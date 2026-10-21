# Clepsydra Claude Code Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one installable `clepsydra` Claude Code plugin (MCP server, skills, board/task mod, lifecycle, health) from this repo, plus the MCP tools it needs.

**Architecture:** The existing dev-mod (`~/.claude/dev-mods/070a0211-5b56-4319-8407-99f14f655225/clepsydra/`) moves into `integrations/claude-code/clepsydra/` and grows pure modules (`tools`, `hub`, `merge`, `health`) wired in `register.tsx`. Seven MCP tools join `crates/clep-mcp`; one new route `POST /api/vault/archive/url` in `crates/clep-api` fetches a page server-side and reuses archive ingest. Skills are markdown in the plugin.

**Tech Stack:** Claude Code mod host API (`claude-code`, `claude-code/testing`, `claude plugin test|validate`), Rust 2024 (rmcp `#[tool]`, axum, utoipa, `clep_feeds::network::CheckedHttpClient`), MDX docs.

**Spec:** `docs/superpowers/specs/2026-10-21-claude-code-plugin-design.md`

## Global Constraints

- Work in a worktree `.worktrees/claude-code-plugin` on `feature/claude-code-plugin` off `develop`. The main checkout has the user's uncommitted Bases/Folio edits: never touch them. Before `cargo test` in the worktree, `ui/dist` must exist (rust-embed); seed `target/` per the `rust-apfs-worktrees` skill.
- Plugin root: `integrations/claude-code/clepsydra/`. Marketplace: `.claude-plugin/marketplace.json` at repo root, marketplace name `clepsydra`, one plugin `clepsydra`, source `./integrations/claude-code/clepsydra`. Plugin version `0.2.0`.
- Plugin MCP server: `{ "clepsydra": { "command": "clep", "args": ["mcp"] } }` in the plugin's `.mcp.json`. Plugin tool names: `mcp__plugin_clepsydra_clepsydra__vault_*`. The mod never hard-codes a tool prefix.
- Hub frontmatter keys: `integration_branch` (string), `triage_index` (wikilink string, e.g. `"[[Clepsydra: Stray Thoughts]]"`).
- Hub prompt section: only `## Status` and `## Threads`, total ≤ 2000 chars, section id `clepsydra:hub`.
- Delivery line: `- merged <short-sha> into <branch> (<YYYY-MM-DD>)` under `## Delivery` on the task page. No AI-journal entry on merge.
- Health segment text: `vault ✓`, `vault ✗`, `vault · N conflicts`. One `ui.notice` at session start only when unhealthy.
- `journalModel` default: `claude-haiku-5-5`.
- `vault_archive_url` pages carry the tag `server-fetch` (marks the lower fidelity than SingleFile).
- Hooks never throw into the host and never block a prompt on the network (existing mod rule: network work goes through `$.clock.after(0, …)`).
- After any route/DTO change: `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.
- Every `clep` run in tests/scratch sets `CLEPSYDRA__VAULT__ROOT` (ambient-config hazard). The health probe's `clep doctor --json` is the one deliberate exception: it reports on the user's real config, read-only.
- Stage explicit paths (`git add .` is intercepted by the user's shell).

## Review Focus

1. **Merge command variants** — `git merge --abort`, `--squash`, `--no-commit`, a conflicted merge (non-zero exit), `git pull`, `cd <dir> && git merge x`, `git -C <dir> merge x`. Only a completed merge counts, in the directory it ran in. Pinned in Task 4.
2. **Vault server down** — at session start, during a merge update, during health polls. No throw, no blocked prompt; a failed merge update shows a toast naming the task, not silence. Pinned in Tasks 4 and 5.
3. **Hub shape** — no hub for the slug, a hub with neither section, two PROJECT pages for one slug (the `board = true` one wins, as on the board), a missing `integration_branch` (no merge automation). Pinned in Task 3.
4. **Archive URL inputs** — non-HTML content (PDF), an empty Readability result (fall back to whole-body markdown), a redirect to a private address, an oversize body, archiving disabled. Pinned in Task 8.
5. **Duplicate MCP servers** — a repo that still has a `clepsydra` `.mcp.json` entry while the plugin is installed. Tool resolution prefers `mcp__plugin_clepsydra_clepsydra__*`, falls back to `mcp__clepsydra__*`. Pinned in Task 2.

---

## Phase 1 — Plugin bundle, lifecycle, health (TypeScript)

### Task 1: Move the mod into the repo as a marketplace plugin

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `integrations/claude-code/clepsydra/` ← copy of the dev-mod dir (`hooks/`, `types/`, `tsconfig.json`, `.claude-plugin/plugin.json`, `.claude-plugin/types/` honouring its `.gitignore`)
- Create: `integrations/claude-code/clepsydra/.mcp.json`
- Modify: `integrations/claude-code/clepsydra/.claude-plugin/plugin.json` (version `0.2.0`; `journalModel` default `claude-haiku-5-5`)
- Modify: `integrations/claude-code/clepsydra/hooks/register.tsx` (`DEFAULTS.journalModel`)
- Modify: `justfile` — recipe `plugin-test` running `claude plugin validate integrations/claude-code/clepsydra && claude plugin validate . && claude plugin test integrations/claude-code/clepsydra`

**Interfaces:**
- Produces: plugin root path, `just plugin-test`.

- [ ] **Step 1:** Copy the dev-mod into the plugin root (do not delete the dev-mod; Task 14 does that). Write `marketplace.json` and `.mcp.json` per Global Constraints.
- [ ] **Step 2:** Run `just plugin-test`. Expected: both validates pass; all existing mod tests pass (`format`, `journal`, `links`, `project`, `register`, `tasks`).
- [ ] **Step 3:** Commit `feat(plugin): move clepsydra mod into an in-repo marketplace`.

### Task 2: Resolve vault tools by suffix

**Files:**
- Create: `integrations/claude-code/clepsydra/hooks/tools.ts`, `hooks/tools.test.ts`
- Modify: `hooks/register.tsx` (drop `TASK_TOOL`/`JOURNAL_TOOL` constants; `callTool` takes a suffix)

**Interfaces:**
- Produces: `resolveVaultTool(names: readonly string[], suffix: string): \`mcp__${string}__${string}\` | undefined` — matches `mcp__<server>__<suffix>` where the server is `plugin_clepsydra_clepsydra` (preferred) or `clepsydra`; nothing else. `callVault($, suffix: string, input, consent?)` in `register.tsx`, which lists tools once per session via `$.tool.list` and caches the map; an unresolved suffix returns `{ ok: false, text: 'clepsydra MCP tool <suffix> not available' }`.

