# Stray Thoughts P1 Editor Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make todo checkbox state immediate and durable, preserve newly created todos through save/navigation round trips, and provide a normal forward exit from terminal inline code.

**Architecture:** Slate remains the sole live-document authority and Markdown remains the disk boundary. Correct the checkbox at its controlled DOM-to-Slate event, enforce the canonical task-list shape in shared transforms/converters, and add one structural terminal-code boundary helper consumed by the editor key handler.

**Tech Stack:** React 19, TypeScript, Slate 0.123, slate-history, slate-react, mdast-util-gfm, Vitest, Testing Library, user-event, Bun.

## Global Constraints

- Fix shared Slate operation/normalization boundaries; do not add navigation-time repairs, local checkbox shadow state, per-character exceptions, or timers.
- Todo Markdown is canonical GFM task syntax: `- [ ] text` and `- [x] text`.
- One checkbox activation produces one undoable Slate change and one autosave input value.
- Terminal inline-code exit clears only the `code` mark; it does not clear bold, italic, underline, or link state outside the existing punctuation contract.
- Block code behavior is unchanged.
- Every production change starts with a focused failing behavioral test.
- Existing unstaged files in the primary checkout remain untouched.

---

### Task 1: Make checkbox interaction immediately reflect Slate state

**Files:**
- Modify: `ui/src/editor/schema/elements/list.tsx` (`ListItem`)
- Create or modify test: `ui/src/editor/schema/elements/list.test.tsx`
- Test: `ui/src/editor/plugins/__tests__/withOutliner.test.ts`
- Test: `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`

**Interfaces:**
- Preserve `ListItemElement.checked?: boolean | null`.
- Preserve `toggleCheckbox(editor: Editor): void`.
- The rendered `<input checked={element.checked}>` remains controlled by Slate; no React `useState` is introduced.

- [ ] **Step 1: Add a failing rendered checkbox test**

Render a real Slate editor using the schema registry with one unchecked task item and an `onChange` spy. Click the checkbox and assert the DOM, node, serialization, and history agree immediately:

```tsx
const checkbox = screen.getByRole("checkbox", { name: /buy milk/i });
await user.click(checkbox);
expect(checkbox).toBeChecked();
expect(screen.getByText("Buy milk").closest("li")).toHaveClass("line-through");
expect((editor.children[0] as BulletedListElement).children[0].checked).toBe(true);
expect(slateToMarkdown(editor.children)).toContain("[x] Buy milk");
expect(onChange).toHaveBeenCalled();
```

Undo once and assert the checkbox, node, and Markdown all return to unchecked. Add a read-only case proving activation cannot mutate the node.

- [ ] **Step 2: Run the rendered test RED**

```bash
bun run test src/editor/schema/elements/list.test.tsx
```

Expected: the immediate checked assertion reproduces the current browser defect even though completed styling may change.

- [ ] **Step 3: Remove native rollback from the controlled input event**

`ListItem` currently calls `preventDefault()` inside checkbox `onChange`, which can restore the native checkbox state after Slate rerenders. Keep Slate authoritative but do not cancel the change event:

```tsx
onChange={() => {
  if (readOnly) return;
  const path = ReactEditor.findPath(editor, element);
  Transforms.setNodes(
    editor,
    { checked: !checked } as Partial<Element>,
    { at: path },
  );
}}
```

Do not add local checked state. If a rendered regression test proves event bubbling moves the editor selection, stop propagation at the non-editable wrapper without cancelling the checkbox default.

- [ ] **Step 4: Run focused checkbox tests GREEN**

```bash
bun run test src/editor/schema/elements/list.test.tsx src/editor/plugins/__tests__/withOutliner.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts
```

