# P4 — Footnotes Round-Trip + Hover Preview (WU-4c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop dropping markdown footnotes: round-trip `[^id]` references and `[^id]: …` definitions through the Slate editor (parse → edit → serialize, no data loss), render refs as hoverable superscript markers, and render definitions in a footnotes region.

**Architecture:** Both serialization ends already handle footnote *mdast* nodes — `mdastToSlate` parses with `remarkGfm` (emits `footnoteReference`/`footnoteDefinition`) and `slateToMdast` stringifies with `gfmToMarkdown()` (handles them). The only gap is the **Slate-layer bridge**: add `footnote-ref` (inline void) and `footnote-def` (block) element types, un-drop them in mdast→slate, add the reverse cases in slate→mdast, register inline/void, and render them. The ref's hover preview resolves the matching definition *locally* from the editor tree.

**Tech Stack:** React 19, Slate (inline void elements, `useSlateStatic`, `Node.string`), remark/mdast (`remarkGfm`, `gfmToMarkdown` — already wired), Vitest.

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-4** footnotes (#132).

## Verified facts (current code)

- `mdast-to-slate.ts:57 mdastToSlate(markdown)` uses `remarkGfm` → footnote nodes are produced; the block switch lists `footnoteDefinition` under "intentionally skip → null", and the phrasing switch returns `[]` for `footnoteReference`. **These are the only drop points.**
- `slate-to-mdast.ts:402 slateToMdast(nodes)` calls `toMarkdown(root, { extensions: [gfmToMarkdown(), …] })` — `gfmToMarkdown()` **already stringifies footnote mdast nodes**, so NO stringify-extension change is needed; we only add Slate-element → mdast-node cases.
- `withWikilinks.ts` configures `isInline`/`isVoid` for `wikilink`/`block-ref`/`thematic-break` — the pattern to extend for `footnote-ref`.
- `CustomElement` union (`types.ts`) lists the element types; round-trip tests live in `convert/__tests__/round-trip.test.ts`.
- `mdast-to-slate.ts` and `renderElement.tsx` are in the user's WIP; `types.ts`, `withWikilinks.ts`, `slate-to-mdast.ts`, `round-trip.test.ts` are clean.

## Decisions (resolved)

- **`footnote-ref`** = inline **void** `{ type: "footnote-ref", identifier: string, children: [{text:""}] }`. **`footnote-def`** = **block** `{ type: "footnote-def", identifier: string, children: Descendant[] }`.
- **Hover preview is local, not `CLink`.** Footnote definitions live in the same document, not in a page — so the ref's hover resolves the matching `footnote-def` by `identifier` from the editor tree (`useSlateStatic` + `Node.string`) and shows a lightweight tooltip. (CLink is page-backed and doesn't fit.)
- Use the mdast `identifier` for both `identifier` and `label` on stringify (gfm uses `identifier`).

## ⚠️ WIP + git rules

