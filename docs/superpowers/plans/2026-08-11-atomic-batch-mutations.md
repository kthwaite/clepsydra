# Atomic Batch Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every logical multi-file vault mutation commit or recover as one unit, then migrate all applicable callers and document explicitly compensated exceptions.

**Architecture:** `MutationCoordinator` remains the mutation authority. A focused `batch_mutation` module owns durable transaction manifests, staged/rollback bytes, publication, and recovery; the coordinator owns path locking, index reconciliation, notifications, and hooks. `MutationPlan` becomes both the preview DTO and the source of batch intents instead of executing filesystem changes itself.

**Tech Stack:** Rust, Tokio, Axum, rusqlite, serde/serde_json, tempfile, existing `IndexHandle`, `MutationCoordinator`, `MutationPlanner`, and atomic-file helpers.

## Global Constraints

- Markdown and TOML files remain authoritative.
- Do not add a second mutation coordinator.
- Acquire normalized affected paths in deterministic order before revalidating preconditions.
- A completed request or startup recovery must not leave a mixed logical mutation.
- Do not claim simultaneous multi-file rename to processes reading outside Clepsydra during commit.
- Filesystem commit precedes index reconciliation and SSE notification.
- Startup recovery runs before indexing or request serving.
- Preserve explicit per-item semantics only for operations proven not to be one logical batch.
- Follow TDD: observe each new test fail for the intended missing behavior before implementation.

---

### Task 1: Define durable batch transaction types

**Files:**
- Create: `src/vault/batch_mutation.rs`
- Modify: `src/vault/mod.rs`
- Test: `src/vault/batch_mutation.rs`

**Interfaces:**
- Produces:
  - `pub enum ExpectedPathState { Missing, Bytes(Vec<u8>) }`
  - `pub enum BatchPathIntent { Write { path: VaultPath, expected: ExpectedPathState, content: Vec<u8> }, Move { source: VaultPath, destination: VaultPath, expected_source: Vec<u8> }, Delete { path: VaultPath, expected: Vec<u8> } }`
  - `pub struct BatchMutationCommand { pub intents: Vec<BatchPathIntent>, pub index_events: Vec<ChangeEvent>, pub moved_pages: Vec<(VaultPath, VaultPath)> }`
  - private serializable `TransactionManifest` and `TransactionPhase::{Prepared, Committing, FilesystemCommitted}`
  - `BatchMutationCommand::affected_paths() -> Vec<VaultPath>` returning sorted, deduplicated source and destination paths
- Consumes: existing `VaultPath` and `ChangeEvent`.

- [ ] **Step 1: Write failing type and invariant tests**

```rust
#[test]
fn affected_paths_are_sorted_and_deduplicated() {
    let command = BatchMutationCommand {
        intents: vec![
            BatchPathIntent::Move {
                source: VaultPath::new("z.md").unwrap(),
                destination: VaultPath::new("a.md").unwrap(),
                expected_source: b"z".to_vec(),
            },
            BatchPathIntent::Write {
                path: VaultPath::new("z.md").unwrap(),
                expected: ExpectedPathState::Missing,
                content: b"new".to_vec(),
            },
        ],
        index_events: vec![],
        moved_pages: vec![],
    };
    assert_eq!(
        command.affected_paths().iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["a.md", "z.md"]
    );
}

#[test]
fn duplicate_final_destinations_are_rejected() {
    let error = validate_intents(&[
        write_missing("same.md", b"one"),
        write_missing("same.md", b"two"),
    ]).unwrap_err();
    assert!(error.to_string().contains("same.md"));
}
```

- [ ] **Step 2: Run the focused tests and verify missing types fail**

Run: `cargo test --lib vault::batch_mutation::tests -- --nocapture`  
Expected: FAIL because `batch_mutation` and its types do not exist.

- [ ] **Step 3: Implement the types and validation**

Use `BTreeSet` for deterministic paths. Reject an empty command, duplicate final destinations, a move whose source equals destination, and conflicting intents for the same source. Keep transaction serialization private so API clients cannot forge recovery manifests.

- [ ] **Step 4: Run focused tests**

Run: `cargo test --lib vault::batch_mutation::tests -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/batch_mutation.rs src/vault/mod.rs
git commit -m "feat(vault): define atomic batch mutation intents"
```

### Task 2: Persist transaction workspaces and recover phases

