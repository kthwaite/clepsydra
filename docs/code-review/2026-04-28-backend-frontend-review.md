# Code Review: Backend (`src/`) and Frontend (`ui/src/`)

Date: 2026-04-28
Scope: full-tree review of the Rust backend and React frontend.
Method: two `feature-dev:code-reviewer` agents dispatched in parallel, one per tree, with confidence-based filtering. Findings below are pointers to investigate — verify against current source before acting.

---

## 🦀 Backend (`src/`)

### Critical

1. **Recursive folder delete skips delete hooks**
   Location: `src/api/folders.rs:349-363`
   With `recursive=true`, `fs::remove_dir_all` runs before any per-page hook invocation, so `ArchiveDeleteHook` ref-count decrements never fire. CAS blobs leak permanently with positive `ref_count` and become ineligible for GC.
   Fix: walk the tree first, run `state.delete_hooks` per page (matching the pattern in `delete_page`), then remove.

2. **N+1 per-block property queries in `content_index`**
   Location: `src/api/index_routes.rs:820-835`
   Loads all pages in one query, then issues two prepared queries per page inside a for loop. A 5k-page vault runs 10k extra queries on the single-threaded index worker, blocking all other concurrent index access.
   Fix: bulk `IN (...)` queries or a single JOIN returning all needed columns.

### High

3. **Fake pagination**
   Location: `src/api/pagination.rs:22-39`; `src/api/pages.rs:163`
   `PaginatedResponse::from_vec` materializes the full result set, then slices in Rust. `list_pages` SQL has no `LIMIT/OFFSET`. The `total` is correct but the underlying query reads everything.
   Fix: push `LIMIT/OFFSET` into SQL, separate `SELECT COUNT(*)` for total. `PaginationParams` is already threaded through.

4. **Non-atomic read-modify-write on page edits**
   Location: `src/api/pages.rs:405-484`
   `update_page` reads the file, merges fields in memory, then `fs::write` truncates and overwrites. No optimistic-concurrency token, no file lock. Concurrent PUTs or watcher upserts during save can silently lose writes.
   Fix: `If-Match` ETag using existing `content_hash`, or perform read-modify-write inside a single `with_index` closure.

5. **`tasks.rs` "batched" lookup is still N+1**
   Location: `src/api/tasks.rs:271-284`
   Comment at line 270 claims batching; implementation prepares + queries per task in a for loop. Same pattern in `agenda.rs` (`fill_properties`) and `journal.rs`. 100–500 tasks serialize hundreds of queries on the index thread.
   Fix: single `IN`-clause query keyed by `(page_id, span_start)`.

6. **`search_blocks` unbounded `LIKE '%q%'`**
   Location: `src/api/blocks.rs:138-147`
   Leading-wildcard `LIKE` forces full table scan on every call. `limit` accepts arbitrary `i64` with no upper bound (caller can request `limit=1000000`).
   Fix: cap `limit` at e.g. 200; consider FTS via existing `pages_fts` table.

7. **Archive URL dedup is a full-table scan**
   Location: `src/vault/index.rs:1435-1457`
   `find_by_archive_url` runs `json_extract(meta_json, '$.archive.url')` over every row in `pages` with no supporting index, while holding `archive_ingest_lock`.
   Fix: dedicated indexed column populated by archive deriver, or separate `archive_index` table keyed by URL.

8. **`IndexHandle::spawn` panics on thread-spawn failure**
   Location: `src/vault/index_handle.rs:44`
   `.expect("failed to spawn vault-index thread")` panics the entire server under fd/thread exhaustion.
   Fix: propagate via `?` — `run_server` already returns `Box<dyn Error>`.

9. **`resolve_links_for_page` re-prepares statements in inner loop**
   Location: `src/vault/index.rs:982-998`
   Per-canonical-name × per-unresolved-link `prepare(...)` calls run on every incremental sync.
   Fix: hoist `count_stmt` (or use `prepare_cached`) outside the inner `for (source_id, span_start) in &unresolved` loop.

10. **Folder-not-empty detected via string match**
    Location: `src/api/folders.rs:354-362`
    Matches `e.to_string()` against `"not empty"` / `"Directory not empty"` with macOS errno 66 fallback. Locale- and libc-fragile.
    Fix: `e.raw_os_error()` matching `Some(66) | Some(39)` (macOS / Linux), or `ErrorKind::DirectoryNotEmpty`.

### Medium

11. **Default port mismatch**
    Location: `src/lib.rs:99`; `src/lib.rs:47`
    `Config::builder()` sets `server.port=3000`; `ServerSettings::default()` returns 16667. The struct default is unreachable through the load path; effective default is 3000.
    Fix: align both to the same port.

