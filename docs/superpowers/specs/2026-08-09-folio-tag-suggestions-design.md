# Folio Tag Suggestions Design

## Goal

Give the folio tag editor the same suggestion interaction as the New Entry modal while retaining the folio editor's existing appearance, derived-tag handling, blur-save behavior, and support for creating new tags.

## Architecture

Extend the existing `TagInput` component with an optional `suggestions` prop. The component remains usable without suggestions, so the aliases editor and existing callers keep their current behavior.

`Folio` will load the vault tag index through the existing `useTags` query, map the response to tag names, and pass those names through `PageEditorHeader` to the tag `TagInput`. The aliases `TagInput` will not receive suggestions.

No API or backend change is required.

## Interaction

While the user types a non-empty draft, the folio tag editor will:

- filter known tags case-insensitively using the same substring matching as New Entry;
- omit editable and derived tags already attached to the folio;
- show at most the existing New Entry suggestion limit;
- expose suggestions as an accessible listbox associated with the combobox input;
- highlight the first match initially;
- move the highlight with Arrow Up and Arrow Down;
- complete the highlighted match with Tab;
- commit the highlighted match with Enter after arrow navigation;
- dismiss the list with Escape without propagating that Escape to surrounding UI.

Existing behavior remains unchanged where it does not conflict with suggestions:

- plain Enter commits the raw draft;
- comma commits the raw draft;
- blur commits the raw draft and triggers the folio save flush;
- empty Tab moves focus normally;
- Backspace on an empty draft removes the last editable tag;
- arbitrary new tags remain valid.

## Components

### `Folio`

Call `useTags`, derive `string[]` suggestions from the tag index, and pass them to `PageEditorHeader`.

### `PageEditorHeader`

Add a `tagSuggestions` prop and forward it only to the `Tags` input. Do not pass it to `Aliases`.

### `TagInput`

Add optional suggestion state and accessible combobox/listbox rendering. Keep suggestion behavior dormant when no suggestions are provided.

## Error and Loading Behavior

The existing query semantics apply. Before the tag index loads, or if it is unavailable, the folio tag editor continues to accept new tags without suggestions. Tag editing and saving do not depend on the index request succeeding.

## Verification

Component tests will cover filtering, exclusion of existing and derived tags, keyboard highlight/completion, Escape dismissal, and preservation of raw tag entry. Header or folio tests will verify that vault tag suggestions reach the tag editor and not the aliases editor.

A browser smoke test will open a folio, type a partial known tag, verify the suggestion list appears, select a suggestion by keyboard, and confirm the selected tag is present in the editor.
