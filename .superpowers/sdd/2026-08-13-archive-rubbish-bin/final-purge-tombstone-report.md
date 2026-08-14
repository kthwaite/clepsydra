# Final Purge Tombstone Report

## Result

Implemented crash-resumable permanent removal for Rubbish Bin items in commit `14fd5b30` (`fix(rubbish): make purge removal crash-resumable`).

No UI query-invalidation files were touched.

## Architecture invariant

After the CAS release ledger commits, permanent removal never recursively deletes the visible UUID item directory in place. The store now:

1. revalidates the complete UUID item against the caller's expected bytes and manifest;
2. atomically renames `<rubbish>/<uuid>` to the no-replace tombstone `<rubbish>/.purge-<uuid>`;
3. fsyncs the Rubbish root, making that namespace transition durable;
4. recursively removes only the hidden tombstone; and
5. fsyncs the Rubbish root again.

Therefore, failure or process loss at any boundary leaves either the complete actionable UUID directory or an identifiable hidden purge tombstone. Recursive deletion can make only the tombstone partial; it cannot create a visible invalid UUID row.

Exact, canonical `.purge-<uuid>` names are excluded from authoritative listing. Malformed lookalikes remain visible as invalid store entries. Cleanup validates that the Rubbish root and tombstone are physical directories and does not follow symlinked roots or tombstones.

## Recovery and lifecycle behavior

- Explicit purge retry checks for and deletes an existing tombstone before attempting to read page or manifest content. A partial tombstone is never parsed.
- A resumed tombstone path skips captured-archive release entirely, so it cannot decrement CAS again. The durable CAS release ledger remains one-shot.
- After successful tombstone cleanup, explicit retry removes any rebuildable catalog row and returns the existing typed `RubbishItemNotFound` result; it does not restore the item.
- Startup reconciliation removes all canonical purge tombstones before index open/build. The subsequent authoritative Rubbish catalog rebuild therefore contains neither tombstone nor stale catalog row.
- A failure before the rename leaves the original item byte-identical and catalog-actionable. A failure after the rename leaves no visible UUID item and no catalog ghost.
- Empty Bin still snapshots valid entries newest-first and preserves ordered per-item outcomes. Tombstones are recovery state, not snapshot rows.

## Strict RED/GREEN evidence

Observed RED failures before production changes:

- `cargo test startup_reconciliation_removes_partial_purge_tombstones_without_listing_them --lib`
  - compile failure: `RubbishStore::reconcile_purge_tombstones` did not exist.
- `cargo test purge_rename_failure_leaves_the_complete_uuid_item_actionable --lib`
  - failed because in-place `remove_dir_all` had already deleted `manifest.json`, leaving a partial UUID directory.
- `cargo test build_app_state_finishes_interrupted_rubbish_purge_tombstones --lib`
  - failed because startup left the partial tombstone present.
- `cargo test purge_rubbish_post_remove_root_sync_failure_does_not_restore_a_catalog_ghost --lib`
  - failed because explicit retry did not remove the retained tombstone.
- `cargo test startup_reconciliation_rejects_a_symlinked_root_without_deleting_its_target --lib`
  - failed because initial recovery followed the symlinked Rubbish root; root validation was added before cleanup.

Final focused verification:

- `cargo test vault::rubbish::tests --lib`
  - 18 passed, 0 failed.
- `cargo test purge_rubbish_ --lib`
  - 3 passed, 0 failed.
- `cargo test build_app_state_finishes_interrupted_rubbish_purge_tombstones --lib`
  - 1 passed, 0 failed.
- `cargo test --test mutation_test purge_rubbish`
  - 5 passed, 0 failed.
- `cargo test --test mutation_test empty_rubbish_snapshots_valid_items_newest_first_and_continues_truthful_failures`
  - 1 passed, 0 failed.
- `cargo test --test api_rubbish_test rubbish_`
  - 8 passed, 0 failed.
- `cargo test --test api_rubbish_test failed_purge_after_cas_release_cannot_restore_and_retry_finishes`
  - 1 passed, 0 failed.
- `cargo test --test archive_test purge_rubbish_releases_unique_captured_refs_and_leaves_ordinary_attachments_untouched`
  - 1 passed, 0 failed.

The focused cases cover failure before rename, rename/root-fsync ambiguity, failure during tombstone removal, an already-partial tombstone, failure after tombstone removal before durable root sync, explicit retry, startup reconciliation, catalog truth, restore lockout, Empty Bin ordering, and CAS release behavior.

Per assignment constraints, formatters, linters, builds, and project-wide test suites were not run. The Rust test commands above compiled every changed Rust surface they exercised.

## Self-review

- Confirmed the atomic rename uses the repository's existing `install_noreplace` primitive rather than introducing another publication convention.
- Confirmed both namespace changes are followed by the existing directory fsync helper.
- Confirmed tombstone cleanup performs no manifest/page reads and is idempotent when the tombstone is already absent.
- Confirmed the normal purge result and existing typed errors remain unchanged.
- Confirmed startup cleanup precedes authoritative catalog reconciliation.
- Confirmed ordinary purge, restore, failed-post-ledger restore lockout, cleanup retry, Empty Bin ordering, and unique CAS release tests remain green.
- Confirmed only `src/vault/rubbish.rs`, `src/vault/mutation_coordinator.rs`, and `src/lib.rs` are in the implementation commit.

## Concerns

- A retry that successfully finishes a pre-existing tombstone returns the established `RubbishItemNotFound` error because partial tombstones intentionally contain no trustworthy result metadata. Cleanup and catalog reconciliation have completed at that point; startup is also idempotent.
- Permission-based before-rename and mid-removal boundary tests are Unix-gated. Portable tests still cover partial-tombstone startup cleanup, listing exclusion, and post-removal root-fsync failure.
