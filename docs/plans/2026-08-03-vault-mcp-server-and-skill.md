# Vault MCP Server + Agent Skill Plan

_Date:_ 2026-08-03

## Context

Clepsydra already exposes everything an agent needs to work a vault — page
CRUD, folder operations, kind/project assignment with metadata-projected
relocation, FTS5 search, link graph queries, journal capture — but only over
the HTTP API consumed by the UI (`src/api/`, OpenAPI at `/api/openapi.json`)
and a handful of CLI subcommands (`new`, `grep`, `tree`).

Claude Code and Cowork speak MCP (Model Context Protocol). Today an agent
asked to "file yesterday's captures" has to shell out to `curl` against a
server whose port it must discover from `config.toml`, guess at request
shapes, and re-learn the vault's conventions (kinds, canonical folders,
frontmatter, wikilink rewriting) every session.

This plan scopes two deliverables:

1. **An MCP server** exposing vault operations as typed tools, so any MCP
   client (Claude Code, Cowork, Claude Desktop) can add, edit, organise, and
   create entries.
2. **An agent skill** (`SKILL.md`) teaching the agent the vault's vocabulary
   and safe workflows — when to capture vs. create a note, how to file pages
   with assign rather than raw moves, how to avoid duplicate pages, how to
   recover from conflicts.

The tools are the hands; the skill is the operating manual.

## Goals

1. Let an MCP client create, read, edit, organise, and delete vault pages
   without knowing HTTP endpoint shapes or the filename identity scheme
   (docs/adr/0002-page-filename-identity.md).
2. Preserve the server as the **single writer**: every mutation goes through
   the running server's `MutationCoordinator` (path locks, stale detection,
   hooks, SSE notifications), never through direct file writes.
3. Reuse existing request/response DTOs and error mapping — the MCP layer is
   an adapter, not a second implementation of vault semantics.
4. Ship as part of the existing binary (`clep mcp`) — no second toolchain,
   no separate install step.
5. Give agents affordances the raw API makes awkward: surgical string-replace
   edits, append-to-page, and dry-run previews of link-rewriting mutations.
6. Encode vault conventions in a project skill so Claude Code / Cowork
   sessions use the tools well by default.

## Non-goals

This plan does **not** aim to:

- add authentication or multi-user support — the MCP server inherits the
  existing localhost trust model (see Security below)
- expose the academic library, importers (DOI/ISBN/BibTeX/Zotero), archive
  ingest, attachments, or the TASKING board — these are phase-2 candidates
  once the core entry workflow is proven
- implement MCP resources or prompts — tools only, at first; resources
  (e.g. `vault://page/{path}`) can come later if clients benefit
- support remote (streamable HTTP) transport — stdio only; the MCP process
  runs on the same machine as the vault
- replace the LSP — editor integration stays with `clep serve --lsp`

## Architecture

### Decision: in-binary stdio proxy to the running HTTP server

```
Claude Code / Cowork
        │  MCP over stdio
        ▼
  clep mcp            (new subcommand, rmcp SDK)
        │  HTTP (reqwest), base URL from Settings::load
        ▼
  clep serve          (existing axum server, MutationCoordinator, index, SSE)
        │
        ▼
  vault files + SQLite index
```

Options considered:

| Option | Verdict |
| --- | --- |
| **A. `clep mcp` stdio subcommand proxying HTTP** | **Chosen.** Single binary, reuses `Settings::load` for discovery, server stays single writer, UI sees changes live via existing SSE. |
| B. `clep mcp` embedding `Vault` + `VaultIndex` directly | Rejected: two processes writing one SQLite index; bypasses the coordinator's path locks, hooks, and change notifications. The watcher would eventually reconcile files, but "eventually consistent with the UI" is exactly the bug class the coordinator exists to prevent. |
| C. Standalone TypeScript MCP server generated from OpenAPI | Rejected for now: second toolchain and release artifact, drift risk against the Rust DTOs. Revisit if we ever want a remote/hosted MCP endpoint. |

Implementation notes for option A:

- **SDK**: the official Rust MCP SDK (`rmcp` crate), stdio transport.
- **Discovery**: same config lookup as every other subcommand
  (`./config.toml` → `$XDG_CONFIG_HOME/clepsydra/config.toml` →
  `~/.config/clepsydra/config.toml`); build the base URL from
  `[server] host/port/tls` exactly as `open-url` does
  (src/bin/cli.rs `OpenUrl` arm).
- **TLS**: when `server.tls.enabled`, trust the vault's own generated
  certificate explicitly (load it from the configured `cert_path`) rather
  than disabling verification.
