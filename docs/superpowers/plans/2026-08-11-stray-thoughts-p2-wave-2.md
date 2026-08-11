# Stray Thoughts P2 Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add suggestion-backed RSS groups, persistent accessible subscription disclosures, and a URL-addressed responsive split reader.

**Architecture:** Extend the existing feed API with a local entry-detail read and opaque vault preference namespace, keep group mutations on the manifest CAS path, persist only collapsed presentation identities, and make `/feeds` own selected-entry URL state while `FeedRiver` retains its infinite query and optimistic mutation machinery.

**Tech Stack:** Rust, Axum, SQLite, Utoipa/OpenAPI, React 19, TypeScript, TanStack Router, TanStack Query, React Aria Components, Vitest, Testing Library, Bun, Vite.

## Global constraints

- Work in one isolated feature worktree created from the current `develop` commit.
- `feeds.md`, the feed SQLite store, and manifest revision/CAS mutations remain authoritative.
- Browser storage may contain only collapsed group/feed identities, namespaced by an opaque backend-provided vault key.
- All rendered feed HTML is the stored sanitizer output. Never add an iframe, source-article fetch, or client reader extraction.
- URL search is authoritative for selected entry and existing filters.
- Detail 404 clears only selection; transient errors retain selection and expose retry.
- Full `/feeds` uses list-to-pane selection. Compact Atrium rendering keeps its existing inline disclosure behavior.
- Every new control must be keyboard operable, accessibly named, and usable at mobile breakpoints.
- Follow TDD: run every named test red before implementation, green after implementation, then commit.
- Do not run project-wide formatters, linters, builds, or full suites inside implementation tasks. Run shared gates once in Task 5.
- Preserve unrelated changes. Do not edit the source vault directly.

## File structure

- Modify `src/api/feeds.rs` — expose vault preference namespace and GET entry detail beside PATCH.
- Modify `src/api/mod.rs` or the repository's OpenAPI registration site only if required to register the new operation.
- Modify `src/feeds/store.rs` only if the existing entry lookup is not public enough for the API handler.
- Modify `tests/api_feeds.rs` — detail 200/404 and namespace contracts.
- Modify `ui/src/api/schema.d.ts` — regenerate from the live OpenAPI endpoint; never hand-edit.
- Modify `ui/src/api/feeds.ts` — detail query and detail/list mutation coherence.
- Modify `ui/src/api/feeds.test.ts` — query and optimistic cache contracts.
- Create `ui/src/components/codex/FeedGroupComboBox.tsx` and `.test.tsx` — accessible editable group control.
- Modify `ui/src/components/codex/FeedManagement.tsx` and `.test.tsx` — use group control and preserve conflict drafts.
- Create `ui/src/store/feedDisclosure.ts` and `.test.ts` — defensive versioned persistence and reconciliation.
- Modify `ui/src/components/codex/FeedManagement.tsx` and `.test.tsx` — controlled group/feed disclosures.
- Create `ui/src/components/codex/FeedReaderPane.tsx` and `.test.tsx` — stored-content reader and detail actions.
- Modify `ui/src/components/codex/FeedRiver.tsx` and `.test.tsx` — full-reader selection mode while retaining compact expansion.
- Modify `ui/src/routes/feeds.tsx` and `ui/src/routes/-feeds.test.tsx` — route entry state and responsive composition.

---

### Task 1: Entry detail API and vault preference namespace

