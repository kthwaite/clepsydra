# Editor Autoformat Layer & Slash Menu (v2)

**Date:** 2026-03-13  
**Status:** Draft (tightened for implementation)

This is a tightened replacement spec for `2026-03-13-editor-autoformat-design.md`.
It resolves ordering ambiguity, reduces feature-conflict risk, and defines explicit invariants + tests.

---

## 1) Scope

### In scope (v2)
- Autoformat plugin for block + inline transforms.
- Enter-key list continuation + blockquote/code-fence behavior.
- Slash command menu for block transforms.
- New `strikethrough` mark end-to-end (render + md serialization).

### Explicitly out of scope (v2)
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

### I-6 List-item shape contract (v2)
Autoformat-generated list items must be:
- `list-item.children[0]` = `paragraph`
- optional additional children = nested lists only

Legacy mixed shapes are tolerated, but new transforms should write canonical shape.

---

## 4) `insertText` pipeline (exact order)

For each typed character `ch`:

1. **Try overtype**
   - If cursor is directly before same char and char is one of `*`, `_`, `~`, `` ` ``, `]`, `)`, move cursor past it.
   - If overtype occurred, attempt inline transform (step 4 logic only) and then return.

2. **Immediate thematic-break trigger** (`---`)
   - If `ch === "-"` and paragraph text before cursor is exactly `"--"` and cursor at end of block: convert to thematic break; return.

3. **Space-triggered block transforms**
   - If `ch === " "`, run paragraph/list-item prefix checks (Section 5) in defined order.
   - First match wins; return.

4. **Inline transform**
   - If `ch` can close an inline pattern (`*`, `_`, `~`, `` ` ``, `)`), attempt inline transform (Section 6).
   - If matched, apply and return.

5. **Auto-pair**
   - If `ch` is supported opener (`*` or `_` only in v2), try auto-pair (Section 7).
   - If paired/wrapped, return.

6. **Fallback**
   - Call original `insertText(ch)`.

No other implicit paths. This order is normative.

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

This is the only task-list autoformat path in v2.

### 5.3 Special block triggers

### `---` immediate
- On third `-` in paragraph-start context (`"--"` before cursor):
  - replace paragraph with `thematic-break`
  - insert following empty paragraph
  - place cursor in new paragraph

### Triple-backtick fence on Enter
Handled in `insertBreak` only.

When current block is paragraph and full text matches:
- ````^```([A-Za-z0-9_-]+)?$````

Action:
- convert paragraph to `code-block`
- set `language` when capture exists
- clear content to empty text leaf
- place cursor at offset 0 in code-block

### 5.4 List merge policy (deterministic)

When creating a new list-item from a paragraph:
1. If both previous and next siblings are same list type:
   - insert item into previous list tail
   - move next list’s children into previous list
   - remove next list
2. Else if previous sibling is same list type:
   - append to previous list
3. Else if next sibling is same list type:
   - prepend to next list
4. Else:
   - create new list wrapper containing item

---

## 6) Inline transforms

Only within one text node.

| Markdown pattern | Result |
|---|---|
| `**text**` | `bold` |
| `*text*` | `italic` |
| `__text__` | `bold` |
| `_text_` | `italic` |
| `~~text~~` | `strikethrough` |
| `` `text` `` | `code` |
| `[text](url)` | `link` element |

### 6.1 Opener validity
An opener is valid only if:
- it is at text start, or
- previous char is whitespace.

(Prevents mid-word triggers like `foo_bar_baz`.)

### 6.2 Closer disambiguation
For `*`, `_`, `~`:
- If preceding char equals typed char, treat closer as double-char (`**`, `__`, `~~`).
- Else treat as single-char (`*`, `_`, `~`).

Search for matching opener of the same width; do not downgrade double to single in same attempt.

### 6.3 Content validity
Do not transform if content between opener/closer is empty.

### 6.4 Link transform (`[text](url)`)
Trigger: typed `)`.

Parse nearest suffix ending at cursor with shape:
- `[...] (...)` contiguous, no newline in either segment.

Action:
1. Delete full markdown substring.
2. Insert `link` element with parsed URL and inline text children.
3. Cursor moves after inserted link.

---

## 7) Auto-pair and overtype

### 7.1 Auto-pair enabled chars (v2)
- `*`
- `_`

### 7.2 Auto-pair disabled in v2
- `~` (still supported for inline transform as `~~...~~`)
- `` ` ``
- `[`
- `(`

### 7.3 Pairing rules
For enabled chars:
- Collapsed selection: insert opener + closer, place cursor between.
- Non-collapsed selection (single text node only): wrap selection.

