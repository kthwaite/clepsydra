# Editor Autoformat Layer & Slash Menu

**Date:** 2026-03-13
**Status:** Design approved, pending implementation

## Overview

Add a comprehensive autoformat layer to the Slate editor that transforms typed markdown syntax into rendered blocks and formatted text, plus a slash command menu for discoverability. The editing model is document-first (Obsidian-style): paragraphs are the default block type, lists are opt-in.

## Architecture

### Plugin: `withAutoformat`

A single Slate plugin overriding `insertText` and `insertBreak`, inserted into the editor chain outside `withOutliner`:

```
withReact(withHistory(withAutoformat(withOutliner(withLinks(withWikilinks(createEditor()))))))
```

Internally organized into four sub-modules:

```
plugins/
  autoformat/
    withAutoformat.ts    — plugin entry, insertText/insertBreak overrides
    blockTransforms.ts   — # → heading, - → list, > → blockquote, --- → hr
    inlineTransforms.ts  — **bold**, *italic*, `code`, ~strike~, [text](url)
    autoPair.ts          — auto-insert closing marker on open
    listContinuation.ts  — Enter in list → new item, Enter on empty → exit
```

### `insertText` evaluation order

The `insertText` override evaluates in this exact sequence:

1. **Overtype check** — if cursor is immediately before a closing marker and the typed character matches, move cursor past it. No insertion. **Does not short-circuit** — continues to step 4 to check whether the resulting buffer now contains a complete marker pair.
2. **Block transform (space-triggered)** — if typed character is space and text before cursor is a recognized block prefix in a paragraph or list-item, apply block transform. Short-circuits on match.
3. **Block transform (immediate)** — if typed character is `-` and text before cursor is exactly `--` in a paragraph, convert to thematic-break. Short-circuits on match.
4. **Inline transform** — if typed character completes a closing marker (e.g., second `*` of `**`), or if overtype (step 1) just moved the cursor past a closing marker, scan for matching opener and apply mark/element. Uses the `*`/`**` disambiguation rule (see Ambiguity Resolution below). Short-circuits on match.
5. **Auto-pair** — if typed character is an opening marker and conditions are met, insert both opening and closing markers. Short-circuits on match.
6. **Fallback** — call original `insertText` (normal character insertion).

Steps 2–6 follow a first-match-wins short-circuit rule. Step 1 is the exception: overtype always continues to step 4 because moving past a closing marker often completes an inline format pair.

Step 2 covers both paragraph-level transforms (headings, lists, blockquotes) and list-item-level transforms (`[ ]`/`[x]` → task item). The context (paragraph vs list-item) determines which prefix set is checked.

**Example: `*hello*` (italic with auto-pair):**
- First `*`: step 1 (no marker to overtype) → step 2 (not space) → step 3 (not `-`) → step 4 (no opener to match) → step 5 (auto-pair) fires, inserting `*|*`
- `h`, `e`, `l`, `l`, `o`: all fall through to step 6 (normal insertion), giving `*hello|*`
- Second `*`: step 1 (overtype) fires — cursor moves past the auto-paired `*`, giving `*hello*|`. Continues to step 4 (inline transform) — finds the opener `*` at start, applies italic, removes both markers.

**Example: `**hello**` (bold with auto-pair):**
- First `*`: auto-pair → `*|*`
- Second `*`: step 1 (overtype) moves past paired `*` → `**|`. Step 4: scans for opener, finds `*` at position 0, but disambiguation rule checks if preceding char is also `*` — position 0 has no preceding char, so this would be italic, not bold. But there's only one character of content (`*`) between opener and closer, and it's the marker itself, so no valid text to format. Step 4 finds no valid match → no transform. Continue to step 5: auto-pair fires, inserting `*` → `**|**`.
- `h`, `e`, `l`, `l`, `o`: normal insertion → `**hello|**`
- First closing `*`: step 1 (overtype) moves past paired `*` → `**hello*|*`. Step 4: scans for opener `*`, finds match at position 1. Disambiguation: preceding char at position 0 is `*`, so treat as `**` bold closer — but only one `*` has been closed so far. The disambiguation rule recognizes this as the first `*` of a `**` pair and does **not** fire. No match.
- Second closing `*`: step 1 (overtype) moves past paired `*` → `**hello**|`. Step 4: scans for `**` opener (disambiguation sees preceding char is `*`), finds `**` at position 0, applies bold to "hello", removes all four markers.

