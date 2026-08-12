# Atomic batch mutation final fix report

## Status

Complete. All P1 final-review findings were fixed in the isolated `feature/now-program` worktree with focused regressions and one cohesive final-fix commit.

## Finding evidence

### Important 1 — UI bulk assign clean cutover

- **RED:** `bun run test -- src/components/codex/Gazetteer.test.ts` exited 1. The new atomic response fixture contained only `moved` and `unchanged`; Gazetteer's success callback threw `TypeError` at `data.failed.length`.
- **GREEN:** The same focused file passes: 1 file, 6 tests. Gazetteer now consumes `moved` source paths and `unchanged` paths to remove completed selections, with no `failed` compatibility path or stale failure UI.
- Regenerated `ui/src/api/schema.d.ts` from the production OpenAPI endpoint on an isolated server port. `BulkAssignResponse` now contains exactly `moved` and `unchanged`, and the operation documents atomic success/error responses.

### Important 2 — startup persisted post-move reconciliation

- **RED:** `cargo test build_app_state_replays_committed_academic_move_hooks_before_finalization --lib` failed because the production constructor left the annotation's indexed and on-disk `work_path` at `library/papers/my-paper.md` and removed the transaction workspace.
- **GREEN:** The same focused test passes. It creates a real `FilesystemCommitted` transaction, calls `build_app_state`, and proves the rebuilt destination UUID drives `AcademicMoveHook`, the annotation bytes and `meta_json` contain `archive/my-paper.md`, the `work_path` property link resolves to the work UUID, and only then the transaction workspace is removed.
- **Idempotence RED/GREEN:** `cargo test replay_with_current_work_path_does_not_rewrite_annotation --lib` first failed with `PermissionDenied` because replay rewrote an already-current read-only annotation; it now passes because the hook skips unchanged `work_path` values.
- Move hooks now return the paths they modified. The mutation coordinator reindexes those paths after persisted index events; startup performs final link resolution before transaction finalization. Normal direct and asynchronous batch paths use the same reconciliation implementation with source identity, while startup recovery explicitly uses rebuilt destination identity.

### Important 3 — safe move rollback

- **RED:** `cargo test move_rollback_preserves_published_destination_when_recreated_source_conflicts --lib` failed when reading the destination with `NotFound`, proving rollback deleted the valid published copy before detecting the recreated-source conflict.
- **GREEN:** The same focused test passes. Rollback verifies the payload and preflights source and destination hashes before mutation, restores the source first, then removes the destination with the existing live race checks. A conflicting recreated source returns the exact `RecoveryConflict` path while both the external source and valid destination survive.

### Minor — destination validation specificity

- `cargo test final_destination --lib` passes 2 tests.
- The duplicate-write test now asserts `IntentValidationError::DuplicateFinalDestination("same.md")` exactly.
- A move-plus-write collision at the same final destination asserts the same exact variant.

## Files

- `src/lib.rs`
- `src/vault/academic_hook.rs`
- `src/vault/batch_mutation.rs`
- `src/vault/hooks.rs`
- `src/vault/mutation_coordinator.rs`
- `tests/api_test.rs`
- `ui/src/api/schema.d.ts`
- `ui/src/components/codex/Gazetteer.test.ts`
- `ui/src/components/codex/Gazetteer.tsx`
- `.superpowers/sdd/2026-08-11-atomic-batch-mutations/final-fix-report.md`

## Focused final verification

- `cargo test vault::batch_mutation::tests --lib`: 31 passed.
- `cargo test vault::academic_hook::tests --lib`: 2 passed.
- `cargo test build_app_state_replays_committed_academic_move_hooks_before_finalization --lib`: 1 passed.
- `cargo test --test api_test page_mutation_projected_move_invokes_hook_before_notification`: 1 passed.
- `cargo test --test academic_test move_work_updates_annotation_work_path`: 1 passed.
- `bun run test -- src/components/codex/Gazetteer.test.ts`: 1 file, 6 tests passed.

## Commit

`HEAD` — `fix(vault): close atomic batch final review findings` (this report is part of the same cohesive commit; the immutable hash is returned after commit creation).

## Concerns

No functional concerns found in focused self-review. Full gates were intentionally not run per assignment. The focused Vitest run emits pre-existing Vite native-config-loader warnings for `__dirname` and an extensionless `mdx-plugin` import; they do not affect the test result.
