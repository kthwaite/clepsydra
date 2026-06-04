# Shared Block Conversions — Design

**Date:** 2026-06-04
**Status:** Approved (design)

## Problem

Paragraph-to-block conversions (heading, bulleted/numbered/task list, blockquote,
code-block, thematic-break) are implemented twice with divergent mechanics:

- **Autoformat** (`ui/src/editor/plugins/autoformat/blockTransforms.ts`) —
  space/`-`/Enter triggered. Deletes the trigger marker, converts, and **merges a
  new list with an adjacent same-type list** (`mergeWithAdjacentList`). Wraps the
  paragraph in a `list-item` via `wrapNodes`.
- **Slash menu** (`executeSlashCommand` in `ui/src/editor/SlateEditor.tsx`) —
  deletes the `/query`, converts, **does not merge** adjacent lists, and uses a
  different list mechanic (`setNodes(list-item)` + re-wrap text in a paragraph).
  Also `removeNodes`+`insertNodes` for code-block/divider where `setNodes` suffices.
  Not wrapped in an undo batch.

Both reach the same canonical shapes, so the conversion logic should live in one place.

## Decision

Extract a single shared helper. Resolve the divergences:

- **List merge:** always merge adjacent same-type lists. The slash menu gains this
  behavior — typing `/bullet` directly under an existing bullet list now joins it.
  This is treated as a bug fix, not a regression.
- **List mechanic:** standardize on the autoformat approach — `wrapNodes(makeListItem)`
  around the paragraph, producing the canonical `list-item > paragraph > text`.
- **Void/code blocks:** use `setNodes` to change the paragraph's `type`. An emptied
  paragraph (`children: [{ text: "" }]`) becomes exactly what `makeThematicBreak` /
  `makeCodeBlock` produce, so the slash menu's `removeNodes`+`insertNodes` is dropped.
- **Batching:** the helper owns one `HistoryEditor.withNewBatch` +
  `Editor.withoutNormalizing` spanning the text deletion and the conversion. The
  slash menu thereby gains proper single-step undo.

## Module

New file: `ui/src/editor/transforms/blockConversions.ts`

```ts
export type BlockConversion =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "bulleted-list" }
  | { type: "numbered-list" }
  | { type: "task" }                       // bulleted list-item, checked: false
  | { type: "blockquote" }
  | { type: "code-block"; language?: string }
  | { type: "thematic-break" };

export function applyBlockConversion(
  editor: Editor,
  opts: { at: Path; deleteRange?: Range; conversion: BlockConversion },
): void;
```

`mergeWithAdjacentList` relocates from `blockTransforms.ts` into this module (now
shared by both call paths).

### Behavior

All steps run inside one `withNewBatch` + `withoutNormalizing`:

1. If `deleteRange` is provided, delete it (empties the trigger marker or `/query`).
2. Dispatch on `conversion.type`:
   - **heading** — `setNodes({ type: "heading", level })` at `at`.
   - **bulleted-list / numbered-list / task** — `wrapNodes(makeListItem({ checked }))`
     (checked is `false` for `task`, omitted otherwise), then
     `wrapNodes(make{Bulleted,Numbered}List())` (task uses bulleted), then
     `mergeWithAdjacentList`.
   - **blockquote** — `wrapNodes(makeBlockquote())`.
   - **code-block** — `setNodes({ type: "code-block", language })`.
   - **thematic-break** — `setNodes({ type: "thematic-break" })`, insert a trailing
     paragraph after, move the cursor into it.

## Callers

- **`blockTransforms.ts`** — the heading / list / task / blockquote arms of
  `tryBlockTransform`, plus `tryThematicBreak` and `tryCodeFence`, each become a single
  `applyBlockConversion` call passing their existing computed `deleteRange`. The
  per-type helpers (`applyListTransform`, `applyTaskListTransform`) and the local
  `mergeWithAdjacentList`/`applyWithBatch` are removed. `tryTaskPromotion` (sets
  `checked` on an *existing* list-item) stays — it is not a paragraph→block conversion
  and is not duplicated.
- **`SlateEditor.tsx`** — `executeSlashCommand`'s switch collapses to mapping `cmd.id`
  to a `BlockConversion` and one `applyBlockConversion` call with
  `deleteRange: { anchor: slashTrigger.anchor, focus: selection.focus }`. The `make*`
  imports used only by the removed switch arms are pruned.

## Testing

- New `ui/src/editor/transforms/__tests__/blockConversions.test.ts` drives
  `applyBlockConversion` directly (pure Slate, no `withReact`), covering each
  conversion type and the list-merge path.
- Existing `blockTransforms.test.ts`, `withAutoformat.test.ts`, and slash-menu tests
  remain the behavioral safety net and must stay green. The one intentional behavior
  delta — slash-menu list merge — gets a new/updated assertion.

## Out of scope

- Adding wikilink/block-ref/footnote entries to the slash menu.
- Changing trigger detection, the combobox UI, or `tryTaskPromotion`.
