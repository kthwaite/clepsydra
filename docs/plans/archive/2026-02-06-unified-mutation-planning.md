# Unified Mutation Planning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the three ad-hoc mutation paths (page move, folder move, page delete) with a unified `MutationPlan` that computes all effects upfront, supports dry-run preview, and uses incremental index updates instead of full rebuilds.

**Architecture:** Introduce a `MutationPlan` struct computed by a `MutationPlanner` that captures all file operations and text edits before any writes. The planner consumes the existing `rewriter` and `index` primitives. A new `POST /index/preview-mutation` endpoint returns the plan as JSON for UI confirmation. The existing move/delete handlers are refactored to use the planner internally, and their post-mutation index updates switch from full `build()` to incremental `SyncEngine::process_events()`.

**Tech Stack:** Rust (rusqlite, Axum), existing `rewriter.rs`, `sync/mod.rs`

---

## Context

### Current State

Three mutation handlers exist with duplicated logic:

| Handler | File | Rewrite Logic | Index Update |
|---------|------|--------------|-------------|
| `move_page` | `src/api/pages.rs:510` | Inline: stem + title + rel-path replacement pairs | Full `build()` + `resolve_links()` |
| `delete_page` | `src/api/pages.rs:330` | Inline: stem + title + rel-path with DELETE sentinels | Full `build()` + `resolve_links()` (if rewrites occurred) |
| `move_folder` | `src/api/folders.rs:256` | Inline: per-file stem + title + rel-path, dedup staged writes | Full `build()` + `resolve_links()` |

All three:
1. Query backlink pages from the index
2. Build `(old_target, new_target)` replacement pairs
3. Call `rewriter::rewrite_links_in_content()` per referencing file
4. Call `rewriter::apply_staged_writes()`
5. Perform the file operation (rename/delete)
6. Full index rebuild

### What This Plan Adds

1. **`MutationPlan`** — a struct capturing all planned file operations and text edits
2. **`MutationPlanner`** — computes the plan from an operation description, without side effects
3. **Dry-run endpoint** — `POST /index/preview-mutation` returns the plan as JSON
4. **Incremental index update** — after applying mutations, use `SyncEngine::process_events()` instead of full `build()`
5. **Refactored handlers** — move/delete use the planner internally, eliminating duplication

### Files Overview

| File | Action |
|------|--------|
| `src/vault/mutation.rs` | New: `MutationOp`, `MutationPlan`, `MutationPlanner`, `PlannedFileOp`, `PlannedTextEdit` |
| `src/vault/mod.rs` | Export `mutation` module |
| `src/api/pages.rs` | Refactor `move_page` and `delete_page` to use planner |
| `src/api/folders.rs` | Refactor `move_folder` to use planner |
| `src/api/index_routes.rs` | Add `POST /index/preview-mutation` endpoint |
| `tests/mutation_test.rs` | New: tests for MutationPlanner |
| `tests/api_test.rs` | Test for preview endpoint |

### Design Decisions

**Why not a full transaction system?** Logseq uses DataScript transactions for atomicity, but our mutations are filesystem-based. The staged-write pattern already provides crash safety. The planner adds *preview* and *deduplication*, not transactional rollback.

**Why keep the rewriter as-is?** The rewriter's `rewrite_links_in_content()` and `apply_staged_writes()` are well-tested and correct. The planner delegates to them — it doesn't replace them.

**What about `compute_relative_path`?** Currently duplicated between `pages.rs` and `folders.rs`. The planner extracts it into the mutation module as a shared utility.

---

### Task 1: MutationPlan Types and MutationOp Enum

Define the core types for the mutation planning system.

**Files:**
- Create: `src/vault/mutation.rs`
- Modify: `src/vault/mod.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Write the failing test**

Create `tests/mutation_test.rs`:

```rust
use clepsydra::vault::mutation::{MutationOp, MutationPlan};

#[test]
fn mutation_plan_types_exist() {
    // Verify types are constructible
    let _op = MutationOp::MovePage {
        source: "alpha.md".to_string(),
        destination: "beta.md".to_string(),
    };

    let plan = MutationPlan::empty();
    assert!(plan.file_ops.is_empty());
    assert!(plan.text_edits.is_empty());
    assert!(plan.index_events.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test mutation_plan_types_exist -- --nocapture`
Expected: FAIL — module doesn't exist.

**Step 3: Write minimal implementation**

Create `src/vault/mutation.rs`:

```rust
use std::path::PathBuf;

use serde::Serialize;

use super::path::VaultPath;
use super::sync::ChangeEvent;

/// A mutation operation to be planned.
#[derive(Debug, Clone)]
pub enum MutationOp {
    /// Move a page from source to destination.
    MovePage {
        source: String,
        destination: String,
    },
    /// Delete a page with optional rewrite mode.
    DeletePage {
        path: String,
        rewrite: RewriteMode,
    },
    /// Move a folder from source to destination.
    MoveFolder {
        source: String,
        destination: String,
    },
}

/// How to rewrite links when deleting a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewriteMode {
    /// Replace link syntax with plain text.
    PlainText,
    /// Replace link syntax with strikethrough.
    Unlink,
    /// Leave links untouched (they become unresolved).
    None,
}

/// A planned file-system operation (not yet executed).
#[derive(Debug, Clone, Serialize)]
pub struct PlannedFileOp {
    /// What kind of operation.
    pub kind: FileOpKind,
    /// The vault-relative path affected.
    pub path: String,
    /// For renames/moves: the destination path.
    pub destination: Option<String>,
}

/// Kind of file operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpKind {
    Rename,
    Delete,
    CreateDir,
}

