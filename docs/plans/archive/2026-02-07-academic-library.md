# Academic Library Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a domain layer for academic works (papers, books) with structured citation metadata, cite_key-based wikilink resolution, annotation pages, and filtered listing — all composed on top of vault core's `PageMeta::extra` without modifying core structs.

**Architecture:** Academic metadata (`kind: work`, `work_type`, `authors`, `cite_key`, etc.) lives in `PageMeta::extra` (persisted in `meta_json`). A `CiteKeyDeriver` registers cite_keys in `canonical_names` for wikilink resolution. A new `AcademicMoveHook` rewrites `work_path` in annotation frontmatter when a work is moved. API endpoints under `/api/vault/academic/` provide typed CRUD on top of generic page operations. Filtering uses SQLite `json_extract()` on `meta_json`.

**Tech Stack:** Rust, Axum 0.8, rusqlite (JSON1 extension via `bundled`), serde_yaml, existing Deriver/PostMoveHook traits.

---

### Task 1: Academic types module + config section

**Files:**
- Create: `src/vault/academic.rs`
- Modify: `src/vault/mod.rs` (add `pub mod academic;`)
- Modify: `src/vault/config.rs` (add `AcademicSection`)
- Test: `tests/academic_test.rs`

**Context:** The types come from the spec in `_features/002-academic-library.md`. The `PageMeta::extra` is `HashMap<String, serde_yaml::Value>`. We need:
1. Domain types (`WorkMeta`, `AnnotationMeta`, enums)
2. Helpers to convert between `PageMeta::extra` and academic types
3. Config section for folder paths

`VaultConfig` is in `src/vault/config.rs:22-26`. `VaultSection` is at lines 28-40. Add an optional `academic` section.

**Step 1: Write the failing test**

Create `tests/academic_test.rs`:

```rust
use std::collections::HashMap;

use clepsydra::vault::academic::{WorkMeta, WorkType, ReadingStatus, AnnotationMeta, AnnotationType};

#[test]
fn work_meta_roundtrip_through_extra() {
    use clepsydra::vault::academic::{work_meta_to_extra, extra_to_work_meta};
    use clepsydra::vault::page::PageMeta;

    let work = WorkMeta {
        work_type: WorkType::Paper,
        authors: vec!["Ashish Vaswani".to_string()],
        year: Some(2017),
        venue: Some("NeurIPS".to_string()),
        publisher: None,
        status: Some(ReadingStatus::Unread),
        rating: Some(5),
        external_ids: None,
        urls: None,
        assets: vec![],
        cite_key: Some("vaswani2017attention".to_string()),
        extra: HashMap::new(),
    };

    let extra = work_meta_to_extra(&work);
    assert_eq!(extra.get("kind").and_then(|v| v.as_str()), Some("work"));
    assert_eq!(extra.get("work_type").and_then(|v| v.as_str()), Some("paper"));

    let roundtripped = extra_to_work_meta(&extra).expect("should parse back");
    assert_eq!(roundtripped.cite_key, Some("vaswani2017attention".to_string()));
    assert!(matches!(roundtripped.work_type, WorkType::Paper));
    assert_eq!(roundtripped.year, Some(2017));
}

#[test]
fn annotation_meta_roundtrip() {
    use clepsydra::vault::academic::{annotation_meta_to_extra, extra_to_annotation_meta};
    use uuid::Uuid;

    let work_id = Uuid::now_v7();
    let ann = AnnotationMeta {
        work_id,
        work_path: Some("library/papers/attention.md".to_string()),
        source_asset: None,
        source_location: None,
        annotation_type: Some(AnnotationType::Highlight),
        extra: HashMap::new(),
    };

    let extra = annotation_meta_to_extra(&ann);
    assert_eq!(extra.get("kind").and_then(|v| v.as_str()), Some("annotation"));

    let roundtripped = extra_to_annotation_meta(&extra).expect("should parse back");
    assert_eq!(roundtripped.work_id, work_id);
}

#[test]
fn academic_config_defaults() {
    use clepsydra::vault::config::VaultConfig;

    let config = VaultConfig::default();
    assert_eq!(config.academic.library_folder, "library");
    assert_eq!(config.academic.papers_folder, "library/papers");
    assert_eq!(config.academic.annotations_folder, "library/annotations");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test --test academic_test`
