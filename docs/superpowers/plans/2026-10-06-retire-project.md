# Retire Project (hide from Tasking board)

## Rulings (2026-10-06)

- Marker: reuse `board: false` on PROJECT pages. Its meaning widens: it now also hides the slug's Tasks.
- A slug is **retired** iff ≥1 PROJECT page declares that `project` slug AND every PROJECT page with that slug has `board: false`. A slug with no PROJECT page is never retired. Slug-less pages never retire anything.
- `GET /board` drops Tasks whose `project` is a retired slug. `GET /board?include_retired=true` returns all Tasks. The param affects `tasks` only; `operations` keep today's behaviour (`board: false` pages excluded either way).
- Filter after `load_tasks` computes blockers, so `blocked`/`blocks` stay correct for remaining Tasks.
- MCP: code resolution (`resolve_board_ref`) always passes `include_retired=true`. `vault_board` passes it only when the `project` param is set.
- No UI action. Frontmatter only. UI needs no logic change: `deriveProjectScopes` synthesizes rows from task slugs, and retired tasks no longer arrive.
- Out of scope: agenda, calendar todos, tasks endpoint outside `/board`.

## Tasks (TDD)

### T1 — server filter (`crates/clep-api`)
1. RED in `crates/clep-api/tests/api_board_test.rs`:
   - `retired_project_tasks_hidden`: PROJECT `projects/old.md` (`project: old`, `board: false`) + TASK with `project: old` + TASK with `project: live` → `GET /board` tasks contains only the `live` task.
   - `include_retired_returns_retired_tasks`: same fixture, `?include_retired=true` → both tasks.
   - `slug_with_listed_page_not_retired`: two PROJECT pages with slug `mix`, one `board: false`, one absent → `mix` task present.
   - `task_slug_without_project_page_not_retired`: TASK `project: orphan`, no PROJECT page → present.
2. GREEN in `crates/clep-api/src/api/board/read.rs`: add `Query<BoardQuery { include_retired: Option<bool> }>` (utoipa `IntoParams`), collect retired slugs during the operations loop (track per slug: any page / any listed page), then `tasks.retain(...)` unless included. Annotate the param in `#[utoipa::path]`.
3. Update the `board:` comment in read.rs to describe the widened meaning.

### T2 — MCP (`crates/clep-mcp`)
1. `resolve_board_ref`: `get_json(BOARD_URL, &[("include_retired", "true")])` (match `get_json`'s query arg type).
2. `vault_board`: pass the same query only when `params.project` is `Some`. Mention in the tool description that retired Projects' (`board: false`) Tasks are hidden unless `project` names them.
3. Test if the existing MCP test harness can assert the query (wiremock); otherwise unit-test a small helper `board_query(project: Option<&str>)`.

### T3 — contract + docs
1. Regenerate schema offline: `cargo run -q -p clep-api --example openapi > target/openapi.json && (cd ui && bun run openapi:file)`.
2. `ui/src/docs/content/tasks-agenda-journals-and-board.mdx` Scope rail paragraph: `board: false` retires a Project — hides its row and all its Tasks.

### Gates
`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p clep-api -p clep-mcp`; `cd ui && bun run typecheck && bun run lint && bun run test`.
