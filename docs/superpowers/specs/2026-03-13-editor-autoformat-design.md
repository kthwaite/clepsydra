# Editor Autoformat Layer & Slash Menu

**Date:** 2026-03-13
**Status:** Design approved, pending implementation

---

## 1) Scope

### In scope
- Autoformat plugin for block + inline transforms.
- Enter-key list continuation + blockquote/code-fence behavior.
- Slash command menu for block transforms.
- New `strikethrough` mark end-to-end (render + md serialization).

### Explicitly out of scope
- Bracket/paren auto-pair (`[`, `(`) — deferred to avoid `[[` / link conflicts.
- Backtick auto-pair — deferred to avoid triple-backtick fence conflicts.
- Autoformat across multiple text nodes/elements.
- Plugin-registered slash commands, categories, MRU ordering.

---

## 2) Plugin composition

`withAutoformat` is inserted outside `withOutliner`:

```ts
withReact(withHistory(withAutoformat(withOutliner(withLinks(withWikilinks(createEditor()))))))
```

`withAutoformat` owns overrides for:
- `insertText`
- `insertBreak`

And delegates to submodules:

```
plugins/
  autoformat/
    withAutoformat.ts
    blockTransforms.ts
    inlineTransforms.ts
    autoPair.ts
    listContinuation.ts
```

---

## 3) Hard invariants (must hold)

### I-1 Selection/shape guards
- Autoformat runs only when selection exists.
- Inline/block trigger transforms require collapsed selection.
- Selection wrapping (auto-pair) is the only non-collapsed path.

### I-2 Context guards
- No block prefix transforms unless current block is `paragraph` or `list-item` (task-promotion only).
- No inline transforms in `code-block`.
- No inline transforms when active marks include `code`.

### I-3 Text locality
- Inline marker transforms only operate when opener and closer are in the **same text node**.

### I-4 Undo behavior
Every successful transform executes in exactly one history batch:

```ts
HistoryEditor.withNewBatch(editor, () => {
  Editor.withoutNormalizing(editor, () => {
    // transform ops
  });
});
```

Expected result: one Cmd/Ctrl+Z reverts one autoformat action.

### I-5 Combobox exclusivity
At most one trigger is active at a time:
- `[[` wikilink
- `((` block-ref
- `/` slash

Priority: `[[` > `((` > `/`.

### I-6 List-item shape contract

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

- `list-item.children[0]` = `paragraph`.
- Optional additional children = nested lists only.
- **Block transforms** that create a list-item must wrap the existing text in a paragraph child: `{ type: "list-item", children: [{ type: "paragraph", children: [{ text: "" }] }] }`.
- **List continuation** (`insertBreak`) must create new list-items with a paragraph child, not bare text nodes.
- **Task-list prefix detection** (`[ ]`/`[x]` at start of list-item) operates on the text within the first paragraph child.
- The `withOutliner` normalizer skips list-items entirely (returns early), so there is no safety net — transforms must produce structurally valid nodes.
- **Pre-requisite fix:** `withOutliner`'s empty-children fallback currently inserts a bare `{ text: "" }` — this must be changed to `{ type: "paragraph", children: [{ text: "" }] }` as part of this implementation so the normalizer and transforms agree on canonical shape.

Legacy mixed shapes are tolerated on read, but new transforms must write canonical shape.

---

## 4) `insertText` pipeline (exact order)

For each typed character `ch`:

1. **Try overtype**
   - If cursor is directly before same char and char is one of `*`, `_`, `~`, `` ` ``, `]`, `)`, move cursor past it.
   - If overtype occurred, attempt inline transform (step 4 logic only) on the post-overtype buffer state, then return.
   - Disambiguation reads the character immediately before the current cursor position in the text node **after** the overtype move. This means the check sees the full accumulated marker characters, not the character preceding where the user physically pressed the key.

2. **Immediate thematic-break trigger** (`---`)
   - If `ch === "-"` and paragraph text before cursor is exactly `"--"` and cursor at end of block: convert to thematic break + insert trailing empty paragraph; return.

3. **Space-triggered block transforms**
   - If `ch === " "`, run paragraph/list-item prefix checks (Section 5) in defined order.
   - First match wins; return.

4. **Inline transform**
   - If `ch` can close an inline pattern (`*`, `_`, `~`, `` ` ``, `)`), attempt inline transform (Section 6).
   - If matched, apply and return.