/// A planned text edit to a file's content.
#[derive(Debug, Clone, Serialize)]
pub struct PlannedTextEdit {
    /// Vault-relative path of the file to edit.
    pub path: String,
    /// The old content snippet being replaced (for preview).
    pub old_text: String,
    /// The new content snippet replacing it (for preview).
    pub new_text: String,
}

/// The complete plan for a mutation: what files to move/delete and what
/// text edits to make in referencing pages.
#[derive(Debug, Clone, Serialize)]
pub struct MutationPlan {
    /// File-system operations (renames, deletes, mkdir).
    pub file_ops: Vec<PlannedFileOp>,
    /// Text edits to referencing pages (link rewrites).
    pub text_edits: Vec<PlannedTextEdit>,
    /// Index events to fire after applying the plan.
    #[serde(skip)]
    pub index_events: Vec<ChangeEvent>,
    /// Staged writes: (absolute path, new content). Not serialized.
    #[serde(skip)]
    pub staged_writes: Vec<(PathBuf, String)>,
}

impl MutationPlan {
    pub fn empty() -> Self {
        Self {
            file_ops: Vec::new(),
            text_edits: Vec::new(),
            index_events: Vec::new(),
            staged_writes: Vec::new(),
        }
    }
}

/// Compute a relative path from `from_path` to `to_path`, where both are
/// vault-relative paths (e.g. `notes/a.md`, `notes/b.md`).
pub fn compute_relative_path(from_path: &str, to_path: &str) -> String {
    let from_dir = if let Some(pos) = from_path.rfind('/') {
        &from_path[..pos]
    } else {
        ""
    };

    let to_dir = if let Some(pos) = to_path.rfind('/') {
        &to_path[..pos]
    } else {
        ""
    };

    let to_filename = if let Some(pos) = to_path.rfind('/') {
        &to_path[pos + 1..]
    } else {
        to_path
    };

    if from_dir == to_dir {
        return to_filename.to_string();
    }

    let from_parts: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };

    let to_parts: Vec<&str> = if to_dir.is_empty() {
        Vec::new()
    } else {
        to_dir.split('/').collect()
    };

    let common_len = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = from_parts.len() - common_len;
    let mut result = String::new();
    for _ in 0..ups {
        result.push_str("../");
    }
    for part in &to_parts[common_len..] {
        result.push_str(part);
        result.push('/');
    }
    result.push_str(to_filename);

    result
}
```

Add to `src/vault/mod.rs`:

```rust
pub mod mutation;
```

**Step 4: Run test to verify it passes**

Run: `cargo test mutation_plan_types_exist -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/mutation.rs src/vault/mod.rs tests/mutation_test.rs
git commit -m "feat(vault): add MutationPlan types and MutationOp enum"
```

---

### Task 2: MutationPlanner — Plan Page Move

Implement the planner's `plan_page_move()` method that computes all effects of a page move without executing anything.

**Files:**
- Modify: `src/vault/mutation.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Write the failing test**

Add to `tests/mutation_test.rs`:

```rust
use std::fs;
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{MutationOp, MutationPlanner, RewriteMode};
use clepsydra::vault::path::VaultPath;
use tempfile::TempDir;

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

#[test]
fn plan_page_move_computes_text_edits() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000100
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000101
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/beta.md".to_string(),
        })
        .unwrap();

    // Should have 1 file op (rename beta.md -> archive/beta.md)
    assert_eq!(plan.file_ops.len(), 1);
    assert_eq!(plan.file_ops[0].path, "beta.md");
    assert_eq!(
        plan.file_ops[0].destination.as_deref(),
        Some("archive/beta.md")
    );

    // Should have text edits for alpha.md (rewrite [[Beta]])
    assert!(!plan.text_edits.is_empty(), "should have text edits");
    let alpha_edits: Vec<_> = plan.text_edits.iter().filter(|e| e.path == "alpha.md").collect();
    assert!(!alpha_edits.is_empty(), "should have edits for alpha.md");

    // Should have staged writes
    assert!(!plan.staged_writes.is_empty());

    // Should have index events (upsert for alpha.md and archive/beta.md,
    // remove for beta.md)
    assert!(!plan.index_events.is_empty());
}

#[test]
fn plan_page_move_no_edits_when_no_backlinks() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000102
title: Alpha
---
No links here.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "alpha.md".to_string(),
            destination: "archive/alpha.md".to_string(),
        })
        .unwrap();

    assert_eq!(plan.file_ops.len(), 1);
    assert!(plan.text_edits.is_empty());
    assert!(plan.staged_writes.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test plan_page_move -- --nocapture`
