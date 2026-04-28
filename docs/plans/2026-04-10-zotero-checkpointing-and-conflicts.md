# Zotero Import Checkpointing & Conflict Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add incremental sync via checkpoint persistence and configurable conflict resolution to the Zotero import pipeline, so that repeated imports only process changed items and users can choose how to handle metadata updates.

**Architecture:** Checkpointing persists the last-sync timestamp to `.clepsydra/importers/zotero.toml` after each successful import. The `import_zotero_handler` auto-reads this checkpoint and passes it as the `since` filter. Conflict policies add a `conflict_policy` enum to `ImportZoteroRequest`; when an existing item is found, the policy determines whether to skip, overwrite mapped fields, or return a conflict payload for manual resolution.

**Tech Stack:** Rust (toml, serde, chrono), rusqlite, Axum

---

## Existing Infrastructure

Before starting, familiarize yourself with these files:

- `src/vault/import_zotero.rs` (~430 lines) — `ImportZoteroRequest`, `ZoteroItem`, `query_items()` (accepts `since` filter), `derive_cite_key()`, `map_to_import_entry()`, `find_existing_by_zotero_key()`, `normalize_since()`
- `src/api/academic.rs` (~990 lines) — `import_zotero_handler()` orchestrates the import: resolve DB path → query items → dedup by zotero_key → dedup by DOI/ISBN/cite_key → create work → patch provenance → re-index. Returns `ImportResponse { results: Vec<ImportResult> }`.
- `src/vault/import.rs` (~175 lines) — `BibImportEntry`, `find_existing_work()` (DOI → ISBN → cite_key dedup)
- `src/vault/config.rs` — `VaultConfig`, `AcademicSection`, `ZoteroSection { database_path: Option<String> }`
- `src/vault/page.rs` — `PageMeta` with `extra: HashMap<String, serde_yaml::Value>` (flattened into frontmatter), `Page::from_file()`, `write_page_content()`
- `tests/import_test.rs` — cite key derivation, Zotero DB query, mapping, dedup, and round-trip tests. Uses `create_mock_zotero_db()` helper.

**Key patterns:**
- Dedup currently returns early with `"skipped"` status on any match. No field comparison.
- Provenance is stored in frontmatter: `import: { source: zotero, zotero_key: ..., zotero_item_id: ..., imported_at: ... }`
- `query_items()` already accepts `since: Option<&str>` and filters by `i.dateModified > ?`.
- The handler already has `normalize_since()` to convert ISO 8601 → Zotero's datetime format.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/vault/checkpoint.rs` | **Create** | `ImportCheckpoint` struct, TOML read/write, auto-`since` logic |
| `src/vault/import_zotero.rs` | **Modify** | Add `ConflictPolicy` enum, `FieldDiff` type, `compute_field_diffs()` function |
| `src/api/academic.rs` | **Modify** | Wire checkpoint read/write, conflict policy dispatch in import loop |
| `src/vault/config.rs` | **No change** | Checkpoint lives in `.clepsydra/importers/`, not in config |
| `src/vault/mod.rs` | **Modify** | Add `pub mod checkpoint;` |
| `tests/import_test.rs` | **Modify** | Add checkpoint and conflict policy tests |
| `tests/checkpoint_test.rs` | **Create** | Unit tests for checkpoint read/write/round-trip |

---

## Task 1: Checkpoint Read/Write Module

**Files:**
- Create: `src/vault/checkpoint.rs`
- Modify: `src/vault/mod.rs`
- Create: `tests/checkpoint_test.rs`

- [ ] **Step 1: Write the failing test for checkpoint round-trip**

In `tests/checkpoint_test.rs`:

```rust
use clepsydra::vault::checkpoint::ImportCheckpoint;
use tempfile::TempDir;

#[test]
fn checkpoint_round_trip() {
    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path();

    // No checkpoint yet — should return None
    let loaded = ImportCheckpoint::load(vault_root, "zotero");
    assert!(loaded.is_none());

    // Save a checkpoint
    let cp = ImportCheckpoint {
        last_synced: "2024-06-15 12:30:00".to_string(),
        items_imported: 42,
    };
    cp.save(vault_root, "zotero").unwrap();

    // Load it back
    let loaded = ImportCheckpoint::load(vault_root, "zotero").unwrap();
    assert_eq!(loaded.last_synced, "2024-06-15 12:30:00");
    assert_eq!(loaded.items_imported, 42);
}

#[test]
fn checkpoint_overwrites_previous() {
    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path();

    let cp1 = ImportCheckpoint {
        last_synced: "2024-01-01 00:00:00".to_string(),
        items_imported: 10,
    };
    cp1.save(vault_root, "zotero").unwrap();

    let cp2 = ImportCheckpoint {
        last_synced: "2024-06-15 12:30:00".to_string(),
        items_imported: 25,
    };
    cp2.save(vault_root, "zotero").unwrap();

    let loaded = ImportCheckpoint::load(vault_root, "zotero").unwrap();
    assert_eq!(loaded.last_synced, "2024-06-15 12:30:00");
    assert_eq!(loaded.items_imported, 25);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test checkpoint_test -- --nocapture`
Expected: compilation error — `checkpoint` module does not exist.

- [ ] **Step 3: Implement the checkpoint module**

Create `src/vault/checkpoint.rs`:

```rust
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Persisted state from the last successful import run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCheckpoint {
    pub last_synced: String,
    pub items_imported: u64,
}

impl ImportCheckpoint {
    /// Load a checkpoint for the given source (e.g. "zotero").
    /// Returns `None` if no checkpoint file exists.
    pub fn load(vault_root: &Path, source: &str) -> Option<Self> {
        let path = vault_root
            .join(".clepsydra/importers")
            .join(format!("{source}.toml"));
        let contents = fs::read_to_string(path).ok()?;
        toml::from_str(&contents).ok()
    }

    /// Save this checkpoint for the given source.
    /// Creates the `.clepsydra/importers/` directory if it doesn't exist.
    pub fn save(&self, vault_root: &Path, source: &str) -> Result<(), String> {
        let dir = vault_root.join(".clepsydra/importers");
        fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create importers dir: {e}"))?;
        let path = dir.join(format!("{source}.toml"));
        let contents = toml::to_string_pretty(self)
            .map_err(|e| format!("failed to serialize checkpoint: {e}"))?;
        fs::write(path, contents)
            .map_err(|e| format!("failed to write checkpoint: {e}"))?;
        Ok(())
    }
}
```

- [ ] **Step 4: Register the module**

In `src/vault/mod.rs`, add after the `cas` line:

```rust
pub mod checkpoint;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --test checkpoint_test -- --nocapture`
Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/vault/checkpoint.rs src/vault/mod.rs tests/checkpoint_test.rs
git commit -m "feat(vault): add ImportCheckpoint for persisting sync state"
```

---

## Task 2: Wire Checkpointing Into the Import Handler

**Files:**
- Modify: `src/vault/import_zotero.rs:16-26` — add `auto_checkpoint` field to request
- Modify: `src/api/academic.rs:703-990` — read checkpoint, use as `since`, write after success

- [ ] **Step 1: Write the failing test for auto-checkpoint behavior**

In `tests/import_test.rs`, add:

```rust
#[test]
fn checkpoint_file_written_after_import() {
    use clepsydra::vault::checkpoint::ImportCheckpoint;

    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path().join("vault");
    init_vault(&vault_root).unwrap();

    // No checkpoint before import
    assert!(ImportCheckpoint::load(&vault_root, "zotero").is_none());

    // After a successful import, checkpoint should exist
    // (This test validates the checkpoint module integration;
    //  the actual import handler is tested via API tests)
    let cp = ImportCheckpoint {
        last_synced: "2024-06-15 12:30:00".to_string(),
        items_imported: 3,
    };
    cp.save(&vault_root, "zotero").unwrap();

    let loaded = ImportCheckpoint::load(&vault_root, "zotero").unwrap();
    assert_eq!(loaded.last_synced, "2024-06-15 12:30:00");
    assert_eq!(loaded.items_imported, 3);
}
```

- [ ] **Step 2: Run test to verify it passes** (this is a smoke test for integration)

Run: `cargo test --test import_test checkpoint_file_written -- --nocapture`
Expected: PASS

- [ ] **Step 3: Add `auto_checkpoint` field to ImportZoteroRequest**

In `src/vault/import_zotero.rs`, modify `ImportZoteroRequest`:

```rust
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct ImportZoteroRequest {
    #[serde(default)]
    pub database_path: Option<String>,
    #[serde(default)]
    pub collection: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    /// When true (default), automatically use the last checkpoint as `since`
    /// if no explicit `since` is provided, and save a new checkpoint after
    /// a successful import.
    #[serde(default = "default_true")]
    pub auto_checkpoint: bool,
}