**Files:**
- Modify: `src/vault/batch_mutation.rs`
- Test: `src/vault/batch_mutation.rs`

**Interfaces:**
- Produces:
  - `pub(crate) struct PreparedBatch`
  - `pub(crate) fn prepare(root: &Path, command: &BatchMutationCommand) -> Result<PreparedBatch, BatchMutationError>`
  - `impl PreparedBatch { fn publish(&mut self) -> Result<(), BatchMutationError>; fn rollback(&mut self) -> Result<(), BatchMutationError>; fn mark_filesystem_committed(&mut self) -> Result<(), BatchMutationError>; fn finish(self) -> Result<(), BatchMutationError> }`
  - `pub fn recover_pending(root: &Path) -> Result<Vec<RecoveredBatch>, BatchMutationError>`
- Consumes: Task 1 transaction types.

- [ ] **Step 1: Write failure and recovery tests**

```rust
#[test]
fn prepared_transaction_does_not_change_destinations() {
    let fixture = fixture_with_file("a.md", b"before");
    let prepared = prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();
    assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
    assert!(prepared.directory().join("manifest.json").is_file());
}

#[test]
fn committing_transaction_recovers_exact_pre_state() {
    let fixture = fixture_with_files(&[("a.md", b"before-a"), ("b.md", b"before-b")]);
    let mut prepared = prepare(fixture.root(), &replace_two_files()).unwrap();
    prepared.test_publish_first_intent_only().unwrap();
    drop(prepared);
    recover_pending(fixture.root()).unwrap();
    assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before-a");
    assert_eq!(fs::read(fixture.root().join("b.md")).unwrap(), b"before-b");
}

#[test]
fn filesystem_committed_transaction_is_reported_for_index_reconciliation() {
    let fixture = fixture_with_file("a.md", b"before");
    seed_filesystem_committed_manifest(fixture.root(), "a.md", b"after");
    let recovered = recover_pending(fixture.root()).unwrap();
    assert_eq!(recovered[0].phase, TransactionPhase::FilesystemCommitted);
    assert_eq!(recovered[0].index_events, vec![ChangeEvent::Upsert(VaultPath::new("a.md").unwrap())]);
}
```

Expose deterministic `#[cfg(test)]` failpoints at: manifest flush, each publication, phase flush, each rollback publication, and workspace removal.

- [ ] **Step 2: Run focused recovery tests**

Run: `cargo test --lib vault::batch_mutation::tests -- --nocapture`  
Expected: FAIL because prepare/recovery behavior is absent.

- [ ] **Step 3: Implement durable workspace handling**

Store under `.clepsydra/transactions/<uuid>/`:

```text
manifest.json
staged/<intent-index>
rollback/<intent-index>
```

Write and `sync_all` staged and rollback files before marking `Prepared`. Write manifests through the existing atomic publication helper. After every phase change, sync the manifest and transaction directory. For a move, rollback records both the source bytes and whether the destination was missing. Recovery must be idempotent by comparing observed bytes against manifest hashes before changing a path.

- [ ] **Step 4: Run focused tests twice**

Run twice: `cargo test --lib vault::batch_mutation::tests -- --nocapture`  
Expected: PASS both times, proving repeated recovery leaves the same state.

- [ ] **Step 5: Commit**

```bash
git add src/vault/batch_mutation.rs
git commit -m "feat(vault): persist and recover batch transactions"
```

### Task 3: Execute batches through MutationCoordinator

**Files:**
- Modify: `src/vault/mutation_coordinator.rs`
- Modify: `src/vault/batch_mutation.rs`
- Test: `src/vault/mutation_coordinator.rs`
- Test: `tests/mutation_test.rs`

**Interfaces:**
- Produces:

```rust
pub async fn execute_batch(
    &self,
    vault: &Vault,
    index: &IndexHandle,
    hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
    command: BatchMutationCommand,
    notify: Arc<dyn Fn(MutationNotification) + Send + Sync>,
) -> Result<MutationNotification, MutationError>;
```

- `MutationError` gains typed `BatchPrepare`, `BatchPublish`, `BatchRollback`, and `BatchRecovery` variants containing the transaction directory when retained.
- Consumes: `BatchMutationCommand`, Task 2 preparation/publication, existing `lock_paths`, `IndexHandle`, and notification DTO.

- [ ] **Step 1: Write coordinator behavior tests**

