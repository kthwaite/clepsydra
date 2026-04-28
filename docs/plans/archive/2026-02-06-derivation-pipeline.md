# Derivation Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the monolithic derivation logic from `VaultIndex::build()` into a composable pipeline of pluggable `Deriver` traits, so that new derived artifacts (embeddings, publish index, academic metadata) can be added without modifying the index builder.

**Architecture:** Introduce a `Deriver` trait with a `derive(&self, page: &IndexedPage, tx: &Transaction)` method. Extract the four current derivation concerns (canonical names, body links, property ref links, tags) into individual `Deriver` implementations. Refactor `VaultIndex` to hold a `Vec<Box<dyn Deriver>>` and iterate over them in pass 2. The parse/walk/UUID-conflict logic stays in `build()` — only the per-page persistence dispatches to derivers. A new `IndexedPage` struct (renamed from the private `ParsedFile`) becomes the shared intermediate representation passed to each deriver.

**Tech Stack:** Rust 2024 edition, rusqlite (bundled), existing vault modules (unchanged APIs)

**Spec:** `docs/design-notes/reference-architecture-analysis.md` §1

---

## Module Layout (after)

```
src/vault/
  mod.rs                # Re-exports (add `derivation`)
  index.rs              # VaultIndex — owns derivers, orchestrates build
  derivation.rs         # NEW: Deriver trait + IndexedPage struct
  derivers/
    mod.rs              # NEW: Re-exports built-in derivers
    canonical_names.rs  # NEW: CanonicalNameDeriver
    links.rs            # NEW: LinkDeriver (body + property ref links)
    tags.rs             # NEW: TagDeriver
  # unchanged:
  canonical.rs
  config.rs
  hooks.rs
  init.rs
  link.rs
  page.rs
  path.rs
  rewriter.rs
```

---

## Task 1: Define the Deriver trait and IndexedPage struct

**Files:**
- Create: `src/vault/derivation.rs`
- Modify: `src/vault/mod.rs` (add `pub mod derivation;`)

**Step 1: Create `derivation.rs` with types**

```rust
use rusqlite::Transaction;

use super::canonical::CanonicalName;
use super::index::IndexError;
use super::link::Link;
use super::page::PageMeta;
use super::path::VaultPath;

/// The parsed, normalized representation of a single page, ready for derivation.
///
/// Produced by the index builder's parse phase and consumed by each [`Deriver`].
/// This struct is the shared contract between the index builder and all derivers.
pub struct IndexedPage {
    /// Vault-relative path to the page.
    pub vault_path: VaultPath,
    /// Parsed frontmatter metadata.
    pub meta: PageMeta,
    /// Markdown body (after frontmatter).
    pub body: String,
    /// blake3 hash of the full file content.
    pub content_hash: String,
    /// Links extracted from the markdown body.
    pub body_links: Vec<Link>,
    /// Links extracted from frontmatter properties (tags, aliases, custom).
    pub prop_links: Vec<Link>,
    /// Canonical name derived from title or filename.
    pub canonical: CanonicalName,
}

/// A composable unit of index derivation.
///
/// Implementors produce derived artifacts (canonical names, links, tags, etc.)
/// from a parsed [`IndexedPage`] and persist them within a SQLite transaction.
///
/// The index builder calls [`Deriver::derive`] once per page per build cycle,
/// after upserting the page row and clearing stale derived data. Derivers MUST
/// be idempotent: the builder deletes old derived rows before calling derivers,
/// so each call produces the complete set of derived rows for that page.
pub trait Deriver: Send + Sync {
    /// Human-readable name for logging and diagnostics.
    fn name(&self) -> &str;

    /// Derive artifacts for a single page and persist them in the transaction.
    ///
    /// `page_id` is the stringified UUID of the page (already inserted into
    /// the `pages` table). The deriver should INSERT rows into its target
    /// table(s) within `tx`.
    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError>;
}
```

**Step 2: Add module declaration to `mod.rs`**