- [ ] **Step 1: Failing tests** in `tools.test.ts`:
  - `prefers the plugin server`: names `['mcp__clepsydra__vault_task_update','mcp__plugin_clepsydra_clepsydra__vault_task_update']`, suffix `vault_task_update` → the plugin name.
  - `falls back to the repo server`: only `mcp__clepsydra__vault_task_update` → that name.
  - `ignores other servers`: `['mcp__other__vault_task_update']` → `undefined`.
  - `exact suffix`: `['mcp__clepsydra__vault_task_update_extra']` → `undefined`.
- [ ] **Step 2:** `claude plugin test integrations/claude-code/clepsydra` → FAIL (module missing).
- [ ] **Step 3:** Implement `resolveVaultTool`; switch `register.tsx` call sites to `callVault($, 'vault_task_update', …)` / `'vault_ai_journal_capture'`. Extend `register.test.tsx`: a session whose tool list holds only the plugin-named task tool still moves a task to `FIELD` on `/task start`.
- [ ] **Step 4:** `just plugin-test` → PASS.
- [ ] **Step 5:** Commit `feat(plugin): resolve vault MCP tools by suffix`.

### Task 3: Hub context at session start

**Files:**
- Create: `hooks/hub.ts`, `hooks/hub.test.ts`
- Modify: `hooks/register.tsx` (load hub in `startup`; `hubRef` atom; `prompt.compose` adds the `clepsydra:hub` section)
- Modify: `hooks/tasks.ts` `parseBoard` if needed so the board's `operations[]` rows expose `project`, `board` flag and page `path` (`HubRow = { project: string; path: string; board: boolean }`)

