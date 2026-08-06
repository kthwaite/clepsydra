# MCP server (`clep mcp`)

`clep mcp` exposes the vault to MCP clients — Claude Code, Cowork, Claude
Desktop, or anything else that speaks the Model Context Protocol — as a set
of `vault_*` tools. It runs on stdio and proxies every call to the running
`clep serve` HTTP API, so the server remains the single writer: path locks,
stale-write detection, link rewriting, hooks, and SSE notifications all
apply to agent edits exactly as they do to UI edits.

Design and milestones: docs/plans/2026-08-03-vault-mcp-server-and-skill.md.

## Setup

1. Make sure `clep` is on `PATH` (`cargo install --path .` or symlink the
   build) and the API server is running: `clep serve`.
2. Register the MCP server with your client. This repo ships a project-level
   `.mcp.json`:

   ```json
   { "mcpServers": { "clepsydra": { "command": "clep", "args": ["mcp"] } } }
   ```

   - **Claude Code**: picks up `.mcp.json` from the project root
     automatically, or add it globally with
     `claude mcp add clepsydra -- clep mcp`.
   - **Cowork / Claude Desktop**: add the same command/args entry under
     `mcpServers` in the app's MCP settings.

3. Agents in this repository also get the `vault` skill
   (`.claude/skills/vault/SKILL.md`), which teaches the vault's vocabulary
   and safe workflows.

`clep mcp` discovers the API server through the usual config lookup
(`./config.toml`, then `$XDG_CONFIG_HOME/clepsydra/config.toml`, then
`~/.config/clepsydra/config.toml`) — run it from the directory whose
`config.toml` points at the vault you want. With `[server].tls.enabled`,
it trusts the server's own mkcert certificate. It refuses a non-loopback
`[server].host` unless started with `--allow-remote`.

## Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `vault_search` | read | Full-text search (FTS5) over titles and bodies |
| `vault_get_page` | read | One page by path or id: meta, kind, project, body |
| `vault_list_pages` | read | Paginated page listing, filterable by kind, tag, and project |
| `vault_tree` | read | Folder tree, or one folder's contents |
| `vault_links` | read | Backlinks, outlinks, or similar pages |
| `vault_tags` | read | Tag vocabulary with usage counts |
| `vault_create_page` | write | New page in one atomic mutation; derives the canonical `yyyymmdd.slug.shortid.md` path, declares kind/project |
| `vault_update_page` | write | Whole-field replacement of title/tags/aliases/body |
| `vault_edit_page` | write | Exact-match string edit of the body, guarded by a content hash |
| `vault_append_page` | write | Append to the page or to a heading's section (hash-guarded, one retry) |
| `vault_journal_capture` | write | Quick-capture into today's journal |
| `vault_assign` | organise | Declare kind/project (single or bulk); the vault relocates files |
| `vault_move_page` | organise | Explicit rename/relocate with link rewriting |
| `vault_folder` | organise | Create / delete (`recursive` opt-in) / move folders |
| `vault_delete_page` | organise | Delete; refuses backlinked pages until `force: true` |
| `vault_preview_mutation` | read | Dry-run a move/delete: the plan, including link rewrites |

Errors are written for agents: 404s suggest `vault_search` (the page may
have been refiled), stale-write 409s say re-read and retry, and the delete
tool's backlink refusal includes the linking pages so the agent can review
them before forcing.

Read-modify-write tools (`vault_edit_page`, `vault_append_page`) send the
SHA-256 of the body they read along with the write
(`expected_body_sha256` on `PUT /pages/{path}`); the server rejects the
write with 409 if the body changed since that read, and the mutation
coordinator's path lock carries the check through to the write itself — a
concurrent edit can never be silently overwritten. `vault_create_page`
declares kind/project inside the create mutation itself, and its `folder`
parameter is constrained to locations the metadata-projected layout
(ADR-0001) would not immediately move the page out of.

## Evaluation

`tests/mcp_evals/` contains a fixture vault and ten verified read-only Q&A
pairs for measuring whether an agent can navigate a vault with these tools;
see the README there for how to run them.
