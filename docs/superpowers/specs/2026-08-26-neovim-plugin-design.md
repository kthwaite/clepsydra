# Neovim Plugin and LSP Depth Design

## Goal

Make Neovim a first-class editing surface for a Clepsydra vault, including on
remote SSH boxes where the web UI is not in reach. Two deliverables:

- deepen the existing `clep lsp` server with block-reference intelligence and
  markdown-oxide-inspired conveniences (benefits every LSP editor, not just
  Neovim);
- add an in-repo Neovim plugin (`nvim/`) that layers journal navigation, quick
  capture, Task workflow, and snacks.nvim pickers on top of the LSP and the
  `clep serve` HTTP API.

## Context and locked decisions

- Neovim is a primary editing surface for the vault. Deployment target
  includes remote SSH boxes where `clep serve` is guaranteed to run (it hosts
  the MCP endpoint for Claude Code instances).
- **Transport: LSP + HTTP hybrid.** The split rule: anything needing cursor or
  buffer context is an LSP feature (Rust, standard protocol methods only);
  vault-global reads and all writes go over the HTTP API (Lua, protected by
  the server's mutation coordinator, TSK codes assigned server-side).
- **ADR 0001 is untouched.** The LSP process still never writes vault files.
  New LSP features are read-only projections; `clep serve` absorbs editor
  writes as external edits, as today.
- **Plugin home: in-repo `nvim/` directory**, loaded via a lazy.nvim
  `dir = <path>` local spec. Remote boxes get the plugin by cloning this repo
  (which they do anyway to build `clep`).
- Inspiration: markdown-oxide's feature index (<https://oxide.md/Features+Index>).
  Parity is taken only where Clepsydra's link grammar already supports the
  concept.

## Scope

This feature will:

- add LSP completion, hover, goto-definition, and references for
  `((block-id))` block references;
- add a backlinks line to the existing wikilink page hover;
- add date-word wikilink completion (`[[today`, `[[yesterday`, weekday names)
  resolving to journal page links;
- create the `nvim/` plugin: journal navigation and capture, Task quick-add
  and stage transitions, snacks.nvim picker sources, a client-side handler for
  the `clepsydra.findReferences` code-lens command, and `:checkhealth`
  support;
- add headless Lua tests, stylua formatting, and a `neovim.mdx` docs page;
- update `lsp.mdx` for the new LSP capabilities.

This feature will not:

- add heading-anchor links (`[[Page#Heading]]`) or append-to-heading code
  actions — that is a vault grammar/index feature deserving its own spec;
- add any write path to the LSP process (ADR 0001);
- impose default keymaps in the plugin (commands and `<Plug>` mappings only);
- add authentication to the HTTP API (it has none today; the plugin targets
  `localhost`);
- port the Task Board, Agenda, or graph views to Neovim — pickers only.

## Component 1: LSP additions (`src/lsp/`)

All standard LSP methods; no custom protocol extensions.

### Block references

The index already carries what is needed: `blocks(block_id, page_id,
block_type, content, span_start, span_end, …)` with `idx_blocks_block_id`,
and `links.target_block_id` with its partial index.

- **Completion.** Add `(` to the completion trigger characters. After a `((`
  prefix, complete against `blocks` rows with non-null `block_id`, matching
  the typed text against `content` (substring `LIKE` match). Label: a content
  snippet plus source page. Inserted text: the full `((block-id))` form
  replacing the typed prefix. Encrypted-body positions stay excluded, as for
  existing completions.
- **Hover.** On a `((block-id))` under the cursor, show the block's content
  and its source page path. Unresolved block ids report as unresolved, in the
  style of the existing wikilink hover.
- **Goto definition.** Jump to the defining block: resolve `block_id` →
  (`page_id`, `span_start`), convert to a file URI and position.
- **References.** Extend the references handler so a cursor on a
  `((block-id))` returns all links with that `target_block_id`, reusing the
  existing backlink-to-range conversion.

`document.rs` link extraction already produces `LinkKind::BlockRef` spans;
handlers dispatch on the link kind under the cursor.

### Page hover backlinks

The existing wikilink hover (title, path, preview) gains one line: the
target's backlink count, from the same index query the code lens uses.

### Date-word wikilink completion

Inside a `[[` prefix, the literal words `today`, `yesterday`, `tomorrow`, and
English weekday names additionally offer the corresponding journal page as a
completion (resolved by date math in the server; weekday names resolve to the
next occurrence). This is completion sugar only — the link grammar is
unchanged, and the inserted text is a normal `[[…]]` wikilink to the journal
page name.

## Component 2: Neovim plugin (`nvim/`)

### Layout

```
nvim/
  lua/clepsydra/
    init.lua          -- setup(opts), public API
    config.lua        -- defaults + user opts merge
    client.lua        -- async HTTP client (vim.system + curl, vim.json)
    journal.lua       -- daily navigation + capture
    tasks.lua         -- Task quick-add + stage transitions
    picker.lua        -- snacks.nvim picker sources
    lsp_commands.lua  -- vim.lsp.commands registrations
    health.lua        -- :checkhealth clepsydra
  lsp/clepsydra.lua   -- vim.lsp.config definition on the rtp
  plugin/clepsydra.lua -- :Clep command tree, lazy-loading glue
  tests/              -- headless busted-style specs + run.lua
  stylua.toml
  README.md
```

`lsp/clepsydra.lua` ships the server definition (cmd `clep lsp`, markdown
filetype, `.clepsydra` root marker), so a user config reduces to
`vim.lsp.enable("clepsydra")` plus the lazy.nvim dir spec.

### Configuration

`require("clepsydra").setup{}` options, with defaults:

- `server_url = "http://localhost:3000"` — matches the `[server].port`
  default (`set_default("server.port", 3000)`, `src/lib.rs`). No discovery
  magic; users with a different port or the Caddy hostname set it here.
- `vault_root = nil` — auto-detected from the `.clepsydra` ancestor of the
  current buffer; explicit override for edge cases.

### HTTP client

`client.lua` wraps `vim.system({"curl", …})` with JSON encode/decode and
callback-style async. All routes are under `/api/vault`. Failures surface via
`vim.notify` once per distinct error, not per keystroke; pickers show an
empty list with the error in the picker title.

Routes used (all existing; no backend route changes expected):

| Purpose | Route |
| --- | --- |
| Today's journal (read / ensure-create) | `GET`/`POST /api/vault/journal/today` |
| Capture to today | `POST /api/vault/journal/today/capture` |
| Journal by date | `GET /api/vault/journal/{date}` |
| Page search (FTS5) | `GET /api/vault/index/search` |
| Backlinks with context | `GET /api/vault/index/backlinks/{*path}` |
| Tags | `GET /api/vault/index/tags` |
| Task list | `GET /api/vault/tasks/` |
| Task create | `POST /api/vault/board/tasks` |
| Task stage transition | `PATCH /api/vault/board/tasks/{id}` |
| Board snapshot | `GET /api/vault/board/` |

### Commands (`:Clep` tree)

- `:Clep today` — ensure + open today's journal page in the current window.
- `:Clep daily {spec}` — open a journal page by relative spec: `prev`, `next`,
  `+N`, `-N`, a weekday name, or `YYYY-MM-DD`. `prev`/`next`/offsets are
  relative to the current buffer when it is a journal page, otherwise to
  today. Date math lives in Lua; the journal path comes from the API.
- `:Clep capture` — normal mode: send the current line; visual mode: send the
  selection. Appends to today's journal via the capture route and notifies
  with the target page.
- `:Clep task add {title}` — create a Task (stage `INTAKE`); the server
  assigns the TSK code, which is echoed.
- `:Clep task stage` — find the TSK code under the cursor (or in the current
  page's frontmatter), show the five stages (`INTAKE` → `TRIAGE` → `FIELD` →
  `REVIEW` → `SEALED`) in `vim.ui.select`, PATCH the choice.
- `:Clep search | backlinks | tags | tasks` — open the corresponding picker.

### Pickers (snacks.nvim)

Sources are built inline with `Snacks.picker.pick`; users wanting named
`Snacks.picker.*` entry points can wrap the exported functions in their own
snacks config.

- `clepsydra_pages` — FTS5 search, live query against `/search`; confirm
  opens the file (vault-relative path joined to the detected vault root).
- `clepsydra_backlinks` — backlinks of the current buffer's page with context
  lines; confirm jumps to the source location.
- `clepsydra_tags` — tag list; confirm drills into a page picker filtered by
  tag.
- `clepsydra_tasks` — Task list with code, title, stage; confirm opens the
  Task page.

Layouts and window options stay with the user's snacks config; the plugin
sets only source behavior.

### LSP client glue

`lsp_commands.lua` registers `vim.lsp.commands["clepsydra.findReferences"]`,
which the existing code lens emits but no stock client implements. The
handler routes through the standard references flow rendered via the
client's default references UI (quickfix).

## Error handling

- serve unreachable: journal/task/picker commands fail with one actionable
  `vim.notify` (URL tried, hint to check `clep serve`); LSP features are
  unaffected.
- LSP not attached: `:Clep` commands that need only HTTP still work;
  `:checkhealth clepsydra` reports binary presence, LSP attach state, and
  serve reachability separately.
- Non-vault buffers: `:Clep` commands abort with a clear message when no
  `.clepsydra` root is found.

## Testing

- **Rust:** TDD via the existing LSP test harness (`src/lsp/test_support.rs`)
  for block-ref completion/hover/definition/references, hover backlink line,
  and date-word completion. `cargo test`, `cargo clippy`, `cargo fmt` on
  touched files only (develop is not repo-wide fmt-clean).
- **Lua:** busted-style specs run headless with `nvim -l tests/run.lua`
  (plenary-free mini harness). Unit-test date math, TSK-code detection, route
  building, and response parsing with a stubbed client; picker/command
  integration is exercised against a mocked `client.lua`. `stylua --check
  nvim/` as the format gate.
- Both suites documented as verification gates alongside the existing ones.

## Documentation

- New `ui/src/docs/content/neovim.mdx`: install (lazy.nvim dir spec), setup,
  command reference, picker reference, health checks.
- `lsp.mdx`: add block-reference and date-completion rows to the capability
  table; link to the Neovim page.
- `nvim/README.md`: short pointer to the docs page.

## Delivery phases

One spec (this document), three implementation plans, in order:

- **Phase A — LSP depth** (`src/lsp/`): block-ref intelligence, hover
  backlinks, date-word completion. Independent of B/C.
- **Phase B — plugin core** (`nvim/`): layout, config, client, journal,
  pickers, lsp_commands, health, tests, docs pages.
- **Phase C — Task workflow** (`nvim/`): task add/stage commands and the
  tasks picker. Depends on B.

Each phase lands on `develop` via the standard feature workflow (branch,
TDD, subagent execution, review, gates, merge).
