# Editor Schema Refactor — Registry-Driven Element Model

**Date:** 2026-05-31
**Status:** Design — pending implementation plan
**Area:** `ui/src/editor/`

## Problem

The Slate custom schema is correct but scattered. Knowledge about a single
element type is spread across at least four files:

- **Shape/types** — `editor/types.ts` (the `CustomElement` discriminated union).
- **Classification** — `isInline`/`isVoid` split across `plugins/withWikilinks.ts`
  and `plugins/withLinks.ts`.
- **Structural normalization** — `plugins/withOutliner.ts` (`normalizeNode` for
  list-items only; no guards for other types).
- **Rendering** — `elements/renderElement.tsx` (one `switch` arm per type).
- **Construction** — inline node literals built ad hoc in `SlateEditor.tsx`,
  cast with `as any` at every `Transforms` boundary.
- **Serialization** — `convert/slate-to-mdast.ts` and `convert/mdast-to-slate.ts`
  (per-type switches, ~1000 lines).

Consequences:

- Adding an element type means editing 5–6 files with no single source of truth.
- `as any` casts at the transform layer defeat the discriminated union — a
  malformed node (wrong field, missing child) is not caught at compile time.
- No `normalizeNode` guards exist for inline voids, code-block purity, or
  footnote integrity; those invariants are enforced only at construction time
  and can drift (e.g. on paste).

## Goal

Make **adding a new element type as close to a single self-contained file as
possible**, while tightening type safety and adding the missing normalization
invariants. This is the explicit top priority: optimize for ease of extension.

## Approach: central per-element descriptor registry

Each element type is described once, in one file, by an `ElementDescriptor`
that co-locates its classification, factory, renderer, normalization rule, and
(serialize-out) mdast mapping. Editor plugins and the renderer become thin
dispatchers over the registry.

### Descriptor model

```ts
// schema/descriptor.ts
type ElementKind = "block" | "inline" | "void-block" | "inline-void";

interface ElementDescriptor<T extends CustomElement = CustomElement> {
  type: T["type"];
  kind: ElementKind;                                       // isInline/isVoid derived
  create(props: CreateProps<T>): T;                        // typed factory
  render(props: RenderElementProps & { element: T }): JSX.Element;
  normalize?(entry: NodeEntry<T>, editor: Editor): boolean; // true = claimed, skip default
  toMdast?(node: T, ctx: SerializeCtx): MdastNode;          // serialize-out only
}
```

`isInline`/`isVoid` are **derived, never hand-written**:

- `isInline = kind === "inline" || kind === "inline-void"`
- `isVoid   = kind === "void-block" || kind === "inline-void"`

Current classification this must reproduce:

| type | kind |
|---|---|
| paragraph, heading, code-block, blockquote, bulleted-list, numbered-list, list-item, footnote-def | `block` |
| thematic-break | `void-block` |
| link | `inline` |
| wikilink, block-ref, footnote-ref | `inline-void` |

### File layout

```
ui/src/editor/schema/
  descriptor.ts        ElementDescriptor type + kind→isInline/isVoid helpers
  registry.ts          REGISTRY: Record<ElementType, ElementDescriptor>; getDescriptor(type)
  withSchema.ts        plugin: derives isInline/isVoid; dispatches normalizeNode
  documentRules.ts     cross-node rules (footnote uniqueness / dangling refs)
  types.ts             CustomElement union (from element interfaces) + module augmentation
  elements/
    paragraph.tsx  heading.tsx  codeBlock.tsx  blockquote.tsx
    list.tsx       (bulleted-list + numbered-list + list-item — coupled, one file)
    thematicBreak.tsx  wikilink.tsx  link.tsx  blockRef.tsx
    footnoteRef.tsx    footnoteDef.tsx
```

- Each `elements/*.tsx` exports its **interface**, its **descriptor**, and
  references its existing render component (`CodeBlockElement`,
  `WikilinkElement`, …) which stay in `editor/elements/` — the descriptor points
  at them rather than relocating them.
- `types.ts` assembles `CustomElement` from the element interfaces and holds the
  single `declare module "slate"` augmentation.
- `registry.ts` collects the descriptors.
- No import cycle: `descriptor.ts` is generic and imports no concrete element.

### Adding a new element type (the target workflow)

1. Create `schema/elements/foo.tsx` — interface + descriptor (`kind`, `create`,
   `render`, optional `normalize`, optional `toMdast`).
2. Add `FooElement` to the `CustomElement` union in `schema/types.ts`.
3. Register the descriptor in `schema/registry.ts`.
4. If it has a markdown deserialization, add **one** branch to
   `convert/mdast-to-slate.ts` (see Serialization — the deserializer stays
   keyed on the mdast vocabulary).

The TS union must still be enumerated (a `CustomTypes` requirement), but all
*behavior* lives in the one element file.

## Normalization

`withSchema` owns the single `normalizeNode` override and dispatches by type:

```ts
editor.normalizeNode = (entry, options) => {
  const [node, path] = entry;
  if (Editor.isEditor(node)) {
    if (runDocumentRules(editor)) return;          // cross-node footnote pass
  }
  if (Element.isElement(node)) {
    const desc = getDescriptor(node.type);
    if (desc?.normalize?.(entry, editor)) return;  // claimed → Slate re-runs
  }
  normalizeNode(entry, options);                   // fall through to base
};
```

