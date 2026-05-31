# Editor Schema Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adding a new Slate element type a single self-contained file by moving classification, construction, rendering, normalization, and serialize-out into a per-element descriptor registry; eliminate `as any` from the editor element/transform paths; add the missing normalization invariants.

**Architecture:** A central `schema/` module. Each element type lives in one `schema/elements/*.tsx` file exporting its TS interface and an `ElementDescriptor` (`kind`, `create`, `render`, optional `normalize`, optional `toMdast`). A `withSchema` plugin derives `isInline`/`isVoid` from `kind` and dispatches `normalizeNode` by type; cross-node footnote rules live in `documentRules.ts`. `renderElement` and `slate-to-mdast` become thin dispatchers over the registry.

**Tech Stack:** React 19, Slate + slate-react + slate-history, TypeScript (strict), Vitest, mdast-util-* converters, Bun.

**Spec:** `docs/superpowers/specs/2026-05-31-editor-schema-refactor-design.md`

---

## File Structure

**Create:**
- `ui/src/editor/schema/descriptor.ts` — `ElementKind`, `ElementDescriptor`, `kindIsInline`/`kindIsVoid` helpers, `SerializeCtx`.
- `ui/src/editor/schema/registry.ts` — `REGISTRY` map + `getDescriptor(type)`.
- `ui/src/editor/schema/withSchema.ts` — plugin: derive `isInline`/`isVoid`, dispatch `normalizeNode`.
- `ui/src/editor/schema/documentRules.ts` — cross-node footnote uniqueness/dangling pass.
- `ui/src/editor/schema/types.ts` — `CustomElement` union assembled from element interfaces + `declare module "slate"` augmentation (moved from `editor/types.ts`).
- `ui/src/editor/schema/elements/{paragraph,heading,codeBlock,blockquote,list,thematicBreak,wikilink,link,blockRef,footnoteRef,footnoteDef}.tsx`
- Test files alongside: `schema/__tests__/classification.test.ts`, `schema/__tests__/factories.test.ts`, `schema/__tests__/normalize.test.ts`, `schema/__tests__/documentRules.test.ts`.

**Modify:**
- `ui/src/editor/types.ts` — re-export from `schema/types.ts` (keep import path stable for existing consumers).
- `ui/src/editor/SlateEditor.tsx:55-65` — plugin chain; `:154-398` — call sites use factories, drop `as any`.
- `ui/src/editor/elements/renderElement.tsx` — becomes registry dispatcher.
- `ui/src/editor/plugins/withOutliner.ts` — remove `normalizeNode` override (commands stay).
- `ui/src/editor/convert/slate-to-mdast.ts` — `convertElement` becomes a registry dispatcher; export `SerializeCtx` helpers.

**Delete:**
- `ui/src/editor/plugins/withLinks.ts`, `ui/src/editor/plugins/withWikilinks.ts` (+ no test files exist for them).

**Untouched:** `convert/mdast-to-slate.ts`, `elements/renderLeaf.tsx`, `decorate-code.ts`, autoformat plugins, the dedicated render components (`CodeBlockElement.tsx`, `WikilinkElement.tsx`, `BlockRefElement.tsx`, `LinkElement.tsx`, `FootnoteRefElement.tsx`) — descriptors point at them.

**Commands:** run from `ui/`. Test: `bun run test <path>` (Vitest). Typecheck: `bun run typecheck`.

---

## Phase 1 — Scaffold registry + classification (no behavior change)

### Task 1: Descriptor type and kind helpers

**Files:**
- Create: `ui/src/editor/schema/descriptor.ts`
- Test: `ui/src/editor/schema/__tests__/classification.test.ts`

- [ ] **Step 1: Write `descriptor.ts`**

```ts
import type { Editor, NodeEntry } from "slate";
import type { RenderElementProps } from "slate-react";
import type { BlockContent, PhrasingContent, RootContent } from "mdast";
import type { CustomElement, CustomText, ElementType } from "./types";

export type ElementKind = "block" | "inline" | "void-block" | "inline-void";

export function kindIsInline(kind: ElementKind): boolean {
  return kind === "inline" || kind === "inline-void";
}

export function kindIsVoid(kind: ElementKind): boolean {
  return kind === "void-block" || kind === "inline-void";
}

/** Recursive serialization helpers passed to each descriptor's toMdast. */
export interface SerializeCtx {
  inlineChildren(children: CustomElement["children"]): PhrasingContent[];
  blockChildren(children: CustomElement["children"]): BlockContent[];
  appendBlockMetadata(
    children: PhrasingContent[],
    element: { properties?: Record<string, string>; blockId?: string },
  ): void;
}

export interface ElementDescriptor<T extends CustomElement = CustomElement> {
  type: T["type"];
  kind: ElementKind;
  /** Build a fully-formed node (owns default/empty children). */
  create(props: CreateProps<T>): T;
  /** Render; receives the narrowed element. */
  render(props: RenderElementProps & { element: T }): JSX.Element;
  /** Return true if this rule claims the node (skip Slate's default). */
  normalize?(entry: NodeEntry<T>, editor: Editor): boolean;
  /** Serialize this node to an mdast node (serialize-out only). */
  toMdast?(node: T, ctx: SerializeCtx): RootContent;
}

/** create() input: the node minus type/children (children defaulted by the factory). */
export type CreateProps<T extends CustomElement> = Omit<T, "type" | "children"> &
  Partial<Pick<T, "children">>;

export type { CustomElement, CustomText, ElementType };
```

