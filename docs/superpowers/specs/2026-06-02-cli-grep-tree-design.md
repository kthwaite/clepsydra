# CLI `grep` and `tree` subcommands — design

Date: 2026-06-02

## Summary

Add two read-only CLI subcommands to the `clepsydra` binary:

- **`grep <QUERY>`** — full-text search over the vault's FTS index, returning a
  rank-ordered list of matching pages with highlighted snippets.
- **`tree`** — render the entire vault directory tree, enriching indexed notes
  with metadata (kind, title, tags, dates, word count) and showing other items
  (folders, attachments, non-page files) with file size.

Both commands open the vault and a freshly-built read-only index via the
existing `open_vault_and_index()` helper (the same path `relabel` uses), and
follow the `doctor` precedent for output: styled human-readable text by
default, raw structured output under `--json`.

## Motivation

`serve` exposes search and content listing over HTTP, but there is no
terminal-native way to query a vault. `grep` and `tree` give the operator a
fast, scriptable overview without starting the server. They reuse existing
index machinery rather than introducing new query paths.

## Architecture

Each command is a thin dispatch arm in `src/bin/cli.rs`; the substantive logic
lives in testable library modules under `src/vault/` — the established home for
CLI-facing logic alongside `relabel.rs` and `new_note.rs`.

```
cli.rs (Commands::Grep / Commands::Tree)
  └─ open_vault_and_index()            (existing; src/lib.rs)
       ├─ grep  → src/vault/grep.rs    (fts_quote + render over VaultIndex::search)
       └─ tree  → src/vault/tree.rs    (fs walk + index metadata join + render)
```

## `grep` — FTS search

### Module `src/vault/grep.rs`

- `fts_quote(query: &str) -> String` — wraps the input as a single FTS5 phrase
  by surrounding it in double quotes and doubling any embedded `"`
  (`he said "hi"` → `"he said ""hi"""`). This makes arbitrary user input safe
  to pass to `MATCH` (the chosen "literal, auto-quoted" semantics), so stray
  quotes or operator characters never produce an FTS5 syntax error.
- A `--raw` flag bypasses `fts_quote` and passes the string straight to `MATCH`,
  giving power users full FTS5 operator syntax (phrases, `AND`/`OR`, `NEAR`,
  prefix `*`).
- Reuses `VaultIndex::search(query, limit)` verbatim. That method already
  returns `SearchResult { page_id, path, title, snippet, rank }`, where
  `snippet` is produced by FTS5's `snippet(pages_fts, 3, '<mark>', '</mark>',
  '…', 32)` and rows are `ORDER BY rank`.

### Rendering

- `render_human(results, writer)` — one entry per result, in rank order. Each
  entry shows the `path` (and `title` when it differs from the filename), with
  the `<mark>…</mark>` spans converted to ANSI accent (barbican orange) and the
  `…` ellipses dimmed, via `anstream::AutoStream` (TTY/`NO_COLOR`-aware, exactly
  as `doctor` does). An empty result set prints a dim "no matches" line.
- `render_json(results, writer)` — emits the result rows as JSON. The `snippet`
  field retains its `<mark>` markers so a downstream consumer can locate
  highlights; each row also carries `page_id`, `path`, `title`, and `rank`.

### CLI surface

```
clepsydra grep <QUERY> [--limit/-n <N>] [--raw] [--json]
```

- `QUERY` (positional, required) — the search string.
- `--limit/-n <N>` — maximum results; default **20**.
- `--raw` — pass `QUERY` to FTS5 `MATCH` unquoted.
- `--json` — emit structured output instead of styled text.

Exit code is 0 whether or not there are matches (a query with zero hits is not
an error).

## `tree` — vault tree with metadata

### Module `src/vault/tree.rs`

- Walks the vault filesystem starting at `vault.root()`. Excludes dotfiles and
  dot-directories (`.git`, etc.) and the `.clepsydra` directory (index db,
  config, templates). `_attachments` and all regular content are shown.
- Builds a `TreeNode` tree distinguishing three node types:
  - **dir** — a directory.
  - **note** — a file whose vault path matches an indexed page; carries
    metadata.
  - **file** — any other regular file ("other item"); carries its file size.
- Metadata for notes comes from a single bulk pre-load from the index keyed by
  path, so the walk does not issue per-node queries:
  - **kind, title, tags** — from the `pages` and `tags` tables (cheap, no disk
    reads).
  - **created_at, updated_at, word_count** — require reading each note via
    `Page::from_file`, the same per-file disk read `content_index` performs.
    This is the one O(n) expensive step; it always runs (not gated behind a
    flag) for parity with the HTTP content index.

### Rendering

- `render_human(tree, writer)` — a box-drawing tree (`├──`, `└──`, `│`,
  indentation guides). Within each directory, sub-directories are listed first,
  then files, each group sorted alphabetically. Per-line content:
  - **note**: name + dim `[KIND]` tag + title (when distinct from filename) +
    tags + dates/word-count.
  - **file**: name + dim human-readable size.
  - **dir**: name only.
- `render_json(tree, writer)` — a nested JSON tree of typed nodes
  (`{ "type": "dir" | "note" | "file", "name", "path", ...metadata, "children" }`).

### CLI surface

```
clepsydra tree [--json]
```

## Error handling

- Both commands surface vault/index open failures through the existing
  `open_vault_and_index()` error path, which `run_cli` Display-prints (the
  pattern shared with `relabel`).
- `grep` without `--raw` cannot produce an FTS5 syntax error because the query
  is always quoted; with `--raw`, an FTS5 error propagates as a normal `Err`.
- `tree` skips filesystem entries it cannot stat rather than aborting the whole
  walk.

## Testing

Unit tests against a temp vault (the `vault_in_tempdir` pattern already in
`cli_tests`):

- **grep** (`src/vault/grep.rs`):
  - `fts_quote` escapes embedded double quotes and wraps the phrase.
  - A seeded note is found and returned in rank order for a literal query.
  - `--raw` path passes an operator query through to `MATCH`.
- **tree** (`src/vault/tree.rs`):
  - dotfiles and `.clepsydra` are excluded from the walk.
  - an indexed note node carries its kind and tags.
  - an `_attachments` file appears as a `file` node with a size.

Dispatch smoke tests in `cli_tests` mirroring `relabel_dry_run_returns_zero`:
`grep` and `tree` (and their `--json` variants) parse and return exit code 0
against a seeded temp vault.

## Decisions / defaults

- grep query semantics: **literal, auto-quoted** by default; `--raw` opts into
  FTS5 operators.
- grep default `--limit`: **20**.
- `tree` source: **filesystem walk** enriched with index metadata (so folders,
  attachments, and unindexed files appear), not index-pages-only.
- `tree` scope: **hide dotfiles + `.clepsydra`**; show `_attachments` and
  regular content.
- `tree` always reads files for word-count/dates (no gating flag).
- Both commands offer **`--json`**, matching `doctor`.

## Out of scope (YAGNI)

- Pagination / offset on `grep` or `tree`.
- `tree` depth limits, kind filters, or `--no-content` fast mode.
- Search across block content or properties (the `blocks` FTS-less search in
  `api/blocks.rs` is unaffected).
