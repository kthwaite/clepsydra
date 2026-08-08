# Editable Wikilinks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render only a wikilink's custom label when present and let users move a caret into an atomic wikilink to edit `Target|Label` without changing dropdown completion.

**Architecture:** Preserve the existing Slate `inline-void` node and Markdown model. Add a per-editor React controller that tracks one transient edit session, an inline input that edits a local draft, and SlateEditor boundary-arrow wiring that enters the atomic node from surrounding text. Commit the parsed target and alias as one Slate history batch.

**Tech Stack:** React 19, TypeScript 5.9, Slate 0.123, slate-react 0.123, slate-history 0.113, Vitest 4, Testing Library, Storybook 10, Biome.

## Global Constraints

- Passive `[[Target|Label]]` renders only `⟦Label⟧`; passive `[[Target]]` renders `⟦Target⟧`.
- Active editing renders source-like `Target` or `Target|Label` inside the existing ornamental brackets.
- Keep wikilinks as Slate `inline-void` nodes with `{ type, target, alias?, children: [{ text: "" }] }`.
- Plain click edits; Cmd-click on macOS and Ctrl-click elsewhere opens.
- Arrow-right from before enters at offset zero; Arrow-left from after enters at the draft end.
- Tab completion remains target-only; Left then `|Label` edits the completed node.
- Enter and valid boundary exit commit; Escape cancels; Cmd/Ctrl+Enter commits a valid draft and opens it.
- Empty target restores the original node; empty alias removes `alias`; only the first pipe is structural.
- One completed edit session is one undo step.
- No backend, index, rename-rewriter, dependency, or Markdown syntax changes.

## File Structure

- `ui/src/editor/wikilinkEditing.tsx` — draft parsing, adjacent-node detection, context, and per-editor edit-session controller.
- `ui/src/editor/WikilinkInlineEditor.tsx` — focused local draft control and keyboard/blur exit semantics.
- `ui/src/editor/elements/WikilinkElement.tsx` — passive display, active-control rendering, and navigation/create behavior.
- `ui/src/editor/SlateEditor.tsx` — controller ownership, provider wiring, and adjacent arrow interception.
- `ui/src/editor/__tests__/wikilinkEditing.test.tsx` — parser, adjacency, commit/cancel, selection, and undo contracts.
- `ui/src/editor/__tests__/WikilinkInlineEditor.test.tsx` — caret placement and control keyboard contracts.
- `ui/src/editor/__tests__/WikilinkElement.test.tsx` — passive label and click/navigation contracts.
- `ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx` — dropdown-to-label and direct-entry integration contracts.
- `ui/src/editor/SlateEditor.stories.tsx` — browser-visible passive and editable examples using the production editor.
- `ui/src/docs/content/getting-started.mdx` — labeled syntax and keyboard interaction documentation.

---

### Task 1: Passive Alias-Only Rendering

**Files:**
- Modify: `ui/src/editor/elements/WikilinkElement.tsx:25-108`
- Test: `ui/src/editor/__tests__/WikilinkElement.test.tsx:120-168`

**Interfaces:**
- Consumes: Existing `WikilinkElementType` fields `target: string` and `alias?: string`.
- Produces: Passive visible text invariant `alias && alias !== target ? alias : target` for later active-mode work.

- [ ] **Step 1: Replace the resolved-link test with an alias-only contract**

```tsx
it("shows only the alias when a custom label exists", () => {
  lookupMock.mockReturnValue("notes/clepsydra-design.md");
  renderWikilink("Clepsydra Design Notes", "the design doc");

  expect(screen.getByText("the design doc")).toBeInTheDocument();
  expect(screen.queryByText("Clepsydra Design Notes")).toBeNull();
});
```

- [ ] **Step 2: Replace the dangling-link test with the same alias-only contract**

```tsx
it("shows only the alias for a dangling labeled link", () => {
  renderWikilink("Unwritten Page", "someday");

  expect(screen.getByText("someday")).toBeInTheDocument();
  expect(screen.queryByText("Unwritten Page")).toBeNull();
});
```

- [ ] **Step 3: Add the unlabeled fallback contract**