- [ ] **Step 2: Move the type union into `schema/types.ts`**

Create `ui/src/editor/schema/types.ts` by moving the contents of `ui/src/editor/types.ts` verbatim, then add an `ElementType` helper. The element interfaces are re-exported from here so element files can import them:

```ts
import type { BaseEditor, Descendant } from "slate";
import type { HistoryEditor } from "slate-history";
import type { ReactEditor } from "slate-react";

// (interfaces ParagraphElement … FootnoteDefElement unchanged — moved verbatim)

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

export type ElementType = CustomElement["type"];

export interface CustomText { /* unchanged */ }
export type CustomEditor = BaseEditor & ReactEditor & HistoryEditor;

declare module "slate" {
  interface CustomTypes {
    Editor: CustomEditor;
    Element: CustomElement;
    Text: CustomText;
  }
  interface BaseRange {
    token?: string;
  }
}
```

Then replace `ui/src/editor/types.ts` body with a re-export so existing imports keep working:

```ts
export * from "./schema/types";
```

- [ ] **Step 3: Run typecheck to confirm the move is clean**

Run: `bun run typecheck`
Expected: PASS (no consumers broke; `#/editor/types` still resolves).

- [ ] **Step 4: Commit**

```bash
git add ui/src/editor/schema/descriptor.ts ui/src/editor/schema/types.ts ui/src/editor/types.ts
git commit -m "refactor(editor): scaffold schema descriptor type + move element union"
```

### Task 2: Element files (classification only) + registry

**Files:**
- Create: all 11 `ui/src/editor/schema/elements/*.tsx`
- Create: `ui/src/editor/schema/registry.ts`

- [ ] **Step 1: Create each element file with type + kind + a temporary throwing render/create**

In phase 1 the descriptors only need `type` and `kind`; `create`/`render` are filled in phase 2. Use placeholders that throw so a missed wire-up fails loudly rather than silently. Example — `schema/elements/paragraph.tsx`:

```tsx
import type { ElementDescriptor } from "../descriptor";
import type { ParagraphElement } from "../types";

export const paragraphDescriptor: ElementDescriptor<ParagraphElement> = {
  type: "paragraph",
  kind: "block",
  create: () => {
    throw new Error("not implemented until phase 2");
  },
  render: () => {
    throw new Error("not implemented until phase 2");
  },
};
```

Create the remaining files with these `(type, kind)` pairs (same shape, throwing create/render):

| file | type | kind |
|---|---|---|
| `heading.tsx` | `heading` | `block` |
| `codeBlock.tsx` | `code-block` | `block` |
| `blockquote.tsx` | `blockquote` | `block` |
| `thematicBreak.tsx` | `thematic-break` | `void-block` |
| `link.tsx` | `link` | `inline` |
| `wikilink.tsx` | `wikilink` | `inline-void` |
| `blockRef.tsx` | `block-ref` | `inline-void` |
| `footnoteRef.tsx` | `footnote-ref` | `inline-void` |
| `footnoteDef.tsx` | `footnote-def` | `block` |

For lists, put all three in `schema/elements/list.tsx`, exporting `bulletedListDescriptor` (`bulleted-list`, `block`), `numberedListDescriptor` (`numbered-list`, `block`), `listItemDescriptor` (`list-item`, `block`).

- [ ] **Step 2: Create `registry.ts`**

