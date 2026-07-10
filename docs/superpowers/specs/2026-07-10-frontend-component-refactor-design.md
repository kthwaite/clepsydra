# Frontend Component Refactor Design

## Goal

Remove the strongest duplicated frontend implementations identified in the July 2026 audit without changing user-visible behavior, routes, data contracts, or the two established visual languages (Codex and Tasking).

## Constraints

- Preserve current rendering, keyboard behavior, focus behavior, mutation payloads, labels, dimensions, test IDs, and store transitions.
- Keep Codex and Tasking modal presentation separate.
- Prefer narrow components and pure helpers over configuration-driven universal components.
- Do not combine the Kanban card, backlog register row, and cycle lane row into one universal task row.
- Do not introduce memoization or new state abstractions without a demonstrated need.
- Preserve unrelated working-tree changes.

## Considered Approaches

### 1. Domain-specific shells and leaf components — selected

Create a Codex modal shell and a Tasking modal frame, then extract tasking statistics and repeated leaf presentation. Each abstraction owns one stable responsibility and preserves the domain’s existing styling.

Benefits: small APIs, minimal behavioral risk, clear ownership, and no cross-domain styling coupling.

### 2. Extend the existing generic `Dialog` for every modal

Add enough variants and slots to represent centered standard dialogs, top-aligned Codex overlays, and Tasking register dialogs.

Rejected because the current primitive imposes standard header/footer chrome and a different theme vocabulary. Supporting every domain would make its API conditional and difficult to understand.

### 3. Universal configurable modal/task components

Represent dialogs and task rows with configuration arrays, render slots, and many flags.

Rejected because it would replace duplicated markup with prop complexity. The domain workflows and task layouts have materially different behavior.

## Architecture

### Codex modal shell

Add `ui/src/components/codex/CodexModalShell.tsx` using React Aria `ModalOverlay`, `Modal`, and `Dialog`. It owns:

- top-aligned Codex scrim and panel placement;
- dismissable backdrop behavior;
- dialog semantics, focus containment, and focus restoration;
- configurable accessible label and maximum width;
- shared panel border/background/font classes;
- optional keyboard handling for content-specific controls.

Migrate `LocationModal`, `InscribeModal`, `ShortcutHelpModal`, and `CommandPalette`. Domain content remains in each caller. Escape handling must respect an inner control that has already consumed the event. `CommandPalette` retains ArrowUp, ArrowDown, Enter, and selection behavior.

### Tasking modal frame

Add `ui/src/components/tasking/BoardModalFrame.tsx` using the same React Aria primitives already used by the tasking dialogs. It owns:

- the `z-[9000]` overlay and backdrop blur;
- dismissability and open-change callback;
- responsive width;
- bordered panel and shared shadow;
- optional max-height and keyboard handler;
- accessible label and existing backdrop/panel test IDs.

Migrate `NewTaskModal`, `NewCycleModal`, `OpenCycleModal`, and `SealCycleModal`. Keep their content, widths, headers, footers, and mutation logic explicit.

### Tasking statistics

Add `ui/src/components/tasking/board-stats.ts` with pure helpers:

- `checklistProgress(checks)` returns `done`, `total`, `percent`, and `isComplete`;
- `cycleStats(items)` computes committed, sealed, field, hold, checklist, and sealed-percentage totals;
- `sealStats(tasks, cycleCode)` filters a cycle and adds carryover.

Current checklist semantics remain unchanged:

- arrays with fewer than two entries produce zero values;
- percentage is zero when total is zero;
- completion requires a positive total and exact equality;
- percentage is not clamped or rounded for individual task progress;
- cycle sealed percentage remains rounded and based on sealed tasks divided by committed tasks.

Move pure-helper tests to import from `board-stats.ts`. Render components must not own exported domain calculations.

### Cycle transition leaves

Add narrow cycle-transition presentation components only where duplication is exact:

- `CycleMetric` for the repeated metric label/value cell;
- shared header/footer primitives only if their resulting APIs remain smaller than the duplicated markup.

Open- and seal-cycle workflow bodies remain separate.

### Scope rail cycle row

Add a private or tasking-local `CycleNavRow` that renders the shared cycle navigation row. Normalize real cycles and the backlog pseudo-cycle into explicit row props. Preserve the backlog count definition (`!task.cycle`) and its displayed `BKLG`/`unscheduled` labels.

### Task identity leaves

Extract only stable repeated fragments, such as checklist text/progress and HOLD identity presentation, when the extraction can be used by at least two task layouts without layout flags. Keep `TaskCard`, `BacklogView`, and `CycleView` as separate containers.

## Data Flow and Error Handling

This refactor introduces no new server calls or state. Existing stores and mutations remain authoritative. Modal shells receive open/dismiss state from callers and do not own domain state. Pure statistics accept existing `BoardTask` values and preserve current fallback behavior for malformed checklist tuples.

React Aria owns modal focus and backdrop mechanics. Inner controls may prevent the default Escape action; shells must not dismiss after an inner control consumes Escape.

## Testing

Work test-first by adding or updating focused tests before each extraction:

1. Codex shell contracts: backdrop dismissal, Escape dismissal, consumed Escape, accessible dialog role, and command-palette navigation.
2. Tasking frame contracts: existing backdrop, Escape, close-button, Cmd/Ctrl+Enter, visibility, and test-ID expectations remain green.
3. Statistics contracts: short checklist tuple, zero total, complete/incomplete, percentage calculation, aggregate cycle counts, and seal carryover.
4. Scope rail: real-cycle and backlog selection/count behavior remains unchanged.
5. Task leaf rendering: HOLD and checklist summaries remain unchanged where extracted.

After focused tests, run the complete frontend gates:

- `bun --cwd ui run typecheck`
- `bun --cwd ui run lint`
- `bun --cwd ui run test`
- `bun --cwd ui run build`

## Acceptance Criteria

- Four Codex overlays use one React Aria-backed Codex shell.
- Four Tasking dialogs use one Tasking frame.
- Checklist, cycle, and seal statistics live in a pure non-component module.
- Repeated cycle metric cells use one leaf component.
- ScopeRail renders real and backlog cycles through one row component.
- No universal task row or monolithic task form is introduced.
- Existing behavior, visual classes, test IDs, mutation payloads, and store transitions are preserved.
- Focused tests and all frontend verification gates pass.
