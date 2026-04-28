# Mutation Robustness & Edge Case Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical self-link/internal-ref path collision in mutation execution, harden delete_folder index cleanup, widen backlink safety check, add partial-failure recovery, optimize MostRecent ranking, and reduce lock contention.

**Architecture:** Six issues, ordered by severity. Tasks 1-3 are correctness bugs (self-link collision, delete_folder dependency gaps, backlink check blind spot). Task 4 adds best-effort recovery rebuild on partial mutation failure. Task 5 preloads timestamps to eliminate N log N DB queries. Task 6 splits the Mutex scope to separate planning from execution.

**Tech Stack:** Rust 2024 edition, Axum 0.8, rusqlite, axum_test

---

## Task 1: Fix self-link and folder-internal backlink collisions in mutation planner

The `find_backlink_pages` query (mutation.rs:578) returns ALL pages linking to a target, including the target itself (self-link) and pages inside a folder being moved. After the mutation ordering fix (file ops first, then staged writes), this creates three failure modes:

- **Delete with self-link:** Page A has `[[A]]`. find_backlink_pages returns A. Execution: delete A, then staged_writes recreates A at its old path.
- **Move with self-link:** Page A at `notes/a.md` has `[[A]]`. ref_abs points to old path. Execution: rename A to `archive/a.md`, then staged_writes creates orphan at `notes/a.md`.
- **Folder move with internal cross-refs:** `notes/b.md` links to `notes/a.md`. ref_abs = `/vault/notes/b.md`. After folder rename to `archive/`, staged write targets pre-rename path, creating orphan `notes/b.md`.