5. **Auto-pair**
   - If `ch` is supported opener (`*`, `_`, `~`), try auto-pair (Section 7).
   - If paired/wrapped, return.

6. **Fallback**
   - Call original `insertText(ch)`.

No other implicit paths. This order is normative.

### Walkthrough: `*hello*` (italic with auto-pair)

- First `*`: step 1 (no marker to overtype) → step 2 (not `-`) → step 3 (not space) → step 4 (no opener to match) → step 5 (auto-pair) fires, inserting `*|*`
- `h`, `e`, `l`, `l`, `o`: all fall through to step 6 (normal insertion), giving `*hello|*`
- Second `*`: step 1 (overtype) fires — cursor moves past the auto-paired `*`, giving `*hello*|`. Continues to step 4 (inline transform) — finds the opener `*` at start, applies italic, removes both markers.

### Walkthrough: `**hello**` (bold with auto-pair)

- First `*`: auto-pair → `*|*`
- Second `*`: step 1 (overtype) moves past paired `*` → `**|`. Step 4: scans for opener, finds `*` at position 0, but disambiguation checks char at `cursor_offset - 1` in the post-overtype text — position 0 has no preceding char, so this would be single-`*` italic. But there's only one character of content between opener and closer, and it's the marker itself, so no valid text to format (content validity rule 6.3). No match. Continue to step 5: auto-pair fires, inserting `*` → `**|**`.
- `h`, `e`, `l`, `l`, `o`: normal insertion → `**hello|**`
- First closing `*`: step 1 (overtype) moves past paired `*` → `**hello*|*`. Step 4: scans for opener `*`, finds match at position 1. Disambiguation: char at `cursor_offset - 1` (position 6, `o`) is not `*`, so treat as single-`*` italic closer. But scanning backward for `*` opener preceded by whitespace/start-of-text finds `*` at position 0 — preceded by nothing (start of text). The content between position 0 and position 1 is `*`, which is a marker character, not valid text. No match.
- Second closing `*`: step 1 (overtype) moves past paired `*` → `**hello**|`. Step 4: char at `cursor_offset - 1` is `*` → treat as `**` bold closer. Scans backward for `**` opener at start of text, finds `**` at position 0. Content between is `hello`. Applies bold, removes all four markers.

---

## 5) Block transforms

### 5.1 Paragraph transforms (triggered by space)

Only when current block is `paragraph`, cursor is collapsed, and text from block start to cursor equals the prefix.

Check order (first-match wins):
1. `######` … `#` → heading levels 6..1 (longest first)
2. `^\d+\.$` → numbered list item
3. `-` or `*` → bulleted list item
4. `>` → blockquote

Notes:
- Numbered-list transform ignores typed start number in data model (list starts at 1 in schema).
- If converting to list item and adjacent same-type list exists, merge (Section 5.4).

### 5.2 List-item task promotion (triggered by space)

Only when current block is `list-item`, selection is in the first paragraph text, and text before cursor is:
- `[ ]` → `checked: false`
- `[x]` or `[X]` → `checked: true`

Action:
1. Remove typed marker from start of item text.
2. Set `list-item.checked` accordingly.
3. Keep list type unchanged.

This is the sole task-list autoformat path. The two-step flow for creating a task from scratch: type `- ` (converts paragraph to bulleted list-item), then type `[ ] ` (converts list-item to task item). These operate in different block contexts, so they never race.

### 5.3 Special block triggers

