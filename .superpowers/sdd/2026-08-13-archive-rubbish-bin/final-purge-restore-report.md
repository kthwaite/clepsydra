## Final purge/restore lifecycle report

### Result

A rubbish item whose permanent purge has durably released its captured-archive CAS references can no longer be restored. Restore now checks the existing per-item CAS release ledger while holding the same rubbish-item and destination-path guards used for publication. A completed release returns the established `MutationError::Conflict` before filesystem publication, with guidance to retry permanent deletion. Purge retry behavior is unchanged and remains idempotent.

### Root cause

`release_rubbish_archive_refs` already committed a durable per-item ledger row atomically with CAS reference decrements. That ledger made repeated purge attempts safe, but restore never queried it. If purge released CAS ownership and then failed to remove the rubbish catalog row or retained item, the item remained readable and restore could publish its bytes as an active page even after CAS garbage collection removed the now-unreferenced captured blobs.

### RED evidence

After adding the catalog-removal failure regression and before adding the ledger preflight:

```bash
cargo test --test api_rubbish_test failed_purge_after_cas_release_cannot_restore_and_retry_finishes -- --exact --nocapture
```

Result: **1 failed; 0 passed**. The restore assertion expected HTTP 409 but received HTTP 500 after reaching batch index reconciliation with the still-armed catalog trigger:

```text
Expected status code to be 409 (Conflict), received 500 (Internal Server Error)
error: batch recovery required ... index reconciliation failed: sqlite error: injected rubbish catalog deletion failure
```

This was the intended RED: restore had no CAS-release preflight and proceeded into filesystem/index mutation instead of rejecting the purge-in-progress item.

### GREEN evidence

The same regression after the fix:

```bash
cargo test --test api_rubbish_test failed_purge_after_cas_release_cannot_restore_and_retry_finishes -- --exact --nocapture
```

Result: **1 passed; 0 failed**.

The regression proves in one lifecycle:

- catalog removal fails only after the CAS release ledger commits;
- the retained item bytes remain authoritative;
- the active path remains absent;
- CAS GC removes the released captured blob;
- restore returns HTTP 409 with `retry permanent deletion` guidance before publication;
- the active path remains absent and the retained bytes remain unchanged after restore rejection;
- dropping the injected catalog trigger and retrying purge succeeds even though the blob has been collected;
- the release ledger remains completed and no second decrement occurs.

Ordinary retained-item restore remains supported:

```bash
cargo test --test api_rubbish_test rubbish_restore_returns_original_identity_and_occupied_path_retains_item -- --exact --nocapture
```

Result: **1 passed; 0 failed**.

The existing domain-level completed-ledger purge retry remains idempotent:

```bash
cargo test --test mutation_test purge_rubbish_retries_after_completed_ledger_without_a_second_decrement -- --exact --nocapture
```

Result: **1 passed; 0 failed**.

Focused Rubbish API regression suite:

```bash
cargo test --test api_rubbish_test -- --nocapture
```

Result: **11 passed; 0 failed**.

Per assignment, no formatter, lint, build, or project-wide suite was run. The exact focused runs emitted an unrelated existing `unused import: BlobMetadata` warning from `src/api/archive.rs`; this task did not modify that file.

### Changed files

- `src/vault/cas.rs`
  - Added `ContentStore::rubbish_archive_refs_released`, a typed query over the durable per-item release ledger.
- `src/vault/mutation_coordinator.rs`
  - Added `restore_rubbish`, which acquires restore path/item guards, checks the release ledger, and delegates to the existing guarded batch executor only when CAS ownership is intact.
- `src/api/rubbish.rs`
  - Routed restore through the guarded lifecycle method and supplied the shared CAS store.
- `tests/api_rubbish_test.rs`
  - Added the catalog-removal failure, CAS-GC, restore rejection, retained-state, and idempotent retry regression.

### Implementation and self-review

- The ledger query reuses the same SQLite lookup used by release idempotency, so the restore decision reads the durable source of truth rather than inferring state from blob rows or filesystem presence.
- The restore wrapper derives the one affected rubbish item from the prepared command and rejects malformed restore commands before mutation.
- CAS release state is checked only after the coordinator acquires both destination-path and rubbish-item guards. Purge takes the same rubbish-item guard, preventing a check/publication race.
- The conflict is returned before `execute_batch_with_guard`, so no filesystem publication, index reconciliation, notification, or retained-item consumption occurs.
- The error uses the established typed `MutationError::Conflict` to preserve the existing HTTP 409 mapping. Its message explains that captured-archive references were released and instructs the caller to retry permanent deletion.
- Purge implementation and release logic were not changed. A retry observes the completed ledger, skips another decrement/prevalidation, removes the catalog/item, and succeeds after GC.
- The approved index-reconciliation rollback work was not modified. The shared coordinator file was hunk-staged so the sibling rollback changes remained outside this fix commit.
- `git diff --cached --check` passed before commit.

### Commit

`670d1b80 fix(rubbish): block restore after purge release`

### Concerns

No lifecycle concern remains within this scope. The focused Rust runs report the unrelated pre-existing `BlobMetadata` unused-import warning noted above.