```ts
import type { ElementDescriptor } from "./descriptor";
import type { ElementType } from "./types";
import { paragraphDescriptor } from "./elements/paragraph";
import { headingDescriptor } from "./elements/heading";
import { codeBlockDescriptor } from "./elements/codeBlock";
import { blockquoteDescriptor } from "./elements/blockquote";
import {
  bulletedListDescriptor,
  listItemDescriptor,
  numberedListDescriptor,
} from "./elements/list";
import { thematicBreakDescriptor } from "./elements/thematicBreak";
import { wikilinkDescriptor } from "./elements/wikilink";
import { linkDescriptor } from "./elements/link";
import { blockRefDescriptor } from "./elements/blockRef";
import { footnoteRefDescriptor } from "./elements/footnoteRef";
import { footnoteDefDescriptor } from "./elements/footnoteDef";

const ALL: ElementDescriptor[] = [
  paragraphDescriptor,
  headingDescriptor,
  codeBlockDescriptor,
  blockquoteDescriptor,
  bulletedListDescriptor,
  numberedListDescriptor,
  listItemDescriptor,
  thematicBreakDescriptor,
  wikilinkDescriptor,
  linkDescriptor,
  blockRefDescriptor,
  footnoteRefDescriptor,
  footnoteDefDescriptor,
];

export const REGISTRY = Object.fromEntries(
  ALL.map((d) => [d.type, d]),
) as Record<ElementType, ElementDescriptor>;

export function getDescriptor(type: ElementType): ElementDescriptor | undefined {
  return REGISTRY[type];
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/editor/schema/elements ui/src/editor/schema/registry.ts
git commit -m "refactor(editor): element descriptor files + registry (classification only)"
```

### Task 3: `withSchema` plugin deriving isInline/isVoid + parity test

**Files:**
- Create: `ui/src/editor/schema/withSchema.ts`
- Test: `ui/src/editor/schema/__tests__/classification.test.ts`

- [ ] **Step 1: Write the failing parity test**

This asserts the registry reproduces the exact classification the two old plugins produced.

```ts
import { createEditor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";
import type { ElementType } from "../types";

const INLINE = new Set<ElementType>(["wikilink", "block-ref", "footnote-ref", "link"]);
const VOID = new Set<ElementType>(["wikilink", "block-ref", "footnote-ref", "thematic-break"]);

const ALL_TYPES: ElementType[] = [
  "paragraph", "heading", "code-block", "blockquote", "bulleted-list",
  "numbered-list", "list-item", "thematic-break", "wikilink", "link",
  "block-ref", "footnote-ref", "footnote-def",
];

describe("withSchema classification", () => {
  const editor = withSchema(createEditor());

  it.each(ALL_TYPES)("isInline(%s) matches legacy", (type) => {
    expect(editor.isInline({ type, children: [{ text: "" }] } as never)).toBe(
      INLINE.has(type),
    );
  });

  it.each(ALL_TYPES)("isVoid(%s) matches legacy", (type) => {
    expect(editor.isVoid({ type, children: [{ text: "" }] } as never)).toBe(
      VOID.has(type),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/editor/schema/__tests__/classification.test.ts`
Expected: FAIL — `withSchema` is not defined.

- [ ] **Step 3: Write `withSchema.ts` (classification only for now)**

```ts
import { type Editor, Element as SlateElement } from "slate";
import { kindIsInline, kindIsVoid } from "./descriptor";
import { getDescriptor } from "./registry";

export function withSchema(editor: Editor): Editor {
  const { isInline, isVoid } = editor;

  editor.isInline = (element) => {
    if (SlateElement.isElement(element)) {
      const desc = getDescriptor(element.type);
      if (desc) return kindIsInline(desc.kind);
    }
    return isInline(element);
  };

  editor.isVoid = (element) => {
    if (SlateElement.isElement(element)) {
      const desc = getDescriptor(element.type);
      if (desc) return kindIsVoid(desc.kind);
    }
    return isVoid(element);
  };

  return editor;
}
```

Note: `kindIsInline`/`kindIsVoid` come straight from `descriptor.ts`; `getDescriptor` from `registry.ts`. No re-export needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/editor/schema/__tests__/classification.test.ts`
Expected: PASS (all 26 cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/withSchema.ts ui/src/editor/schema/registry.ts ui/src/editor/schema/__tests__/classification.test.ts
git commit -m "feat(editor): withSchema derives isInline/isVoid from registry"
```

### Task 4: Swap plugin chain; delete old plugins

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx:55-65`
- Delete: `ui/src/editor/plugins/withLinks.ts`, `ui/src/editor/plugins/withWikilinks.ts`

- [ ] **Step 1: Replace the chain and imports**

In `SlateEditor.tsx`, remove the `withLinks` and `withWikilinks` imports (lines 25, 34) and add `import { withSchema } from "./schema/withSchema";`. Replace lines 55-65:

```tsx
  const editor = useMemo(
    () => withReact(withHistory(withAutoformat(withOutliner(withSchema(createEditor()))))),
    [],
  );
```

- [ ] **Step 2: Delete the obsolete plugins**

```bash
git rm ui/src/editor/plugins/withLinks.ts ui/src/editor/plugins/withWikilinks.ts
```

- [ ] **Step 3: Typecheck + full editor test suite (regression guard)**

Run: `bun run typecheck && bun run test src/editor`
Expected: PASS. `withSchema` now provides the inline/void behavior previously split across the deleted plugins; existing wikilink/blockref/footnote tests still pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/editor/SlateEditor.tsx
git commit -m "refactor(editor): wire withSchema, remove withLinks/withWikilinks"
```

