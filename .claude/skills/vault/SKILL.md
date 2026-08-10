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
  TODO→`todos/`, QUOTE→`quotes/`, BOOK→`books/`, CAPTURE→`captures/`,
  CODE→`code/`, PERSON→`people/`, TASK→`tasks/`, CYCLE→`cycles/`,
  AI_CONVERSATION→`conversations/`.
- **Frontmatter** — `id` (UUID, never touch), `title`, `type`, `tags`,
  `aliases`, `project`, `created_at`/`updated_at`.
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
| Fleeting thought, log entry | `vault_journal_capture` |
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
| Find / read / orient | `vault_search`, `vault_get_page`, `vault_list_pages`, `vault_tree`, `vault_links`, `vault_tags` |

## Workflows

**Capture.** Fleeting input goes to today's journal via
`vault_journal_capture` (markdown bullet, e.g. `- idea: ...`). Substantial
input becomes a page: `vault_create_page` with `kind: CAPTURE` if it still
needs processing, or its real kind if it's already formed.

**Conversation.** “Send this conversation to Clepsydra” means
`vault_capture_conversation`, never `vault_create_page`: generic creation
omits the identity and prefix ledger needed for safe append. Send every
complete visible user/assistant turn in source order, verbatim. Do not
summarize. Clepsydra cannot retrieve omitted or truncated turns, hidden
system/developer prompts, tool calls or results, or attachment contents.
When the host exposes both provider and conversation ID, pass both; the
server keeps the normalized provider and a derived hash, not the raw host
ID, then creates once and appends only an exact new suffix. A missing host
ID creates a new Folio. Report the returned `created`, `appended`, or
`unchanged` operation. On truncation or divergence conflict, ask the user
to re-run from a host context containing the complete earlier prefix; never
fuzzy-match or overwrite.

**Create.** Always `vault_search` first — the note may exist; extend it
instead of duplicating. Check `vault_tags` and reuse existing tag spellings.
Wikilink related pages in the body (`[[Title]]`), including one link back to
the relevant project or hub page when there is one. Let the tool derive the
path; pass `folder` only when the user names a specific location.

**Edit.** Read with `vault_get_page`, then `vault_edit_page` with an exact
unique `old_string` (or `vault_append_page` to add). If the body came back
`body_truncated: true`, don't edit blind — narrow the target first. On a
conflict error, re-read and re-apply; never blindly retry the same payload.

**Organise.** Filing means declaring metadata: `vault_assign` with `kind`
and/or `project` (bulk-capable via `paths`) — the vault relocates files
itself and rewrites links. Use `vault_move_page` only for destinations
assignment can't express, and run `vault_preview_mutation` first when the
page has backlinks or you're moving folders.

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
