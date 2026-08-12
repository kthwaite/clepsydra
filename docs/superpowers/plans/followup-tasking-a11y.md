# Follow-up: Tasking board accessibility

**Status:** backlog (logged 2026-06-11 during Task 15 integration polish). Not blocking the initial ship.

## Deferred items

### 1. TaskCard keyboard activation

**Status: DONE** (commits: 91f95eab–1f29d4e8; 2026-08-12)

`TaskCard` now renders with `role="button"`, `tabIndex={0}`, and a `keyDown` handler for Enter/Space to open the edit panel. Target guard prevents the handler from firing when focus is on a descendant (dossier button, priority/status chips). The dossier footer link is now a real `<button>` element. Regression test ensures RAC Buttons (priority badge, state pip) don't bubble keyboard activation to the card. Keyboard tests verify dossier button isolation.

### 2. Keyboard DnD for TaskCard

HTML5 drag-and-drop (`draggable` / `onDragStart`) is not keyboard-accessible. A keyboard DnD affordance (e.g. grab with Space, reorder with arrow keys, drop with Enter/Space, cancel with Escape) is needed for full a11y compliance. Consider react-aria's `useDraggable` / `useDroppable` or a custom keyboard trap.

### 3. TaskEditPanel focus containment vs aria-modal

**Status: DONE** (commit: 9c04fc9b; 2026-08-12)

The panel now wraps its contents in react-aria's `FocusScope` (`contain restoreFocus autoFocus`), replacing the hand-rolled focus-on-open/restore-on-close effect. Tab/Shift-Tab now cycle only within the panel while it is open (verified by tabbing well past the panel's focusable count and asserting `document.activeElement` never leaves it); focus still restores to the opener on close. `role=dialog` + `aria-modal` and the Escape-to-close listener are unchanged. `react-aria` was promoted from a transitive dependency (via `react-aria-components`) to a direct one.

Item 2 (keyboard DnD for TaskCard) remains open — this fix only addressed the edit panel's focus trap, not drag-and-drop keyboard accessibility.

### 4. Cycle modal chrome extraction (CycleModalShell)

`NewCycleModal`, `OpenCycleModal`, and `SealCycleModal` each hand-roll their own modal chrome (overlay, close button, focus handling). Extract a shared `CycleModalShell` that handles: `role=dialog`, `aria-labelledby`, `aria-modal`, Escape-to-close, focus-on-open, focus-restore-on-close, and a consistent scrim. Each modal body then only renders its own content.

## Why not now

These are UI polish/a11y concerns that don't block the core tasking workflow. Keyboard DnD in particular is a significant effort. The focus-trap and modal chrome refactors are medium-effort with good return. Ship the board first; address in a follow-up pass.

## Acceptance (per item)

1. **TaskCard keyboard** — `role="button"` + `tabIndex={0}` + Enter/Space opens edit panel; axe-core `aria-required-children` clean.
2. **Keyboard DnD** — drag handles operable without a pointer device; ARIA live region announces position changes.
3. **TaskEditPanel focus trap** — Tab/Shift-Tab cycles only within the panel while it is open; `inert` or equivalent applied to the sibling board body. **DONE** (via `FocusScope contain`, commit 9c04fc9b).
4. **CycleModalShell** — all three cycle modals share one shell component; no duplicated focus/escape logic; RTL tests confirm Escape closes each modal.
