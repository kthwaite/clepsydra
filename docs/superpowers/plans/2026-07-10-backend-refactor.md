# Backend Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the backend's confirmed concurrency, query, blocking-I/O, mutation-orchestration, and duplication defects without changing public API contracts.

**Architecture:** Extend the existing vault mutation machinery with path-scoped execution and intent-level index policies. Establish correctness barriers first, then migrate route-level filesystem/index choreography incrementally; every task is independently testable and committed.

**Tech Stack:** Rust 2024, Axum 0.8, Tokio 1.49, rusqlite 0.33/SQLite, parking_lot 0.12, axum-test 18.

## Global Constraints

- Preserve public request and response schemas, existing success statuses, and existing error statuses except stale-revision conflicts become `409 Conflict`.
- Preserve existing code prefixes, padding, case behavior, page projection, hooks, links, and change-notification semantics.
- Use `src/vault/mutation.rs` as the canonical mutation machinery; do not create a competing framework.
- Filesystem/index drift must be reported truthfully; never claim cross-store transactionality.
- Preserve unrelated working-tree changes.
- Follow TDD: observe each focused test fail before implementing the behavior.
- Each task ends with focused verification and a separate commit.

---

### Task 1: Path-scoped mutation serialization and atomic replacement

**Files:**
- Create: `src/vault/mutation_coordinator.rs`
- Modify: `src/vault/mod.rs`
- Modify: `src/api/mod.rs` (`AppState` construction/state fields)
- Test: `tests/mutation_test.rs`

**Interfaces:**
- Produces `MutationCoordinator::new()`, `MutationCoordinator::lock_paths(&[VaultPath])`, and `atomic_replace(path: &Path, content: &[u8]) -> io::Result<()>`.
- Locks normalize keys from `VaultPath`, deduplicate keys, and acquire multiple keys in lexical order.

- [ ] **Step 1: Write failing concurrency and atomic-replacement tests**

Add tests that start two Tokio tasks for one path, assert the second cannot enter until the first guard drops, assert different paths may proceed concurrently, and assert `atomic_replace` leaves either the old or complete new content when its pre-rename write fails. Use `tokio::time::timeout` for deterministic lock assertions and `TempDir` for file state.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `cargo test --test mutation_test mutation_coordinator -- --nocapture`
Expected: FAIL because `MutationCoordinator` and `atomic_replace` do not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Store path locks behind `parking_lot::Mutex<HashMap<VaultPath, Weak<tokio::sync::Mutex<()>>>>`; retain strong lock references in the returned guard. Sort/deduplicate multi-path keys before awaiting. Implement atomic replacement by creating a same-directory unique temporary file with exclusive creation, writing and syncing it, then renaming it over the destination; remove the temporary file on every pre-rename error.

- [ ] **Step 4: Expose one coordinator through `AppState`**

Initialize one shared coordinator in every production and test `AppState` constructor so all route mutations contend on the same lock table.

- [ ] **Step 5: Run focused tests**

Run: `cargo test --test mutation_test mutation_coordinator -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `refactor(vault): add mutation coordinator`

---

### Task 2: Race-safe block-ID assignment

**Files:**
- Modify: `src/api/blocks.rs:211-296`
- Modify: `src/vault/mutation_coordinator.rs`
- Test: `tests/api_blocks_test.rs`

**Interfaces:**
- Consumes `MutationCoordinator::lock_paths` and `atomic_replace` from Task 1.
- Produces block assignment that returns `409` for stale targets and never loses a successful concurrent assignment.

- [ ] **Step 1: Add failing API concurrency tests**

Create one test issuing two simultaneous assign-ID requests against different blocks in the same page; accept either two successes with both IDs present or one success plus one `409`, but reject two successes with one lost ID. Add a test that changes the page after indexing and before assignment, expecting `409` and unchanged content.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `cargo test --test api_blocks_test assign_block_id -- --nocapture`
Expected: at least one new race/stale-state assertion FAILS.

- [ ] **Step 3: Move lookup and validation inside the path lock**

Acquire the page lock before reading index/file state. Reload current content, validate that `span_start`/`span_end` still identify the expected block boundary, and return `ApiError::conflict` when the indexed span no longer matches current parsed content. Use checked arithmetic and UTF-8 boundaries before insertion.

- [ ] **Step 4: Atomically replace and reindex before unlocking**

Call `atomic_replace`; apply the content-changed index sequence; return success only after reindexing succeeds. Keep the guard alive through reindexing.

- [ ] **Step 5: Run focused tests**

Run: `cargo test --test api_blocks_test assign_block_id -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `fix(api): serialize block id assignment`

---

### Task 3: Exclusive asynchronous attachment storage

**Files:**
- Modify: `src/api/attachments.rs:116-243`
- Test: `tests/api_test.rs`

