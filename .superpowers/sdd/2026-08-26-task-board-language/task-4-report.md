# Task 4 Report: Cycle Lifecycle Language

## Status

Complete.

## Red evidence

Command:

`bun run test src/components/tasking/__tests__/cycleModals.test.tsx`

Result after updating tests first: 68 tests ran; 16 failed and 52 passed. Ten failures were the expected missing lifecycle copy and pending-action states for creation, activation, and closure. Six integration waits still expected the pre-cutover `TASKING BOARD` heading from the shared Task Board language changes. The existing POST/PATCH wire-contract tests passed, including `ACTIVE`, `CLOSED`, `BACKLOG`, target cycle codes, and omitted `carry_to` for keep-in-cycle.

## Green evidence

Command:

`bun run test src/components/tasking/__tests__/cycleModals.test.tsx`

Result: 1 test file passed; 68 tests passed. Vitest emitted only the existing Vite native-config compatibility warning.

Patch hygiene:

`git diff --check`

Result: passed with no output.

## Files

- `ui/src/components/tasking/NewCycleModal.tsx`
- `ui/src/components/tasking/OpenCycleModal.tsx`
- `ui/src/components/tasking/SealCycleModal.tsx`
- `ui/src/components/tasking/__tests__/cycleModals.test.tsx`
- `.superpowers/sdd/2026-08-26-task-board-language/task-4-report.md`

## Decisions

- Used distinct visible and accessible actions: `Create cycle`, `Start cycle`, and `Close cycle`.
- Added exact pending copy: `Creating…`, `Starting…`, and `Closing…`.
- Added accessible names to creation fields while retaining the existing form structure and test IDs.
- Kept internal modal kinds, component names, mutation fields, state IDs, carry sentinels, date calculations, and success behavior unchanged.
- Kept `PLANNED`, `ACTIVE`, `CLOSED`, `BACKLOG`, cycle codes, and omitted `carry_to` as wire values while presenting title-case human labels.
- Changed the creation sub-header to `SET UP A CADENCE WINDOW` so creation no longer reads as activation.
- Updated this focused test file's integration wait from the superseded `TASKING BOARD` heading to the shared `Task Board` heading supplied by Tasks 1–3.

## Self-review

- Exact brief copy is asserted for modal titles, field labels, goal placeholder, actions, progress states, activation target state, closure metrics, incomplete-task movement choices, clean close, and the closed destination.
- Accessible dialog, field, group, and button names are covered where the copy is interactive or labels a control.
- Existing wire assertions remain intact and green. No mutation body, endpoint, state ID, carry sentinel, date calculation, or atomic close behavior changed.
- Changes are limited to the four assigned UI/test files and this report.
- Formatter, lint, typecheck, full suite, and project-wide validation were intentionally not run, per the task constraints.

## Commit

`feat(tasking): clarify cycle lifecycle language` (this task commit)