Expected: FAIL — module does not exist

**Step 3: Create `src/vault/academic.rs`**

```rust
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkType {
    Paper,
    Book,
    Thesis,
    Report,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadingStatus {
    Unread,
    Reading,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationType {
    Highlight,
    Note,
}

// ---------------------------------------------------------------------------
// Nested value types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExternalIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkUrls {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceLocation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<[f32; 4]>,
}

// ---------------------------------------------------------------------------
// Work metadata (fields beyond PageMeta core)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkMeta {
    pub work_type: WorkType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ReadingStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ids: Option<ExternalIds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<WorkUrls>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cite_key: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

// ---------------------------------------------------------------------------
// Annotation metadata (fields beyond PageMeta core)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationMeta {
    pub work_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_location: Option<SourceLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation_type: Option<AnnotationType>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

// ---------------------------------------------------------------------------
// Conversion helpers: WorkMeta <-> PageMeta::extra
// ---------------------------------------------------------------------------

/// Convert `WorkMeta` into `PageMeta::extra` entries.
/// Injects `kind: "work"` so the page is identifiable as an academic work.
pub fn work_meta_to_extra(work: &WorkMeta) -> HashMap<String, serde_yaml::Value> {
    let value = serde_yaml::to_value(work).expect("WorkMeta serializes");
    let mut map: HashMap<String, serde_yaml::Value> = match value {
        serde_yaml::Value::Mapping(m) => m
            .into_iter()
            .filter_map(|(k, v)| Some((k.as_str()?.to_string(), v)))
            .collect(),
        _ => HashMap::new(),
    };
    map.insert(
        "kind".to_string(),
        serde_yaml::Value::String("work".to_string()),
    );
    map
}

/// Try to extract `WorkMeta` from `PageMeta::extra`.
/// Returns `None` if `kind != "work"` or deserialization fails.
pub fn extra_to_work_meta(
    extra: &HashMap<String, serde_yaml::Value>,
) -> Option<WorkMeta> {
    let kind = extra.get("kind")?.as_str()?;
    if kind != "work" {
        return None;
    }
    // Build a serde_yaml::Mapping from the extra entries (excluding "kind")
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in extra {
        if k != "kind" {
            mapping.insert(
                serde_yaml::Value::String(k.clone()),
                v.clone(),
            );
        }
    }
    serde_yaml::from_value(serde_yaml::Value::Mapping(mapping)).ok()
}

/// Convert `AnnotationMeta` into `PageMeta::extra` entries.
/// Injects `kind: "annotation"`.
pub fn annotation_meta_to_extra(ann: &AnnotationMeta) -> HashMap<String, serde_yaml::Value> {
    let value = serde_yaml::to_value(ann).expect("AnnotationMeta serializes");
    let mut map: HashMap<String, serde_yaml::Value> = match value {
        serde_yaml::Value::Mapping(m) => m
            .into_iter()
            .filter_map(|(k, v)| Some((k.as_str()?.to_string(), v)))
            .collect(),
        _ => HashMap::new(),
    };
    map.insert(
        "kind".to_string(),
        serde_yaml::Value::String("annotation".to_string()),
    );
    map
}

/// Try to extract `AnnotationMeta` from `PageMeta::extra`.
/// Returns `None` if `kind != "annotation"` or deserialization fails.
pub fn extra_to_annotation_meta(
    extra: &HashMap<String, serde_yaml::Value>,
) -> Option<AnnotationMeta> {
    let kind = extra.get("kind")?.as_str()?;
    if kind != "annotation" {
        return None;
    }
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in extra {
        if k != "kind" {
            mapping.insert(
                serde_yaml::Value::String(k.clone()),
                v.clone(),
            );
        }
    }
    serde_yaml::from_value(serde_yaml::Value::Mapping(mapping)).ok()
}
```