In `src/vault/mod.rs`, add after the existing module declarations:

```rust
pub mod derivation;
```

**Step 3: Run `cargo check`**

Run: `cargo check 2>&1 | head -30`
Expected: Compiles with no errors (new module has no consumers yet).

**Step 4: Commit**

```bash
git add src/vault/derivation.rs src/vault/mod.rs
git commit -m "feat(vault): add Deriver trait and IndexedPage struct"
```

---

## Task 2: Implement CanonicalNameDeriver

**Files:**
- Create: `src/vault/derivers/mod.rs`
- Create: `src/vault/derivers/canonical_names.rs`
- Modify: `src/vault/mod.rs` (add `pub mod derivers;`)

**Step 1: Create `derivers/mod.rs`**

```rust
pub mod canonical_names;
```

**Step 2: Create `derivers/canonical_names.rs`**

```rust
use rusqlite::{Transaction, params};

use crate::vault::canonical::CanonicalName;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives canonical name entries (title, filename, aliases) for a page.
pub struct CanonicalNameDeriver;

impl Deriver for CanonicalNameDeriver {
    fn name(&self) -> &str {
        "canonical_names"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        // 1. Title-derived canonical name
        if let Some(ref title) = page.meta.title {
            let cn = CanonicalName::from_title(title);
            tx.execute(
                "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'title')",
                params![cn.as_str(), page_id],
            )?;
        }

        // 2. Filename-derived canonical name
        let fn_cn = CanonicalName::from_filename(filename_component(&page.vault_path));
        tx.execute(
            "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'filename')",
            params![fn_cn.as_str(), page_id],
        )?;

        // 3. Each alias
        for alias in &page.meta.aliases {
            let alias_cn = CanonicalName::from_title(alias);
            tx.execute(
                "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'alias')",
                params![alias_cn.as_str(), page_id],
            )?;
        }

        Ok(())
    }
}

/// Extract the filename component from a VaultPath string.
fn filename_component(vp: &crate::vault::path::VaultPath) -> &str {
    let s = vp.as_str();
    if let Some(pos) = s.rfind('/') {
        &s[pos + 1..]
    } else {
        s
    }
}
```

**Step 3: Add module declaration to `mod.rs`**

In `src/vault/mod.rs`, add:

```rust
pub mod derivers;
```

**Step 4: Run `cargo check`**

Run: `cargo check 2>&1 | head -30`
Expected: Compiles clean. The deriver is defined but not yet called.

**Step 5: Commit**

```bash
git add src/vault/derivers/ src/vault/mod.rs
git commit -m "feat(vault): add CanonicalNameDeriver"
```

---

## Task 3: Implement LinkDeriver

**Files:**
- Create: `src/vault/derivers/links.rs`
- Modify: `src/vault/derivers/mod.rs` (add `pub mod links;`)

**Step 1: Create `derivers/links.rs`**

```rust
use rusqlite::{Transaction, params};

use crate::vault::canonical::CanonicalName;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;
use crate::vault::link::LinkKind;

/// Derives link rows (body links + property ref links) for a page.
pub struct LinkDeriver;

impl Deriver for LinkDeriver {
    fn name(&self) -> &str {
        "links"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        // Body links (non-negative span_start)
        for link in &page.body_links {
            let (kind_str, source_field) = match &link.kind {
                LinkKind::Wiki => ("wiki", None),
                LinkKind::Markdown => ("markdown", None),
                LinkKind::PropertyRef { source_field } => {
                    ("property_ref", Some(source_field.clone()))
                }
            };
            let target_canonical = CanonicalName::new(&link.target_raw);
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, kind, source_field, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    page_id,
                    link.target_raw,
                    target_canonical.as_str(),
                    kind_str,
                    source_field,
                    link.span.start as i64,
                    link.span.end as i64,
                ],
            )?;
        }

        // Property ref links (negative span_start to avoid PK collision)
        for (i, link) in page.prop_links.iter().enumerate() {
            let (kind_str, source_field) = match &link.kind {
                LinkKind::Wiki => ("wiki", None),
                LinkKind::Markdown => ("markdown", None),
                LinkKind::PropertyRef { source_field } => {
                    ("property_ref", Some(source_field.clone()))
                }
            };
            let target_canonical = CanonicalName::new(&link.target_raw);
            let neg_span = -((i as i64) + 1);
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, kind, source_field, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    page_id,
                    link.target_raw,
                    target_canonical.as_str(),
                    kind_str,
                    source_field,
                    neg_span,
                    0i64,
                ],
            )?;
        }

        Ok(())
    }
}
```

