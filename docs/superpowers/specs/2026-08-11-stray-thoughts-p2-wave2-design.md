# Clepsydra Stray Thoughts P2 Wave 2 Design

**Date:** 2026-08-11
**Status:** Approved program slice
**Source:** `Clepsydra: Stray Thoughts`
**Parent:** `docs/superpowers/specs/2026-08-11-stray-thoughts-p2-program-design.md`

## Goal

Complete the three RSS P2 items as one independently releasable slice:

1. replace free-text RSS group fields with suggestion-backed editable comboboxes;
2. make subscription groups and feed rows persistently collapsible;
3. replace inline full-reader expansion with a responsive list-and-reader surface.

The existing `feeds.md` manifest, feed database, revision compare-and-swap mutations, sanitized stored HTML, and URL search state remain authoritative. The work does not introduce an iframe, source-page fetching, a second group registry, or domain state in browser storage.

## Current architecture

- `src/routes/feeds.tsx` owns `/feeds` filter search state and switches between the river and subscription management.
- `src/components/codex/FeedRiver.tsx` owns infinite entry pagination, optimistic entry mutations, inline expansion, and compact Atrium rendering.
- `src/components/codex/FeedManagement.tsx` owns subscribe/edit/delete/import/export controls. Subscribe and edit currently use plain group inputs, and all groups and rows remain expanded.
- `src/api/feeds.ts` maps generated OpenAPI hooks and maintains feed-entry optimistic caches.
- `src/api/feeds.rs` exposes entry listing and patching, but no entry-detail read route. A URL-addressed selection therefore cannot reliably load an entry outside the currently fetched pages.
- `src/feeds/store.rs` already has an ID lookup used by entry patching. The backend stores sanitized `content_html`; oversized or unavailable bodies are represented by `None`.

## Group picker

### Shared control

Add a small RSS-specific editable combobox and use it in both `SubscribeForm` and `EditFeedDialog`. It follows the repository's existing React Aria `ComboBox` pattern:

- `allowsCustomValue` remains enabled;
- current manifest group names are the only suggestions;
- matching is trimmed and ASCII case-insensitive, mirroring `feeds::manifest` group lookup;
- suggestions are deduplicated case-insensitively while retaining the first manifest spelling and manifest order;
- choosing a suggestion commits that exact canonical spelling;
- committing a nonmatching non-empty draft creates a new group through the existing mutation;
- an empty draft remains `null`, preserving the current default/ungrouped mutation semantics;
- Enter, blur, and listbox selection commit once; Escape dismisses the popup without discarding the draft.

The control is presentational. It receives `groups`, `value`, and `onChange`; it owns only the live text draft and popup state. It does not mutate the manifest itself.

### Mutation and conflict behavior

Subscribe and edit continue to call `useSubscribeFeed` and `useUpdateFeed`. Those hooks continue to inject the latest cached manifest revision. On a 409 or other mutation failure:

- the form/dialog stays mounted;
- URL/title/group drafts remain unchanged;
- the existing mutation alert remains visible;
- retry repeats the same user-selected group against the newly loaded manifest revision only after the normal query invalidation/refetch path has completed.

No frontend group entity or immediate `feeds.md` write is added.

## Disclosure preferences

### Storage contract

Add a dedicated `feedDisclosure` preference module rather than expanding the general UI store. `FeedListResponse` gains an opaque `preference_namespace`: a domain-separated BLAKE3 digest of the canonical configured vault root, never the raw path. Persist versioned JSON in local storage under `clepsydra.feeds.disclosure.<preference_namespace>`. Moving a vault intentionally resets this presentation preference; serving another vault from the same origin cannot inherit it.

The value contains only collapsed identities:

```ts
{
  version: 1,
  groups: string[],
  feeds: number[]
}
```

