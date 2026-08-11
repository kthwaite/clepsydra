# Tasking Board QoL Pass Design

**Date:** 2026-08-11
**Status:** Approved design, pending written-spec review

## Context

The TASKING board (shipped 2026-06-11 from `docs/superpowers/plans/2026-06-10-tasking-board.md`) works, but a full audit of `ui/src/components/tasking/`, `ui/src/api/board.ts`, and `src/api/board/` surfaced seven outright bugs, a set of workflow gaps that make routine task management heavier than it should be, and systematic hardcoding that drifts from house conventions. The most severe finding: TIMELINE mode has never rendered correctly — it uses `tl-*` CSS classes that exist only in the design prototype (`docs/pkm-redesign/project/styles-board.css`), which is never imported.

This pass fixes the bugs, adds the four highest-value workflow upgrades (inline status/priority editing, board search/filter, quick-add, keyboard shortcuts), restores TIMELINE properly with real `start` dates, closes the two cheap items from `docs/superpowers/plans/followup-tasking-a11y.md`, and consolidates duplicated vocabulary/constants. Backend changes are limited to small DTO additions and constant consolidation — no new endpoints, no schema migrations.

## Goals

- Every board mutation failure is visible to the user; the board reflects external edits without a manual refresh.
- Status and priority are editable from any card or row in any mode without opening the edit panel.
- Tasks can be found by text and filtered by priority/hold across all modes.
- A task can be created from a column or the backlog by typing a title and pressing Enter.
- TIMELINE renders as designed, positioned by a real, user-editable `start` date.
- The board is operable by keyboard: shortcuts for the common actions, activatable cards, a contained edit panel.
- One source of truth for column labels, priority colors, health colors, debounce timing, and backend field defaults.

## Non-goals (explicitly deferred)

- Persisted manual ordering / same-column drag ranking (needs a rank field and reorder endpoint).
- Bulk/batch task patch; `GET /board` query filters or pagination.
- Cycle rename/recode (filename-derived identity; would orphan task references).
- Keyboard drag-and-drop (a11y followup item 2 stays in the backlog).
- Destroy undo (needs trash/restore backend); the two-step arm remains.
- Checklist write-through from the panel (plan decision 7 stands: the markdown body is the source of truth).
- Operation create/edit UI; WIP limit config plumbing; transactional carryover.

## Delivery structure

### Slice A: Bug fixes

1. **Board staleness.** `useVaultEvents` adds `queryKeys.board.all` to the `index_changed` invalidation set, so Folio/MCP/external edits refresh the board.
2. **Firefox drag.** `TaskCard` `onDragStart` calls `e.dataTransfer.setData("text/plain", task.id)` (and sets `effectAllowed`); HTML5 drag then initiates in Firefox.
3. **Silent failures.** All board mutations surface errors via the house `sonner` toaster: `usePatchTask` onError (after rollback), `useCreateTask`, `useDeleteTask`, `useCreateCycle`, `usePatchCycle`. Messages name the action, not the HTTP detail.
4. **Health fallback.** One `healthColor(health)` helper in `board-constants`; unknown values render `--ink-mute` everywhere (header currently defaults to green, rail to grey).
5. **DUE validation.** DUE inputs in `NewTaskModal` and `TaskEditPanel` become `type="date"`, matching the cycle modals' START/END fields.
6. **Hold placeholder.** The hold toggle writes `"BLOCKED"` and focuses the reason input with its text selected; the shouty `"BLOCKED — STATE REASON"` placeholder never persists unnoticed.
7. **Error state.** The board-level error screen gains a RETRY button (calls `refetch`).

**Acceptance criteria**

- Editing a task page outside the board updates the board within one SSE cycle (integration-tested at the hook level with a mocked event).
- A patch that fails rolls back *and* raises a toast; create/delete/cycle failures raise toasts without closing state loss.
- Unknown health renders identically in BoardHeader and ScopeRail.
- An invalid due date cannot be committed from either form.

### Slice B: Filing guards

1. Operations without a `project:` slug are excluded from the OPERATION dropdowns in `NewTaskModal` and `TaskEditPanel` (assigning writes the op code into `project:` frontmatter, which `filterTasks` treats as UNFILED — a silent misfile).
2. `ScopeRail` badge counts use the same predicate as `filterTasks`, so a rail badge always equals the count the click reveals. The rail's modal-preset logic stops passing an op code as a project (`ScopeRail.tsx:135` branch).
3. CLOSED cycles are excluded from cycle dropdowns, except when the task's current cycle is closed (shown, marked, still selectable away from).

**Acceptance criteria**

- No dropdown offers a slug-less op; rail badge and filtered view agree for every row, including UNFILED.
- A task not already in a closed cycle cannot be moved into one from the UI.

### Slice C: TIMELINE restyle + `start` plumbing

1. Port the prototype's `tl-*` styles into `TimelineView` as Tailwind utilities on Vessel tokens (same treatment KanbanView/BacklogView received). No CSS file import; no visual dependence on `docs/`.
2. Backend: `CreateTaskRequest` gains optional `start`; `PatchTaskRequest` gains tri-state `start` (absent = keep, null = clear, string = set), symmetric with `due`. Regenerate `ui/src/api/schema.d.ts`.
3. UI: START `type="date"` field in `NewTaskModal` (alongside DUE) and `TaskEditPanel`; `applyTaskPatch` handles the new tri-state field.
4. `timeline-math` positions bars from real `start`, keeping the `due − 2d` synthetic fallback for tasks without one; the ±2-day window pad and fallback length become named constants.