#### `---` immediate
- On third `-` in paragraph-start context (`"--"` before cursor):
  - Replace paragraph with `thematic-break`.
  - Insert following empty paragraph.
  - Place cursor in new paragraph.

#### Triple-backtick fence on Enter
Handled in `insertBreak` only.

When current block is paragraph and full text matches:
- ````^```([A-Za-z0-9_-]+)?$````

Action:
- Convert paragraph to `code-block`.
- Set `language` when capture exists.
- Clear content to empty text leaf.
- Place cursor at offset 0 in code-block.

### 5.4 List merge policy (deterministic)

When creating a new list-item from a paragraph:
1. If both previous and next siblings are same list type:
   - Insert item into previous list tail.
   - Move next list's children into previous list.
   - Remove next list.
2. Else if previous sibling is same list type:
   - Append to previous list.
3. Else if next sibling is same list type:
   - Prepend to next list.
4. Else:
   - Create new list wrapper containing item.

---

## 6) Inline transforms

Only within one text node.

| Markdown pattern | Result |
|---|---|
| `**text**` | `bold` |
| `*text*` | `italic` |
| `__text__` | `bold` |
| `_text_` | `italic` |
| `~text~` | `strikethrough` |
| `` `text` `` | `code` |
| `[text](url)` | `link` element |

### 6.1 Opener validity
An opener is valid only if:
- it is at text start, or
- previous char is whitespace.

(Prevents mid-word triggers like `foo_bar_baz`.)

### 6.2 Closer disambiguation
For `*` and `_`:
- If char at `cursor_offset - 1` (post-overtype) equals typed char, treat closer as double-char (`**`, `__`).
- Else treat as single-char (`*`, `_`).

Search for matching opener of the same width; do not downgrade double to single in same attempt.

Note: `~` uses single-tilde only — no disambiguation needed.

### 6.3 Content validity
Do not transform if content between opener/closer is empty.

### 6.4 Link transform (`[text](url)`)
Trigger: typed `)`.

Parse nearest suffix ending at cursor with shape:
- `[...](...)` contiguous, no newline in either segment.

Action:
1. Delete full markdown substring.
2. Insert `link` element with parsed URL and inline text children.
3. Cursor moves after inserted link.

---

## 7) Auto-pair and overtype

### 7.1 Auto-pair enabled chars
- `*`
- `_`
- `~`

### 7.2 Auto-pair disabled
- `` ` `` — auto-pairing would create `` `|` `` on first keystroke, making triple-backtick ` ``` ` fence impossible to build up naturally.
- `[` — auto-pairing would conflict with `[[` wikilink trigger. First `[` would insert `[]`, second `[` would produce `[[|]` — stray `]` remains after wikilink insertion, corrupting text.
- `(` — not auto-paired; avoids complexity with prose parentheses and link syntax.

### 7.3 Pairing rules
For enabled chars:
- Collapsed selection: insert opener + closer, place cursor between.
- Non-collapsed selection (single text node only): wrap selection.

### 7.4 Skip auto-pair when
- In `code-block`.
- Active mark `code`.
- Immediately before same character.
- For `*`/`_`/`~`: previous char is non-whitespace (mid-word).

### 7.5 Overtype
If cursor is directly before same closing marker character, advance cursor instead of inserting duplicate.

Applies to: `*`, `_`, `~`, `` ` ``, `]`, `)`.

(Overtype applies to more characters than auto-pair — it supports typing through manually-entered or auto-paired closers, and through the `[text](url)` workflow.)

---

## 8) `insertBreak` behavior (exact order)

1. If inside `list-item`: run list continuation logic (Section 9) and return if handled.
2. Else if inside `blockquote`: new paragraph inside quote; empty paragraph exits quote.
3. Else if paragraph matches triple-backtick fence: convert to code-block (Section 5.3).
4. Else fallback to original `insertBreak`.

---

## 9) List continuation rules

Inside `list-item` on Enter:

1. **Non-empty item**
   - Create next sibling list-item with canonical shape (paragraph child).
   - If current item is task (`checked` present), new item gets `checked: false`.
   - Cursor in new item's paragraph start.

2. **Empty item + nested level**
   - Outdent one level (same structural effect as Shift+Tab).

3. **Empty item + top level**
   - Exit list: unwrap to empty paragraph after list position.

4. **Cursor mid-text**
   - Split text at cursor into current/new item.
   - Nested list children remain on current item.
   - New item has canonical shape (paragraph child containing the split-off text).

"Empty" means first paragraph text (trimmed) is empty and no non-empty inline content.

---

## 10) Slash menu

### 10.1 Trigger
Slash menu opens only when all are true:
- Current block is `paragraph`.
- Selection is collapsed in first text node of paragraph.
- Text from paragraph start to cursor matches `^/.*$`.
- Cursor is at paragraph end (no trailing text after cursor).
- No active `[[` or `((` trigger (combobox exclusivity, I-5).

This intentionally disables mid-sentence slash command invocation.

### 10.2 Key handling
When slash menu active, intercept and `preventDefault` for:
- `ArrowUp`
- `ArrowDown`
- `Enter`
- `Tab`
- `Escape`

### 10.3 Dismissal
On Escape, the slash trigger state is cleared and the `/` text (plus any query characters) is deleted from the document. This prevents residual `/` text from re-triggering the menu on subsequent `handleChange` calls and keeps the document clean.

### 10.4 Commands (v1 flat set)
- Heading 1..6
- Bullet list
- Numbered list
- Task list
- Blockquote
- Code block
- Divider

### 10.5 Execution contract
On command selection:
1. Delete `/query` range.
2. Apply same transform functions used by autoformat.
3. Close menu.

Divider inserts thematic break + trailing empty paragraph, cursor in paragraph.

### 10.6 Component: `SlashCombobox`
Follows existing combobox pattern:
- floating-ui positioning relative to cursor.
- Arrow key navigation, Enter/Tab to select, Escape to dismiss.
- Fuzzy filtering as user types after `/`.

---

## 11) Strikethrough mark

`CustomText` adds:

```ts
strikethrough?: true;
```

Render in `renderLeaf` with `<del>`.

Serialization:
- `slate-to-mdast.ts`: map mark to mdast `delete` node (serialized as `~text~`).
- `mdast-to-slate.ts`: map mdast `delete` to `strikethrough: true` in marks accumulator (currently at line 262, the `delete` case drops to plain text — update to pass `{ ...marks, strikethrough: true }`).

Mark precedence:
- `code` remains exclusive (highest precedence).
- Non-code marks can combine (`bold`, `italic`, `strikethrough`).

---

## 12) Integration risks and mitigations

### Wikilink `[[` flow
The existing wikilink combobox deletes from `[[` anchor to cursor and inserts a void wikilink element. **Mitigation:** `[` excluded from auto-pairing; combobox exclusivity (I-5) prevents slash menu from interfering.

### Block ref `((` flow
Same pattern as wikilinks. `(` is not auto-paired. Combobox exclusivity applies.

### `withOutliner` normalizer bypass
`withOutliner` returns early for all list-items without calling `normalizeNode`. **Mitigation:** canonical shape contract (I-6); `withOutliner` fallback fix; test coverage for list-item shape after each transform.

---

## 13) Files

### New
- `ui/src/editor/plugins/autoformat/withAutoformat.ts`
- `ui/src/editor/plugins/autoformat/blockTransforms.ts`
- `ui/src/editor/plugins/autoformat/inlineTransforms.ts`
- `ui/src/editor/plugins/autoformat/autoPair.ts`
- `ui/src/editor/plugins/autoformat/listContinuation.ts`
- `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`
- `ui/src/editor/SlashCombobox.tsx`
- `ui/src/editor/__tests__/SlashCombobox.test.tsx`

### Modify
- `ui/src/editor/SlateEditor.tsx` (plugin wiring + slash trigger + keydown routing)
- `ui/src/editor/types.ts` (`strikethrough`)
- `ui/src/editor/elements/renderLeaf.tsx` (`<del>` rendering)
- `ui/src/editor/convert/slate-to-mdast.ts` (serialize `delete`)
- `ui/src/editor/convert/mdast-to-slate.ts` (deserialize `delete`)
- `ui/src/editor/convert/__tests__/slate-to-mdast.test.ts`
- `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`
- `ui/src/editor/convert/__tests__/round-trip.test.ts`
- `ui/src/editor/plugins/withOutliner.ts` (fix empty-children fallback to insert paragraph child)

---

## 14) Required test cases (minimum set)

### A. Regression guards
- **RG-01** Typing `[[abc` still opens wikilink combobox (no leftover auto-paired brackets).
- **RG-02** Typing a fence start (e.g. ` ```ts `) then Enter creates `code-block(language="ts")`.
- **RG-03** Typing `/` in `https://` does **not** open slash menu.

### B. Block transforms
- **BT-01** `#` + space → heading level 1.
- **BT-02** `######` + space → heading level 6.
- **BT-03** `1.` + space → numbered-list/list-item.
- **BT-04** `-` + space and `*` + space → bulleted-list/list-item.
- **BT-05** `>` + space → blockquote containing paragraph.
- **BT-06** Third `-` in empty paragraph (`---`) → thematic-break + trailing paragraph.
- **BT-07** Start-of-item `[ ]` + space in list-item sets `checked:false` and removes marker text.
- **BT-08** Start-of-item `[x]` + space in list-item sets `checked:true` and removes marker text.

### C. Inline transforms
- **IT-01** `*a*` → italic.
- **IT-02** `**a**` → bold (double-char disambiguation).
- **IT-03** `_a_` and `__a__` equivalents.
- **IT-04** `~a~` → strikethrough.
- **IT-05** `` `a` `` → code mark.
- **IT-06** `[x](https://a.b)` → link element.
- **IT-07** Mid-word `_` in `foo_bar` does not trigger italic.
- **IT-08** No inline transform inside `code-block`.
- **IT-09** Empty content `**` does not transform (content validity).

### D. Auto-pair/overtype
- **AP-01** Typing `*` inserts `*|*`.
- **AP-02** Typing second `*` in `*|*` yields `**|**` path for bold typing.
- **AP-03** Overtype at closer advances cursor; does not duplicate marker.
- **AP-04** Auto-pair skipped for mid-word `*` and `_`.
- **AP-05** Selection wrap with `*`, `_`, and `~` works in single text node.
- **AP-06** Typing `~` inserts `~|~`; typing text then `~` applies strikethrough.

### E. Enter/list continuation
- **LC-01** Enter in non-empty list-item creates next item with canonical shape.
- **LC-02** Enter in non-empty task item creates `checked:false` next item.
- **LC-03** Enter on empty nested item outdents once.
- **LC-04** Enter on empty top-level item exits to paragraph.
- **LC-05** Enter mid-item splits text into two items with canonical shape.

### F. Slash menu
- **SM-01** `/` at empty paragraph start opens menu.
- **SM-02** `/he` filters headings.
- **SM-03** Enter executes command and deletes `/query`.
- **SM-04** Arrow/Escape are intercepted while active.
- **SM-05** If `[[` trigger is active, slash menu remains inactive.
- **SM-06** Escape deletes `/` text and closes menu.

### G. Serialization
- **SZ-01** Slate `strikethrough` serializes to markdown `~text~`.
- **SZ-02** Markdown `~text~` deserializes to Slate `strikethrough:true`.
- **SZ-03** Round-trip preserves combined marks excluding code-precedence cases.

---

## 15) Definition of done

Implementation is complete when:
1. All invariants (I-1 through I-6) are satisfied.
2. Required tests A–G pass.
3. No regressions in existing wikilink/block-ref combobox behavior.
4. Manual QA confirms single-step undo for each autoformat action.
