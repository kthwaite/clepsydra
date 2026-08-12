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

- `StagedWrite` owns the exact bytes read to compute each rewrite. Conversion never resamples planner-produced content; manually assembled public file operations are snapshotted during conversion because they have no planner-owned intent.
- Folder planning performs one inventory walk. Exact file bytes, per-file move intents, directory preparation metadata, markdown index events, and move-hook metadata all derive from that inventory.
- Explicit `FileOpKind::CreateDir` entries add their missing path and ancestors to preparation metadata, and directory-only batches publish successfully.
- Directory ownership uses a durable claim plus an atomically published prepared directory. Recovery distinguishes an unpublished claim from a published transaction-owned path by whether its prepared directory still exists, while preserving paths created externally after preparation.
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

## Review round 2 fixes

### RED evidence

- `cargo test --test mutation_test move_plan_batch_intents_cover_every_previewed_path_with_exact_expected_bytes -- --nocapture` failed with the preview-derived set missing `archive`, proving the test no longer passed through a hard-coded expected set.
- `cargo test --test mutation_test public_rename_and_delete_file_ops_are_converted_to_batch_intents -- --nocapture` failed because neither public file operation produced a logical intent.
- `cargo test --lib recovery_removes_directory_when_crash_follows_atomic_ownership_publication -- --nocapture` initially failed to compile because the deterministic ownership-publication failpoint did not exist.

### Fixes

- Planner previews now include missing destination directories as `CreateDir` file operations, while batch commands continue to carry those paths only as preparation metadata. The page-move equality test derives its complete expected path set from `MutationPlan.file_ops` and `MutationPlan.text_edits`.
- `into_batch_command` converts public `Rename` and `Delete` file operations that lack planner-owned primary intents; planner-produced intents remain authoritative and are not duplicated or resampled.
- Missing directories are prepared inside the transaction workspace. The manifest durably claims each path before `install_noreplace` atomically publishes its prepared directory. A surviving prepared directory means publication never occurred; its absence means recovery owns and removes the published directory. This closes the former create-before-manifest crash gap without deleting externally created paths.

### Final GREEN evidence

- `cargo test --test mutation_test -- --nocapture`: 46 passed.
- `cargo test --lib vault::batch_mutation::tests -- --nocapture`: 29 passed, 832 filtered out.
- `cargo test --lib rolls_back_ -- --nocapture`: 2 passed, 859 filtered out.

## Review round 3 fix

### RED evidence

- `cargo test --test mutation_test empty_folder_plan_does_not_adopt_a_late_file_during_conversion -- --nocapture` failed because conversion rewalked an empty planned folder and created a `Move` intent for `notes/late.md`, despite the planner snapshot having no file, index event, or move-hook metadata for it.

### Fix

- Folder planning already records its exact source-directory inventory in private removal metadata. `into_batch_command` now treats a rename whose source is in that planner-owned metadata as represented even when the folder was empty and therefore produced no primary file intents. Manually assembled public folder renames can still use the conversion fallback, while planner-produced folders are never rewalked.

### Final GREEN evidence

- `cargo test --test mutation_test empty_folder_plan_does_not_adopt_a_late_file_during_conversion -- --nocapture`: 1 passed, 45 filtered out.
- `cargo test --test mutation_test -- --nocapture`: 47 passed.