**Acceptance criteria**

- Timeline bars are absolutely positioned on a working track in the built app (assert on computed layout, not just inline styles).
- `start` round-trips through create and patch (backend integration test), and clearing it reverts a task's bar to the fallback.

### Slice D: Inline status/priority editing

The priority chip and status pip on cards and rows become click targets opening a small popover (RAC `Popover` + `Dialog`) hosting the existing `DispositionRow` / `PriorityRow`. One `InlineEditPopover` component reused by `TaskCard`, `BacklogView` rows, and `CycleView` rows (TimelineView bars keep click-to-open-panel). Selection patches immediately (existing optimistic path) and closes the popover. Card click-to-open-panel still works; the chips stop propagation.

**Acceptance criteria**

- Status and priority are changeable from CARD, BACKLOG, and CYCLE modes without the edit panel, by mouse and keyboard.
- Popover chips are buttons (focusable, Enter/Space), and opening one does not open the edit panel.

### Slice E: Search/filter

A FILTER input in `BoardHeader` plus quick toggles for priority (P0–P3) and HOLD. Matching is case-insensitive substring across title, code, tags, and assignee. Filtering is client-side in `TaskingScreen`, composed before `filterTasks`, applied in all four modes. State is ephemeral (not persisted in the board store's `partialize`). `/` focuses the input; Escape clears and blurs it. A results line shows `N OF M` when a filter is active.

**Acceptance criteria**

- Typing narrows all four views live; toggles compose with text and with the op rail; clearing restores everything.
- Filter state does not survive a reload.

### Slice F: Quick-add

An inline "+ ADD" row at the bottom of each kanban column and the top of the backlog: type a title, Enter commits via the existing `useCreateTask` with the column's status (INTAKE for backlog) and active op preset; Esc cancels; blur with text keeps the row open. Empty titles do not commit (no more silent `"UNTITLED TASKING"` — the full modal also gains required-title validation). The full modal remains for detailed entry; its backdrop-click dismiss (`isDismissable`) is disabled once any field is dirty (Escape still works).

**Acceptance criteria**

- A task created by quick-add lands in the right column with the right op; Enter-with-empty-title is a no-op.
- A dirty NewTaskModal survives a backdrop click; a pristine one dismisses.

### Slice G: Keyboard shortcuts + a11y core

1. Registry entries (visible in ⌘/ help): `N` new task, `1`–`4` mode switch, `/` focus filter, `[` toggle rail — scoped to the tasking route.
2. The `useGlobalShortcuts` dispatcher gains two guards: bare-key shortcuts do not fire when the event target is editable, and no app shortcut fires while a `[role="dialog"]` is open.
3. `TaskCard` becomes keyboard-activatable: `role="button"`, `tabIndex={0}`, Enter/Space opens the edit panel; the dossier `<span>` becomes a real button.
4. `TaskEditPanel` contains focus: RAC `FocusScope contain` (or `inert` on the sibling board body); Tab cycles within the panel; the a11y followup doc is updated to mark items 1 and 3 done.

**Acceptance criteria**

- All four shortcuts work and appear in the help modal; typing in any board input or modal triggers none of them (and no global ⌘ shortcut fires inside an open dialog).
- A keyboard-only user can open a card, edit it, and return, without focus escaping the panel.

### Slice H: Hardcoding consolidation + polish

Frontend:
- One priority color map in `board-constants` (replaces copies in `TaskCard`, `TaskEditPanel`, `fields`, `BacklogView`, `PriChip`).
- Column labels come from `BoardResponse.columns` everywhere; `COL_LABEL` is deleted and a label lookup is threaded to the views that need it.
- `DEBOUNCE_MS` named once in `TaskEditPanel`; modal widths and the ESC-chip markup consolidated into `BoardModalFrame` variants.
- `BoardHeader`/`ScopeRail` font sizes move from `text-[9px]`-style literals to `--fs-*` tokens so `data-density` applies; stale `var(--pad, 12px)` / `var(--row-h, 32px)` fallbacks corrected to token values.
- The two inert `eslint-disable` comments become `biome-ignore`; the one button missing `type="button"` gets it.
- Polish: BacklogView empty state; `title` tooltips on truncated titles/op names; tags render "+N" past three; stale "Tasks 9-12" scaffolding comment removed.

Backend (constant consolidation only, no behavior change):
- `"INTAKE"` / `"P2"` defaults declared once (`board::defaults`) and referenced by the write path, both read paths, and `task_history`.
- Task/cycle paths built via `Kind::canonical_folder()` instead of interpolated literals; kind discriminators in SQL use `Kind::as_str()`.

**Acceptance criteria**

- `rg` finds exactly one declaration of the priority color map, the column label source, and each backend default.
- Density presets visibly change header/rail typography; backend test suite is behavior-identical (green, no snapshot changes).

## Error handling

All new mutation paths reuse the existing optimistic-rollback + toast pattern from Slice A. Quick-add and popover patches show pending state via the mutation's `isPending` on their local control only — no global spinners.

## Testing

- RTL tests per slice for every new interaction (popover editing, quick-add commit/cancel, filter composition, shortcut dispatch guards, focus containment), following the existing `__tests__/` patterns (jsdom `isContentEditable` shim where needed).
- Unit tests for the filter predicate and quick-add preset logic as pure functions.
- Backend: integration tests for `start` create/patch round-trip and tri-state clear in `tests/api_board_test.rs`.
- Verification gates: `cargo test` + `cargo clippy`, `bun run typecheck` + `lint` + `test`, plus `bun run openapi` regeneration after the DTO change.