---

## Phase 2 — Render dispatch + factories + kill `as any`

### Task 5: Fill `render` + `create` in every descriptor

**Files:**
- Modify: all `ui/src/editor/schema/elements/*.tsx`

- [ ] **Step 1: Fill `paragraph.tsx` (simplest pattern)**

```tsx
import type { ElementDescriptor } from "../descriptor";
import type { ParagraphElement } from "../types";

export const paragraphDescriptor: ElementDescriptor<ParagraphElement> = {
  type: "paragraph",
  kind: "block",
  create: ({ children = [{ text: "" }], ...rest } = {} as never) => ({
    type: "paragraph",
    children,
    ...rest,
  }),
  render: ({ attributes, children }) => <p {...attributes}>{children}</p>,
};

export const makeParagraph = paragraphDescriptor.create;
```

- [ ] **Step 2: Fill `heading.tsx` (carries the level→class map from current renderElement.tsx:18-34)**

```tsx
import type { ElementDescriptor } from "../descriptor";
import type { HeadingElement } from "../types";

const HEADING_CLASSES: Record<number, string> = {
  1: "mb-4 mt-8 font-sans text-[28px] font-black tracking-[-0.01em] text-ink",
  2: "mb-3 mt-8 border-t border-rule pt-3 font-sans text-[20px] font-bold text-ink",
  3: "mb-2 mt-6 border-t border-rule-soft pt-2 font-sans text-[16px] font-semibold text-ink",
  4: "mb-2 mt-4 font-sans text-[14px] font-semibold text-ink",
  5: "mb-1 mt-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2",
  6: "mb-1 mt-3 font-sans text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute",
};

export const headingDescriptor: ElementDescriptor<HeadingElement> = {
  type: "heading",
  kind: "block",
  create: ({ level, children = [{ text: "" }], ...rest }) => ({
    type: "heading",
    level,
    children,
    ...rest,
  }),
  render: ({ attributes, children, element }) => {
    const Tag = `h${element.level}` as const;
    return (
      <Tag {...attributes} className={HEADING_CLASSES[element.level]}>
        {children}
      </Tag>
    );
  },
};

export const makeHeading = headingDescriptor.create;
```

- [ ] **Step 3: Fill the remaining descriptors, lifting the exact JSX from `renderElement.tsx`**

Each `render` is copied verbatim from the matching arm of the current `elements/renderElement.tsx` (lines 36-105) and the dedicated components stay where they are. Specifics:

- `codeBlock.tsx`: `render: (props) => <CodeBlockElement {...props} element={props.element} />` (import from `#/editor/elements/CodeBlockElement`); `create: ({ language, children = [{ text: "" }], ...rest }) => ({ type: "code-block", language, children, ...rest })`.
- `blockquote.tsx`: render the `<blockquote className="my-4 border-l-2 …">` from line 40-47; `create` defaults `children` to `[{ text: "" }]`.
- `thematicBreak.tsx`: render the `<div {...attributes} contentEditable={false}><hr …/>{children}</div>` from line 71-76; `create: () => ({ type: "thematic-break", children: [{ text: "" }] })`.
- `wikilink.tsx`: `render: (props) => <WikilinkElement {...props} element={props.element} />`; `create: ({ target, alias }) => ({ type: "wikilink", target, alias, children: [{ text: "" }] })`. Export `makeWikilink`.
- `link.tsx`: `render: (props) => <LinkElement {...props} element={props.element} />`; `create: ({ url, children = [{ text: "" }] }) => ({ type: "link", url, children })`.
- `blockRef.tsx`: `render: (props) => <BlockRefElement {...props} element={props.element} />`; `create: ({ blockId }) => ({ type: "block-ref", blockId, children: [{ text: "" }] })`. Export `makeBlockRef`.
- `footnoteRef.tsx`: `render: (props) => <FootnoteRefElement {...props} element={props.element} />`; `create: ({ identifier }) => ({ type: "footnote-ref", identifier, children: [{ text: "" }] })`.
- `footnoteDef.tsx`: render the `<div className="cl-footnote-def …">` block from line 91-101; `create: ({ identifier, children = [{ text: "" }] }) => ({ type: "footnote-def", identifier, children })`.
- `list.tsx`: `bulletedListDescriptor.render` = the `<ul className="list-['▸'] …">` (line 50-54); `numberedListDescriptor.render` = the `<ol className="list-decimal pl-6">` (line 57-61); `listItemDescriptor.render` = the existing `ListItem` component (move the `ListItem` function from `renderElement.tsx:113-157` into `list.tsx`). `create` factories: lists default `children: []`; list-item defaults `children: [{ type: "paragraph", children: [{ text: "" }] }]`. Export `makeListItem`, `makeBulletedList`, `makeNumberedList`.