Group identity is `trim().toLocaleLowerCase("en-US")`; feed identity is the stable numeric feed ID. The namespace selects the vault-specific storage slot. Domain data, titles, URLs, revisions, root paths, and entry state are never persisted.

Reads are defensive. Missing storage, malformed JSON, an unknown version, storage exceptions, or invalid element types resolve to empty sets, which means all disclosures are expanded. Writes catch storage exceptions and leave the in-memory interaction usable.

### Reconciliation and pruning

Whenever a successful manifest value is available, reconcile the stored sets against the live normalized group identities and feed IDs. Remove obsolete values and write only when the normalized preference changed. Duplicate or differently cased group keys collapse to one normalized identity.

This is opportunistic cleanup, not a manifest mutation. Loading and manifest-error states do not erase preferences because there is no authoritative live set to reconcile against.

### Accessible management structure

Each manifest group becomes a React Aria `Disclosure` whose trigger exposes the group name, feed count, and expanded state. Each feed becomes a nested `Disclosure`:

- the collapsed feed summary retains title, URL, health indicator, last/next fetch, error count, and tags;
- edit and unsubscribe actions move into the feed disclosure panel;
- the last-error detail also lives in the panel;
- group collapse hides its feed list without changing individual feed preferences;
- re-expanding a group restores each feed's prior state.

Pointer press, Enter, and Space use React Aria disclosure semantics. Preference updates happen from controlled `onExpandedChange` callbacks.

## Entry detail API

Add `GET /api/vault/feeds/entries/{id}` beside the existing PATCH route. It returns `FeedEntryDto` from the feed store's existing ID lookup and maps absence to the established 404 API error. The route:

- reads only the local feed database;
- performs no network request and schedules no refresh;
- returns the same already-sanitized `content_html` and metadata shape used by the list endpoint;
- is included in OpenAPI and the generated TypeScript client.

Add a `useFeedEntry(id)` query hook keyed by the generated detail route. It is disabled for no selection. Successful entry patches update or invalidate both detail and list caches so bookmark/read/tag controls remain coherent.

## Split reader

### URL state

Extend `/feeds` search validation with optional positive integer `entry`. Filters remain unchanged. Selecting a row navigates with `entry: id`; closing/back-to-list removes only `entry`. Filter changes preserve a valid selection until the selected entry is proven unavailable.

A detail 404 clears only `entry` with a replace navigation. Network/server errors keep the selection and show an explicit retry state; they are not treated as proof that the entry was pruned.

### River behavior

The full `/feeds` river changes from inline content disclosures to a selectable entry list. `FeedRiver` receives `selectedEntryId` and `onSelectEntry` for the full route. Selection:

- marks an unread entry read through the existing optimistic mutation path;
- updates the URL without changing `view`, `group`, `feed`, `tag`, or `manage`;
- does not recreate the infinite query, discard fetched pages, or reset the river scroll container;
- exposes `aria-current` on the selected row.

The compact Atrium `FeedRiver` keeps its current inline disclosure behavior and full-reader link. This avoids forcing route-owned detail state into the dashboard card.

### Desktop layout

At the existing desktop breakpoint, the feed content card becomes a two-column grid:

- left: bounded-width river with its own vertical scroll container, pagination, day headings, and selected-row state;
- right: independently scrolling reader pane with a sticky pane header;
- no selection: a quiet instruction to select an entry;
- selection: title, source/feed name when known, author, timestamp, tags, stored body, and actions.

Stored `content_html` is rendered with the existing `feed-entry-content` presentation. The backend sanitizer remains the trust boundary. The pane never creates an iframe, calls the source URL, or performs client-side extraction. `Open original` is a normal explicit `target="_blank" rel="noreferrer"` link after the existing HTTP(S)-only URL check.

When `content_html` is absent, the pane still renders all available metadata and the original link. The current storage model has no independent excerpt column; therefore no unstored or reconstructed excerpt is claimed. If a bounded stored excerpt is added later, the pane may render it without changing selection behavior.

