# Wikilink Create CTA Design

## Goal

When the Slate wikilink combobox has no matching page for a non-empty query, replace the passive “No pages found” state with an actionable `Create “<query>”` row. Activating it creates or reuses a blank note in the background, inserts the wikilink at the current editor selection, and leaves the user in the source page.

## Decisions

- **Visibility:** show the create action only when the trimmed query is non-empty and the filtered page list has zero matches. Partial matches continue to occupy the chooser without an additional create row.
- **Interaction:** the create row is a normal combobox selection. Mouse click, Enter, and Tab all activate it; Arrow keys retain the existing suggestion behavior.
- **Result:** successful activation inserts the requested wikilink, closes the combobox, restores the editor flow, and does not open the target page.
- **Page shape:** create an empty `NOTE` whose title is the trimmed query. Generate its path with the existing canonical intake-path convention.
- **Race policy:** before creating, refresh link resolution and search for an exact title using the existing NFC-normalized, case-insensitive comparison. Reuse a target found by either check instead of creating a duplicate.
- **Failure policy:** do not insert the wikilink when target creation fails. Keep the combobox open, show a retryable inline error, and preserve the typed query.

## Existing behavior to reuse

`WikilinkElement` already resolves a dangling-link click through three steps:

1. Refresh the source page’s link resolution, covering index lag after a recent edit.
2. Search the index for an exact normalized title match.
3. Create an empty note with `useCreatePage`, `intakePath`, and `generateShortId` only when the target remains unresolved.

The combobox CTA must not introduce a second creation convention. Extract this sequence into a shared resolve-or-create hook used by both the existing dangling-link click and the new combobox action. The caller decides what happens after resolution: dangling-link clicks open the returned path; the combobox inserts a link and stays in the current editor.

## Component design

### Shared target resolver

Add an editor-level hook exposing one operation:

```ts
resolveOrCreate(target: string): Promise<{ path: string; title: string }>
```

The operation:

- trims the target and rejects an empty title;
- asks `useWikilinkResolution().refetchAndLookup(target)` for a fresh resolved path;
- searches `/api/vault/index/search?q=<target>` and accepts only an exact NFC-normalized, case-insensitive title match;
- otherwise builds the canonical `NOTE` intake path, creates `{ title: target }` with an empty body, and returns that path;
- prevents duplicate concurrent submissions for the same mounted caller;
- propagates failures so each caller can render or preserve its appropriate state.

The exact-title normalization helper moves with this shared contract. `WikilinkElement` removes its local search/create implementation and opens the path returned by the shared resolver.

### `WikilinkCombobox`

Represent the zero-result CTA as a synthetic suggestion item rather than a separate passive `emptyMessage`. This preserves the existing `EditorSuggestionPopover` keyboard and mouse semantics without adding a second selection system.

- Existing matches map to page suggestion items.
- Zero matches plus a non-empty trimmed query maps to one create suggestion item.
- Empty/whitespace-only queries keep a non-actionable prompt and never create an untitled page.
- The create row reads `Create “<trimmed query>”` and exposes pending or failed state supplied by the editor.
- While pending, repeat activation is ignored.

`WikilinkCombobox` reports page selection and create selection through distinct callbacks. It remains responsible for filtering and presentation, not API mutation.

### `SlateEditor`

`SlateEditor` owns the create-action lifecycle because it owns the active trigger and Slate selection.

- Call the shared resolver with the trimmed query.
- On success, replace the active `[[...` trigger range with a wikilink node targeting the requested title, using the same insertion transform as a normal page selection.
- Close the combobox only after successful resolution or creation.
- Keep the editor on the source page; do not call `useOpenTab`.
- Track pending and error state per active query. Clear stale error state when the query changes or the combobox closes.
- Guard the async completion against a changed or closed trigger so an old request cannot insert into a later selection.

## Data flow

1. The user types `[[New Topic`.
2. `SlateEditor` derives the trigger query and passes it to `WikilinkCombobox`.
3. Filtering returns zero matches, so the combobox renders `Create “New Topic”` as its only selectable row.
4. Click, Enter, or Tab calls the create callback.
5. The shared resolver refreshes resolution, checks an exact title search match, then creates an empty canonical `NOTE` only if still unresolved.
6. On success, `SlateEditor` inserts `[[New Topic]]`, closes the chooser, and continues editing the source page.
7. Normal mutation invalidation makes the target available to index-backed views and later wikilink resolution.

## Error handling and concurrency

- A whitespace-only query cannot create a page.
- A lagging index cannot cause a duplicate when refresh or exact-title search finds the target.
- A double click or repeated Enter/Tab while pending issues one resolve-or-create operation.
- A failed search or create request leaves the query and chooser intact, displays a concise failure state, and permits retry.
- An async result belonging to a trigger that was closed or replaced is ignored for Slate insertion. A successfully created page remains valid even when its stale UI completion is ignored.
- Existing dangling-link click behavior remains best-effort: it continues to leave the link dangling on failure.

## Testing

### Shared resolver

- returns a freshly resolved path without searching or creating;
- reuses an exact NFC-normalized, case-insensitive title match;
- creates one empty canonical `NOTE` when unresolved;
- rejects an empty target;
- propagates search and creation failures;
- suppresses duplicate concurrent submissions.

### `WikilinkCombobox`

- shows the create row only for a non-empty zero-match query;
- does not show it when partial matches exist;
- does not offer creation for an empty query;
- activates creation by mouse, Enter, and Tab through existing popover selection semantics;
- renders pending and error states without losing the query.

### `SlateEditor`

- successful background creation inserts the requested wikilink and leaves the current page open;
- failure inserts nothing and keeps the combobox available for retry;
- stale async completion does not mutate a changed selection.

### Existing dangling link

- retained tests prove refreshed and exact-title targets are reused;
- creation still opens the returned path;
- failure still leaves the link dangling.

## Out of scope

- Showing a create action alongside partial matches.
- Creating folders, projects, journals, or non-`NOTE` kinds from the combobox.
- Opening or focusing the newly created page.
- Adding aliases, tags, project assignment, body templates, or metadata beyond the title.
- Changing unresolved-wikilink diagnostics, LSP code actions, or non-Slate relation editors.