### Undo batching strategy

All multi-operation transforms use `Editor.withoutNormalizing` for the mutation sequence plus `editor.writeHistory('undos', { operations: [...], selectionBefore })` within a `HistoryEditor.withoutSaving` block. This gives us explicit control: the entire transform (marker deletion + mark application + cursor move) appears as a single undo entry.

Concretely, each transform function:
1. Calls `HistoryEditor.withoutSaving(editor, () => { ... })` to suppress per-op undo entries
2. Inside that, calls `Editor.withoutNormalizing(editor, () => { ... })` to batch normalization
3. After the mutations complete, manually pushes one compound undo entry with all operations and the pre-transform selection

This pattern is already established in the Slate ecosystem (slate-history's own merge logic) and ensures Cmd+Z reverts any transform cleanly to the typed-prefix state.

### Slash Menu: `SlashCombobox`

A new combobox component following the existing `WikilinkCombobox` / `BlockRefCombobox` pattern, triggered by `/` at start of a block.

## List-Item Canonical Shape

The parser (`mdast-to-slate.ts`) emits list-items with **paragraph children** — a list-item's first child is always a `ParagraphElement` containing the item's text content. Nested lists, when present, appear as subsequent children.

```
bulleted-list
  list-item
    paragraph          ← always present, contains the item's text
      "item text"
    bulleted-list      ← optional nested list
      list-item
        paragraph
          "nested text"
```

**This is the canonical shape all transforms must produce and preserve.** Specifically:

- **Block transforms** that create a list-item must wrap the existing text in a paragraph child: `{ type: "list-item", children: [{ type: "paragraph", children: [{ text: "" }] }] }`.
- **List continuation** (`insertBreak`) must create new list-items with a paragraph child, not bare text nodes.
- **Task-list prefix detection** (`[ ]`/`[x]` at start of list-item) operates on the text within the first paragraph child.
- The `withOutliner` normalizer skips list-items entirely (returns early, line 39), so there is no safety net — transforms must produce structurally valid nodes.

## Block-Level Transforms

Triggered in `insertText` when the inserted character is `" "` (space) and the text before the cursor matches a recognized prefix. Only fires in **paragraph** blocks — no re-conversion of existing typed blocks, no transforms inside code blocks, blockquotes, or headings.

**Prefix matching**: checked against the full text content of the paragraph before the cursor at the moment space is typed.

The check order for the primary (paragraph → block) transform:

1. `######` through `#` → heading (most hashes first)
2. `N.` (digit(s) + dot) → numbered list
3. `-` or `*` → bulleted list
4. `>` → blockquote

**Task-list transform** — runs inside **list-item** blocks only (not paragraphs). This is the sole mechanism for creating task items:

5. `[ ]` or `[x]` at start of the list-item's first paragraph text + space → set `checked` on the list-item, remove prefix text

The two-step flow for creating a task from scratch: type `- ` (converts paragraph to bulleted list-item), then type `[ ] ` (converts list-item to task item). This avoids any ambiguity between `- ` and `- [ ]` prefix racing — they operate in different block contexts.

| Prefix | Context | Transform |
|--------|---------|-----------|
| `#` through `######` | Paragraph | Convert → heading (level 1–6) |
| `-` or `*` | Paragraph | Wrap in bulleted-list, convert to list-item |
| `N.` (digit(s) + dot) | Paragraph | Wrap in numbered-list, convert to list-item |
| `>` | Paragraph | Convert → blockquote containing paragraph |
| `[ ]` or `[x]` | List-item | Set `checked` on item, remove prefix text |

### Special cases

- **` ``` ` + Enter**: Detected in `insertBreak`. When Enter is pressed and the block text is exactly ` ``` ` (optionally followed by a language string like ` ```rust `), convert to code-block with language set, clear text. Only fires in paragraph blocks.
- **`---`**: Detected in `insertText` when typing the third `-` and text is exactly `--`. No space needed — convert immediately to thematic-break. Only fires in paragraph blocks.
- **List merging**: When converting to a list item, if the previous or next sibling is already the same list type, merge into it rather than creating a new list wrapper.

## Inline Transforms

Triggered in `insertText` when the user types a closing marker that matches an earlier opening marker in the same text node.

The opening marker must be preceded by whitespace or be at the start of text (prevents mid-word triggers like `path_to_file_name`).

| Marker pair | Result |
|-------------|--------|
| `**...**` | Apply `bold` mark |
| `*...*` | Apply `italic` mark (must not be `**`) |
| `__...__` | Apply `bold` mark |
| `_..._` | Apply `italic` mark (must not be `__`) |
| `` `...` `` | Apply `code` mark |
| `~...~` | Apply `strikethrough` mark (**new mark**) |
| `[text](url)` | Insert `link` element |

### Mark application flow

1. User types closing marker (e.g., second `*` after `hello *world`)
2. Scan backward for matching opener preceded by whitespace/start-of-text
3. Delete opening and closing markers
4. Apply mark to text between them
5. Move cursor after formatted text
6. Entire sequence in a single undo batch (see Undo Batching Strategy above)

### Ambiguity resolution (`*` / `**`, `_` / `__`)

When the user types `*`, check if the preceding character is also `*`. If so, treat as `**` closing pair for bold. Otherwise treat as `*` closing for italic. Same logic for `_` / `__`.

### Link detection `[text](url)`

Triggered when user types `)`. Scan backward for `](` to find URL, then further back for `[` to find link text. If full `[...](...)` structure found:

1. Delete entire `[text](url)` text
2. Insert `link` element with URL and text content
3. Single undo batch

## Auto-Pairing

When the user types an opening formatting marker, the closing marker is automatically inserted and cursor placed between them.

### Trigger characters: `*`, `_`, `~`

**Note:** Backtick (`` ` ``) is **not** auto-paired. Auto-pairing backticks would conflict with the ` ``` ` (triple backtick) code fence trigger — the auto-paired backticks would create `` `|` `` on the first keystroke, making it impossible to build up ` ``` ` naturally. Inline code formatting via `` `...` `` still works through inline transforms (type opening `` ` ``, type text, type closing `` ` `` → code mark applied).

**Note:** Square bracket `[` is **not** auto-paired. Auto-pairing `[` would conflict with the existing `[[` wikilink trigger flow. Currently, typing `[[` opens the wikilink combobox, and selecting a page deletes from the `[[` anchor to the cursor and inserts a wikilink element. If `[` auto-paired to `[]`, the first `[` would insert `[]` and the cursor would be between them. The second `[` would then produce `[[|]` — the stray `]` would remain after wikilink insertion, corrupting the text. Bracket characters are left to normal insertion; the `[text](url)` link workflow works through inline transform detection on `)`.

**Behavior:**
1. Type `*` → inserts `**` with cursor between: `*|*`
2. Type another `*` → `**|**` (building up to bold)
3. Type text → `**hello|**`
4. Type closing markers → inline transform fires

### Skip auto-pair when:
- Character after cursor is already the same character
- Cursor is inside a code mark or code-block
- Non-whitespace character immediately precedes cursor and character is `*`, `_`, or `~` (mid-word)

### Overtype
When cursor is immediately before a closing marker and user types that same character, move cursor past it instead of inserting a duplicate. Applies to all auto-pairable characters (`*`, `_`, `~`).

### Selection wrapping
If text is selected and user types a pairing character, wrap the selection. E.g., select "hello", type `*` → `*hello*`.

## List Continuation

Handled in `insertBreak` override.

### Enter in a list item

1. **Non-empty item**: Insert new list-item after current one, with canonical shape (paragraph child). If the current item has `checked` defined (task item), new item gets `checked: false`. Cursor moves to the new empty paragraph inside the new item.

2. **Empty item, nested**: Outdent one level (same as Shift+Tab). Second Enter on outdented empty item exits list.

3. **Empty item, top-level**: Unwrap from list, convert to empty paragraph.

4. **Cursor mid-text**: Split at cursor. Text before stays in current item's paragraph, text after moves to a new list-item's paragraph (new node is a list-item with paragraph child, not a bare paragraph).

### Enter in a blockquote

New paragraph inside blockquote. Enter on empty paragraph inside blockquote exits (unwraps to top-level paragraph).

### Enter in a code block

Pass through to default Slate behavior (new line within code block). Exiting code blocks deferred to later iteration.

## Slash Menu

### Trigger

`/` typed at **position 0** of a block's text content only. The slash menu is a block-level tool for converting block types — it does not make sense mid-sentence. Restricting to position 0 avoids false triggers in URLs, file paths, prose, and fractions.

Detection in `handleChange` alongside existing `[[` and `((` detection. The check is simple: is the `/` at offset 0 in the text node, and is that text node the first child of a paragraph?

The slash menu follows the same `handleKeyDown` interception pattern as `WikilinkCombobox` and `BlockRefCombobox` — when the slash combobox is active, Enter/ArrowUp/ArrowDown/Escape are intercepted with `event.preventDefault()` so they don't reach Slate's `insertBreak`.

### Component: `SlashCombobox`

Follows existing combobox pattern:
- floating-ui positioning relative to cursor
- Arrow key navigation, Enter/Tab to select, Escape to dismiss
- Fuzzy filtering as user types after `/`

### Command set (v1, flat list)

| Command | Action |
|---------|--------|
| Heading 1 | Convert to heading level 1 |
| Heading 2 | Convert to heading level 2 |
| Heading 3 | Convert to heading level 3 |
| Heading 4 | Convert to heading level 4 |
| Heading 5 | Convert to heading level 5 |
| Heading 6 | Convert to heading level 6 |
| Bullet list | Convert to bulleted list item |
| Numbered list | Convert to numbered list item |
| Task list | Convert to list item with checkbox |
| Blockquote | Convert to blockquote |
| Code block | Convert to code block |
| Divider | Insert thematic break |

### Execution

Each command deletes the `/` trigger text and any query characters, then calls the same transform functions as block-level autoformat — shared code. The transform receives the current block and converts it, same as if the user had typed the markdown prefix.

### Deferred

Categories/grouping, plugin-registered commands, recently-used ordering.

## New Type: `strikethrough` mark

Added to `CustomText`:

```typescript
export interface CustomText {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  strikethrough?: true;  // new
}
```

Rendering in `renderLeaf`: wrap in `<del>`.

Serialization:
- `slate-to-mdast.ts`: emit `delete` mdast node wrapping strikethrough text
- `mdast-to-slate.ts`: detect `delete` mdast node and apply `strikethrough` mark (currently at line 262, the `delete` case drops to plain text — update to pass `{ ...marks, strikethrough: true }`)

## Integration risks and mitigations

### Wikilink `[[` flow

The existing wikilink combobox (triggered by `[[`) works by detecting `[[` in `handleChange` and inserting a void wikilink element that replaces the range from the `[[` anchor to the cursor. Auto-pairing `[` would break this flow (see Auto-Pairing section for details). **Mitigation:** `[` is explicitly excluded from auto-pairing.

### Block ref `((` flow

Same pattern as wikilinks. `(` is not auto-paired (never was proposed for general auto-pairing — only `(` after `]` was considered for link syntax, and that has been dropped to keep things simple).

### `withOutliner` normalizer bypass

`withOutliner` returns early for all list-items without calling the default `normalizeNode`. This means malformed list-items are never corrected automatically. **Mitigation:** the canonical list-item shape is documented above; all transforms that create or modify list-items must produce valid nodes with paragraph children. Test coverage for list-item shape after each transform.

## Files to create

- `ui/src/editor/plugins/autoformat/withAutoformat.ts`
- `ui/src/editor/plugins/autoformat/blockTransforms.ts`
- `ui/src/editor/plugins/autoformat/inlineTransforms.ts`
- `ui/src/editor/plugins/autoformat/autoPair.ts`
- `ui/src/editor/plugins/autoformat/listContinuation.ts`
- `ui/src/editor/SlashCombobox.tsx`

## Files to modify

- `ui/src/editor/types.ts` — add `strikethrough` mark
- `ui/src/editor/elements/renderLeaf.tsx` — render strikethrough
- `ui/src/editor/convert/slate-to-mdast.ts` — serialize strikethrough
- `ui/src/editor/convert/mdast-to-slate.ts` — deserialize strikethrough (update existing `delete` case)
- `ui/src/editor/SlateEditor.tsx` — wire up `withAutoformat`, add slash menu trigger detection and `SlashCombobox`