Expected: FAIL — `MutationPlanner` doesn't exist.

**Step 3: Write minimal implementation**

Add to `src/vault/mutation.rs`:

```rust
use std::fs;

use rusqlite::params;

use super::Vault;
use super::canonical::CanonicalName;
use super::index::{IndexError, VaultIndex};
use super::page::Page;
use super::rewriter;

/// Plans mutations without executing them.
pub struct MutationPlanner<'a> {
    vault: &'a Vault,
    index: &'a VaultIndex,
}

impl<'a> MutationPlanner<'a> {
    pub fn new(vault: &'a Vault, index: &'a VaultIndex) -> Self {
        Self { vault, index }
    }

    /// Compute a mutation plan for the given operation.
    pub fn plan(&self, op: &MutationOp) -> Result<MutationPlan, IndexError> {
        match op {
            MutationOp::MovePage { source, destination } => {
                self.plan_page_move(source, destination)
            }
            MutationOp::DeletePage { path, rewrite } => {
                self.plan_page_delete(path, *rewrite)
            }
            MutationOp::MoveFolder { source, destination } => {
                self.plan_folder_move(source, destination)
            }
        }
    }

    fn plan_page_move(
        &self,
        source: &str,
        destination: &str,
    ) -> Result<MutationPlan, IndexError> {
        let source_vp = VaultPath::new(source).map_err(|e| {
            IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
        })?;
        let dest_vp = VaultPath::new(destination).map_err(|e| {
            IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
        })?;

        let mut plan = MutationPlan::empty();

        // File op: rename
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Rename,
            path: source.to_string(),
            destination: Some(destination.to_string()),
        });

        // Compute replacement pairs and text edits
        let old_stem = source_vp.stem().to_string();
        let new_stem = dest_vp.stem().to_string();

        let backlink_pages = self.find_backlink_pages(&source_vp, &old_stem)?;

        // Read source page for title
        let source_abs = self.vault.resolve(&source_vp);
        let source_title = Page::from_file(&source_abs, source_vp.clone())
            .ok()
            .and_then(|p| p.meta.title);

        for (_, ref_path_str) in &backlink_pages {
            let ref_vp = VaultPath::new(ref_path_str).map_err(|e| {
                IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
            })?;
            let ref_abs = self.vault.resolve(&ref_vp);
            let content = fs::read_to_string(&ref_abs)?;

            let mut replacements: Vec<(String, String)> = Vec::new();

            if old_stem != new_stem {
                replacements.push((old_stem.clone(), new_stem.clone()));
            }

            if let Some(ref title) = source_title {
                if title != &old_stem && title != &new_stem {
                    replacements.push((title.clone(), new_stem.clone()));
                }
            }

            let old_rel = compute_relative_path(ref_vp.as_str(), source_vp.as_str());
            let new_rel = compute_relative_path(ref_vp.as_str(), dest_vp.as_str());
            if old_rel != new_rel {
                replacements.push((old_rel, new_rel));
            }

            if replacements.is_empty() {
                continue;
            }

            let replacement_refs: Vec<(&str, &str)> = replacements
                .iter()
                .map(|(old, new)| (old.as_str(), new.as_str()))
                .collect();

            let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
            if new_content != content {
                // Record text edits for preview
                for (old, new) in &replacements {
                    plan.text_edits.push(PlannedTextEdit {
                        path: ref_path_str.clone(),
                        old_text: old.clone(),
                        new_text: new.clone(),
                    });
                }
                plan.staged_writes.push((ref_abs, new_content));
            }
        }

        // Index events
        plan.index_events.push(ChangeEvent::Remove(source_vp));
        plan.index_events
            .push(ChangeEvent::Upsert(dest_vp));
        for (_, ref_path_str) in &backlink_pages {
            if let Ok(vp) = VaultPath::new(ref_path_str) {
                plan.index_events.push(ChangeEvent::Upsert(vp));
            }
        }

        Ok(plan)
    }

    fn plan_page_delete(
        &self,
        _path: &str,
        _rewrite: RewriteMode,
    ) -> Result<MutationPlan, IndexError> {
        // Placeholder — implemented in Task 3
        Ok(MutationPlan::empty())
    }

    fn plan_folder_move(
        &self,
        _source: &str,
        _destination: &str,
    ) -> Result<MutationPlan, IndexError> {
        // Placeholder — implemented in Task 4
        Ok(MutationPlan::empty())
    }

    /// Find pages that link to the given target.
    fn find_backlink_pages(
        &self,
        target_vp: &VaultPath,
        target_stem: &str,
    ) -> Result<Vec<(String, String)>, IndexError> {
        let target_canonical = CanonicalName::new(target_stem);
        let mut stmt = self.index.connection().prepare(
            "SELECT DISTINCT l.source_id, p.path
             FROM links l
             JOIN pages p ON p.id = l.source_id
             WHERE l.target_path = ?1 OR l.target_canonical = ?2",
        )?;

        let pages: Vec<(String, String)> = stmt
            .query_map(
                params![target_vp.as_str(), target_canonical.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .filter_map(|r| r.ok())
            .collect();

        Ok(pages)
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test plan_page_move -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/mutation.rs tests/mutation_test.rs
git commit -m "feat(vault): add MutationPlanner with plan_page_move()"
```

