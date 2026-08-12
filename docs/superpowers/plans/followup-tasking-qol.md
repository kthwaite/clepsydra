# Follow-up: Tasking QoL pass residuals

**Status:** backlog (logged 2026-08-12 at the close of the QoL pass, spec `docs/superpowers/specs/2026-08-11-tasking-qol-design.md`). None block the merge; the final whole-branch review triaged all of these as non-blocking.

## Pre-existing defects surfaced by the pass (higher priority, out of its scope)

### 1. Global `throwOnError: true` neuters in-component error UI

`ui/src/lib/queryClient.ts:6` sets `throwOnError: true` for all queries, so any background query failure crashes to the app-wide error boundary instead of the component's own error state. This makes the board's ERROR/RETRY screen (and equivalent states elsewhere) unreachable for real network failures in production. No test catches it because every suite builds an ad-hoc QueryClient. Confirmed by live smoke: killing the server mid-session crashes the app rather than showing the board's error state or the mutation toast path recovering. Present since the repo's first commit; affects every view, not just Tasking. Deserves its own fix + tests.

### 2. TimelineView renders null-project tasks twice

`ui/src/components/tasking/TimelineView.tsx` groups by `t.project === op.project`; a task with `project: null` matches a slug-less operation (`null === null`) and is *also* collected into the UNFILED pseudo-group. Blames to `5b01e31b` (2026-06-11). Narrow trigger, visually confusing.

## Deferred from the pass (minor)

- **Keyboard-path chip tests for BacklogView/CycleView rows** — TaskCard got a keyboard regression test (Enter on chip does not activate the card) and the `e.target !== e.currentTarget` keydown guard; bk/cv rows rely on RAC propagation-stopping alone. Add the guard + tests for symmetry (a future native button nested in a row would reproduce the Task-20 dossier bug).
- **NewTaskModal dirty-check ignores selects/radios** — changing only OPERATION/CYCLE/DISPOSITION/PRIORITY leaves the modal backdrop-dismissable. Compare against preset-derived initial values.
- **SQL kind literals outside the board module** — `src/api/agenda.rs`, `src/api/tasks.rs`, `src/api/conversations.rs` still inline `'TASK'`/`'PROJECT'`/`'AI_CONVERSATION'`; the board module now uses `Kind::as_str()` + params. Extend the consolidation.
- **Inert biome-ignore comments** — three `biome-ignore lint/correctness/useExhaustiveDependencies` comments suppress a rule this repo's biome config never enables (warnings: `suppressions/unused`). Program-level call: enable the rule or drop the comments.
- **"New task" preset inconsistency** — the `N` shortcut opens the modal with no preset while ScopeRail's NEW TASKING and quick-add apply the active-op preset. Pick one behavior.
- **Legacy non-ISO `due:` values render blank in the date inputs** — display-only; editing overwrites blind. Consider a visible raw-value hint for unparseable dates.
- **Hardcoded "IN-FIELD" stat captions** in BoardHeader/CycleView metric tiles would desync if the server relabels the FIELD column (they are metric names, not column labels — rename deliberately if ever needed).
- Cosmetic: stale "COL_LABEL" test name in CycleView.test.tsx; ScopeRail onClick recomputes `opKey(op)` beside a cached const; stale pre-FocusScope comment in TaskEditPanel.test.tsx:615.

## Still open from the original a11y followup

- **Keyboard drag-and-drop** (`followup-tasking-a11y.md` item 2) — unchanged; cards move between columns only by pointer drag or via the inline status popover (which is the interim keyboard path).