**Interfaces:**
- Attachment upload streams to a same-directory temporary file and installs without replacing an existing destination.
- Existing `201`, `404`, `409`, and response DTO contracts remain unchanged.

- [ ] **Step 1: Add failing simultaneous-upload test**

Issue two concurrent multipart uploads to the same attachment path with different payloads. Assert exactly one `201`, exactly one `409`, and stored bytes equal the successful request payload. Add cleanup coverage for a malformed/interrupted multipart body where feasible through the existing test server.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `cargo test --test api_test attachment -- --nocapture`
Expected: concurrent upload assertion FAILS under the forced interleaving.

- [ ] **Step 3: Implement exclusive streamed upload**

Use `tokio::fs::create_dir_all`; create a unique temporary file with `OpenOptions::create_new(true)`; consume multipart chunks into `tokio::io::AsyncWriteExt`; flush/sync; then install without replacing the destination. On collision map `AlreadyExists` to `ApiError::conflict`; on every failure remove the temporary file.

- [ ] **Step 4: Convert read/delete filesystem calls**

Use `tokio::fs::read` and `tokio::fs::remove_file`, preserving `404` checks and MIME behavior.

- [ ] **Step 5: Run focused tests**

Run: `cargo test --test api_test attachment -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `fix(api): make attachment storage exclusive`

---

### Task 4: Transactional board-code reservations

**Files:**
- Modify: `src/vault/index.rs` (schema/migration initialization)
- Modify: `src/api/board/mod.rs:310-347`
- Modify: `src/api/board/tasks.rs:60-204`
- Modify: `src/api/board/cycles.rs:74-156`
- Test: `tests/api_board_test.rs`
- Test: `tests/index_test.rs`

**Interfaces:**
- Produces `reserve_code_number(conn: &mut Connection, family: &str, observed_max: u32) -> rusqlite::Result<u32>`.
- Task and cycle creation retain exclusive filesystem creation as a second uniqueness barrier.

- [ ] **Step 1: Add failing allocator and concurrent-create tests**

Test reservation initialization from existing page maxima, monotonic subsequent reservations, independent task/cycle families, and simultaneous task/cycle API creates producing unique codes.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `cargo test --test index_test code_reservation -- --nocapture`
Run: `cargo test --test api_board_test concurrent_create -- --nocapture`
Expected: FAIL because reservation storage is absent and current max-plus-one races.

- [ ] **Step 3: Add reservation schema and transaction**

Create an internal `code_counters(family TEXT PRIMARY KEY, next_value INTEGER NOT NULL)` table during index schema setup. In an immediate transaction, initialize from `observed_max + 1`, reserve the current value, increment, and commit. Do not reuse numbers after a failed file create.

- [ ] **Step 4: Migrate task and cycle allocation**

Replace `next_code_number` with reservation. Use `create_new(true)` for both resource types; explicit user-supplied conflicts remain conflicts. Remove task-only non-exclusive retry behavior.

- [ ] **Step 5: Run focused tests**

Run both commands from Step 2; expected: PASS.

- [ ] **Step 6: Commit**

Commit: `fix(board): reserve unique task and cycle codes`

---

### Task 5: Aggregate board checkbox counts

**Files:**
- Modify: `src/api/board/read.rs:377-495`
- Test: `tests/api_board_test.rs`

**Interfaces:**
- Produces one task-loading query or one preaggregate query returning `[done, total]` by page ID.
- Preserves cancelled-in-total and done-only semantics.

- [ ] **Step 1: Add failing aggregate behavior test**

Seed tasks with no statuses, todo, done, and cancelled block properties. Assert the board response returns `[0,0]`, `[0,1]`, `[1,1]`, and `[0,1]` respectively. Add a test-only SQLite trace/count seam if the existing index permits it, asserting task count does not increase statement count; otherwise test the extracted aggregate helper directly with multiple pages in one call.

- [ ] **Step 2: Run focused test**

Run: `cargo test --test api_board_test checklist_counts -- --nocapture`
Expected: behavioral assertions may pass, but the aggregate-helper/query-count assertion FAILS.

- [ ] **Step 3: Implement grouped aggregation**

Fetch counts grouped by `page_id` once and map them into task DTOs. Remove per-task `count_checks` calls from `load_tasks`; retain a single-page helper only if the detail endpoint requires it and share the SQL aggregation semantics.

- [ ] **Step 4: Run focused test**

Run the command from Step 2; expected: PASS.

- [ ] **Step 5: Commit**

Commit: `perf(board): aggregate checklist counts`

---

### Task 6: Intent-level index mutation policies

**Files:**
- Modify: `src/vault/index_handle.rs:80-133`
- Create: `src/vault/index_policy.rs`
- Modify: `src/vault/mod.rs`
- Test: `tests/index_handle_test.rs`
- Test: `tests/link_extraction_test.rs`

**Interfaces:**
- Produces `IndexMutation::{Created, ContentChanged, Moved { old_path }, Deleted}` and `IndexHandle::apply_mutation(path: VaultPath, mutation: IndexMutation)`.
- `ContentChanged` invalidates links, indexes, resolves outgoing links, and refreshes reverse dependencies.

- [ ] **Step 1: Add failing policy tests**

Cover created, changed, moved, and deleted pages; verify outgoing links, inbound links, reverse dependencies, and stale old paths through public index queries.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `cargo test --test index_handle_test mutation_policy -- --nocapture`
Expected: FAIL because the intent API does not exist.

- [ ] **Step 3: Implement policies on the index thread**

Keep all policy steps inside one `with_index` closure. Return typed policy errors; do not discard link-resolution/database errors. Separate expected unresolved links using existing index result types rather than string matching.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2 and `cargo test --test link_extraction_test -- --nocapture`; expected: PASS.

- [ ] **Step 5: Commit**

Commit: `refactor(index): centralize mutation policies`

---

### Task 7: Mutation-service page and project cutover

**Files:**
- Modify: `src/vault/mutation_coordinator.rs`
- Modify: `src/api/pages.rs:425-584,832-937`
- Modify: `src/api/board/tasks.rs:322-380`
- Modify: `src/api/mod.rs`
- Test: `tests/api_test.rs`
- Test: `tests/api_board_test.rs`

**Interfaces:**
- Produces typed `MutationError`, `ProjectAssignment::{Unchanged, Set(String), Clear}`, page create/update commands, and project reassignment returning the final `VaultPath`.
- Consumes `IndexHandle::apply_mutation` from Task 6.

- [ ] **Step 1: Add failing service-level and route regression tests**

Cover page create conflict, page update, project set, explicit clear, unchanged no-op, projected move, destination collision, hook invocation, reverse links, response DTOs, notification ordering, and filesystem-success/index-failure reporting.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `cargo test --test api_test page_mutation -- --nocapture`
Run: `cargo test --test api_board_test project_assignment -- --nocapture`
Expected: new service/ordering assertions FAIL.

- [ ] **Step 3: Add typed mutation commands and errors**

Keep HTTP-specific types out of `vault`. Map invalid input/not-found/conflict/stale/filesystem/index/hook failures in handlers. Retain `409` only for destination/stale conflicts and existing mappings elsewhere.

- [ ] **Step 4: Cut over page create/update**

Move locking, file operation, index policy, and notification into the coordinator. Keep DTO validation and response assembly in `pages.rs`. Remove migrated direct `with_index` closures.

- [ ] **Step 5: Cut over project assignment and board-task refiling**

Normalize existing transport shapes into `ProjectAssignment`. Preserve explicit-clear folder stripping and conservative unchanged behavior. Remove duplicated reconciliation branches.

- [ ] **Step 6: Run focused tests**

Run both commands from Step 2; expected: PASS.

- [ ] **Step 7: Commit**

Commit: `refactor(api): centralize page mutations`

---

### Task 8: Remaining mutation cutover and archive compensation

**Files:**
- Modify: `src/vault/mutation_coordinator.rs`
- Modify: `src/api/board/tasks.rs`
- Modify: `src/api/board/cycles.rs`
- Modify: `src/api/journal.rs`
- Modify: `src/api/archive.rs:286-297,399-470`
- Modify: `src/api/blocks.rs`
- Test: `tests/api_board_test.rs`
- Test: `tests/api_journal_test.rs`
- Test: `tests/archive_test.rs`
- Test: `tests/api_blocks_test.rs`

**Interfaces:**
- All migrated routes use coordinator commands and intent-level index policies.
- Archive compensation returns a primary error plus collected cleanup failures.

- [ ] **Step 1: Add failing route-policy and rollback tests**

Cover task/cycle/journal/block mutations updating links and notifications consistently. Add a fault-injection seam for CAS decrement and assert every hash is attempted, the primary error remains primary, and cleanup failures are observable.

- [ ] **Step 2: Run focused tests and observe failure**

Run: `cargo test --test archive_test rollback -- --nocapture`
Run: `cargo test --test api_journal_test mutation -- --nocapture`
Expected: rollback observability and policy assertions FAIL.

- [ ] **Step 3: Migrate remaining handlers**

Replace repeated write/index/resolve/notify sequences with coordinator commands. Remove obsolete direct choreography and do not leave forwarding wrappers.

- [ ] **Step 4: Implement aggregate CAS compensation reporting**

Attempt every decrement, collect `(hash, error)` entries, attach them to the primary archive error/log context, and never substitute cleanup failure for the original request failure.

- [ ] **Step 5: Run affected suites**

Run: `cargo test --test api_board_test --test api_journal_test --test archive_test --test api_blocks_test -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `refactor(api): route mutations through coordinator`

