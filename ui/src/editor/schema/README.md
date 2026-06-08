# Editor schema — adding a new element

The Slate document schema is **registry-driven**: every element type is described
once by an `ElementDescriptor`, and the editor derives all of its behaviour
(inline/void classification, rendering, per-node normalization, markdown
serialization) from that descriptor. There is no central `switch` to keep in
sync — `renderElement`, `withSchema`, and `slate-to-mdast` are all dispatchers
that look the descriptor up by `type`.

Adding an element is therefore mostly **one new file plus one registry line**.
Deserialization (markdown → Slate) is the one direction that is *not* yet
registry-driven and needs a hand-written branch.

## The descriptor contract

Defined in [`descriptor.ts`](./descriptor.ts):

```ts
interface ElementDescriptor<T extends CustomElement = CustomElement> {
  type: T["type"];          // the element's discriminant string
  kind: ElementKind;        // "block" | "inline" | "void-block" | "inline-void"
  create(props): T;         // factory — owns default/empty children
  render(props): JSX;       // receives the narrowed RenderElementProps
  normalize?(entry, editor): boolean;  // per-node rule; true = "I handled it"
  toMdast?(node, ctx): RootContent;    // serialize OUT to markdown
}
```

- **`kind`** is the single source of truth for `editor.isInline` / `editor.isVoid`.
  `withSchema` derives them via `kindIsInline(kind)` and `kindIsVoid(kind)` — you
  never touch `isInline`/`isVoid` directly.
  - `block` — a normal block (paragraph, heading, blockquote, list…).
  - `inline` — flows inside a paragraph with editable text children (`link`).
  - `void-block` — block with no editable text (`thematic-break`).
  - `inline-void` — atomic inline token (`wikilink`, `block-ref`, `footnote-ref`).
- **`normalize`** returns `true` when it has claimed the node, which **stops**
  Slate's default normalization for that pass. Return `false` to fall through.
  Return `true` for at most **one** fix per call and let Slate re-run the pass.
- **`toMdast`** is optional. Without it, the element serializes as a paragraph of
  its children (the `convertElement` fallback in `slate-to-mdast.ts`).

## Step-by-step

### 1. Declare the type — `schema/types.ts`

Add the element interface, then add it to the `CustomElement` union (this single
line is what makes `ElementType` and every dispatcher aware of it):

```ts
export interface CalloutElement {
  type: "callout";
  variant: "note" | "warning";
  blockId?: string;
  properties?: Record<string, string>;
  children: Descendant[];
}

export type CustomElement =
  | ParagraphElement
  // …
  | CalloutElement;   // ← add here
```

Conventions:
- Block elements that participate in block metadata carry optional `blockId?` and
  `properties?`.
- Inline-void elements use `children: CustomText[]` and, by Slate invariant, must
  always be created with `children: [{ text: "" }]`.

### 2. Author the descriptor — `schema/elements/<name>.tsx`

One file per element. Export the descriptor and a `make<Name>` factory (the
factory is just `descriptor.create`, re-exported for ergonomic node construction
in transforms, tests, and stories).

```tsx
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { CalloutElement } from "../types";

export const calloutDescriptor: ElementDescriptor<CalloutElement> = {
  type: "callout",
  kind: "block",
  create: ({ variant, children = [{ text: "" }], ...rest }: CreateProps<CalloutElement>) => ({
    type: "callout",
    variant,
    children,
    ...rest,
  }),
  render: ({ attributes, children, element }) => (
    <aside {...attributes} className={element.variant === "warning" ? "…" : "…"}>
      {children}
    </aside>
  ),
  // optional:
  // normalize: (entry, editor) => { … return true if claimed },
  toMdast: (node, ctx) => ({
    type: "blockquote",
    children: ctx.blockChildren(node.children),
  }),
};

export const makeCallout = calloutDescriptor.create;
```

Notes on each piece:
- **`create`** owns sensible defaults. Even when a field is unused at runtime the
  typed signature still requires the props object, so factories are called as
  `makeThematicBreak({})`.