**Step 4: Add `pub mod academic;` to `src/vault/mod.rs`**

**Step 5: Add academic config section to `src/vault/config.rs`**

Add to `VaultConfig`:
```rust
#[derive(Debug, Clone, Default, Deserialize)]
pub struct VaultConfig {
    #[serde(default)]
    pub vault: VaultSection,
    #[serde(default)]
    pub academic: AcademicSection,
}
```

Add the section:
```rust
#[derive(Debug, Clone, Deserialize)]
pub struct AcademicSection {
    #[serde(default = "default_library_folder")]
    pub library_folder: String,
    #[serde(default = "default_papers_folder")]
    pub papers_folder: String,
    #[serde(default = "default_books_folder")]
    pub books_folder: String,
    #[serde(default = "default_annotations_folder")]
    pub annotations_folder: String,
}

impl Default for AcademicSection {
    fn default() -> Self {
        Self {
            library_folder: default_library_folder(),
            papers_folder: default_papers_folder(),
            books_folder: default_books_folder(),
            annotations_folder: default_annotations_folder(),
        }
    }
}

fn default_library_folder() -> String { "library".to_string() }
fn default_papers_folder() -> String { "library/papers".to_string() }
fn default_books_folder() -> String { "library/books".to_string() }
fn default_annotations_folder() -> String { "library/annotations".to_string() }
```

**Step 6: Run test to verify it passes**

Run: `cargo test --test academic_test`
Expected: PASS

**Step 7: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 8: Commit**

```bash
git add src/vault/academic.rs src/vault/mod.rs src/vault/config.rs tests/academic_test.rs
git commit -m "feat(vault): add academic types module and config section"
```

---

### Task 2: CiteKeyDeriver

**Files:**
- Create: `src/vault/derivers/cite_key.rs`
- Modify: `src/vault/derivers/mod.rs` (add `pub mod cite_key;`)
- Modify: `src/vault/index.rs` (register deriver)
- Test: `tests/academic_test.rs`

**Context:** The existing `CanonicalNameDeriver` inserts title/filename/alias entries into `canonical_names`. The `CiteKeyDeriver` does the same for `cite_key` from `PageMeta::extra`, with `source = 'cite_key'`. This enables `[[vaswani2017attention]]` to resolve to the work page. The deriver pattern is in `src/vault/derivers/canonical_names.rs`.

**Step 1: Write the failing test**

In `tests/academic_test.rs`:

```rust
use std::fs;
use tempfile::TempDir;
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;

#[test]
fn cite_key_resolves_via_wikilink() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    // Write a work page with cite_key
    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000200
kind: work
work_type: paper
title: Attention Is All You Need
cite_key: vaswani2017attention
tags: []
---
Content.
";
    fs::write(root.join("attention.md"), work_content).unwrap();

    // Write a page that links via cite_key
    let linker_content = "\
---
id: 00000000-0000-0000-0000-000000000201
title: My Notes
tags: []
---
See [[vaswani2017attention]] for details.
";
    fs::write(root.join("notes.md"), linker_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // The link [[vaswani2017attention]] should resolve to attention.md
    let unresolved = index.unresolved_with_candidates().unwrap();
    let cite_key_unresolved: Vec<_> = unresolved
        .iter()
        .filter(|u| u.target_raw == "vaswani2017attention")
        .collect();
    assert!(
        cite_key_unresolved.is_empty(),
        "cite_key link should be resolved, but found unresolved: {:?}",
        cite_key_unresolved
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test cite_key_resolves`
Expected: FAIL — cite_key not registered as canonical name

**Step 3: Create `src/vault/derivers/cite_key.rs`**