**Step 2: Add to `derivers/mod.rs`**

```rust
pub mod canonical_names;
pub mod links;
```

**Step 3: Run `cargo check`**

Run: `cargo check 2>&1 | head -30`
Expected: Compiles clean.

**Step 4: Commit**

```bash
git add src/vault/derivers/links.rs src/vault/derivers/mod.rs
git commit -m "feat(vault): add LinkDeriver"
```

---

## Task 4: Implement TagDeriver

**Files:**
- Create: `src/vault/derivers/tags.rs`
- Modify: `src/vault/derivers/mod.rs` (add `pub mod tags;`)

**Step 1: Create `derivers/tags.rs`**

```rust
use rusqlite::{Transaction, params};

use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives tag rows from a page's frontmatter tags.
pub struct TagDeriver;

impl Deriver for TagDeriver {
    fn name(&self) -> &str {
        "tags"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        for tag in &page.meta.tags {
            tx.execute(
                "INSERT OR IGNORE INTO tags (page_id, tag) VALUES (?1, ?2)",
                params![page_id, tag],
            )?;
        }
        Ok(())
    }
}
```

**Step 2: Add to `derivers/mod.rs`**

```rust
pub mod canonical_names;
pub mod links;
pub mod tags;
```

**Step 3: Run `cargo check`**

Run: `cargo check 2>&1 | head -30`
Expected: Compiles clean.

**Step 4: Commit**

```bash
git add src/vault/derivers/tags.rs src/vault/derivers/mod.rs
git commit -m "feat(vault): add TagDeriver"
```

---

## Task 5: Refactor VaultIndex to own derivers

This is the core refactoring task. We modify `VaultIndex` to hold a `Vec<Box<dyn Deriver>>`, expose `make_indexed_page()` as a public representation, and delegate per-page persistence to the derivers.

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `src/vault/derivation.rs` (make `IndexedPage` fields `pub` — already done)

**Step 1: Write the failing test**

Add a new test in `tests/index_test.rs` that verifies the refactored index produces identical results:

```rust
#[test]
fn build_with_derivers_produces_same_results() {
    // This test verifies the derivation pipeline produces the same
    // output as the original monolithic build. It uses the same fixture
    // as build_index_from_test_vault but checks via the public API.
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000001
title: Hello
tags:
  - greeting
aliases:
  - hi
---
See [[World]] for details.
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000002
title: World
tags:
  - place
---
Back to [[Hello]].
"#;

    let (_tmp, vault) = setup_vault(&[("hello.md", page_a), ("world.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let stats = index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    assert_eq!(stats.pages_indexed, 2);

    // Canonical names: title("hello") + filename("hello") dedup + alias("hi") = 2 for page A
    //                  title("world") + filename("world") dedup = 1 for page B
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert!(cn_count >= 3, "expected at least 3 canonical_names, got {cn_count}");

    // Body links: 2 wiki links
    let link_count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE kind = 'wiki' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_count, 2);

    // Property ref links: tags + aliases produce property_ref links
    let prop_count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE kind = 'property_ref'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Page A: tags=["greeting"], aliases=["hi"] → 2 prop refs
    // Page B: tags=["place"] → 1 prop ref
    assert_eq!(prop_count, 3, "expected 3 property ref links");

    // Tags: 2 tags total
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 2);

    // Link resolution: [[World]] from page A should resolve to page B
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000001' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(target_id.as_deref(), Some("00000000-0000-0000-0000-000000000002"));
}
```