**Interfaces:**
- Produces:
  - `hubSections(body: string, names: readonly string[], cap: number): string | undefined` — the named `##` sections in body order, each with its heading, joined by a blank line, cut at `cap` chars with `…`; `undefined` when none match.
  - `hubSettings(meta: Record<string, unknown>): HubSettings` where `HubSettings = { integrationBranch?: string; triageIndex?: string }` (from `integration_branch`, `triage_index`; non-strings ignored).
  - `pickHub(rows: readonly HubRow[], slug: string): HubRow | undefined` — `board: true` wins ties, then first.
  - `hubRef` atom value `{ path: string; title: string; settings: HubSettings; section?: string } | null`, read by Tasks 4 and 11.
- Hub load: `pickHub` over board operations, then `getJson($, '/pages/' + path)` (page detail: `meta` carries extras); on any failure `hubRef` stays `null` and nothing is added.

- [ ] **Step 1: Failing tests** in `hub.test.ts`:
  - `keeps only Status and Threads`: body with `## Status`, `## Notes`, `## Threads` → output contains Status and Threads text, not Notes.
  - `caps at 2000 chars`: a 5000-char Status → length ≤ 2000, ends with `…`.
  - `undefined without sections`: body with only `## Notes` → `undefined`.
  - `heading match ignores case and trailing spaces`: `## status  ` matches.
  - `settings`: `{ integration_branch: 'develop', triage_index: '[[X]]', other: 1 }` → `{ integrationBranch: 'develop', triageIndex: '[[X]]' }`; `{ integration_branch: 3 }` → `{}`.
  - `pickHub prefers board true`: two rows for `clepsydra`, second `board: true` → second.
  - `pickHub none`: no row for slug → `undefined`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; wire into `startup` after `refreshBoard`. In `register.test.tsx`: with a stubbed board + page reply, the composed prompt contains section `clepsydra:hub`; with the page fetch failing, no hub section and no error surfaced.
- [ ] **Step 4:** `just plugin-test` → PASS.
- [ ] **Step 5:** Commit `feat(plugin): add project hub status to session context`.

### Task 4: Merge → Review with a Delivery line

**Files:**
- Create: `hooks/merge.ts`, `hooks/merge.test.ts`
- Modify: `hooks/register.tsx` (`on('tool.call', { tool: 'Bash' }, …)`: `const r = await next(e)`, inspect, schedule the update with `$.clock.after(0, …)`, return `r` unchanged)
- Modify: `hooks/tasks.ts` — `BoardTask` gains `path: string` if absent

**Interfaces:**
- Consumes: `hubRef` (Task 3), `callVault` (Task 2), `branchTaskCode`, `bindingRef`, `boardRef`.
- Produces:
  - `parseMerge(command: string): MergeCall | undefined`, `MergeCall = { dir?: string; branch: string }`. Recognises `git merge <opts> <branch>` alone or after `cd <dir> &&`, and `git -C <dir> merge …`. Returns `undefined` for `--abort`, `--continue`, `--quit`, `--squash`, `--no-commit`, `git pull`, and merges with no branch argument.
  - `mergeTask(input: { bound?: string; mergedBranch: string; tasks: readonly BoardTask[] }): BoardTask | undefined` — bound code first, else `branchTaskCode(mergedBranch)`; `undefined` when not on the board or status is `REVIEW`/`SEALED`.
  - `deliveryLine(sha: string, branch: string, date: string): string` → exact Global Constraints format.
  - `deliveryAppend(body: string, line: string): { heading?: 'Delivery'; content: string }` — `heading: 'Delivery'` and `content = line` when the body has a `## Delivery` heading; else no heading and `content = '\n## Delivery\n\n' + line + '\n'`.
- Runtime flow after a Bash result with exit 0 and a `MergeCall`: in `dir ?? repo top`, `git rev-parse --abbrev-ref HEAD` must equal `hubRef.settings.integrationBranch` (absent → stop); `git rev-parse --short HEAD` → sha; `mergeTask`; `callVault('vault_task_update', { task, status: 'REVIEW' })`; `callVault('vault_get_page', { path })` → `deliveryAppend` → `callVault('vault_append_page', …)`; toast `TSK-… → REVIEW (sha)` on success, `could not update TSK-…: <reason>` on failure; refresh board.

