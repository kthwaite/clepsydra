# Incremental Sync Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a file-watching sync engine that detects vault changes on disk, incrementally re-indexes only affected pages, and propagates dependency updates (re-resolving links from pages that reference renamed/deleted pages) — without requiring full vault rebuilds.

**Architecture:** A new `sync` module wraps `notify` filesystem events into a debounced, channel-based stream. A `SyncEngine` owns the `VaultIndex` and `Vault`, receives change events, classifies them (create/modify/delete/rename), and dispatches minimal re-index operations. Content-hash gating (already in `build()`) prevents wasted work. A reverse-dependency map (pages that *link to* a changed page) enables targeted re-resolution without full re-parse. The sync engine runs as a `tokio::task` in the server, replacing the current one-shot `build()` at startup.

**Tech Stack:** `notify 8` (filesystem watcher), `notify-debouncer-mini` (event debouncing), existing `VaultIndex`/`Vault`/`Deriver` infrastructure, tokio channels

**Spec:** `docs/design-notes/reference-architecture-analysis.md` §2

---

## Design Decisions

### What changes vs. what stays

The current `VaultIndex::build()` already has content-hash gating (lines 229–239 of `index.rs`) that skips unchanged files. This plan does **not** replace `build()` — instead it adds a thin event-driven layer that calls into granular index operations extracted from `build()`.

### Scope boundaries

- **In scope:** File watcher, debounced event stream, single-page index/re-index/delete, reverse-dependency re-resolution, startup full build, tokio integration
- **Out of scope:** CRDT sync, multi-device sync, WebSocket push to frontend, file conflict resolution. These belong in later phases.

### Key invariant

After any sync cycle, the index state must be identical to what a full `build()` + `resolve_links()` would produce. Tests verify this by comparing incremental vs. full-rebuild outcomes.

---

## Module Layout (after)

```
src/vault/
  sync.rs               # NEW: SyncEngine, ChangeEvent, SyncStats
  sync/
    watcher.rs          # NEW: VaultWatcher — wraps notify + debouncer
  index.rs              # MODIFIED: extract index_page(), remove_page() from build()
  mod.rs                # MODIFIED: add pub mod sync;
```

---

## Task 1: Extract `index_page()` and `remove_page()` from `VaultIndex::build()`

The current `build()` does everything: walk, parse, detect UUID conflicts, upsert, derive, prune. We need granular operations that the sync engine can call for individual pages.

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `tests/index_test.rs`

**Step 1: Write the failing test for `index_page()`**

```rust
#[test]
fn index_page_indexes_single_file() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000010
title: Single
tags:
  - solo
---
A [[Missing]] link.
"#;

    let (_tmp, vault) = setup_vault(&[("single.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let vp = clepsydra::vault::path::VaultPath::new("single.md").unwrap();
    let result = index.index_page(&vault, &vp).unwrap();

    assert!(result, "index_page should return true for a new page");

    // Verify page is in DB
    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages WHERE path = 'single.md'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);

    // Verify derivers ran (tags present)
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 1);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test index_page_indexes_single_file 2>&1 | tail -5`
Expected: FAIL — `index_page` method does not exist.

**Step 3: Write the failing test for `remove_page()`**

```rust
#[test]
fn remove_page_deletes_from_index() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000011
title: ToRemove
tags:
  - ephemeral
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("to_remove.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // First build to get page in index
    index.build(&vault).unwrap();

    let vp = clepsydra::vault::path::VaultPath::new("to_remove.md").unwrap();
    let removed = index.remove_page(&vp).unwrap();
    assert!(removed, "remove_page should return true when page existed");

    // Verify page is gone
    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    // Verify derived data is gone (ON DELETE CASCADE)
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 0);
}
```

**Step 4: Run tests to verify they fail**

Run: `cargo test remove_page_deletes 2>&1 | tail -5`
Expected: FAIL — `remove_page` method does not exist.

**Step 5: Implement `index_page()` and `remove_page()`**

In `src/vault/index.rs`, add these methods to `VaultIndex`:

```rust
/// Index (or re-index) a single page from the vault.
///
/// Reads the file at `vault_path`, parses frontmatter, extracts links,
/// and upserts into the database. Returns `true` if the page was indexed,
/// `false` if skipped (content unchanged).
///
/// This does NOT resolve links — call [`resolve_links`] or
/// [`resolve_links_for_page`] after indexing.
pub fn index_page(
    &mut self,
    vault: &Vault,
    vault_path: &VaultPath,
) -> Result<bool, IndexError> {
    let abs_path = vault.resolve(vault_path);
    let linkable_properties = &vault.config().vault.linkable_properties;

    let content = std::fs::read_to_string(&abs_path)
        .map_err(IndexError::Io)?;
    let content_hash = blake3::hash(content.as_bytes()).to_hex().to_string();

    // Check if hash matches DB -> skip if unchanged
    let existing_hash: Option<String> = self.conn
        .query_row(
            "SELECT content_hash FROM pages WHERE path = ?1",
            params![vault_path.as_str()],
            |row| row.get(0),
        )
        .ok();

    if existing_hash.as_deref() == Some(&content_hash) {
        return Ok(false);
    }

    let (meta, body) = parse_frontmatter(&content)
        .map_err(|e| IndexError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())))?;

    let canonical = if let Some(ref title) = meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    let body_links = extract_links(&body);

    let mut prop_links = Vec::new();
    for prop in linkable_properties {
        let values: Vec<String> = match prop.as_str() {
            "tags" => meta.tags.clone(),
            "aliases" => meta.aliases.clone(),
            _ => {
                if let Some(val) = meta.extra.get(prop) {
                    yaml_value_to_strings(val)
                } else {
                    Vec::new()
                }
            }
        };
        if !values.is_empty() {
            prop_links.extend(extract_property_refs(prop, &values));
        }
    }

    let page = IndexedPage {
        vault_path: vault_path.clone(),
        abs_path: abs_path.clone(),
        meta,
        body,
        content_hash,
        body_links,
        prop_links,
        canonical,
    };

    let tx = self.conn.transaction()?;
    let page_id = page.meta.id.to_string();
    let meta_json = serde_json::to_string(&page.meta).unwrap_or_else(|_| "{}".to_string());
    let created_at = page.meta.created_at.map(|dt| dt.to_rfc3339());
    let updated_at = page.meta.updated_at.map(|dt| dt.to_rfc3339());

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
            page.vault_path.as_str(),
            page.meta.title,
            page.canonical.as_str(),
            created_at,
            updated_at,
            meta_json,
            page.content_hash,
        ],
    )?;

    // Clear old derived data
    tx.execute("DELETE FROM links WHERE source_id = ?1", params![page_id])?;
    tx.execute("DELETE FROM tags WHERE page_id = ?1", params![page_id])?;
    tx.execute("DELETE FROM canonical_names WHERE page_id = ?1", params![page_id])?;

    for deriver in &self.derivers {
        deriver.derive(&page, &page_id, &tx)?;
    }

    tx.commit()?;
    Ok(true)
}

/// Remove a page from the index by its vault path.
///
/// Returns `true` if a page was found and removed, `false` if no page
/// existed at that path. Derived data (links, tags, canonical_names) is
/// removed via ON DELETE CASCADE.
pub fn remove_page(&mut self, vault_path: &VaultPath) -> Result<bool, IndexError> {
    let changes = self.conn.execute(
        "DELETE FROM pages WHERE path = ?1",
        params![vault_path.as_str()],
    )?;
    Ok(changes > 0)
}
```

**Step 6: Add `Clone` derive to `VaultPath` if not already present**

Check `src/vault/path.rs` — `VaultPath` needs `Clone` for the `index_page` method to construct `IndexedPage`.

**Step 7: Run tests to verify they pass**

Run: `cargo test index_page_indexes_single_file remove_page_deletes 2>&1 | tail -10`
Expected: PASS

**Step 8: Write a test verifying index_page skips unchanged content**

```rust
#[test]
fn index_page_skips_unchanged() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000012
title: Unchanged
---
Same content.
"#;

    let (_tmp, vault) = setup_vault(&[("unchanged.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let vp = clepsydra::vault::path::VaultPath::new("unchanged.md").unwrap();

    let first = index.index_page(&vault, &vp).unwrap();
    assert!(first, "first index should return true");

    let second = index.index_page(&vault, &vp).unwrap();
    assert!(!second, "second index of unchanged file should return false");
}
```

**Step 9: Run full test suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL tests pass.

**Step 10: Commit**

```bash
git add src/vault/index.rs src/vault/path.rs tests/index_test.rs
git commit -m "feat(vault): extract index_page() and remove_page() from VaultIndex

Granular single-page index and remove operations, extracted from the
bulk build() method. Content-hash gating skips unchanged pages.
Derived data cascades on delete."
```

---

## Task 2: Add `resolve_links_for_page()` — targeted link resolution

Currently `resolve_links()` scans ALL unresolved links. For incremental sync we need targeted resolution: resolve only links from/to a specific page.

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `tests/index_test.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn resolve_links_for_page_resolves_only_affected() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000020
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000021
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    // Don't resolve globally — use targeted resolution

    let vp = clepsydra::vault::path::VaultPath::new("alpha.md").unwrap();
    let resolved = index.resolve_links_for_page(&vp).unwrap();
    assert_eq!(resolved, 1, "expected 1 link resolved");

    // Verify the link is resolved
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000020' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(target_id.as_deref(), Some("00000000-0000-0000-0000-000000000021"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test resolve_links_for_page_resolves 2>&1 | tail -5`
Expected: FAIL — method does not exist.