**Step 2: Run the test to verify it passes with the CURRENT monolithic build**

Run: `cargo test build_with_derivers_produces_same_results -- --nocapture 2>&1 | tail -10`
Expected: PASS (this is a characterization test for the existing behavior we must preserve).

**Step 3: Refactor `VaultIndex` struct to hold derivers**

Replace the `VaultIndex` struct and modify `open()`:

In `src/vault/index.rs`, change the struct and `open` method:

```rust
use super::derivation::{Deriver, IndexedPage};
use super::derivers::canonical_names::CanonicalNameDeriver;
use super::derivers::links::LinkDeriver;
use super::derivers::tags::TagDeriver;

pub struct VaultIndex {
    conn: Connection,
    derivers: Vec<Box<dyn Deriver>>,
}

impl VaultIndex {
    pub fn open(db_path: &Path) -> Result<Self, IndexError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;

        Ok(Self {
            conn,
            derivers: vec![
                Box::new(CanonicalNameDeriver),
                Box::new(LinkDeriver),
                Box::new(TagDeriver),
            ],
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Register an additional deriver to run during index builds.
    pub fn register_deriver(&mut self, deriver: Box<dyn Deriver>) {
        self.derivers.push(deriver);
    }
```

**Step 4: Refactor `build()` pass 2 to dispatch to derivers**

Replace the pass 2 loop body (the per-page section after `for pf in &parsed_files`). The parse phase (pass 1) and UUID conflict detection stay unchanged. Only pass 2 changes:

The `ParsedFile` struct at the top of `index.rs` is removed. Instead, collect `Vec<IndexedPage>` in pass 1. Update the `build()` method:

1. Change `parsed_files: Vec<ParsedFile>` → `parsed_files: Vec<IndexedPage>` (the struct fields are identical; `IndexedPage` drops the `abs_path` field which is only needed for UUID conflict resolution). Keep `abs_path` as a separate parallel `Vec<PathBuf>` or add it temporarily to `IndexedPage` as a non-pub helper.

   Actually, to minimize churn, add `abs_path: PathBuf` as a `pub(crate)` field on `IndexedPage` — it's needed during UUID conflict resolution but not by derivers.

   In `src/vault/derivation.rs`, add:
   ```rust
   use std::path::PathBuf;

   pub struct IndexedPage {
       // ... existing fields ...
       /// Absolute filesystem path. Used during UUID conflict resolution; not
       /// consumed by derivers.
       pub(crate) abs_path: PathBuf,
   }
   ```

2. Replace the old pass 2 per-page loop body with:

```rust
// -----------------------------------------------------------------
// Pass 2: Upsert all parsed files into the database
// -----------------------------------------------------------------

for pf in &parsed_files {
    let meta_json = serde_json::to_string(&pf.meta).unwrap_or_else(|_| "{}".to_string());
    let page_id = pf.meta.id.to_string();
    let created_at = pf.meta.created_at.map(|dt| dt.to_rfc3339());
    let updated_at = pf.meta.updated_at.map(|dt| dt.to_rfc3339());

    // Upsert into pages table
    tx.execute(
        "INSERT INTO pages (id, path, title, canonical_name, created_at, updated_at, meta_json, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           title = excluded.title,
           canonical_name = excluded.canonical_name,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           meta_json = excluded.meta_json,
           content_hash = excluded.content_hash",
        params![
            page_id,
            pf.vault_path.as_str(),
            pf.meta.title,
            pf.canonical.as_str(),
            created_at,
            updated_at,
            meta_json,
            pf.content_hash,
        ],
    )?;

    // Clear old derived data for this page
    tx.execute("DELETE FROM links WHERE source_id = ?1", params![page_id])?;
    tx.execute("DELETE FROM tags WHERE page_id = ?1", params![page_id])?;
    tx.execute("DELETE FROM canonical_names WHERE page_id = ?1", params![page_id])?;

    // Dispatch to derivers
    for deriver in &self.derivers {
        deriver.derive(pf, &page_id, &tx)?;
    }

    stats.pages_indexed += 1;
}
```