```tsx
it("shows the target when no custom label exists", () => {
  lookupMock.mockReturnValue("notes/clepsydra-design.md");
  renderWikilink("Clepsydra Design Notes");

  expect(screen.getByText("Clepsydra Design Notes")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the renderer tests and verify RED**

Run: `bun run test src/editor/__tests__/WikilinkElement.test.tsx` from `ui/`.

Expected: the two alias-only tests fail because both target and alias remain visible.

- [ ] **Step 5: Render one passive display value**

Replace `id`, `label`, and the target/separator/label fragment with:

```tsx
const displayText =
  element.alias && element.alias !== element.target
    ? element.alias
    : element.target;

// inside CLink, between the ornamental brackets
<span className="px-[2px] not-italic">{displayText}</span>
```

Retain resolved/dangling classes, `CLink`, and both ornamental bracket spans unchanged.

- [ ] **Step 6: Run the renderer tests and verify GREEN**

Run: `bun run test src/editor/__tests__/WikilinkElement.test.tsx` from `ui/`.

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/editor/elements/WikilinkElement.tsx ui/src/editor/__tests__/WikilinkElement.test.tsx
git commit -m "fix(ui): show only wikilink display labels"
```

---

### Task 2: Wikilink Edit-Session Controller

**Files:**
- Create: `ui/src/editor/wikilinkEditing.tsx`
- Create: `ui/src/editor/__tests__/wikilinkEditing.test.tsx`

**Interfaces:**
- Consumes: Slate `Editor`, `Path`, `Text`, `Element`, `Transforms`; slate-history `HistoryEditor`.
- Produces:
  - `type WikilinkExit = "before" | "after" | "preserve"`
  - `type WikilinkCaretEdge = "start" | "end"`
  - `interface ParsedWikilinkDraft { target: string; alias?: string }`
  - `parseWikilinkDraft(draft: string): ParsedWikilinkDraft | null`
  - `findAdjacentWikilink(editor: Editor, key: "ArrowLeft" | "ArrowRight"): { path: Path; caret: WikilinkCaretEdge; returnSide: "before" | "after" } | null`
  - `useWikilinkEditingController(editor: Editor): WikilinkEditingController`
  - `WikilinkEditingProvider` and `useWikilinkEditing()`.

- [ ] **Step 1: Write parser tests**

```tsx
describe("parseWikilinkDraft", () => {
  it.each([
    ["Target", { target: "Target" }],
    ["Target|Label", { target: "Target", alias: "Label" }],
    ["Target|", { target: "Target" }],
    ["Target|Label|Detail", { target: "Target", alias: "Label|Detail" }],
  ])("parses %s", (draft, expected) => {
    expect(parseWikilinkDraft(draft)).toEqual(expected);
  });

  it("rejects a target that is empty after trimming", () => {
    expect(parseWikilinkDraft("   |Label")).toBeNull();
  });

  it("preserves non-empty target and alias whitespace", () => {
    expect(parseWikilinkDraft(" Target | Label ")).toEqual({
      target: " Target ",
      alias: " Label ",
    });
  });
});
```

- [ ] **Step 2: Write adjacency tests with real Slate trees**

Build a history-enabled schema editor containing:

```tsx
{
  type: "paragraph",
  children: [
    { text: "before" },
    makeWikilink({ target: "Target" }),
    { text: "after" },
  ],
}
```

Assert:

```tsx
Transforms.select(editor, { path: [0, 0], offset: "before".length });
expect(findAdjacentWikilink(editor, "ArrowRight")).toEqual({
  path: [0, 1],
  caret: "start",
  returnSide: "before",
});

Transforms.select(editor, { path: [0, 2], offset: 0 });
expect(findAdjacentWikilink(editor, "ArrowLeft")).toEqual({
  path: [0, 1],
  caret: "end",
  returnSide: "after",
});
```

Also assert null for expanded selections, non-boundary offsets, wrong arrow directions, and adjacent non-wikilink nodes.

- [ ] **Step 3: Write controller tests**

Use `renderHook` with the real history-enabled editor. Cover:

```tsx
act(() => result.current.begin([0, 1], "end", "after"));
expect(result.current.active).toEqual({
  path: [0, 1],
  initialCaret: "end",
  returnSide: "after",
});

act(() =>
  result.current.commit(
    { target: "New Target", alias: "Label" },
    "after",
  ),
);
expect(Node.get(editor, [0, 1])).toMatchObject({
  type: "wikilink",
  target: "New Target",
  alias: "Label",
});
expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });

act(() => editor.undo());
expect(Node.get(editor, [0, 1])).toMatchObject({
  target: "Target",
  alias: "Old Label",
});
```

