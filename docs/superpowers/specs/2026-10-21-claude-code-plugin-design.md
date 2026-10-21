# Clepsydra Claude Code plugin — design

Date: 2026-10-21. Status: scoped, awaiting plan.
Vault note: `notes/clepsydra/20261021.clepsydra-claude-code-plugin-ideas.tXYNQbc3.md`.

## Goal

One installable Claude Code plugin gives any repo the full clepsydra workflow:
MCP tools, vault skills, task board, task lifecycle, decisions, triage, health,
and research capture. Today these pieces are spread over a dev-only mod, two
repo-local skills, and hand-copied `.mcp.json` and CLAUDE.md sections.

## Starting point

- `~/.claude/dev-mods/070a0211-…/clepsydra/` is already a plugin
  (`.claude-plugin/plugin.json`, `hooks/hooks.json` → `register.tsx`, bun tests).
  It has `/board`, `/task` (bind, `start` → `FIELD`), branch TSK detection,
  `[[wikilink]]` attach, the active-task prompt section, and the queued
  session-end AI journal.
- `.claude/skills/vault` and `.claude/skills/onboard-project` live in this repo only.
- `clep mcp` exposes 28 `vault_*` tools.

## Rulings

| # | Topic | Ruling |
|---|---|---|
| R1 | Location | In this repo: plugin at `integrations/claude-code/clepsydra/`, marketplace at `.claude-plugin/marketplace.json` (repo root). |
| R2 | Skills | `vault` and `onboard-project` move into the plugin. Repo copies are deleted. |
| R3 | MCP | The plugin ships the MCP server (`clep mcp`). Remove the `clepsydra` `.mcp.json` entries in clepsydra, xxii, falls. Tool names become `mcp__plugin_clepsydra_clepsydra__vault_*`. The mod finds tools by `vault_*` suffix through `tool.list`, never by a hard-coded prefix. |
| R4 | Per-project settings | In hub (PROJECT page) frontmatter: `integration_branch`, `triage_index` (a wikilink). |
| R5 | Hub context | SessionStart adds the hub's `## Status` and `## Threads` sections as a session prompt section, max ~2k chars. |
| R6 | Merge trigger | Only merges Claude runs on the main loop (a subagent's Bash call is ignored). On a successful `git merge` (Bash tool) while on the hub's `integration_branch`: the task moves to `REVIEW` and a delivery line is appended. Task = the TSK code in the merged branch name; else the bound TSK, only when that binding was made on the merged branch (bindings are keyed `repoTop@branch`); else none. Merge dir: an absolute `cd`/`-C` dir as given, a relative one joined to the session cwd, none = the session cwd; it must share the session repo's git common dir, and a present `MERGE_HEAD` stops the update. Skip when already `REVIEW`/`SEALED`. No AI-journal entry for merges. |
| R7 | Delivery line | `- merged <short-sha> into <branch> (<YYYY-MM-DD>)` under `## Delivery` on the task page (heading created if missing). |
| R8 | `/decide` | Appends a dated bullet to the hub's `## Decisions` section: decision · why · link (task or commit). |
| R9 | `/triage` | Generic: `/triage <source page \| journal date range>`. The index page comes from hub `triage_index`. Convention = the current Stray Thoughts convention (below). |
| R10 | Health | A `ui.status` segment: `vault ✓`, `vault ✗`, or `vault · N conflicts`. One `ui.notice` at SessionStart only when unhealthy. Server + sync status each poll. `clep doctor` only at start. |
| R11 | Archive URL | New server-side fetch. `vault_archive_url {url, tags}`: clep fetches the page with the external-previews fetch guards (SSRF, size, timeout; no JS), extracts markdown server-side, stores the raw HTML as the snapshot. Lower fidelity than SingleFile (no inlined assets); the page says so. Requires `archive.enabled`. |
| R12 | New MCP tools | Academic import, Bases read, agenda/calendar read, feeds read (+ mark-read). No feed subscribe/unsubscribe. |
| R13 | Allowlist | User-level `~/.claude/settings.json` allows: all read tools (search, get_page, list_pages, tree, links, tags, board, bases, base_query, agenda, feed_entries, preview_mutation, list_rubbish, get_rubbish_item), `vault_task_create`, `vault_task_update`, `vault_ai_journal_capture`, `vault_append_page`, `vault_edit_page`, `vault_import_work`, `vault_archive_url`. (Plugins cannot grant permissions.) |
| R14 | Other repos | Last task trims xxii and falls CLAUDE.md vault sections to a short pointer and removes their `.mcp.json` entry. Left uncommitted there for review. |

## Components

### A. Plugin bundle (R1–R3)

```
.claude-plugin/marketplace.json          # name "clepsydra", one plugin → ./integrations/claude-code/clepsydra
integrations/claude-code/clepsydra/
  .claude-plugin/plugin.json             # from the mod; version bump 0.2.0
  .mcp.json                              # { clepsydra: { command: "clep", args: ["mcp"] } }
  hooks/                                 # mod module + tests (moved)
  skills/vault/  skills/onboard-project/  skills/triage/  skills/decide/  skills/research-to-vault/
  types/  tsconfig.json  package.json    # bun test script
```

- Mod changes: tool-name resolution by suffix (R3). Default `journalModel` →
  `claude-haiku-5-5`.
- `onboard-project` stops writing `.mcp.json` and the long CLAUDE.md section.
  It now writes the hub frontmatter fields (R4) and a two-line CLAUDE.md pointer.
- Install docs: `ui/src/docs/content/claude-code.mdx` (`/plugin marketplace add <repo path>`, `/plugin install clepsydra@clepsydra`, the allowlist block).

### B. Lifecycle (R5–R7)

- `hub.ts` (pure): pick named `##` sections from a body, cap length.
- `merge.ts` (pure): detect a successful `git merge` from a Bash tool call + result;
  get merged branch, new HEAD SHA; decide the target task.
- `register.tsx`: SessionStart loads the hub via the API (read-only GET, like
  the board). A `tool.call` handler (post-result) runs the merge check, then
  `vault_task_update` and `vault_append_page`.
- Open check for the plan: confirm `tool.call` can observe a Bash result after it
  runs. If it can't, fall back to a standard plugin `PostToolUse` hook script.

### C. `/decide`, `/triage` (R8–R9)

Skills, not mod commands: they are prompt workflows run by the model.

- `decide`: resolve project → hub; `vault_append_page` with `heading: "Decisions"`
  (create the section if missing).
- `triage`: encodes the convention now kept only in Claude memory:
  one TSK per source item (`ai-generated`, project, `link` = source page),
  grouping only when items share one delivery surface; P1s + quick wins → `TRIAGE`,
  the rest → `INTAKE`; insert `## Triage — <date>` above the previous triage
  section of the index page; mirror items into the index's
  Bugfixes/Improvements/Features lists as `— [[Title]] (TSK-…)`;
  never write into the human journal.

### D. Health (R10)

- `health.ts` (pure): fold probe results into a segment + optional notice.
- Probes: API reachability (existing GET), `GET /sync/status` for conflicts,
  `clep doctor` (exit code + warning count) once at start, 10 s timeout.

### E. MCP tools (R11–R12) — `crates/clep-mcp`, `crates/clep-api`

| Tool | Backing route | Kind |
|---|---|---|
| `vault_import_work {doi \| isbn \| bibtex}` | `POST /academic/import/{doi,isbn,bibtex}` | write |
| `vault_bases` | `GET /bases` | read |
| `vault_base_query {slug, view}` | `POST /bases/{slug}/views/{view}/evaluate` | read |
| `vault_agenda {from, to}` | `GET /agenda` + `GET /index/calendar` | read |
| `vault_feed_entries {feed?, unread?}` | `GET /feeds/entries` | read |
| `vault_feed_mark_read {ids}` | `POST /feeds/entries/mark-read` | write |
| `vault_archive_url {url, tags}` | new `POST /archive/url` | write |

- `POST /archive/url`: new route + OpenAPI entry; regenerate `schema.d.ts`.
  HTML → markdown crate chosen in the plan (readability-style extraction).
- Update the MCP server instructions text and `ui/src/docs/content/mcp.mdx`.

### F. Research skill (needs E)

`skills/research-to-vault`: when asked to research into the vault, archive
each primary source with `vault_archive_url` (or `vault_import_work` for
DOI/ISBN), then write one NOTE (`ai-generated`, project-filed, hub-linked)
that cites the archived pages by wikilink. Explicit trigger only.

### G. Rollout (R13–R14)

- Add the allowlist to `~/.claude/settings.json`.
- Remove `.mcp.json` `clepsydra` entries (clepsydra, xxii, falls); trim the two
  CLAUDE.md sections; delete the dev-mod copy once the installed plugin works.
- Set `integration_branch` / `triage_index` on the clepsydra, xxii, falls hubs.

## Testing

- Plugin: bun tests for every pure module (`hub`, `merge`, `health`, tool-name
  resolution); existing mod tests keep passing.
- Rust: integration tests per new MCP tool (clep-mcp), `/archive/url` with
  wiremock (success, SSRF refusal, archiving disabled, oversize).
- Manual smoke in a fresh session: install from the marketplace, `/board`,
  `/task start`, a merge into develop on a scratch branch, `/decide`, health
  segment with the server stopped.

## Out of scope

Feed subscribe/unsubscribe; Bases writes; git post-merge hooks for human
merges; AI-journal entries on merge; a clepsydra-dev plugin (OpenAPI regen
hook, `codexView` reminder).

## Suggested phases

1. A + B + D (plugin bundle, lifecycle, health) — TypeScript only.
2. E (MCP tools, `/archive/url`) — Rust.
3. C + F (skills) — after 2 so `research` can use the new tools.
4. G (rollout).