```rust
use rusqlite::{Transaction, params};

use crate::vault::canonical::CanonicalName;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives a canonical name entry from the `cite_key` field in PageMeta::extra.
///
/// When a page has `cite_key: "foo2024bar"` in its frontmatter, this deriver
/// registers it in `canonical_names` with `source = 'cite_key'`, enabling
/// `[[foo2024bar]]` wikilinks to resolve to that page.
pub struct CiteKeyDeriver;

impl Deriver for CiteKeyDeriver {
    fn name(&self) -> &str {
        "cite_key"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        let cite_key = match page.meta.extra.get("cite_key") {
            Some(v) => match v.as_str() {
                Some(s) if !s.is_empty() => s,
                _ => return Ok(()),
            },
            None => return Ok(()),
        };

        let cn = CanonicalName::new(cite_key);
        tx.execute(
            "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'cite_key')",
            params![cn.as_str(), page_id],
        )?;

        Ok(())
    }
}
```

**Step 4: Register deriver**

Add `pub mod cite_key;` to `src/vault/derivers/mod.rs`.

In `src/vault/index.rs`, where derivers are registered in `VaultIndex::open()`, add:
```rust
Box::new(derivers::cite_key::CiteKeyDeriver),
```

**Step 5: Run test to verify it passes**

Run: `cargo test cite_key_resolves`
Expected: PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 7: Commit**

```bash
git add src/vault/derivers/cite_key.rs src/vault/derivers/mod.rs src/vault/index.rs tests/academic_test.rs
git commit -m "feat(vault): add CiteKeyDeriver for cite_key wikilink resolution"
```

---

### Task 3: PostMoveHook wiring + AcademicMoveHook

**Files:**
- Modify: `src/vault/mutation.rs` (accept hooks in `execute()`)
- Create: `src/vault/academic_hook.rs` (or add to `academic.rs`)
- Modify: `src/api/mod.rs` (add hooks to AppState)
- Modify: `src/api/pages.rs` (pass hooks to `execute()`)
- Modify: `src/api/folders.rs` (pass hooks to `execute()`)
- Modify: `src/lib.rs` (register academic hook at startup)
- Test: `tests/academic_test.rs`

**Context:** `PostMoveHook` trait exists in `src/vault/hooks.rs` but isn't called anywhere. `MutationPlan::execute()` signature is `fn execute(self, vault: &Vault, index: &mut VaultIndex) -> Result<(), IndexError>`. We need to add a `hooks: &[Box<dyn PostMoveHook>]` parameter and call hooks after page-move file ops.

The academic move hook queries the index for annotations with `work_id` matching the moved page's UUID, then rewrites their `work_path` frontmatter.

**Step 1: Write the failing test**

In `tests/academic_test.rs`:

```rust
#[test]
fn move_work_updates_annotation_work_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    // Create papers folder
    fs::create_dir_all(root.join("library/papers")).unwrap();
    fs::create_dir_all(root.join("library/annotations")).unwrap();
    fs::create_dir_all(root.join("archive")).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000300
kind: work
work_type: paper
title: My Paper
cite_key: mypaper2024
tags: []
---
Paper content.
";
    fs::write(root.join("library/papers/my-paper.md"), work_content).unwrap();

    let ann_content = "\
---
id: 00000000-0000-0000-0000-000000000301
kind: annotation
work_id: 00000000-0000-0000-0000-000000000300
work_path: library/papers/my-paper.md
annotation_type: highlight
tags: []
---
A highlight.
";
    fs::write(root.join("library/annotations/highlight-1.md"), ann_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Move the work page
    use clepsydra::vault::mutation::{MutationOp, MutationPlanner};
    use clepsydra::vault::academic_hook::AcademicMoveHook;
    use clepsydra::vault::hooks::PostMoveHook;

    let hooks: Vec<Box<dyn PostMoveHook>> = vec![Box::new(AcademicMoveHook)];
    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "library/papers/my-paper.md".to_string(),
            destination: "archive/my-paper.md".to_string(),
        })
        .unwrap();
    plan.execute(&vault, &mut index, &hooks).unwrap();

    // Verify annotation's work_path was updated
    let ann_content = fs::read_to_string(root.join("library/annotations/highlight-1.md")).unwrap();
    assert!(
        ann_content.contains("work_path: archive/my-paper.md")
            || ann_content.contains("work_path: \"archive/my-paper.md\""),
        "expected work_path updated to archive/my-paper.md, got: {ann_content}"
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test move_work_updates`
Expected: FAIL — `execute()` doesn't accept hooks, `AcademicMoveHook` doesn't exist