Add separate tests that:

- `alias: undefined` removes an existing alias.
- `cancel("before")` leaves the node unchanged and selects the end of `[0, 0]`.
- `commit(parsed, "preserve")` does not overwrite the current Slate selection.
- A second `begin` replaces, rather than stacks with, the first session.

- [ ] **Step 4: Run the new test file and verify RED**

Run: `bun run test src/editor/__tests__/wikilinkEditing.test.tsx` from `ui/`.

Expected: module import failure because `wikilinkEditing.tsx` does not exist.

- [ ] **Step 5: Implement the parser and adjacency helper**

Use the first pipe only:

```tsx
export function parseWikilinkDraft(
  draft: string,
): ParsedWikilinkDraft | null {
  const divider = draft.indexOf("|");
  const target = divider === -1 ? draft : draft.slice(0, divider);
  const alias = divider === -1 ? undefined : draft.slice(divider + 1);
  if (target.trim().length === 0) return null;
  return alias === undefined || alias.length === 0
    ? { target }
    : { target, alias };
}
```

For adjacency, require a collapsed selection in a `Text` node. Inspect the current text child's sibling at `index - 1` only when ArrowLeft is pressed at offset zero, and at `index + 1` only when ArrowRight is pressed at the text length. Return a match only when the sibling is a Slate element with `type === "wikilink"`.

- [ ] **Step 6: Implement context and controller**

The context value is:

```tsx
export interface WikilinkEditingController {
  active: {
    path: Path;
    initialCaret: WikilinkCaretEdge;
    returnSide: "before" | "after";
  } | null;
  begin(
    path: Path,
    initialCaret: WikilinkCaretEdge,
    returnSide: "before" | "after",
  ): void;
  commit(parsed: ParsedWikilinkDraft, exit: WikilinkExit): void;
  cancel(exit: WikilinkExit): void;
}
```

Implement `commit` inside one `HistoryEditor.withNewBatch`. Use `Transforms.setNodes` for `target`; set `alias` when present and `Transforms.unsetNodes(editor, "alias", { at: active.path })` when absent. Wrap these mutations in `Editor.withoutNormalizing`. Clear active state after the mutation. For `before`/`after`, select `Editor.before(editor, active.path)` or `Editor.after(editor, active.path)`; for `preserve`, do not select.

`cancel` clears active state without node mutations and applies the same exit selection rules. The required `useWikilinkEditing()` hook throws a descriptive error outside `WikilinkEditingProvider`; do not add a silent no-op fallback.

- [ ] **Step 7: Run the controller tests and verify GREEN**

Run: `bun run test src/editor/__tests__/wikilinkEditing.test.tsx` from `ui/`.

Expected: all parser, adjacency, mutation, selection, and undo tests pass.

- [ ] **Step 8: Commit**

```bash
git add ui/src/editor/wikilinkEditing.tsx ui/src/editor/__tests__/wikilinkEditing.test.tsx
git commit -m "feat(ui): add wikilink edit sessions"
```

---

### Task 3: Active Inline Editor and Navigation Semantics

**Files:**
- Create: `ui/src/editor/WikilinkInlineEditor.tsx`
- Create: `ui/src/editor/__tests__/WikilinkInlineEditor.test.tsx`
- Modify: `ui/src/editor/elements/WikilinkElement.tsx:1-112`
- Modify: `ui/src/editor/__tests__/WikilinkElement.test.tsx`

**Interfaces:**
- Consumes: `parseWikilinkDraft`, `WikilinkExit`, `ParsedWikilinkDraft`, `useWikilinkEditing()` from Task 2.
- Produces:
  - `WikilinkInlineEditor({ initialDraft, initialCaret, returnSide, onCommit, onCancel, onOpen })`.
  - Passive plain-click editing and modifier-click navigation.
  - Active rendering selected by `Path.equals(controller.active.path, ReactEditor.findPath(editor, element))`.

- [ ] **Step 1: Write inline-control tests**

Render `WikilinkInlineEditor` with callback spies and test:

```tsx
expect(screen.getByRole("textbox", { name: "Edit wikilink" })).toHaveValue(
  "Target|Label",
);
```