**Every descriptor exports a `makeX` alias** for its `create` (e.g. `export const makeCodeBlock = codeBlockDescriptor.create;`, `export const makeThematicBreak = thematicBreakDescriptor.create;`, `export const makeBlockquote = …`, `export const makeFootnoteRef = …`, `export const makeFootnoteDef = …`, `export const makeLink = …`). Phase 2 Task 7 imports these aliases.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/elements
git commit -m "feat(editor): descriptors own render + create factories"
```

### Task 6: `renderElement` becomes a dispatcher

**Files:**
- Modify: `ui/src/editor/elements/renderElement.tsx`

- [ ] **Step 1: Replace the whole file with a registry dispatch**

```tsx
import type { RenderElementProps } from "slate-react";
import { getDescriptor } from "#/editor/schema/registry";

export function renderElement(props: RenderElementProps) {
  const desc = getDescriptor(props.element.type);
  if (desc) {
    return desc.render(props as never);
  }
  // Unknown type — fall back to a plain paragraph so the doc still renders.
  return <p {...props.attributes}>{props.children}</p>;
}
```

The `ListItem` helper has moved to `list.tsx` (Task 5 Step 3); the dedicated `*Element` component imports are gone from this file.

- [ ] **Step 2: Run render + full editor suite**

Run: `bun run test src/editor`
Expected: PASS — existing render/round-trip tests still green; output identical because the JSX was lifted verbatim.

- [ ] **Step 3: Commit**

```bash
git add ui/src/editor/elements/renderElement.tsx
git commit -m "refactor(editor): renderElement dispatches through registry"
```

### Task 7: Swap construction call sites to factories; remove `as any`

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx:154-398`

- [ ] **Step 1: Replace inline-node literals with factories**

In `insertWikilink` (line 171) use `makeWikilink({ target: page.title ?? page.canonical_name })`; in `doInsertBlockRef` (line 197) use `makeBlockRef({ blockId })`. Import `makeWikilink`, `makeBlockRef` from their element files. In `executeSlashCommand`, replace each `{ … } as any` literal with the matching factory or a typed `Partial<CustomElement>`:

```tsx
// heading arm (was line 274)
Transforms.setNodes(editor, { type: "heading", level } satisfies Partial<HeadingElement>, { at: entry[1] });
// code arm (was line 353-357)
Transforms.insertNodes(editor, makeCodeBlock({}), { at: blockPath });
// divider arm (was line 374-379)
Transforms.insertNodes(editor, makeThematicBreak(), { at: blockPath });
Transforms.insertNodes(editor, makeParagraph(), { at: nextPath });
// list wrap arms — setNodes to list-item then wrap:
Transforms.setNodes(editor, { type: "list-item" } satisfies Partial<ListItemElement>, { at: blockPath });
Transforms.wrapNodes(editor, makeParagraph(), { at: blockPath, match: (n) => Text.isText(n) });
Transforms.wrapNodes(editor, makeBulletedList(), { at: blockPath });
```

Add the factory imports. Replace the `(block as any).type` reads (lines 136, 271, 286, etc.) with `SlateElement.isElement(block) && block.type === "paragraph"` — `Element.isElement` narrows to `CustomElement`, so `.type` needs no cast.

- [ ] **Step 2: Grep to confirm no `as any` remains in the file**

Run: `grep -n "as any" ui/src/editor/SlateEditor.tsx`
Expected: no output.

- [ ] **Step 3: Typecheck + editor suite**

