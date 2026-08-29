# Folio selection bubble menu — implementation plan

Branch `feature/folio-bubble-menu` off `develop` @ a5958381. Worktree `.worktrees/folio-bubble-menu`.
Vault task: `TSK-jaded-sod-0wt0t`.

## Decisions

- Show the menu only for a non-collapsed selection in an editable Folio Slate editor.
- Use `@floating-ui/react` with a Slate DOM range virtual reference, `offset`, `flip`, `shift`, and `autoUpdate`. Prefer placement above; flip below when space is constrained.
- Never expose prose marks when the selection touches inline code or a code block. The menu stays hidden for those selections.
- Preserve the Slate selection when controls receive pointer input. Apply marks to the selected range, then restore editor focus.
- Provide bold, italic, underline, strikethrough, subscript, superscript, inline code, highlight, and text colour.
- Text colour and highlight each use a compact theme-safe palette plus a native custom colour input and a clear action.
- Persist colour marks as constrained inline HTML styles because Markdown has no native colour syntax. Parse only supported `color` and `background-color` values. Do not preserve arbitrary style properties.
- Keep the component editor-local. No global toolbar abstraction.

## Task 1 — Colour mark model and Markdown round-trip

**Files**
- Modify `ui/src/editor/schema/types.ts`
- Modify `ui/src/editor/elements/renderLeaf.tsx`
- Modify `ui/src/editor/convert/slate-to-mdast.ts`
- Modify `ui/src/editor/convert/mdast-to-slate.ts`
- Modify conversion tests under `ui/src/editor/convert/__tests__/`

**Red**
1. Add conversion tests for text colour, highlight colour, nested existing marks, clearing, and rejection of unrelated inline styles.
2. Run only the conversion tests. Confirm failures describe missing colour marks.

**Green**
1. Add optional `color` and `backgroundColor` text marks.
2. Render the marks without breaking Prism token colours.
3. Serialize the two marks to minimal inline HTML.
4. Parse the two supported style declarations while ignoring unsupported declarations.
5. Run conversion and leaf tests.

## Task 2 — Selection bubble menu

**Files**
- Create `ui/src/editor/SelectionBubbleMenu.tsx`
- Create `ui/src/editor/__tests__/SelectionBubbleMenu.test.tsx`
- Modify `ui/src/editor/floatingSelectionReference.ts`
- Modify `ui/src/editor/SlateEditor.tsx`

**Red**
1. Add behavior tests for visibility, placement middleware configuration through observable output, mark toggling, mutual exclusion of subscript/superscript, palette/custom colours, clear actions, selection preservation, and code-selection suppression.
2. Run the focused tests. Confirm they fail because the menu does not exist.

**Green**
1. Add a non-collapsed selection virtual reference helper using the DOM range geometry and editor root as `contextElement`.
2. Implement the accessible toolbar and colour popovers.
3. Derive active/mixed marks from the selected Slate text nodes.
4. Hide the toolbar for code blocks and selections touching inline code.
5. Mount it inside the existing `Slate` context and ensure selection changes reposition or close it.
6. Run focused editor tests.

## Task 3 — Review and verification

1. Review both tasks against the vault checklist and repository conventions. Fix findings with focused regression tests.
2. Run UI typecheck: `bun run typecheck`.
3. Run UI lint: `bun run lint`.
4. Run UI tests: `bun run test`.
5. Run repository Rust tests: `cargo test`.
6. Start the application and verify in a real browser: above/below placement, every prose control, colour palettes/custom colours, persistence after save/reload, code suppression, light/dark appearance, and mobile viewport.
7. Commit the branch, merge it into `develop`, remove the worktree, then mark the vault checklist complete and move the task to Done.