12. **File I/O on the index thread for backlinks**
    Location: `src/vault/index.rs:1305-1323`
    `backlinks_with_context` calls `fs::read_to_string` per source page from inside the index worker. 100 backlinks = 100 synchronous reads blocking all index access.
    Fix: return span coordinates from `with_index`, perform reads in `spawn_blocking` in the async handler.

13. **`capture_today` lost-update race**
    Location: `src/api/journal.rs:404-468`
    Read-then-write with no lock. Two concurrent capture POSTs silently lose one entry.
    Fix: serialize through index thread or per-vault file-write lock.

14. **`update_task_status` TOCTOU**
    Location: `src/api/tasks.rs:377-468`
    Two separate `with_index` calls: re-index, then fetch. Concurrent operation between them can return a `TaskItem` reflecting state the caller didn't write.
    Fix: combine re-index + read into one closure.

15. **`Settings::load` requires config.toml to exist**
    Location: `src/lib.rs:89-94`
    Returns `Err("no config.toml found")` if missing, contradicting the documented "defaults → toml → env" layering.
    Fix: skip the `File::from(...)` source when `find_config_path` returns `None`.

### Themes

- **Index thread is a contention hot spot.** Multiple handlers do blocking disk I/O (backlinks, page reads) or large N+1 query loops inside the single-threaded index worker, serializing unrelated requests behind them.
- **Pagination is illusory.** `from_vec` defeats it; needs SQL-level `LIMIT/OFFSET`.
- **Recursive folder delete bypasses the hook system** — silent CAS leak.
- **Read-modify-write is unprotected throughout** (`update_page`, `capture_today`, `update_task_status`).
- **N+1 patterns mislabeled as "batched"** in tasks/agenda/journal handlers.

---

## ⚛️ Frontend (`ui/src/`)

### Critical

1. **List autoformat passes stale path to `mergeWithAdjacentList`**
   Location: `ui/src/editor/plugins/autoformat/blockTransforms.ts:231-237`
   After two `wrapNodes` calls, `blockPath` now refers to the inner paragraph (`list > list-item > paragraph`), not the new list. Passing it to `mergeWithAdjacentList` causes `Node.get(editor, listPath)` to read the wrong node — items may be silently dropped or throw on adjacent-list merges.
   Fix: snapshot `Path.parent(Path.parent(blockPath))` after wrapping; pass the derived list path.

2. **`SlateEditor` doesn't reset on async `initialValue` arrival**
   Location: `ui/src/editor/SlateEditor.tsx:54-64`
   Editor is `useMemo([], [])`; Slate ignores `initialValue` after mount. If page data resolves after mount with the empty fallback `[{type:"paragraph", children:[{text:""}]}]`, the next autosave can silently overwrite the page with empty content.
   Fix: `key` derived from page id on `<Slate>`, or imperative `editor.children = initialValue; Editor.normalize(editor, {force:true})` when `saveStatus === "saved"` and new data arrives.

### High

3. **`tryLinkTransform` patches `editor.isInline` non-exception-safely**
   Location: `ui/src/editor/plugins/autoformat/inlineTransforms.ts:196-216`
   Saves and restores `editor.isInline` around `HistoryEditor.withNewBatch`. If the batch throws, restore never runs and `isInline` is permanently broken via stale closure. Worse, `withLinks` already registers `link` as inline — the override is dead weight.
   Fix: remove the mutation entirely; rely on `withLinks`.

4. **`BlockRefElement.onClick` is a no-op**
   Location: `ui/src/editor/elements/BlockRefElement.tsx:10-13`
   Insertion + storage works; the chip's click handler calls `e.preventDefault()` and nothing else. Most user-visible half-baked feature.
   Fix: implement navigation to the source page (requires `useBlock(blockId)` or threading `page_path`), or remove the handler so default click behavior returns; add a `title` with the blockId in the interim.

5. **`ThemeProvider` recreates `setMode`/`toggle` every render**
   Location: `ui/src/components/ThemeProvider.tsx:32-38`
   Plain function expressions inside the component body. The `useMemo` at line 71 captures fresh references on every recompute, so context value identity changes on every mode flip — re-rendering all consumers including ones reading only `resolvedTheme`.
   Fix: `useCallback` with stable deps; include in `useMemo` dep array.

6. **`AppLayout` opens search via synthetic `KeyboardEvent`**
   Location: `ui/src/components/AppLayout.tsx:21-24`
   Header search button fires `new KeyboardEvent("keydown", { key:"k", metaKey:true })` on `window` to trigger `SearchPalette`'s listener. Synthetic event has `isTrusted: false`; any future `isTrusted` check breaks it.
   Fix: lift `open`/`setOpen` into `useUiStore`; button calls `openSearch()` directly.