**Step 3: Update `MutationPlan::execute()` signature**

In `src/vault/mutation.rs`, change:
```rust
pub fn execute(
    self,
    vault: &Vault,
    index: &mut VaultIndex,
    hooks: &[Box<dyn crate::vault::hooks::PostMoveHook>],
) -> Result<(), IndexError> {
```

After the file-move operations (Rename ops) and before the sync step, call hooks for each Rename:
```rust
// Call post-move hooks for renames
for op in &self.file_ops {
    if let FileOpKind::Rename { destination } = &op.kind {
        let old_vp = VaultPath::new(&op.path).map_err(vp_err)?;
        let new_vp = VaultPath::new(destination).map_err(vp_err)?;
        // Look up page UUID from the index (page was already moved on disk)
        if let Ok(page_id_str) = index.connection().query_row(
            "SELECT id FROM pages WHERE path = ?1",
            rusqlite::params![op.path],
            |row| row.get::<_, String>(0),
        ) {
            if let Ok(page_id) = page_id_str.parse::<uuid::Uuid>() {
                for hook in hooks {
                    hook.on_page_moved(&old_vp, &new_vp, &page_id)
                        .map_err(|e| IndexError::Other(e.to_string()))?;
                }
            }
        }
    }
}
```

**Step 4: Update all callers of `execute()`**

In `src/api/pages.rs` (delete_page, move_page handlers) and `src/api/folders.rs` (move_folder handler), change `plan.execute(&state.vault, &mut index)` to `plan.execute(&state.vault, &mut index, &state.hooks)`.

Add `pub hooks: Vec<Box<dyn crate::vault::hooks::PostMoveHook>>` to `AppState` in `src/api/mod.rs`.

In `src/lib.rs`, construct and pass hooks:
```rust
use vault::academic_hook::AcademicMoveHook;

let hooks: Vec<Box<dyn vault::hooks::PostMoveHook>> = vec![
    Box::new(AcademicMoveHook),
];
// Pass to AppState
```

Update test helpers in `tests/api_test.rs` (setup_server, setup_server_with_files, setup_server_with_config) to include `hooks: vec![]`.

**Step 5: Implement `AcademicMoveHook`**

Create `src/vault/academic_hook.rs`:

```rust
use crate::vault::hooks::PostMoveHook;
use crate::vault::page::{Page, write_page_content};
use crate::vault::path::VaultPath;
use uuid::Uuid;

/// Post-move hook that rewrites `work_path` in annotation frontmatter
/// when the referenced work page is moved.
pub struct AcademicMoveHook;

impl PostMoveHook for AcademicMoveHook {
    fn on_page_moved(
        &self,
        _old_path: &VaultPath,
        new_path: &VaultPath,
        page_id: &Uuid,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // This hook needs vault root to find annotation files.
        // Since we don't have vault access in the trait, the hook will be
        // called from execute() which has vault access. We'll refine the
        // trait signature to accept &Vault, or handle this at the call site.
        //
        // For now, this is a placeholder — the actual implementation will
        // iterate annotation pages in the index that have matching work_id
        // and rewrite their work_path field.
        Ok(())
    }
}
```

**IMPORTANT DESIGN NOTE:** The `PostMoveHook` trait as defined doesn't receive `&Vault` or `&VaultIndex`. The hook needs access to both to find and rewrite annotation files. Two options:

**Option A (recommended):** Expand the trait to accept `&Vault` and `&VaultIndex`:
```rust
pub trait PostMoveHook: Send + Sync {
    fn on_page_moved(
        &self,
        old_path: &VaultPath,
        new_path: &VaultPath,
        page_id: &Uuid,
        vault: &Vault,
        index: &VaultIndex,
    ) -> Result<(), Box<dyn std::error::Error>>;
}
```

