# Board projects from PROJECT pages; Tasking list view fixes

Vault tasks: TSK-0113 (board counts 0 projects), TSK-0114 (list view chips over
header; completed hidden by default). Branch `fix/board-projects-list-view`
off `develop`.

## Decisions (2026-08-28, with Kit)

- A board **project** is a PROJECT page that declares a `project` slug. The
  legacy `board = true` flag still admits a PROJECT page (with or without a
  slug) but is no longer required. One operation per slug: prefer `board = true`,
  then the page whose canonical name equals the slug, then path order.
- Task `project` values exist only where a PROJECT page declares that slug.
  `POST /board/tasks` and `PATCH /board/tasks/{id}` reject an unknown slug with
  400, exactly like `ensure_cycle_exists`. Empty string on PATCH still clears.
- The Clepsydra NOTE is upgraded to a PROJECT page (`project = "clepsydra"`)
  through the vault (`vault_assign`), not by hand.
- List ("backlog") mode hides SEALED tasks by default. The toggle lives in
  `BoardHeader` next to the mode tabs (only in backlog mode), persisted in the
  board store as `showCompleted`. Kanban's Decision 8 (closed-cycle sealed
  filter) is untouched.
- Inline-edit chips (and the TaskCard link chip) stack at `z-[1]`: above the
  row's `z-0` open button, below the sticky rows (`z-[2]`–`z-[4]`).

## Task A — Rust: board projects and project validation

Files: `src/api/board/read.rs`, `src/api/board/mod.rs`, `src/api/board/tasks.rs`,
`tests/api_board_test.rs`, `src/mcp/server.rs` (tool description text only),
`ui/src/docs/content/tasks-agenda-journals-and-board.mdx`.

1. **Tests first** in `tests/api_board_test.rs`:
   - `project_page_with_slug_is_an_operation_without_board_flag`: PROJECT page
     `projects/atlas/atlas.md` with `project: atlas`, no `board` → one
     operation, `project == "atlas"`, `code == "ATLAS"`, `health == "GREEN"`.
   - Rewrite `project_without_board_flag_excluded` → PROJECT pages with neither
     slug nor `board: true` are excluded (keep both fixtures, rename to
     `project_page_without_slug_or_board_flag_excluded`).
   - `one_operation_per_project_slug_prefers_board_flag`: two PROJECT pages
     declaring `project: atlas`, one with `board: true` → exactly one operation
     and it is the flagged page (`path` asserted).
   - `create_task_rejects_unknown_project`: POST with `"project": "ghost"` and
     no PROJECT page → 400.
   - `patch_task_rejects_unknown_project`: PATCH `{ "project": "ghost" }` → 400;
     PATCH `{ "project": "" }` still clears (existing test covers).
   - Fix fixtures that now need a PROJECT page for their target slug:
     `project_assignment_patch_task_moves_to_set_project`,
     `project_assignment_patch_task_destination_collision_returns_409`
     (add `projects/op-b/op-b.md` with `project: op-b`).
2. **read.rs**: select `id, path, title, canonical_name, meta_json, project`
   for kind PROJECT ordered by path; admit when `project.is_some()` or
   `board == true`; group by slug key (`project` slug, else page code) with the
   preference order above; keep field derivation as is.
3. **mod.rs**: `ensure_project_exists(state, slug) -> Result<(), ApiError>`
   beside `ensure_cycle_exists`, querying `pages WHERE kind = 'PROJECT' AND
   project = ?1 LIMIT 1`; 400 message `unknown project: {slug}`.
4. **tasks.rs**: call it in `create_task` when `body.project` is `Some(non-empty)`
   and in `patch_task` when `body.project` is `Some(non-empty)`.
5. **Docs**: one paragraph in the board docs page (Projects on the board come
   from PROJECT pages declaring `project`; `board = true` is optional; task
   project must name one). MCP `vault_task_create`/`vault_task_update`
   descriptions: "project must name an existing Project (a PROJECT page)".
6. Gates: `cargo test --test api_board_test`, `cargo test --test api_tasks_test`,
   `cargo test mcp`, `cargo clippy --all-targets`, `cargo fmt -- --check` on the
   touched files only (develop is not repo-wide fmt clean).

## Task B — UI: list view stacking and completed toggle

Files: `ui/src/components/tasking/InlineEditPopover.tsx`, `TaskCard.tsx`,
`BoardHeader.tsx`, `TaskingScreen.tsx`, `ui/src/store/board.ts`, tests under
`ui/src/components/tasking/__tests__/`.

1. **Tests first**:
   - `InlineEditPopover.test.tsx`: the trigger does not use a Tailwind z-index
     of 10 or more (sticky list rows are `z-[3]`/`z-[4]`); it does carry `z-[1]`.
   - `TaskingScreen.test.tsx`: in backlog mode a SEALED fixture task is absent
     by default; pressing the "completed" toggle shows it; the FilterBar count
     strip excludes hidden completed tasks; kanban mode is unaffected.
   - `BoardHeader.test.tsx`: toggle renders only when `mode === "backlog"`,
     has `aria-pressed`, and labels the hidden count ("Show 3 completed").
   - Store: `showCompleted` defaults to false and is persisted.
2. `InlineEditPopover.tsx` and `TaskCard.tsx`: `z-10` → `z-[1]`.
3. `store/board.ts`: `showCompleted: boolean` (persisted) + `setShowCompleted`.
4. `TaskingScreen.tsx`: after `filterTasks`, when `mode === "backlog" &&
   !showCompleted` drop `status === "SEALED"` before `applyClientFilter`, so
   `opFilteredCount` and `visibleTasks` both exclude them; compute
   `hiddenCompletedCount` and pass it to `BoardHeader`.
5. `BoardHeader.tsx`: toggle button after the mode tablist, backlog mode only,
   `aria-pressed={showCompleted}`, label `Show N completed` / `Hide completed`.
6. Gates: `cd ui && bun run typecheck`, `bunx biome check` on touched files,
   `bun run test src/components/tasking src/store`.

## Task C — Vault and close-out (main session)

1. `vault_assign` the Clepsydra note to kind PROJECT, project `clepsydra`;
   extend it with `## Status` / `## Threads` per the onboard-project hub shape.
2. Reinstall the binary (`cargo install --path .`) so the running server can be
   restarted onto the fix; report that a restart is required.
3. Seal TSK-0113 and TSK-0114; annotate Stray Thoughts.