After render, assert `selectionStart`/`selectionEnd` are `0` for `initialCaret="start"` and `initialDraft.length` for `initialCaret="end"`.

Use `userEvent` to cover:

- ArrowLeft at offset zero calls `onCommit(parsed, "before")`.
- ArrowLeft away from offset zero does not exit.
- ArrowRight at the draft end calls `onCommit(parsed, "after")`.
- Enter calls `onCommit(parsed, "after")`.
- Escape calls `onCancel(returnSide)` without calling commit.
- Blur calls `onCommit(parsed, "preserve")`.
- An invalid draft calls `onCancel(exit)` for normal exits.
- Cmd/Ctrl+Enter with a valid draft calls `onCommit(parsed, "after")`, then `onOpen(parsed.target)`.
- Cmd/Ctrl+Enter with an invalid draft calls neither callback and leaves the control focused.
- One additional pipe remains part of `alias` in the parsed callback value.

- [ ] **Step 2: Run inline-control tests and verify RED**

Run: `bun run test src/editor/__tests__/WikilinkInlineEditor.test.tsx` from `ui/`.

Expected: module import failure because the component does not exist.

- [ ] **Step 3: Implement the inline control**

Use a controlled `<input>` inside a non-editable Slate wrapper:

```tsx
<input
  ref={inputRef}
  aria-label="Edit wikilink"
  value={draft}
  onChange={(event) => setDraft(event.target.value)}
  className="min-w-[4ch] bg-transparent px-[2px] font-mono text-[0.95em] text-ink outline-none"
/>
```

In `useLayoutEffect`, focus and call `setSelectionRange(0, 0)` for start or `(draft.length, draft.length)` for end. Keep a `finishedRef` guard so a key-triggered commit followed by blur does not commit twice. Apply the exact keyboard and blur rules from Step 1. Size the input with `style={{ width: `${Math.max(draft.length, 4)}ch` }}`; do not add a second persistent field or popover.

- [ ] **Step 4: Run inline-control tests and verify GREEN**

Run: `bun run test src/editor/__tests__/WikilinkInlineEditor.test.tsx` from `ui/`.

Expected: all tests pass.

- [ ] **Step 5: Extend WikilinkElement tests with an editing controller wrapper**

Replace the standalone render helper with one that can provide a real or explicit test controller. Add contracts:

- Plain click calls `begin(path, "end", "after")` and does not call `openTab`, search, or create.
- Cmd-click and Ctrl-click on a resolved link call `openTab("page", resolvedPath)` and do not begin editing.
- Cmd-click on a dangling link preserves refetch/search/create/open behavior.
- When active, the component renders the `Edit wikilink` textbox with `Target|Label` and does not render a passive role=`link`.
- Active commit delegates to `controller.commit`; active cancel delegates to `controller.cancel`.

Use a real Slate/withReact wrapper so `ReactEditor.findPath` resolves the element path; do not mock `findPath`.

- [ ] **Step 6: Run WikilinkElement tests and verify RED**

Run: `bun run test src/editor/__tests__/WikilinkElement.test.tsx` from `ui/`.

Expected: plain clicks still navigate and no active textbox exists.

- [ ] **Step 7: Refactor navigation and add passive/active modes**

In `WikilinkElement`:

- Obtain `editor` with `useSlateStatic()` and `path` with `ReactEditor.findPath(editor, element)`.
- Obtain the controller with `useWikilinkEditing()`.
- Generalize the existing dangling click function to `openTarget(target: string)`. Resolve in this order: current `lookup(target)`, `refetchAndLookup(target)`, exact-title search, page creation. Open a resolved current lookup immediately.
- Set passive `CLink.onClick` to prevent default/propagation. Cmd/Ctrl calls `openTarget(element.target)`; plain click calls `begin(path, "end", "after")`.
- When active, replace `CLink` with a non-navigating span containing brackets and `WikilinkInlineEditor`. Initialize draft as `alias === undefined ? target : `${target}|${alias}``.
- On `onCommit`, call `controller.commit(parsed, exit)`. On `onCancel`, call `controller.cancel(exit)`. On `onOpen`, call `openTarget(target)` after the inline control has committed.

Preserve dangling/resolved colors in passive mode and use resolved text styling for the active control. Suppress hover preview while active by not rendering `CLink`.

- [ ] **Step 8: Run both component test files**