---

### Task 3: MutationPlanner — Plan Page Delete

Implement the planner's `plan_page_delete()` method.

**Files:**
- Modify: `src/vault/mutation.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn plan_page_delete_with_rewrite() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000103
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000104
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    // Should have 1 file op (delete beta.md)
    assert_eq!(plan.file_ops.len(), 1);
    assert_eq!(plan.file_ops[0].path, "beta.md");

    // Should have text edits for alpha.md
    assert!(!plan.text_edits.is_empty());

    // Should have staged writes for alpha.md
    assert!(!plan.staged_writes.is_empty());

    // Should have index events (remove for beta.md, upsert for alpha.md)
    assert!(!plan.index_events.is_empty());
}

#[test]
fn plan_page_delete_rewrite_none_no_text_edits() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000105
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000106
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::None,
        })
        .unwrap();

    // File op still present
    assert_eq!(plan.file_ops.len(), 1);

    // But no text edits or staged writes
    assert!(plan.text_edits.is_empty());
    assert!(plan.staged_writes.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test plan_page_delete -- --nocapture`
Expected: FAIL — `plan_page_delete` returns empty plan.

**Step 3: Write minimal implementation**

Replace the placeholder `plan_page_delete` in `src/vault/mutation.rs`:

```rust
fn plan_page_delete(
    &self,
    path: &str,
    rewrite: RewriteMode,
) -> Result<MutationPlan, IndexError> {
    let target_vp = VaultPath::new(path).map_err(|e| {
        IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
    })?;

    let mut plan = MutationPlan::empty();

    // File op: delete
    plan.file_ops.push(PlannedFileOp {
        kind: FileOpKind::Delete,
        path: path.to_string(),
        destination: None,
    });

    // Index event: remove
    plan.index_events.push(ChangeEvent::Remove(target_vp.clone()));

    if rewrite == RewriteMode::None {
        return Ok(plan);
    }

    // Compute rewrite edits
    let old_stem = target_vp.stem().to_string();
    let target_abs = self.vault.resolve(&target_vp);
    let page = Page::from_file(&target_abs, target_vp.clone()).map_err(|e| {
        IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
    })?;
    let display_text = page
        .meta
        .title
        .clone()
        .unwrap_or_else(|| old_stem.clone());

    let sentinel_prefix = match rewrite {
        RewriteMode::PlainText => rewriter::DELETE_PLAIN,
        RewriteMode::Unlink => rewriter::DELETE_UNLINK,
        RewriteMode::None => unreachable!(),
    };
    let sentinel = format!("{sentinel_prefix}{display_text}");

    let backlink_pages = self.find_backlink_pages(&target_vp, &old_stem)?;

    for (_, ref_path_str) in &backlink_pages {
        let ref_vp = VaultPath::new(ref_path_str).map_err(|e| {
            IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
        })?;
        let ref_abs = self.vault.resolve(&ref_vp);
        let content = fs::read_to_string(&ref_abs)?;

        let mut replacements: Vec<(String, String)> = Vec::new();
        replacements.push((old_stem.clone(), sentinel.clone()));
        if display_text != old_stem {
            replacements.push((display_text.clone(), sentinel.clone()));
        }

        let old_rel = compute_relative_path(ref_vp.as_str(), target_vp.as_str());
        if old_rel != old_stem {
            replacements.push((old_rel, sentinel.clone()));
        }

        let replacement_refs: Vec<(&str, &str)> = replacements
            .iter()
            .map(|(old, new)| (old.as_str(), new.as_str()))
            .collect();

        let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
        if new_content != content {
            for (old, _) in &replacements {
                plan.text_edits.push(PlannedTextEdit {
                    path: ref_path_str.clone(),
                    old_text: old.clone(),
                    new_text: display_text.clone(),
                });
            }
            plan.staged_writes.push((ref_abs, new_content));
            plan.index_events.push(ChangeEvent::Upsert(ref_vp));
        }
    }

    Ok(plan)
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test plan_page_delete -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/mutation.rs tests/mutation_test.rs
git commit -m "feat(vault): add plan_page_delete() to MutationPlanner"
```

