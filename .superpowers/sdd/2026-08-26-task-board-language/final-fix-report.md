# Final fix report

## Scope

This final fix wave addresses all findings in `final-review-findings.md`.
It changes Task Board presentation code, Task Board tests, and the Task Board guide only.
No backend, route, API schema, store identifier, payload field, sentinel, or persisted state value changed.

## Red evidence

Tests were changed before production code.

Command:

```text
cd ui
bun run test src/components/tasking/__tests__/board-constants.test.tsx src/components/tasking/__tests__/CycleView.test.tsx src/components/tasking/__tests__/ScopeRail.test.tsx src/components/tasking/__tests__/TimelineView.test.tsx src/components/tasking/__tests__/cycleModals.test.tsx src/components/tasking/__tests__/NewTaskModal.test.tsx src/components/tasking/__tests__/TaskEditPanel.test.tsx src/components/tasking/__tests__/TaskingScreen.test.tsx src/components/tasking/__tests__/telemetry.test.tsx
```

Result: expected failure. All 9 selected files failed, with 27 failing tests. The failures showed the intended presentation gaps:

- priority radios still exposed `P0` instead of `P0 Critical`;
- priority and status filter options still exposed raw IDs;
- Cycle selectors still exposed `ACTIVE`, `PLANNED`, and `CLOSED`;
- Cycle lifecycle entry points still rendered `OPEN CYCLE`, `SEAL CYCLE`, and `CYCLE SEALED`;
- the Backlog description and rail still rendered retired register/`unscheduled` copy;
- the Timeline footer still rendered `UNSCHEDULED`;
- the New Cycle Status hint and Start Cycle consequence still rendered `cadence`;
- the shared Cycle state mapping did not exist.

A focused follow-up red run added the undated Cycle-window contract:

```text
bun run test src/components/tasking/__tests__/board-constants.test.tsx
```

Result: expected failure, 3 of 6 tests failed. `fmtCycleWindow(null, null)` returned `UNSCHEDULED` instead of `No dates`, priority radios lacked approved labels, and `cycleStateLabel` did not exist.

The first complete Task Board run then exposed two additional stale checked-in assertions that expected `+ ADD` while the rendered approved placeholder was `+ New task`. Those assertions were migrated without changing the Quick Add interaction tests.

## Implementation decisions

### Shared presentation vocabulary

- Added one `CYCLE_STATE_LABEL` mapping in `board-constants.tsx`:
  - `PLANNED` → `Planned`
  - `ACTIVE` → `Active`
  - `CLOSED` → `Closed`
  - `BACKLOG` → `Backlog`
- Added `cycleStateLabel`, which falls back to the raw state ID for unknown values.
- Reused that mapping in Cycle view state presentation and both Task Cycle selectors.
- Reused existing `PRI_LABEL` and `COL_LABEL` mappings for form radios and filter options.
- Changed the undated Cycle-window presentation to `No dates`. The Backlog pseudo-Cycle uses the more specific `No Cycle` label.

### Cycle and Backlog copy

- Backlog pseudo-Cycle description: `Tasks not assigned to a Cycle.`
- Backlog rail secondary text: `Tasks without a Cycle`.
- Planned Cycle entry point: `Start cycle`.
- Active Cycle entry point: `Close cycle`.
- Closed badge: `Cycle closed`.
- Decorative lifecycle glyphs are `aria-hidden`, so accessible names are exactly `Start cycle` and `Close cycle`.
- New Cycle Status hint: `lifecycle`.
- Start Cycle consequence: `sets active Cycle to {code}`.
- Timeline count: `without due date`; footer detail remains `No due date · in Backlog or Inbox`.

### Documentation

The carryover choice now says `Keep in this cycle`, matching the UI. The technical explanation remains unchanged: omitting `carry_to` leaves Tasks in that Cycle.

## Files changed

Production:

- `ui/src/components/tasking/board-constants.tsx`
- `ui/src/components/tasking/fields.tsx`
- `ui/src/components/tasking/TaskingScreen.tsx`
- `ui/src/components/tasking/CycleView.tsx`
- `ui/src/components/tasking/ScopeRail.tsx`
- `ui/src/components/tasking/TimelineView.tsx`
- `ui/src/components/tasking/NewCycleModal.tsx`
- `ui/src/components/tasking/OpenCycleModal.tsx`
- `ui/src/components/tasking/NewTaskModal.tsx`
- `ui/src/components/tasking/TaskEditPanel.tsx`

Tests:

- `ui/src/components/tasking/__tests__/board-constants.test.tsx`
- `ui/src/components/tasking/__tests__/CycleView.test.tsx`
- `ui/src/components/tasking/__tests__/ScopeRail.test.tsx`
- `ui/src/components/tasking/__tests__/TimelineView.test.tsx`
- `ui/src/components/tasking/__tests__/cycleModals.test.tsx`
- `ui/src/components/tasking/__tests__/NewTaskModal.test.tsx`
- `ui/src/components/tasking/__tests__/TaskEditPanel.test.tsx`
- `ui/src/components/tasking/__tests__/TaskingScreen.test.tsx`
- `ui/src/components/tasking/__tests__/telemetry.test.tsx`
- `ui/src/components/tasking/__tests__/BacklogView.test.tsx`
- `ui/src/components/tasking/__tests__/KanbanView.test.tsx`

Guide:

- `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`

## Payload and interaction checks

Tests demonstrate that display labels do not change wire or store contracts:

- Clicking `In Progress` still emits status `FIELD`.
- Clicking `Review` still PATCHes status `REVIEW`.
- Clicking `P0 Critical` still emits/PATCHes priority `P0`.
- Selecting Cycle option `C-02 (Planned)` still PATCHes cycle `C-02`.
- The full New Task flow selects neutral labels but still POSTs `status: "FIELD"`, `priority: "P1"`, and `cycle: "C-01"`.
- Backlog selection still PATCHes `cycle: null`.
- `Start cycle` still opens the internal `{ kind: "open", cycleId }` entry point and PATCHes `state: "ACTIVE"`.
- `Close cycle` still opens the internal `{ kind: "seal", cycleId }` entry point and PATCHes `state: "CLOSED"`.
- Close carry choices still send `carry_to: "BACKLOG"`, send the raw target Cycle code, or omit `carry_to` for `Keep in this cycle`.

## Green evidence

Task Board suite:

```text
bun run test src/components/tasking
```

Result: 19 test files passed; 519 tests passed.

Task Board guide route test:

```text
bun run test -- src/routes/__tests__/-docs.test.ts
```

Result: 1 test file passed; 28 tests passed. The test emitted the existing jsdom `Window.scrollTo()` not-implemented notices and still exited successfully.

Patch whitespace check:

```text
git diff --check
```

Result: clean.

## Retired vocabulary audit

A case-insensitive audit covered Task Board production JSX and the Task Board guide for the named retired phrases. Remaining matches are limited to internal identifiers, wire values, test negative checks, and comments, which the controller explicitly excluded. No named retired phrase remains in rendered production copy in the addressed surfaces.

## Self-review

- All four findings are addressed.
- One shared Cycle state mapping is used; no duplicate display map was introduced.
- Priority, status, and Cycle option values remain raw IDs.
- Cycle modal kinds, Cycle state IDs, Backlog/null sentinels, API fields, route names, test IDs, and mutation behavior remain unchanged.
- Interaction assertions were preserved or strengthened. No interaction was replaced by a constants-only assertion.
- No backend or unrelated product surface changed.
- No formatter, lint, full UI suite, Rust suite, or project-wide validation was run.

## Commit

This report is included in the single final fix-wave commit with subject:

```text
fix(tasking): finish language cutover
```

## Verification fix

Main-agent verification found that `KanbanView.tsx` still imported `pad2`
after the approved copy removed its final use. The unused import was removed
without changing Kanban behavior.

Verification:

```text
bun run typecheck
```

Result: passed (`tsc --noEmit --project tsconfig.app.json`).

```text
bun run test src/components/tasking/__tests__/KanbanView.test.tsx
```

Result: 1 test file passed; 53 tests passed. The run emitted only the existing
Vite native-config warning.

The verification fix is committed separately as:

```text
fix(tasking): remove stale Kanban import
```

## Semantic carry-group verification fix

Focused lint found that the carry-choice wrapper used `role=\"group\"` on a
`div`. It now uses a semantic `fieldset` with the same `aria-label`, classes,
test ID, buttons, and accessible group name.

Verification:

```text
bunx biome lint src/components/tasking/SealCycleModal.tsx
```

Result: passed; 1 file checked with no diagnostics and no fixes applied.

```text
bun run test src/components/tasking/__tests__/cycleModals.test.tsx
```

Result: 1 test file passed; 70 tests passed. The run emitted only the existing
Vite native-config warning.

```text
bun run typecheck
```

Result: passed (`tsc --noEmit --project tsconfig.app.json`).

The semantic fix is committed separately as:

```text
fix(tasking): use semantic carry group
```
