# Markdown Bracket Shortcuts — Design

**Date:** 2026-07-17
**Status:** Approved (design)

## Problem

The Slate autoformat layer already converts a completed `[label](url)` sequence into a `link` when the closing `)` is typed. It does not recognize typed footnote references, create matching footnote definitions, or continue a completed `[label]` into the `()` portion of a Markdown link. Square and round delimiters are also absent from the generic auto-pair set.

The requested authoring flow is structural rather than generic delimiter pairing:

- typing the closing `]` in `[^identifier]` creates a `footnote-ref` and, if needed, one matching empty `footnote-def` at the end of the document;
- typing the closing `]` in `[label]` inserts `()` and places the caret between the parentheses;
- typing the URL and closing/overtype `)` uses the existing link transform to create a `link` element.

## Decisions

- Extend the existing autoformat pipeline. Do not add DOM `keydown` handling or reparse the current block.
- Append newly created footnote definitions at the document end. Keep the caret immediately after the inline reference.
- Reuse an existing definition with the same identifier; never create a duplicate.
- Require non-empty footnote identifiers and link labels.
- Disable these transformations in block code and inline code contexts.
- Preserve incomplete or invalid syntax as literal text.
- Character-by-character input and multi-character composition/autocorrect input produce the same Slate structure.
- Each structural shortcut is one history batch. One undo returns to the state immediately before the triggering `]` keystroke and removes any definition created by that shortcut.

## Architecture

### Inline transformation dispatch

Extend `ui/src/editor/plugins/autoformat/inlineTransforms.ts` so `tryInlineTransform` handles `]` before the existing `)` link closer.

The `]` handler examines the current text leaf before the caret, matching the nearest valid `[` opener in that leaf:

1. `[^identifier` becomes a `footnote-ref` when the user types `]`.
2. `[label` becomes literal `[label]()` with the caret between `(` and `)` when the user types `]`.
3. Empty labels/identifiers, nested unmatched bracket syntax, and missing openers return `false`, allowing normal text insertion.

Footnotes take precedence over link-label completion, so `[^identifier]` never receives `()`.

The existing opener boundary rule remains in force: the opener must be at the start of the leaf or preceded by whitespace. This avoids converting brackets embedded in ordinary tokens and matches the current link transform.

### Footnote reference and definition transaction

For a footnote match, one `HistoryEditor.withNewBatch` transaction:

1. removes the literal `[^identifier` range (the typed `]` has not yet been inserted);
2. inserts the existing `footnote-ref` element shape with `children: [{ text: "" }]`;
3. scans top-level document nodes for a `footnote-def` with the same identifier;
4. appends a new definition only when no match exists, using an empty paragraph child so it is a valid editable block;
5. restores the caret immediately after the inline void reference.

The implementation should use the existing schema element factories if importing them does not create a dependency cycle; otherwise it should construct the same registered node shapes locally.

### Link-label continuation and final conversion

For a link-label match, one history batch inserts the closing `]` plus `()` and positions the caret inside the parentheses. The text remains Markdown syntax until a non-empty destination is completed.

The preinserted `)` is already recognized by `tryOvertype`. `tryLinkTransform` must therefore receive and honor `closerConsumed`: on the overtype path, the final `)` is present in `textBefore` and must be excluded from both the URL and the deletion range calculation. The normal path, where `)` has not yet been inserted, remains unchanged. Empty destinations remain literal `[label]()`.

### Composed input

Add `]` to the composed-inline closer set in `withAutoformat.ts`. `resolveComposedInline` continues to replay the shared inline transformation logic rather than implementing a second parser. A composed `[^id]` creates the same reference/definition pair as per-character typing; a composed complete `[label](url)` resolves directly to a link without leaving an extra `()`.

The replay loop must not manufacture link continuation syntax while a complete composed link already has its destination. Resolution order and tests must establish that complete Markdown input converts once and retains no delimiters.

### Context guards

Keep the existing code-block guard and add the equivalent active-code-mark guard used by `tryAutoPair`. Neither footnote nor link structural shortcuts run when the selection is inside inline code. No editor-level keyboard event handling is added.

## Data flow

### Footnote

`type "[^source]"` → `insertText("]")` → inline `]` transform → replace literal range with `footnote-ref(source)` → find/append `footnote-def(source)` → caret after reference.

### Link

`type "[Example]"` → `insertText("]")` → inline `]` transform → text becomes `[Example]()` with caret inside → type destination → type/overtype `)` → existing `)` transform → replace Markdown syntax with `link(url, "Example")`.

## Error and edge-case behavior

- `[]` and `[^]` stay literal.
- A footnote reference whose definition already exists creates no new block.
- Multiple references to the same identifier share one definition.
- A label or identifier without a valid opener stays literal.
- Bracket shortcuts inside code blocks or inline code stay literal.
- `[label]()` stays literal until it has a non-empty destination.
- Existing complete-link conversion continues to support ordinary typed and composed input.
- Document normalization must not move the user selection into the appended footnote definition.

## Testing

Extend `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts` using a schema-aware editor for inline elements.

Required observable cases:

1. Typing `[^1]` creates one `footnote-ref` and appends one empty `footnote-def` with identifier `1`.
2. The caret remains after the inserted inline reference.
3. Typing another `[^1]` reuses the existing definition.
4. An existing matching definition is reused even when it is not the final node.
5. Typing `[Example]` produces `[Example]()` and places the caret inside the parentheses.
6. Typing/overtype-closing `[Example](https://example.com)` creates a link whose URL excludes the closing `)`.
7. Existing direct complete-link conversion remains unchanged.
8. `[]`, `[^]`, unmatched syntax, and empty link destinations remain literal.
9. Footnote/link bracket shortcuts do not run in code blocks or inline code.
10. Composed `[^id]` creates the same reference/definition structure as per-character typing.
11. Composed `[label](url)` creates exactly one link with no leftover delimiters.
12. One undo returns a footnote shortcut to the pre-`]` state and removes its newly appended definition; one undo does the same for link-label continuation.

## Scope

This change adds authoring shortcuts only. It does not add footnote-definition navigation, renumber identifiers, reorder existing definitions, auto-pair arbitrary square brackets, fetch link metadata, or change Markdown serialization.
