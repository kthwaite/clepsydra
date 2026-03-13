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

1. **Overtype check** — if cursor is immediately before a closing marker and the typed character matches, move cursor past it. No insertion. **Does not short-circuit** — continues to step 3 to check whether the resulting buffer now contains a complete marker pair.
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

### Slash Menu: `SlashCombobox`

A new combobox component following the existing `WikilinkCombobox` / `BlockRefCombobox` pattern, triggered by `/` at start of text or after whitespace.

## Block-Level Transforms

Triggered in `insertText` when the inserted character is `" "` (space) and the text before the cursor matches a recognized prefix. Only fires in **paragraph** blocks — no re-conversion of existing typed blocks, no transforms inside code blocks, blockquotes, or headings.

**Prefix matching order and ambiguity**: Longer/more-specific prefixes are checked before shorter ones. Additionally, a prefix must not fire if the text before the cursor is a strict prefix of a longer recognized pattern. Concretely: when the user types `-` then space, the text before cursor is `-`, which is a strict prefix of `- [ ]` and `- [x]`. The bulleted list transform must **not** fire here. It fires only when the character before the triggering space is not `[`, `]`, or `x` in a position consistent with a task-list prefix — in practice, the simplest check is: if text before cursor matches `- ` or `* ` and the next characters the user types are `[`, defer. Since we can't predict future keystrokes, the practical implementation is:

- The `-` / `*` bulleted list trigger checks that the full text before cursor is **exactly** `-` or `*` (nothing more after dash/star except the triggering space).
- The `- [ ]` / `- [x]` task list trigger checks the full text before cursor is exactly `- [ ]`, `- [x]`, `-[ ]`, or `-[x]`.

These fire on different keystrokes (first space for bullet, second space after `]` for task), so they never race. The key insight: when the user types `- ` (dash-space), the text before cursor is `-` and the transform fires. If they wanted a task list, they would type `- []` or `-[]` first and then space — but that requires typing `[` before the second space, at which point the user is already inside a bulleted list item. **To handle this correctly, typing `[ ]` or `[x]` at the start of a list-item (after the autoformat to bullet) should convert that list-item to a task item** (set `checked` accordingly and remove the typed `[ ] ` or `[x] ` text). This is a secondary transform that runs inside list-items, not paragraphs.

The check order for the primary (paragraph → block) transform:

1. `######` through `#` → heading (most hashes first)
2. `N.` (digit(s) + dot) → numbered list
3. `-` or `*` → bulleted list
4. `>` → blockquote

The task-list transform is a separate check that runs inside **list-item** blocks:

5. `[ ]` or `[x]` at start of list-item text + space → set `checked` on the list-item, remove prefix text

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
- **Undo**: All transforms wrapped in a single undo batch so Cmd+Z reverts cleanly to the typed prefix.

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
6. Single undo batch

### Ambiguity resolution (`*` / `**`, `_` / `__`)

When the user types `*`, check if the preceding character is also `*`. If so, treat as `**` closing pair for bold. Otherwise treat as `*` closing for italic. Same logic for `_` / `__`.

### Link detection `[text](url)`

Triggered when user types `)`. Scan backward for `](` to find URL, then further back for `[` to find link text. If full `[...](...)` structure found:

1. Delete entire `[text](url)` text
2. Insert `link` element with URL and text content
3. Single undo batch

## Auto-Pairing

When the user types an opening formatting marker, the closing marker is automatically inserted and cursor placed between them.

### Trigger characters: `*`, `_`, `~`, `` ` ``

**Behavior:**
1. Type `*` → inserts `**` with cursor between: `*|*`
2. Type another `*` → `**|**` (building up to bold)
3. Type text → `**hello|**`
4. Type closing markers → inline transform fires

### Skip auto-pair when:
- Character after cursor is already the same character
- Cursor is inside a code mark or code-block
- Non-whitespace character immediately precedes cursor and character is `*`, `_`, or `~` (mid-word)

### Bracket auto-pairing
- `[` → `[]` (supports `[text](url)` workflow)
- `(` → `()` only after `]` (supports link syntax, avoids pairing in normal prose)

### Overtype
When cursor is immediately before a closing marker and user types that same character, move cursor past it instead of inserting a duplicate.

### Selection wrapping
If text is selected and user types a pairing character, wrap the selection. E.g., select "hello", type `*` → `*hello*`.

## List Continuation

Handled in `insertBreak` override.

### Enter in a list item

1. **Non-empty item**: Insert new list-item after current one. If current item has `checked` defined (task item), new item gets `checked: false`. Cursor moves to new empty item.

2. **Empty item, nested**: Outdent one level (same as Shift+Tab). Second Enter on outdented empty item exits list.

3. **Empty item, top-level**: Unwrap from list, convert to empty paragraph.

4. **Cursor mid-text**: Split at cursor. Text before stays in current item, text after moves to new item (new node is a list-item, not paragraph).

### Enter in a blockquote

New paragraph inside blockquote. Enter on empty paragraph inside blockquote exits (unwraps to top-level paragraph).

### Enter in a code block

Pass through to default Slate behavior (new line within code block). Exiting code blocks deferred to later iteration.

## Slash Menu

### Trigger

`/` typed at **position 0** of a text node, or immediately after a whitespace character with no other `/` between the whitespace and the cursor. This prevents false triggers in URLs (`https://...`), file paths, or fractions.

Detection in `handleChange` alongside existing `[[` and `((` detection. The trigger check scans backward from the cursor: find the last `/`, verify it is at position 0 or preceded by whitespace, and verify no other non-whitespace characters appear between that whitespace and the `/`.

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

Each command calls the same transform functions as block-level autoformat — shared code.

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
- `mdast-to-slate.ts`: detect `delete` mdast node and apply `strikethrough` mark

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
- `ui/src/editor/convert/mdast-to-slate.ts` — deserialize strikethrough
- `ui/src/editor/SlateEditor.tsx` — wire up `withAutoformat`, add slash menu trigger detection and `SlashCombobox`