3. Remove the old inline canonical_names/links/tags INSERT blocks (lines 379–462 in the original).

4. Remove the private `ParsedFile` struct (lines 47–56) — replaced by `IndexedPage`.

**Step 5: Run the full test suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL tests pass, including `build_with_derivers_produces_same_results` and all existing `index_test.rs` tests.

**Step 6: Commit**

```bash
git add src/vault/index.rs src/vault/derivation.rs tests/index_test.rs
git commit -m "refactor(vault): dispatch index derivation to composable Deriver trait

Extract canonical_names, links, and tags persistence from the monolithic
VaultIndex::build() into CanonicalNameDeriver, LinkDeriver, and TagDeriver.
The index builder now iterates over registered derivers per page.
ParsedFile replaced by public IndexedPage struct."
```

---

## Task 6: Clean up — remove the VaultPathExt trait from index.rs

The `VaultPathExt` trait and its `filename_component()` method at the bottom of `index.rs` (lines 562–576) is now only used by `CanonicalNameDeriver`, which has its own copy. Remove the dead code from `index.rs`.

**Files:**
- Modify: `src/vault/index.rs` (remove `VaultPathExt` trait and impl, lines 562–576)

**Step 1: Remove the trait**

Delete the `VaultPathExt` trait, its `impl for VaultPath`, and the `use super::path::VaultPath;` import if it's no longer needed in `index.rs` (check: `VaultPath` is still used in `IndexedPage` via `derivation.rs`, and may still be referenced in `build()` for constructing `IndexedPage`).

Actually, `VaultPath` is still needed in `build()` for constructing `IndexedPage` instances. Only remove the `VaultPathExt` trait and impl block.

**Step 2: Run `cargo test`**

Run: `cargo test 2>&1 | tail -20`
Expected: All tests pass (the trait was only used in the old inline derivation code).

**Step 3: Commit**

```bash
git add src/vault/index.rs
git commit -m "chore(vault): remove dead VaultPathExt trait from index.rs"
```

---

## Task 7: Add a test for custom deriver registration

This validates the extension point: external code can register a custom `Deriver` and it runs during `build()`.

**Files:**
- Modify: `tests/index_test.rs`

**Step 1: Write the test**

```rust
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use clepsydra::vault::derivation::{Deriver, IndexedPage};
use clepsydra::vault::index::IndexError;
use rusqlite::Transaction;

/// A no-op deriver that counts how many times it's called.
struct CountingDeriver {
    count: Arc<AtomicUsize>,
}

impl Deriver for CountingDeriver {
    fn name(&self) -> &str {
        "counting"
    }

    fn derive(
        &self,
        _page: &IndexedPage,
        _page_id: &str,
        _tx: &Transaction,
    ) -> Result<(), IndexError> {
        self.count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[test]
fn custom_deriver_is_called_during_build() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000099
title: Test
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("test.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let call_count = Arc::new(AtomicUsize::new(0));
    index.register_deriver(Box::new(CountingDeriver {
        count: Arc::clone(&call_count),
    }));

    index.build(&vault).unwrap();

    assert_eq!(call_count.load(Ordering::Relaxed), 1, "custom deriver should be called once per page");
}
```

**Step 2: Run the test**