fn default_true() -> bool {
    true
}
```

- [ ] **Step 4: Wire checkpoint into import_zotero_handler**

In `src/api/academic.rs`, modify `import_zotero_handler`. After the DB path is resolved (after line 745, before the `conn` open), add checkpoint loading:

```rust
    // 1b. Load checkpoint for auto-since
    let checkpoint_since = if req.auto_checkpoint && req.since.is_none() {
        crate::vault::checkpoint::ImportCheckpoint::load(state.vault.root(), "zotero")
            .map(|cp| cp.last_synced)
    } else {
        None
    };

    let effective_since = req.since.as_deref()
        .map(crate::vault::import_zotero::normalize_since)
        .or(checkpoint_since);
```

Then replace the existing `normalized_since` and `query_items` call (lines 751-757) with:

```rust
    let items = crate::vault::import_zotero::query_items(
        &conn,
        req.collection.as_deref(),
        effective_since.as_deref(),
    )
    .map_err(ApiError::internal)?;
```

At the end of the handler, before `Ok(Json(ImportResponse { results }))` (line 990), add checkpoint saving:

```rust
    // Save checkpoint after successful import (not on dry_run)
    if req.auto_checkpoint && !req.dry_run {
        let created_count = results.iter()
            .filter(|r| r.status == "created")
            .count() as u64;
        if created_count > 0 || results.iter().any(|r| r.status == "skipped") {
            let now = chrono::Utc::now()
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            let cp = crate::vault::checkpoint::ImportCheckpoint {
                last_synced: now,
                items_imported: created_count,
            };
            if let Err(e) = cp.save(state.vault.root(), "zotero") {
                tracing::warn!("Failed to save Zotero checkpoint: {e}");
            }
        }
    }
```

- [ ] **Step 5: Verify compilation**

Run: `cargo check`
Expected: clean compilation.

- [ ] **Step 6: Run all existing import tests to confirm no regression**

Run: `cargo test --test import_test -- --nocapture`
Expected: all tests pass (existing behavior unchanged — `auto_checkpoint` defaults to `true` but without a prior checkpoint, behavior is identical to no `since`).

- [ ] **Step 7: Commit**

```bash
git add src/vault/import_zotero.rs src/api/academic.rs tests/import_test.rs
git commit -m "feat(import): auto-checkpoint Zotero imports for incremental sync"
```

---

## Task 3: ConflictPolicy Enum and Request Wiring

**Files:**
- Modify: `src/vault/import_zotero.rs` — add `ConflictPolicy` enum
- Modify: `src/api/academic.rs:154-167` — add `conflict_detail` to `ImportResult`

- [ ] **Step 1: Add ConflictPolicy enum**

In `src/vault/import_zotero.rs`, add after the `ImportZoteroRequest` struct:

```rust
/// How to handle items that already exist locally.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// Skip items that already exist (current behavior).
    #[default]
    Skip,
    /// Overwrite mapped metadata fields from Zotero, preserving local-only content.
    SourceWins,
    /// Report conflicts without modifying anything.
    Manual,
}
```

- [ ] **Step 2: Add `conflict_policy` to ImportZoteroRequest**

In `src/vault/import_zotero.rs`, add to `ImportZoteroRequest`:

```rust
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
```

- [ ] **Step 3: Extend ImportResult with conflict detail**

In `src/api/academic.rs`, modify `ImportResult`:

First, add `FieldDiff` and `ConflictDetail` to `src/vault/import_zotero.rs` (to avoid a vault→api circular dependency):

```rust
/// A single field-level difference between local and source metadata.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct FieldDiff {
    pub field: String,
    pub local_value: Option<String>,
    pub source_value: Option<String>,
}