Expected: immediate state, undo, keyboard toggle, and Markdown serialization pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/elements/list.tsx ui/src/editor/schema/elements/list.test.tsx
git commit -m "fix(editor): update todo checkboxes immediately"
```

---

### Task 2: Preserve created todos through save and reload

**Files:**
- Modify test: `ui/src/editor/plugins/autoformat/__tests__/blockTransforms.test.ts`
- Modify test: `ui/src/editor/plugins/autoformat/__tests__/listContinuation.test.ts`
- Modify test: `ui/src/editor/convert/__tests__/round-trip.test.ts`
- Create integration test: `ui/src/editor/__tests__/SlateEditor.todo-round-trip.test.tsx`
- Modify only the shared source shown by the failing contract: `ui/src/editor/transforms/blockConversions.ts`, `ui/src/editor/plugins/autoformat/blockTransforms.ts`, `ui/src/editor/plugins/autoformat/listContinuation.ts`, `ui/src/editor/schema/elements/list.tsx`, or the two converters

**Interfaces:**
- Every task item has shape:

```ts
{
  type: "list-item";
  checked: boolean;
  children: [{ type: "paragraph"; children: CustomText[] }];
}
```

- `slateToMarkdown(markdownToSlate(source))` preserves task state.
- Existing Backspace/empty-list commands remove a restored item without special cases.

- [ ] **Step 1: Add a pure canonical round-trip matrix**

Exercise both task creation paths: paragraph autoformat from `[ ] ` and Enter continuation from an existing checked task. For each result:

```ts
const markdown = slateToMarkdown(editor.children);
expect(markdown).toContain("- [ ] New task");
const restored = markdownToSlate(markdown);
const item = taskItemAt(restored, 0);
expect(item).toMatchObject({
  type: "list-item",
  checked: false,
  children: [{ type: "paragraph" }],
});
expect(slateToMarkdown(restored)).toBe(markdown);
```

Also assert no extra empty/plain bullet appears and restored list commands can check, uncheck, empty, Backspace, and exit to a paragraph.

- [ ] **Step 2: Run pure tests and identify the first red invariant**

```bash
bun run test src/editor/plugins/autoformat/__tests__/blockTransforms.test.ts src/editor/plugins/autoformat/__tests__/listContinuation.test.ts src/editor/convert/__tests__/round-trip.test.ts
```

Expected: at least one assertion reproduces checked-state or canonical-shape loss. If all pure tests pass, do not edit production code; continue to the real input/save test because the defect is then above the converter boundary.

- [ ] **Step 3: Add the real edit-save-remount regression**

Render production `SlateEditor` with `usePageEditor`'s conversion/save contract, drive the observed keyboard sequence through the real editable, call `saveNow`, unmount, and remount from the captured Markdown response. Assert the restored checkbox and ordinary remove flow:

```ts
expect(savedBody).toContain("[ ] New task");
rerenderPageFrom(savedBody);
expect(screen.getByRole("checkbox", { name: "New task" })).not.toBeChecked();
await removeTaskWithNormalListCommands(user);
expect(screen.queryByText("New task")).not.toBeInTheDocument();
expect(screen.queryByRole("listitem", { name: "" })).not.toBeInTheDocument();
```

Use fake timers only to flush the existing 1500ms save debounce; do not add production timing logic.

- [ ] **Step 4: Run the integration test RED**

```bash
bun run test src/editor/__tests__/SlateEditor.todo-round-trip.test.tsx
```

Expected: FAIL at the observed shape, save, or restored-removal invariant. Record the first divergent Slate tree in the task result.

- [ ] **Step 5: Correct the single shared producer or converter**

Make the smallest change that ensures every task producer uses the descriptor-backed canonical nesting and explicit checked state. The production result must be equivalent to:

```ts
makeBulletedList({
  children: [
    makeListItem({
      checked: false,
      children: [makeParagraph({ children: [{ text: "New task" }] })],
    }),
  ],
});
```

If the failing tree is already canonical but the save omits the operation, correct `onSlateChange`/operation classification in `usePageEditor.ts` so structural `set_node`, `insert_node`, and `remove_node` operations mark the document dirty; continue excluding selection-only operations. Do not repair the tree on navigation or load.

- [ ] **Step 6: Run all todo paths GREEN**

```bash
bun run test src/editor/__tests__/SlateEditor.todo-round-trip.test.tsx src/editor/schema/elements/list.test.tsx src/editor/plugins/__tests__/withOutliner.test.ts src/editor/plugins/autoformat/__tests__/blockTransforms.test.ts src/editor/plugins/autoformat/__tests__/listContinuation.test.ts src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts
```

Expected: all pass, including save/remount and normal removal.

- [ ] **Step 7: Commit**

Stage the integration test and only the source/tests actually needed by the first divergent invariant:

```bash
git commit -m "fix(editor): preserve todos across navigation"
```

---

### Task 3: Exit terminal inline code with ArrowRight

**Files:**
- Modify: `ui/src/editor/plugins/withInlinePunctuationBoundary.ts`
- Modify: `ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts`
- Modify: `ui/src/editor/SlateEditor.tsx`
- Create or modify test: `ui/src/editor/__tests__/SlateEditor.inline-code-boundary.test.tsx`

**Interfaces:**
- Add `exitTerminalInlineCode(editor: Editor): boolean`.
- Return `true` only for a collapsed selection at the end of a `code: true` text leaf that is also at the end of its containing text block.
- On success remove only the active `code` mark; leave selection at the boundary so the next insertion serializes outside the backticks.

- [ ] **Step 1: Add failing structural boundary tests**

```ts
Transforms.select(editor, { path: [0, 0], offset: 4 });
expect(exitTerminalInlineCode(editor)).toBe(true);
editor.insertText(" next");
expect(slateToMarkdown(editor.children).trim()).toBe("`code` next");
```

Add negative cases for a caret inside code, code followed by ordinary text, non-code terminal text, expanded selection, and a block-code element. Add a mixed-mark case proving bold remains active while code is removed.

- [ ] **Step 2: Run structural tests RED**

```bash
bun run test src/editor/__tests__/withInlinePunctuationBoundary.test.ts
```

Expected: FAIL because `exitTerminalInlineCode` does not exist.

- [ ] **Step 3: Implement the structural helper**

Use Slate points rather than Markdown text:

```ts
export function exitTerminalInlineCode(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;
  const [leaf] = Editor.leaf(editor, selection.anchor);
  if (leaf.code !== true || selection.anchor.offset !== leaf.text.length) return false;
  const block = Editor.above(editor, {
    at: selection.anchor,
    match: (node) => SlateElement.isElement(node) && Editor.isBlock(editor, node),
  });
  if (!block || !Editor.isEnd(editor, selection.anchor, block[1])) return false;
  Editor.removeMark(editor, "code");
  return true;
}
```

Adjust the block predicate only if existing schema helpers provide the repository-standard block test.

- [ ] **Step 4: Wire ArrowRight before adjacent-inline navigation**

In `SlateEditor`'s key handler, after IME/read-only guards and before existing wikilink ArrowRight handling:

```ts
if (event.key === "ArrowRight" && exitTerminalInlineCode(editor)) {
  event.preventDefault();
  return;
}
```

Do not intercept ArrowLeft, ordinary typing, or ArrowRight when the helper returns false.

- [ ] **Step 5: Run real keyboard test GREEN**

```bash
bun run test src/editor/__tests__/SlateEditor.inline-code-boundary.test.tsx src/editor/__tests__/withInlinePunctuationBoundary.test.ts src/editor/convert/__tests__/round-trip.test.ts
```

The real test must press ArrowRight then type, assert regular sans-serif/non-code rendering, assert `` `code` next `` serialization, and verify one-step undo of inserted text.

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/plugins/withInlinePunctuationBoundary.ts ui/src/editor/__tests__/withInlinePunctuationBoundary.test.ts ui/src/editor/SlateEditor.tsx ui/src/editor/__tests__/SlateEditor.inline-code-boundary.test.tsx
git commit -m "fix(editor): exit terminal inline code"
```

---

### Task 4: Review and editor smoke verification

- [ ] **Step 1: Review operation invariants**

Confirm there is no checkbox shadow state, navigation repair, DOM-only formatting fix, or character-specific inline-code path.

- [ ] **Step 2: Run focused editor suite**

Run all files named in Tasks 1–3 plus `ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx` when present. Expected: PASS.

- [ ] **Step 3: Browser smoke**

In a real Folio: create a todo, check/uncheck it, save, navigate away/back, remove it normally, then type inline code at end-of-line, press ArrowRight, type ordinary prose, save, and inspect Markdown after reload.

- [ ] **Step 4: Commit review corrections**

Commit only if review or smoke verification required source changes.