---

### Task 4: MutationPlanner — Plan Folder Move

Implement the planner's `plan_folder_move()` method.

**Files:**
- Modify: `src/vault/mutation.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn plan_folder_move_rewrites_all_contained_pages() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000107
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000108
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("alpha.md", page_a),
        ("notes/beta.md", page_b),
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

    // Should have a rename file op for the folder
    assert!(
        plan.file_ops.iter().any(|op| op.path == "notes"
            && op.destination.as_deref() == Some("archive")),
        "should plan folder rename"
    );

    // Should have text edits if alpha.md links to beta.md via wikilink
    // (wikilinks use stem, which doesn't change when only the folder moves,
    // but markdown relative paths do change)
    // The key: if alpha links via [[Beta]], the stem doesn't change,
    // so no wikilink rewrite. But markdown links would change.

    // Should have index events for the moved file
    assert!(!plan.index_events.is_empty());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test plan_folder_move -- --nocapture`
Expected: FAIL — returns empty plan.

**Step 3: Write minimal implementation**

Replace the placeholder `plan_folder_move` in `src/vault/mutation.rs`:

```rust
fn plan_folder_move(
    &self,
    source: &str,
    destination: &str,
) -> Result<MutationPlan, IndexError> {
    let source_vp = VaultPath::new(source).map_err(|e| {
        IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
    })?;
    let dest_vp = VaultPath::new(destination).map_err(|e| {
        IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
    })?;

    let source_abs = self.vault.resolve(&source_vp);

    let mut plan = MutationPlan::empty();

    // File op: rename folder
    plan.file_ops.push(PlannedFileOp {
        kind: FileOpKind::Rename,
        path: source.to_string(),
        destination: Some(destination.to_string()),
    });

    // List all .md files in source folder
    let mut md_files: Vec<(VaultPath, VaultPath)> = Vec::new();
    for entry in walkdir::WalkDir::new(&source_abs)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
    {
        let abs = entry.path();
        let rel = abs.strip_prefix(self.vault.root()).map_err(|e| {
            IndexError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        })?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let suffix = rel_str.strip_prefix(source_vp.as_str()).unwrap_or(&rel_str);
        let new_rel = format!("{}{suffix}", dest_vp.as_str());

        let old_vp = VaultPath::new(&rel_str).map_err(|e| {
            IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
        })?;
        let new_vp = VaultPath::new(&new_rel).map_err(|e| {
            IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string()))
        })?;

        md_files.push((old_vp, new_vp));
    }

    // For each file, compute backlinks and build rewrites
    for (old_vp, new_vp) in &md_files {
        let old_stem = old_vp.stem().to_string();
        let new_stem = new_vp.stem().to_string();

        let backlink_pages = self.find_backlink_pages(old_vp, &old_stem)?;
        if backlink_pages.is_empty() {
            // Still need index events for the moved file
            plan.index_events.push(ChangeEvent::Remove(old_vp.clone()));
            plan.index_events.push(ChangeEvent::Upsert(new_vp.clone()));
            continue;
        }

        let old_abs = self.vault.resolve(old_vp);
        let source_title = Page::from_file(&old_abs, old_vp.clone())
            .ok()
            .and_then(|p| p.meta.title);

        for (_, ref_path_str) in &backlink_pages {
            let ref_vp = VaultPath::new(ref_path_str).map_err(|e| {
                IndexError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    e.to_string(),
                ))
            })?;
            let ref_abs = self.vault.resolve(&ref_vp);

            // Check if we already have staged content for this file
            let content = if let Some(staged) = plan.staged_writes.iter().find(|(p, _)| *p == ref_abs) {
                staged.1.clone()
            } else {
                fs::read_to_string(&ref_abs)?
            };

            let mut replacements: Vec<(String, String)> = Vec::new();

            if old_stem != new_stem {
                replacements.push((old_stem.clone(), new_stem.clone()));
            }

            if let Some(ref title) = source_title {
                if title != &old_stem && title != &new_stem {
                    replacements.push((title.clone(), new_stem.clone()));
                }
            }

            let old_rel = compute_relative_path(ref_vp.as_str(), old_vp.as_str());
            let new_rel = compute_relative_path(ref_vp.as_str(), new_vp.as_str());
            if old_rel != new_rel {
                replacements.push((old_rel, new_rel));
            }

            if replacements.is_empty() {
                continue;
            }

            let replacement_refs: Vec<(&str, &str)> = replacements
                .iter()
                .map(|(old, new)| (old.as_str(), new.as_str()))
                .collect();

            let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
            if new_content != content {
                for (old, new) in &replacements {
                    plan.text_edits.push(PlannedTextEdit {
                        path: ref_path_str.clone(),
                        old_text: old.clone(),
                        new_text: new.clone(),
                    });
                }

                // Upsert or update staged writes
                if let Some(existing) = plan.staged_writes.iter_mut().find(|(p, _)| *p == ref_abs) {
                    existing.1 = new_content;
                } else {
                    plan.staged_writes.push((ref_abs, new_content));
                }
            }
        }

        plan.index_events.push(ChangeEvent::Remove(old_vp.clone()));
        plan.index_events.push(ChangeEvent::Upsert(new_vp.clone()));
    }

    // Add upsert events for rewritten referencing pages
    for (_, ref_path_str) in plan.text_edits.iter().map(|e| ("", &e.path)) {
        if let Ok(vp) = VaultPath::new(ref_path_str) {
            if !plan.index_events.iter().any(|ev| match ev {
                ChangeEvent::Upsert(p) => p.as_str() == vp.as_str(),
                _ => false,
            }) {
                plan.index_events.push(ChangeEvent::Upsert(vp));
            }
        }
    }

    Ok(plan)
}
```