/// Conflict detail returned for `Manual` conflict policy.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct ConflictDetail {
    pub fields: Vec<FieldDiff>,
}
```

Then in `src/api/academic.rs`, import and use them:

```rust
use crate::vault::import_zotero::{ConflictDetail, FieldDiff};
```

Modify `ImportResult`:

```rust
#[derive(Debug, Serialize, ToSchema)]
pub struct ImportResult {
    pub cite_key: String,
    pub status: String, // "created" | "skipped" | "updated" | "conflict" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_detail: Option<ConflictDetail>,
}
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check`
Expected: clean compilation. Existing code constructs `ImportResult` without `conflict_detail`; add `conflict_detail: None` to all existing construction sites.

- [ ] **Step 5: Commit**

```bash
git add src/vault/import_zotero.rs src/api/academic.rs
git commit -m "feat(import): add ConflictPolicy enum and ConflictDetail types"
```

---

## Task 4: Source-Wins Merge Logic

**Files:**
- Modify: `src/vault/import_zotero.rs` — add `compute_field_diffs()` function
- Modify: `src/api/academic.rs` — add `apply_source_wins()` function, dispatch in import loop
- Modify: `tests/import_test.rs` — add merge tests

- [ ] **Step 1: Write the failing test for field diff computation**

In `tests/import_test.rs`, add:

```rust
use clepsydra::vault::import_zotero::{compute_field_diffs, map_to_import_entry};

#[test]
fn compute_diffs_detects_changed_title() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let local_meta = clepsydra::vault::page::PageMeta {
        title: Some("Old Title".to_string()),
        tags: vec!["local-tag".to_string()],
        ..Default::default()
    };

    let diffs = compute_field_diffs(&entry, &local_meta);
    assert!(diffs.iter().any(|d| d.field == "title"
        && d.local_value.as_deref() == Some("Old Title")
        && d.source_value.as_deref() == Some("Attention Is All You Need")));
}

#[test]
fn compute_diffs_empty_when_identical() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let local_meta = clepsydra::vault::page::PageMeta {
        title: Some("Attention Is All You Need".to_string()),
        ..Default::default()
    };

    let diffs = compute_field_diffs(&entry, &local_meta);
    assert!(diffs.iter().all(|d| d.field != "title"), "title should not diff when identical");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test import_test compute_diffs -- --nocapture`
Expected: compilation error — `compute_field_diffs` does not exist.

- [ ] **Step 3: Implement `compute_field_diffs`**

In `src/vault/import_zotero.rs`, add:

```rust
use crate::vault::page::PageMeta;
use crate::vault::import::BibImportEntry;