**Contract:** `normalize` returns `true` when it claims the node — either it made
a fix (Slate re-runs the multi-pass loop) or it deliberately suppresses the
default (as list-item does today to preserve mixed content). Returning
`false`/absent falls through to Slate's defaults. Each rule fixes **one** thing
then returns.

### Invariants

| Invariant | Lives in | Rule |
|---|---|---|
| List structure | `list.tsx` | Preserve current behavior: list-item ensures ≥1 child, claims the node to prevent block-flattening. Add: `bulleted/numbered-list` children that are not `list-item` get wrapped (inline/text) or lifted (blocks). |
| Code-block purity | `codeBlock.tsx` | Children must be plain text only. Strip marks / unwrap inline or element children that slip in (e.g. via paste). Matches the `CustomText[]` typing. |
| Void-inline integrity | `wikilink.tsx`, `blockRef.tsx`, `footnoteRef.tsx` | Enforce exactly one empty text child. If `target`/`identifier` is empty, unwrap the void to its text (drop the malformed node) rather than leave a broken void. |
| Footnote identifier rules | `documentRules.ts` | Cross-node. Run only when normalizing the editor root (`path.length === 0`), single pass: dedupe `footnote-def` identifiers; detect `footnote-ref` with no matching def. |

**Footnote dangling-ref handling is non-destructive:** a ref with no matching
def is flagged (decoration/derived state), not mutated away. Confirm exact
surfacing during implementation; default is a visual flag, no data change.

**Performance:** dispatch is an O(1) registry lookup per node. The cross-node
footnote pass runs once per top-level normalization at the root, not as a deep
scan per node.

## Construction & type safety

Each descriptor's `create` is the only sanctioned way to build a node, owning
the boilerplate (empty-text children for voids, default `children`) so
construction can't drift from what `normalize` expects.

```ts
// before
Transforms.setNodes(editor, { type: "heading", level } as any, { at });
const node: WikilinkElement = { type: "wikilink", target, children: [{ text: "" }] };

// after
Transforms.setNodes(editor, makeHeading({ level }), { at });
Transforms.insertNodes(editor, makeWikilink({ target }));
```

- `as any` *reads* (`(block as any).type`) vanish by leaning on
  `Element.isElement(n)`, which narrows `Node` to `CustomElement`.
- `as any` *writes* become typed `Partial<CustomElement>` at `Transforms.setNodes`.
- **Target: zero `as any` in the editor element/transform paths.** The
  decoration `token` range augmentation (`BaseRange`) is a separate concern and
  stays.

## Serialization (scope: serialize-out only)

The converters are asymmetric:

- **slate→mdast** switches cleanly on *our* element types → 1:1 with descriptors.
  Move into each descriptor as `toMdast(node, ctx)`; `slate-to-mdast.ts` becomes
  a thin dispatcher.
- **mdast→slate** switches on the *foreign mdast* vocabulary (`code`, `list`,
  `wikiLink`, `footnoteReference`) and carries cross-cutting concerns (one mdast
  `list` → bulleted/numbered; HTML-comment block IDs/properties; YAML
  frontmatter; tables). It does **not** reduce to one branch per element type and
  **stays as-is**.

Adding a type therefore touches the descriptor (`toMdast`) plus one branch in the
deserializer. This is accepted asymmetry, not a leaky attempt to force both
directions through the registry.

## Plugin chain

```ts
// before
withReact(withHistory(withAutoformat(withOutliner(withLinks(withWikilinks(createEditor()))))))
// after
withReact(withHistory(withAutoformat(withOutliner(withSchema(createEditor())))))
```

- `withLinks` and `withWikilinks` are **deleted**; classification derived in
  `withSchema`.
- `withOutliner` keeps its **commands** (`indentListItem`, `outdentListItem`,
  `moveBlockUp/Down`, `toggleCheckbox`, `deleteBackward`) — these are commands,
  not schema — but loses its `normalizeNode` override, which moves to the `list`
  descriptor.
- `withAutoformat` is unaffected (insert-driven; touches no schema hook —
  verified).

## Out of scope

- Text marks (`renderLeaf`) remain a hand-written switch. A symmetric mark
  registry is possible future work but not justified now (YAGNI); this pass is
  about elements.
- No new element types are added; this is structural.
- `mdast→slate` deserialization is not moved into descriptors.

## Testing strategy

Test-driven throughout; transforms tested directly without `withReact` (the
established project pattern).

- **Regression guard:** existing round-trip, `withOutliner`, `renderLeaf`, and
  decorate tests must stay green at every phase.
- **New tests (red→green):** one per normalization invariant; `create` factory
  unit tests; a classification test asserting `isInline`/`isVoid` derived from
  the registry exactly matches today's behavior for all 13 element types.

## Phasing

Each phase lands independently green; risk front-loaded out of the early phases.

1. **Scaffold `schema/`** — descriptor type, registry, `withSchema` deriving
   `isInline`/`isVoid`; delete `withLinks`/`withWikilinks`. No behavior change;
   classification parity test proves it.
2. **Render + factories** — move `renderElement` dispatch and `create` factories
   into descriptors; swap call sites; eliminate `as any`.
3. **List normalization move** — relocate list `normalizeNode` from
   `withOutliner` to the `list` descriptor, behavior-preserving.
4. **New invariants** — code-block purity, void integrity, `documentRules`
   footnote pass. The behavior-changing phase; strict TDD.
5. **Serialize-out** — `toMdast` into descriptors; `slate-to-mdast.ts` becomes a
   dispatcher.
