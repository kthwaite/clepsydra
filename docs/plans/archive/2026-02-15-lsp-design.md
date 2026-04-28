# Clepsydra LSP Design

## Overview

A Language Server Protocol implementation for clepsydra vaults, providing IDE
features for markdown files with wikilinks, frontmatter, and the clepsydra
knowledge graph. Modeled after
[markdown-oxide](https://github.com/Feel-ix-343/markdown-oxide) (architecture)
and the [tower-lsp](https://github.com/ebkalderon/tower-lsp) examples
(framework).

Targets Neovim 0.9+ and Helix as primary editors.

## Decisions

| Dimension | Decision | Rationale |
|---|---|---|
| LSP framework | `tower-lsp` v0.20 | Mature, async-native, tower ecosystem |
| Transport | stdio | Standard for editor integration |
| Process model | Unified with HTTP server | Single index owner, no SQLite contention |
| Launch | `clepsydra serve --lsp` | Editor launches full process; HTTP + LSP coexist |
| Document sync | `TextDocumentSyncKind::FULL` | Matches existing full-document parse pipeline |
| Index access | Dedicated thread + command channel | `rusqlite::Connection` is `!Send`; avoids async lock hazards |
| Text buffers | `ropey::Rope` per open document | Byte-offset ↔ line/col translation |
| Position encoding | UTF-8 only (`PositionEncodingKind::UTF8`) | Native to ropey; supported by Neovim 0.9+ and Helix |
| File watching | Watcher owns closed files; LSP owns open files | No double-indexing on save |
| Index updates | Debounced (500ms idle); in-memory diagnostics are immediate | Avoids hammering SQLite on every keystroke |

## Architecture

### Process model

`clepsydra serve --lsp` runs the HTTP server, file watcher, and LSP stdio
handler in one process. A single dedicated OS thread owns the `VaultIndex`
(and its `rusqlite::Connection`). All access — from LSP handlers, Axum
handlers, and the watcher sync loop — goes through a typed command channel.

```
                    ┌──────────────────────────────────┐
                    │         tokio runtime             │
                    │                                   │
  Editor ─ stdio ──▶  tower-lsp handlers (async)       │
                    │       │                           │
  HTTP clients ─────▶  Axum handlers (async)            │
                    │       │                           │
  VaultWatcher ─────▶  sync event loop (async)          │
                    │       │                           │
                    │       ▼                           │
                    │  IndexHandle (mpsc::Sender)       │
                    │       │                           │
                    └───────┼───────────────────────────┘
                            │ IndexCommand + oneshot
                    ┌───────▼───────────────────────────┐
                    │  Index thread (std::thread)        │
                    │  owns: VaultIndex, Vault           │
                    │  loop: recv command → execute →    │
                    │        respond via oneshot         │
                    └───────────────────────────────────┘
```

### Core types

```rust
/// Async-friendly handle to the index thread. Clone + Send + Sync.
#[derive(Clone)]
struct IndexHandle {
    tx: mpsc::Sender<IndexCommand>,
}

enum IndexCommand {
    // Queries
    ResolveLink { target: String, reply: oneshot::Sender<Vec<LinkMatch>> },
    Backlinks { path: VaultPath, max_context: usize, reply: oneshot::Sender<Vec<Backlink>> },
    Search { query: String, limit: usize, reply: oneshot::Sender<Vec<SearchResult>> },
    CompleteCanonicalName { prefix: String, limit: usize, reply: oneshot::Sender<Vec<CompletionCandidate>> },
    CompleteTags { prefix: String, limit: usize, reply: oneshot::Sender<Vec<String>> },
    ReverseDeps { path: VaultPath, reply: oneshot::Sender<Vec<VaultPath>> },
    AllCanonicalNames { reply: oneshot::Sender<HashSet<CanonicalName>> },

    // Mutations
    IndexPage { path: VaultPath, reply: oneshot::Sender<Result<(), IndexError>> },
    RemovePage { path: VaultPath, reply: oneshot::Sender<Result<(), IndexError>> },
    ProcessSyncEvents { events: Vec<ChangeEvent>, reply: oneshot::Sender<Result<SyncStats, IndexError>> },
    Build { progress: Option<Box<dyn Fn(usize, usize) + Send>>, reply: oneshot::Sender<Result<(), IndexError>> },
}
```

`IndexHandle` replaces `Arc<parking_lot::Mutex<VaultIndex>>` for both the HTTP
server and the LSP. Axum handlers migrate to use `IndexHandle` as a
prerequisite refactor.

### Shared state

```rust
struct AppState {
    vault: Vault,                                // Clone, lightweight
    index: IndexHandle,                          // Clone, channel-based
    cas: Arc<parking_lot::Mutex<ContentStore>>,   // unchanged
    change_tx: broadcast::Sender<SyncNotification>,
    open_files: Arc<Mutex<HashSet<VaultPath>>>,  // LSP-owned files; watcher skips these
    hooks: Vec<Box<dyn PostMoveHook>>,
    delete_hooks: Vec<Box<dyn PostDeleteHook>>,
}
```

### LSP backend

```rust
struct LspBackend {
    client: tower_lsp::Client,
    state: Arc<AppState>,
    documents: Mutex<HashMap<Url, Document>>,
    debounce_tx: mpsc::Sender<DebouncedIndexRequest>,
    canonical_names: Arc<RwLock<HashSet<CanonicalName>>>,  // snapshot for fast diagnostics
}
```

### Document struct

```rust
struct Document {
    rope: ropey::Rope,
    meta: PageMeta,
    body: String,              // markdown body after frontmatter fences
    body_byte_offset: usize,   // byte position where body starts in full text
    links: Vec<Link>,          // extracted via extract_links()
    version: i32,              // editor version counter
    dirty: bool,               // true if index is stale relative to in-memory state
}
```

### File ownership split

The watcher runs as today but checks `AppState::open_files`. If a watcher
event targets an open file, it is ignored — the LSP's `did_change`/`did_save`
handles it. The watcher handles everything else: new files created externally,
files edited outside the editor, deletions.

## Document Lifecycle

Two layers of state: **in-memory** (fast, per-keystroke) and **persistent**
(debounced, SQLite).

```
did_open(uri, text, version)
  1. Parse frontmatter + body
  2. Build Rope from full text
  3. Record body_byte_offset
  4. Extract links (extract_links on body)
  5. Insert into documents map
  6. Add vault_path to open_files set (watcher stops owning this file)
  7. Send IndexPage to index thread (non-debounced; first open is cheap)
  8. Compute + publish diagnostics from in-memory link state

did_change(uri, text, version)                [full sync]
  1. Replace rope, re-parse frontmatter + body
  2. Re-extract links
  3. Update document in map, mark dirty = true
  4. Compute + publish diagnostics from in-memory state  ← instant
  5. Send debounce request                                ← NOT immediate

did_save(uri)
  1. If dirty: flush index update immediately (cancel pending debounce)
  2. Re-resolve reverse deps via index thread
  3. Publish diagnostics for this file + any affected open files

did_close(uri)
  1. If dirty: flush final index update
  2. Remove from documents map
  3. Remove from open_files set (watcher resumes ownership)
```

### Debounce mechanism

A dedicated tokio task receives `DebouncedIndexRequest { vault_path,
document_snapshot }` messages. It maintains a
`HashMap<VaultPath, (Instant, DocumentSnapshot)>` — on each incoming request,
the timer for that path resets. A tick loop (every 100ms) flushes any entry
idle for 500ms+:

```
typing:    |..|..|..|..|..|.............|
debounce:                        ↑ flush (500ms since last change)
did_save:               ↑ immediate flush, cancel pending debounce
```

Flush sends `IndexPage` + `ResolveLinksForPage` to the index thread. The
debounce task never touches the index directly.

### In-memory diagnostics

Diagnostics are computed without the index thread by comparing link targets
against a cached `HashSet<CanonicalName>` snapshot:

| Check | Source | Latency |
|---|---|---|
| Unresolved wikilinks | `link.target_raw` vs canonical name set | ~instant |
| Ambiguous wikilinks | Same set, check for multiple matches | ~instant |
| Frontmatter YAML parse failure | `parse_frontmatter` error | ~instant |

The canonical name snapshot is refreshed from the index thread on each debounce
flush and on `did_open`. Any open documents whose diagnostics depended on the
old snapshot are re-diagnosed after refresh.

### Property ref links

Property ref links (`span: 0..0`, negative `span_start` in the index) are
skipped for LSP diagnostics entirely. They have no meaningful source location
in the document. The index thread still processes them for the backlink graph.

## Phase 1 — Core Navigation

### Completions

#### Wikilink completion (`[[`)

LSP `triggerCharacters` accepts only single characters — register `[`. The
completion handler scans backward from cursor for `[[` not followed by `]]`.
If the preceding character is a single `[` (not `[[`), bail — it's a markdown
link.

Filter prefix: text between `[[` and cursor.

```
User types: [[des|          (cursor at |)
                ^^^ prefix = "des"
```

Query via index thread: `CompleteCanonicalName { prefix: "des", limit: 50 }`

```sql
SELECT DISTINCT cn.canonical_name, p.path, p.title
FROM canonical_names cn
JOIN pages p ON p.id = cn.page_id
WHERE cn.canonical_name LIKE ?1 || '%'
ORDER BY cn.canonical_name
LIMIT 50
```

Each result becomes a `CompletionItem`:
- `label`: page title (or filename stem if untitled)
- `kind`: `CompletionItemKind::REFERENCE`
- `detail`: vault-relative path
- `filterText`: canonical name (editor does fuzzy matching on this)
- `textEdit`: replace range from `[[` to cursor with `[[resolved-target]]`
  (include closing brackets explicitly — auto-close behavior varies across
  editors)

Display-text links (`[[target|display]]`) are manual in Phase 1: the user
types `|` after accepting a completion. Snippet support (`[[target|$1]]`) is
a Phase 2 upgrade path.

#### Tag completion (`#`)

Trigger character: `#`. Handler checks: `#` must be at a word boundary and not
inside a code span (check rope backward for backtick parity). Prefix is text
after `#`.

Query: `CompleteTags { prefix, limit: 50 }`

#### Frontmatter key completion

Detection: cursor byte offset is before `body_byte_offset` (inside frontmatter
fences). On a line matching `^\w*$` or after a key with no value, offer known
keys: hardcoded set (`title`, `tags`, `aliases`, `created_at`, `updated_at`).
Vocabulary from the `extra` column across the vault is a low-priority addition.

### Go to Definition

1. Convert LSP position → byte offset in body (via rope:
   `line_to_byte(line) + char_offset - body_byte_offset`)
2. Find the `Link` whose `span` contains that byte offset
3. If no link, return `None`
4. Branch on `link.kind`:
   - `Wiki`: send `ResolveLink { target: link.target_raw }` to index thread
   - `Markdown`: resolve path via `vault.resolve()`
5. Result:
   - Single match → `Location { uri, range: start-of-file }`
   - Multiple matches → `Vec<Location>` (editor shows picker)
   - No match → `None`

### Hover

Same link-under-cursor detection as go-to-definition. Once target resolves:

1. Read target page: `tokio::fs::read_to_string(vault.resolve(&target_path))`
2. Parse frontmatter → title, tags
3. First 10 lines of body as preview
4. Format as Markdown:

```markdown
**Page Title**
`vault/path/to/page`
Tags: #tag1 #tag2

---

First lines of body content...
```

Unresolved target: hover shows `⚠ Unresolved link: "target"`.

### Diagnostics

Published via `client.publish_diagnostics()` on every `did_change`.

| Condition | Severity | Code |
|---|---|---|
| Wikilink target not in canonical name set | Warning | `unresolved-link` |
| Wikilink target matches 2+ canonical names | Information | `ambiguous-link` |
| Frontmatter YAML parse failure | Error | `invalid-frontmatter` |

**Not diagnosed:**
- Missing/invalid page ID — `parse_or_repair_frontmatter` auto-generates
  UUIDs; warning about their absence is noise.
- Property ref links — no source location.

**Range mapping:** `link.span` (body bytes) + `body_byte_offset` → absolute
bytes → rope `byte_to_line` / remainder for UTF-8 character offset.

**Ambiguous links:** Each candidate page becomes a
`DiagnosticRelatedInformation` entry with the candidate's URI and path.

**Cross-file staleness:** When the debounce flush refreshes the canonical name
snapshot, all open documents are re-diagnosed. Creating a new page clears
broken-link diagnostics in other files — after the debounce window.

## Phase 2 — References & Symbols

### Find References (Backlinks)

Two contexts:

1. **Cursor on a wikilink target.** Resolve target, query
   `Backlinks { path: target_path, max_context: 0 }`.
2. **Cursor on the page's own title** (frontmatter or first heading). Target
   is the current page. Query backlinks for self.

Each backlink maps to a `Location`. For referring files not open in the editor,
build a throwaway rope from `fs::read_to_string` for offset conversion.
Markdown files are small; this is negligible.

### Document Symbols

Parse headings from in-memory `Document.body` via pulldown-cmark. Build nested
`DocumentSymbol` tree:

```
├── (title from frontmatter)          SymbolKind::FILE
│   ├── ## Section A                  SymbolKind::STRING
│   │   ├── ### Subsection A.1
│   │   └── ### Subsection A.2
│   └── ## Section B
```

- `range`: heading start to next heading of same-or-higher level (or EOF)
- `selectionRange`: the heading line itself
- Root symbol: frontmatter title or filename stem

Entirely in-memory, no index thread involvement.

### Workspace Symbols

Query via index thread: `Search { query, limit: 50 }` against FTS5 table.
Results map to `SymbolInformation` with `kind: FILE`.

Empty query fallback: `SELECT path, title FROM pages ORDER BY updated_at DESC
LIMIT 50` (FTS5 doesn't handle empty queries).

### Code Lens

Single code lens per file above the frontmatter: `"N references"`. Clicking
triggers find-references for the current page.

Heading-level backlink counts require `[[page#heading]]` fragment support in
the link model, which doesn't exist yet. Noted as future extension.

**Resolve pattern:** Return lenses without commands on initial request.
`codeLens/resolve` fills in counts lazily to avoid blocking initial render.

### Phase 2 summary

| Feature | Index thread? | In-memory? | Notes |
|---|---|---|---|
| Find references | Yes (Backlinks) | Throwaway ropes for closed files | |
| Document symbols | No | Heading parse from body | |
| Workspace symbols | Yes (Search) | No | FTS5 query |
| Code lens | Yes (Backlinks count) | No | Page-level, resolved lazily |

## Phase 3 — Refactoring & Actions

### Rename

Trigger: `textDocument/rename` on a wikilink target or the page's own
frontmatter title.

The LSP computes a `WorkspaceEdit`; the **editor** applies it. The LSP does
not call `rewrite_links_in_content` or `apply_staged_writes` directly.

**Sequence:**

```
prepareRename(position)
  → Validate cursor is on a renameable element
  → Check for conflicts (target path already exists → error)
  → Return current name + range

rename(position, newName)
  1. Resolve old target → VaultPath
  2. Compute new VaultPath from newName
  3. Query all canonical names resolving to old target (including aliases)
  4. Query all pages with links matching any of those canonical names
  5. For each referring page:
     a. Open in editor → compute TextEdit from in-memory Document
     b. Not open → read from disk, compute edits
  6. Build WorkspaceEdit with DocumentChanges:
     a. RenameFile { oldUri, newUri }
     b. TextEdits on target page (update frontmatter title)
     c. TextEdits on each referring page (rewrite wikilinks)
  7. Return WorkspaceEdit
```

The index updates itself via the resulting `did_change` / `did_save` /
`didChangeWatchedFiles` events flowing back from the editor.

**Edge cases:**
- Aliases: query *all* canonical names that resolve to the target, find links
  matching any of them.
- Open file being renamed: editor handles URI update via `RenameFile` in
  `DocumentChanges`. LSP updates its `documents` map on the resulting
  `did_close(old)` + `did_open(new)`.
- Folder-qualified links: rename changes vault path, which changes derived
  folder-qualified canonical names. Query all canonical names for the page,
  not just the title-based one.

### Code Actions

#### Create missing page (on `unresolved-link` diagnostic)

```
Kind: quickfix
Title: "Create page: {target}"
```

Returns `WorkspaceEdit` with `CreateFile { uri }` and a `TextEdit` inserting
frontmatter scaffold (`id`, `title`). Watcher indexes the new file after
creation, clearing the diagnostic on next refresh.

#### Disambiguate link (on `ambiguous-link` diagnostic)

One code action per candidate:

```
Kind: quickfix
Title: "Resolve to: folder/Page Title"
```

`TextEdit` replacing `[[ambiguous]]` with `[[folder/Page Title]]`, using the
shortest path prefix that uniquely identifies the candidate (walk up path
segments until unique).

#### Extract selection to page (stretch goal)

```
Kind: refactor
Title: "Create page from selection"
```

Creates a new page with selected text as body, replaces selection with a
wikilink. Page title derived from first line of selection.

### Formatting

Deliberately minimal — only clepsydra-specific concerns:

1. **Frontmatter field order.** Reorder to: `id`, `title`, `tags`, `aliases`,
   `created_at`, `updated_at`, then `extra` fields alphabetically.
2. **Wikilink canonical casing.** Normalize `[[some page]]` to `[[Some Page]]`
   if the target resolves and has a known title. Opt-in via vault config.

### Phase 3 summary

| Feature | Writes files? | Index thread? | Key constraint |
|---|---|---|---|
| Rename | Via WorkspaceEdit | Backlinks + canonical names | Editor owns writes |
| Create page | Via WorkspaceEdit | No | Watcher indexes after creation |
| Disambiguate | Via TextEdit | Canonical name lookup | Shortest-unique-prefix |
| Extract to page | Via WorkspaceEdit | No | Stretch goal |
| Formatting | Via TextEdit | Optional (casing) | Opt-in normalization |

## Initialization

```
 1. Parse CLI args, load VaultConfig
 2. Open Vault at root path
 3. Open/build VaultIndex from .clepsydra/index.db
 4. Spawn index thread → returns IndexHandle
 5. Build AppState { vault, index, cas, open_files, ... }
 6. Spawn VaultWatcher (notify debouncer → mpsc channel)
 7. Spawn watcher sync loop (reads channel, forwards to index thread)
 8. If --lsp:
    a. Build LspBackend
    b. Spawn debounce flush task
    c. Spawn tower-lsp Server on stdin/stdout
 9. Bind Axum HTTP listener
10. select! on shutdown signals
```

### Startup indexing

`initialize` returns immediately with capabilities. Full index build runs
asynchronously on the index thread. During the build window, features degrade
gracefully: completions return empty, go-to-def returns None, diagnostics show
all links as unresolved. Once the build completes, the canonical name snapshot
refreshes and all open files are re-diagnosed.

Progress reporting via `window/workDoneProgress`:
- Token: `"clepsydra/indexing"`
- Begin: `"Indexing vault..."` with percentage
- End: `"Indexed N pages"`

Requires `VaultIndex::build` to accept a progress callback (small refactor).

### Shutdown

- **LSP `shutdown` request:** tears down LSP handler only. HTTP server
  continues. Watcher resumes full file ownership.
- **stdin EOF:** if the editor process owned stdio, initiate full shutdown.
- **SIGINT:** full shutdown. Flush dirty documents, close SQLite, exit.

## Error Handling

**Index thread panic.** All `IndexHandle` calls receive `RecvError`. The LSP:
- Logs the error
- Publishes `window/showMessage` (Error): `"Index unavailable — restart clepsydra"`
- Degrades gracefully (empty completions, no go-to-def, file-level warning)
- Does not attempt automatic restart

**Malformed documents.** `parse_frontmatter` failure:
- `Document.meta` gets default `PageMeta` (generated UUID, no title/tags)
- `Document.body` is the entire file content
- Single Error diagnostic at line 1
- All other features still work against the body

**Stale WorkspaceEdits.** `WorkspaceEdit` includes document versions. If a file
changed between edit computation and application, the editor rejects the stale
edit. No LSP-side guard needed.

## Edge Cases

1. **Circular renames.** `prepareRename` checks for target path conflicts and
   returns an error. No merge semantics.

2. **Wikilinks inside code blocks.** `extract_links` already skips code blocks.
   Completion handler must also check code context before returning results:
   parse pulldown-cmark events up to cursor, track code span/fence state.

3. **Very large files.** In-memory parse is O(n). If `did_change` processing
   exceeds 50ms, log a warning. Incremental sync is a future optimization, not
   v1 scope.

4. **Multiple vaults.** One vault per process. `initialize` picks the first
   workspace folder containing `.clepsydra/`. Documents outside the vault are
   ignored. Multi-vault support (multiple `IndexHandle` instances) is future
   work.

5. **Watcher/code-action race.** "Create page" via `WorkspaceEdit` triggers
   both `didChangeWatchedFiles` and the watcher. The index thread is idempotent
   (upsert semantics). No coordination needed.

6. **Rename across folders.** Folder moves change derived canonical names.
   Rename handler queries all canonical names for the page, including
   folder-qualified ones.

## Dependencies

New crates:

```toml
tower-lsp = "0.20"
ropey = "1"
```

All other required crates (`tokio`, `serde_json`, `tracing`, `parking_lot`,
`pulldown-cmark`) are already present. `dashmap` is not needed — open
documents use `HashMap` behind `Mutex`.

## File Layout

```
src/
├── bin/
│   └── cli.rs              # add --lsp flag to serve subcommand
├── lsp/
│   ├── mod.rs              # LspBackend, LanguageServer impl, initialization
│   ├── completion.rs       # Wikilink, tag, frontmatter completion
│   ├── hover.rs            # Link target preview
│   ├── definition.rs       # Go-to-definition
│   ├── references.rs       # Find-all-references (backlinks)
│   ├── diagnostics.rs      # Diagnostic computation + publishing
│   ├── symbols.rs          # Document + workspace symbols
│   ├── rename.rs           # Rename with cross-file rewriting
│   ├── actions.rs          # Code actions (create, disambiguate, extract)
│   ├── formatting.rs       # Frontmatter ordering, canonical casing
│   └── document.rs         # Document struct, rope, offset mapping
├── vault/
│   ├── index_handle.rs     # IndexHandle, IndexCommand, index thread  [NEW]
│   └── ...                 # existing modules unchanged
└── lib.rs                  # add pub mod lsp; refactor AppState to use IndexHandle
```

`index_handle.rs` lives in `vault/` because the HTTP server uses it too.

## Implementation Order

```
Phase 0 — Foundation (no LSP features yet)
  0a. IndexHandle + index thread; refactor AppState; migrate Axum handlers
  0b. --lsp flag on CLI; tower-lsp scaffold (initialize/shutdown only)
  0c. Document struct + rope + offset mapping + tests

Phase 1 — Core navigation
  1a. did_open / did_change / did_close lifecycle
  1b. Diagnostics (in-memory, immediate)
  1c. Go to definition
  1d. Hover
  1e. Completions (wikilinks, then tags)
  1f. Debounce flush task + canonical name snapshot refresh

Phase 2 — References & symbols
  2a. Find references (backlinks)
  2b. Document symbols (heading tree)
  2c. Workspace symbols (FTS5)
  2d. Code lens (page-level backlink count)

Phase 3 — Refactoring & actions
  3a. Rename (page rename + cross-file link rewrite)
  3b. Code action: create missing page
  3c. Code action: disambiguate link
  3d. Formatting (frontmatter order, optional canonical casing)
  3e. Code action: extract selection to page (stretch)
```

Phase 0 is prerequisite work that benefits the whole codebase. The
`IndexHandle` refactor eliminates the `Arc<Mutex<VaultIndex>>` pattern from
the HTTP server and establishes the concurrency model for all future work.
