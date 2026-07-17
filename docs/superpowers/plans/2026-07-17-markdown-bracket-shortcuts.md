# Markdown Bracket Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structural Markdown typing shortcuts that create footnote references with matching definitions and continue `[label]` into a link destination.

**Architecture:** Extend the existing Slate `withAutoformat` pipeline. A shared `]` inline transform handles footnotes before link-label continuation, while the existing `)` transform gains consumed-closer awareness so the preinserted round bracket is never stored in the URL; composed input replays the same transformations.

**Tech Stack:** TypeScript 5.9, Slate 0.123, slate-history 0.113, Vitest 4, Bun, Biome

## Global Constraints

- Use the existing `makeFootnoteRef` and `makeFootnoteDef` schema factories.
- Append a missing footnote definition at document end; never duplicate a matching definition.
- Keep the caret after a created footnote reference and inside `()` after link-label continuation.
- Do not transform empty/incomplete syntax, code blocks, or inline code.
- Character-by-character and composed multi-character input must produce the same Slate structures.
- Each `]` shortcut must be one independent history batch.
- Do not add DOM keyboard handlers, generic square-bracket pairing, dependencies, or serialization changes.

---

## File Structure

- Modify `ui/src/editor/plugins/autoformat/inlineTransforms.ts`: own `]` dispatch, footnote construction, link-label continuation, code-context guard, and consumed-`)` handling.
- Modify `ui/src/editor/plugins/autoformat/withAutoformat.ts`: replay `]` during composed input without reprocessing continuation delimiters.
- Modify `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`: integration contracts for typed/composed footnotes, links, guards, definition reuse, caret placement, and undo.
- No new runtime source files. Both shortcuts share the existing inline-autoformat context, text-before-caret lookup, history batching, and composed-input replay.

---

### Task 1: Link Label Continuation

**Files:**
- Modify: `ui/src/editor/plugins/autoformat/inlineTransforms.ts:13-30,168-211`
- Test: `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts:73-101,214-285`

**Interfaces:**
- Consumes: `tryInlineTransform(editor: Editor, typed: string, closerConsumed?: boolean): boolean`, `getTextBefore(editor)` and the existing `tryOvertype` dispatch order.
- Produces: `tryBracketTransform(editor: Editor): boolean`; `tryLinkTransform(editor: Editor, closerConsumed?: boolean): boolean` whose consumed path excludes the already-present final `)` from `url`.

- [ ] **Step 1: Add failing link-label and overtype tests**

Add these cases to `describe("inline transforms via insertText", ...)`:

```ts
it("] after [label inserts () and places the caret inside", () => {
  const editor = makeSchemaEditor();
  type(editor, "[Example]");

  expect(Node.string(editor.children[0])).toBe("[Example]()");
  expect(editor.selection).toEqual({
    anchor: { path: [0, 0], offset: "[Example](".length },
    focus: { path: [0, 0], offset: "[Example](".length },
  });
});

it("overtype-closing the inserted ) creates a link without storing the closer", () => {
  const editor = makeSchemaEditor();
  type(editor, "[Example]");
  type(editor, "https://example.com)");

  const children = (editor.children[0] as any).children;
  const link = children.find((child: any) => child.type === "link");
  expect(link).toMatchObject({
    type: "link",
    url: "https://example.com",
    children: [{ text: "Example" }],
  });
  expect(Node.string(editor.children[0])).toBe("Example");
});

it("leaves an empty link destination as literal markdown", () => {
  const editor = makeSchemaEditor();
  type(editor, "[Example]");
  editor.insertText(")");

  expect(Node.string(editor.children[0])).toBe("[Example]()");
  expect(
    (editor.children[0] as any).children.some(
      (child: any) => child.type === "link",
    ),
  ).toBe(false);
});

it("one undo reverses link-label continuation", () => {
  const editor = makeSchemaEditor();
  type(editor, "[Example");
  editor.insertText("]");

  editor.undo();

  expect(Node.string(editor.children[0])).toBe("[Example");
});
```

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run:

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: the new cases fail because `]` currently inserts only a literal bracket and the overtype path includes the consumed `)` in the URL.

- [ ] **Step 3: Dispatch `]` and add minimal link-label continuation**

In `tryInlineTransform`, add `]` before `)` and pass `closerConsumed` to the link transform:

```ts
if (typed === "]") return tryBracketTransform(editor);
if (typed === ")") return tryLinkTransform(editor, closerConsumed);
```

Add a bracket transform near `tryLinkTransform`:

```ts
function tryBracketTransform(editor: Editor): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore } = info;
  const openBracketIdx = textBefore.lastIndexOf("[");
  if (openBracketIdx === -1) return false;
  if (openBracketIdx > 0 && !/\s/.test(textBefore[openBracketIdx - 1]))
    return false;

  const label = textBefore.slice(openBracketIdx + 1);
  if (label.length === 0 || label.startsWith("^")) return false;

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Transforms.insertText(editor, "]()");
    Transforms.move(editor, {
      distance: 1,
      unit: "character",
      reverse: true,
    });
  });
  return true;
}
```

This helper deliberately rejects `^` labels; Task 2 adds the higher-priority footnote branch.

- [ ] **Step 4: Make final-link conversion consumed-closer aware**

Change the existing helper signature and derive the URL boundary from whether overtype already moved past `)`:

```ts
function tryLinkTransform(
  editor: Editor,
  closerConsumed = false,
): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  if (closerConsumed && !textBefore.endsWith(")")) return false;
  const contentEnd = textBefore.length - (closerConsumed ? 1 : 0);

  const bracketParenIdx = textBefore.lastIndexOf("](", contentEnd);
  if (bracketParenIdx === -1) return false;

  const openBracketIdx = textBefore.lastIndexOf("[", bracketParenIdx - 1);
  if (openBracketIdx === -1) return false;
  if (openBracketIdx > 0 && !/\s/.test(textBefore[openBracketIdx - 1]))
    return false;

  const linkText = textBefore.slice(openBracketIdx + 1, bracketParenIdx);
  const url = textBefore.slice(bracketParenIdx + 2, contentEnd);
  if (linkText.length === 0 || url.length === 0) return false;

  const rangeStart: Point = { path: path as any, offset: openBracketIdx };
  const rangeEnd: Point = { path: path as any, offset: textBefore.length };

  HistoryEditor.withNewBatch(editor as any, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);
      Transforms.insertNodes(editor, {
        type: "link",
        url,
        children: [{ text: linkText }],
      } as any);
    });
  });

  return true;
}
```

Keep the deletion endpoint at `textBefore.length`: the consumed path must delete the physical `)` even though `contentEnd` excludes it from `url`.

- [ ] **Step 5: Run focused tests and confirm green**

Run:

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: all autoformat tests pass, including the pre-existing direct/composed `[t](https://a.b)` contract.

- [ ] **Step 6: Commit the independently working link shortcut**

```bash
git add ui/src/editor/plugins/autoformat/inlineTransforms.ts ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
git commit -m "feat(editor): continue markdown link labels"
```

---

### Task 2: Footnote Reference and Definition Shortcut

**Files:**
- Modify: `ui/src/editor/plugins/autoformat/inlineTransforms.ts:1-45` and the Task 1 `tryBracketTransform`
- Modify: `ui/src/editor/plugins/autoformat/withAutoformat.ts:95-149`
- Test: `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts:73-101,214-285`

**Interfaces:**
- Consumes: Task 1's `tryBracketTransform(editor): boolean`; `makeFootnoteRef({ identifier })`; `makeFootnoteDef({ identifier })`; `resolveComposedInline(editor)`.
- Produces: `tryBracketTransform` with footnote precedence and deduplicated document-end definitions; composed `]` replay; a shared code-block/inline-code context guard for every inline structural transform.

- [ ] **Step 1: Add failing typed-footnote tests**

Add a `describe("footnote shortcut", ...)` section:

```ts
describe("footnote shortcut", () => {
  it("creates a reference and one matching definition at document end", () => {
    const editor = makeSchemaEditor();
    type(editor, "[^1]");

    const paragraph = editor.children[0] as any;
    expect(paragraph.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "footnote-ref", identifier: "1" }),
      ]),
    );
    expect(editor.children.at(-1)).toMatchObject({
      type: "footnote-def",
      identifier: "1",
      children: [{ text: "" }],
    });
  });

  it("keeps the caret after the inline reference", () => {
    const editor = makeSchemaEditor();
    type(editor, "[^1]");
    type(editor, "after");

    const children = (editor.children[0] as any).children;
    const refIndex = children.findIndex(
      (child: any) => child.type === "footnote-ref",
    );
    expect(refIndex).toBeGreaterThanOrEqual(0);
    expect(children.slice(refIndex + 1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "after" })]),
    );
  });

  it("reuses an existing matching definition", () => {
    const editor = makeSchemaEditor([
      { type: "paragraph", children: [{ text: "" }] },
      { type: "footnote-def", identifier: "1", children: [{ text: "body" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ]);
    Transforms.select(editor, { path: [0, 0], offset: 0 });
    type(editor, "[^1]");

    expect(
      editor.children.filter(
        (node: any) =>
          node.type === "footnote-def" && node.identifier === "1",
      ),
    ).toHaveLength(1);
    expect(editor.children[1]).toMatchObject({ children: [{ text: "body" }] });
  });

  it("multiple references share one definition", () => {
    const editor = makeSchemaEditor();
    type(editor, "[^same] [^same]");

    expect(
      editor.children.filter(
        (node: any) =>
          node.type === "footnote-def" && node.identifier === "same",
      ),
    ).toHaveLength(1);
  });

  it("leaves empty footnote and link labels literal", () => {
    const footnote = makeSchemaEditor();
    type(footnote, "[^]");
    expect(Node.string(footnote.children[0])).toBe("[^]");

    const link = makeSchemaEditor();
    type(link, "[]");
    expect(Node.string(link.children[0])).toBe("[]");
  });

  it("one undo removes both the reference shortcut and its new definition", () => {
    const editor = makeSchemaEditor();
    type(editor, "[^undo");
    editor.insertText("]");

    editor.undo();

    expect(Node.string(editor.children[0])).toBe("[^undo");
    expect(
      editor.children.some((node: any) => node.type === "footnote-def"),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Add failing code-context and composed-input tests**

Add these contracts:

```ts
it("does not run bracket shortcuts inside inline code", () => {
  const editor = makeSchemaEditor([
    { type: "paragraph", children: [{ text: "[^code", code: true }] },
  ]);
  editor.insertText("]");

  expect(Node.string(editor.children[0])).toBe("[^code]");
  expect(editor.children).toHaveLength(1);
});

it("does not run bracket shortcuts inside a code block", () => {
  const editor = makeSchemaEditor([
    { type: "code-block", language: null, children: [{ text: "[^code" }] },
  ]);
  editor.insertText("]");

  expect(Node.string(editor.children[0])).toBe("[^code]");
  expect(editor.children).toHaveLength(1);
});

it("[^id] delivered as one composed string creates a reference and definition", () => {
  const editor = makeSchemaEditor();
  editor.insertText("[^id]");

  expect((editor.children[0] as any).children).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "footnote-ref", identifier: "id" }),
    ]),
  );
  expect(editor.children.at(-1)).toMatchObject({
    type: "footnote-def",
    identifier: "id",
  });
});