- [ ] **Step 1: Failing tests** in `merge.test.ts`:
  - `plain merge`: `git merge --no-ff feature/TSK-brave-finch-7q3zd` → `{ branch: 'feature/TSK-brave-finch-7q3zd' }`.
  - `cd prefix`: `cd /repo && git merge x` → `{ dir: '/repo', branch: 'x' }`.
  - `-C`: `git -C /repo merge --no-ff -m "m" x` → `{ dir: '/repo', branch: 'x' }`.
  - `excluded`: each of `git merge --abort`, `git merge --squash x`, `git merge --no-commit x`, `git pull`, `git merge` → `undefined`.
  - `mergeTask bound wins`: bound `TSK-a-b-1`, branch with `TSK-c-d-2`, both on board → `TSK-a-b-1`.
  - `mergeTask from branch`: no binding → the branch's code.
  - `mergeTask skips review/sealed`: status `REVIEW` → `undefined`; `SEALED` → `undefined`.
  - `deliveryLine`: `('a1b2c3d','develop','2026-10-21')` → `- merged a1b2c3d into develop (2026-10-21)`.
  - `deliveryAppend existing / missing heading`: both branches above.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `merge.ts`; wire the Bash `tool.call` handler. In `register.test.tsx`:
  - a successful merge on `develop` with hub `integration_branch = 'develop'` calls the task-update tool with `status: 'REVIEW'` and the append tool with the delivery line;
  - the same merge with exit code 1 calls neither;
  - current branch `main` ≠ `develop` → neither;
  - task-update tool erroring → a toast containing `could not update`, and the Bash result returned unchanged;
  - the handler returns `next`'s result object identically in every case.
- [ ] **Step 4:** `just plugin-test` → PASS.
- [ ] **Step 5:** Commit `feat(plugin): move merged tasks to Review with a delivery line`.

### Task 5: Health segment and notice

**Files:**
- Create: `hooks/health.ts`, `hooks/health.test.ts`
- Modify: `hooks/register.tsx` (`healthRef`; probes in `startup` and in the existing 30 s poll; `showStatus` joins task entry + health)

**Interfaces:**
- Produces:
  - `Health = { reachable: boolean; conflicts: number; doctor?: { errors: number; warnings: number } }`
  - `healthSegment(h: Health): string` → `vault ✗` when unreachable, `vault · N conflicts` when `conflicts > 0`, else `vault ✓`.
  - `healthNotice(h: Health): string | undefined` — `undefined` when reachable, 0 conflicts and 0 doctor errors; else one sentence naming each problem (e.g. `clepsydra: server unreachable — start clep serve`, `clepsydra: 2 sync conflicts — open /conflicts`, `clepsydra: clep doctor reports 1 error`).
  - `statusText(task: string | undefined, health: string): string` — `task · health` or `health`.
  - `conflictCount(json: unknown): number` — from `GET /sync/status` (read the `SyncStatus` schema in `crates/clep-api/src/api/sync.rs` for the field; non-sync vault → 0).
  - `doctorCounts(stdout: string): { errors: number; warnings: number } | undefined` — from `clep doctor --json` (check statuses `ERR`/`WARN`; read the JSON shape from `crates/clep-doctor`); unparsable → `undefined`.
- Probes: reachable = the board GET succeeded; conflicts = `getJson('/sync/status')` each poll; doctor = `exec(['clep','doctor','--json'], 10_000)` once in `startup`. Notice via `$.ui.notice` once per session.

- [ ] **Step 1: Failing tests** for each function: segment for all three states; notice `undefined` when healthy and naming both problems when unreachable + doctor error; `statusText` with and without task; `conflictCount` on a sample reply, on `{}` → 0; `doctorCounts` on a sample report with 1 ERR + 2 WARN, and on `not json` → `undefined`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement and wire. `register.test.tsx`: board fetch failing at start → status `vault ✗` and exactly one notice; healthy start → no notice; a later poll that fails does not raise a second notice.
- [ ] **Step 4:** `just plugin-test` → PASS.
- [ ] **Step 5:** Commit `feat(plugin): show vault health in the status line`.