Run: `cargo test custom_deriver_is_called_during_build -- --nocapture 2>&1 | tail -10`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/index_test.rs
git commit -m "test(vault): verify custom deriver registration and invocation"
```

---

## Task 8: Add a convenience constructor for default derivers

The current `open()` hardcodes the three built-in derivers. Add a `open_bare()` constructor that creates an index with NO derivers (useful for testing and for callers who want full control). Keep `open()` as the batteries-included default.

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `tests/index_test.rs` (add test)

**Step 1: Write the failing test**

```rust
#[test]
fn open_bare_has_no_derivers() {
    let page = r#"---
id: 00000000-0000-0000-0000-0000000000aa
title: Bare
tags:
  - test
---
See [[Other]].
"#;

    let (_tmp, vault) = setup_vault(&[("bare.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open_bare(&db_path).unwrap();

    let stats = index.build(&vault).unwrap();
    assert_eq!(stats.pages_indexed, 1);

    // Pages table should have the row (upsert is in build(), not in derivers)
    let page_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(page_count, 1);

    // But derived tables should be empty (no derivers registered)
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert_eq!(cn_count, 0, "bare index should have no canonical_names");

    let link_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0))
        .unwrap();
    assert_eq!(link_count, 0, "bare index should have no links");

    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 0, "bare index should have no tags");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test open_bare_has_no_derivers 2>&1 | tail -10`
Expected: FAIL — `open_bare` method doesn't exist yet.

**Step 3: Implement `open_bare()`**

In `src/vault/index.rs`, add after `open()`:

```rust
    /// Open the index database with NO derivers registered.
    ///
    /// Useful for testing or for callers who want to register a custom set
    /// of derivers via [`register_deriver`].
    pub fn open_bare(db_path: &Path) -> Result<Self, IndexError> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;

        Ok(Self {
            conn,
            derivers: Vec::new(),
        })
    }
```

**Step 4: Run test to verify it passes**

Run: `cargo test open_bare_has_no_derivers -- --nocapture 2>&1 | tail -10`
Expected: PASS

**Step 5: Run full test suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL tests pass.

**Step 6: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add VaultIndex::open_bare() for deriver-free index"
```

---

## Task 9: Verify API layer still works end-to-end

The API layer (`src/api/`) calls `index.build()` and `index.resolve_links()` — verify it still compiles and the integration tests pass.

**Step 1: Run `cargo build`**

Run: `cargo build 2>&1 | tail -10`
Expected: Compiles clean.

**Step 2: Run the full test suite including API tests**

Run: `cargo test 2>&1 | tail -30`
Expected: ALL tests pass, including `api_test.rs` and `e2e_test.rs`.

**Step 3: Run clippy**

Run: `cargo clippy 2>&1 | tail -20`
Expected: No warnings from vault or derivers modules.

**Step 4: Commit (if clippy required fixes)**

```bash
git add -A
git commit -m "chore: fix clippy warnings from derivation refactor"
```

(Skip this commit if clippy is clean.)

---

## Summary

| Task | What | Files | ~Size |
|------|------|-------|-------|
| 1 | `Deriver` trait + `IndexedPage` struct | `derivation.rs`, `mod.rs` | 50 LOC |
| 2 | `CanonicalNameDeriver` | `derivers/canonical_names.rs` | 45 LOC |
| 3 | `LinkDeriver` | `derivers/links.rs` | 60 LOC |
| 4 | `TagDeriver` | `derivers/tags.rs` | 25 LOC |
| 5 | Refactor `VaultIndex` to dispatch to derivers | `index.rs`, `derivation.rs`, test | Net -30 LOC (extraction) |
| 6 | Remove dead `VaultPathExt` | `index.rs` | -15 LOC |
| 7 | Test custom deriver registration | `index_test.rs` | 35 LOC |
| 8 | `open_bare()` constructor | `index.rs`, test | 25 LOC |
| 9 | Verify API + clippy clean | (no new files) | 0 LOC |

**Total:** ~195 new LOC, ~45 removed. Net delta: ~150 LOC of new modular code replacing ~80 LOC of inlined logic, plus ~70 LOC of new tests.

**Key invariant preserved:** All existing tests pass unchanged. The refactoring is behavior-preserving — the derivers produce byte-identical SQLite output to the old inline code.