Run: `bun run test src/editor/__tests__/WikilinkInlineEditor.test.tsx src/editor/__tests__/WikilinkElement.test.tsx` from `ui/`.

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add ui/src/editor/WikilinkInlineEditor.tsx ui/src/editor/elements/WikilinkElement.tsx ui/src/editor/__tests__/WikilinkInlineEditor.test.tsx ui/src/editor/__tests__/WikilinkElement.test.tsx
git commit -m "feat(ui): edit wikilinks in place"
```

---

### Task 4: SlateEditor Arrow and Completion Integration

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx:1-48,112-150,334-502`
- Create: `ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx`
- Create: `ui/src/editor/SlateEditor.stories.tsx`

**Interfaces:**
- Consumes: `findAdjacentWikilink`, `useWikilinkEditingController`, and `WikilinkEditingProvider` from Task 2.
- Produces: Production provider wiring and adjacent-arrow entry in the real editor.

- [ ] **Step 1: Write the SlateEditor integration harness**

Mock `usePages` to return one completion candidate:

```tsx
{
  id: "page-1",
  title: "My Page",
  canonical_name: "my-page",
  path: "notes/my-page.md",
}
```

Mock only network hooks (`usePages`, `useAssignBlockId`, resolution/search/create); keep real Slate, autoformat, schema, combobox, editing controller, and wikilink renderer. Provide `QueryClientProvider` and the same `HTMLElement.prototype.isContentEditable` shim used by `SlateEditor.vim-toggle.test.tsx`.

- [ ] **Step 2: Write the completion-to-label failing test**

```tsx
const editable = screen.getByRole("textbox");
await user.click(editable);
await user.type(editable, "[[My");
await user.keyboard("{Tab}");
await user.keyboard("{ArrowLeft}|short label{Enter}");

expect(screen.getByRole("link", { name: "short label" })).toBeInTheDocument();
expect(screen.queryByText("My Page")).toBeNull();
```

Capture the latest `onChange` value, serialize it with `slateToMarkdown`, and assert it contains `[[My Page|short label]]`.

- [ ] **Step 3: Write direct-entry and directional-entry tests**

Add tests that:

- Typing `[[My Page|direct label]]` autoformats and passively displays only `direct label`.
- Starting with text + wikilink + text, ArrowRight from the end of preceding text opens the active input at selection offset zero.
- ArrowLeft from the start of following text opens it at draft-end offset.
- Escape after editing restores the original target/alias and returns to the entry side.

- [ ] **Step 4: Run the integration file and verify RED**

Run: `bun run test src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx` from `ui/`.

Expected: no provider is mounted and ArrowLeft/ArrowRight do not enter the wikilink.

- [ ] **Step 5: Wire the controller and provider**

In `SlateEditor`:

```tsx
const wikilinkEditing = useWikilinkEditingController(editor);
```

After the existing combobox guard and Vim handler, intercept only ArrowLeft/ArrowRight:

```tsx
if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
  const adjacent = findAdjacentWikilink(editor, event.key);
  if (adjacent) {
    event.preventDefault();
    wikilinkEditing.begin(
      adjacent.path,
      adjacent.caret,
      adjacent.returnSide,
    );
    return;
  }
}
```

Inside `<Slate>`, wrap `Editable` and `VimStatusBar` in:

```tsx
<WikilinkEditingProvider value={wikilinkEditing}>
  {/* Editable and VimStatusBar */}
</WikilinkEditingProvider>
```

Keep combobox overlays outside the provider because they do not consume edit-session state.

- [ ] **Step 6: Run the integration and existing editor tests**

Run: `bun run test src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx src/editor/__tests__/SlateEditor.vim-toggle.test.tsx src/editor/__tests__/WikilinkCombobox.test.tsx` from `ui/`.

Expected: all tests pass; Vim and dropdown key handling remain intact.

- [ ] **Step 7: Add a production-editor Storybook story**

Create `SlateEditor.stories.tsx` with a `QueryClientProvider`, disabled network retries, and `WikilinkResolutionProvider path="notes/story.md"` around the real editor. The provider may resolve the story link as dangling when no backend is available; that is the intended offline story state. Use an initial paragraph containing:

```tsx
[
  { text: "Before " },
  makeWikilink({ target: "Clepsydra Design Notes", alias: "the design doc" }),
  { text: " after" },
]
```