## Phase 2 — MCP tools and server-side archive (Rust)

### Task 6: Read tools — Bases, agenda, feeds

**Files:**
- Create: `crates/clep-mcp/src/reading.rs` (param structs, query builders, date → RFC3339 helpers)
- Modify: `crates/clep-mcp/src/lib.rs` (`mod reading;`), `crates/clep-mcp/src/server.rs` (four `#[tool]` methods in the `#[tool_router]` impl; tests in its `mod tests`)

**Interfaces:**
- Produces (all `read_only_hint = true, destructive_hint = false, idempotent_hint = true`):
  - `vault_bases()` → `GET /api/vault/bases`.
  - `vault_base_query(BaseQueryParams { slug: String, view: String })` → `POST /api/vault/bases/{slug}/views/{view}/evaluate` with the minimal `BaseViewEvaluateRequest` body (read its struct in `crates/clep-api/src/api/bases.rs`; send defaults).
  - `vault_agenda(AgendaParams { today: Option<String>, from: Option<String>, to: Option<String> })` — dates `YYYY-MM-DD`; `today` defaults to local today; returns `{ "agenda": <GET /agenda?today=>, "calendar": <GET /index/calendar?from=&to=> }`, `calendar` present only when both `from` and `to` are given. `from`/`to` become local-midnight RFC3339 (`calendar_bounds(from, to) -> Result<(String, String), String>` in `reading.rs`; `to` is exclusive, so `to` + 1 day).
  - `vault_feed_entries(FeedEntriesParams { feed: Option<Vec<i64>>, unread: Option<bool>, limit: Option<u32> })` → `GET /api/vault/feeds/entries` (`unread: true` → `view=unread`; check `EntryViewDto` spelling).

- [ ] **Step 1: Failing tests** (`server.rs` tests, using `serve_seeded_vault`):
  - `bases_lists_seeded_bases` — create a base via `POST /api/vault/bases`, then `vault_bases` contains its slug.
  - `base_query_evaluates_a_view` — the created base's default view returns rows JSON (assert an array key, e.g. `rows`).
  - `agenda_without_range_has_no_calendar` / `agenda_with_range_has_calendar`.
  - `calendar_bounds_rejects_bad_dates` (unit, `reading.rs`): `('2026-13-01','2026-10-02')` → `Err`; `from > to` → `Err`.
  - `feed_entries_empty_vault` → empty list, no error.
  - Extend the instructions test: instructions mention `vault_bases`, `vault_agenda`, `vault_feed_entries`.
- [ ] **Step 2:** `cargo test -p clep-mcp` → FAIL.
- [ ] **Step 3:** Implement; add one sentence per tool group to the server instructions.
- [ ] **Step 4:** `cargo test -p clep-mcp` → PASS; `cargo clippy -p clep-mcp --all-targets -- -D warnings` clean.
- [ ] **Step 5:** Commit `feat(mcp): add Bases, agenda and feed read tools`.

### Task 7: Write tools — academic import, feed mark-read

**Files:**
- Modify: `crates/clep-mcp/src/reading.rs` (params + validation), `crates/clep-mcp/src/server.rs`

**Interfaces:**
- Produces:
  - `vault_import_work(ImportWorkParams { doi: Option<String>, isbn: Option<String>, bibtex: Option<String> })` — exactly one must be non-empty (`import_route(&ImportWorkParams) -> Result<(&'static str, Value), String>` returns `/api/vault/academic/import/{doi|isbn|bibtex}` and body `{doi}`/`{isbn}`/the bibtex body shape from `academic.rs`). Annotations: not read-only, not destructive, idempotent (imports dedupe; confirm in `academic.rs`, else `idempotent_hint = false`).
  - `vault_feed_mark_read(MarkReadParams { ids: Vec<i64> })` → `POST /api/vault/feeds/entries/mark-read` (body per its request struct). Empty `ids` → error without a request.