Note: you'll need to add `use walkdir;` at the top of `mutation.rs`.

**Step 4: Run test to verify it passes**

Run: `cargo test plan_folder_move -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/mutation.rs tests/mutation_test.rs
git commit -m "feat(vault): add plan_folder_move() to MutationPlanner"
```

---

### Task 5: MutationPlan Execution

Add a method to `MutationPlan` that executes the plan: applies staged writes, performs file operations, and fires incremental index events.

**Files:**
- Modify: `src/vault/mutation.rs`
- Test: `tests/mutation_test.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn execute_plan_moves_file_and_rewrites() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000110
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000111
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/beta.md".to_string(),
        })
        .unwrap();

    // Execute
    plan.execute(&vault, &mut index).unwrap();

    // Verify file moved
    assert!(!vault.resolve(&VaultPath::new("beta.md").unwrap()).exists());
    assert!(vault
        .resolve(&VaultPath::new("archive/beta.md").unwrap())
        .exists());

    // Verify alpha.md was rewritten (if stem changed, the wikilink was rewritten)
    // Since stem is the same ("beta"), only markdown relative paths change.
    // But the link is [[Beta]] (wikilink), so it stays [[Beta]].
    // That's correct — wikilinks use canonical names, not paths.

    // Verify index updated incrementally (not full rebuild)
    // Check that archive/beta.md is in the index
    let page_path: Option<String> = index
        .connection()
        .query_row(
            "SELECT path FROM pages WHERE id = '00000000-0000-0000-0000-000000000111'",
            [],
            |row| row.get(0),
        )
        .ok();
    assert_eq!(page_path.as_deref(), Some("archive/beta.md"));
}

#[test]
fn execute_plan_deletes_file_and_rewrites() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000112
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000113
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    plan.execute(&vault, &mut index).unwrap();

    // Verify file deleted
    assert!(!vault.resolve(&VaultPath::new("beta.md").unwrap()).exists());

    // Verify alpha.md was rewritten — [[Beta]] should be plain text now
    let alpha_content =
        fs::read_to_string(vault.resolve(&VaultPath::new("alpha.md").unwrap())).unwrap();
    assert!(
        !alpha_content.contains("[[Beta]]"),
        "link should have been rewritten"
    );
    assert!(
        alpha_content.contains("Beta"),
        "plain text should remain"
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test execute_plan -- --nocapture`
Expected: FAIL — `execute` method doesn't exist.

**Step 3: Write minimal implementation**

Add to `MutationPlan` in `src/vault/mutation.rs`:

```rust
impl MutationPlan {
    // ... empty() already exists

    /// Execute the planned mutation: apply staged writes, perform file
    /// operations, and incrementally update the index.
    pub fn execute(
        self,
        vault: &Vault,
        index: &mut VaultIndex,
    ) -> Result<(), IndexError> {
        // 1. Apply staged text edits (rewrite referencing pages)
        if !self.staged_writes.is_empty() {
            rewriter::apply_staged_writes(&self.staged_writes).map_err(|e| {
                IndexError::Io(e)
            })?;
        }

        // 2. Perform file operations
        for op in &self.file_ops {
            match op.kind {
                FileOpKind::Rename => {
                    if let Some(ref dest) = op.destination {
                        let source_vp = VaultPath::new(&op.path).map_err(|e| {
                            IndexError::Io(std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                e.to_string(),
                            ))
                        })?;
                        let dest_vp = VaultPath::new(dest).map_err(|e| {
                            IndexError::Io(std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                e.to_string(),
                            ))
                        })?;
                        let source_abs = vault.resolve(&source_vp);
                        let dest_abs = vault.resolve(&dest_vp);

                        if let Some(parent) = dest_abs.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        fs::rename(&source_abs, &dest_abs)?;
                    }
                }
                FileOpKind::Delete => {
                    let vp = VaultPath::new(&op.path).map_err(|e| {
                        IndexError::Io(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            e.to_string(),
                        ))
                    })?;
                    let abs = vault.resolve(&vp);
                    if abs.exists() {
                        fs::remove_file(&abs)?;
                    }
                }
                FileOpKind::CreateDir => {
                    let vp = VaultPath::new(&op.path).map_err(|e| {
                        IndexError::Io(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            e.to_string(),
                        ))
                    })?;
                    let abs = vault.resolve(&vp);
                    fs::create_dir_all(&abs)?;
                }
            }
        }

        // 3. Incrementally update the index via SyncEngine
        use super::sync::SyncEngine;
        SyncEngine::process_events(&self.index_events, vault, index)?;

        Ok(())
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test execute_plan -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/vault/mutation.rs tests/mutation_test.rs
git commit -m "feat(vault): add MutationPlan::execute() with incremental index update"
```

---

### Task 6: Refactor API Handlers to Use Planner

Replace the inline rewrite logic in `move_page`, `delete_page`, and `move_folder` with the `MutationPlanner`.

**Files:**
- Modify: `src/api/pages.rs`
- Modify: `src/api/folders.rs`
- Test: Run existing tests (no new tests — this is a refactor)

**Step 1: Run existing tests to establish baseline**

Run: `cargo test`
Record the number of passing tests.

**Step 2: Refactor `move_page` in `src/api/pages.rs`**

Replace the inline rewrite logic (lines ~534-638) with:

```rust
async fn move_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<MovePageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    let source_vp =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let source_abs = state.vault.resolve(&source_vp);
    if !source_abs.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    let dest_vp = VaultPath::new(&body.destination)
        .map_err(|e| ApiError::bad_request(format!("invalid destination: {e}")))?;
    let dest_abs = state.vault.resolve(&dest_vp);
    if dest_abs.exists() {
        return Err(ApiError::conflict(format!(
            "destination already exists: {}",
            body.destination
        )));
    }

    // Plan and execute
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        let planner = MutationPlanner::new(&state.vault, &index);
        let plan = planner
            .plan(&MutationOp::MovePage {
                source: path.clone(),
                destination: body.destination.clone(),
            })
            .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

        plan.execute(&state.vault, &mut index)
            .map_err(|e| ApiError::internal(format!("execute failed: {e}")))?;
    }

    // Return updated page detail
    let page = Page::from_file(&dest_abs, dest_vp.clone())
        .map_err(|e| ApiError::internal(format!("failed to read moved page: {e}")))?;

    let canonical = if let Some(ref title) = page.meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(dest_vp.stem())
    };

    Ok(Json(PageDetail {
        path: dest_vp.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta,
        body: page.body,
    }))
}
```

**Step 3: Refactor `delete_page` in `src/api/pages.rs`**

Replace the inline rewrite logic with the planner. The backlink check (409 without force) stays as-is — only the rewrite + delete + index update path uses the planner.

```rust
// In delete_page, after the backlink check and before the response:
// Replace the rewrite, index cleanup, file delete, and re-index blocks with:

let rewrite_mode = match query.rewrite.as_str() {
    "unlink" => RewriteMode::Unlink,
    "none" => RewriteMode::None,
    _ => RewriteMode::PlainText,
};

{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let planner = MutationPlanner::new(&state.vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: path.clone(),
            rewrite: rewrite_mode,
        })
        .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

    plan.execute(&state.vault, &mut index)
        .map_err(|e| ApiError::internal(format!("execute failed: {e}")))?;
}

Ok(StatusCode::NO_CONTENT.into_response())
```

**Step 4: Refactor `move_folder` in `src/api/folders.rs`**

Replace the inline rewrite logic with:

```rust
{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let planner = MutationPlanner::new(&state.vault, &index);
    let plan = planner
        .plan(&MutationOp::MoveFolder {
            source: path.clone(),
            destination: body.destination.clone(),
        })
        .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

    plan.execute(&state.vault, &mut index)
        .map_err(|e| ApiError::internal(format!("execute failed: {e}")))?;
}

Ok(StatusCode::OK.into_response())
```

**Step 5: Run all existing tests**

Run: `cargo test`
Expected: ALL existing tests pass (same count as baseline, no regressions).

**Step 6: Run clippy**

