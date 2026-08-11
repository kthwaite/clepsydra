# Stray Thoughts P1 Discovery and Folio Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make search and Folio tag suggestions reliable within one second on the current vault, add authoritative Gazetteer Kind/Project filtering, and restore Folio working position across in-session navigation.

**Architecture:** Normalize human search input into safe FTS5 prefix queries and add bounded server-side tag suggestions. Move Gazetteer filters/pagination into the backend query and route search state. Store only a bounded, non-persisted Folio restoration snapshot and apply it after the matching editor mount when its selection context is still compatible.

**Tech Stack:** Rust 2024, Rusqlite/FTS5, Axum/Utoipa, React 19, TypeScript, TanStack Query/Router, Zustand, Slate, React Aria Components, Vitest/Testing Library, Bun, Cargo.

## Global Constraints

- Search and Folio tag suggestions must complete or show a retryable failure within one second on the current local vault; timing is a smoke contract, not a shared-runner unit assertion.
- Search remains local FTS5 and preserves exact/general text matching while adding punctuation-safe prefix matching.
- Older requests cannot overwrite newer query results.
- Gazetteer Kind, Project, text, and tag filters combine with AND semantics at the authoritative backend query.
- Gazetteer filter state is route state; it is not a global preference.
- Folio restoration is in-memory only and bounded; it is never added to persisted workspace state or URLs.
- Never apply a saved Slate range to a different page or incompatible leaf context.
- Every production change follows a red-green behavioral test.
- Existing unstaged primary-checkout files remain untouched.

---

### Task 1: Normalize and bound full-text search

**Files:**
- Modify: `src/vault/index.rs` (`VaultIndex::search`, focused unit tests)
- Modify: `src/api/index_routes.rs` (`search`, API tests)
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify only if needed: `ui/src/api/index.ts` (`useSearch`)

**Interfaces:**
- Add private or `pub(crate)` `fts_prefix_query(input: &str) -> Result<String, SearchQueryError>` at the vault/index boundary.
- `VaultIndex::search(&self, query: &str, limit: usize)` retains its public signature and applies normalization internally.
- Human token `clep` becomes the safe FTS5 prefix expression `"clep"*`; punctuation separates tokens rather than becoming FTS syntax.

- [ ] **Step 1: Add failing FTS query tests**

Create tests against an in-memory index containing **Clepsydra: Stray Thoughts**:

```rust
assert_paths(index.search("clep", 20).unwrap(), &["notes/stray.md"]);
assert_paths(index.search("clepsydra", 20).unwrap(), &["notes/stray.md"]);
assert_paths(index.search("Clepsydra: Stray", 20).unwrap(), &["notes/stray.md"]);
assert!(index.search(": OR *", 20).is_ok());
```

Also preserve multi-token AND behavior and Unicode letters. Blank/punctuation-only input returns an empty result or the existing typed bad request, never an FTS syntax error.

- [ ] **Step 2: Run search tests RED**

```bash
cargo test vault::index::tests::search_prefixes_human_tokens --lib -- --exact
```

Expected: `clep` does not match or punctuation reaches raw `MATCH` syntax.

- [ ] **Step 3: Implement safe prefix normalization**

Split on non-alphanumeric characters, lowercase only where FTS collation already treats case insensitively, escape embedded quotes, and join non-empty terms with `AND`:

```rust
fn fts_prefix_query(input: &str) -> Option<String> {
    let terms = input
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}
```

Pass the normalized expression to `pages_fts MATCH ?1`. Keep `limit` parameterized and rank ordering unchanged.

- [ ] **Step 4: Add visible client lifecycle tests**

In Command Palette tests, defer query A and query B, resolve B first then A, and assert B remains visible. Assert loading and backend error/retry states are announced. TanStack Query keys should provide stale isolation; if existing generated-query behavior already makes the stale test green, add no duplicate request state.

- [ ] **Step 5: Run focused client tests RED/GREEN**

```bash
bun run test src/components/codex/__tests__/CommandPalette.test.tsx
```

Implement only missing loading/error/retry presentation and keep the existing 200ms debounce. Do not copy results into an unkeyed local state that can reintroduce stale writes.

- [ ] **Step 6: Commit**

```bash
git add src/vault/index.rs src/api/index_routes.rs ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/__tests__/CommandPalette.test.tsx
git commit -m "fix(search): normalize prefix queries"
```

---

### Task 2: Add bounded Folio tag suggestions