### 7.4 Skip auto-pair when
- In `code-block`.
- Active mark `code`.
- Immediately before same character.
- For `*`/`_`: previous char is non-whitespace (mid-word).

### 7.5 Overtype
If cursor is directly before same closing marker character, advance cursor instead of inserting duplicate.

---

## 8) `insertBreak` behavior (exact order)

1. If inside `list-item`: run list continuation logic (Section 9) and return if handled.
2. Else if inside `blockquote`: newline paragraph inside quote; empty paragraph exits quote.
3. Else if paragraph matches triple-backtick fence: convert to code-block (Section 5.3).
4. Else fallback to original `insertBreak`.

---

## 9) List continuation rules

Inside `list-item` on Enter:

1. **Non-empty item**
   - Create next sibling list-item.
   - If current item is task (`checked` present), new item gets `checked: false`.
   - Cursor in new item start.

2. **Empty item + nested level**
   - Outdent one level (same structural effect as Shift+Tab).

3. **Empty item + top level**
   - Exit list: unwrap to empty paragraph after list position.

4. **Cursor mid-text**
   - Split text at cursor into current/new item.
   - Nested list children remain on current item.

"Empty" means first paragraph text (trimmed) is empty and no non-empty inline content.

---

## 10) Slash menu (tightened trigger semantics)

### 10.1 Trigger
Slash menu opens only when all are true:
- Current block is `paragraph`.
- Selection is collapsed in first text node of paragraph.
- Text from paragraph start to cursor matches `^/.*$`.
- Cursor is at paragraph end (no trailing text after cursor).
- No active `[[` or `((` trigger.

This intentionally disables mid-sentence slash command invocation in v2.

### 10.2 Key handling
When slash menu active, intercept and `preventDefault` for:
- `ArrowUp`
- `ArrowDown`
- `Enter`
- `Tab`
- `Escape`

### 10.3 Commands (v1 flat set)
- Heading 1..6
- Bullet list
- Numbered list
- Task list
- Blockquote
- Code block
- Divider

### 10.4 Execution contract
On command selection:
1. Delete `/query` range.
2. Apply same transform functions used by autoformat.
3. Close menu.

Divider inserts thematic break + trailing empty paragraph, cursor in paragraph.

---

## 11) Strikethrough mark

`CustomText` adds:

```ts
strikethrough?: true;
```

Render in `renderLeaf` with `<del>`.

Serialization:
- `slate-to-mdast.ts`: map mark to mdast `delete` node.
- `mdast-to-slate.ts`: map mdast `delete` to `strikethrough: true` in marks accumulator.

Mark precedence:
- `code` remains exclusive (highest precedence).
- non-code marks can combine (`bold`, `italic`, `strikethrough`).

---

## 12) Files

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

---

## 13) Required test cases (minimum set)

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
- **IT-04** `~~a~~` → strikethrough.
- **IT-05** `` `a` `` → code mark.
- **IT-06** `[x](https://a.b)` → link element.
- **IT-07** Mid-word `_` in `foo_bar` does not trigger italic.
- **IT-08** No inline transform inside `code-block`.

### D. Auto-pair/overtype
- **AP-01** Typing `*` inserts `*|*`.
- **AP-02** Typing second `*` in `*|*` yields `**|**` path for bold typing.
- **AP-03** Overtype at closer advances cursor; does not duplicate marker.
- **AP-04** Auto-pair skipped for mid-word `*` and `_`.
- **AP-05** Selection wrap with `*` and `_` works in single text node.

### E. Enter/list continuation
- **LC-01** Enter in non-empty list-item creates next item.
- **LC-02** Enter in non-empty task item creates `checked:false` next item.
- **LC-03** Enter on empty nested item outdents once.
- **LC-04** Enter on empty top-level item exits to paragraph.
- **LC-05** Enter mid-item splits text into two items.

### F. Slash menu
- **SM-01** `/` at empty paragraph start opens menu.
- **SM-02** `/he` filters headings.
- **SM-03** Enter executes command and deletes `/query`.
- **SM-04** Arrow/Escape are intercepted while active.
- **SM-05** If `[[` trigger is active, slash menu remains inactive.

### G. Serialization
- **SZ-01** Slate `strikethrough` serializes to markdown `~~text~~`.
- **SZ-02** Markdown `~~text~~` deserializes to Slate `strikethrough:true`.
- **SZ-03** Round-trip preserves combined marks excluding code-precedence cases.

---

## 14) Definition of done

Implementation is complete when:
1. All invariants above are satisfied.
2. Required tests A–G pass.
3. No regressions in existing wikilink/block-ref combobox behavior.
4. Manual QA confirms single-step undo for each autoformat action.
