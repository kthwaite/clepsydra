# Follow-up: Tasking board accessibility

**Status:** backlog (logged 2026-06-11 during Task 15 integration polish). Not blocking the initial ship.

## Deferred items

### 1. TaskCard keyboard activation

`TaskCard` renders as a `<div>` with `onClick`. It needs `role="button"`, `tabIndex={0}`, and a `keyDown` handler for Enter/Space to open the edit panel. Currently only mouse-accessible.

### 2. Keyboard DnD for TaskCard

HTML5 drag-and-drop (`draggable` / `onDragStart`) is not keyboard-accessible. A keyboard DnD affordance (e.g. grab with Space, reorder with arrow keys, drop with Enter/Space, cancel with Escape) is needed for full a11y compliance. Consider react-aria's `useDraggable` / `useDroppable` or a custom keyboard trap.

### 3. TaskEditPanel focus containment vs aria-modal

The edit panel uses hand-rolled focus handling (focus on open, restore on close, `role=dialog aria-modal`). It does not currently trap focus within the panel — a keyboard user can Tab out of the panel into the scrim or board body. Fix: implement a focus trap (e.g. `inert` on the backdrop, or a `<FocusTrap>` wrapper, or the RAC `FocusScope` with `contain`).

### 4. Cycle modal chrome extraction (CycleModalShell)

`NewCycleModal`, `OpenCycleModal`, and `SealCycleModal` each hand-roll their own modal chrome (overlay, close button, focus handling). Extract a shared `CycleModalShell` that handles: `role=dialog`, `aria-labelledby`, `aria-modal`, Escape-to-close, focus-on-open, focus-restore-on-close, and a consistent scrim. Each modal body then only renders its own content.

## Why not now

These are UI polish/a11y concerns that don't block the core tasking workflow. Keyboard DnD in particular is a significant effort. The focus-trap and modal chrome refactors are medium-effort with good return. Ship the board first; address in a follow-up pass.

## Acceptance (per item)

1. **TaskCard keyboard** — `role="button"` + `tabIndex={0}` + Enter/Space opens edit panel; axe-core `aria-required-children` clean.
2. **Keyboard DnD** — drag handles operable without a pointer device; ARIA live region announces position changes.
3. **TaskEditPanel focus trap** — Tab/Shift-Tab cycles only within the panel while it is open; `inert` or equivalent applied to the sibling board body.
4. **CycleModalShell** — all three cycle modals share one shell component; no duplicated focus/escape logic; RTL tests confirm Escape closes each modal.
