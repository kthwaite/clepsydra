# Tasking backlog: Jira-style tables (TSK-loamy-cup)

Branch `feature/backlog-tables`. UI only.

## Scope (user rulings 2026-10-08)

- Jira-style layout, single column:
  1. **Active cycle** table: tasks whose `cycle` is the active cycle (`cycles.find(c => c.state === "ACTIVE")`, same rule as `BoardHeader`). Shown only if an active cycle exists. Heading names the cycle code/label and its dates.
  2. **Backlog** table: every other visible task.
- Each table has its own column header row.
- Each table caps at ~10 rows tall (≈ 10 × 40px body + header) and scrolls inside.
- SEALED tasks hidden by default. A "Show done" toggle in the view header reveals them; persisted per viewer in `useBoardStore` (zustand `persist`, key `clepsydra.board`).
- Built on the shared `ui/src/components/ui/data-table/DataTable.tsx` (TanStack Table v9). Add opt-in row virtualisation there with `@tanstack/react-virtual`; existing consumers (BaseTableView, Gazetteer) must stay unchanged when they don't opt in.
- Priority grouping goes away. Within each table sort: priority P0→P3, then status (COL_ORDER), then due asc (null last).

## TDD tasks

### Task 1 — DataTable virtualisation (shared)
- Add `@tanstack/react-virtual` (pin exact current version, `bun add`).
- New opt-in prop, e.g. `virtualize?: { rowHeight: number; maxHeight: number; overscan?: number }`. When set, the table renders in its own scroll container of `maxHeight`, header sticky inside it, and only the visible rows (+ overscan) render, with spacer rows keeping total height and correct `aria-rowcount`/`aria-rowindex`.
- Grid keyboard navigation (`grid-navigation.ts`) must still reach rows outside the rendered window (scroll the virtualiser to the target index before focusing). If that is disproportionate, document the limit and test what is supported.
- Tests in `data-table/__tests__/DataTable.test.tsx`: non-virtual path unchanged; virtual path renders a bounded subset under a mocked scroll element size (jsdom has no layout — mock `getBoundingClientRect`/`offsetHeight` or use the virtualiser's `initialRect`); aria row counts correct.

### Task 2 — pure split helper
- In `BacklogView.tsx` (or a sibling `backlog-tables.ts`), replace `groupBacklog` with `splitBacklog(tasks, activeCycle, { showDone }) → { cycle: BoardTask[] | null; backlog: BoardTask[] }` with the sort above.
- Unit tests first: active cycle split, no active cycle → `cycle: null`, SEALED filtering, sort order.

### Task 3 — BacklogView on DataTable
- Columns: Code, Task (PriChip in priority InlineEditPopover · TypeChip · Blocked pill · title), Project, Status (status InlineEditPopover), Assignee, Estimate, Due, Checklist dots. Keep the current responsive drop rule (below 1400px hide Assignee/Estimate; below 1280px hide Project/Checklist) via `columnVisibility` from a media-query hook.
- Row activation opens the task editor (`setEditTaskId`); selected row in accent tint. Inline popovers must keep working inside DataTable rows (they are controls, so they should not trigger row activation).
- Keep QuickAddRow at the top. Empty state per table.
- Add `showDone` + setter to `ui/src/store/board.ts` (persisted; add to `board.test.ts`).
- Thread the active cycle from `TaskingScreen` (it already has board data) into `BacklogView`.
- Rewrite `__tests__/BacklogView.test.tsx` for the new structure first, then implement. Preserve testids where they still make sense (`bk-row-*`, `bk-action-*` may change — update tests deliberately, not silently).
- Stone & Lamp: tokens only from `main.css`; check paper + dark modes and mobile widths.

### Task 4 — gates
`bun run typecheck`, `bun run lint`, `bun run test`; `bun run knip` for the removed `groupBacklog` export.
