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
- The helper retains the established exact list invalidation and full `/api/vault/rubbish` path-prefix invalidation, covering list and detail queries.
- Existing restore still invalidates normal page-derived structures in addition to Rubbish data. Purge and Empty Bin still invalidate only Rubbish data and never derive a page path from an item ID.
- No Rust files or lifecycle behavior were touched.

## Concerns

No concerns within the assigned cache-invalidation path. The pre-existing Vite configuration warning noted above remains outside this task.
