# Markdown Paste Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Slate editor parse pasted markdown into the corresponding Slate elements instead of inserting it as literal text.

**Architecture:** A new `withMarkdownPaste` plugin overrides `editor.insertData`: it defers internal Slate fragments, code-block pastes, and non-text pastes to the captured base `insertData` (from `withReact`), and for plain-text pastes it runs the existing `markdownToSlate` converter and inserts the result via `Transforms.insertFragment`. The plugin is wired as the outermost wrapper in the editor's plugin chain.

**Tech Stack:** TypeScript, Slate (`slate`, `slate-react`, `slate-history`), the project's `markdownToSlate` (remark + GFM + wikilinks) converter, Vitest, Bun. All commands run from `ui/`.

**Note:** `Transforms.insertFragment(editor, markdownToSlate(text))` was empirically verified to: replace an empty paragraph with a pasted block (e.g. `## Title` → an H2), insert multi-block markdown correctly, and merge inline markdown (`**bold**`) into the current paragraph. No empty-block special-casing is needed.

---

## File Structure

- **Create** `ui/src/editor/plugins/withMarkdownPaste.ts` — the plugin: `insertData` override + local `isInCodeBlock` guard.
- **Create** `ui/src/editor/plugins/__tests__/withMarkdownPaste.test.ts` — unit tests (MP-01…MP-06).
- **Modify** `ui/src/editor/SlateEditor.tsx` — import `withMarkdownPaste` and wrap it around `withReact(...)` in the editor `useMemo`.

---

## Task 1: The `withMarkdownPaste` plugin

**Files:**
- Create: `ui/src/editor/plugins/withMarkdownPaste.ts`
- Test: `ui/src/editor/plugins/__tests__/withMarkdownPaste.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `ui/src/editor/plugins/__tests__/withMarkdownPaste.test.ts`:

```ts
import { createEditor, type Editor } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it, vi } from "vitest";
import { withSchema } from "#/editor/schema/withSchema";
import { withMarkdownPaste } from "../withMarkdownPaste";

/**
 * Build a test editor with a stubbed base insertData (the slot withReact would
 * normally fill). withMarkdownPaste captures this stub as its fallback.
 */
function makeEditor() {
  const editor = withSchema(withHistory(createEditor()));
  const base = vi.fn();
  editor.insertData = base;
  withMarkdownPaste(editor);
  return { editor, base };
}

function fakeData(parts: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => parts[type] ?? "",
  } as unknown as DataTransfer;
}

function emptyParagraph(editor: Editor) {
  editor.children = [{ type: "paragraph", children: [{ text: "" }] }];
  editor.selection = {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: 0 },
  };
}

