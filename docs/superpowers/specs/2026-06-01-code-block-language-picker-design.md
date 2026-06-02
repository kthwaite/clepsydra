# Code-block language picker — design

**Date:** 2026-06-01
**Status:** Approved (brainstorming → ready for plan)

## Problem

Code blocks in the Slate editor display their syntax-highlighting language as
read-only text in the block header (`ui/src/editor/elements/CodeBlockElement.tsx:14-15`).
The language can only be set at creation time via the markdown fence (```` ```lang ````),
parsed by `tryCodeFence()` in `ui/src/editor/plugins/autoformat/blockTransforms.ts:384-411`.
There is no UI affordance to change or clear the language afterwards — the user
must edit the underlying source.

We want an interactive control to pick the language, and to reset it, directly
from the rendered code block.

## Decisions

> **Post-implementation correction (2026-06-01):** the "~270 registered
> grammars" figure below was wrong. The *common* refractor bundle we import
> registers only **38 distinct grammars** (and notably omits `tsx`/`jsx`). The
> searchable popover remains the right control, but the sizing rationale was
> inaccurate. Resolution: we kept the lightweight common bundle and explicitly
> registered `jsx`/`tsx` on top (see `ui/src/editor/refractor-languages.ts`);
> the `plaintext` family is excluded from the list since the "Plain text" reset
> row covers it. Switching to `refractor/all` (~292 grammars) remains the lever
> if broader coverage is wanted later.

These were settled during brainstorming:

1. **Control style:** a searchable popover anchored to the language label —
   a type-to-filter, keyboard-navigable list. Chosen over a short dropdown or
   inline text field because refractor supports many registered grammars.
2. **Language scope:** a curated set of common languages pinned at the top,
   with search across the full set.
3. **Reset:** a single **Plain text** entry in the picker that clears
   `element.language` (renders as `TXT`, no highlighting). No separate ✕ affordance.
4. **Searchable set = registered set:** the picker is driven by
   `refractor.listLanguages()` (the ~270 grammars already bundled via the common
   `refractor` import). Every option in the picker genuinely highlights; no
   bundle-size change, and the picker never lists a language the highlighter
   can't render.

## Behaviour

- The language label at the top-right of each code block becomes a clickable
  trigger (a `<button>`), replacing the static `<span>`.
- Clicking it opens a floating popover anchored to the label:
  - an autofocused search input;
  - below it, a keyboard-navigable list (↑/↓ to move, Enter/Tab to select,
    Esc to dismiss);
  - the curated common languages are shown first when the filter is empty;
    typing filters across all registered grammars;
  - a **Plain text** entry resets the block (clears `language`).
- Selecting any item closes the popover and writes the change.
- Click-outside also dismisses the popover.

## Components

### New: `ui/src/editor/code-languages.ts`

Pure, no React, unit-testable.

- A hardcoded `COMMON` ordering of common language ids
  (e.g. `typescript`, `javascript`, `tsx`, `jsx`, `python`, `rust`, `go`,
  `bash`, `json`, `html`/`markup`, `css`, `sql`, `yaml`, `toml`, `markdown`).
- `listLanguageIds()` — returns the registered set from
  `refractor.listLanguages()`, with `COMMON` pinned to the front (deduped),
  the remainder following (alphabetical).
- `filterLanguages(query)` — case-insensitive substring filter over that list;
  empty query returns the curated-first ordering.
- `displayLabel(id)` — uppercase display label for the header/list
  (mirrors the existing `lang.toUpperCase()` behaviour).

### New: `ui/src/editor/elements/CodeLangPicker.tsx`

Self-contained popover. Modeled on the conventions in
`ui/src/components/ui/editor-suggestion-popover.tsx` (same floating-ui
middleware — `offset(6)`, `flip()`, `shift({ padding: 8 })`, `bottom-start`,
fixed strategy — and the same Vessel popover styling: `border border-border
bg-popover shadow-md`, zero radius, `role="listbox"`/`role="option"`,
`aria-activedescendant`). It differs by owning an integrated search input;
the existing `EditorSuggestionPopover` assumes the query arrives from the editor
keystream, which does not fit a standalone control, so we do not reuse it
directly.

Props:

```ts
interface CodeLangPickerProps {
  value: string | null;            // current language, null = plain text
  reference: HTMLElement | null;   // the label button to anchor to
  onSelect: (lang: string | null) => void; // null = reset to plain text
  onClose: () => void;
}
```

Internal state: `query` (search text) and `selectedIndex` (active row).
Items come from `filterLanguages(query)`, with the **Plain text** reset entry
included in the list. Letter keys flow to the input; ↑/↓/Enter/Tab/Esc drive
navigation/selection. Autofocus the input on open.

### Edit: `ui/src/editor/elements/CodeBlockElement.tsx`

- Hold `open` state (`useState`).
- Render the right-side label as a `<button>` trigger inside the header
  (header stays `contentEditable={false}`); keep the `Code` label and the
  accent-coloured language text.
- Resolve the node path with `useSlateStatic()` + `ReactEditor.findPath(editor, element)`.
- On select: `Transforms.setNodes(editor, { language }, { at: path })`;
  on reset: `Transforms.setNodes(editor, { language: undefined }, { at: path })`
  — following the existing transform pattern
  (`ui/src/editor/plugins/autoformat/blockTransforms.ts:411`,
  `renderElement.tsx` checkbox toggle).
- Render `<CodeLangPicker>` when `open`, passing the label button as `reference`.

## Data flow

Pick → `Transforms.setNodes` mutates `element.language` → Slate re-renders the
block → `decorateCode` (`ui/src/editor/decorate-code.ts:38`) re-tokenizes
(or returns `[]` when cleared) → highlighting updates live. No new state store;
the Slate node is the single source of truth.

## Edge cases

- Empty filter → curated common list.
- No matches → an empty message row; the **Plain text** entry remains reachable.
- Reset then re-pick is symmetric (`language: undefined` ↔ `language: id`).
- Picker only lists registered grammars, so every selectable option highlights.
- Clicking the trigger must not move the editor selection into the block
  (header is already `contentEditable={false}`; use `onMouseDown` preventDefault
  where appropriate, as the suggestion popover does).

## Testing

- **`code-languages.ts` unit tests:** curated-first ordering, `filterLanguages`
  substring matching (case-insensitive, empty query), `displayLabel`.
- **Slate transform test:** without `withReact` (per the project's editor-testing
  approach) — assert that applying the select transform sets `language` and the
  reset transform clears it; assert `decorateCode` returns `[]` for a cleared
  block and non-empty ranges for a set language.
- **Optional:** a Storybook story for `CodeLangPicker` demonstrating filter and
  keyboard navigation.

## Out of scope

- Changing how the markdown fence parses the initial language.
- Switching to `refractor/all` (the full ~297-grammar bundle) — deferred unless
  the long tail is needed.
- Persisting a per-user "favourite languages" list.