- [ ] **Step 1: Failing tests:** `import_route` unit tests — none set → `Err` naming all three; two set → `Err`; whitespace-only counts as unset; each single field → its route. `mark_read_rejects_empty_ids`. Tool registry test: both tools listed with the stated annotations.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `cargo test -p clep-mcp` → PASS; clippy clean.
- [ ] **Step 5:** Commit `feat(mcp): add academic import and feed mark-read tools`.

### Task 8: `POST /api/vault/archive/url`

**Files:**
- Create: `crates/clep-api/src/api/archive_url.rs`
- Modify: `crates/clep-api/src/api/archive.rs` (extract ingest core), `crates/clep-api/src/api/mod.rs` (route), `crates/clep-api/src/api/openapi.rs`, `crates/clep-api/Cargo.toml` (+ readability and HTML→markdown crates; check current versions with context7/crates.io: candidates `dom_smoothie`, `htmd`), `ui/src/api/schema.d.ts` (regenerated)
- Test: in-module tests in `archive_url.rs`; route tests in `crates/clep-api/tests/` beside existing archive tests

**Interfaces:**
- Produces:
  - `pub(crate) async fn ingest(state: &AppState, req: ArchiveRequest) -> Result<(StatusCode, ArchiveResponse), ApiError>` — the body of today's `ingest_archive` after the `enabled` check; `ingest_archive` becomes a thin wrapper. Behaviour unchanged (existing archive tests stay green).
  - `ArchiveUrlRequest { url: String, tags: Vec<String> }` (`#[serde(default)]` on tags), response `ArchiveResponse`, 200/201 like `/archive`.
  - `pub(crate) async fn fetch_page(client: &CheckedHttpClient, url: &Url) -> Result<FetchedPage, ArchiveUrlError>`; `FetchedPage { final_url: Url, html: String, title: String, byline: Option<String>, site_name: Option<String>, published_time: Option<String>, lang: Option<String>, markdown: String }`. Follows redirects through `CheckedHttpClient` (same policy as previews); refuses non-`text/html` content types; Readability article → markdown, empty article → whole `<body>` → markdown.
  - `fn to_archive_request(page: FetchedPage, tags: Vec<String>, captured_at: String) -> ArchiveRequest` — `snapshot_html = page.html`, `content_hash = ContentStore::hash_bytes(markdown)`, `domain` from host, tags = given ∪ `server-fetch`.
  - Errors: archiving disabled → 403; invalid/non-http URL → 400; private destination or fetch failure → 422 `could not fetch <host>` (never echo query strings); non-HTML → 422 `not an HTML page`.
  - Handler uses `CheckedHttpClient::new(MAX_ARCHIVE_BYTES)` with `MAX_ARCHIVE_BYTES = 8 * 1024 * 1024`, 20 s deadline.

- [ ] **Step 1: Failing tests:**
  - `fetch_page_extracts_article` — wiremock serves an article page; `CheckedHttpClient::for_test(MAX, "example.test", addr)`; markdown contains the article heading, not the nav text; title set.
  - `fetch_page_falls_back_to_body` — page with no article structure → non-empty markdown.
  - `fetch_page_rejects_pdf` — `application/pdf` → `NotHtml`.
  - `fetch_page_rejects_oversize` — body > limit → error.
  - `to_archive_request_adds_server_fetch_tag_and_hash` — tag present once even if given; `content_hash` equals `hash_bytes(markdown)`.
  - Route tests: archiving disabled → 403; `http://127.0.0.1/x` → 422 with no URL path in the message; `ftp://x` → 400.
- [ ] **Step 2:** `cargo test -p clep-api archive` → FAIL.
- [ ] **Step 3:** Implement; register route + OpenAPI; regenerate `schema.d.ts` with the offline command.
- [ ] **Step 4:** `cargo test -p clep-api` → PASS; clippy clean; `(cd ui && bun run typecheck)` → PASS.
- [ ] **Step 5:** Commit `feat(archive): archive a URL by server-side fetch`.

### Task 9: `vault_archive_url` tool and docs

**Files:**
- Modify: `crates/clep-mcp/src/server.rs`, `ui/src/docs/content/mcp.mdx`