**Files:**
- Modify: `src/api/index_routes.rs` (`TagQuery`, `tags`)
- Modify: `src/api/openapi.rs`
- Modify: `tests/openapi_contract.rs`
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/index.ts` (`useTags`, new `useTagSuggestions`)
- Modify: `ui/src/components/ui/tag-input.tsx`
- Modify: `ui/src/components/ui/__tests__/tag-input.test.tsx`
- Modify: `ui/src/editor/PageEditorHeader.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`

**Interfaces:**
- Preserve `GET /index/tags` without parameters for vocabulary/count consumers.
- Add optional `q` and `limit` query parameters; with `q`, return at most `limit` case-insensitive substring matches ordered by exact/prefix preference, count descending, then tag.
- Add `useTagSuggestions(query: string, limit = 12, enabled = true)` while preserving `useTags(enabled?: boolean)` for existing callers.
- Extend `TagInput` with controlled request lifecycle only where required: `onSuggestionQueryChange`, `suggestionsLoading`, `suggestionsError`, `onRetrySuggestions`.

- [ ] **Step 1: Add failing bounded endpoint tests**

Seed more than 12 tags and assert `q=jour&limit=12` returns only matching values, respects the bound, and ranks `journal` before a mere interior match. Assert the unparameterized endpoint retains complete count behavior.

- [ ] **Step 2: Run endpoint tests RED**

```bash
cargo test api::index_routes::tests::tags_support_bounded_suggestions --lib -- --exact
```

- [ ] **Step 3: Implement parameterized SQL**

Use bound parameters and escape `%`, `_`, and the escape character for `LIKE ... ESCAPE`. Keep the existing grouped count query for no `q`; do not fetch all tags and truncate in Rust.

- [ ] **Step 4: Add failing Folio suggestion lifecycle tests**

Drive TagInput query changes `jo` then `jour`, resolve the newer request first, and assert the rendered suggestions remain for `jour` after the old request resolves. Assert `role=status` while loading and a retry button on error. Keep raw tag commit available when suggestions fail.

- [ ] **Step 5: Implement debounced server suggestions**

Folio owns the current tag query and passes it through the existing debounce hook to `useTagSuggestions`. `PageEditorHeader` forwards query/lifecycle props to `TagInput`. Keep selected/editable values controlled by `usePageEditor`; suggestions never mutate tags until selection/commit.

- [ ] **Step 6: Regenerate and verify the API contract**

Run the repository OpenAPI generation flow against the updated server, then focused tests:

```bash
cargo test api::index_routes::tests::tags_support_bounded_suggestions --lib -- --exact
cargo test --test openapi_contract
bun run test src/components/ui/__tests__/tag-input.test.tsx src/components/codex/__tests__/Folio.test.tsx
```

Expected: bounded server results, stale isolation, loading/error/retry, and raw commit all pass.

- [ ] **Step 7: Commit**

```bash
git add src/api/index_routes.rs src/api/openapi.rs tests/openapi_contract.rs ui/src/api/schema.d.ts ui/src/api/index.ts ui/src/components/ui/tag-input.tsx ui/src/components/ui/__tests__/tag-input.test.tsx ui/src/editor/PageEditorHeader.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.test.tsx
git commit -m "perf(tags): bound folio suggestions"
```

---

### Task 3: Move Gazetteer Kind and Project filters to the authoritative query

**Files:**
- Modify: `src/api/index_routes.rs` (`ContentIndexQuery`, `content_index`, tests)
- Modify: `src/api/openapi.rs`
- Modify: `tests/openapi_contract.rs`
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/index.ts` (`useContentIndex` options)
- Modify: `ui/src/routes/gazetteer.tsx`
- Modify: `ui/src/store/gazetteer.ts` or remove duplicated filter fields from it
- Modify: `ui/src/components/codex/Gazetteer.tsx`
- Modify: `ui/src/components/codex/MobileGazetteer.tsx`
- Modify: `ui/src/components/codex/Gazetteer.test.ts`
- Modify: `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx`
- Modify: `ui/src/components/codex/gazetteer-filter.ts` only for sorting already-loaded current-page rows

**Interfaces:**
- `ContentIndexQuery` gains `q: Option<String>`, `kind: Option<String>`, `project: Option<String>`, and repeated/encoded `tags: Vec<String>` in addition to `limit/offset`.
- Unknown Kind returns 400. A non-existent Project returns an empty page, not unfiltered results.
- `useContentIndex({ q, kind, project, tags, limit, offset })` returns authoritative `items` and `total`.
- Gazetteer route search owns `q`, `tags`, `kind`, `project`, `sort`, and `page`.

- [ ] **Step 1: Add failing backend filter matrix**

Seed pages spanning two kinds, two projects, and multiple tags. Assert Kind-only, Project-only, query-only, tags-AND, and combined filters. Assert project `missing` returns zero and does not broaden. Assert `total` is computed before limit/offset.

- [ ] **Step 2: Run backend tests RED**

```bash
cargo test api::index_routes::tests::content_index_filters_authoritatively --lib -- --exact
```

- [ ] **Step 3: Implement one filtered SQL query**

Validate Kind with `Kind::from_token`. Build parameterized `WHERE` clauses over `pages p`; use one `EXISTS` clause per selected tag for AND semantics. Apply text matching to title/path/description using the existing content-index columns. Count with the same clauses, then fetch only the requested page and its tag/link aggregates. Do not load every page before pagination.

- [ ] **Step 4: Add failing route/UI tests**

Assert route validation and navigation retain:

```ts
{
  q: "atlas",
  tags: ["research"],
  kind: "PROJECT",
  project: "clepsydra",
  sort: "title",
  page: 2,
}
```

Assert changing any filter resets page to 1 and calls `useContentIndex` with the combined query. Assert clearing Project retains Kind/text/tags. Cover desktop and mobile controls with accessible labels.