**Files:**
- Modify: `src/api/feeds.rs`
- Modify: `src/feeds/store.rs` only if necessary
- Modify: OpenAPI registration file only if compilation identifies one
- Modify: `tests/api_feeds.rs`
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/feeds.ts`
- Modify: `ui/src/api/feeds.test.ts`

**Interfaces:**
- `FeedListResponse.preference_namespace: String` is a domain-separated BLAKE3 hash of the canonical configured vault root.
- `GET /api/vault/feeds/entries/{id}` returns `FeedEntryDto` or the established 404 `ApiError`.
- `useFeedEntry(id?: number)` is disabled without a positive ID and uses the generated detail operation.
- Entry patch success keeps the detail cache and all matching infinite-list caches coherent.

- [ ] **Step 1: Add failing Rust API tests**

In `tests/api_feeds.rs`, create entries using existing feed fixtures and prove:

1. GET of a known ID returns the same ID/title/sanitized `content_html`, read/bookmark state, and tags as list results.
2. GET of an unknown ID returns 404 with the standard API error body.
3. Calling GET does not enqueue or perform refresh work; assert through the existing fixture scheduler/request counters rather than source inspection.
4. Two list responses for the same vault return the same non-empty `preference_namespace`.
5. Different temporary vault roots return different namespaces, and the response string contains neither raw root path.

Do not add an excerpt field or network behavior.

- [ ] **Step 2: Run the focused Rust test RED**

```bash
cargo test --test api_feeds entry_detail
cargo test --test api_feeds preference_namespace
```

Expected: FAIL because the response field and GET handler do not exist.

- [ ] **Step 3: Implement namespace and GET handler**

In `src/api/feeds.rs`:

- add `preference_namespace` to `FeedListResponse`;
- canonicalize `state.vault.root()` using the existing repository path/error conventions;
- hash `b"clepsydra-feed-preferences-v1\0"` followed by canonical root bytes with `blake3::Hasher`;
- expose only lowercase hex;
- add a Utoipa GET operation on `/entries/{id}`;
- call the existing feed-store ID lookup used by patching;
- map missing entry through the existing `feed_store_error`/not-found behavior;
- register GET and PATCH on the same Axum path with `get(get_entry).patch(patch_entry)` or the repository-equivalent method router.

Do not schedule refresh or read source URLs.

- [ ] **Step 4: Run Rust tests GREEN**

```bash
cargo test --test api_feeds entry_detail
cargo test --test api_feeds preference_namespace
```

Expected: PASS.

- [ ] **Step 5: Regenerate OpenAPI client**

Build and launch `clep serve` against a disposable temporary vault on an unused local port, then run from `ui/`:

```bash
bun run openapi
```

Set the command's endpoint/port using the repository's established temporary-server procedure if port 3000 is occupied. Verify `schema.d.ts` contains both `get_entry` and `patch_entry` on `/api/vault/feeds/entries/{id}` plus `preference_namespace` on `FeedListResponse`. Stop the server.

- [ ] **Step 6: Add failing frontend API tests**

In `ui/src/api/feeds.test.ts`, prove:

- no detail request occurs for `undefined`;
- a selected ID calls the generated GET path with its path parameter;
- patch success updates the corresponding detail query result;
- list optimistic behavior remains unchanged.

Run:

```bash
bun run test src/api/feeds.test.ts
```

Expected: FAIL because `useFeedEntry` and detail cache integration do not exist.

- [ ] **Step 7: Implement frontend detail hook and cache coherence**

Add the generated detail-query hook. Reuse the existing query-key conventions. On patch optimistic/success/rollback, update detail state with the same projected fields used for list caches; do not invalidate unrelated details or insert an absent list row.

- [ ] **Step 8: Run focused API tests GREEN and commit**

```bash
bun run test src/api/feeds.test.ts
cargo test --test api_feeds entry_detail
cargo test --test api_feeds preference_namespace
```

```bash
git add src/api/feeds.rs src/feeds/store.rs tests/api_feeds.rs ui/src/api/schema.d.ts ui/src/api/feeds.ts ui/src/api/feeds.test.ts
git commit -m "feat(feeds): add entry detail API"
```

Stage `src/feeds/store.rs` only if actually changed. Record red/green commands and the commit in the SDD ledger.

---

### Task 2: Suggestion-backed RSS group controls

**Files:**
- Create: `ui/src/components/codex/FeedGroupComboBox.tsx`
- Create: `ui/src/components/codex/FeedGroupComboBox.test.tsx`
- Modify: `ui/src/components/codex/FeedManagement.tsx`
- Modify: `ui/src/components/codex/FeedManagement.test.tsx`

**Interfaces:**
- `FeedGroupComboBox({ value, groups, ariaLabel, disabled, onChange })` controls a string draft and allows custom values.
- Export a pure `canonicalFeedGroups(groups)` helper only if tests need it.
- Equality is trimmed ASCII case-insensitive; first manifest spelling and order win.
- Empty commit emits `""`; form adapters map it to `null` as they do now.

- [ ] **Step 1: Write failing combobox tests**

Cover:

- duplicate `Research`, ` research `, and `RESEARCH` options render once as `Research`;
- input filters suggestions case-insensitively;
- pointer selection and Arrow/Enter selection commit canonical stored spelling exactly once;
- entering `New Group` and pressing Enter commits it exactly once;
- blur commits a novel draft once but does not duplicate the preceding selection commit;
- Escape closes suggestions without clearing the draft;
- disabled state prevents commits.

Run:

```bash
bun run test src/components/codex/FeedGroupComboBox.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 2: Implement the reusable control**