---

### Task 9: Trust-boundary helpers, typed cycle states, and test fixture

**Files:**
- Modify: `src/api/error.rs`
- Modify: `src/api/pages.rs`
- Modify: `src/api/folders.rs`
- Modify: `src/api/index_routes.rs`
- Modify: `src/api/academic.rs`
- Modify: `src/api/board/mod.rs`
- Modify: `src/api/board/cycles.rs`
- Create: `tests/support/mod.rs`
- Modify: `tests/api_test.rs`
- Modify: `tests/api_journal_test.rs`
- Modify: `tests/api_blocks_test.rs`
- Modify: `tests/api_board_test.rs`
- Modify: `tests/archive_test.rs`
- Remove: `src/lsp/references.rs:16-32` dead helper and isolated test if still unused

**Interfaces:**
- Produces separate request-path and internal-path parsing helpers.
- Produces typed `CycleState` parsing plus operation-specific allowed-state checks.
- Produces `ApiFixture::builder()` with explicit pre-index seeding, config, hooks, and state access.

- [ ] **Step 1: Add failing focused tests**

Assert malformed request paths remain `400`, malformed stored/generated paths remain internal errors, create-cycle rejects `CLOSED`, patch-cycle accepts it, and fixture options reproduce each suite's current startup ordering.

