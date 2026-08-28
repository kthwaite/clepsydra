---
name: vault
description: Use when asked to add or capture something in the clepsydra vault, create or edit pages, search or read notes, tag or file pages, reorganise vault content, or send the current conversation to Clepsydra.
---

# Working the clepsydra vault

The vault is a folder of markdown pages with TOML frontmatter, served by
`clep serve` and operated on through the `clepsydra-vault` MCP tools
(`vault_*`). The server must be running; if tools report it unreachable,
tell the user to start `clep serve` — don't fall back to editing vault
files directly, which bypasses locking, link rewriting, and the index.

## Vocabulary

- **Kinds** — every page has exactly one kind, declared in frontmatter
  (`type =`) or inferred from its top-level folder. Tokens and canonical
  folders: NOTE→`notes/`, PROJECT→`projects/`, JOURNAL→`journals/`,
  AI_JOURNAL→`ai-journals/`, TODO→`todos/`, QUOTE→`quotes/`, BOOK→`books/`,
  CAPTURE→`captures/`, CODE→`code/`, PERSON→`people/`, TASK→`tasks/`, CYCLE→`cycles/`,
  RECIPE→`recipes/`, MEETING→`meetings/`, AI_CONVERSATION→`conversations/`.
  There is no 1:1 kind: a 1:1 is a MEETING tagged `1:1`.
- **Frontmatter** — `id` (UUID, never touch), `title`, `type`, `tags`,
  `aliases`, `project`, `created_at`/`updated_at`.
- **Attendees** — MEETING pages name people in `attendees`, a list of
  wikilinks to person pages. A MEETING names any number; a 1:1 is a MEETING
  tagged `1:1`. `vault_search` counts them: `attendees:1`, `attendees:>1`,
  `attendees:0`; find 1:1s with `kind:meeting tag:1:1`.
- **Occurred** — MEETING pages record when they happened in `occurred_at`, an
  unquoted TOML date-time (`2026-08-27T14:00:00Z`, or a bare date). Quoted, it
  is refused: a string never sorts or filters as a date.
- **Wikilinks** — `[[Canonical Name]]` links pages by title-derived name or
  alias. The server rewrites inbound links on moves/renames/deletes.
- **Filenames** — authored pages use `yyyymmdd.slug.shortid.md`
  (docs/adr/0002). Never construct these by hand; `vault_create_page`
  derives them.
- **Projects** — a declared `project` files the page under
  `<kind-folder>/<project>/` (docs/adr/0001).

## Choosing the right tool

| Intent | Tool |
| --- | --- |
| Fleeting thought, log entry (user's own, on request) | `vault_journal_capture` |
| Agent-initiated note, work log, aside | `vault_ai_journal_capture` |
| Current visible conversation | `vault_capture_conversation` — not create |
| New standalone page | `vault_create_page` |
| Targeted body change | `vault_edit_page` |
| Add to a page or a section | `vault_append_page` |
| Retitle / retag / rewrite wholesale | `vault_update_page` |
| File pages (kind/project) | `vault_assign` — not move |
| Explicit rename/relocate | `vault_move_page` |
| Folder create/delete/move | `vault_folder` |
| Remove a page | `vault_delete_page` |
| See what a move/delete would rewrite | `vault_preview_mutation` |
| See the Task Board / look up codes | `vault_board` |
| New Task | `vault_task_create` — not create |
| Move a Task through the board / edit fields | `vault_task_update` |
| New Cycle | `vault_cycle_create` |
| Close or edit a Cycle | `vault_cycle_update` |
| Find / read / orient | `vault_search`, `vault_get_page`, `vault_list_pages`, `vault_tree`, `vault_links`, `vault_tags` |

## Workflows

**Capture.** Fleeting input splits by whose journal it belongs in.
`vault_journal_capture` writes to the user's own journal (markdown bullet,
e.g. `- idea: ...`) — use it only when the user explicitly asks for a
journal capture. `vault_ai_journal_capture` writes to the separate AI
journal instead: it's the default for agent-initiated notes, work logs, and
session asides, and takes an optional `author` label (e.g. `claude-code`) to
attribute the entry. Do not add `ai-generated` to either capture merely
because an LLM performed it. Substantial input becomes a page:
`vault_create_page` with `kind: CAPTURE` if it still needs processing, or its
real kind if it's already formed.

**Conversation.** “Send this conversation to Clepsydra” means
`vault_capture_conversation`, never `vault_create_page`: generic creation
omits the identity and prefix ledger needed for safe append. Do not add
`ai-generated` merely because an LLM performed the conversation capture.
Send every complete visible user/assistant turn in source order, verbatim.
Do not summarize. Clepsydra cannot retrieve omitted or truncated turns, hidden
system/developer prompts, tool calls or results, or attachment contents.
When the host exposes both provider and conversation ID, pass both; the
server keeps the normalized provider and a derived hash, not the raw host
ID, then creates once. Later captures match earlier turns by ordered role,
content, and source turn identity before appending only the new suffix;
timestamp differences do not affect matching. A missing host ID creates a
new Folio. Report the returned `created`, `appended`, or `unchanged`
operation. On truncation or divergence conflict, ask the user to re-run
from a host context containing the complete earlier prefix; never
fuzzy-match or overwrite.