Run: `bun run typecheck && bun run test src/editor`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/editor/SlateEditor.tsx
git commit -m "refactor(editor): construct nodes via factories, drop as-any casts"
```

---

## Phase 3 — Move list normalization into the registry (behavior-preserving)

### Task 8: Relocate list-item normalize from withOutliner to the list descriptor

**Files:**
- Modify: `ui/src/editor/schema/withSchema.ts`, `ui/src/editor/schema/elements/list.tsx`, `ui/src/editor/plugins/withOutliner.ts`

- [ ] **Step 1: Add normalize dispatch to `withSchema`**

Extend `withSchema` to override `normalizeNode` (keep the classification overrides from Task 3):

```ts
import { Editor, Element as SlateElement, type NodeEntry } from "slate";
// …
export function withSchema(editor: Editor): Editor {
  const { isInline, isVoid, normalizeNode } = editor;
  // (isInline / isVoid overrides unchanged)

  editor.normalizeNode = (entry, options) => {
    const [node] = entry;
    if (SlateElement.isElement(node)) {
      const desc = getDescriptor(node.type);
      if (desc?.normalize?.(entry as NodeEntry<never>, editor)) return;
    }
    normalizeNode(entry, options);
  };

  return editor;
}
```

- [ ] **Step 2: Move the list-item rule into `listItemDescriptor.normalize`**

Lift the logic from `withOutliner.ts:26-39` verbatim into the descriptor:

```ts
listItemDescriptor.normalize = (entry, editor) => {
  const [node, path] = entry;
  if (node.children.length === 0) {
    Transforms.insertNodes(
      editor,
      makeParagraph(),
      { at: [...path, 0] },
    );
    return true; // claimed: made a fix
  }
  return true; // claim list-item to suppress default block-flattening (current behavior)
};
```

(Define it inline in the descriptor object rather than post-assignment; shown separately here for clarity. Import `Transforms` and `makeParagraph`.)

- [ ] **Step 3: Remove the `normalizeNode` override from `withOutliner`**

In `withOutliner.ts`, delete the `normalizeNode` assignment (lines 20-42) and remove `normalizeNode` from the destructure (line 18). Keep `deleteBackward` and all command exports unchanged.

- [ ] **Step 4: Run the outliner regression suite**

Run: `bun run test src/editor/plugins/__tests__/withOutliner.test.ts`
Expected: PASS — nesting/mixed-content behavior unchanged; the rule simply runs from a different plugin.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/withSchema.ts ui/src/editor/schema/elements/list.tsx ui/src/editor/plugins/withOutliner.ts
git commit -m "refactor(editor): list-item normalization moves into registry"
```

---

## Phase 4 — New normalization invariants (behavior-changing, strict TDD)

### Task 9: List-structure invariant

**Files:**
- Modify: `ui/src/editor/schema/elements/list.tsx`
- Test: `ui/src/editor/schema/__tests__/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createEditor, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";

describe("list structure invariant", () => {
  it("wraps a stray paragraph child of a list into a list-item", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "bulleted-list", children: [{ type: "paragraph", children: [{ text: "x" }] }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const list = editor.children[0] as { children: { type: string }[] };
    expect(list.children.every((c) => c.type === "list-item")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/editor/schema/__tests__/normalize.test.ts -t "list structure"`
Expected: FAIL — stray paragraph remains a direct child.

- [ ] **Step 3: Add the rule to `bulletedListDescriptor.normalize` and `numberedListDescriptor.normalize`**

```ts
function normalizeList(entry: NodeEntry, editor: Editor): boolean {
  const [node, path] = entry;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!(SlateElement.isElement(child) && child.type === "list-item")) {
      // Wrap the stray child in a list-item at its position.
      Transforms.wrapNodes(editor, makeListItem({ children: [] }), {
        at: [...path, i],
      });
      return true; // one fix per pass
    }
  }
  return false; // nothing to fix → fall through to defaults
}
```

Assign `normalize: normalizeList` on both list descriptors.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `bun run test src/editor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/elements/list.tsx ui/src/editor/schema/__tests__/normalize.test.ts
git commit -m "feat(editor): enforce list children are list-items"
```

### Task 10: Code-block purity invariant

**Files:**
- Modify: `ui/src/editor/schema/elements/codeBlock.tsx`
- Test: `ui/src/editor/schema/__tests__/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("code-block purity invariant", () => {
  it("strips marks from code-block text children", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "code-block", children: [{ text: "x", bold: true }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const cb = editor.children[0] as { children: Record<string, unknown>[] };
    expect(cb.children[0].bold).toBeUndefined();
  });

  it("unwraps an inline element inside a code-block to plain text", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "code-block",
        children: [{ type: "wikilink", target: "X", children: [{ text: "" }] }],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const cb = editor.children[0] as { children: { type?: string }[] };
    expect(cb.children.every((c) => c.type === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/editor/schema/__tests__/normalize.test.ts -t "code-block purity"`
Expected: FAIL.

- [ ] **Step 3: Implement `codeBlockDescriptor.normalize`**

```ts
const CODE_MARKS = ["bold", "italic", "underline", "code", "strikethrough"] as const;

codeBlockDescriptor.normalize = (entry, editor) => {
  const [node, path] = entry;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (SlateElement.isElement(child)) {
      // Replace an element child with its plain text.
      Transforms.removeNodes(editor, { at: [...path, i] });
      Transforms.insertNodes(
        editor,
        { text: Node.string(child) },
        { at: [...path, i] },
      );
      return true;
    }
    const marks = CODE_MARKS.filter((m) => (child as Record<string, unknown>)[m]);
    if (marks.length > 0) {
      for (const m of marks) Transforms.unsetNodes(editor, m, { at: [...path, i] });
      return true;
    }
  }
  return false;
};
```