it("[label] delivered as one composed string adds exactly one destination pair", () => {
  const editor = makeSchemaEditor();
  editor.insertText("[label]");

  expect(Node.string(editor.children[0])).toBe("[label]()");
});
```

The existing composed complete-link test remains the regression contract that `[label](url)` resolves directly instead of adding another `()`.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: footnote, code-context, and composed-`]` cases fail because Task 1 rejects `^` labels and `withAutoformat` does not replay `]`.

- [ ] **Step 4: Use schema factories and guard all inline transforms from code**

Add imports:

```ts
import type { CustomElement } from "#/editor/types";
import { makeFootnoteDef } from "#/editor/schema/elements/footnoteDef";
import { makeFootnoteRef } from "#/editor/schema/elements/footnoteRef";
```

Replace the current first guard in `tryInlineTransform` with:

```ts
if (isInCodeContext(editor)) return false;
```

Keep `isInCodeBlock`, then add:

```ts
function isInCodeContext(editor: Editor): boolean {
  if (isInCodeBlock(editor)) return true;
  return Editor.marks(editor)?.code === true;
}
```

- [ ] **Step 5: Add the footnote-first branch to `tryBracketTransform`**

Immediately after computing and validating `label`, branch before link continuation:

```ts
if (label.startsWith("^")) {
  const identifier = label.slice(1);
  if (identifier.trim().length === 0) return false;

  const hasDefinition = editor.children.some((node) => {
    if (!SlateElement.isElement(node)) return false;
    const element = node as CustomElement;
    return (
      element.type === "footnote-def" && element.identifier === identifier
    );
  });

  const rangeStart: Point = {
    path: info.path as any,
    offset: openBracketIdx,
  };
  const rangeEnd: Point = {
    path: info.path as any,
    offset: textBefore.length,
  };

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);
      Transforms.insertNodes(editor, makeFootnoteRef({ identifier }));
      Transforms.move(editor);
      const afterReference = editor.selection;

      if (!hasDefinition) {
        Transforms.insertNodes(editor, makeFootnoteDef({ identifier }), {
          at: [editor.children.length],
        });
      }
      if (afterReference) Transforms.select(editor, afterReference);
    });
  });
  return true;
}
```

Leave the Task 1 non-footnote `]()` branch directly after this code.

- [ ] **Step 6: Replay composed `]` exactly once**

In `withAutoformat.ts`, add `]`:

```ts
const INLINE_CLOSERS = new Set(["`", "~", "*", "_", ")", "]"]);
```

In `resolveComposedInline`, stop after a successful `]` transform because link-label continuation expands syntax instead of consuming all delimiters; another pass would re-read its newly inserted `]` and duplicate `()`:

```ts
if (tryInlineTransform(editor, ch)) {
  if (ch === "]") return;
  transformed = true;
  break;
}
```

Right-to-left scanning still resolves a complete composed `[label](url)` at `)` before it ever reaches `]`.

- [ ] **Step 7: Run focused tests and confirm green**

Run:

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: all autoformat tests pass, including typed/composed links, typed/composed footnotes, definition reuse, code guards, caret behavior, and undo.

- [ ] **Step 8: Commit the independently working footnote shortcut**

```bash
git add ui/src/editor/plugins/autoformat/inlineTransforms.ts ui/src/editor/plugins/autoformat/withAutoformat.ts ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
git commit -m "feat(editor): create typed footnote references"
```

---

### Task 3: Review, Smoke Test, and Verification Gates

**Files:**
- Review: `ui/src/editor/plugins/autoformat/inlineTransforms.ts`
- Review: `ui/src/editor/plugins/autoformat/withAutoformat.ts`
- Review: `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`
- No documentation or changelog file changes: the approved design is already committed, and the repository has no changelog convention.

**Interfaces:**
- Consumes: completed Task 1 and Task 2 behavior.
- Produces: browser-observed shortcut behavior and clean project verification gates.

- [ ] **Step 1: Review the combined implementation against the approved design**

Confirm each invariant directly in the changed code:

```text
] dispatch precedes ) dispatch
footnote branch precedes link-label continuation
makeFootnoteRef/makeFootnoteDef are used
matching top-level definitions are reused
consumed ) is deleted but excluded from url
code blocks and code marks return false before dispatch
composed ] returns after one successful expansion
no DOM key handler, dependency, serializer, or generic [] pairing was added
```

Reject and correct any deviation before continuing.

- [ ] **Step 2: Run the focused integration test as a smoke check**

```bash
bun --cwd ui run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: the file passes with zero failed tests.

- [ ] **Step 3: Start the application processes using the harness process manager**

Start the backend with application `cargo`, arguments `run -- serve`, readiness log `listening`, and the frontend with application `bun`, arguments `--cwd ui run dev -- --host 127.0.0.1`, readiness log `Local:`. Open the reported Vite URL in the browser.

Expected: both processes become ready and the workspace renders without a route error.

- [ ] **Step 4: Exercise both shortcuts in the real editor**

Create a temporary note named `scratch/bracket-shortcut-smoke.md`, then verify:

```text
Type [Example]                     → editor shows [Example]() with caret inside ()
Type https://example.com and )     → syntax becomes a rendered link; destination excludes )
Type [^smoke]                      → inline footnote chip appears
Inspect document end              → one empty smoke definition appears
Type a second [^smoke]             → no second smoke definition appears
Undo the second reference          → only that shortcut is reversed
```

Delete the temporary note after observation. Expected: every transition is visible in the running Slate editor and no literal delimiter residue remains after completed link/footnote conversion.

- [ ] **Step 5: Run mandatory typecheck**

```bash
bun --cwd ui run typecheck
```

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 6: Run mandatory lint**

```bash
bun --cwd ui run lint
```

Expected: exit 0 with no Biome errors.

- [ ] **Step 7: Run the complete UI test suite**

```bash
bun --cwd ui run test
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 8: Commit any formatter-only corrections, otherwise leave history unchanged**

Only if Steps 5–7 required source corrections:

```bash
git add ui/src/editor/plugins/autoformat/inlineTransforms.ts ui/src/editor/plugins/autoformat/withAutoformat.ts ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
git commit -m "fix(editor): satisfy bracket shortcut verification"
```

Expected: implementation commits remain focused; no unrelated working-tree files enter the commit.

- [ ] **Step 9: Complete branch integration**

After task-level implementation and two-stage reviews pass, use the repository's integration-branch workflow: merge the feature work into the detected integration branch, rerun the three mandatory gates there, and report the exact commit IDs plus browser observation. Do not leave a compatibility shim or unmerged worktree branch.