```rust
#[tokio::test]
async fn batch_revalidates_every_path_after_lock_acquisition() {
    let fixture = coordinator_fixture(&[("a.md", "one"), ("b.md", "two")]);
    fixture.block_first_lock().await;
    let pending = fixture.execute(replace_both("one", "two", "ONE", "TWO"));
    fs::write(fixture.root().join("b.md"), "external").unwrap();
    fixture.release_lock();
    let error = pending.await.unwrap_err();
    assert!(matches!(error, MutationError::Stale(path) if path.as_str() == "b.md"));
    assert_eq!(fs::read_to_string(fixture.root().join("a.md")).unwrap(), "one");
}

#[tokio::test]
async fn batch_notifies_once_after_every_file_and_index_commit() {
    let fixture = coordinator_fixture(&[("a.md", "one"), ("b.md", "two")]);
    let notifications = Arc::new(Mutex::new(Vec::new()));
    fixture.execute_with_notifications(replace_both("one", "two", "ONE", "TWO"), notifications.clone()).await.unwrap();
    assert_eq!(notifications.lock().unwrap().as_slice(), &[MutationNotification {
        upserted: vec!["a.md".into(), "b.md".into()], removed: vec![]
    }]);
}
```

Also assert overlapping batches with reversed input order complete without deadlock.

- [ ] **Step 2: Run coordinator tests**

Run: `cargo test --lib vault::mutation_coordinator::tests::batch -- --nocapture`  
Expected: FAIL because `execute_batch` is absent.

- [ ] **Step 3: Implement coordinator orchestration**

Call `command.affected_paths()`, then `lock_paths`. Prepare/publish in `spawn_blocking` while retaining the guard. After `FilesystemCommitted`, apply all `ChangeEvent`s in one `IndexHandle::with_index` call using `SyncEngine::process_events`. Run post-move hooks only after filesystem commit and before notification. Preserve the transaction workspace if index reconciliation fails so startup recovery can reconcile.

- [ ] **Step 4: Run coordinator and mutation tests**

Run: `cargo test --lib vault::mutation_coordinator::tests::batch -- --nocapture`  
Run: `cargo test --test mutation_test -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/mutation_coordinator.rs src/vault/batch_mutation.rs tests/mutation_test.rs
git commit -m "feat(vault): coordinate durable batch commits"
```

### Task 4: Convert MutationPlan into batch intents and migrate move/delete callers

**Files:**
- Modify: `src/vault/mutation.rs`
- Modify: `src/vault/rewriter.rs`
- Modify: `src/api/pages.rs`
- Modify: `src/api/folders.rs`
- Modify: `src/vault/reconcile.rs`
- Modify: `src/vault/relabel.rs`
- Modify: `tests/mutation_test.rs`
- Modify: `tests/api_test.rs`
- Modify: `tests/academic_test.rs`

**Interfaces:**
- Produces: `MutationPlan::into_batch_command(self, vault: &Vault) -> Result<BatchMutationCommand, IndexError>`.
- Removes: `MutationPlan::execute` and `rewriter::apply_staged_writes` after every caller migrates.
- Consumes: `MutationCoordinator::execute_batch`.

- [ ] **Step 1: Write preview-to-command equivalence tests**

```rust
#[test]
fn move_plan_batch_intents_cover_every_previewed_path() {
    let plan = planned_move_with_two_backlink_rewrites();
    let preview_paths = plan.text_edits.iter().map(|edit| edit.path.as_str())
        .chain(plan.file_ops.iter().map(|op| op.path.as_str()))
        .collect::<BTreeSet<_>>();
    let command = plan.into_batch_command(&vault).unwrap();
    let command_paths = command.affected_paths().iter().map(VaultPath::as_str).collect::<BTreeSet<_>>();
    assert!(preview_paths.is_subset(&command_paths));
}
```

Add API tests that a page move/delete emits one notification and never leaves rewritten backlinks without the primary move/delete.

- [ ] **Step 2: Run mutation and API tests**

Run: `cargo test --test mutation_test move_plan_batch -- --nocapture`  
Run: `cargo test --test api_test page_move -- --nocapture`  
Expected: FAIL because plans still execute directly.

- [ ] **Step 3: Implement conversion and migrate callers**

For each staged write, read current bytes and create a `Write` intent with `ExpectedPathState::Bytes`. Convert rename/delete operations to `Move`/`Delete`. Directory creation remains preparation metadata, not a standalone logical mutation. Update page and folder handlers to plan through `IndexHandle::with_index`, release the index closure, then call `execute_batch`; never await while holding an index closure.