(Import `Node`, `Transforms`, `Element as SlateElement`.)

- [ ] **Step 4: Run to verify pass + full suite**

Run: `bun run test src/editor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/elements/codeBlock.tsx ui/src/editor/schema/__tests__/normalize.test.ts
git commit -m "feat(editor): enforce code-block plain-text purity"
```

### Task 11: Void-inline integrity invariant

**Files:**
- Modify: `ui/src/editor/schema/elements/wikilink.tsx`, `blockRef.tsx`, `footnoteRef.tsx`
- Test: `ui/src/editor/schema/__tests__/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("void-inline integrity invariant", () => {
  it("drops a wikilink with an empty target, unwrapping to its text child", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "a" },
          { type: "wikilink", target: "", children: [{ text: "" }] },
          { text: "b" },
        ],
      },
    ] as never;
    Editor.normalize(editor, { force: true });
    const para = editor.children[0] as { children: { type?: string }[] };
    expect(para.children.some((c) => c.type === "wikilink")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/editor/schema/__tests__/normalize.test.ts -t "void-inline integrity"`
Expected: FAIL.

- [ ] **Step 3: Implement a shared rule and assign it to the three void descriptors**

In `schema/elements/voidInline.ts` (new helper file):

```ts
import { Element as SlateElement, type Editor, type NodeEntry, Transforms } from "slate";

/** keyField: the descriptor field that must be non-empty (target | blockId | identifier). */
export function makeVoidIntegrityRule(keyField: string) {
  return (entry: NodeEntry, editor: Editor): boolean => {
    const [node, path] = entry;
    if (!SlateElement.isElement(node)) return false;
    const key = (node as Record<string, unknown>)[keyField];
    if (typeof key !== "string" || key.length === 0) {
      // Malformed void — remove it (its only child is empty text).
      Transforms.removeNodes(editor, { at: path });
      return true;
    }
    return false;
  };
}
```

Assign: `wikilinkDescriptor.normalize = makeVoidIntegrityRule("target")`, `blockRefDescriptor.normalize = makeVoidIntegrityRule("blockId")`, `footnoteRefDescriptor.normalize = makeVoidIntegrityRule("identifier")`.

- [ ] **Step 4: Run to verify pass + full suite**

Run: `bun run test src/editor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/schema/elements/voidInline.ts ui/src/editor/schema/elements/wikilink.tsx ui/src/editor/schema/elements/blockRef.tsx ui/src/editor/schema/elements/footnoteRef.tsx ui/src/editor/schema/__tests__/normalize.test.ts
git commit -m "feat(editor): enforce void-inline integrity (non-empty key)"
```

### Task 12: Cross-node footnote rules (document-level)

**Files:**
- Create: `ui/src/editor/schema/documentRules.ts`
- Modify: `ui/src/editor/schema/withSchema.ts`
- Test: `ui/src/editor/schema/__tests__/documentRules.test.ts`

- [ ] **Step 1: Write the failing test (uniqueness — the destructive rule)**

```ts
import { createEditor, Editor, Node } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../withSchema";

describe("footnote document rules", () => {
  it("renames a duplicate footnote-def identifier to keep ids unique", () => {
    const editor = withSchema(createEditor());
    editor.children = [
      { type: "footnote-def", identifier: "1", children: [{ text: "a" }] },
      { type: "footnote-def", identifier: "1", children: [{ text: "b" }] },
    ] as never;
    Editor.normalize(editor, { force: true });
    const ids = editor.children.map((n) => (n as { identifier: string }).identifier);
    expect(new Set(ids).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test src/editor/schema/__tests__/documentRules.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `documentRules.ts`**

```ts
import { type Editor, Element as SlateElement, Transforms } from "slate";

/** Runs once per top-level normalization. Returns true if it made a fix. */
export function runDocumentRules(editor: Editor): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < editor.children.length; i++) {
    const node = editor.children[i];
    if (SlateElement.isElement(node) && node.type === "footnote-def") {
      const id = node.identifier;
      if (seen.has(id)) {
        let next = `${id}-2`;
        let n = 2;
        while (seen.has(next)) next = `${id}-${++n}`;
        Transforms.setNodes(editor, { identifier: next }, { at: [i] });
        return true; // one fix per pass
      }
      seen.add(id);
    }
  }
  return false;
}
```

Dangling `footnote-ref` detection is **non-destructive** (surfaced via decoration in a later UI pass, per spec) and intentionally not handled here.

- [ ] **Step 4: Wire it into `withSchema` at the editor root**

In `withSchema`'s `normalizeNode`, before the element dispatch:

```ts
import { runDocumentRules } from "./documentRules";
// …
editor.normalizeNode = (entry, options) => {
  const [node] = entry;
  if (Editor.isEditor(node)) {
    if (runDocumentRules(editor)) return;
  }
  if (SlateElement.isElement(node)) {
    const desc = getDescriptor(node.type);
    if (desc?.normalize?.(entry as NodeEntry<never>, editor)) return;
  }
  normalizeNode(entry, options);
};
```

(Add `Editor` to the slate import.)

- [ ] **Step 5: Run to verify pass + full suite**

Run: `bun run test src/editor`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/schema/documentRules.ts ui/src/editor/schema/withSchema.ts ui/src/editor/schema/__tests__/documentRules.test.ts
git commit -m "feat(editor): dedupe footnote-def identifiers at document level"
```

