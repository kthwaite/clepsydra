# Task 4 report

## Status

Complete. Mutation previews now convert to durable batch commands with exact expected bytes; page, folder, reconcile, relabel, and test callers use coordinator-owned batch execution. The legacy `MutationPlan::execute` and `rewriter::apply_staged_writes` APIs and their callsites are removed.

## RED evidence

- `cargo test --test mutation_test move_plan_batch -- --nocapture`
  - Failed to compile as intended: `no method named into_batch_command found for struct MutationPlan` at the new preview-to-command equivalence test.
- `cargo test --test api_test page_move -- --nocapture`
  - Failed as intended: the old page-move handler notified only `renamed.md`; the test required the notification to cover the committed backlink rewrite (`source.md`) as well.

## GREEN evidence

- `cargo test --test mutation_test move_plan_batch -- --nocapture`: 1 passed.
- `cargo test --test api_test page_move -- --nocapture`: 2 passed.
- `cargo test --test mutation_test -- --nocapture`: 41 passed.
- `cargo test --test api_test -- --nocapture`: 119 passed.
- `cargo test --test academic_test -- --nocapture`: 5 passed.
- Focused batch unit compilation/execution: `cargo test --lib batch_mutation::tests::affected_paths_are_sorted_and_deduplicated -- --nocapture`: 1 passed, 853 filtered out.
- Legacy symbol inventory: no remaining `MutationPlan::execute`, `plan.execute`, or `apply_staged_writes` references under `src/` or `tests/`.

The focused integration commands reported five existing library warnings; no failures were present. No formatter, linter, build, or broad test suite was run, per the task constraint.

## Files changed

- `src/vault/mutation.rs`
- `src/vault/rewriter.rs`
- `src/vault/batch_mutation.rs`
- `src/vault/mutation_coordinator.rs`
- `src/api/pages.rs`
- `src/api/folders.rs`
- `src/vault/reconcile.rs`
- `src/vault/relabel.rs`
- `tests/mutation_test.rs`
- `tests/api_test.rs`
- `tests/academic_test.rs`
- `tests/rewriter_test.rs`
- `.superpowers/sdd/2026-08-11-atomic-batch-mutations/task-4-report.md`

## Migration inventory

- `MutationPlan::into_batch_command` converts staged backlink rewrites to `Write` intents with `ExpectedPathState::Bytes`, page renames to `Move`, deletes to `Delete`, and folder renames to exact-byte per-file moves.
- Missing destination directories and removed source directories are durable transaction preparation metadata. They are validated, manifested, published, rolled back, recovered, and included in coordinator path locking without becoming logical path intents.
- Page move and delete handlers plan synchronously inside `IndexHandle::with_index`, release the closure, then execute through `MutationCoordinator::execute_batch`. Notifications now come only from the coordinator after filesystem and index completion.
- Folder move snapshots under deterministic subtree exclusion, releases the index closure, then uses the same async coordinator batch path.
- Reconcile and relabel retain their direct `VaultIndex` interfaces but call `MutationCoordinator::execute_batch_direct`, which shares the async coordinator's publication, hook, index-reconciliation, retained-workspace, and cleanup helpers. No second coordinator instance or legacy executor exists.
- Mutation and academic tests that executed plans directly now convert and execute through the direct coordinator path.
- The obsolete staged-writer test and API were removed.

## Commit

This report is part of commit `refactor(vault): execute planned moves as atomic batches`; the final commit hash is reported in the task handoff because a commit cannot contain its own content hash.

## Concerns

No known functional concerns. Folder batches deliberately reject non-empty source-directory cleanup during publication and retain/roll back through the durable batch path rather than deleting unexpected files.

## Review round 0 fixes

### RED evidence

- `cargo test --test mutation_test move_plan_batch -- --nocapture` failed because conversion resampled the concurrent replacement as the backlink's expected bytes instead of retaining the planner snapshot.
- `cargo test --test mutation_test folder_plan_batch_uses_the_planner_inventory_without_rewalking -- --nocapture` failed because a post-plan `notes/late.md` appeared in the converted command.
- `cargo test --test mutation_test explicit_create_dir_plan_becomes_preparation_metadata -- --nocapture` failed with no preparation directories instead of `archive` and `archive/nested`.
- `cargo test --lib preserves_directory_created_after_preparation -- --nocapture` failed both rollback and recovery cases because an externally created destination directory was removed.
- `cargo test --lib directory_only_command_publishes_preparation_metadata -- --nocapture` failed with `Validation(\"batch mutation command is empty\")`.

### Fixes

- `StagedWrite` now owns the exact bytes read to compute each rewrite. `into_batch_command` never rereads content; stale concurrent primary or backlink updates are rejected.
- Folder planning performs one inventory walk. Exact file bytes, per-file move intents, directory preparation metadata, markdown index events, and move-hook metadata all derive from that inventory.
- Explicit `FileOpKind::CreateDir` entries add their missing path and ancestors to preparation metadata, and directory-only batches publish successfully.
- The manifest durably records `created_directories` after each successful directory creation. Rollback and crash recovery remove only transaction-owned directories; a path created externally after preparation remains untouched.
- Added exact semantic affected-path equality tests for move, delete, and nested folder plans.
- Added coordinator failure injection proving a plan-derived backlink write is rolled back when the following primary move fails, with unchanged index and no notification.
- Added nested folder cleanup/recovery coverage for unexpected source content and interrupted publication.

### Final GREEN evidence

- `cargo test --test mutation_test -- --nocapture`: 45 passed.
- `cargo test --test api_test -- --nocapture`: 119 passed.
- `cargo test --test academic_test -- --nocapture`: 5 passed.
- `cargo test --lib vault::batch_mutation::tests -- --nocapture`: 28 passed, 832 filtered out.
- `cargo test --lib rolls_back_ -- --nocapture`: 2 passed, 858 filtered out.
- Legacy executor search remains empty.