Run: `cargo clippy`
Fix any warnings.

**Step 7: Commit**

```bash
git add src/api/pages.rs src/api/folders.rs
git commit -m "refactor(api): use MutationPlanner for move/delete handlers"
```

---

### Task 7: Dry-Run Preview Endpoint

Add `POST /index/preview-mutation` that returns a mutation plan as JSON without executing it.

**Files:**
- Modify: `src/api/index_routes.rs`
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn preview_mutation_returns_plan() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000120
title: Alpha
---
Link to [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000121
title: Beta
---
Content.
"#;

    let app = setup_test_app(&[("alpha.md", page_a), ("beta.md", page_b)]);

    let body = serde_json::json!({
        "operation": "move_page",
        "source": "beta.md",
        "destination": "archive/beta.md"
    });

    let resp = app
        .post("/api/vault/index/preview-mutation")
        .json(&body)
        .await;
    resp.assert_status_ok();

    let plan: serde_json::Value = resp.json();

    // Should have file_ops
    let file_ops = plan["file_ops"].as_array().unwrap();
    assert!(!file_ops.is_empty());
    assert_eq!(file_ops[0]["kind"], "rename");
    assert_eq!(file_ops[0]["path"], "beta.md");

    // Should have text_edits (may be empty if only wikilinks and stem doesn't change)
    assert!(plan["text_edits"].is_array());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test preview_mutation_returns_plan -- --nocapture`
Expected: FAIL — endpoint doesn't exist.

**Step 3: Write minimal implementation**

Add route in `src/api/index_routes.rs`:

```rust
.route("/preview-mutation", post(preview_mutation))
```

Add request type and handler:

```rust
use crate::vault::mutation::{MutationOp, MutationPlanner, RewriteMode};

#[derive(Debug, Deserialize)]
struct PreviewMutationRequest {
    operation: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    destination: String,
    #[serde(default = "default_rewrite_mode")]
    rewrite: String,
}

fn default_rewrite_mode() -> String {
    "plain_text".to_string()
}

async fn preview_mutation(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewMutationRequest>,
) -> Result<Response, ApiError> {
    let op = match req.operation.as_str() {
        "move_page" => MutationOp::MovePage {
            source: req.source,
            destination: req.destination,
        },
        "delete_page" => {
            let rewrite = match req.rewrite.as_str() {
                "unlink" => RewriteMode::Unlink,
                "none" => RewriteMode::None,
                _ => RewriteMode::PlainText,
            };
            MutationOp::DeletePage {
                path: req.source,
                rewrite,
            }
        }
        "move_folder" => MutationOp::MoveFolder {
            source: req.source,
            destination: req.destination,
        },
        other => {
            return Err(ApiError::bad_request(format!(
                "unknown operation: {other}"
            )));
        }
    };

    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let planner = MutationPlanner::new(&state.vault, &index);
    let plan = planner
        .plan(&op)
        .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

    Ok((StatusCode::OK, Json(&plan)).into_response())
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test preview_mutation_returns_plan -- --nocapture`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): add POST /index/preview-mutation for dry-run mutation preview"
```

---

### Task 8: Clean Up Duplicated Code and Final Pass

Remove the now-unused inline rewrite logic and the duplicated `compute_relative_path` function. Run full test suite and clippy.

**Files:**
- Modify: `src/api/pages.rs` — remove unused `compute_relative_path`, unused `find_backlink_pages` (now in mutation.rs), unused rewriter imports
- Modify: `src/api/folders.rs` — remove unused `compute_relative_path`, unused rewriter imports
- Verify: all tests pass, clippy clean

**Step 1: Identify dead code**

After the refactor in Task 6, the following should be unused in `pages.rs`:
- `compute_relative_path()` — now in `mutation.rs`
- `find_backlink_pages()` — now in `MutationPlanner`
- Various rewriter imports

And in `folders.rs`:
- `compute_relative_path()` — now in `mutation.rs`

**IMPORTANT**: `find_backlink_pages()` in `pages.rs` may still be used by the backlink check in `delete_page` (the 409 check before force). Check carefully before removing. If so, keep it for the 409 check, or extract it to a shared location.

Also: the `upsert_page_in_index()` helper in `pages.rs` is used by `create_page` and `update_page` — those were NOT refactored (they don't need the planner). Keep this helper.

**Step 2: Remove dead code**

Remove only what is truly unused. Use `cargo clippy` to identify dead code warnings.

**Step 3: Run full test suite**

Run: `cargo test`
Expected: ALL PASS

**Step 4: Run clippy**

Run: `cargo clippy -- -W clippy::all`
Fix any warnings.

**Step 5: Commit**

```bash
git add src/api/pages.rs src/api/folders.rs
git commit -m "chore: remove duplicated mutation logic after planner refactor"
```