Use React Aria `ComboBox`, `Input`, `Popover`, `ListBox`, and `ListBoxItem`; follow `ProjectCombo.tsx` for selection/blur de-duplication but use the group normalization contract above. Use controlled `inputValue`, `allowsCustomValue`, and accessible labels. Avoid adding a global store.

- [ ] **Step 3: Run control tests GREEN**

```bash
bun run test src/components/codex/FeedGroupComboBox.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Add failing management integration tests**

Update `FeedManagement.test.tsx` to prove:

- subscribe and edit surfaces expose group comboboxes populated from all manifest groups;
- selecting an existing differently cased match sends the manifest spelling;
- a novel value reaches `useSubscribeFeed`/`useUpdateFeed` through the existing mutation shape;
- a rejected mutation leaves URL/title/group drafts visible and the error alert rendered;
- retry does not double-submit from selection plus blur.

Run:

```bash
bun run test src/components/codex/FeedManagement.test.tsx
```

Expected: FAIL with the current plain inputs.

- [ ] **Step 5: Wire both forms**

Compute canonical group options once from `feedsQuery.data?.groups`. Pass them to `SubscribeForm` and `EditFeedDialog`; replace only group inputs. Keep URL/title inputs, modal lifetime, error rendering, and existing mutation adapters unchanged.

- [ ] **Step 6: Run focused tests GREEN and commit**

```bash
bun run test src/components/codex/FeedGroupComboBox.test.tsx src/components/codex/FeedManagement.test.tsx
```

```bash
git add ui/src/components/codex/FeedGroupComboBox.tsx ui/src/components/codex/FeedGroupComboBox.test.tsx ui/src/components/codex/FeedManagement.tsx ui/src/components/codex/FeedManagement.test.tsx
git commit -m "feat(feeds): suggest subscription groups"
```

Record review evidence in the SDD ledger.

---

### Task 3: Persistent group and feed disclosures

**Files:**
- Create: `ui/src/store/feedDisclosure.ts`
- Create: `ui/src/store/feedDisclosure.test.ts`
- Modify: `ui/src/components/codex/FeedManagement.tsx`
- Modify: `ui/src/components/codex/FeedManagement.test.tsx`

**Interfaces:**
- Storage key: `clepsydra.feeds.disclosure.${preferenceNamespace}`.
- Stored value: `{ version: 1, groups: string[], feeds: number[] }`.
- Export pure defensive read/write/reconcile helpers or a small hook with those operations testable without rendering.
- Absence/corruption/storage exceptions mean empty collapsed sets.
- Reconciliation runs only with successful manifest data.

- [ ] **Step 1: Write failing preference tests**

Prove:

- missing and malformed values read as empty;
- unknown versions and wrong element types read as empty;
- writes are namespace-specific and contain only version/groups/feeds;
- storage getter/setter exceptions do not escape;
- group normalization deduplicates case/whitespace;
- reconciliation removes obsolete group identities and feed IDs;
- reconciliation retains live identities and avoids writes when unchanged;
- no reconciliation occurs without a successful live manifest.

Run:

```bash
bun run test src/store/feedDisclosure.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement defensive preferences**

Use sets in memory and sorted arrays in storage for deterministic output. Normalize group identities with `trim().toLocaleLowerCase("en-US")`. Reject non-finite/non-integer/non-positive feed IDs. Avoid Zustand persistence because the namespace arrives asynchronously with feed data and only this surface consumes the state.

- [ ] **Step 3: Run preference tests GREEN**