**Create.** Always `vault_search` first — the note may exist; extend it
instead of duplicating. Every standalone page authored by an LLM must
include the `ai-generated` tag. Check `vault_tags` and reuse existing tag
spellings. Declare the page's real Kind and project, and let the tool derive
the path. Substantial project documentation must wikilink its project or hub
page; wikilink other related pages in the body (`[[Title]]`). Pass `folder`
only when the user names a specific location.

**Edit.** Read with `vault_get_page`, then `vault_edit_page` with an exact
unique `old_string` (or `vault_append_page` to add). If the body came back
`body_truncated: true`, don't edit blind — narrow the target first. On a
conflict error, re-read and re-apply; never blindly retry the same payload.
An edit does not add `ai-generated` merely because an LLM performed it.

**Organise.** Filing means declaring metadata: `vault_assign` with `kind`
and/or `project` (bulk-capable via `paths`) — the vault relocates files
itself and rewrites links. Use `vault_move_page` only for destinations
assignment can't express, and run `vault_preview_mutation` first when the
page has backlinks or you're moving folders.

**Task Board.** Use display labels in prose and persisted values in MCP calls:
Inbox (`INTAKE`) → Ready (`TRIAGE`) → In Progress (`FIELD`) → Review
(`REVIEW`) → Done (`SEALED`). Priorities are P0 Critical, P1 High, P2 Medium,
and P3 Low. Orient with `vault_board`; it lists Task TSK codes, Cycle S codes,
and Projects through the legacy `operations` response field. Codes are
server-minted petnames — `TSK-<adjective>-<noun>-<tail>` for Tasks,
`S-<adjective>-<noun>-<tail>` for Cycles (e.g. `TSK-brave-finch-7q3zd`) —
never invent one. Input is matched case-insensitively, and any unique prefix
(e.g. `TSK-brave-finch`) addresses the page; an ambiguous prefix is rejected
with the candidates listed. Legacy `vault_board` response fields remain
unchanged. The raw
`columns[].label`/`columns[].sub` pairs are `INTAKE`/`unfiled`,
`TRIAGE`/`staged`, `IN-FIELD`/`active`, `REVIEW`/`qa / seal`, and
`SEALED`/`closed`. Derive display labels from `columns[].id` using the status
mapping above. `tasks[].checks` is `[done, total]` Checklist Item counts.
`tasks[].link` and `operations[].dossier` are Related Page values.

Create Tasks with `vault_task_create`, never `vault_create_page` — the server
mints the `TSK-<adjective>-<noun>-<tail>` code and files the page under
`tasks/<project>/`; include `ai-generated` in tags for LLM-authored Tasks.
The `body` wire field is the Task Description. Checklist values become Todos.
Move and edit with `vault_task_update`, addressing the Task by code (or any
unique prefix of one), path, or id. Title/Project/status/priority/tags update
when present (`clear_project: true` clears the Project). Cycle, assignee,
estimate, due, blocker reason (`hold`), and Related Page (`link`) are
tri-state — absent keeps, `null` or `""` clears, and a value sets. A
non-empty `hold` means Blocked; Cycle `"BACKLOG"` moves the Task to Backlog.

Create Cycles with `vault_cycle_create` (omit `code` to have the server mint
an `S-<adjective>-<noun>-<tail>` code; an explicit `code` must match that
same format or it is rejected; `CLOSED` is rejected at creation).
Close a finished Cycle with `vault_cycle_update` using state `CLOSED`. Pass
`carry_to` to move unfinished Tasks: `"BACKLOG"` moves them to Backlog, while
a Cycle code or unique prefix reassigns them.

**Delete.** `vault_delete_page` without `force` first. If it refuses with a
backlink list, show the user what links there and confirm before re-running
with `force: true` (default rewrite `plain_text` turns inbound links into
plain text). For folders, inspect with `vault_tree` before any
`recursive: true` delete.

## Don'ts

- Don't edit vault files with filesystem tools while the server is running.
- Don't invent filenames, ids, or kind tokens (valid kinds are listed above).
- Don't create near-duplicate pages — search, then extend or link instead.
- Don't use `vault_create_page` for a current conversation; it cannot provide
  conversation identity, verified-prefix, or safe suffix-append semantics.
- Don't force-delete or recursively delete without surfacing what will be
  affected to the user first.

## Setup (once)

Register the MCP server in the project's `.mcp.json` (already present in
this repo):

```json
{ "mcpServers": { "clepsydra": { "command": "clep", "args": ["mcp"] } } }
```

`clep mcp` finds the server via the usual config lookup (`./config.toml`,
then `~/.config/clepsydra/config.toml`) and refuses non-loopback hosts
unless passed `--allow-remote`. See `ui/src/docs/content/mcp.mdx` for details.