**Option B:** Store vault root in the hook at construction time.

Go with Option A — it's cleaner and the trait is internal. Update `src/vault/hooks.rs` accordingly.

The `AcademicMoveHook::on_page_moved()` implementation:
1. Query index: `SELECT path FROM pages WHERE json_extract(meta_json, '$.work_id') = ?1` using `page_id.to_string()`
2. For each matching annotation page, read the file, update `work_path` in `meta.extra`, write back
3. Re-index the annotation page

**Step 6: Run test to verify it passes**

Run: `cargo test move_work_updates`
Expected: PASS

**Step 7: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 8: Commit**

```bash
git add src/vault/hooks.rs src/vault/mutation.rs src/vault/academic_hook.rs src/vault/mod.rs \
  src/api/mod.rs src/api/pages.rs src/api/folders.rs src/lib.rs \
  tests/academic_test.rs tests/api_test.rs
git commit -m "feat(vault): wire PostMoveHook into mutation execute, add AcademicMoveHook"
```

---

### Task 4: Academic API — Create Work

**Files:**
- Create: `src/api/academic.rs`
- Modify: `src/api/mod.rs` (add module + route)
- Test: `tests/api_test.rs`

**Context:** The `POST /api/vault/academic/works` endpoint creates a work page. It accepts a typed `CreateWorkRequest`, builds a `PageMeta` with academic fields in `extra`, writes the file to the configured folder (e.g., `library/papers/`), indexes it, and returns a `WorkDetail` response. cite_key uniqueness is checked against `canonical_names`. Rating is validated to be 1..=5.

**Step 1: Write the failing test**

In `tests/api_test.rs`:

```rust
#[tokio::test]
async fn create_work_page() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Attention Is All You Need",
            "authors": ["Ashish Vaswani", "Noam Shazeer"],
            "year": 2017,
            "venue": "NeurIPS",
            "cite_key": "vaswani2017attention"
        }))
        .await;

    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    assert_eq!(body["title"], "Attention Is All You Need");
    assert_eq!(body["work_type"], "paper");
    assert_eq!(body["cite_key"], "vaswani2017attention");
    assert!(body["path"].as_str().unwrap().ends_with(".md"));
}

#[tokio::test]
async fn create_work_duplicate_cite_key_returns_409() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Paper A",
            "cite_key": "samekey"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Paper B",
            "cite_key": "samekey"
        }))
        .await;

    res.assert_status(StatusCode::CONFLICT);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test create_work_page`
Expected: FAIL — 404, no route

**Step 3: Create `src/api/academic.rs`**

Define request/response types and the `create_work` handler:

- `CreateWorkRequest`: `work_type`, `title`, `authors`, `year`, `venue`, `publisher`, `status`, `rating`, `external_ids`, `urls`, `cite_key`, `tags`, `aliases`, `body`
- `WorkDetail` response: `path`, `id`, `title`, `work_type`, `authors`, `year`, `venue`, `publisher`, `status`, `rating`, `external_ids`, `urls`, `assets`, `cite_key`, `tags`, `body`
- Handler: validate rating (1..=5), check cite_key uniqueness via `canonical_names`, determine folder from `work_type` (paper→papers_folder, book→books_folder), generate slug from title via `VaultPath::from_title()`, build `PageMeta` with extra fields, write file, index, return detail
- Router: `pub fn router() -> Router<Arc<AppState>>` with `POST /works` → `create_work`

**Step 4: Mount in `src/api/mod.rs`**

Add `pub mod academic;` and nest:
```rust
.nest("/academic", academic::router())
```

**Step 5: Run test to verify it passes**