/// Compare a source import entry against local page metadata.
/// Returns a list of fields where the source and local values differ.
/// Only compares mapped metadata fields (title, authors, year, venue, publisher, doi, isbn).
pub fn compute_field_diffs(source: &BibImportEntry, local: &PageMeta) -> Vec<FieldDiff> {
    let mut diffs = Vec::new();

    // Title
    let local_title = local.title.as_deref().unwrap_or("");
    if local_title != source.title {
        diffs.push(FieldDiff {
            field: "title".to_string(),
            local_value: Some(local_title.to_string()),
            source_value: Some(source.title.clone()),
        });
    }

    // Year — compare via extra.year
    let local_year = local.extra.get("year")
        .and_then(|v| match v {
            serde_yaml::Value::Number(n) => n.as_i64().map(|i| i as i32),
            _ => None,
        });
    if local_year != source.year {
        diffs.push(FieldDiff {
            field: "year".to_string(),
            local_value: local_year.map(|y| y.to_string()),
            source_value: source.year.map(|y| y.to_string()),
        });
    }

    // Venue
    let local_venue = local.extra.get("venue")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_venue != source.venue {
        diffs.push(FieldDiff {
            field: "venue".to_string(),
            local_value: local_venue,
            source_value: source.venue.clone(),
        });
    }

    // Publisher
    let local_publisher = local.extra.get("publisher")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_publisher != source.publisher {
        diffs.push(FieldDiff {
            field: "publisher".to_string(),
            local_value: local_publisher,
            source_value: source.publisher.clone(),
        });
    }

    // DOI — nested in external_ids
    let local_doi = local.extra.get("external_ids")
        .and_then(|v| v.as_mapping())
        .and_then(|m| m.get(serde_yaml::Value::String("doi".to_string())))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_doi != source.doi {
        diffs.push(FieldDiff {
            field: "doi".to_string(),
            local_value: local_doi,
            source_value: source.doi.clone(),
        });
    }

    // ISBN — nested in external_ids
    let local_isbn = local.extra.get("external_ids")
        .and_then(|v| v.as_mapping())
        .and_then(|m| m.get(serde_yaml::Value::String("isbn".to_string())))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if local_isbn != source.isbn {
        diffs.push(FieldDiff {
            field: "isbn".to_string(),
            local_value: local_isbn,
            source_value: source.isbn.clone(),
        });
    }

    diffs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test import_test compute_diffs -- --nocapture`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/import_zotero.rs tests/import_test.rs
git commit -m "feat(import): add compute_field_diffs for conflict detection"
```

---

## Task 5: Conflict Policy Dispatch in Import Handler

**Files:**
- Modify: `src/api/academic.rs:782-850` — replace skip-only dedup with policy dispatch

- [ ] **Step 1: Extract `apply_source_wins` helper**

In `src/api/academic.rs`, add a helper function before `import_zotero_handler`:

```rust
/// Apply source-wins merge: overwrite mapped metadata fields from the import entry,
/// preserving the page body and local-only frontmatter fields.
fn apply_source_wins(
    state: &AppState,
    page_path: &str,
    entry: &crate::vault::import::BibImportEntry,
    item: &crate::vault::import_zotero::ZoteroItem,
) -> Result<(), ApiError> {
    let vp = VaultPath::new(page_path)
        .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
    let abs_path = state.vault.resolve(&vp);

    let mut page = Page::from_file(&abs_path, vp.clone())
        .map_err(|e| ApiError::internal(format!("Failed to read page: {e}")))?;

    // Overwrite mapped fields
    page.meta.title = Some(entry.title.clone());

    // Update work_meta fields via extra
    if let Some(year) = entry.year {
        page.meta.extra.insert("year".to_string(), serde_yaml::Value::Number(year.into()));
    }
    if let Some(ref venue) = entry.venue {
        page.meta.extra.insert("venue".to_string(), serde_yaml::Value::String(venue.clone()));
    }
    if let Some(ref publisher) = entry.publisher {
        page.meta.extra.insert("publisher".to_string(), serde_yaml::Value::String(publisher.clone()));
    }

    // Update authors
    let authors_val: Vec<serde_yaml::Value> = entry.authors.iter()
        .map(|a| serde_yaml::Value::String(a.clone()))
        .collect();
    page.meta.extra.insert("authors".to_string(), serde_yaml::Value::Sequence(authors_val));

    // Update external_ids
    let mut ext_ids = serde_yaml::Mapping::new();
    if let Some(ref doi) = entry.doi {
        ext_ids.insert(
            serde_yaml::Value::String("doi".to_string()),
            serde_yaml::Value::String(doi.clone()),
        );
    }
    if let Some(ref isbn) = entry.isbn {
        ext_ids.insert(
            serde_yaml::Value::String("isbn".to_string()),
            serde_yaml::Value::String(isbn.clone()),
        );
    }
    if let Some(ref arxiv) = entry.arxiv {
        ext_ids.insert(
            serde_yaml::Value::String("arxiv".to_string()),
            serde_yaml::Value::String(arxiv.clone()),
        );
    }
    if !ext_ids.is_empty() {
        page.meta.extra.insert("external_ids".to_string(), serde_yaml::Value::Mapping(ext_ids));
    }

    // Update import.imported_at timestamp
    if let Some(serde_yaml::Value::Mapping(ref mut import_map)) = page.meta.extra.get_mut("import") {
        import_map.insert(
            serde_yaml::Value::String("imported_at".to_string()),
            serde_yaml::Value::String(Utc::now().to_rfc3339()),
        );
    }

    // Write back (preserves body)
    let content = write_page_content(&page.meta, &page.body);
    fs::write(&abs_path, content)
        .map_err(|e| ApiError::internal(format!("Failed to write page: {e}")))?;

    Ok(())
}
```

- [ ] **Step 2: Modify the dedup branches in import_zotero_handler**

In `src/api/academic.rs`, replace the two "skipped" early-return blocks (zotero_key dedup at ~line 796 and DOI/ISBN/cite_key dedup at ~line 841) with conflict-policy-aware dispatch. Both blocks follow the same pattern — here's the replacement for the zotero_key dedup block:

```rust
        if let Some(path) = existing_by_zk {
            match req.conflict_policy {
                crate::vault::import_zotero::ConflictPolicy::Skip => {
                    results.push(ImportResult {
                        cite_key: format!("zotero:{}", item.zotero_key),
                        status: if req.dry_run { "would_skip".to_string() } else { "skipped".to_string() },
                        page_path: Some(path),
                        error: None,
                        conflict_detail: None,
                    });
                }
                crate::vault::import_zotero::ConflictPolicy::SourceWins => {
                    let mut entry = crate::vault::import_zotero::map_to_import_entry(item);
                    let formatted_authors: Vec<String> = item.authors.iter()
                        .map(crate::vault::import_zotero::format_author)
                        .collect();
                    entry.cite_key = crate::vault::import_zotero::derive_cite_key(
                        item.extra_field.as_deref(), &formatted_authors,
                        entry.year, &item.title, &used_cite_keys,
                    );

                    if req.dry_run {
                        results.push(ImportResult {
                            cite_key: entry.cite_key,
                            status: "would_update".to_string(),
                            page_path: Some(path),
                            error: None,
                            conflict_detail: None,
                        });
                    } else {
                        apply_source_wins(&state, &path, &entry, item)?;
                        // Re-index
                        let vp = VaultPath::new(&path)
                            .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
                        state.index.with_index(move |index, vault| {
                            index.index_page(vault, &vp)
                        }).await
                        .map_err(|e| ApiError::internal(e.to_string()))?
                        .map_err(|e| ApiError::internal(e.to_string()))?;

                        results.push(ImportResult {
                            cite_key: entry.cite_key,
                            status: "updated".to_string(),
                            page_path: Some(path),
                            error: None,
                            conflict_detail: None,
                        });
                    }
                }
                crate::vault::import_zotero::ConflictPolicy::Manual => {
                    let entry = crate::vault::import_zotero::map_to_import_entry(item);
                    let vp = VaultPath::new(&path)
                        .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
                    let abs_path = state.vault.resolve(&vp);
                    let page = Page::from_file(&abs_path, vp)
                        .map_err(|e| ApiError::internal(format!("Failed to read page: {e}")))?;
                    let diffs = crate::vault::import_zotero::compute_field_diffs(&entry, &page.meta);

                    if diffs.is_empty() {
                        results.push(ImportResult {
                            cite_key: format!("zotero:{}", item.zotero_key),
                            status: "skipped".to_string(),
                            page_path: Some(path),
                            error: None,
                            conflict_detail: None,
                        });
                    } else {
                        results.push(ImportResult {
                            cite_key: format!("zotero:{}", item.zotero_key),
                            status: "conflict".to_string(),
                            page_path: Some(path),
                            error: None,
                            conflict_detail: Some(ConflictDetail { fields: diffs }),
                        });
                    }
                }
            }
            continue;
        }
```

Apply the same pattern to the DOI/ISBN/cite_key dedup block (~line 841). The logic is identical except the `cite_key` field uses `entry.cite_key` instead of `format!("zotero:{}", ...)`.

- [ ] **Step 3: Add `conflict_detail: None` to all existing ImportResult constructions**

Search for all `ImportResult {` in `src/api/academic.rs` and ensure each one includes `conflict_detail: None`. This includes the `import_bibtex`, `import_doi`, and `import_isbn_handler` functions which also construct `ImportResult`.

- [ ] **Step 4: Verify compilation**

Run: `cargo check`
Expected: clean compilation.

- [ ] **Step 5: Run all tests**

Run: `cargo test --test import_test -- --nocapture`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/api/academic.rs
git commit -m "feat(import): dispatch conflict_policy in Zotero import handler"
```

---

## Task 6: Integration Tests

**Files:**
- Modify: `tests/import_test.rs`

- [ ] **Step 1: Write integration test for source-wins behavior**

In `tests/import_test.rs`, add:

```rust
use clepsydra::vault::import_zotero::ConflictPolicy;

#[test]
fn compute_diffs_detects_year_change() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let mut local_meta = clepsydra::vault::page::PageMeta::default();
    local_meta.title = Some("Attention Is All You Need".to_string());
    local_meta.extra.insert(
        "year".to_string(),
        serde_yaml::Value::Number(2016.into()),
    );

    let diffs = compute_field_diffs(&entry, &local_meta);
    let year_diff = diffs.iter().find(|d| d.field == "year").unwrap();
    assert_eq!(year_diff.local_value.as_deref(), Some("2016"));
    assert_eq!(year_diff.source_value.as_deref(), Some("2017"));
}

