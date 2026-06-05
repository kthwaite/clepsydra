# Markdown Paste Handler — Design

**Date:** 2026-06-05
**Status:** Approved (design)

## Problem

The Slate editor converts markdown markup *as you type* (the autoformat layer) but
does nothing special on **paste**. Pasting raw markdown (e.g. copied from a `.md`
file or another markdown editor) inserts it as literal plain text — `## Title`
stays as the literal characters instead of becoming a heading. We want pasted
markdown to be parsed and inserted as the corresponding Slate elements.

The machinery to convert markdown already exists: `mdastToSlate(markdown: string):
Descendant[]` (`ui/src/editor/convert/mdast-to-slate.ts`) is a pure function that
parses markdown (remark + GFM + wikilinks) into a Slate `Descendant[]` tree. It is
re-exported from the `#/editor/convert` barrel as `markdownToSlate`. The paste
handler reuses it.

## Decisions (from brainstorming)

- **Trigger:** always convert. Every external `text/plain` paste runs through
  `mdastToSlate`. Predictable and markdown-native (matches Obsidian/Notion). Accepted
  risk: incidental markdown characters in pasted prose (e.g. `1. ` at the start of a
  line) may transform.
- **HTML ignored:** when a clipboard carries both `text/html` and `text/plain`, the
  markdown path wins — we read only `text/plain` and never consult `text/html`. One
  code path, simplest mental model.
- **Internal copy/paste preserved:** copying *within* the editor sets
  `application/x-slate-fragment`; that always pastes as the original rich fragment,
  never markdown-reparsed.
- **Block metadata on paste:** reuse `mdastToSlate` with its defaults (which extract
  `^blockId` and `[key:: value]` property syntax). Importing a duplicate `^blockId`
  via paste is possible but unlikely; recorded as a known follow-up rather than
  handled in v1.

## Architecture

A new Slate plugin, `withMarkdownPaste`, overrides `editor.insertData`. It is the
idiomatic Slate seam for paste, keeps `SlateEditor.tsx` thin, reuses
`mdastToSlate` + `Transforms.insertFragment`, and is unit-testable without
`withReact`.

**New file:** `ui/src/editor/plugins/withMarkdownPaste.ts`

```ts
import { Editor, Element as SlateElement, Transforms } from "slate";
import { markdownToSlate } from "#/editor/convert";
import type { CustomElement } from "#/editor/types";

export function withMarkdownPaste(editor: Editor): Editor {
  const { insertData } = editor; // withReact's insertData

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

`isInCodeBlock` mirrors the identical guard in
`ui/src/editor/plugins/autoformat/inlineTransforms.ts` (kept local to avoid coupling
the two plugins; it is a few lines).

### Wiring

`ui/src/editor/SlateEditor.tsx` (the `useMemo` that builds the editor, currently
around lines 89–90):

```ts
withMarkdownPaste(
  withReact(
    withHistory(withAutoformat(withOutliner(withSchema(createEditor())))),
  ),
)
```

`withMarkdownPaste` must be the **outermost** wrapper so the `insertData` it captures
is `withReact`'s implementation (used as the fallback for internal fragments, files,
and code-block pastes).

## Behavior notes

- **Inline vs block is automatic.** `Transforms.insertFragment` merges the fragment's
  leading/trailing blocks into the insertion point: pasting `**bold** word` mid-
  sentence inserts inline marks into the current paragraph, while multi-block markdown
  splits the paragraph and inserts the blocks between. No special-casing required.
- **No autoformat interference.** Paste flows through `insertData` →
  `insertFragment`, never `insertText`, so the autoformat layer does not re-process
  pasted content.
- **`mdastToSlate` never returns empty.** It guarantees at least one block, so
  `insertFragment` always receives a valid fragment.

## Testing

`ui/src/editor/plugins/__tests__/withMarkdownPaste.test.ts`. Build the editor as
`withMarkdownPaste(withHistory(withSchema(createEditor())))` with a stubbed base
`insertData` (a spy), and a small fake `DataTransfer` helper:

```ts
function fakeData(parts: Record<string, string>): DataTransfer {
  return { getData: (type: string) => parts[type] ?? "" } as unknown as DataTransfer;
}
```

Cases:
- **MP-01:** pasting `## Title` (text/plain) into an empty paragraph produces a
  `heading` level-2 element; base `insertData` not called.
- **MP-02:** pasting multi-block markdown (`# H\n\n- a\n- b`) produces a heading
  followed by a bulleted list.
- **MP-03:** pasting inline markdown (`**bold**`) into the middle of an existing
  paragraph merges a bold-marked text node inline (no new block).
- **MP-04:** when `application/x-slate-fragment` is present, the override defers to
  base `insertData` (spy called once) and does not parse markdown.
- **MP-05:** with the selection inside a `code-block`, a `text/plain` paste defers to
  base `insertData` (literal paste), markdown not parsed.
- **MP-06:** empty / no `text/plain` defers to base `insertData`.

The selection-dependent cases (MP-03, MP-05) set `editor.selection` explicitly, as
the existing autoformat tests do.

## Out of scope (follow-ups)

- Deduplicating / stripping `^blockId` on paste to avoid block-id collisions.
- A separate "Paste as plain text" escape hatch.
- HTML-clipboard deserialization for rich web paste.
- Pasting images / files (continues to use `withReact`'s default `insertData`).