**Step 3: Implement `resolve_links_for_page()`**

In `src/vault/index.rs`:

```rust
/// Resolve unresolved links originating from or targeting a specific page.
///
/// This resolves:
/// 1. Outgoing links from the page (links where source_id = page's id)
/// 2. Incoming links to the page (links targeting the page's canonical names)
///
/// Returns the number of links resolved.
pub fn resolve_links_for_page(&mut self, vault_path: &VaultPath) -> Result<usize, IndexError> {
    let tx = self.conn.transaction()?;
    let mut resolved_count = 0;

    // Look up page_id
    let page_id: Option<String> = tx
        .query_row(
            "SELECT id FROM pages WHERE path = ?1",
            params![vault_path.as_str()],
            |row| row.get(0),
        )
        .ok();

    let page_id = match page_id {
        Some(id) => id,
        None => {
            tx.commit()?;
            return Ok(0);
        }
    };

    // 1. Resolve outgoing links from this page
    let mut stmt = tx.prepare(
        "SELECT source_id, span_start, target_canonical
         FROM links
         WHERE source_id = ?1 AND target_id IS NULL AND target_canonical IS NOT NULL",
    )?;

    let outgoing: Vec<(String, i64, String)> = stmt
        .query_map(params![page_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for (source_id, span_start, target_canonical) in &outgoing {
        let mut lookup = tx.prepare(
            "SELECT cn.page_id, p.path
             FROM canonical_names cn
             JOIN pages p ON p.id = cn.page_id
             WHERE cn.canonical_name = ?1",
        )?;
        let matches: Vec<(String, String)> = lookup
            .query_map(params![target_canonical], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(lookup);

        if matches.len() == 1 {
            let (target_id, target_path) = &matches[0];
            tx.execute(
                "UPDATE links SET target_id = ?1, target_path = ?2
                 WHERE source_id = ?3 AND span_start = ?4",
                params![target_id, target_path, source_id, span_start],
            )?;
            resolved_count += 1;
        }
    }

    // 2. Resolve incoming links targeting this page's canonical names
    let mut cn_stmt = tx.prepare(
        "SELECT canonical_name FROM canonical_names WHERE page_id = ?1",
    )?;
    let canonical_names: Vec<String> = cn_stmt
        .query_map(params![page_id], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(cn_stmt);

    for cn in &canonical_names {
        let mut stmt = tx.prepare(
            "SELECT source_id, span_start FROM links
             WHERE target_canonical = ?1 AND target_id IS NULL",
        )?;
        let unresolved: Vec<(String, i64)> = stmt
            .query_map(params![cn], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        for (source_id, span_start) in &unresolved {
            // This page is the unique match (we only search its canonical names)
            // But we must verify no other page also claims this canonical name
            let mut count_stmt = tx.prepare(
                "SELECT COUNT(*) FROM canonical_names WHERE canonical_name = ?1",
            )?;
            let match_count: i64 = count_stmt
                .query_row(params![cn], |row| row.get(0))?;
            drop(count_stmt);

            if match_count == 1 {
                let path: String = tx.query_row(
                    "SELECT path FROM pages WHERE id = ?1",
                    params![page_id],
                    |row| row.get(0),
                )?;
                tx.execute(
                    "UPDATE links SET target_id = ?1, target_path = ?2
                     WHERE source_id = ?3 AND span_start = ?4",
                    params![page_id, path, source_id, span_start],
                )?;
                resolved_count += 1;
            }
        }
    }

    tx.commit()?;
    Ok(resolved_count)
}
```

**Step 4: Run tests**

Run: `cargo test resolve_links_for_page 2>&1 | tail -10`
Expected: PASS

**Step 5: Run full test suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL tests pass.

**Step 6: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add resolve_links_for_page() for targeted link resolution

