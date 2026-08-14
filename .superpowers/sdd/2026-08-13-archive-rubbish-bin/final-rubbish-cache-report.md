# Final rubbish cache report

## Result

Successful page archive mutations now invalidate the full Rubbish Bin query path prefix, including the cached list and item-detail keys. Cross-client `index_changed` events perform the same invalidation, so active queries can refetch and inactive cached queries remain marked stale until reused.

The existing Rubbish restore, purge, and Empty Bin hooks use the same centralized helper. No Rust lifecycle code changed.

## TDD evidence

### RED

- `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx` — exit 1: 2 failed, 9 passed. The new archive-success test observed the exact Rubbish list key still valid, and the new `index_changed` test observed the exact Rubbish list key still valid. Both failures were `expected false to be true`; the integration assertion that an unrelated `feed_changed` event leaves Rubbish list/detail keys valid already passed.

### GREEN

- `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx` — exit 0: 3 files passed, 11 tests passed.
- `bun run test -- src/api/rubbish.test.tsx` — exit 0: 1 file passed, 3 tests passed. This retains restore, purge, and Empty Bin mutation coverage.
- Final focused verification: `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/api/rubbish.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx` — exit 0: 4 files passed, 14 tests passed.

Vitest emitted the existing Vite `configLoader: 'native'` compatibility warning for `__dirname` and the extensionless `./mdx-plugin` import; the focused tests themselves had no failures.

## Query-key coverage

- Page archive success marks `queryKeys.rubbish.all` stale.
- Page archive success also marks `['get', '/api/vault/rubbish/{item_id}', ...]` detail state stale through the Rubbish path-prefix predicate.
- `index_changed` applies the same exact list/detail behavior for cross-client archive and restore lifecycle changes.
- An unrelated feeds key is not invalidated by either Rubbish path-prefix check.
- A `feed_changed` event invalidates the existing feeds prefix while leaving both exact Rubbish list and detail keys valid.

## Commit

Task commit subject: `fix(ui): invalidate rubbish cache on archive lifecycle`.

## Self-review

- Centralized the pre-existing Rubbish invalidation sequence in `api/keys.ts`; page mutations, Rubbish mutations, and SSE handling do not introduce competing predicates or query-key shapes.
- Archive invalidation remains inside `onSuccess`, so failed archives do not make Rubbish queries stale.
- SSE invalidation is limited to `index_changed`; `base_registry_changed` and `feed_changed` retain their existing branches.
- The helper uses one boundary-aware `/api/vault/rubbish` path-family predicate, covering the exact list and slash-delimited detail paths without matching adjacent path names.
- Existing restore still invalidates normal page-derived structures in addition to Rubbish data. Purge and Empty Bin still invalidate only Rubbish data and never derive a page path from an item ID.
- No Rust files or lifecycle behavior were touched.

## Concerns

No concerns within the assigned cache-invalidation path. The pre-existing Vite configuration warning noted above remains outside this task.

## Review correction: single-pass active refetch

### Changes

- Replaced the separate exact-list and prefix invalidations with one query-cache pass.
- The predicate matches only the exact `/api/vault/rubbish` path or a slash-delimited descendant, so `/api/vault/rubbish-bin` remains untouched.
- Added active `QueryObserver` coverage for both page archive success and cross-client `index_changed`: each lifecycle action causes exactly one additional list fetch.
- The same tests keep an inactive item-detail query cached and prove it becomes stale without fetching.
- Updated restore, purge, and Empty Bin tests to assert list/detail cache behavior rather than the removed exact-list filter call.

### TDD evidence

- RED: `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/hooks/useVaultEvents.test.tsx` — exit 1: 2 failed, 8 passed. Both new active-list regressions expected two total fetches (initial plus one lifecycle refetch) but observed three, proving the duplicate exact-list/prefix invalidations cancelled and restarted the first refetch.
- Intermediate GREEN: the same command — exit 0: 2 files passed, 10 tests passed after changing the helper to one boundary-aware predicate.
- Existing-hook check initially exposed two implementation-coupled assertions in `src/api/rubbish.test.tsx` that still expected the removed exact-list filter. They were replaced with cache-state assertions for the list, detail, and unaffected page keys.
- Final focused verification: `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/api/rubbish.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx` — exit 0: 4 files passed, 14 tests passed.

### Commit and self-review

Follow-up commit subject: `fix(ui): avoid duplicate rubbish list refetch`.

Self-review confirmed one `invalidateQueries` call per Rubbish lifecycle invalidation, boundary-safe path matching, one active list refetch for both archive and SSE flows, stale inactive details, feed-event isolation, and unchanged restore/purge/Empty Bin transport behavior. No Rust files changed.

### Concerns

No scoped concerns. The focused runs continue to emit only the pre-existing Vite native-config compatibility warning documented above.

## Definitive review correction: purge and Empty Bin settlement

### Root cause and changes