- [ ] **Step 2: Run focused tests**

Run: `cargo test --test api_board_test cycle_state -- --nocapture`
Run: `cargo test --test api_test invalid_path -- --nocapture`
Expected: typed helper/fixture compile assertions FAIL before implementation.

- [ ] **Step 3: Implement narrow helpers and enum**

Do not create one context-free path helper. Parse valid state independently from whether create/patch permits the transition; preserve existing response messages where asserted.

- [ ] **Step 4: Extract and migrate the fixture builder**

Keep seeding-before-index versus mutation-after-index explicit. Return `TempDir`, `TestServer`, and optional `Arc<AppState>` without hidden global state.

- [ ] **Step 5: Remove confirmed dead helper**

Use LSP references first; remove only if no production caller exists. Do not retain `allow(dead_code)` or a compatibility alias.

- [ ] **Step 6: Run affected tests**

Run: `cargo test --test api_test --test api_journal_test --test api_blocks_test --test api_board_test --test archive_test -- --nocapture`
Expected: PASS.

- [ ] **Step 7: Commit**

Commit: `refactor(api): consolidate validation and test setup`

---

### Task 10: Folder authority, response mapping, and final verification

**Files:**
- Modify: `src/api/folders.rs:70-220`
- Modify: `src/api/pages.rs:187-239`
- Test: `tests/api_test.rs`
- Modify only if required by verification: files touched in Tasks 1-9

**Interfaces:**
- Folder listing has one explicit authority/fallback contract tested through the API.
- Page detail mapping has one canonical function only if all existing fields remain identical.

- [ ] **Step 1: Characterize current folder and response behavior**

Add tests for indexed files, filesystem-only files, stale indexed entries, and every page-detail endpoint. Assert the chosen contract: filesystem presence controls folder membership while index data enriches present files; stale index-only entries are omitted and filesystem-only files receive deterministic fallback summaries.

- [ ] **Step 2: Run characterization tests**

Run: `cargo test --test api_test folder_authority page_detail_mapping -- --nocapture`
Expected: PASS for preserved behavior; if behavior is inconsistent, capture the approved contract in failing assertions before editing.

- [ ] **Step 3: Centralize implementations without changing output**

Name the folder authority/fallback policy in one helper. Replace near-identical page-detail mapping only when the characterization tests prove identical output; otherwise keep endpoint-specific mapping and document the real distinction in code types rather than a comment-only fork.

- [ ] **Step 4: Run focused backend suites**

Run: `cargo test --test api_test --test api_board_test --test api_blocks_test --test api_journal_test --test archive_test --test mutation_test --test index_handle_test -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Run repository verification gates**

Run: `cargo check --all-targets`
Expected: PASS.

Run: `cargo clippy --all-targets --all-features -- -D warnings`
Expected: PASS.

Run: `cargo test --all-targets --all-features`
Expected: PASS.

Run the repository's frontend typecheck, lint, and test commands discovered from `ui/package.json`, because the required project gate covers the full repository even though no frontend behavior should change.
Expected: all PASS.

- [ ] **Step 6: Review diff and remove scaffolding**

Remove test-only timing sleeps, debug logging, dead wrappers, compatibility aliases, and obsolete imports. Preserve fault-injection seams only when they test an observable recovery contract.

- [ ] **Step 7: Commit verification fixes if needed**

Commit: `chore: finish backend refactor verification`
Skip this commit when verification required no changes.

- [ ] **Step 8: Merge**

After two-stage code review and all gates pass, merge the feature branch into `develop` and verify the merge result with the same focused smoke tests.