Resolves both outgoing links from a page and incoming links targeting
the page's canonical names. Preserves the ambiguity policy (only 1
match resolves)."
```

---

## Task 3: Add `reverse_deps()` — find pages linking to a given page

When a page changes (especially rename/delete), we need to know which other pages reference it so we can re-resolve their links.

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `tests/index_test.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn reverse_deps_returns_pages_linking_to_target() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000030
title: Hub
---
Links to [[Spoke One]] and [[Spoke Two]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000031
title: Spoke One
---
Back to [[Hub]].
"#;
    let page_c = r#"---
id: 00000000-0000-0000-0000-000000000032
title: Spoke Two
---
Standalone.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("hub.md", page_a),
        ("spoke-one.md", page_b),
        ("spoke-two.md", page_c),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let vp = clepsydra::vault::path::VaultPath::new("hub.md").unwrap();
    let deps = index.reverse_deps(&vp).unwrap();

    // spoke-one links to hub
    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0].as_str(), "spoke-one.md");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test reverse_deps_returns 2>&1 | tail -5`
Expected: FAIL

**Step 3: Implement `reverse_deps()`**

```rust
/// Find all pages that link to the given page (by resolved target_id or
/// target_canonical matching the page's canonical names).
///
/// Returns vault paths of the source pages (deduplicated).
pub fn reverse_deps(&self, vault_path: &VaultPath) -> Result<Vec<VaultPath>, IndexError> {
    let page_id: Option<String> = self.conn
        .query_row(
            "SELECT id FROM pages WHERE path = ?1",
            params![vault_path.as_str()],
            |row| row.get(0),
        )
        .ok();

    let mut source_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Some(ref page_id) = page_id {
        // Pages that resolved to this page
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT p.path FROM links l
             JOIN pages p ON l.source_id = p.id
             WHERE l.target_id = ?1",
        )?;
        let paths: Vec<String> = stmt
            .query_map(params![page_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        source_paths.extend(paths);

        // Pages with unresolved links matching this page's canonical names
        let mut cn_stmt = self.conn.prepare(
            "SELECT canonical_name FROM canonical_names WHERE page_id = ?1",
        )?;
        let cns: Vec<String> = cn_stmt
            .query_map(params![page_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        drop(cn_stmt);

        for cn in &cns {
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT p.path FROM links l
                 JOIN pages p ON l.source_id = p.id
                 WHERE l.target_canonical = ?1 AND l.target_id IS NULL",
            )?;
            let paths: Vec<String> = stmt
                .query_map(params![cn], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            source_paths.extend(paths);
        }
    }

    // Remove self
    source_paths.remove(vault_path.as_str());

    let mut result: Vec<VaultPath> = source_paths
        .into_iter()
        .filter_map(|p| VaultPath::new(&p).ok())
        .collect();
    result.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    Ok(result)
}
```

**Step 4: Run tests**

Run: `cargo test reverse_deps_returns 2>&1 | tail -10`
Expected: PASS

**Step 5: Run full suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL pass.

**Step 6: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add reverse_deps() for dependency-aware sync

Returns vault paths of all pages that link to a given page, enabling
targeted re-resolution when a page is modified, renamed, or deleted."
```

---

## Task 4: Add `invalidate_links_to()` — clear stale resolved links

When a page is renamed or deleted, links from other pages that previously resolved to it are now stale. This method nulls out their `target_id` and `target_path` so they become unresolved again and can be re-resolved against the new state.

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `tests/index_test.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn invalidate_links_to_clears_resolved_links() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000040
title: Source
---
Link to [[Target]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000041
title: Target
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("source.md", page_a), ("target.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Verify link is resolved
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000040' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(target_id.is_some(), "link should be resolved before invalidation");

    // Invalidate
    let vp = clepsydra::vault::path::VaultPath::new("target.md").unwrap();
    let count = index.invalidate_links_to(&vp).unwrap();
    assert_eq!(count, 1, "expected 1 link invalidated");

    // Verify link is now unresolved
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000040' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(target_id.is_none(), "link should be unresolved after invalidation");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test invalidate_links_to_clears 2>&1 | tail -5`
Expected: FAIL

**Step 3: Implement `invalidate_links_to()`**

```rust
/// Null out `target_id` and `target_path` for all links that currently
/// resolve to the given page. This makes them "unresolved" again so they
/// can be re-resolved against updated index state.
///
/// Returns the number of links invalidated.
pub fn invalidate_links_to(&mut self, vault_path: &VaultPath) -> Result<usize, IndexError> {
    let page_id: Option<String> = self.conn
        .query_row(
            "SELECT id FROM pages WHERE path = ?1",
            params![vault_path.as_str()],
            |row| row.get(0),
        )
        .ok();

    let page_id = match page_id {
        Some(id) => id,
        None => return Ok(0),
    };

    let count = self.conn.execute(
        "UPDATE links SET target_id = NULL, target_path = NULL
         WHERE target_id = ?1",
        params![page_id],
    )?;

    Ok(count)
}
```

**Step 4: Run tests**

Run: `cargo test invalidate_links_to_clears 2>&1 | tail -10`
Expected: PASS

**Step 5: Run full suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL pass.

**Step 6: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add invalidate_links_to() for stale link cleanup

Nulls target_id and target_path for all links resolved to a page,
preparing them for re-resolution after rename or delete."
```

---

## Task 5: Add `notify` and `notify-debouncer-mini` dependencies

**Files:**
- Modify: `Cargo.toml`

**Step 1: Add dependencies**

Add to `[dependencies]` in `Cargo.toml`:

```toml
notify = "8"
notify-debouncer-mini = "0.5"
```

**Step 2: Run `cargo check`**

Run: `cargo check 2>&1 | tail -10`
Expected: Compiles (no new code uses them yet).

**Step 3: Commit**

```bash
git add Cargo.toml
git commit -m "chore: add notify and notify-debouncer-mini dependencies"
```

---

## Task 6: Implement `VaultWatcher` — filesystem event stream

The watcher wraps `notify-debouncer-mini` and produces a `tokio::sync::mpsc` stream of `ChangeEvent`s.

**Files:**
- Create: `src/vault/sync/mod.rs`
- Create: `src/vault/sync/watcher.rs`
- Modify: `src/vault/mod.rs` (add `pub mod sync;`)

**Step 1: Create `sync/mod.rs`**

```rust
pub mod watcher;

use super::path::VaultPath;

/// A filesystem change detected by the watcher.
#[derive(Debug, Clone)]
pub enum ChangeEvent {
    /// A file was created or modified.
    Upsert(VaultPath),
    /// A file was removed.
    Remove(VaultPath),
}
```

**Step 2: Create `sync/watcher.rs`**

```rust
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_mini::{
    DebouncedEventKind, new_debouncer,
};
use tokio::sync::mpsc;

use super::ChangeEvent;
use crate::vault::path::VaultPath;

/// Watches a vault directory for filesystem changes and emits [`ChangeEvent`]s.
pub struct VaultWatcher {
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

impl VaultWatcher {
    /// Start watching the vault at `root`.
    ///
    /// Debounces events by `debounce` duration. Sends change events to `tx`.
    /// Only `.md` files are emitted; the `.clepsydra/` directory is excluded.
    pub fn start(
        root: PathBuf,
        debounce: Duration,
        tx: mpsc::UnboundedSender<ChangeEvent>,
    ) -> Result<Self, notify::Error> {
        let root_clone = root.clone();
        let debouncer = new_debouncer(debounce, move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            let events = match result {
                Ok(events) => events,
                Err(e) => {
                    tracing::warn!("watcher error: {e}");
                    return;
                }
            };

            for event in events {
                let path = &event.path;

                // Skip non-.md files
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }

                // Skip .clepsydra/ directory
                if let Ok(rel) = path.strip_prefix(&root_clone) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if rel_str.starts_with(".clepsydra/") {
                        continue;
                    }

                    let vault_path = match VaultPath::new(&rel_str) {
                        Ok(vp) => vp,
                        Err(_) => continue,
                    };

                    let change = match event.kind {
                        DebouncedEventKind::Any => {
                            if path.exists() {
                                ChangeEvent::Upsert(vault_path)
                            } else {
                                ChangeEvent::Remove(vault_path)
                            }
                        }
                        DebouncedEventKind::AnyContinuous => {
                            continue; // skip continuous events, they're noise
                        }
                    };

                    if tx.send(change).is_err() {
                        // Receiver dropped, stop processing
                        return;
                    }
                }
            }
        })?;

        let mut watcher = debouncer;
        watcher.watcher().watch(
            root.as_ref(),
            notify::RecursiveMode::Recursive,
        )?;

        Ok(Self {
            _debouncer: watcher,
        })
    }
}
```

**Step 3: Add module declaration to `mod.rs`**

In `src/vault/mod.rs`, add:

```rust
pub mod sync;
```

**Step 4: Run `cargo check`**

Run: `cargo check 2>&1 | tail -20`
Expected: Compiles (watcher defined but not yet used in server).

**Step 5: Commit**

```bash
git add src/vault/sync/ src/vault/mod.rs
git commit -m "feat(vault): add VaultWatcher — debounced filesystem change stream

Wraps notify-debouncer-mini, filters for .md files, excludes
.clepsydra/, and emits ChangeEvent::Upsert/Remove via tokio mpsc."
```

---

## Task 7: Implement `SyncEngine` — the incremental sync coordinator

The `SyncEngine` consumes `ChangeEvent`s and orchestrates incremental index updates with dependency propagation.

**Files:**
- Modify: `src/vault/sync/mod.rs`

**Step 1: Implement `SyncEngine`**

```rust
use std::sync::Mutex;

use super::Vault;
use super::index::VaultIndex;
use super::path::VaultPath;

pub mod watcher;

/// A filesystem change detected by the watcher.
#[derive(Debug, Clone)]
pub enum ChangeEvent {
    /// A file was created or modified.
    Upsert(VaultPath),
    /// A file was removed.
    Remove(VaultPath),
}

/// Statistics from a single sync cycle.
#[derive(Debug, Default)]
pub struct SyncStats {
    pub pages_indexed: usize,
    pub pages_skipped: usize,
    pub pages_removed: usize,
    pub links_resolved: usize,
    pub deps_reresolved: usize,
}

/// Processes change events and incrementally updates the vault index.
pub struct SyncEngine;

impl SyncEngine {
    /// Process a batch of change events against the index.
    ///
    /// For each event:
    /// - **Upsert**: re-index the page, resolve its links, then re-resolve
    ///   links from pages that depend on it (reverse deps).
    /// - **Remove**: collect reverse deps *before* deletion, remove the page,
    ///   invalidate stale links, then re-resolve affected pages' links.
    pub fn process_events(
        events: &[ChangeEvent],
        vault: &Vault,
        index: &mut VaultIndex,
    ) -> Result<SyncStats, super::index::IndexError> {
        let mut stats = SyncStats::default();

        for event in events {
            match event {
                ChangeEvent::Upsert(vp) => {
                    if vault.is_excluded(vp) {
                        continue;
                    }

                    match index.index_page(vault, vp)? {
                        true => {
                            stats.pages_indexed += 1;

                            // Resolve this page's outgoing + incoming links
                            let resolved = index.resolve_links_for_page(vp)?;
                            stats.links_resolved += resolved;

                            // Re-resolve reverse dependencies
                            let deps = index.reverse_deps(vp)?;
                            for dep_path in &deps {
                                let r = index.resolve_links_for_page(dep_path)?;
                                stats.deps_reresolved += r;
                            }
                        }
                        false => {
                            stats.pages_skipped += 1;
                        }
                    }
                }
                ChangeEvent::Remove(vp) => {
                    // Collect reverse deps BEFORE removing
                    let deps = index.reverse_deps(vp)?;

                    // Invalidate links pointing to this page
                    index.invalidate_links_to(vp)?;

                    // Remove the page
                    if index.remove_page(vp)? {
                        stats.pages_removed += 1;
                    }

                    // Re-resolve affected pages' links
                    for dep_path in &deps {
                        let r = index.resolve_links_for_page(dep_path)?;
                        stats.deps_reresolved += r;
                    }
                }
            }
        }

        Ok(stats)
    }
}
```

**Step 2: Run `cargo check`**

Run: `cargo check 2>&1 | tail -10`
Expected: Compiles.

**Step 3: Commit**

```bash
git add src/vault/sync/mod.rs
git commit -m "feat(vault): add SyncEngine for incremental index updates

Processes ChangeEvent batches: re-indexes modified pages, removes
deleted pages, propagates dependency updates via reverse_deps and
invalidate_links_to."
```

---

## Task 8: Integration test — incremental sync matches full rebuild

This is the critical correctness test: after incremental sync, the index state must be identical to a fresh full rebuild.

**Files:**
- Create: `tests/sync_test.rs`

**Step 1: Write the integration test**

```rust
use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::path::VaultPath;
use clepsydra::vault::sync::{ChangeEvent, SyncEngine};
use rusqlite::params;
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

/// Helper: snapshot the index state as comparable tuples.
fn snapshot_pages(index: &VaultIndex) -> Vec<(String, String, String)> {
    let mut stmt = index
        .connection()
        .prepare("SELECT id, path, content_hash FROM pages ORDER BY path")
        .unwrap();
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

fn snapshot_links(index: &VaultIndex) -> Vec<(String, String, Option<String>, Option<String>)> {
    let mut stmt = index
        .connection()
        .prepare(
            "SELECT source_id, target_raw, target_id, target_path
             FROM links ORDER BY source_id, span_start",
        )
        .unwrap();
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[test]
fn incremental_add_matches_full_rebuild() {
    // Start with page A only
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000050
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000051
title: Beta
---
Back to [[Alpha]].
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // Initial full build with just alpha.md
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Now add beta.md to disk
    fs::write(vault.root().join("beta.md"), page_b).unwrap();

    // Incremental sync
    let events = vec![ChangeEvent::Upsert(VaultPath::new("beta.md").unwrap())];
    let stats = SyncEngine::process_events(&events, &vault, &mut index).unwrap();
    assert_eq!(stats.pages_indexed, 1);

    // Snapshot incremental state
    let inc_pages = snapshot_pages(&index);
    let inc_links = snapshot_links(&index);

    // Now do a full rebuild in a separate index for comparison
    let db_path2 = vault.root().join(".clepsydra/cache_ref.db");
    let mut ref_index = VaultIndex::open(&db_path2).unwrap();
    ref_index.build(&vault).unwrap();
    ref_index.resolve_links().unwrap();

    let ref_pages = snapshot_pages(&ref_index);
    let ref_links = snapshot_links(&ref_index);

    assert_eq!(inc_pages, ref_pages, "pages mismatch after incremental add");
    assert_eq!(inc_links, ref_links, "links mismatch after incremental add");
}

#[test]
fn incremental_modify_matches_full_rebuild() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000052
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000053
title: Beta
---
No links here.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Modify beta.md — change title (affects canonical names and link resolution)
    let page_b_v2 = r#"---
id: 00000000-0000-0000-0000-000000000053
title: Gamma
---
Now I link to [[Alpha]].
"#;
    fs::write(vault.root().join("beta.md"), page_b_v2).unwrap();

    // Incremental sync
    let events = vec![ChangeEvent::Upsert(VaultPath::new("beta.md").unwrap())];
    SyncEngine::process_events(&events, &vault, &mut index).unwrap();

    let inc_pages = snapshot_pages(&index);
    let inc_links = snapshot_links(&index);

    // Full rebuild reference
    let db_path2 = vault.root().join(".clepsydra/cache_ref.db");
    let mut ref_index = VaultIndex::open(&db_path2).unwrap();
    ref_index.build(&vault).unwrap();
    ref_index.resolve_links().unwrap();

    let ref_pages = snapshot_pages(&ref_index);
    let ref_links = snapshot_links(&ref_index);

    assert_eq!(inc_pages, ref_pages, "pages mismatch after modify");
    assert_eq!(inc_links, ref_links, "links mismatch after modify");
}

#[test]
fn incremental_delete_matches_full_rebuild() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000054
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000055
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Delete beta.md from disk
    fs::remove_file(vault.root().join("beta.md")).unwrap();

    // Incremental sync
    let events = vec![ChangeEvent::Remove(VaultPath::new("beta.md").unwrap())];
    let stats = SyncEngine::process_events(&events, &vault, &mut index).unwrap();
    assert_eq!(stats.pages_removed, 1);

    let inc_pages = snapshot_pages(&index);
    let inc_links = snapshot_links(&index);

    // Full rebuild reference
    let db_path2 = vault.root().join(".clepsydra/cache_ref.db");
    let mut ref_index = VaultIndex::open(&db_path2).unwrap();
    ref_index.build(&vault).unwrap();
    ref_index.resolve_links().unwrap();

    let ref_pages = snapshot_pages(&ref_index);
    let ref_links = snapshot_links(&ref_index);

    assert_eq!(inc_pages, ref_pages, "pages mismatch after delete");
    assert_eq!(inc_links, ref_links, "links mismatch after delete");
}
```

**Step 2: Run tests**

Run: `cargo test --test sync_test 2>&1 | tail -20`
Expected: ALL 3 tests pass.

**Step 3: Commit**

```bash
git add tests/sync_test.rs
git commit -m "test(vault): integration tests verifying incremental sync matches full rebuild

Three tests: add, modify, and delete. Each compares incremental sync
output against a fresh full build + resolve_links to ensure identical
index state."
```

---

## Task 9: Wire the sync engine into the server

Replace the one-shot `build()` at startup with a sync loop. The server starts with a full build, then spawns a background task that watches for changes and processes them incrementally.

**Files:**
- Modify: `src/lib.rs`
- Modify: `src/api/mod.rs` (change `Mutex<VaultIndex>` to `Arc<Mutex<VaultIndex>>`)

**Step 1: Update `AppState` to use `Arc<Mutex<VaultIndex>>`**

In `src/api/mod.rs`:

```rust
pub struct AppState {
    pub vault: Vault,
    pub index: Arc<Mutex<VaultIndex>>,
    pub warnings: Mutex<Vec<String>>,
}
```

Add `use std::sync::Arc;` (already imported for Router state).

**Step 2: Update `run_server()` to spawn watcher + sync loop**

In `src/lib.rs`:

```rust
use std::time::Duration;
use vault::sync::{ChangeEvent, SyncEngine};
use vault::sync::watcher::VaultWatcher;

pub async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
    // ... existing setup (logging, settings, vault, index) ...

    let index = Arc::new(Mutex::new(index));

    // Store warnings
    let warnings = Arc::new(Mutex::new(stats.warnings));

    // Build shared state
    let state = Arc::new(AppState {
        vault,
        index: Arc::clone(&index),
        warnings: Mutex::new(warnings.lock().unwrap().clone()),
    });

    // Spawn file watcher + sync loop
    let vault_root = state.vault.root().to_path_buf();
    let sync_vault = state.vault.clone(); // Need Vault: Clone
    let sync_index = Arc::clone(&index);
    let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();

    let _watcher = VaultWatcher::start(
        vault_root,
        Duration::from_millis(500),
        change_tx,
    )?;

    tokio::spawn(async move {
        let mut batch: Vec<ChangeEvent> = Vec::new();
        loop {
            // Drain available events
            match change_rx.recv().await {
                Some(event) => {
                    batch.push(event);
                    // Drain any additional buffered events
                    while let Ok(event) = change_rx.try_recv() {
                        batch.push(event);
                    }
                }
                None => break, // Channel closed
            }

            // Process batch
            let mut idx = sync_index.lock().unwrap();
            match SyncEngine::process_events(&batch, &sync_vault, &mut idx) {
                Ok(stats) => {
                    if stats.pages_indexed > 0 || stats.pages_removed > 0 {
                        tracing::info!(
                            indexed = stats.pages_indexed,
                            skipped = stats.pages_skipped,
                            removed = stats.pages_removed,
                            resolved = stats.links_resolved,
                            deps = stats.deps_reresolved,
                            "sync cycle complete"
                        );
                    }
                }
                Err(e) => {
                    tracing::error!("sync error: {e}");
                }
            }
            batch.clear();
        }
    });

    // ... existing router + server setup ...
}
```

**Step 3: Make `Vault` cloneable**

In `src/vault/mod.rs`, add `Clone` derive or manual impl. `VaultConfig` and `glob::Pattern` both implement `Clone`, so:

```rust
#[derive(Clone)]
pub struct Vault { ... }
```

Actually, `Vault` has `Vec<glob::Pattern>` — check if `glob::Pattern` is `Clone`. If not, we need to `Arc` the vault or restructure. Likely it is `Clone` since it derives common traits.

**Step 4: Run `cargo check`**

Run: `cargo check 2>&1 | tail -20`
Expected: Compiles.

**Step 5: Run full test suite**

Run: `cargo test 2>&1 | tail -20`
Expected: ALL tests pass (the API tests may need minor adjustments if `AppState` field types changed).

**Step 6: Commit**

```bash
git add src/lib.rs src/api/mod.rs src/vault/mod.rs
git commit -m "feat: wire sync engine into server — watch vault for changes