Run: `cargo test create_work`
Expected: PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`

**Step 7: Commit**

```bash
git add src/api/academic.rs src/api/mod.rs tests/api_test.rs
git commit -m "feat(api): add POST /academic/works endpoint for creating work pages"
```

---

### Task 5: Academic API — Get Work + List Works

**Files:**
- Modify: `src/api/academic.rs` (add get_work and list_works handlers)
- Test: `tests/api_test.rs`

**Context:** `GET /academic/works/by-id/:uuid` retrieves a single work by UUID. `GET /academic/works` lists works with optional query filters: `work_type`, `status`, `tag`, `author` (case-insensitive substring), `year`. Listing queries `pages.meta_json` via `json_extract()`.

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn list_works_with_filters() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "ML Paper",
            "year": 2020,
            "status": "unread",
            "tags": ["ml"]
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "book",
            "title": "ML Book",
            "year": 2019,
            "status": "done"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // List all works
    let res = server.get("/api/vault/academic/works").await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 2);

    // Filter by work_type=paper
    let res = server.get("/api/vault/academic/works?work_type=paper").await;
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["title"], "ML Paper");

    // Filter by year=2020
    let res = server.get("/api/vault/academic/works?year=2020").await;
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);

    // Filter by status=done
    let res = server.get("/api/vault/academic/works?status=done").await;
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["title"], "ML Book");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test list_works_with`
Expected: FAIL

**Step 3: Implement handlers**

`get_work`: Look up page by UUID, read file, extract `WorkMeta` from extra, build response.

`list_works`: Build a SQL query with dynamic `WHERE` clauses using `json_extract()`:
```sql
SELECT id, path, title, meta_json FROM pages
WHERE json_extract(meta_json, '$.kind') = 'work'
  AND (?1 IS NULL OR json_extract(meta_json, '$.work_type') = ?1)
  AND (?2 IS NULL OR json_extract(meta_json, '$.status') = ?2)
  AND (?3 IS NULL OR json_extract(meta_json, '$.year') = ?3)
ORDER BY path
```

For author filter: `AND json_extract(meta_json, '$.authors') LIKE '%' || ?4 || '%'` (case-insensitive via `LIKE`).

For tag filter: `EXISTS (SELECT 1 FROM tags WHERE tags.page_id = pages.id AND tags.tag = ?5)`.

Add routes:
```rust
.route("/works", get(list_works).post(create_work))
.route("/works/by-id/{uuid}", get(get_work))
```

**Step 4: Run tests**

Run: `cargo test list_works_with && cargo test && cargo clippy`

**Step 5: Commit**

```bash
git add src/api/academic.rs tests/api_test.rs
git commit -m "feat(api): add GET /academic/works and GET /academic/works/by-id/:uuid endpoints"
```

---

### Task 6: Academic API — Update Work

**Files:**
- Modify: `src/api/academic.rs` (add update_work handler)
- Test: `tests/api_test.rs`