**Interfaces:**
- Consumes: `POST /api/vault/archive/url` (Task 8).
- Produces: `vault_archive_url(ArchiveUrlParams { url: String, tags: Option<Vec<String>> })`; not read-only, not destructive, idempotent. Description says: server-side fetch, lower fidelity than the browser extension, tagged `server-fetch`, requires archiving enabled.

- [ ] **Step 1: Failing tests:** registry test (name + annotations); against `serve_seeded_vault` with archiving disabled in the seed config → error text contains `archiving is disabled`. Instructions test mentions `vault_archive_url` and `vault_import_work`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; document all seven new tools in `mcp.mdx` (one row each, matching the existing table style).
- [ ] **Step 4:** `cargo test -p clep-mcp` → PASS.
- [ ] **Step 5:** Commit `feat(mcp): add vault_archive_url`.

## Phase 3 — Skills and docs

Skills have no unit tests. Each task's gate is `claude plugin validate integrations/claude-code/clepsydra`, plus the content checks listed. Follow the `writing-for-agents` skill for wording.

### Task 10: Move `vault` and `onboard-project`; install docs

**Files:**
- Move: `.claude/skills/vault/` → `integrations/claude-code/clepsydra/skills/vault/`; `.claude/skills/onboard-project/` → `…/skills/onboard-project/` (`git mv`)
- Modify: both SKILL.md files
- Create: `ui/src/docs/content/claude-code.mdx` (+ register it wherever the other docs pages are listed; find with `grep -rn "mcp.mdx\|'mcp'" ui/src/docs`)