7. **`usePageEditor` redundant effect dep**
   Location: `ui/src/editor/usePageEditor.ts:79-103`
   `initialValue` derived from `page` via `useMemo`; both included in sync `useEffect` deps. Causes double-fire on every page update; misleading contract for callers.
   Fix: remove `initialValue` from the dep array — `page` already covers it.

8. **`BacklinksPanel` uses array index in composite key**
   Location: `ui/src/components/BacklinksPanel.tsx:20`
   `key={\`${bl.source_id}-${i}\`}` — `source_id` is not unique (same page can link multiple times), but the index tiebreaker corrupts reconciliation on reorder.
   Fix: `key={\`${bl.source_id}-${bl.span_start}\`}`.

9. **Duplicated list-type guards across three plugin files**
   Locations: `ui/src/editor/plugins/withOutliner.ts:3-15`; `ui/src/editor/plugins/autoformat/blockTransforms.ts:26-27` (`LIST_TYPES`); `ui/src/editor/plugins/autoformat/listContinuation.ts:12-22`
   Identical `isListElement`/`isListItem` predicates; adding a list type silently requires multi-file edits.
   Fix: extract to `#/editor/plugins/listUtils.ts`; import from all three.

### Medium

10. **`mergeWithAdjacentList` insertion index goes stale**
    Location: `ui/src/editor/plugins/autoformat/blockTransforms.ts:82-116`
    Uses `prevNode.children.length` from a snapshot captured before any `Transforms.moveNodes`. Each move grows the live tree by one but the destination index doesn't advance, so items land in reverse order.
    Fix: counter (`let destIdx = prevNodeChildCount; ... to: [...prevPath, destIdx++]`).

11. **`WikilinkCombobox` filter is unmemoized**
    Location: `ui/src/editor/WikilinkCombobox.tsx:21-28`
    Filters all pages on every keystroke; `SlashCombobox` already memoizes the same pattern (line 27). Inconsistent.
    Fix: `useMemo(() => pages.filter(...).slice(0,8), [pages, lowerQuery])`.

12. **`SlateEditor.handleChange` not memoized**
    Location: `ui/src/editor/SlateEditor.tsx:78-151`
    Plain function declaration; new identity each render. Closes over `slashTrigger`/`wikilinkTrigger`/`blockRefTrigger` by value — stale-closure risk if a key event fires before state flush.
    Fix: refs for trigger states read inside the handler, or `useCallback` with full deps.

### Themes

- **Slate transform paths go stale.** Two distinct bugs in autoformat list code (path-after-wrap, stale child-count) — symptomatic of not recomputing paths after each `Transforms.*` call inside a `withoutNormalizing` block.
- **Block-ref is half-finished at the render layer.** Insertion + storage works; the chip click is a placeholder.
- **API hooks split between typed `$api` and raw `fetch`.** `blocks.ts`, `journal.ts`, `tasks.ts` use raw fetch + hand-rolled query keys; `pages.ts`, `index.ts` use the OpenAPI wrapper. Raw paths will drift from the server contract.
- **Duplicated list-type predicates** across three plugin files — any new list type is a silent multi-file edit.
- **Search open-state via synthetic keyboard event** — sole path through a fake ⌘K, fragile and untestable.

---

## Highest-leverage actions

If only a subset gets addressed in the near term:

1. **Folder recursive delete + delete hooks** (Backend Critical #1) — silent data integrity bug, leaks blobs forever.
2. **Real SQL pagination** (Backend High #3) — defines the scaling ceiling of the entire app.
3. **Slate autoformat path staleness** (Frontend Critical #1 + Medium #10) — both bugs cause user-visible content corruption in lists.
4. **`SlateEditor` `initialValue` race** (Frontend Critical #2) — can silently overwrite a page with empty content.
5. **Cap `search_blocks.limit`; dedupe N+1 task/agenda/journal property loads** — cheap wins that meaningfully unblock the index thread.

---

## Open questions / assumptions

1. Is the index-thread architecture intended to remain single-threaded long-term, or is moving to a connection pool on the table? Several findings (file I/O on index thread, N+1 patterns) are only critical because of the single-threaded constraint.
2. For `update_page` concurrency: is local-first single-user the only target, or does the watcher's edit-during-save case warrant ETag protection?
3. Block-ref click behavior: should it open the source page, expand inline, or scroll-to-target? Determines the fix shape.