**Context:** `PUT /academic/works/by-id/:uuid` updates a work's metadata. Only provided fields are changed (patch semantics). Re-indexes the page after write.

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn update_work_changes_status() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Update Test",
            "status": "unread"
        }))
        .await;
    res.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = res.json();
    let uuid = created["id"].as_str().unwrap();

    let res = server
        .put(&format!("/api/vault/academic/works/by-id/{uuid}"))
        .json(&serde_json::json!({
            "status": "reading",
            "rating": 4
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "reading");
    assert_eq!(body["rating"], 4);
    // Title should be unchanged
    assert_eq!(body["title"], "Update Test");
}
```

**Step 2: Implement handler**

`UpdateWorkRequest`: all fields optional. Read existing page, merge updated fields into `meta.extra`, write back, re-index.

Add route:
```rust
.route("/works/by-id/{uuid}", get(get_work).put(update_work))
```

**Step 3: Run tests + commit**

```bash
git commit -m "feat(api): add PUT /academic/works/by-id/:uuid update endpoint"
```

---

### Task 7: Academic API — Create & List Annotations

**Files:**
- Modify: `src/api/academic.rs` (add annotation handlers)
- Test: `tests/api_test.rs`

**Context:** `POST /academic/annotations` creates an annotation page linked to a work via `work_id`. `GET /academic/works/by-id/:uuid/annotations` lists annotations for a work. Annotations are stored in the configured `annotations_folder`.

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn create_and_list_annotations() {
    let (server, _tmp) = setup_server();

    // Create a work first
    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Annotated Paper"
        }))
        .await;
    res.assert_status(StatusCode::CREATED);
    let work: serde_json::Value = res.json();
    let work_id = work["id"].as_str().unwrap();

    // Create an annotation
    let res = server
        .post("/api/vault/academic/annotations")
        .json(&serde_json::json!({
            "work_id": work_id,
            "annotation_type": "highlight",
            "source_location": {"page": 4, "quote": "Important finding"},
            "tags": ["key-result"],
            "body": "This is the core contribution."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);
    let ann: serde_json::Value = res.json();
    assert_eq!(ann["work_id"], work_id);
    assert_eq!(ann["annotation_type"], "highlight");

    // List annotations for the work
    let res = server
        .get(&format!("/api/vault/academic/works/by-id/{work_id}/annotations"))
        .await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["annotation_type"], "highlight");
}
```

**Step 2: Implement handlers**

`create_annotation`: Validate `work_id` exists in index. Generate slug from annotation type + timestamp or sequence. Build `PageMeta` with annotation fields in `extra`. Write to `annotations_folder`. Index. Return detail.

`list_annotations`: Query `pages` where `json_extract(meta_json, '$.kind') = 'annotation' AND json_extract(meta_json, '$.work_id') = ?1`.

Add routes:
```rust
.route("/annotations", post(create_annotation))
.route("/works/by-id/{uuid}/annotations", get(list_annotations))
```

Note: The `{uuid}` wildcard — since Axum 0.8 requires `{*path}` only for trailing wildcards, a single `{uuid}` segment is fine here.

**Step 3: Run tests + commit**

```bash
git commit -m "feat(api): add annotation create and list endpoints"
```

---

### Task 8: Integration tests — full lifecycle

**Files:**
- Test: `tests/academic_test.rs`

**Context:** End-to-end test covering the full academic lifecycle: create work with cite_key → verify cite_key resolution → create annotation → list annotations → update work status → verify everything still resolves.

**Step 1: Write the integration test**

```rust
#[tokio::test]
async fn academic_lifecycle_integration() {
    // Uses setup_server() from api_test.rs helpers, or duplicated here
    // Full lifecycle: create work → cite_key resolves → create annotation → list → update

    // 1. Create a paper with cite_key
    // 2. Create a separate page that links via [[cite_key]] wikilink
    // 3. Rebuild index and verify link resolves (backlinks endpoint)
    // 4. Create annotation on the paper
    // 5. List annotations — verify 1 result
    // 6. Update paper status to "reading"
    // 7. Get paper — verify status changed, cite_key still present
    // 8. Get work by UUID — verify all fields
}
```

**Step 2: Implement the test** with full assertions at each step

**Step 3: Run all tests + clippy**

Run: `cargo test && cargo clippy`

**Step 4: Commit**

```bash
git add tests/academic_test.rs
git commit -m "test(api): add academic library integration lifecycle test"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Academic types + config | `academic.rs`, `config.rs` |
| 2 | CiteKeyDeriver | `derivers/cite_key.rs`, `index.rs` |
| 3 | PostMoveHook wiring + AcademicMoveHook | `hooks.rs`, `mutation.rs`, `academic_hook.rs` |
| 4 | Create Work endpoint | `api/academic.rs`, `api/mod.rs` |
| 5 | Get + List Works (with filters) | `api/academic.rs` |
| 6 | Update Work endpoint | `api/academic.rs` |
| 7 | Create + List Annotations | `api/academic.rs` |
| 8 | Integration lifecycle test | `tests/academic_test.rs` |

Dependencies: 1→2 (types before deriver), 1→3 (types before hook), 3→4 (hooks before API since API calls execute with hooks), 4→5→6 (sequential API build), 4→7 (works before annotations), all→8 (integration test last).

**Out of scope (deferred):** BibTeX/DOI/ISBN importers (roadmap Phase 7), `works` denormalized table (spec Phase 2), CSL rendering, Zotero sync.