- **`render`** receives `RenderElementProps` already narrowed to your element type.
  Spread `{...attributes}` onto the DOM node Slate manages. For void content, mark
  the non-editable parts `contentEditable={false}`. Styling lives inline as
  Tailwind classes on the rendered node — there is no separate stylesheet.
- **`toMdast`** receives a `SerializeCtx` with recursive helpers:
  - `ctx.inlineChildren(children)` → `PhrasingContent[]`
  - `ctx.blockChildren(children)` → `BlockContent[]`
  - `ctx.appendBlockMetadata(children, node)` → appends `^blockId` / `[key:: value]`
  - `ctx.listItem(node)` → `ListItem`

### 3. Register it — `schema/registry.ts`

Import the descriptor and add it to the `ALL` array. That is the only wiring
needed for rendering, classification, and serialization-out:

```ts
import { calloutDescriptor } from "./elements/callout";

const ALL: ElementDescriptor[] = [
  // …
  calloutDescriptor,
];
```

### 4. Deserialize from markdown (only if it has a markdown form) — `convert/mdast-to-slate.ts`

This is the **one** non-registry-driven direction. Add a branch to the relevant
dispatcher:
- **block** elements → `convertBlockNode` (the `switch (node.type)` at the top).
- **inline** elements → `convertPhrasingNode`.

Build the Slate node with your `make<Name>` factory so the canonical shape is
guaranteed. If the element has no markdown representation (it only ever exists
in-editor), skip this step.

### 5. Cross-node invariants (rare) — `schema/documentRules.ts`

Per-node rules belong in the descriptor's `normalize`. Rules that span *multiple*
nodes (e.g. "footnote-def identifiers must be unique across the document") go in
`runDocumentRules`, which `withSchema` runs once per editor-root normalization
pass. Same contract: one fix per pass, return `true` when you changed something.

### 6. Add a Storybook story — `schema/elements.stories.tsx`

Add one `export const` rendering a representative node through the shared
read-only harness so the element has visual coverage. See the existing stories
for the pattern (inline elements are wrapped via `inlineInParagraph`). Every
registry element is expected to have at least one story.

### 7. Tests

- `schema/__tests__/normalize.test.ts` — exercise any `normalize` rule.
- `schema/__tests__/classification.test.ts` — confirm inline/void classification.
- `convert/__tests__/round-trip.test.ts` — if the element serializes, assert
  markdown → Slate → markdown is stable.

## Kind-specific gotchas

- **Inline / inline-void**: a Slate inline cannot be a direct child of the editor
  root — it must live inside a block (usually a paragraph) flanked by text nodes,
  e.g. `paragraph: [{text:""}, <inline/>, {text:""}]`. Void inlines additionally
  carry their own `children: [{ text: "" }]`.
- **Void integrity**: for inline-void tokens keyed by a required string field
  (`target`, `blockId`, `identifier`), use `makeVoidIntegrityRule("<field>")`
  from [`elements/voidInline.ts`](./elements/voidInline.ts) as the `normalize`
  rule — it removes a malformed token without disturbing surrounding text.
- **`list-item` canonical shape** is `list-item > paragraph > text`. Its
  `normalize` always returns `true` to suppress Slate's default block-flattening,
  so any transform that produces list items must emit that exact nesting.

## Mental model

```
                 ┌────────────────────────┐
   type string → │  REGISTRY (registry.ts)│ ← ElementDescriptor per type
                 └───────────┬────────────┘
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
  renderElement        withSchema            slate-to-mdast
  (elements/)      isInline / isVoid /        convertElement →
   dispatch         normalizeNode             descriptor.toMdast
                    dispatch

  mdast-to-slate  ← hand-written dispatch (NOT registry-driven)
```

Adding a type touches: **1 interface + 1 union line** (`types.ts`), **1 element
file** (`elements/`), **1 registry entry** (`registry.ts`), and — only if it
round-trips through markdown — **1 deserialize branch** (`mdast-to-slate.ts`).