- The purge and Empty Bin REST handlers called coordinator methods that do not accept a mutation notifier, then returned without broadcasting any lifecycle catalog change. MCP purge and Empty Bin use these REST routes, so they inherited the gap.
- Purge mapped coordinator errors before any API-layer action, preventing applied-error outcomes from telling other clients to refresh.
- Local purge and Empty Bin hooks invalidated only in `onSuccess`, so a rejected response after durable state changed left the initiating client's cache fresh.
- Each REST handler now sends exactly one empty-path `IndexChanged` lifecycle notification after its coordinator request settles and before success/error mapping. Empty Bin emits once for the request rather than once per item. Empty path sets are intentional: Rubbish cache invalidation keys off lifecycle index-event type, while no live page path changed.
- Local purge and Empty Bin hooks now run the existing one-pass Rubbish family invalidation in `onSettled`. Both applied and pre-apply rejections therefore refresh harmlessly, with one invalidation per mutation settlement.

### TDD evidence

- UI RED: `bun run test -- src/api/rubbish.test.tsx` — exit 1: 1 failed, 3 passed. The rejected applied-error purge left the active list at one initial fetch instead of refetching once.
- REST purge RED: `cargo test --test api_rubbish_test rubbish_item_delete_purges_exact_item` — exit 101: the expected lifecycle notification receiver was empty.
- Applied-error purge RED: `cargo test --test api_rubbish_test failed_purge_after_cas_release_cannot_restore_and_retry_finishes` — exit 101: the expected lifecycle notification receiver was empty after CAS release and the injected catalog failure.
- Empty Bin RED: `cargo test --test api_rubbish_test empty_rubbish_returns_ordered_partial_outcomes_and_retains_failures` — exit 101: the expected single lifecycle notification receiver was empty.
- Final Rust GREEN: `cargo test --test api_rubbish_test` — exit 0: 11 tests passed.
- Final UI GREEN: `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/api/rubbish.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx` — exit 0: 4 files passed, 15 tests passed.

### Commit and self-review

Task commit subject: `fix(rubbish): refresh caches after purge settlement`.

Self-review confirmed the notification is issued once at each REST request boundary, including error settlement, and Empty Bin's per-item coordinator loop cannot emit duplicates. MCP inherits the same behavior through its REST client. UI rejection coverage proves both an applied-error and a harmless pre-apply error cause one additional active-list fetch apiece while an inactive detail becomes stale without fetching. The existing boundary-aware Rubbish query predicate and feed-event isolation remain unchanged.

### Concerns

No scoped concerns. Successful initiating clients may observe both their local settlement invalidation and the server's cross-client SSE notification, as they already can for archive/restore; each individual path now emits only once. The focused UI run continues to emit the pre-existing Vite native-config warning.

## Coverage follow-up: rejected Empty and pre-apply handlers

### Added coverage

- A rejected `useEmptyRubbish` mutation now has the same active/inactive regression coverage as purge: the exact active list performs one additional fetch, the exact inactive detail becomes stale, and its query function remains at one initial fetch.
- A top-level Empty Bin enumeration failure is induced by replacing the test vault's Rubbish root with a regular file. The handler returns 500 and emits exactly one empty-path `IndexChanged`.
- Invalid-ID and missing-item purge requests are exercised after subscribing. They return 400 and 404 respectively, and each emits exactly one empty-path `IndexChanged`.
- All notification assertions also prove the receiver is empty after the first event.

### Verification evidence

These were coverage-only additions over the already-correct settlement implementation and passed on their first focused run; no production code changed.

- `bun run test -- src/api/rubbish.test.tsx` — exit 0: 1 file passed, 5 tests passed.
- `cargo test --test api_rubbish_test empty_rubbish_enumeration_error_notifies_once` — exit 0: 1 passed.
- `cargo test --test api_rubbish_test pre_apply_purge_errors_notify_once` — exit 0: 1 passed.
- Final Rust verification: `cargo test --test api_rubbish_test` — exit 0: 13 tests passed.
- Final UI verification: `bun run test -- src/api/__tests__/mutation-hooks.test.tsx src/api/rubbish.test.tsx src/hooks/useVaultEvents.test.tsx src/hooks/useVaultEvents.integration.test.tsx` — exit 0: 4 files passed, 16 tests passed.

### Commit and self-review

Coverage commit subject: `test(rubbish): cover rejected lifecycle settlements`.

Self-review confirmed the new tests use exact OpenAPI list/detail query keys, active observer fetch behavior, inactive detail fetch counts, real handler responses, and broadcast receiver emptiness rather than source-shape or invalidation call-count assertions.

### Concerns

None. The focused UI run emitted only the previously documented Vite native-config warning.

## Final coverage correction: rejected Empty isolation

The rejected Empty Bin hook test now keeps an adjacent active `['get', '/api/vault/rubbish-bin']` observer alongside the active exact list and inactive exact detail. After settlement, the exact list has one additional fetch and the exact detail is stale without fetching, while the adjacent query remains at its single initial fetch and is not invalidated. This prevents a broad active-query invalidation from satisfying the lifecycle assertions.

Focused verification: `bun run test -- src/api/rubbish.test.tsx` — exit 0: 1 file passed, 5 tests passed.

Coverage commit subject: `test(rubbish): prove rejected Empty isolation`.

No production code changed. No concerns beyond the previously documented Vite native-config warning.