- [ ] **Step 5: Implement route-owned controls**

Use existing Kind vocabulary/presentation and `ProjectCombo`; no second project vocabulary. Replace local `useContentIndex(500)` plus full-data filtering with page-sized authoritative requests. Keep `filterAndSortRows` only for presentation sorting if the API does not own sort; it must not perform Kind/Project/text/tag filtering over a partial page.

- [ ] **Step 6: Regenerate types and run focused tests**

```bash
cargo test api::index_routes::tests::content_index_filters_authoritatively --lib -- --exact
cargo test --test openapi_contract
bun run test src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add src/api/index_routes.rs src/api/openapi.rs tests/openapi_contract.rs ui/src/api/schema.d.ts ui/src/api/index.ts ui/src/routes/gazetteer.tsx ui/src/store/gazetteer.ts ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/MobileGazetteer.tsx ui/src/components/codex/Gazetteer.test.ts ui/src/components/codex/__tests__/MobileGazetteer.test.tsx ui/src/components/codex/gazetteer-filter.ts
git commit -m "feat(gazetteer): filter by kind and project"
```

Stage only changed files.

---

### Task 4: Restore Folio position during the application session

**Files:**
- Create: `ui/src/store/folioRestoration.ts`
- Create: `ui/src/store/folioRestoration.test.ts`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Modify: `ui/src/editor/SlateEditor.tsx` only if its existing `editorRef` cannot be supplied for ordinary Folios

**Interfaces:**

```ts
type TextPointSnapshot = {
  path: Path;
  offset: number;
  text: string;
};

type FolioRestoration = {
  tabId: string;
  path: string;
  revision: string;
  scrollTop: number;
  anchor: TextPointSnapshot | null;
  focus: TextPointSnapshot | null;
};

saveFolioRestoration(record: FolioRestoration): void;
readFolioRestoration(tabId: string, path: string): FolioRestoration | null;
clearFolioRestoration(tabId: string): void;
```

- The module uses a bounded in-memory map (maximum 16 records) and no Zustand persist/localStorage middleware.
- Selection restores only when both saved paths still resolve to text nodes with identical saved text and valid offsets. Exact revision match is accepted immediately; a changed revision requires the text-context validation.

- [ ] **Step 1: Add failing bounded-store tests**

Test keyed read, path mismatch, explicit clear, and oldest-entry eviction after 17 inserts. Assert no localStorage access.

- [ ] **Step 2: Add failing Folio mount-order tests**

Mock page loading, provide a real editor ref, set scrollTop and a selection, unmount Folio to simulate route-away, then remount. Resolve page/editor mount and assert restoration occurs only afterward. Cover stale path, incompatible leaf text, deleted/error page, mobile and desktop scroll containers, and explicit tab path change.

- [ ] **Step 3: Implement the in-memory store and snapshot helpers**

Clone `Path` arrays and text strings for the two selected leaves only. Do not retain the document AST or page body. Export a helper that validates a saved point against `Editor.node(editor, path)` and `Text.isText`.

- [ ] **Step 4: Capture on Folio unmount**

Supply `editorRef` to ordinary Folios as well as conversations. In a Folio effect cleanup, record `tabId`, current `path`, `editor.getRevision()`, `bodyRef.current?.scrollTop ?? 0`, and the current editor selection's leaf contexts. Clear the record when the tab path changes to a different page or the page becomes unavailable.

- [ ] **Step 5: Restore after matching editor mount**

Use `useLayoutEffect` followed by one `requestAnimationFrame` keyed by `tabId`, `path`, and `editor.editorRevision`. Validate the record, set `bodyRef.current.scrollTop`, then `Transforms.select` the compatible range. Focus only when the Folio was the active editing surface; do not steal focus from a dialog or explicit control.

- [ ] **Step 6: Run restoration tests GREEN**

```bash
bun run test src/store/folioRestoration.test.ts src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx
```

Expected: in-session route-away/return restores page/scroll/selection after mount; stale records do not apply.

- [ ] **Step 7: Commit**

```bash
git add ui/src/store/folioRestoration.ts ui/src/store/folioRestoration.test.ts ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.test.tsx ui/src/editor/SlateEditor.tsx
git commit -m "feat(folio): restore session reading position"
```

---

### Task 5: Review and performance smoke verification

- [ ] **Step 1: Review backend query bounds**

Confirm search/tag/Gazetteer inputs are parameterized, pagination occurs before materializing rows, and invalid filters never broaden silently.

- [ ] **Step 2: Review client lifecycle**

Confirm no unkeyed stale-result state, route state is canonical for Gazetteer, and restoration is non-persisted/bounded.

- [ ] **Step 3: Run current-vault smoke measurements**

Against the current vault, measure wall-clock completion for search `clep`, search `clepsydra`, and Folio tag suggestions. Each must return or show a retryable error within one second. Exercise Gazetteer combined filters/back-forward and Folio route-away/return with scroll and selection.

- [ ] **Step 4: Commit review corrections**

Commit only if review or smoke found a behavior requiring correction.
