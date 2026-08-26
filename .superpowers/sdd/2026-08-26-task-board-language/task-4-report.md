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
- Reduced the creation sub-header to the formatted cycle window only, with no descriptive suffix.
- Updated this focused test file's integration wait from the superseded `TASKING BOARD` heading to the shared `Task Board` heading supplied by Tasks 1–3.

## Self-review

- Exact brief copy is asserted for modal titles, field labels, goal placeholder, actions, progress states, activation target state, closure metrics, incomplete-task movement choices, clean close, and the closed destination.
- Accessible dialog, field, group, and button names are covered where the copy is interactive or labels a control.
- Existing wire assertions remain intact and green. No mutation body, endpoint, state ID, carry sentinel, date calculation, or atomic close behavior changed.
- Changes are limited to the four assigned UI/test files and this report.
- Formatter, lint, typecheck, full suite, and project-wide validation were intentionally not run, per the task constraints.

## Commit

`feat(tasking): clarify cycle lifecycle language` (this task commit)

## Review Fix Round 1

### Red evidence

Command:

`bun run test src/components/tasking/__tests__/cycleModals.test.tsx`

Result after updating the review tests first: 68 tests ran; 6 failed and 62 passed. The six expected failures covered the creation sub-header, activation metrics, exact empty-cycle guidance, exact active-cycle clash guidance, and the accessible incomplete-task choice group.

### Green evidence

Command:

`bun run test src/components/tasking/__tests__/cycleModals.test.tsx`

Result: 1 test file passed; 68 tests passed.

### Decisions and self-review

- The creation sub-header now contains only the formatted date window. The test asserts the exact date text and rejects `cadence window`.
- Activation metrics now use `Tasks` and `Checklist items`.
- Empty-cycle and active-cycle clash guidance match the reviewed sentences exactly.
- Incomplete-task choices expose `role=\"group\"` with the accessible name `Incomplete tasks`; button labels and payload tests remain unchanged.
- A scoped audit of the three assigned modals found no remaining visible or accessible `tasking`, `committed`, `checks`, `open cycle`, `seal cycle`, or `cadence window` copy. Residual matches are internal variable names and stable test IDs only.
- Internal `open`/`seal` modal kinds, component names, test IDs, `ACTIVE`/`CLOSED` states, carry sentinels, and PATCH bodies remain unchanged.
- Follow-up commit: `fix(tasking): complete cycle lifecycle language`.