- **Server not running**: every tool fails fast with an actionable error
  ("clepsydra server not reachable at https://127.0.0.1:3000 — start it with
  `clep serve`"). Auto-spawning the server is an open question (below).
- **New code lives in `src/mcp/`** mirroring the `src/api/` module layout,
  plus a `Commands::Mcp` arm in `src/bin/cli.rs`.

## Tool inventory

Naming: `vault_` prefix, action-oriented, snake_case. All tools return
structured content (JSON) plus a short text rendering. Annotations
(`readOnlyHint`, `destructiveHint`, `idempotentHint`) set per tool.

### Read / orient (read-only)

| Tool | Backing endpoint | Notes |
| --- | --- | --- |
| `vault_search` | `GET /index/search` | FTS5; `query`, `limit`, `raw` (operator syntax). The skill mandates search-before-create. |
| `vault_get_page` | `GET /pages/{path}`, `GET /pages/by-id/{uuid}` | Accepts path **or** id; returns meta, body, kind, project, canonical name. |
| `vault_list_pages` | `GET /pages` | Filters: kind, tag, project, folder prefix; paginated (`limit`/`offset`, defaults small to protect context). |
| `vault_tree` | `GET /folders/tree` + `GET /folders/{path}` | One tool with optional `path`; folder listing with per-note metadata. |
| `vault_links` | `GET /index/backlinks/{path}`, `outlinks`, `similar` | One tool, `direction: backlinks \| outlinks \| similar`. |
| `vault_tags` | `GET /index/tags` | Tag vocabulary + counts; feeds consistent tagging. |

### Create / edit

| Tool | Backing endpoint | Notes |
| --- | --- | --- |
| `vault_create_page` | `POST /pages/{path}` | Inputs: `title` (required), `kind`, `body`, `tags`, `aliases`, `project`, optional `folder` override. The MCP layer derives the canonical `yyyymmdd.slug.shortid.md` path (reusing `new_note`/`page_filename` logic — see open questions) and files under the kind's canonical folder. |
| `vault_update_page` | `PUT /pages/{path}` | Full replacement of title/tags/aliases/body. For wholesale rewrites only. |
| `vault_edit_page` | `GET` + `PUT /pages/{path}` | Surgical edit: `old_string`/`new_string` (+`replace_all`), applied server-side in the MCP process via read-modify-write. Maps a 409/`Stale` conflict to "page changed — re-read and retry". This is the primary edit tool for agents. |
| `vault_append_page` | `GET` + `PUT /pages/{path}` | Append a markdown block (optionally under a named heading). Avoids full-body round-trips for the most common agent write. |
| `vault_journal_capture` | `POST /journal/today/capture` | Quick capture to today's daily note; the "inbox" verb. |

### Organise

| Tool | Backing endpoint | Notes |
| --- | --- | --- |
| `vault_assign` | `POST /pages-assign/{path}`, `POST /pages-assign-bulk` | Set/clear `kind` and `project` frontmatter; the vault relocates the file per the metadata-projected layout (ADR-0001). One tool; `paths: [..]` engages the bulk endpoint with per-path failure reporting. **The** filing verb — the skill steers agents here instead of raw moves. |
| `vault_move_page` | `POST /pages-move/{path}` | Explicit destination move for the cases assign doesn't cover; inbound wikilinks are rewritten by the server. |
| `vault_folder` | `POST`/`DELETE /folders/{path}`, `POST /folders-move/{path}` | `action: create \| delete \| move`. Delete only when empty (server rule). |
| `vault_delete_page` | `DELETE /pages/{path}?force&rewrite` | `destructiveHint: true`. Without `force`, a page with backlinks returns the backlink list instead of deleting — the agent must confirm with `force: true` (and choose `rewrite: plain_text`). |
| `vault_preview_mutation` | `POST /index/preview-mutation` | Dry-run: which files/links a rename/move/delete would rewrite. The skill requires it before bulk organisation and deletes. |

Roughly 15 tools. Phase 2 candidates (explicitly out of scope now): tasks &
agenda (`/tasks`, `/agenda`, `/board`), attachments, archive ingest, academic
works/imports, `vault_stats`, unresolved/ambiguous link reports.

## Error handling & concurrency

- `ApiError` payloads (`src/api/error.rs`) map to MCP tool errors with the
  server's message preserved and a next-step hint appended per class:
  - `404` → suggest `vault_search` (the page may have been relocated by a
    kind/project assignment).
  - `409 Conflict` / `Stale` → "page changed during mutation — re-read with
    `vault_get_page` and re-apply".
  - connection refused → "start the server with `clep serve`".
- `vault_edit_page`/`vault_append_page` implement read-modify-write in the
  MCP process; the server's path-locked `UpdatePageCommand.expected_content`
  check already guarantees a concurrent writer surfaces as `Stale` rather
  than a lost update. The MCP layer retries once on `Stale` for `append`
  (idempotent re-derivation), never for `edit` (the match context may have
  changed).
- Responses are truncated defensively: page bodies over ~50 KB return the
  head plus a note, search defaults to 20 hits. Agents can page/re-query.

## Security

- Inherits the current trust model: the API is unauthenticated and bound to
  `[server] host` (loopback by default). The MCP server adds no new network
  surface — stdio in, localhost HTTP out.
- `clep mcp` refuses to start if the configured host is non-loopback, unless
  passed `--allow-remote` (guards against accidentally pointing an agent at
  someone else's vault over the LAN).
- Destructive operations rely on MCP client-side permissioning plus the
  `force` two-step on delete; no tool bypasses the server's own validation.

## Agent skill

Location: `.claude/skills/vault/SKILL.md` in this repo (picked up
automatically by Claude Code / Cowork sessions here; installable to
`~/.claude/skills/` for use from any directory once the MCP server is
registered globally).

Frontmatter description tuned to trigger on: vault, notes, journal, capture,
filing/organising pages, clepsydra.

Contents (single file, ~150 lines, referencing — not duplicating — ADRs):

1. **Vocabulary** — the 11 `Kind` tokens and their canonical folders
   (`src/vault/kind.rs`); frontmatter fields (`id`, `title`, `type`, `tags`,
   `aliases`, `project`, `created_at`); wikilinks `[[Canonical Name]]` and
   block refs; filename identity scheme (never hand-construct paths — let
   `vault_create_page` derive them).
2. **Core workflows**
   - *Capture*: fleeting input → `vault_journal_capture`; substantial input →
     `vault_create_page` with `kind: CAPTURE`.
   - *Create*: always `vault_search` (and check `vault_tags`) first to avoid
     duplicates and to reuse existing tag vocabulary; link related pages with
     wikilinks in the body.
   - *Edit*: `vault_edit_page` for targeted changes, `vault_update_page`
     only for rewrites; on `Stale`, re-read and re-apply.
   - *Organise*: file with `vault_assign` (kind/project) and let the vault
     relocate files; `vault_preview_mutation` before moves/deletes that touch
     linked pages; never delete with `force` without reporting backlinks to
     the user first.
3. **Registration snippet** — `.mcp.json` entry:
   `{ "mcpServers": { "clepsydra": { "command": "clep", "args": ["mcp"] } } }`
   and the reminder that `clep serve` must be running.

## Testing

- **Unit**: tool-schema serialization, error mapping, edit/append splicing
  (pure functions, no server).
- **Integration**: spin the real axum app on an ephemeral port (the
  `axum-test` harness already used by `src/api` tests), point the MCP layer
  at it, drive tools end-to-end: create → search → edit → assign → preview →
  delete, plus `Stale` injection via a competing write.
- **Manual**: MCP Inspector against `clep mcp`.
- **Evals**: 10 read-only Q&A pairs over a seeded fixture vault (per the
  mcp-builder evaluation format) to measure whether an agent can actually
  navigate the vault with these tools; checked into `docs/plans/` alongside
  this doc or a `tests/mcp_evals/` directory.

## Milestones

1. **M1 — skeleton + read tools** (shipped): `clep mcp` subcommand, rmcp
   wiring, config/base-URL resolution, `search`/`get_page`/`list_pages`/
   `tree`/`links`/`tags`. Integration harness in place.
2. **M2 — create/edit** (shipped): `create_page` (path derivation),
   `update_page`, `edit_page`, `append_page`, `journal_capture`, conflict
   handling. Path derivation stayed client-side: the MCP layer links the
   same crate, so it reuses `page_filename` + `generate_short_id` directly
   (open question 1 resolved — no new server endpoint needed).
3. **M3 — organise** (shipped): `assign`, `move_page`, `folder`,
   `delete_page` (force two-step surfacing the backlink detail),
   `preview_mutation`.
4. **M4 — skill + evals** (shipped): `.claude/skills/vault/SKILL.md`,
   `.mcp.json`, eval set (`tests/mcp_evals/` — fixture vault + 10 verified
   Q&A pairs), and `docs/mcp.md` documenting setup for Claude Code and
   Cowork.

## Open questions

1. **Path derivation for `vault_create_page`**: reuse `new_note`'s logic
   in-process (duplicating the server's view of `default_page_folder`), or
   add a server endpoint (`POST /pages` with no path, server derives it)?
   The latter keeps derivation in one place and benefits the UI too —
   leaning that way, but it grows the HTTP API surface.
2. **Auto-start**: should `clep mcp` spawn `clep serve` when unreachable
   (and own its lifetime), or stay a dumb proxy? Dumb proxy is simpler and
   avoids duplicate-server races; revisit after real usage.
3. **Journal backfill**: `vault_journal_capture` targets today only; is
   capturing to an arbitrary date needed (the API has `GET /journal/{date}`
   but no capture for it)?
4. **Block-level tools**: `/blocks/search` + `/blocks/assign-id` would let
   agents cite and reference blocks precisely — phase 2, or fold
   `assign-id` into M3?
5. **Skill distribution**: in-repo only, or also a plugin/marketplace
   packaging so non-developer Cowork users get the skill + server config in
   one install?
