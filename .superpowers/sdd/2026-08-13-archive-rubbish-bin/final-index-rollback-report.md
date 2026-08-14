# Final index rollback report

## Result

Archive and restore batches now synchronously roll their prepared filesystem transaction back when lifecycle index reconciliation fails. The rollback runs on a blocking worker while the path and rubbish-item guards remain owned by that worker. A successful rollback returns `MutationError::Reconcile { filesystem_applied: false, .. }`; a failed or unjoinable rollback retains the transaction workspace and returns `MutationError::BatchRecovery` with both the index and rollback failures.

Non-lifecycle batches retain their prior recovery behavior. No API, MCP, CAS release-ledger, or restore-eligibility code changed.

## TDD evidence

### RED

- `cargo test --test batch_mutation_test rubbish_archive_` — exit 101: 1 passed, 2 failed, 4 filtered. Both injected archive reconciliation tests failed at the new immediate `MutationError::Reconcile { filesystem_applied: false, .. }` assertion because the operation still returned `BatchRecovery` and left publication pending.
- `cargo test --test batch_mutation_test rubbish_restore_` — exit 101: 1 passed, 2 failed, 4 filtered. Both injected restore reconciliation tests failed at the same new error-state assertion for the same retained-publication behavior.

### GREEN

- `cargo test --test batch_mutation_test rubbish_archive_` — exit 0: 3 passed, 0 failed, 4 filtered; 0.34s.
- `cargo test --test batch_mutation_test rubbish_restore_` — exit 0: 3 passed, 0 failed, 4 filtered; 0.32s.
- `cargo test --test batch_mutation_test` — final exit 0: 7 passed, 0 failed; 0.54s.
- `cargo test --test mutation_test rubbish_lifecycle_notifies_once_only_after_publication_and_indexing` — final exit 0: 1 passed, 0 failed, 65 filtered; 0.22s. This covers the successful async archive/restore publication, index, catalog, notification, and exact-byte lifecycle.

The final lifecycle-success command emitted an unrelated concurrent unused-import warning for `BlobMetadata` in `src/api/archive.rs`; that file is outside this fix.

## Immediate-state assertions

Each injected archive and restore catalog/link failure now checks, before any recovery call:

- active page bytes/existence are restored to the pre-operation state;
- the rubbish item is absent after failed archive and present after failed restore;
- the page index and rubbish catalog retain their pre-operation rows;
- backlink resolution retains its pre-operation target state;
- no mutation notification was emitted; and
- `.clepsydra/transactions` contains no pending workspace after successful rollback.

The tests no longer call `recover_pending` to obtain coherence.

## Commit

Task commit subject: `fix(vault): rollback lifecycle batch after index failure`.

## Self-review

- The new path is gated by `contains_rubbish_lifecycle()`, so already-committed non-lifecycle batches keep the existing retained-recovery behavior.
- `MutationGuard` is moved into the blocking rollback closure and returned with the result, keeping lifecycle guards held throughout rollback.
- The shield's `filesystem_applied` flag is cleared only after `PreparedBatch::rollback()` succeeds.
- Successful rollback returns the ordinary typed reconciliation error and does not notify.
- Rollback failure preserves both causal errors in `BatchRecoveryError::IndexRollback` and leaves the durable transaction workspace available for recovery.
- The index savepoint behavior was not changed; its existing atomic reconciliation path reverts page, catalog, and link mutations before filesystem rollback begins.

## Concerns

No concerns within the assigned lifecycle rollback path. The direct/offline `execute_batch_direct` recovery contract remains unchanged because this assignment targets guarded async lifecycle execution.

## Review round 1 correction

### Changes

- `BatchRecoveryError::IndexRollback` now exposes the primary `IndexError` through `std::error::Error::source`; the secondary rollback failure remains visible in the complete display string.
- Added a deterministic one-shot guarded rollback failpoint matching `RollbackPublication(index)`.
- Added symmetric async archive and restore coverage combining injected catalog reconciliation failure with `RollbackPublication(0)`. Each test verifies `BatchRecoveryError::IndexRollback`, `filesystem_applied=true`, no notification, the published filesystem state, the reverted page/catalog/link index state, one retained transaction workspace, and successful `recover_pending` after the one-shot failure.

### RED

- `cargo test --test batch_mutation_test batch_index_rollback_preserves_primary_error_as_source` — exit 101: 0 passed, 1 failed, 7 filtered. `Error::source` exposed the secondary rollback error instead of the primary index error.
- `cargo test --test batch_mutation_test index_and_rollback_failure` — exit 101 at compilation: two `E0599` errors because the deterministic guarded rollback-injection API did not exist.

### GREEN

- `cargo test --test batch_mutation_test batch_index_rollback_preserves_primary_error_as_source` — exit 0: 1 passed, 0 failed, 7 filtered.
- `cargo test --test batch_mutation_test index_and_rollback_failure` — exit 0: 2 passed, 0 failed, 8 filtered; 0.26s.
- `cargo test --lib batch_mutation::tests::rollback_` — exit 0: 3 passed, 0 failed, 1,048 filtered; 0.28s.
- `cargo test --test batch_mutation_test` — exit 0: 10 passed, 0 failed; 0.73s.
- `cargo test --test mutation_test rubbish_lifecycle_notifies_once_only_after_publication_and_indexing` — exit 0: 1 passed, 0 failed, 65 filtered; 0.24s.

### Commit and self-review

Follow-up commit subject: `fix(vault): preserve index source on rollback failure`.

Self-review found the failpoint isolated to the existing hidden deterministic-injection convention: it is consumed once by `execute_batch_with_guard`, affects only the rollback attempt after reconciliation failure, and leaves normal production rollback on the allocation-free default path. Recovery uses the unchanged non-injected rollback path. No purge restore-safety code changed.

### Concerns

None.