**Files:**
- Modify: `src/vault/mutation.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Write failing test — delete page with self-link**

In `tests/mutation_test.rs`, add a test that creates a page with a self-link, deletes it via MutationPlanner, and verifies the file is truly gone (not recreated by staged writes).

```rust
#[test]
fn delete_page_with_self_link_does_not_recreate_file() {
    let (tmp, vault) = setup_vault(&[
        ("selfie.md", "---\ntitle: Selfie\n---\nSee [[Selfie]] for more."),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "selfie.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    plan.execute(&vault, &mut index).unwrap();

    let abs_path = vault.resolve(&VaultPath::new("selfie.md").unwrap());
    assert!(!abs_path.exists(), "deleted file should not be recreated by staged writes");
}
```

Look at the existing tests in `tests/mutation_test.rs` to match the `setup_vault` helper pattern. If it doesn't exist there, use the one from `tests/index_test.rs`:

```rust
fn setup_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel_path, content) in files {
        let abs = root.join(rel_path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test delete_page_with_self_link -- --nocapture`

Expected: FAIL — assertion that file doesn't exist fails because staged_writes recreates it.

**Step 3: Write failing test — move page with self-link**

```rust
#[test]
fn move_page_with_self_link_no_orphan_at_old_path() {
    let (tmp, vault) = setup_vault(&[
        ("original.md", "---\ntitle: Original\n---\nSee [[Original]]."),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "original.md".to_string(),
            destination: "moved.md".to_string(),
        })
        .unwrap();

    plan.execute(&vault, &mut index).unwrap();

    let old_path = vault.resolve(&VaultPath::new("original.md").unwrap());
    let new_path = vault.resolve(&VaultPath::new("moved.md").unwrap());
    assert!(!old_path.exists(), "old path should not have orphan copy");
    assert!(new_path.exists(), "new path should exist");
}
```

**Step 4: Write failing test — folder move with internal cross-refs**

```rust
#[test]
fn folder_move_internal_refs_no_orphan_outside() {
    let (tmp, vault) = setup_vault(&[
        ("notes/a.md", "---\ntitle: A\n---\nContent of A."),
        ("notes/b.md", "---\ntitle: B\n---\nSee [[A]]."),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MoveFolder {
            source: "notes".to_string(),
            destination: "archive".to_string(),
        })
        .unwrap();

    plan.execute(&vault, &mut index).unwrap();

    // Old paths should not exist
    let old_b = vault.resolve(&VaultPath::new("notes/b.md").unwrap());
    assert!(!old_b.exists(), "notes/b.md should not have orphan after folder move");

    // New paths should exist
    let new_a = vault.resolve(&VaultPath::new("archive/a.md").unwrap());
    let new_b = vault.resolve(&VaultPath::new("archive/b.md").unwrap());
    assert!(new_a.exists(), "archive/a.md should exist");
    assert!(new_b.exists(), "archive/b.md should exist");
}
```

**Step 5: Run tests to verify they fail**

Run: `cargo test self_link -- --nocapture && cargo test orphan -- --nocapture && cargo test internal_refs -- --nocapture`

**Step 6: Implement — filter self-links and remap folder-internal paths**

Three changes in `src/vault/mutation.rs`:

**6a. In `plan_page_delete` (line 383-385):** After calling `find_backlink_pages`, filter out the target page itself:

```rust
let backlink_pages = self.find_backlink_pages(&target_vp, &old_stem)?;

// Filter: don't rewrite the page being deleted
let backlink_pages: Vec<_> = backlink_pages
    .into_iter()
    .filter(|(_, p)| p != path)
    .collect();
```

**6b. In `plan_page_move` (line 269-272):** Same self-filter:

```rust
let backlink_pages = self.find_backlink_pages(&source_vp, &old_stem)?;

// Filter: don't rewrite the page being moved (it's handled by the rename)
let backlink_pages: Vec<_> = backlink_pages
    .into_iter()
    .filter(|(_, p)| p != source)
    .collect();
```

**6c. In `plan_folder_move` (line 493-499):** Filter out pages inside the source folder AND remap paths for any folder-internal backlinks if they come from outside:

```rust
let backlink_pages = self.find_backlink_pages(old_vp, &old_stem)?;

// Filter: skip pages inside the moved folder — their internal
// cross-references don't need rewriting since the whole folder moves.
let source_prefix = format!("{}/", source_vp.as_str());
let backlink_pages: Vec<_> = backlink_pages
    .into_iter()
    .filter(|(_, p)| !p.starts_with(&source_prefix))
    .collect();
```

This is correct because internal pages keep their relative positions when the whole folder moves — wikilinks resolve by canonical name (unchanged), and markdown relative links stay valid since both source and target moved together.

**Step 7: Run all tests**

Run: `cargo test`

Expected: All pass, including the three new tests.

**Step 8: Commit**

```bash
git add src/vault/mutation.rs tests/mutation_test.rs
git commit -m "fix(vault): filter self-links and folder-internal refs in mutation planner

find_backlink_pages returned the target page itself (self-links) and
pages inside a moved folder. After the recent mutation ordering fix
(file ops before rewrites), this caused staged writes to recreate
deleted files or create orphan copies at pre-rename paths.

- plan_page_delete: exclude target page from backlink rewrites
- plan_page_move: exclude source page from backlink rewrites
- plan_folder_move: exclude folder-internal pages from rewrites"
```

---

## Task 2: Fix delete_folder to use SyncEngine for proper dependency re-resolution

The current `delete_folder` cleanup (folders.rs:246-278) calls `invalidate_links_to` + `remove_page` for each orphaned page but does NOT re-resolve affected dependents. In ambiguous link scenarios, links that could resolve after a competing page is deleted remain stale.

The `SyncEngine::process_events` with `ChangeEvent::Remove` handles this correctly: it collects reverse deps before removal, then re-resolves them.

**Files:**
- Modify: `src/api/folders.rs`
- Test: `tests/api_test.rs`

**Step 1: Write failing test — link resolves after ambiguity broken by folder delete**

```rust
#[tokio::test]
async fn delete_folder_re_resolves_affected_links() {
    let (server, _tmp) = setup_server();

    // Create a page outside the folder
    server
        .post("/api/vault/pages/main.md")
        .json(&serde_json::json!({
            "title": "Main",
            "body": "See [[Shared]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Create two pages named "shared" — one outside, one in the folder
    server
        .post("/api/vault/pages/shared.md")
        .json(&serde_json::json!({
            "title": "Shared",
            "body": "I am the real Shared."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/dups/shared.md")
        .json(&serde_json::json!({
            "title": "Shared",
            "body": "I am the duplicate Shared."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // At this point [[Shared]] is ambiguous (2 candidates), so the link is unresolved
    let res = server.get("/api/vault/index/unresolved").await;
    let unresolved: Vec<serde_json::Value> = res.json();
    let shared_unresolved = unresolved.iter().any(|u| u["target_raw"] == "Shared");
    assert!(shared_unresolved, "[[Shared]] should be unresolved due to ambiguity");

    // Delete the folder with the duplicate
    server
        .delete("/api/vault/folders/dups?recursive=true")
        .await
        .assert_status(StatusCode::NO_CONTENT);

    // Now [[Shared]] should resolve (only one candidate remains)
    let res = server.get("/api/vault/index/unresolved").await;
    let unresolved: Vec<serde_json::Value> = res.json();
    let shared_still_unresolved = unresolved.iter().any(|u| u["target_raw"] == "Shared");
    assert!(
        !shared_still_unresolved,
        "[[Shared]] should resolve after ambiguity broken by folder delete"
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test delete_folder_re_resolves -- --nocapture`

Expected: FAIL — the link stays unresolved because delete_folder doesn't re-resolve dependents.

**Step 3: Implement — replace manual loop with SyncEngine**

In `src/api/folders.rs`, replace the manual `invalidate_links_to` + `remove_page` loop (lines 246-278) with `SyncEngine::process_events`:

```rust
// Remove orphaned pages from the index
{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    // Find pages that were under this folder
    let folder_prefix = format!("{}/", vault_path.as_str());
    let orphaned: Vec<String> = {
        let mut stmt = index
            .connection()
            .prepare("SELECT path FROM pages WHERE path LIKE ?1")
            .map_err(|e| ApiError::internal(e.to_string()))?;
        stmt.query_map(params![format!("{}%", folder_prefix)], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect()
    };

    if !orphaned.is_empty() {
        use crate::vault::sync::{ChangeEvent, SyncEngine};
        let events: Vec<ChangeEvent> = orphaned
            .iter()
            .filter_map(|p| VaultPath::new(p).ok())
            .map(ChangeEvent::Remove)
            .collect();
        SyncEngine::process_events(&events, &state.vault, &mut index)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
}
```

This replaces the manual loop. `SyncEngine::process_events` with `ChangeEvent::Remove` does: collect reverse deps → `invalidate_links_to` → `remove_page` → re-resolve affected dependents. Exactly what we need.

Add the necessary import at the top of `folders.rs` if not already present:
```rust
use crate::vault::path::VaultPath;
```

**Step 4: Run all tests**

Run: `cargo test`

Expected: All pass, including new test.

**Step 5: Commit**

```bash
git add src/api/folders.rs tests/api_test.rs
git commit -m "fix(api): delete_folder uses SyncEngine for proper link re-resolution

Replaced manual invalidate_links_to + remove_page loop with
SyncEngine::process_events(Remove), which also re-resolves affected
dependents. Previously, links that became unambiguous after a folder
delete would remain stale unresolved."
```

---

## Task 3: Widen backlink safety check to include unresolved and canonical links

The `delete_page` handler (pages.rs:394-396) checks for backlinks only via `target_id` (resolved links). A page with unresolved wikilinks like `[[PageName]]` where `target_id` is NULL (never resolved, or resolved to a different canonical) would not trigger the safety check.

**Files:**
- Modify: `src/api/pages.rs`
- Test: `tests/api_test.rs`

**Step 1: Write failing test — unresolved backlink blocks delete**

```rust
#[tokio::test]
async fn delete_blocked_by_unresolved_backlinks() {
    let (server, _tmp) = setup_server();

    // Create target page
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({
            "title": "Target",
            "body": "I am the target."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Create two pages with the same canonical name to make links ambiguous
    server
        .post("/api/vault/pages/sub/target.md")
        .json(&serde_json::json!({
            "title": "Target",
            "body": "I am the duplicate."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Create a page that links to "Target" (ambiguous, so unresolved)
    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({
            "title": "Source",
            "body": "See [[Target]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Try to delete target.md without force — should be blocked
    // even though the link is unresolved (target_id is NULL)
    let res = server
        .delete("/api/vault/pages/target.md")
        .await;
    res.assert_status(StatusCode::CONFLICT);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test delete_blocked_by_unresolved -- --nocapture`

Expected: FAIL — returns 204 (success) instead of 409 because the current check only queries `target_id`, which is NULL for ambiguous links.

**Step 3: Implement — widen the SQL query**

In `src/api/pages.rs` (line 393-396), replace the narrow query:

```sql
SELECT DISTINCT p.path FROM links l
JOIN pages p ON p.id = l.source_id
WHERE l.target_id = ?1 AND l.source_id != ?1
```

With a wider query that checks `target_id`, `target_path`, AND `target_canonical`:

```sql
SELECT DISTINCT p.path FROM links l
JOIN pages p ON p.id = l.source_id
WHERE (l.target_id = ?1 OR l.target_path = ?2 OR l.target_canonical = ?3)
  AND l.source_id != ?1
```

This requires passing `vault_path.as_str()` and the canonical name as additional parameters. Update the handler code:

```rust
if let Some(ref pid) = page_id {
    let canonical = CanonicalName::from_filename(vault_path.filename());
    let mut stmt = index
        .connection()
        .prepare(
            "SELECT DISTINCT p.path FROM links l
             JOIN pages p ON p.id = l.source_id
             WHERE (l.target_id = ?1 OR l.target_path = ?2 OR l.target_canonical = ?3)
               AND l.source_id != ?1",
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let backlinks: Vec<String> = stmt
        .query_map(
            params![pid, vault_path.as_str(), canonical.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    if !backlinks.is_empty() {
        return Err(ApiError::conflict_with_detail(
            format!(
                "page has {} backlink(s); use force=true to delete",
                backlinks.len()
            ),
            serde_json::json!({ "backlinks": backlinks }),
        ));
    }
}
```

**Step 4: Run all tests**

Run: `cargo test`

Expected: All pass. Verify the existing `delete_with_backlinks_returns_409` test still passes too.

**Step 5: Commit**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "fix(api): widen backlink safety check to include unresolved links

Delete safety check (force=false) now queries target_id, target_path,
and target_canonical. Previously only checked resolved links (target_id),
so pages with ambiguous/unresolved inbound refs could be deleted without
force."
```

---

## Task 4: Best-effort recovery rebuild on partial mutation failure

`MutationPlan::execute()` comments say "a full rebuild recovers correct state" if staged writes fail after file ops, but no recovery actually happens. Add a fallback `index.build()` + `index.resolve_links()` when the staged-write or sync step fails after file ops succeed.

**Files:**
- Modify: `src/vault/mutation.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Implement fallback rebuild**

In `MutationPlan::execute()` (mutation.rs:169-215), restructure so that if step 2 or 3 fails, we attempt a recovery rebuild before returning the error:

```rust
pub fn execute(
    self,
    vault: &Vault,
    index: &mut VaultIndex,
) -> Result<(), IndexError> {
    // 1. Perform file operations FIRST (primary mutation)
    for op in &self.file_ops {
        match op.kind {
            FileOpKind::Rename => {
                if let Some(ref dest) = op.destination {
                    let source_vp = VaultPath::new(&op.path).map_err(vp_err)?;
                    let dest_vp = VaultPath::new(dest).map_err(vp_err)?;
                    let source_abs = vault.resolve(&source_vp);
                    let dest_abs = vault.resolve(&dest_vp);
                    if let Some(parent) = dest_abs.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::rename(&source_abs, &dest_abs)?;
                }
            }
            FileOpKind::Delete => {
                let vp = VaultPath::new(&op.path).map_err(vp_err)?;
                let abs = vault.resolve(&vp);
                if abs.exists() {
                    fs::remove_file(&abs)?;
                }
            }
            FileOpKind::CreateDir => {
                let vp = VaultPath::new(&op.path).map_err(vp_err)?;
                let abs = vault.resolve(&vp);
                fs::create_dir_all(&abs)?;
            }
        }
    }

    // 2. Apply staged text edits + incremental index update.
    // If either fails, attempt a full rebuild to recover consistent state.
    let result = self.apply_writes_and_sync(vault, index);
    if result.is_err() {
        // Best-effort recovery: rebuild from filesystem truth
        let _ = index.build(vault);
        let _ = index.resolve_links();
    }
    result
}

fn apply_writes_and_sync(
    self,
    vault: &Vault,
    index: &mut VaultIndex,
) -> Result<(), IndexError> {
    if !self.staged_writes.is_empty() {
        rewriter::apply_staged_writes(&self.staged_writes)?;
    }

    use super::sync::SyncEngine;
    SyncEngine::process_events(&self.index_events, vault, index)?;

    Ok(())
}
```

Note: `apply_writes_and_sync` needs `self` by value since `apply_staged_writes` takes ownership via the Vec. But `execute` already takes `self` by value. However, we need to split the file_ops out before calling the helper. Restructure:

```rust
pub fn execute(
    self,
    vault: &Vault,
    index: &mut VaultIndex,
) -> Result<(), IndexError> {
    // 1. Perform file operations FIRST (primary mutation)
    for op in &self.file_ops {
        // ... same match block as current ...
    }

    // 2. Apply staged text edits + incremental index update.
    let write_result = if !self.staged_writes.is_empty() {
        rewriter::apply_staged_writes(&self.staged_writes)
            .map_err(IndexError::from)
    } else {
        Ok(())
    };

    let sync_result = if write_result.is_ok() {
        use super::sync::SyncEngine;
        SyncEngine::process_events(&self.index_events, vault, index)
    } else {
        // Skip sync if writes failed — rebuild will handle it
        Err(write_result.unwrap_err())
    };

    // 3. If either step failed, attempt recovery rebuild
    if let Err(ref _e) = sync_result {
        let _ = index.build(vault);
        let _ = index.resolve_links();
    }

    sync_result
}
```

Actually, keep it simpler:

```rust
pub fn execute(
    self,
    vault: &Vault,
    index: &mut VaultIndex,
) -> Result<(), IndexError> {
    // 1. Perform file operations FIRST (primary mutation)
    for op in &self.file_ops {
        match op.kind {
            FileOpKind::Rename => { /* unchanged */ }
            FileOpKind::Delete => { /* unchanged */ }
            FileOpKind::CreateDir => { /* unchanged */ }
        }
    }

    // 2. Apply staged writes and sync index.
    // On failure, attempt a full rebuild to restore consistency.
    let post_result = (|| -> Result<(), IndexError> {
        if !self.staged_writes.is_empty() {
            rewriter::apply_staged_writes(&self.staged_writes)?;
        }
        use super::sync::SyncEngine;
        SyncEngine::process_events(&self.index_events, vault, index)?;
        Ok(())
    })();

    if post_result.is_err() {
        // Best-effort recovery: rebuild index from filesystem truth
        let _ = index.build(vault);
        let _ = index.resolve_links();
    }

    post_result
}
```

**Step 2: Run all tests**

Run: `cargo test`

Expected: All pass — no behavior change for the success path.

**Step 3: Commit**

```bash
git add src/vault/mutation.rs
git commit -m "fix(vault): best-effort recovery rebuild on partial mutation failure

If staged writes or incremental sync fail after file operations succeed,
MutationPlan::execute() now attempts a full index rebuild to restore
consistency. The original error is still returned to the caller."
```

---

## Task 5: Preload timestamps in MostRecent ranking

`rank_candidates` with `DisambiguationStrategy::MostRecent` (index.rs:1125-1147) executes a `SELECT updated_at` query inside the sort comparator, resulting in O(N log N) DB queries. Preload timestamps into a HashMap.

**Files:**
- Modify: `src/vault/index.rs`

**Step 1: Implement preload**

Replace the `MostRecent` branch in `rank_candidates` (index.rs:1125-1147):

```rust
DisambiguationStrategy::MostRecent => {
    // Preload timestamps to avoid O(N log N) DB queries in sort
    use std::collections::HashMap;
    let mut timestamps: HashMap<&str, Option<String>> = HashMap::new();
    for c in &ranked {
        let ts: Option<String> = self
            .conn
            .query_row(
                "SELECT updated_at FROM pages WHERE id = ?1",
                params![c.page_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        timestamps.insert(&c.page_id, ts);
    }
    ranked.sort_by(|a, b| {
        let ts_a = timestamps.get(a.page_id.as_str()).and_then(|t| t.as_ref());
        let ts_b = timestamps.get(b.page_id.as_str()).and_then(|t| t.as_ref());
        ts_b.cmp(&ts_a)
    });
}
```

**Step 2: Run all tests**

Run: `cargo test`

Expected: All pass — same behavior, better performance.

**Step 3: Commit**

```bash
git add src/vault/index.rs
git commit -m "perf(vault): preload timestamps in MostRecent ranking

rank_candidates(MostRecent) was doing per-comparison DB queries inside
the sort comparator (O(N log N) queries). Preload all timestamps into
a HashMap for O(N) queries + O(N log N) in-memory comparisons."
```

---

## Task 6: Reduce lock scope — separate planning from execution

The `std::sync::Mutex<VaultIndex>` is held across both planning (read-only) and execution (read-write + file IO). Planning only needs `&VaultIndex` (immutable). Split the lock scope: plan with a short read lock, then re-acquire for execution. Since `std::sync::Mutex` doesn't support read/write distinction, change to `parking_lot::RwLock` which supports concurrent readers.

**Files:**
- Modify: `Cargo.toml` (add parking_lot)
- Modify: `src/api/mod.rs` (change type)
- Modify: `src/api/pages.rs` (update lock calls)
- Modify: `src/api/folders.rs` (update lock calls)
- Modify: `src/api/index_routes.rs` (update lock calls)
- Modify: `src/lib.rs` or wherever AppState is constructed (update construction)

**Step 1: Add parking_lot dependency**

In `Cargo.toml`, add:

```toml
parking_lot = "0.12"
```

**Step 2: Change AppState index type**

In `src/api/mod.rs`, change:

```rust
// BEFORE:
use std::sync::{Arc, Mutex};
pub struct AppState {
    pub vault: Vault,
    pub index: Arc<Mutex<VaultIndex>>,
    pub warnings: Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
}

// AFTER:
use std::sync::Arc;
pub struct AppState {
    pub vault: Vault,
    pub index: Arc<parking_lot::RwLock<VaultIndex>>,
    pub warnings: parking_lot::Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
}
```

**Step 3: Update all lock call sites**

`parking_lot::RwLock` uses `.read()` and `.write()` instead of `.lock()`, and does NOT return `Result` (it panics on poison, which parking_lot doesn't have). So:

- Read-only access (list queries, planning, backlink checks):
  ```rust
  // BEFORE:
  let index = state.index.lock().map_err(|_| ApiError::internal("index lock poisoned"))?;
  // AFTER:
  let index = state.index.read();
  ```

- Mutable access (index_page, execute, build):
  ```rust
  // BEFORE:
  let mut index = state.index.lock().map_err(|_| ApiError::internal("index lock poisoned"))?;
  // AFTER:
  let mut index = state.index.write();
  ```

- For `Mutex<Vec<String>>` warnings:
  ```rust
  // BEFORE:
  let mut warnings = state.warnings.lock().map_err(|_| ...)?;
  // AFTER:
  let mut warnings = state.warnings.lock();
  ```

Key call sites to update (search for `.index.lock()` and `.warnings.lock()`):

- `src/api/pages.rs`: `list_pages` (read), `get_page_by_id` (read), `delete_page` backlink check (read), `delete_page` execute (write), `move_page` execute (write), `create_page` index_page (write), `update_page` index_page (write)
- `src/api/folders.rs`: `list_folder_contents` (read if it queries index), `delete_folder` (write), `move_folder` (write)
- `src/api/index_routes.rs`: all index query endpoints (read), `rebuild` (write), `preview_mutation` (read), `create_from_link` (write)

**Step 4: Split plan/execute lock scope in mutation handlers**

Now that we have RwLock, we can plan with a read lock and execute with a write lock:

```rust
// In move_page:
// BEFORE:
{
    let mut index = state.index.lock()...;
    let planner = MutationPlanner::new(&state.vault, &index);
    let plan = planner.plan(...)...;
    plan.execute(&state.vault, &mut index)...;
}

// AFTER:
let plan = {
    let index = state.index.read();
    let planner = MutationPlanner::new(&state.vault, &index);
    planner.plan(...)
        .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?
}; // read lock released
{
    let mut index = state.index.write();
    plan.execute(&state.vault, &mut index)
        .map_err(|e| ApiError::internal(format!("execute failed: {e}")))?;
} // write lock released
```

Apply this pattern to: `delete_page`, `move_page` (pages.rs), `move_folder` (folders.rs).

Note: There's a TOCTOU gap — another request could modify the index between plan and execute. Since `MutationPlan::execute` starts with file operations (which will fail if state changed, e.g., file already moved), and then does `SyncEngine::process_events` (which is idempotent on unchanged files), this is acceptable. The planning phase reads backlink state that could be stale by execution time, but the SyncEngine will re-resolve correctly.

**Step 5: Update server construction**

Find where `AppState` is constructed (likely `src/lib.rs` or `src/bin/cli.rs`) and update:

```rust
// BEFORE:
index: Arc::new(Mutex::new(index)),
warnings: Mutex::new(Vec::new()),

// AFTER:
index: Arc::new(parking_lot::RwLock::new(index)),
warnings: parking_lot::Mutex::new(Vec::new()),
```

Also update `tests/api_test.rs` `setup_server()` and `setup_server_with_config()`.

**Step 6: Run all tests**

Run: `cargo test`

Expected: All pass.

**Step 7: Commit**

```bash
git add Cargo.toml src/api/mod.rs src/api/pages.rs src/api/folders.rs src/api/index_routes.rs src/lib.rs tests/api_test.rs
git commit -m "perf(api): replace std::sync::Mutex with parking_lot::RwLock for index

Read-only operations (listing, querying, planning) now take a read lock,
allowing concurrent readers. Only mutations (execute, build, index_page)
take a write lock. Mutation handlers split lock scope: plan under read
lock, execute under write lock."
```

---

## Summary of Changes

| Task | Severity | Files | Change |
|------|----------|-------|--------|
| 1 | Critical | `mutation.rs`, `mutation_test.rs` | Filter self-links and folder-internal refs from backlink rewrites |
| 2 | Moderate | `folders.rs`, `api_test.rs` | Replace manual loop with `SyncEngine::process_events(Remove)` |
| 3 | Moderate | `pages.rs`, `api_test.rs` | Widen backlink check SQL to include `target_path` and `target_canonical` |
| 4 | Low | `mutation.rs` | Best-effort `index.build()` + `resolve_links()` on post-fileop failure |
| 5 | Low | `index.rs` | Preload timestamps into HashMap before sort |
| 6 | Low | Multiple | `parking_lot::RwLock`, split plan/execute lock scope |