---

## Phase 5 — Serialize-out into descriptors

### Task 13: `toMdast` on every descriptor + dispatcher

**Files:**
- Modify: `ui/src/editor/convert/slate-to-mdast.ts`, all `schema/elements/*.tsx`
- Test: `ui/src/editor/convert/__tests__/round-trip.test.ts` (existing — must stay green)

- [ ] **Step 1: Export the recursive helpers from `slate-to-mdast.ts` as a `SerializeCtx`**

Keep `convertInlineChildren`, `convertBlockChildren`, `appendBlockMetadataSuffix` as-is but assemble them into a ctx object passed to descriptors:

```ts
import { getDescriptor } from "#/editor/schema/registry";
import type { SerializeCtx } from "#/editor/schema/descriptor";

const ctx: SerializeCtx = {
  inlineChildren: convertInlineChildren,
  blockChildren: convertBlockChildren,
  appendBlockMetadata: appendBlockMetadataSuffix,
};
```

- [ ] **Step 2: Replace the `convertElement` switch with a dispatcher**

```ts
function convertElement(node: CustomElement): RootContent {
  const desc = getDescriptor(node.type);
  if (desc?.toMdast) return desc.toMdast(node as never, ctx);
  // Fallback: serialize children as a paragraph (matches old default arm).
  return { type: "paragraph", children: convertInlineChildren(node.children) };
}
```

`convertInlineChildren`'s inline `switch` (lines 129-167) stays — inline serialization for `link`/`wikilink`/`block-ref`/`footnote-ref` inside phrasing content is a separate concern from block-level `toMdast` and is not part of this move (documented in spec: serialize-out dispatcher is block-level).

- [ ] **Step 3: Add `toMdast` to each descriptor, lifting the exact arm from the old switch**

Copy each `case` body from the old `convertElement` (lines 175-315) into the matching descriptor's `toMdast`, using `ctx.inlineChildren`/`ctx.blockChildren`/`ctx.appendBlockMetadata` in place of the bare helper calls. Example — `paragraph.tsx`:

```ts
import type { Paragraph } from "mdast";

paragraphDescriptor.toMdast = (node, ctx) => {
  const children = ctx.inlineChildren(node.children);
  ctx.appendBlockMetadata(children, node);
  return { type: "paragraph", children } satisfies Paragraph;
};
```

Repeat for `heading`, `code-block`, `blockquote`, `bulleted-list`, `numbered-list`, `thematic-break`, `list-item`, `link`, `wikilink`, `block-ref`, `footnote-ref`, `footnote-def` — each lifting its existing arm verbatim. `convertListItem` and its metadata helpers stay in `slate-to-mdast.ts` and are reachable via `ctx.blockChildren`; the list descriptors call them through ctx.

- [ ] **Step 4: Run the round-trip suite (the regression guard for this phase)**

Run: `bun run test src/editor/convert`
Expected: PASS — output byte-identical because every arm was lifted verbatim.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/convert/slate-to-mdast.ts ui/src/editor/schema/elements
git commit -m "refactor(editor): slate→mdast dispatches toMdast through registry"
```

### Task 14: Final verification

- [ ] **Step 1: Full typecheck, lint, test**

Run: `bun run typecheck && bun run lint && bun run test src/editor`
Expected: all PASS.

- [ ] **Step 2: Confirm zero `as any` across the editor element/transform paths**

Run: `grep -rn "as any" ui/src/editor/SlateEditor.tsx ui/src/editor/elements ui/src/editor/schema`
Expected: no output (decoration `token` ranges live elsewhere and are untouched).

- [ ] **Step 3: Confirm the "add an element type" surface**

Manually verify a new type needs only: one `schema/elements/*.tsx`, one union line in `schema/types.ts`, one entry in `schema/registry.ts`, and (if it deserializes) one branch in `convert/mdast-to-slate.ts`. Note this in the commit body.

```bash
git commit --allow-empty -m "chore(editor): schema refactor complete — element types now single-file"
```
