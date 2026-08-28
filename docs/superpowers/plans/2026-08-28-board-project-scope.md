# Task Board project scope — plan (2026-08-28)

Branch `fix/board-project-scope` off `develop` (worktree `.worktrees/board-project-scope`).

## Bug

`/tasking` Scope rail shows `0 projects`, `All projects 107`, `No project 107`; no per-project rows, so tasks cannot be scoped by project. Live `/api/vault/board` returns `operations: []` while every task carries `project: "xxii" | "clepsydra"`.

## Root cause

1. `src/api/board/read.rs` lists a PROJECT page as an operation only when its frontmatter has `board: true` (opt-in from the June board design; pinned by `tests/api_board_test.rs::project_without_board_flag_excluded`). Nothing user-facing documents the flag; the onboarding recipe (`.claude/skills/onboard-project`) creates PROJECT pages without it; there is no `clepsydra` PROJECT page at all.
2. The UI derives project rows only from `operations`. `filterTasks` / `hasUnfiledTasks` / `TimelineView` treat any task whose slug has no operation as "No project". `TaskEditPanel` / `NewTaskModal` only offer operations as assignable projects.

## Decisions

- **Server: `board:` becomes opt-out.** A PROJECT page is an operation unless `board: false`. Absent key → listed. `board: true` still works.
- **UI: project scopes = operations ∪ task project slugs.** New `ui/src/components/tasking/board-projects.ts`:

  ```ts
  export interface ProjectScope {
    key: string;            // opFilter value: slug, or op.code for a slug-less op
    slug: string | null;    // null only for a slug-less op
    code: string;           // op.code, or slug.toUpperCase() when synthesized
    name: string;           // op.name, or "" when synthesized
    health: string | null;  // op.health, or null when synthesized
    op: BoardOperation | null; // null when synthesized from task slugs
  }
  export function deriveProjectScopes(operations: BoardOperation[], tasks: BoardTask[]): ProjectScope[];
  export function scopeLabel(scope: ProjectScope): string; // "CODE — name" or "CODE"
  ```

  One scope per operation (key = `opKey(op)`), plus one synthesized scope per distinct `task.project` not already a key. Sorted by `code` (byte order, matching the server's sort).
- **"No project" (UNFILED) = `!task.project` only.** `filterTasks(tasks, opFilter)` and `hasUnfiledTasks(tasks)` drop the `operations` parameter.
- **Consumers take `projects: ProjectScope[]` instead of `operations`:** `ScopeRail`, `BoardHeader` (count), `TimelineView` (grouping), `TaskEditPanel`, `NewTaskModal`. `BoardHeader.activeOp` (health/lead/dossier strip) stays and is `activeScope.op`.
- `TaskingScreen`: `projects = deriveProjectScopes(data.operations, data.tasks)`; the stale-`opFilter` self-heal checks `projects` keys; `activeScope = projects.find(p => p.key === opFilter)`; `telemetryProject` / Kanban & Cycle `activeProject` = `activeScope.slug`; `filterFields.project` options = scope slugs.
- Synthesized rows render a neutral bordered square (same as the "All projects" row) instead of a `HealthDot`; timeline group headers use `HealthDot health={scope.health ?? "NONE"}`.
- Timeline groups only scopes with a slug (`t.project === scope.slug`). Side effect: fixes the residual "null-project tasks render twice" (a slug-less op matched `null === null`).
- No DTO/OpenAPI change → no `schema.d.ts` regen.
- Docs: one sentence in `ui/src/docs/content/tasks-agenda-journals-and-board.mdx` (Scope rail paragraph): every PROJECT page appears; `board: false` hides one; slugs without a page still get a row.

## Tasks

### T1 — server opt-out gate (Rust + docs)

Files: `src/api/board/read.rs`, `tests/api_board_test.rs`, `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`.

1. RED: in `tests/api_board_test.rs` replace `project_without_board_flag_excluded` with two tests:
   - `project_with_board_false_excluded` — `projects/hidden.md` (`board: false`) → `operations` empty.
   - `project_without_board_key_included` — `projects/no-board.md` (no key, `project: no-board`) → exactly one operation with `code == "NO-BOARD"`, `project == "no-board"`, `health == "GREEN"`.
   Run `cargo test --test api_board_test` → the second fails.
2. GREEN: in `read.rs` skip only when `meta.get("board") == Some(&Value::Bool(false))`; rewrite the comment (opt-out, not opt-in).
3. Docs sentence. Run `cargo test --test api_board_test --test api_tasks_test`, `cargo clippy --all-targets -- -D warnings` (scoped: only new warnings matter — develop is not clippy-clean), `cargo fmt -- --check src/api/board/read.rs tests/api_board_test.rs`.

### T2 — UI project scopes

Files: `ui/src/components/tasking/{board-projects.ts,ScopeRail.tsx,TaskingScreen.tsx,BoardHeader.tsx,TimelineView.tsx,TaskEditPanel.tsx,NewTaskModal.tsx}` and their `__tests__` (+ `__tests__/fixtures.ts`, new `__tests__/board-projects.test.ts`).

1. RED: `board-projects.test.ts` — operations map to scopes; orphan task slug synthesizes `{key: "ghost", slug: "ghost", code: "GHOST", name: "", health: null, op: null}`; sorted by code; slug-less op keeps `key = code`; `scopeLabel`.
2. GREEN: implement `board-projects.ts`.
3. RED→GREEN `filterTasks(tasks, opFilter)` + `hasUnfiledTasks(tasks)`: UNFILED = null/empty project only; a task with an unknown slug is NOT unfiled. Update existing tests accordingly.
4. RED→GREEN `ScopeRail` with `projects` prop: header count = `projects.length`; a synthesized row (`GHOST`) renders with its task count and clicking sets `opFilter = "ghost"`; "No project" row only when a null-project task exists.
5. RED→GREEN `TaskingScreen`: with a board whose `operations: []` and tasks in `alpha`/`beta`, the rail shows `ALPHA`/`BETA` rows, `No project` counts only the null-project task, clicking `ALPHA` filters, and the self-heal effect does NOT reset `opFilter = "alpha"` (no operation backs it). `filterFields` project options derive from scopes.
6. RED→GREEN `TimelineView` (`projects` prop; group by slug; UNFILED = null only; synthesized group header shows `GHOST`), `BoardHeader` (`projects` count), `TaskEditPanel` + `NewTaskModal` (`projects`; a synthesized slug is assignable; option label via `scopeLabel`).
7. Gates from `ui/`: `bun run typecheck`, `bun run lint` (compare against develop — baseline is not clean; no new errors in touched files), `bun run test src/components/tasking`, then `bun run test`.

Do not run repo-wide formatters (`cargo fmt`, `biome check --write`) — scope to touched files.

### T3 — review, gates, merge

Review each task's diff, run full gates in the worktree, commit per task, merge `fix/board-project-scope` into `develop`, remove the worktree.