```bash
bun run test src/store/feedDisclosure.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add failing disclosure interaction tests**

In `FeedManagement.test.tsx`, render a successful manifest with at least two groups and feeds. Prove:

- all groups and feeds start expanded with absent storage;
- pointer press collapses and expands group and feed controls;
- Enter and Space operate the trigger and expose correct expanded state;
- group collapse hides the feed list but preserves nested feed preference;
- remount with the same namespace restores collapsed states;
- a different namespace starts expanded;
- a subsequent successful manifest prunes obsolete stored identities;
- loading/error renders do not prune;
- collapsed feed summary still exposes title, URL, health, timing, count, and tags; edit/delete and last error are in its expanded panel.

Run:

```bash
bun run test src/components/codex/FeedManagement.test.tsx
```

Expected: FAIL because management rows are not disclosures.

- [ ] **Step 5: Implement controlled React Aria disclosures**

Use `Disclosure`, `Button slot="trigger"`, and `DisclosurePanel`. Initialize state after a namespace is available, reconcile after successful feed data, and persist controlled changes. Keep individual feed state when a parent group collapses. Do not write on initial error/loading states.

- [ ] **Step 6: Run focused tests GREEN and commit**

```bash
bun run test src/store/feedDisclosure.test.ts src/components/codex/FeedManagement.test.tsx
```

```bash
git add ui/src/store/feedDisclosure.ts ui/src/store/feedDisclosure.test.ts ui/src/components/codex/FeedManagement.tsx ui/src/components/codex/FeedManagement.test.tsx
git commit -m "feat(feeds): persist subscription disclosures"
```

Record review evidence in the SDD ledger.

---

### Task 4: URL-addressed responsive split reader

**Files:**
- Create: `ui/src/components/codex/FeedReaderPane.tsx`
- Create: `ui/src/components/codex/FeedReaderPane.test.tsx`
- Modify: `ui/src/components/codex/FeedRiver.tsx`
- Modify: `ui/src/components/codex/FeedRiver.test.tsx`
- Modify: `ui/src/routes/feeds.tsx`
- Modify: `ui/src/routes/-feeds.test.tsx`

**Interfaces:**
- `FeedsSearch.entry?: number` accepts only positive finite integers.
- `FeedRiver` full mode receives `selectedEntryId?: number` and `onSelectEntry(id)`; compact mode retains inline disclosure.
- `FeedReaderPane` receives selected ID, optional feed name, `onBack`, and `onMissing`; it owns detail loading/error/action presentation.
- `onMissing` is called only for a confirmed 404.

- [ ] **Step 1: Write failing reader-pane tests**

Cover:

- no selection renders selection guidance without issuing a query;
- pending and transient error states retain the selected identity and expose retry;
- confirmed 404 invokes `onMissing` once;
- stored sanitized HTML, title, feed/source, author, timestamp, tags, and state render;
- absent body renders metadata and HTTP(S) original fallback;
- invalid original protocol renders no link;
- reader actions patch read/bookmark/tags and preserve tag draft on failure;
- no iframe appears.

Run:

```bash
bun run test src/components/codex/FeedReaderPane.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 2: Implement reader pane**

Use `useFeedEntry` and existing mutation hooks. Reuse the safe URL and tag normalization behavior by extracting small shared helpers from `FeedRiver.tsx` only if needed; do not duplicate divergent URL policy. Render `content_html` only from the API DTO. Add an explicit **Back to entries** control supplied by `onBack`.

- [ ] **Step 3: Run reader-pane tests GREEN**

```bash
bun run test src/components/codex/FeedReaderPane.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Add failing river selection tests**

In `FeedRiver.test.tsx`, prove:

- full-mode row activation calls `onSelectEntry` without opening inline content;
- selected row exposes `aria-current` and remains in the loaded list;
- selecting unread marks it read using the existing optimistic path;
- loaded pages remain present across selected-ID prop changes;
- the scroll container's `scrollTop` is unchanged across selected-ID rerenders;
- pagination still appends entries;
- compact mode still expands inline and retains its full-reader link.

Run:

```bash
bun run test src/components/codex/FeedRiver.test.tsx
```

Expected: FAIL because full selection mode does not exist.

- [ ] **Step 5: Refactor FeedRiver without resetting query state**

Keep `useInfiniteQuery` and its filters in the same mounted component. In full mode, render selectable rows and remove inline body expansion; in compact mode retain `EntryDisclosure`. Do not key the river by selection. Mark unread on selection with existing mutation reconciliation. Give the full river a stable independently scrolling container.

- [ ] **Step 6: Run river tests GREEN**

```bash
bun run test src/components/codex/FeedRiver.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Add failing route tests**

Update `-feeds.test.tsx` to prove:

- search validation accepts a positive integer `entry` and rejects zero, negative, NaN, decimal, and unrelated values;
- selecting changes only `entry` while preserving view/group/feed/tag/manage;
- closing/back removes only `entry`;
- 404 uses replace navigation and preserves filters;
- transient error does not navigate;
- desktop renders both river and pane as separate scroll regions;
- mobile no-selection shows list, selection shows detail and explicit **Back to entries**;
- list remains mounted across mobile list/detail transitions without remaining accessible while hidden;
- direct URL selection can render an entry outside loaded list pages;
- no browser request targets an entry's external URL and no iframe exists.