Export `EditableLabeledWikilink`. Render the real `SlateEditor`, not a read-only schema preview, and keep `onChange`/`onSaveNow` as story-local no-ops. The story description states: “Only ‘the design doc’ is passive. Click to edit; use Left/Right to enter from adjacent prose.”

- [ ] **Step 8: Commit**

```bash
git add ui/src/editor/SlateEditor.tsx ui/src/editor/SlateEditor.stories.tsx ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx
git commit -m "feat(ui): enter wikilinks with the caret"
```

---

### Task 5: User Documentation and Final Verification

**Files:**
- Modify: `ui/src/docs/content/getting-started.mdx:150-170`
- Test: `ui/src/docs/mdx-smoke.test.tsx`

**Interfaces:**
- Consumes: Completed behavior from Tasks 1–4.
- Produces: User-facing wikilink syntax and interaction documentation; verified release candidate.

- [ ] **Step 1: Add a Wikilinks section to the user guide**

Document exactly:

````mdx
## Wikilinks

Type `[[` to search for a page, then press Enter or Tab to insert the selected
page. A normal link displays its page title:

```markdown
[[Clepsydra Design Notes]]
```

Add a custom display label after a pipe:

```markdown
[[Clepsydra Design Notes|the design doc]]
```

Only `the design doc` is shown, while the link still resolves to Clepsydra
Design Notes. After completing a page from the dropdown, press Left to move
back into the link and type `|the design doc`. Plain click edits a wikilink;
Cmd-click on macOS or Ctrl-click elsewhere opens it.
````

Place the section before the existing LSP introduction so basic authoring precedes editor integration.

- [ ] **Step 2: Run documentation smoke tests**

Run: `bun run test src/docs/mdx-smoke.test.tsx` from `ui/`.

Expected: the updated MDX compiles and all documentation smoke tests pass.

- [ ] **Step 3: Run formatter, typecheck, lint, and full test suite**

Run from `ui/`, in order:

```bash
bun run format
bun run typecheck
bun run lint
bun run test
```

Expected: formatter exits zero; typecheck has no diagnostics; lint has no findings; all Vitest files and tests pass. If formatting changes files, rerun typecheck, lint, and tests after the formatter output is final.

- [ ] **Step 4: Browser smoke the production editor story**

Start Storybook through the process hub with `bun run storybook -- --host 127.0.0.1`, wait for port 6006, then open `EditableLabeledWikilink` in the browser.

Verify visually and interactively:

1. Passive view shows `the design doc`, not `Clepsydra Design Notes`.
2. Plain click shows `Clepsydra Design Notes|the design doc` in the inline editor.
3. Escape returns to alias-only passive rendering.
4. Enter from edit mode commits a changed label and returns to passive rendering.
5. Arrow entry works from both adjacent prose positions.
6. The link brackets, resolved/dangling styling, line height, and surrounding prose do not jump or overlap.

Capture one passive and one active screenshot as verification evidence, then stop Storybook.

- [ ] **Step 5: Commit documentation and any formatter-only changes**

```bash
git add ui/src/docs/content/getting-started.mdx \
  ui/src/editor/WikilinkInlineEditor.tsx \
  ui/src/editor/SlateEditor.tsx \
  ui/src/editor/SlateEditor.stories.tsx \
  ui/src/editor/elements/WikilinkElement.tsx \
  ui/src/editor/wikilinkEditing.tsx \
  ui/src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx \
  ui/src/editor/__tests__/WikilinkElement.test.tsx \
  ui/src/editor/__tests__/WikilinkInlineEditor.test.tsx \
  ui/src/editor/__tests__/wikilinkEditing.test.tsx
git commit -m "docs(ui): document editable wikilinks"
```

If `git diff --cached --quiet` reports no changes beyond already committed task files, skip this commit rather than creating an empty commit.

- [ ] **Step 6: Review every task against the design specification**

Check `docs/superpowers/specs/2026-08-08-editable-wikilinks-design.md` line by line. Confirm every decision, validation rule, accessibility requirement, test contract, and non-goal is represented in the implementation and evidence. Fix any gap with a failing test first, then rerun Step 3.

- [ ] **Step 7: Merge to the integration branch**

After every gate and browser check passes, follow `superpowers:finishing-a-development-branch`: merge the feature branch into `develop`, rerun the verification gates on `develop`, and report the exact merge commit and command results.