describe("withMarkdownPaste", () => {
  it("MP-01: pasting `## Title` produces a heading", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({ "text/plain": "## Title" }));
    const node = editor.children[0] as any;
    expect(node.type).toBe("heading");
    expect(node.level).toBe(2);
    expect(node.children[0].text).toBe("Title");
    expect(base).not.toHaveBeenCalled();
  });

  it("MP-02: pasting multi-block markdown produces a heading + bulleted list", () => {
    const { editor } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({ "text/plain": "# H\n\n- a\n- b" }));
    expect((editor.children[0] as any).type).toBe("heading");
    const list = editor.children[1] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children).toHaveLength(2);
  });

  it("MP-03: pasting `**bold**` mid-paragraph merges inline", () => {
    const { editor } = makeEditor();
    editor.children = [{ type: "paragraph", children: [{ text: "ab" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 1 },
    };
    editor.insertData(fakeData({ "text/plain": "**bold**" }));
    expect(editor.children).toHaveLength(1);
    const para = editor.children[0] as any;
    expect(para.type).toBe("paragraph");
    const bold = para.children.find((c: any) => c.bold === true);
    expect(bold.text).toBe("bold");
  });

  it("MP-04: an internal slate fragment defers to base insertData", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(
      fakeData({
        "application/x-slate-fragment": "encoded-fragment",
        "text/plain": "## Title",
      }),
    );
    expect(base).toHaveBeenCalledTimes(1);
    // markdown path did NOT run: still a single empty paragraph
    expect((editor.children[0] as any).type).toBe("paragraph");
  });

  it("MP-05: pasting inside a code-block defers to base (literal paste)", () => {
    const { editor, base } = makeEditor();
    editor.children = [{ type: "code-block", children: [{ text: "" }] }];
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    };
    editor.insertData(fakeData({ "text/plain": "## Title" }));
    expect(base).toHaveBeenCalledTimes(1);
    expect((editor.children[0] as any).type).toBe("code-block");
  });

  it("MP-06: a paste with no text/plain defers to base", () => {
    const { editor, base } = makeEditor();
    emptyParagraph(editor);
    editor.insertData(fakeData({}));
    expect(base).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && bun run vitest run src/editor/plugins/__tests__/withMarkdownPaste.test.ts`
Expected: FAIL — cannot resolve `../withMarkdownPaste` (module does not exist yet).

- [ ] **Step 3: Implement the plugin**

Create `ui/src/editor/plugins/withMarkdownPaste.ts`:

```ts
import { Editor, Element as SlateElement, Transforms } from "slate";
import { markdownToSlate } from "#/editor/convert";
import type { CustomElement } from "#/editor/types";

/**
 * Parse pasted markdown into Slate elements.
 *
 * Overrides insertData: internal Slate fragments, code-block pastes, and
 * non-text pastes defer to the base (withReact) insertData; plain-text pastes
 * are converted via markdownToSlate and inserted as a fragment.
 */
export function withMarkdownPaste(editor: Editor): Editor {
  const { insertData } = editor;

  editor.insertData = (data: DataTransfer) => {
    // 1. Internal copy/paste — never markdown-reparse our own fragments.
    if (data.getData("application/x-slate-fragment")) {
      insertData(data);
      return;
    }
    // 2. Inside a code-block — paste literally (it's code, not markdown).
    if (isInCodeBlock(editor)) {
      insertData(data);
      return;
    }
    // 3. Plain text → markdown → Slate fragment.
    const text = data.getData("text/plain");
    if (text) {
      Transforms.insertFragment(editor, markdownToSlate(text));
      return;
    }
    // 4. Files / anything else → default behavior.
    insertData(data);
  };

  return editor;
}

function isInCodeBlock(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection) return false;
  const [match] = Editor.nodes(editor, {
    at: selection,
    match: (n) =>
      SlateElement.isElement(n) &&
      !Editor.isEditor(n) &&
      (n as CustomElement).type === "code-block",
  });
  return !!match;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && bun run vitest run src/editor/plugins/__tests__/withMarkdownPaste.test.ts`
Expected: PASS — all six cases (MP-01 … MP-06) green.

- [ ] **Step 5: Typecheck and format**

Run: `cd ui && bun run typecheck && bun run format`
Expected: no type errors; Biome clean. (If `format` touches `ui/src/routeTree.gen.ts`, leave it unstaged — it is auto-generated.)

- [ ] **Step 6: Commit**

Stage ONLY the two files by explicit path (NEVER `git add -A` — this repo has pre-existing untracked files that must stay untracked):

```bash
git add ui/src/editor/plugins/withMarkdownPaste.ts ui/src/editor/plugins/__tests__/withMarkdownPaste.test.ts
git commit -m "feat(editor): add withMarkdownPaste plugin"
```

---

## Task 2: Wire the plugin into the editor

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx`

- [ ] **Step 1: Add the import**

In `ui/src/editor/SlateEditor.tsx`, add this import alongside the other `./plugins/...` imports (near the `withAutoformat` import, ~line 24):

```ts
import { withMarkdownPaste } from "./plugins/withMarkdownPaste";
```

- [ ] **Step 2: Wrap the plugin chain**

Find the editor construction in the `useMemo` (around lines 63–64):

```ts
      withReact(
        withHistory(withAutoformat(withOutliner(withSchema(createEditor())))),
```

Wrap it so `withMarkdownPaste` is the OUTERMOST plugin (so the `insertData` it captures is `withReact`'s). The surrounding `useMemo` already returns this expression — only the wrapping changes:

```ts
      withMarkdownPaste(
        withReact(
          withHistory(withAutoformat(withOutliner(withSchema(createEditor())))),
        ),
      ),
```

Make sure the parentheses balance with the existing closing of the `useMemo` return. Run typecheck (next step) to confirm.

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: no type errors. (`withMarkdownPaste(editor: Editor): Editor` composes cleanly with the `ReactEditor` returned by `withReact` — it returns the same editor object, only adding the `insertData` override.)

- [ ] **Step 4: Run the full editor test suite**

Run: `cd ui && bun run vitest run src/editor`
Expected: PASS — existing editor tests plus the new `withMarkdownPaste` tests, no regressions.

- [ ] **Step 5: Format and commit**

Run: `cd ui && bun run format`
Then stage ONLY the one file by explicit path (leave `ui/src/routeTree.gen.ts` unstaged if format touches it):

```bash
git add ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): enable markdown paste in the page editor"
```

---

## Task 3: Final verification

- [ ] **Step 1: Full UI test suite**

Run: `cd ui && bun run vitest run`
Expected: PASS — no regressions across the whole UI suite.

- [ ] **Step 2: Typecheck and lint**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: typecheck clean; lint reports no errors (a pre-existing Biome schema-version "info" is acceptable).

- [ ] **Step 3: Manual smoke (recommended)**

Run: `cd ui && bun run dev`, open a page in the editor, and:
- Copy this markdown from a plain-text source (e.g. a terminal or `.md` file) and paste into an empty line:
  ```
  ## Heading

  - one
  - two

  Some **bold** and `code`.
  ```
  Expect a real H2, a bulleted list, and a paragraph with bold + inline code.
- Paste `**bold**` into the middle of an existing word — expect inline bold, not a new block.
- Click into a code block and paste `## Heading` — expect the literal text `## Heading`, not a heading.
- Select a few rendered blocks in the editor, copy, and paste elsewhere — expect the rich content to paste unchanged (internal fragment path), not be re-parsed.

---

## Notes for the implementer

- **Why `withMarkdownPaste` must be outermost:** `withReact` defines `insertData`. Capturing it as the fallback requires `withMarkdownPaste` to run after `withReact`, i.e. wrap its result.
- **No autoformat interaction:** paste flows through `insertData` → `insertFragment`, never `insertText`, so the autoformat layer does not re-process pasted content.
- **Known follow-up (out of scope):** pasted markdown containing a `^blockId` will import that id verbatim (potential block-id collision). Accepted for v1; see the spec's "Out of scope".
- **`markdownToSlate`** is the `#/editor/convert` barrel's alias for `mdastToSlate`; it always returns at least one block, so `insertFragment` always gets a valid fragment.