For `reconcile.rs` and `relabel.rs`, route through a direct coordinator helper using the same publisher/recovery code and their existing direct `VaultIndex`; do not retain a second legacy executor.

- [ ] **Step 4: Remove obsolete staged writer and run callers**

Run: `cargo test --test mutation_test -- --nocapture`  
Run: `cargo test --test api_test -- --nocapture`  
Run: `cargo test --test academic_test -- --nocapture`  
Expected: PASS and no references to `MutationPlan::execute` or `apply_staged_writes` remain.

- [ ] **Step 5: Commit**

```bash
git add src/vault/mutation.rs src/vault/rewriter.rs src/api/pages.rs src/api/folders.rs src/vault/reconcile.rs src/vault/relabel.rs tests/mutation_test.rs tests/api_test.rs tests/academic_test.rs
git commit -m "refactor(vault): execute planned moves as atomic batches"
```

### Task 5: Make cycle carryover and bulk assignment all-or-none

**Files:**
- Modify: `src/api/board/cycles.rs`
- Modify: `src/api/pages.rs`
- Modify: `src/api/openapi.rs`
- Test: `tests/api_board_test.rs`
- Test: `tests/api_test.rs`

**Interfaces:**
- Produces helper functions that prepare final page bytes without writing:

```rust
fn plan_cycle_patch_and_carryover(...) -> Result<BatchMutationCommand, ApiError>;
fn plan_bulk_assignment(...) -> Result<BatchMutationCommand, ApiError>;
```

- `POST /pages-assign-bulk` changes from per-item partial results to one successful result or one typed conflict/error; update its response schema accordingly.
- Consumes: P1 batch coordinator.

- [ ] **Step 1: Write cycle failure-injection test**

```rust
#[tokio::test]
async fn closing_cycle_rolls_back_cycle_and_every_carried_task_on_failure() {
    let (server, tmp, state) = seeded_cycle_with_two_tasks();
    state.mutation_coordinator.set_batch_publication_fail_after(Some(1));
    server.patch(&format!("/api/vault/board/cycles/{CYCLE_ID}"))
        .json(&json!({"state":"CLOSED", "carry_to":"BACKLOG"}))
        .await.assert_status_internal_server_error();
    assert_file_contains(&tmp, "cycles/S-13.md", "state: ACTIVE");
    assert_file_contains(&tmp, "tasks/one.md", "cycle: S-13");
    assert_file_contains(&tmp, "tasks/two.md", "cycle: S-13");
}
```

Add a bulk-assign test where the second path is stale and assert the first path remains unchanged.

- [ ] **Step 2: Run focused API tests**

Run: `cargo test --test api_board_test closing_cycle_rolls_back -- --exact --nocapture`  
Run: `cargo test --test api_test bulk_assign_rolls_back -- --exact --nocapture`  
Expected: FAIL because handlers still loop over independent page updates.

- [ ] **Step 3: Plan complete final bytes before executing**

Read every cycle/task or assignment page once, retain exact expected bytes, produce final `write_page_content` bytes, and execute one command. Missing files referenced by the current index are stale preconditions, not silently skipped. Use one timestamp per logical batch. Emit one notification listing sorted upserts.

- [ ] **Step 4: Run board and API suites**

Run: `cargo test --test api_board_test -- --nocapture`  
Run: `cargo test --test api_test -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/board/cycles.rs src/api/pages.rs src/api/openapi.rs tests/api_board_test.rs tests/api_test.rs
git commit -m "fix(api): commit cycle and bulk page changes atomically"
```

### Task 6: Complete the multi-resource mutation audit

**Files:**
- Create: `docs/design-notes/multi-file-mutation-audit.md`
- Modify where audit proves necessary: `src/api/archive.rs`
- Modify where audit proves necessary: `src/api/academic.rs`
- Test: `tests/api_test.rs`
- Test: `tests/academic_test.rs`

**Interfaces:**
- Audit table columns: operation, logical unit, resources, current compensation, classification, proof test.
- Required classifications:
  - page move/delete/folder move and backlink rewrites: batch coordinator,
  - cycle carryover: batch coordinator,
  - bulk assign: batch coordinator,
  - archive page plus CAS references: compensated external-resource transaction,
  - Zotero/import loops: one independently reported item per commit unless the endpoint contract declares one all-or-none import.