**Content requirements:**
- `vault`: the tool table gains the seven new tools; the Setup section says "install the clepsydra plugin" instead of `.mcp.json`; tool names refer to `vault_*` only (no server prefix).
- `onboard-project`: drop writing `.mcp.json` and the long CLAUDE.md section; add: set hub frontmatter `integration_branch` (ask the user; default the repo's integration branch from its CLAUDE.md) and `triage_index` (optional); write this two-line CLAUDE.md pointer:
  `## Project management: clepsydra vault` / `Project state lives in the clepsydra vault (project \`<slug>\`, hub [[<Hub Title>]]); the clepsydra plugin supplies the tools and skills.`
- `claude-code.mdx`: install (`/plugin marketplace add <path to clepsydra repo>`, `/plugin install clepsydra@clepsydra`), what the plugin adds (commands, status, merge behaviour, hub fields), the allowlist block (exact JSON from Task 13).

- [ ] **Step 1:** Move and edit. **Step 2:** `claude plugin validate integrations/claude-code/clepsydra` → PASS; `grep -rn "mcp.json" integrations/claude-code/clepsydra/skills` → only the "no longer needed" note. `(cd ui && bun run typecheck && bun run lint)` → PASS.
- [ ] **Step 3:** Commit `feat(plugin): ship vault and onboard-project skills; add install docs`.

### Task 11: `decide` and `triage` skills

**Files:**
- Create: `integrations/claude-code/clepsydra/skills/decide/SKILL.md`, `…/skills/triage/SKILL.md`

**Content requirements:**
- `decide` (trigger: "/decide", "record a decision", "log this decision"): resolve the project (repo → slug, as the mod does: `projectMap`, else a board project named like the repo) → hub via `vault_search "kind:project project:<slug>"`; append to `## Decisions` with `vault_append_page` (`heading: "Decisions"`; if that heading is missing, append `## Decisions` + the entry at the end). Entry: `- <YYYY-MM-DD> — <decision>. Why: <reason>. (<[[TSK-…]] or commit sha>)`. One entry per call; never rewrite earlier entries.
- `triage` (trigger: "/triage", "triage <page|journal range>"): inputs `<source page>` or `<YYYY-MM-DD..YYYY-MM-DD>` journal range; index page = hub `triage_index` (stop and ask if unset). Encode the convention exactly: one TSK per source item via `vault_task_create` (`ai-generated` tag, project, `link` = source page; for a journal source link the index page, never the journal); group only items that share one delivery surface; P1s + quick wins → `TRIAGE` (a handful), the rest `INTAKE`; insert `## Triage — <YYYY-MM-DD>` above the previous `## Triage — …` section of the index; mirror each item into the index's Bugfixes / Improvements / Features list as `— [[Title]] (TSK-…)`; never write to the human journal; report a table of created codes.

- [ ] **Step 1:** Write both. **Step 2:** validate → PASS. **Step 3:** Commit `feat(plugin): add decide and triage skills`.

### Task 12: `research-to-vault` skill

**Files:**
- Create: `integrations/claude-code/clepsydra/skills/research-to-vault/SKILL.md` (the name avoids the user's existing global `research` skill)

**Content requirements:** explicit trigger only ("research X into the vault", "archive these sources"). For each primary source: DOI/ISBN → `vault_import_work`; other URLs → `vault_archive_url`; keep the returned page titles. Then one NOTE via `vault_create_page` (`ai-generated`, real project, hub wikilink) whose claims cite the archived pages by `[[Title]]`; search first and extend an existing note on the topic. On `archiving is disabled`, cite plain URLs and say so.

- [ ] **Step 1:** Write. **Step 2:** validate → PASS. **Step 3:** Commit `feat(plugin): add research-to-vault skill`.

**Phase 1–3 gate before merge:** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test`, `(cd ui && bun run typecheck && bun run lint && bun run test)`, `just plugin-test`. Then `--no-ff` merge to `develop`; remove the worktree.

## Phase 4 — Rollout (lead session, after merge; touches files outside this repo)

### Task 13: Install, allowlist, hub fields

- [ ] **Step 1:** Remove the `clepsydra` entry from this repo's `.mcp.json` (keep other servers; delete the file if it becomes empty). Commit on develop: `chore: rely on the clepsydra plugin for MCP`.
- [ ] **Step 2:** Ask the user to run `/plugin marketplace add /Users/kit/Source/_p.pkm/clepsydra` and `/plugin install clepsydra@clepsydra` (interactive), then restart the session.
- [ ] **Step 3:** Add to `~/.claude/settings.json` `permissions.allow` (merge, don't overwrite), each prefixed `mcp__plugin_clepsydra_clepsydra__`: `vault_search, vault_get_page, vault_list_pages, vault_tree, vault_links, vault_tags, vault_board, vault_bases, vault_base_query, vault_agenda, vault_feed_entries, vault_task_create, vault_task_update, vault_ai_journal_capture, vault_append_page, vault_edit_page, vault_import_work, vault_archive_url`. Use the `update-config` skill.
- [ ] **Step 4:** Set hub frontmatter: clepsydra `integration_branch = "develop"`, `triage_index = "[[Clepsydra: Stray Thoughts]]"`; xxii and falls `integration_branch` = the branch named in each repo's CLAUDE.md git section (confirm with the user if absent). Use whichever MCP/API path sets frontmatter extras (`vault_update_page` if it accepts properties; else `PATCH` page properties).

### Task 14: Other repos and smoke

- [ ] **Step 1:** In `~/Source/_p.aleph/xxii` and `~/Source/_p.falls/falls`: replace the "Project management: clepsydra vault" section with the Task 10 two-line pointer; remove the `clepsydra` `.mcp.json` entry. Leave uncommitted; show the diff.
- [ ] **Step 2:** Manual smoke in a fresh session in this repo: `/board` pane opens; `/task start <code>` → `FIELD`; status shows `TSK-… · vault ✓`; hub section present (ask Claude what the Status section says); merge check without touching develop: a throwaway git repo in the scratchpad with `develop` + `feature/<code>-smoke` branches, plugin `projectMap` mapping its basename to `clepsydra`, and a throwaway smoke Task (`ai-generated`, archived afterwards) → a Claude-run `git merge --no-ff` there moves it to `REVIEW` and adds the Delivery line; `/decide` writes one dated bullet; stop `clep serve` → `vault ✗` and one notice.
- [ ] **Step 3:** After a passing smoke, delete the dev-mod copy `~/.claude/dev-mods/070a0211-5b56-4319-8407-99f14f655225/clepsydra/` (confirm with the user first). Update the vault note and memory `project_claude_code_mods.md`.