Do NOT execute until the user's WIP is committed (stable base), AND after **P2** (which also edits `renderElement.tsx`) so this builds on P2's committed version. Each task stages ONLY its own files; NEVER `git add -A`/`.`/`ui/`. Do not touch the WIP `footnotes.test.ts` (that's the unrelated read-only footnote parser). Run `bun` from `ui/`. String anchors match the current snapshot; re-read and adapt if drifted.

## File structure

- **Create:** `ui/src/editor/elements/FootnoteRefElement.tsx` (superscript marker + local hover).
- **Modify:** `ui/src/editor/types.ts` (two element types + union); `ui/src/editor/plugins/withWikilinks.ts` (inline/void); `ui/src/editor/convert/mdast-to-slate.ts` (un-drop); `ui/src/editor/convert/slate-to-mdast.ts` (reverse cases); `ui/src/editor/elements/renderElement.tsx` (render both); `ui/src/editor/convert/__tests__/round-trip.test.ts` (tests).

---

## Task 1: Element types + inline/void registration

**Files:**
- Modify: `ui/src/editor/types.ts`, `ui/src/editor/plugins/withWikilinks.ts`

- [ ] **Step 1: Add the two element interfaces + union members**

In `ui/src/editor/types.ts`, after the `BlockRefElement` interface add:
```tsx
export interface FootnoteRefElement {
  type: "footnote-ref";
  identifier: string;
  children: CustomText[];
}

export interface FootnoteDefElement {
  type: "footnote-def";
  identifier: string;
  children: Descendant[];
}
```
and add both to the `CustomElement` union:
```tsx
export type CustomElement =
  | ParagraphElement
  | HeadingElement
  | CodeBlockElement
  | BlockquoteElement
  | BulletedListElement
  | NumberedListElement
  | ListItemElement
  | ThematicBreakElement
  | WikilinkElement
  | LinkElement
  | BlockRefElement
  | FootnoteRefElement
  | FootnoteDefElement;
```

- [ ] **Step 2: Register `footnote-ref` as inline + void**

In `ui/src/editor/plugins/withWikilinks.ts`, extend both predicates. Replace:
```tsx
  editor.isInline = (element) => {
    return SlateElement.isElement(element) &&
      (element.type === "wikilink" || element.type === "block-ref")
      ? true
      : isInline(element);
  };

  editor.isVoid = (element) => {
    if (SlateElement.isElement(element)) {
      if (
        element.type === "wikilink" ||
        element.type === "block-ref" ||
        element.type === "thematic-break"
      ) {
        return true;
      }
    }
    return isVoid(element);
  };
```
with:
```tsx
  editor.isInline = (element) => {
    return SlateElement.isElement(element) &&
      (element.type === "wikilink" ||
        element.type === "block-ref" ||
        element.type === "footnote-ref")
      ? true
      : isInline(element);
  };

  editor.isVoid = (element) => {
    if (SlateElement.isElement(element)) {
      if (
        element.type === "wikilink" ||
        element.type === "block-ref" ||
        element.type === "footnote-ref" ||
        element.type === "thematic-break"
      ) {
        return true;
      }
    }
    return isVoid(element);
  };
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd ui && bun run typecheck` → clean.
```bash
git add ui/src/editor/types.ts ui/src/editor/plugins/withWikilinks.ts
git commit -m "feat(editor): footnote element types + inline/void registration"
```

---

## Task 2: Footnote serialization round-trip (TDD)

**Files:**
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`, `ui/src/editor/convert/slate-to-mdast.ts`
- Test: `ui/src/editor/convert/__tests__/round-trip.test.ts`

- [ ] **Step 1: Write the failing round-trip tests**

Append to `ui/src/editor/convert/__tests__/round-trip.test.ts` (match the file's existing import of `markdownToSlate`/`slateToMarkdown` from `../index` — adjust the import path/names to whatever the file already uses):
```ts
describe("footnotes round-trip", () => {
  it("parses a footnote reference into an inline footnote-ref and a footnote-def block", () => {
    const slate = markdownToSlate("A claim.[^1]\n\n[^1]: The source.\n");
    const json = JSON.stringify(slate);
    expect(json).toContain('"type":"footnote-ref"');
    expect(json).toContain('"identifier":"1"');
    expect(json).toContain('"type":"footnote-def"');
  });

  it("round-trips a footnote ref + definition without dropping it", () => {
    const md = "A claim.[^1]\n\n[^1]: The source.\n";
    const back = slateToMarkdown(markdownToSlate(md));
    expect(back).toContain("[^1]");
    expect(back).toContain("[^1]: The source.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/editor/convert/__tests__/round-trip.test.ts`
Expected: FAIL — footnotes are currently dropped (`type":"footnote-ref"` absent, `[^1]` missing from output).

- [ ] **Step 3: Un-drop footnotes in mdast→slate**

In `ui/src/editor/convert/mdast-to-slate.ts`, remove `footnoteDefinition` from the skip list:
```tsx
    // Node types we intentionally skip
    case "definition":
    case "footnoteDefinition":
    case "yaml":
    case "table":
      return null;
```
→
```tsx
    case "footnoteDefinition":
      return {
        type: "footnote-def",
        identifier: (node as { identifier: string }).identifier,
        children: convertChildren(node.children as RootContent[]),
      };

    // Node types we intentionally skip
    case "definition":
    case "yaml":
    case "table":
      return null;
```
And replace the phrasing `footnoteReference` case:
```tsx
    case "footnoteReference":
      // Not supported in current schema
      return [];
```
→
```tsx
    case "footnoteReference":
      return [
        {
          type: "footnote-ref",
          identifier: (node as { identifier: string }).identifier,
          children: [{ text: "" }],
        },
      ];
```
(If TS complains the phrasing switch's return type doesn't include element nodes, mirror however the `wikiLink` phrasing case is typed — the converter already returns inline element nodes for wikilinks, so the return type already admits `CustomElement`. Use the same cast/shape the wikilink case uses.)

- [ ] **Step 4: Add the reverse cases in slate→mdast**

In `ui/src/editor/convert/slate-to-mdast.ts`:

In `convertInlineChildren` (the inline switch with `link`/`wikilink`/`block-ref`), add:
```tsx
        case "footnote-ref": {
          out.push({
            type: "footnoteReference",
            identifier: node.identifier,
            label: node.identifier,
          } as unknown as PhrasingContent);
          break;
        }
```
(Match the surrounding `case` style — the file pushes onto an `out` array. Use the same accumulation pattern and the `as unknown as PhrasingContent` cast the `block-ref` case uses if the mdast type isn't in the local union.)

In `convertElement` (the block switch), add a case:
```tsx
    case "footnote-def": {
      return {
        type: "footnoteDefinition",
        identifier: node.identifier,
        label: node.identifier,
        children: node.children.map((c) =>
          convertElement(c as CustomElement),
        ),
      } as unknown as RootContent;
    }
```
(Mirror how `blockquote`/`list` cases convert block children. If `convertElement` is the right child-converter in this file, use it; otherwise use whatever block-child converter the file already uses for `blockquote`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && bun run test src/editor/convert/__tests__/round-trip.test.ts`
Expected: PASS. If the stringified definition differs in whitespace (e.g. trailing newline), adjust the test's `toContain` substrings to match `gfmToMarkdown`'s actual output — do NOT loosen them to the point of not asserting the footnote survives.

- [ ] **Step 6: Typecheck, lint, build + commit**

Run: `cd ui && bun run typecheck && bun run lint && bun run build` → all pass.
```bash
git add ui/src/editor/convert/mdast-to-slate.ts ui/src/editor/convert/slate-to-mdast.ts ui/src/editor/convert/__tests__/round-trip.test.ts
git commit -m "feat(editor): round-trip footnotes through Slate (no data loss)"
```

---

## Task 3: Render footnote refs (hover) and definitions

**Files:**
- Create: `ui/src/editor/elements/FootnoteRefElement.tsx`
- Modify: `ui/src/editor/elements/renderElement.tsx`

- [ ] **Step 1: FootnoteRefElement — superscript marker + local hover preview**

Create `ui/src/editor/elements/FootnoteRefElement.tsx`:
```tsx
import { useState } from "react";
import { Node } from "slate";
import { type RenderElementProps, useSlateStatic } from "slate-react";
import type { FootnoteRefElement as FootnoteRefElementType } from "#/editor/types";

type Props = RenderElementProps & { element: FootnoteRefElementType };

export function FootnoteRefElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const [hover, setHover] = useState(false);

  // Resolve the matching footnote-def's text locally from the editor tree.
  let preview = "";
  for (const [node] of Node.elements(editor)) {
    if (
      // biome-ignore lint/suspicious/noExplicitAny: narrow by shape
      (node as any).type === "footnote-def" &&
      // biome-ignore lint/suspicious/noExplicitAny: narrow by shape
      (node as any).identifier === element.identifier
    ) {
      preview = Node.string(node);
      break;
    }
  }

  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="relative inline cursor-default align-super text-[0.75em] text-accent"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        [{element.identifier}]
        {hover && preview && (
          <span className="absolute left-0 top-full z-40 mt-1 block w-[280px] cursor-default border border-ink bg-paper px-2 py-1.5 text-left align-baseline text-[11px] not-italic leading-[1.4] text-ink shadow-[3px_3px_0_0_var(--color-ink)]">
            {preview.slice(0, 240)}
            {preview.length > 240 ? "…" : ""}
          </span>
        )}
      </span>
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Wire both footnote elements into renderElement**

In `ui/src/editor/elements/renderElement.tsx`, add the import:
```tsx
import { FootnoteRefElement } from "./FootnoteRefElement";
```
and add two cases to the `switch (element.type)` (e.g. just before the `paragraph`/`default` case):
```tsx
    case "footnote-ref":
      return <FootnoteRefElement {...props} element={element} />;

    case "footnote-def":
      return (
        <div
          {...attributes}
          className="cl-footnote-def mt-1 flex gap-2 border-t border-rule-soft pt-1 text-[0.85em] text-ink-mute"
        >
          <span contentEditable={false} className="cl-mono text-accent select-none">
            [{element.identifier}]
          </span>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      );
```
(`element.identifier` is available because `element.type` is narrowed to `footnote-def` in this case.)

- [ ] **Step 3: Typecheck, lint, build + commit**

Run: `cd ui && bun run typecheck && bun run lint && bun run build` → all pass.
```bash
git add ui/src/editor/elements/FootnoteRefElement.tsx ui/src/editor/elements/renderElement.tsx
git commit -m "feat(editor): render footnote refs (hover) and definitions"
```

---

## Task 4: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green (round-trip tests added).

- [ ] **Step 2: Manual smoke (dev server)**

Run `cd ui && bun run dev`, open/create a folio containing `Some text.[^1]` and `[^1]: A definition.`, and confirm:
- The reference renders as a superscript `[1]` marker in accent; hovering it shows the definition text in a small tooltip.
- The definition renders in a footnotes region (top-rule + `[1]` marker + text).
- Editing then saving preserves the footnote (reopen the folio — the `[^1]`/`[^1]: …` markdown survives the round-trip, no data loss).

- [ ] **Step 3: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-4 footnote item | Task |
|---|---|
| Un-drop `footnoteReference`/`footnoteDefinition` (mdast→slate) | Task 2 Step 3 |
| Reverse slate→mdast (no data loss) | Task 2 Step 4 + round-trip test |
| Footnote element types + inline/void | Task 1 |
| Reference render + hover preview | Task 3 (FootnoteRefElement, local resolve) |
| Definition render (footnotes region) | Task 3 Step 2 |
