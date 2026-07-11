# Task 7 Report

## Status

Complete. Page creation, page replacement, page assignment, and board-task project refiling now use the reviewed `MutationCoordinator` and `IndexHandle::apply_mutation` path. HTTP request/response DTOs remain in the API layer. The coordinator owns path locking, exclusive/atomic filesystem writes, index policy application, projected moves, hook execution, and post-index notification ordering.

Preserved contracts include:

- `201` page creation and the existing page-detail response shape.
- `200` page update/assignment and board-task response shapes.
- `400` invalid paths, project slugs, kinds, and task fields.
- `404` missing pages/tasks.
- `409` create conflicts plus destination/stale mutation conflicts.
- `500` filesystem, index, reconciliation, and hook failures.
- Distinct `ProjectAssignment::{Unchanged, Set(String), Clear}` behavior.
- An unchanged assignment performs no write, timestamp update, index work, or notification.
- Explicit project clear strips the projected subfolder; absent project remains conservative.
- Projected moves retain inbound-link rewriting and post-move hooks.
- Notifications are emitted only after filesystem, index, reconciliation, and hooks succeed.
- Filesystem-success/index-failure errors explicitly report `filesystem_applied=true` and do not emit a success notification.

## Commit

- `807ee6f refactor(api): centralize page mutations`

## Tests and verification

- RED observed before implementation:
  - `cargo test --test api_test page_mutation -- --nocapture` — destination collision expected `409`, received `200`.
  - `cargo test --test api_board_test project_assignment -- --nocapture` — destination collision expected `409`, received `200`.
- Focused GREEN:
  - `cargo test --test api_test page_mutation -- --nocapture` — 7 passed.
  - `cargo test --test api_board_test project_assignment -- --nocapture` — 3 passed.
- Relevant integration suites:
  - `cargo test --test api_test` — 86 passed.
  - `cargo test --test api_board_test` — 28 passed.
- Typecheck:
  - `cargo check --all-targets` — passed.
- Full suite:
  - `cargo test` — 759 passed across 36 suites.
- Lint:
  - Strict `cargo clippy --all-targets -- -D warnings` remains blocked by pre-existing warnings outside Task 7 (including `academic.rs`, `bcl.rs`, `import_zotero.rs`, `index.rs`, `archive.rs`, `rewriter.rs`, `block.rs`, and unrelated dirty tests).
  - Re-running Clippy with allowances only for those observed baseline lints passed, establishing no additional Task 7 warning.

## Self-review

- Confirmed handlers no longer contain the migrated direct `with_index` mutation closures.
- Confirmed page content updates use the reviewed atomic replacement helper and compare expected content under the coordinator lock to prevent lost updates.
- Confirmed destination existence is checked while source and destination locks are held, before changing source metadata.
- Confirmed `ContentChanged` index policy runs before projected reconciliation, preserving reverse dependency refresh; the existing move planner then rewrites inbound links and invokes hooks.
- Confirmed notification callbacks execute last and tests observe hook-before-notification ordering.
- Confirmed rejected destination collisions leave source metadata and destination contents unchanged.
- Confirmed unrelated pre-existing worktree modifications were not staged or committed.

## Concerns

- The existing move planner erases concrete hook error types into `IndexError::Other`; the coordinator maps that established representation to typed `MutationError::Hook`. Other reconciliation errors retain `MutationError::Reconcile`.
- Strict repository-wide Clippy is not currently clean for pre-existing, out-of-scope warnings listed above. Task 7 code passes Clippy once only those existing lint categories are allowed.

## Important-finding remediation

- Extracted the reviewed platform-specific atomic no-replace rename from attachment storage into the shared vault atomic-file abstraction; attachment uploads and page creation now use the same native primitive.
- Page creation now writes and syncs a same-directory temporary file, atomically publishes it without replacement, and syncs the parent directory. Publication collisions retain `AlreadyExists` and map to `MutationError::Conflict`.
- Write, sync, and publication failures remove the temporary file. The synchronous write/publish section contains no cancellation point, so cancellation can only occur before temporary-file creation or after publication.
- Atomic replacement now applies the destination's existing permissions to the temporary inode before writing and syncing it. The project has no ACL/xattr metadata abstraction, so no additional inode metadata is promised or copied.
- Added regressions for complete atomic creation, collision cleanup/no-clobber behavior, and Unix mode preservation.

### Remediation verification

- `cargo test --test mutation_test mutation_coordinator_atomic -- --nocapture` — 9 passed.
- `cargo test --test api_test page_mutation -- --nocapture` — 7 passed.
- `cargo test --test api_board_test project_assignment -- --nocapture` — 3 passed.
- `cargo check --all-targets` — passed.
- `cargo test` — 762 passed across 36 suites on the final run. An earlier run exposed the pre-existing timing-sensitive `cancelled_attachment_upload_removes_temporary_file`; it passed in isolation immediately afterward and the complete rerun passed.
- Strict `cargo clippy --all-targets -- -D warnings` remains blocked only by the previously reported out-of-scope warnings; the remediation introduced no Clippy finding.

## Windows parent-sync remediation

- Status: complete. Parent-directory synchronization remains `File::open(parent).sync_all()` on non-Windows platforms. On Windows it is an explicitly documented successful no-op because `std::fs` does not open directories with `FILE_FLAG_BACKUP_SEMANTICS` and the crate's current dependencies do not expose a verified directory-handle flush implementation. Successful atomic publication is therefore no longer reported as a guaranteed post-publication failure on Windows.
- Added a Windows-gated contract test covering successful `atomic_create` and `atomic_replace` publication and content.
- The Windows Rust target is not installed on this Darwin workstation (`rustup target list --installed` reports only `aarch64-apple-darwin`), so no Windows cross-target check was run and no toolchain was installed.
- `cargo test --test mutation_test mutation_coordinator_atomic -- --nocapture` — 9 passed on Darwin; the Windows-gated test was not executable on this host.
- `cargo check --all-targets` — passed.
- `cargo test` — 762 passed across 36 suites.
- `rustfmt --edition 2024 --check src/vault/atomic_file.rs tests/mutation_test.rs` — passed.
- Repository-wide `cargo fmt --all -- --check` remains blocked by pre-existing formatting drift in `src/api/openapi.rs`, `src/vault/config.rs`, and `tests/api_blocks_test.rs`; neither touched Rust file has formatting drift.
- Strict `cargo clippy --all-targets -- -D warnings` remains blocked by the previously reported out-of-scope warnings. The affected library and mutation-test targets pass with only those baseline lints allowed.