Run:

```bash
bun run test src/routes/-feeds.test.tsx
```

Expected: FAIL because route selection and split composition do not exist.

- [ ] **Step 8: Implement route composition**

Extend validation and `updateSearch`. Compose the desktop two-column grid and responsive list/detail visibility without keying or conditionally destroying `FeedRiver`. Feed source names come from the already loaded manifest. Clear selection only from explicit back/close or confirmed missing callback.

- [ ] **Step 9: Run focused reader tests GREEN and commit**

```bash
bun run test src/components/codex/FeedReaderPane.test.tsx src/components/codex/FeedRiver.test.tsx src/routes/-feeds.test.tsx src/components/codex/FeedRiverPanel.test.tsx
```

```bash
git add ui/src/components/codex/FeedReaderPane.tsx ui/src/components/codex/FeedReaderPane.test.tsx ui/src/components/codex/FeedRiver.tsx ui/src/components/codex/FeedRiver.test.tsx ui/src/routes/feeds.tsx ui/src/routes/-feeds.test.tsx
git commit -m "feat(feeds): add responsive split reader"
```

Record review evidence in the SDD ledger.

---

### Task 5: Cross-task review, gates, smoke, and integration

**Files:**
- Modify only files required by evidence-backed review findings.
- Update local untracked SDD reports/ledger; do not commit task reports.

- [ ] **Step 1: Run combined focused tests**

From the repository root:

```bash
cargo test --test api_feeds
```

From `ui/`:

```bash
bun run test src/api/feeds.test.ts src/store/feedDisclosure.test.ts src/components/codex/FeedGroupComboBox.test.tsx src/components/codex/FeedManagement.test.tsx src/components/codex/FeedReaderPane.test.tsx src/components/codex/FeedRiver.test.tsx src/components/codex/FeedRiverPanel.test.tsx src/routes/-feeds.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Request final focused code review**

Review the complete Wave 2 diff against the design and this plan. Report only Critical/Important findings with file:line evidence. Correct findings with a new failing test, green focused test, and separate commit. Repeat review until approved.

- [ ] **Step 3: Run Rust repository gates**

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: PASS.

- [ ] **Step 4: Run UI repository gates**

From `ui/`:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Expected: PASS, with only explicitly identified pre-existing tool/config warnings.

- [ ] **Step 5: Run disposable-vault browser smoke**

Create a disposable vault/config and start the freshly built branch server through the process hub. Seed at least two groups, three feeds, sanitized stored content, one bodyless entry, read/unread state, and enough entries to scroll/paginate.

Desktop proof:

1. Existing groups appear as combobox suggestions; selecting one does not duplicate submission.
2. A new group can be entered; a forced manifest conflict keeps the draft.
3. Group and feed disclosures work with pointer and keyboard.
4. Reload retains collapse state for the same namespace; removing a subscription prunes its saved ID.
5. Selecting an entry adds only `entry` to the URL, leaves filters and river scroll intact, and renders stored content in the right pane.
6. A direct URL opens an entry outside initial list pages.
7. Bodyless and 404/transient states follow the design.
8. Network inspection shows no source-article request and DOM inspection shows no iframe.

Mobile proof:

1. List opens detail with the same URL selection.
2. **Back to entries** restores the list and its scroll.
3. Browser Back/Forward traverses list/detail.
4. Group/feed disclosure controls remain keyboard-accessible and usable.

Capture exact observations in the local SDD ledger, then stop the server/browser and remove only the verified disposable directory.

- [ ] **Step 6: Merge and verify on `develop`**

Follow the repository's `finishing-a-development-branch` workflow:

1. ensure the feature worktree is clean and commit history contains no tracked SDD reports;
2. preserve unrelated `develop` changes before merging;
3. merge the named Wave 2 branch into `develop` without rewriting user work;
4. rerun UI typecheck, lint, full tests, build, plus Rust fmt, clippy, and full tests on merged `develop`;
5. remove the Wave 2 worktree and merged branch;
6. mark these source-note checkboxes complete through the vault MCP only after merged verification:
   - `RSS groups use suggestions and a picker`
   - `RSS groups and feeds are collapsible`
   - `RSS feed should be a column of feed items next to - ideally - an iframe displaying content, if possible. Failing this, a 'reader view' of the content on click`

No other source-note item changes in this wave.