Server now starts with full build, then spawns a background task that
watches for .md file changes and incrementally updates the index.
Debounce interval: 500ms."
```

---

## Task 10: Update API rebuild endpoint and fix tests

The `POST /index/rebuild` endpoint should still work for manual full rebuilds. Update any tests that break from the `AppState` changes.

**Files:**
- Modify: `src/api/index_routes.rs` (if needed)
- Modify: `tests/e2e_test.rs` (if `AppState` changes broke it)
- Modify: `tests/api_test.rs` (if exists and broke)

**Step 1: Verify and fix test compilation**

Run: `cargo test 2>&1 | tail -30`

If `e2e_test.rs` or `api_test.rs` fail to compile due to `AppState` field type changes, update them to match.

**Step 2: Run full test suite + clippy**

Run: `cargo test 2>&1 | tail -20`
Run: `cargo clippy 2>&1 | tail -20`
Expected: All pass, no warnings.

**Step 3: Commit (if fixes needed)**

```bash
git add tests/ src/api/
git commit -m "fix: update tests for AppState changes from sync engine integration"
```

---

## Task 11: Final verification

**Step 1: Run `cargo build`**

Run: `cargo build 2>&1 | tail -10`
Expected: Clean.

**Step 2: Run `cargo test`**

Run: `cargo test 2>&1 | tail -30`
Expected: ALL tests pass.

**Step 3: Run `cargo clippy`**

Run: `cargo clippy 2>&1 | tail -20`
Expected: No warnings.

**Step 4: Commit (if clippy fixes needed)**

```bash
git add -A
git commit -m "chore: fix clippy warnings from sync engine"
```

---

## Summary

| Task | What | Files | ~Size |
|------|------|-------|-------|
| 1 | Extract `index_page()` + `remove_page()` | `index.rs`, test | ~80 LOC |
| 2 | `resolve_links_for_page()` | `index.rs`, test | ~60 LOC |
| 3 | `reverse_deps()` | `index.rs`, test | ~50 LOC |
| 4 | `invalidate_links_to()` | `index.rs`, test | ~20 LOC |
| 5 | Add notify dependencies | `Cargo.toml` | 2 lines |
| 6 | `VaultWatcher` + `ChangeEvent` | `sync/mod.rs`, `sync/watcher.rs` | ~90 LOC |
| 7 | `SyncEngine` | `sync/mod.rs` | ~60 LOC |
| 8 | Integration tests (inc. vs full rebuild) | `sync_test.rs` | ~180 LOC |
| 9 | Wire into server | `lib.rs`, `api/mod.rs`, `vault/mod.rs` | ~40 LOC |
| 10 | Fix tests for AppState changes | tests | ~10 LOC |
| 11 | Final verification | (no new files) | 0 LOC |

**Total:** ~590 new LOC across 11 tasks. ~10 commits on `develop`.

**Key invariant:** After any sync cycle, `snapshot(incremental) == snapshot(full_rebuild)`. Three integration tests (add, modify, delete) enforce this.

**Dependencies between tasks:**
- Tasks 1–4 are independent index primitives (can be batched)
- Task 5 is a standalone dep addition
- Tasks 6–7 depend on Tasks 1–4
- Task 8 depends on Tasks 1–7
- Task 9 depends on Tasks 6–7
- Task 10 depends on Task 9
- Task 11 depends on all