- [ ] **Step 1: Write the audit table before code changes**

Populate every filesystem-mutating API and offline command found through `MutationCoordinator`, `MutationPlanner`, `fs::rename`, `fs::remove_file`, `atomic_replace`, and CAS ref-count calls. Every row must cite a file/symbol and one proof test; “safe” without a failure test is not an accepted classification.

- [ ] **Step 2: Add missing compensation tests**

For archive ingestion, inject failure after CAS storage and after page publication; assert no leaked CAS references and no mismatched page. For Zotero, inject failure in item two and assert the response and on-disk state match the documented per-item contract.

Run: `cargo test --test api_test archive_ -- --nocapture`  
Run: `cargo test --test academic_test zotero_ -- --nocapture`  
Expected: at least one new test fails if an audited guarantee is not currently defended.

- [ ] **Step 3: Fix only deficiencies exposed by the audit**

Keep CAS compensation in `archive.rs` because its SQLite/blob store is a separate transactional resource; do not fake filesystem atomicity across SQLite. Make compensation idempotent and retain actionable errors. Keep per-item academic import commits only if the endpoint returns per-item outcomes and tests prove the boundary.

- [ ] **Step 4: Run audit proof suites**

Run: `cargo test --test api_test archive_ -- --nocapture`  
Run: `cargo test --test academic_test zotero_ -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/design-notes/multi-file-mutation-audit.md src/api/archive.rs src/api/academic.rs tests/api_test.rs tests/academic_test.rs
git commit -m "docs(vault): close multi-file mutation audit"
```

### Task 7: Wire startup recovery and run release gates

**Files:**
- Modify: `src/lib.rs`
- Modify: `src/vault/batch_mutation.rs`
- Test: `tests/e2e_test.rs`

**Interfaces:**
- `build_app_state_with_feeds` invokes filesystem recovery after `Vault::open` but before `VaultIndex::build`.
- `committing` transactions restore their declared pre-state before the index opens; `filesystem_committed` transactions retain their workspace through the subsequent full index build, then are finalized and removed.
- Consumes: Task 2 recovery and Task 3 reconciliation semantics.

- [ ] **Step 1: Write startup recovery integration tests**

Seed a `committing` transaction with one published path, start Clepsydra through the production initialization path, and assert both files are restored before the first index query. Seed `filesystem_committed` and assert startup indexes the committed bytes and removes the transaction directory.

- [ ] **Step 2: Run the startup tests**

Run: `cargo test --test e2e_test transaction_recovery -- --nocapture`  
Expected: FAIL because startup does not call recovery.

- [ ] **Step 3: Invoke recovery around the existing startup index build**

In `build_app_state_with_feeds`, recover pending filesystem state immediately after `Vault::open`. Build and resolve the index over the recovered/committed bytes. Only then finish `filesystem_committed` workspaces. Return a startup error with the retained transaction path when recovery or finalization cannot complete. Because all production server, test-server, and MCP-backed state construction flows through this function, do not add a second invocation in the CLI binary. Do not start the filesystem watcher or bind the API before recovery succeeds.

- [ ] **Step 4: Run feature smoke and repository gates**

Run: `cargo test --test e2e_test transaction_recovery -- --nocapture`  
Run: `cargo test --test api_board_test closing_cycle -- --nocapture`  
Run: `cargo check --all-targets --all-features`  
Run: `cargo clippy --all-targets --all-features -- -D warnings`  
Run: `cargo test --all-features`  
Run: `bun run --cwd ui typecheck`  
Run: `bun run --cwd ui lint`  
Run: `bun run --cwd ui test`  
Expected: all commands PASS. If unrelated baseline failures remain, record exact failing tests and do not claim a clean gate.

- [ ] **Step 5: Commit**

```bash
git add src/lib.rs src/vault/batch_mutation.rs tests/e2e_test.rs
git commit -m "feat(vault): recover interrupted batches before startup"
```

## Program acceptance

- No production caller invokes `MutationPlan::execute` or `apply_staged_writes`.
- Cycle carryover and bulk assignment are all-or-none logical mutations.
- Startup recovery is idempotent and precedes indexing.
- Previewed paths and committed paths are equivalent.
- The audit accounts for every multi-file or multi-resource writer with a proof test.
- One successful batch emits one post-commit notification; failed/rolled-back batches emit none.
