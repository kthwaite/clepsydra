# Task 4 — Codex modal shell report

## RED

Created `CodexModalShell.test.tsx` before production code with behavioral coverage for:

- an accessible, visibly rendered named dialog;
- Escape dismissal;
- an inner input that consumes Escape with both `preventDefault()` and `stopPropagation()`;
- backdrop dismissal;
- restoration of focus to the opening trigger.

Command:

`bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx`

Observed failure: Vitest could not resolve `#/components/codex/CodexModalShell` because the component did not exist. This was the expected missing-feature failure.

No Command Palette test existed. Added `CommandPalette.test.tsx` to lock ArrowDown + Enter dispatch and Escape-without-dispatch before migrating the palette. The initial test interaction targeted the non-focusable dialog and failed; after correcting the test to focus the palette textbox, both tests passed against the pre-migration implementation, establishing the existing navigation contract.

## GREEN

Implemented `CodexModalShell` with React Aria Components 1.17 `ModalOverlay`, `Modal`, and `Dialog`:

- controlled open state with `isOpen`;
- dismissable overlay and `onOpenChange(false)` dismissal;
- named dialog semantics;
- React Aria focus containment and restoration;
- shared top-aligned scrim and panel visual classes;
- explicit max-width, optional width, panel layout, and key-handler inputs.

React Aria's modal focus scope handles Tab at the document level. The shell therefore uses a `display: contents` event bridge around dialog children: it invokes the palette handler and stops propagation after a child/consumer has prevented a key. This preserves TagsInput's consumed Tab completion, palette navigation keys, and consumed Escape without adding a global listener.

Shell command after implementation:

`bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx`

Observed: 1 file passed, 3 tests passed.

## Migration

Migrated exactly four overlays:

- `LocationModal`: shell label `Location`, `max-w-[520px]`, store close action.
- `InscribeModal`: shell label `Intake`, `max-w-[520px]`, and `dismiss` (not raw `onClose`) on every shell dismissal path. The form remains a form inside the dialog.
- `ShortcutHelpModal`: shell label `Keyboard shortcuts`, `w-[92%]`, `max-w-[560px]`, and `flex flex-col` panel layout. Removed its window Escape listener.
- `CommandPalette`: shell label `Command console`, `w-[92%]`, `max-w-[680px]`, `flex flex-col`, `onKeyDown={onKey}`, and `onDismiss={close}`. ArrowUp, ArrowDown, Enter, and Escape logic remains unchanged in the palette.

Removed custom scrim click handlers and custom/global Escape handling from the migrated modal components. Updated the Location geocode test to rerender its existing root rather than mount a second portaled modal. Added an Inscribe backdrop-dismiss/reopen test proving local title reset, and retained the tag-completion contract under modal focus containment.

## Verification

Focused command:

`bun --cwd ui test src/components/codex/__tests__/CodexModalShell.test.tsx src/components/codex/__tests__/LocationModal.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/codex/__tests__/ShortcutHelpModal.test.tsx src/components/codex/__tests__/CommandPalette.test.tsx`

Observed final result: 5 files passed, 25 tests passed.

Structural checks:

- exactly the four requested production overlays contain `<CodexModalShell>`;
- no `addEventListener`, custom scrim `onMouseDown`, or hand-authored `role="dialog"` remains in those four files;
- no Tasking files were touched.

Per assignment constraints, formatters, linters, builds, and project-wide tests were not run.

## Self-review

- Accessibility: dialog name, focus movement, focus restoration, Escape, consumed Escape, and backdrop dismissal are behavior-tested.
- Visual contract: shared scrim remains top-aligned at `pt-20`; widths remain 520px / 520px / 560px / 680px; the two pre-existing 92% overlays retain 92%, while Location and Inscribe retain 88%; Shortcut Help and palette retain flex-column panels.
- Behavior contract: Inscribe routes every dismissal through reset; tag Tab completion still passes; palette selection and close behavior pass focused tests.
- Scope: changes are limited to the shell, the four requested consumers, their focused tests, and this required report.
- Concerns: none found in focused verification.