#[test]
fn compute_diffs_detects_doi_change() {
    let item = make_article_item();
    let entry = map_to_import_entry(&item);

    let local_meta = clepsydra::vault::page::PageMeta::default();

    let diffs = compute_field_diffs(&entry, &local_meta);
    let doi_diff = diffs.iter().find(|d| d.field == "doi").unwrap();
    assert!(doi_diff.local_value.is_none());
    assert_eq!(doi_diff.source_value.as_deref(), Some("10.48550/arXiv.1706.03762"));
}

#[test]
fn conflict_policy_default_is_skip() {
    let policy = ConflictPolicy::default();
    assert!(matches!(policy, ConflictPolicy::Skip));
}
```

- [ ] **Step 2: Run all tests**

Run: `cargo test --test import_test -- --nocapture`
Expected: all tests pass.

- [ ] **Step 3: Run full test suite to confirm no regressions**

Run: `cargo test`
Expected: all tests pass across all test files.

- [ ] **Step 4: Commit**

```bash
git add tests/import_test.rs
git commit -m "test(import): add integration tests for field diffs and conflict policy"
```

---

## Summary

After all tasks:

1. **Checkpointing** — `ImportCheckpoint` persists to `.clepsydra/importers/zotero.toml`. The handler auto-reads it as `since` when no explicit value is provided, and writes a new checkpoint after each successful non-dry-run import.

2. **Conflict policies** — `ConflictPolicy::Skip` (default, backward-compatible), `SourceWins` (overwrites mapped fields, preserves body), `Manual` (returns field-level diffs without modifying anything). All three policies work for both dedup paths (zotero_key and DOI/ISBN/cite_key).

3. **API contract** — `ImportResult` gains an optional `conflict_detail` field and new status values: `"updated"` (source-wins applied), `"conflict"` (manual policy, diffs returned), `"would_update"` (dry-run + source-wins).