### Mobile layout

Below the desktop breakpoint:

- no selection shows the normal river;
- a selection shows only the reader pane;
- the pane begins with an explicit **Back to entries** action that removes only `entry`;
- browser Back/Forward naturally traverses list/detail history because selection is URL state.

The list remains mounted but visually hidden only if doing so is required to preserve scroll and loaded pages; it must not remain keyboard- or screen-reader-focusable while hidden. Prefer CSS responsive visibility with `hidden`/`lg:block` semantics over conditional unmounting so pagination and scroll survive list-to-detail transitions.

## Reader actions and consistency

Reader actions reuse `usePatchFeedEntry` for read, bookmark, and tags. The selected detail result is reconciled from mutation responses, while existing optimistic list caches update immediately. A tag editor remains available in the reader pane. Mutation failure preserves the current selection and draft and exposes the existing local error treatment.

If filtering to `unread` removes the selected row after it is marked read, the reader selection remains valid: URL selection and detail identity are independent from list membership. It is cleared only by explicit close/back or a detail 404.

## Error and edge cases

- Empty or whitespace group drafts preserve existing null/default behavior.
- Case-only group matches use the stored manifest spelling rather than creating a duplicate heading.
- Manifest mutation conflicts retain all form fields and the chosen group.
- Corrupt or unavailable local storage defaults to expanded sections.
- Manifest fetch errors never prune disclosure state.
- Entry detail 404 clears only `entry`; transient errors retain it and offer retry.
- A selected entry outside loaded river pages still opens through the detail endpoint.
- A selected read entry remains readable while the `unread` filter hides it.
- Missing stored body renders metadata and **Open original**, not an iframe or hidden network request.
- Invalid/non-HTTP(S) original URLs are not rendered as links.

## Test contract

### Backend and API

- store/detail lookup returns the exact entry and reports missing IDs;
- the feed-list preference namespace is stable for one canonical root, differs across roots, and does not expose the root path;
- GET entry detail returns 200/404 and never schedules refresh work;
- OpenAPI contains GET and PATCH on the same entry path;
- generated client exposes the detail query;
- detail cache and list caches remain coherent after patch mutations.

### Group control

- suggestions are case-insensitively deduplicated and filtered;
- keyboard and pointer selection commit the stored spelling once;
- a novel value commits once and reaches the existing mutation;
- subscribe/edit conflicts leave the complete draft visible.

### Disclosure preferences

- pointer and keyboard toggle group/feed disclosures;
- state survives component remount and storage reinitialization;
- group collapse does not erase nested feed state;
- obsolete group/feed identities are pruned only after successful manifest reconciliation;
- malformed/unavailable storage degrades to expanded.

### Reader

- selecting an entry changes only the `entry` search key;
- direct URL selection loads an entry not present in fetched river pages;
- selection does not reset loaded pages or the list scroll position;
- read/bookmark/tag changes stay coherent in list and pane;
- stored sanitized content renders at desktop and mobile widths;
- missing content renders metadata/original fallback;
- 404 clears only selection; transient detail failure retains selection and retries;
- no iframe is rendered and no request targets the source article;
- mobile detail has an explicit return action and browser history works.

## Verification and delivery

Use one isolated Wave 2 worktree. Each task begins with a failing behavioral test and commits independently. Task-scoped review follows each implementation; a final branch review covers cross-task integration.

Required gates:

- focused Rust and UI tests;
- `cargo fmt --check`;
- `cargo clippy --all-targets --all-features -- -D warnings`;
- full `cargo test`;
- OpenAPI regeneration and generated-client type verification;
- UI typecheck;
- UI lint;
- full UI tests;
- production UI build;
- desktop and mobile browser smoke tests against a disposable vault.

After the verified branch merges to `develop`, remove its worktree and branch. Only then mark the three corresponding `Clepsydra: Stray Thoughts` checkboxes complete through the vault MCP.