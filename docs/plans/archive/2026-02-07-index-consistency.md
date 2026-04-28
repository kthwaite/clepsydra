# Index Consistency & API Ergonomics Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate duplicated indexing logic between the API layer and VaultIndex, fix attachment path contract bug, replace full rebuilds with incremental reindex, and extract shared helpers.

**Architecture:** The API layer (`src/api/pages.rs`) currently has its own `upsert_page_in_index` function that duplicates and diverges from `VaultIndex::index_page`. We remove it entirely and route all API writes through the existing `VaultIndex` methods (`index_page`, `resolve_links_for_page`, `remove_page`, `invalidate_links_to`). The `SyncEngine` already demonstrates the correct incremental pattern — the API layer should follow it.

**Tech Stack:** Rust, Axum 0.8, rusqlite, axum_test (integration tests)

---

## Task 1: Unify Indexing — Replace `upsert_page_in_index` with `VaultIndex::index_page`

This is the highest-impact fix. The API's `upsert_page_in_index` (pages.rs:757-875) is a weaker duplicate of `VaultIndex::index_page` (index.rs:546-665):
- Missing: property link extraction, deriver dispatch, transactions, hash-based skip
- Silently swallows link/tag insert errors (`let _ =` at lines 852, 868)
- Uses `vault_path.stem()` for canonical derivation while index uses `vault_path.filename()` (functionally identical for `.md` files, but divergent in intent)

**Files:**
- Modify: `src/api/pages.rs`
- Test: `tests/api_test.rs`

**Step 1: Write failing test — property links indexed via API create**

The current `upsert_page_in_index` only extracts body links, not property links. After the fix, creating a page via the API should produce property_ref links in the index for configured linkable_properties.

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn create_page_indexes_property_links() {
    let (server, tmp) = setup_server();

    // Write a config.toml with linkable_properties
    let config_path = tmp.path().join("vault/config.toml");
    fs::write(
        &config_path,
        "[vault]\nlinkable_properties = [\"tags\"]\n",
    )
    .unwrap();

    // Create a page with tags
    let res = server
        .post("/api/vault/pages/props.md")
        .json(&serde_json::json!({
            "title": "Property Test",
            "tags": ["concept", "rust"],
            "body": "Some body text."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // Rebuild index to pick up config change, then check links
    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status(StatusCode::OK);

    // Query the index to verify property links exist
    // The unresolved endpoint will show property_ref links since "concept" and "rust" won't resolve
    let res = server.get("/api/vault/index/unresolved").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    let links = body.as_array().unwrap();

    let property_links: Vec<&serde_json::Value> = links
        .iter()
        .filter(|l| l["kind"] == "property_ref")
        .collect();
    assert!(
        property_links.len() >= 2,
        "expected at least 2 property_ref links for tags, got {}",
        property_links.len()
    );
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test create_page_indexes_property_links -- --nocapture`

Expected: FAIL — the current `upsert_page_in_index` doesn't extract property links, so 0 property_ref links will be found.

Note: If the test setup doesn't pick up config.toml changes mid-test (because `Vault::open` already ran), we may need to adjust the test to create the config before `setup_server()`. In that case, create a `setup_server_with_config(config: &str)` variant:

```rust
fn setup_server_with_config(config_content: &str) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    // Write custom config before opening vault
    fs::write(root.join("config.toml"), config_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let state = Arc::new(AppState {
        vault,
        index: Arc::new(Mutex::new(index)),
        warnings: Mutex::new(Vec::new()),
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}
```

**Step 3: Write failing test — create_page resolves outgoing links**

```rust
#[tokio::test]
async fn create_page_resolves_links() {
    let (server, _tmp) = setup_server();

    // Create target page first
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({
            "title": "Target Page",
            "body": "I am the target."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Create page that links to target
    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({
            "title": "Source Page",
            "body": "Link to [[Target Page]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Check that the link resolved (backlinks endpoint should show source → target)
    let res = server
        .get("/api/vault/index/backlinks/target.md")
        .await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    let backlinks = body.as_array().unwrap();
    assert_eq!(
        backlinks.len(),
        1,
        "expected 1 backlink to target.md, got {}",
        backlinks.len()
    );
}
```

**Step 4: Run test to verify it fails**

Run: `cargo test create_page_resolves_links -- --nocapture`

Expected: FAIL — current `upsert_page_in_index` doesn't call `resolve_links_for_page`, so backlinks won't show up.

**Step 5: Implement — replace `upsert_page_in_index` calls with `VaultIndex` methods**

In `src/api/pages.rs`, replace the call in `create_page` (line 251):

```rust
// BEFORE (line 251):
upsert_page_in_index(&state, &vault_path, &meta, &page_body, &content)?;

// AFTER:
{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;
    index
        .index_page(&state.vault, &vault_path)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    index
        .resolve_links_for_page(&vault_path)
        .map_err(|e| ApiError::internal(e.to_string()))?;
}
```

Replace the call in `update_page` (line 314):

```rust
// BEFORE (line 314):
upsert_page_in_index(&state, &vault_path, &meta, &page_body, &content)?;

// AFTER:
{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    // Invalidate links pointing to this page before re-indexing,
    // in case canonical names changed.
    index
        .invalidate_links_to(&vault_path)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    index
        .index_page(&state.vault, &vault_path)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    index
        .resolve_links_for_page(&vault_path)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    // Re-resolve reverse deps in case canonical names changed
    let deps = index
        .reverse_deps(&vault_path)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    for dep_path in &deps {
        index
            .resolve_links_for_page(dep_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
}
```

**Step 6: Fix canonical derivation in response builders**

In `get_page` (line 151), `get_page_by_id` (line 201), `create_page` (line 255), `update_page` (line 319), and `move_page` (line 647), change `vault_path.stem()` to `vault_path.filename()`:

```rust
// BEFORE:
CanonicalName::from_filename(vault_path.stem())

// AFTER:
CanonicalName::from_filename(vault_path.filename())
```

This aligns with what `VaultIndex::index_page` does (index.rs:581). For `.md` files, `from_filename` strips the extension internally, so the output is identical — but the code now clearly expresses the same intent.

**Step 7: Delete `upsert_page_in_index` and clean up imports**

Remove:
- The entire `upsert_page_in_index` function (lines 757-875)
- The `use crate::vault::link::extract_links;` import (line 18) — no longer needed in pages.rs

Verify no other references to `upsert_page_in_index` exist in the file.

**Step 8: Fix `list_pages` ordering**

In `list_pages` (line 114), add ORDER BY:

```sql
-- BEFORE:
"SELECT id, path, title, canonical_name FROM pages"

-- AFTER:
"SELECT id, path, title, canonical_name FROM pages ORDER BY path"
```

**Step 9: Run all tests**

Run: `cargo test`

Expected: All tests pass, including the two new ones.

**Step 10: Commit**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "refactor(api): unify indexing through VaultIndex::index_page

Remove duplicated upsert_page_in_index from API layer. Route create/update
through VaultIndex::index_page + resolve_links_for_page, which properly
extracts property links, uses transactions, and dispatches to derivers.

Also fixes: list_pages now returns deterministic ordering, and response
canonical derivation uses filename() consistently with index."
```

---

## Task 2: Fix Attachment Path Contract

The attachment list endpoint returns vault-relative paths (e.g. `_attachments/image.png`), but get/delete endpoints prepend the attachment folder again, producing a double-prefix (`_attachments/_attachments/image.png`).

**Files:**
- Modify: `src/api/attachments.rs`
- Test: `tests/api_test.rs`

**Step 1: Write failing test — list path usable for get**

```rust
#[tokio::test]
async fn attachment_list_path_round_trips_to_get() {
    let (server, tmp) = setup_server();

    // Create an attachment file directly on disk
    let att_dir = tmp.path().join("vault/_attachments");
    fs::create_dir_all(&att_dir).unwrap();
    fs::write(att_dir.join("photo.png"), b"fake png data").unwrap();

    // List attachments
    let res = server.get("/api/vault/attachments").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    let attachments = body.as_array().unwrap();
    assert_eq!(attachments.len(), 1);

    let listed_path = attachments[0]["path"].as_str().unwrap();

    // Use the listed path to GET the attachment
    let get_url = format!("/api/vault/attachments/{listed_path}");
    let res = server.get(&get_url).await;
    res.assert_status(StatusCode::OK);
    assert_eq!(res.as_bytes(), b"fake png data");
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test attachment_list_path_round_trips_to_get -- --nocapture`

Expected: FAIL — GET returns 404 because `_attachments/_attachments/photo.png` doesn't exist.

**Step 3: Fix — strip attachment folder prefix from list output**

In `src/api/attachments.rs`, the `list_attachments` handler (lines 52-76) builds `rel_str` by stripping `vault.root()`. This gives paths like `_attachments/photo.png`. The get/delete handlers prepend `attachment_folder` again.

Fix: strip the attachment folder prefix from the listed path:

```rust
// In list_attachments, after computing rel_str (line 63):
// BEFORE:
let rel_str = rel.to_string_lossy().replace('\\', "/");

// AFTER:
let rel_str = rel.to_string_lossy().replace('\\', "/");
// Strip the attachment folder prefix so paths are relative to it,
// matching what get/delete expect as URL path parameters.
let attachment_folder = &state.vault.config().vault.attachment_folder;
let rel_str = rel_str
    .strip_prefix(attachment_folder)
    .unwrap_or(&rel_str)
    .trim_start_matches('/')
    .to_string();
```

**Step 4: Run all tests**

Run: `cargo test`

Expected: All pass, including the new round-trip test.

**Step 5: Commit**

```bash
git add src/api/attachments.rs tests/api_test.rs
git commit -m "fix(api): attachment list paths now match get/delete contract

List endpoint was returning vault-relative paths (e.g. _attachments/photo.png)
while get/delete prepend the attachment folder, causing double-prefix 404s.
List now returns paths relative to the attachment folder."
```

---

## Task 3: Extract Shared Helpers

`compute_relative_path` is duplicated verbatim in `pages.rs` (line 693) and `folders.rs` (line 439). The backlink query in `find_backlink_pages` (pages.rs:664) is duplicated inline in `move_folder` (folders.rs:323-330).

**Files:**
- Create: `src/api/helpers.rs`
- Modify: `src/api/mod.rs`, `src/api/pages.rs`, `src/api/folders.rs`

**Step 1: Create `src/api/helpers.rs` with shared functions**

```rust
use rusqlite::params;

use crate::vault::canonical::CanonicalName;

use super::error::ApiError;

/// Find all pages that link to a given target path or canonical name.
/// Returns (source_id, path) pairs.
pub fn find_backlink_pages(
    conn: &rusqlite::Connection,
    target_path: &str,
    target_stem: &str,
) -> Result<Vec<(String, String)>, ApiError> {
    let target_canonical = CanonicalName::new(target_stem);

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT l.source_id, p.path
             FROM links l
             JOIN pages p ON p.id = l.source_id
             WHERE l.target_path = ?1 OR l.target_canonical = ?2",
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let pages: Vec<(String, String)> = stmt
        .query_map(params![target_path, target_canonical.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(pages)
}

/// Compute a relative path from `from_path` to `to_path`, where both are
/// vault-relative paths (e.g. `notes/a.md`, `notes/b.md`).
pub fn compute_relative_path(from_path: &str, to_path: &str) -> String {
    // ... move the existing implementation verbatim from pages.rs:693-750
}
```

**Step 2: Register the module**

In `src/api/mod.rs`, add:

```rust
pub mod helpers;
```

**Step 3: Update `pages.rs` to use shared helpers**

- Remove the `find_backlink_pages` function (lines 664-689)
- Remove the `compute_relative_path` function (lines 693-750)
- Replace all call sites with `super::helpers::find_backlink_pages(...)` and `super::helpers::compute_relative_path(...)`
- Remove the `use crate::vault::canonical::CanonicalName;` import **only if** it's no longer used directly in pages.rs (check response builders first — they still use it, so keep the import)

**Step 4: Update `folders.rs` to use shared helpers**

- Remove the `compute_relative_path` function (lines 439-492)
- Replace the inline backlink query in `move_folder` (lines 323-340) with `super::helpers::find_backlink_pages(...)`
- Replace `compute_relative_path(...)` calls with `super::helpers::compute_relative_path(...)`
- Remove the `use crate::vault::canonical::CanonicalName;` import if no longer needed in folders.rs

**Step 5: Run all tests**

Run: `cargo test`

Expected: All pass — pure refactor, no behavior change.

**Step 6: Commit**

```bash
git add src/api/helpers.rs src/api/mod.rs src/api/pages.rs src/api/folders.rs
git commit -m "refactor(api): extract shared helpers for backlink queries and relative paths

Deduplicate compute_relative_path (was in pages.rs and folders.rs) and
find_backlink_pages (was in pages.rs, duplicated inline in folders.rs)
into src/api/helpers.rs."
```

---

## Task 4: Incremental Reindex + Fix Mutation Ordering for Move/Delete

Two intertwined issues:
1. **Mutation ordering:** Move/delete currently apply backlink rewrites *before* the primary fs mutation (rename/delete). If the fs mutation fails after rewrites, backlink pages are corrupted.
2. **Full rebuild:** Move/delete call `index.build()` + `index.resolve_links()` after mutations, which won't scale.

The fix: reorder to do primary fs mutation first, then rewrites, then incremental reindex. Follow the `SyncEngine` pattern.

**Files:**
- Modify: `src/api/pages.rs` (move_page, delete_page)
- Modify: `src/api/folders.rs` (move_folder, delete_folder)
- Test: `tests/api_test.rs`

### 4a: Fix `delete_page` — mutation ordering + incremental reindex

**Step 1: Write test for delete ordering correctness**

The existing `delete_force_plain_text_rewrites` test validates end-state but not ordering. Add a test that verifies atomicity:

```rust
#[tokio::test]
async fn delete_page_no_stale_index_entries() {
    let (server, _tmp) = setup_server();

    // Create target and source
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({
            "title": "Target",
            "body": "I will be deleted."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({
            "title": "Source",
            "body": "Link to [[Target]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Delete target with force + plain_text rewrite
    let res = server
        .delete("/api/vault/pages/target.md?force=true&rewrite=plain_text")
        .await;
    res.assert_status(StatusCode::NO_CONTENT);

    // Verify target is gone from index listing
    let res = server.get("/api/vault/pages").await;
    let pages: Vec<serde_json::Value> = res.json();
    assert!(
        !pages.iter().any(|p| p["path"] == "target.md"),
        "deleted page should not appear in listing"
    );

    // Verify the link in source.md is now unresolved or gone
    // (backlinks to a deleted page should return empty)
    let res = server.get("/api/vault/index/backlinks/target.md").await;
    res.assert_status(StatusCode::OK);
    let backlinks: Vec<serde_json::Value> = res.json();
    assert_eq!(
        backlinks.len(),
        0,
        "no backlinks should exist for deleted page"
    );
}
```

**Step 2: Refactor `delete_page` — reorder mutations and use incremental reindex**

Current flow (pages.rs:330-504):
1. Find backlinks (lines 355-402)
2. Compute and apply rewrites (lines 404-448) ← writes to disk
3. Remove from index manually (lines 452-483)
4. Delete file (lines 485-487) ← primary mutation AFTER rewrites
5. Full rebuild (lines 490-501)

New flow:

```rust
async fn delete_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> Result<Response, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    let old_stem = vault_path.stem().to_string();

    // Read the page to get title (needed for display text in rewrites)
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;
    let display_text = page.meta.title.clone().unwrap_or_else(|| old_stem.clone());

    // Check backlinks and compute rewrites (before any mutation)
    let (backlink_pages, staged_writes) = {
        let index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        // Backlink conflict check (non-force mode)
        let page_id: Option<String> = index
            .connection()
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .ok();

        if !query.force {
            if let Some(ref pid) = page_id {
                let mut stmt = index
                    .connection()
                    .prepare(
                        "SELECT DISTINCT p.path FROM links l
                         JOIN pages p ON p.id = l.source_id
                         WHERE l.target_id = ?1 AND l.source_id != ?1",
                    )
                    .map_err(|e| ApiError::internal(e.to_string()))?;

                let backlinks: Vec<String> = stmt
                    .query_map(params![pid], |row| row.get(0))
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
        }

        let bp = helpers::find_backlink_pages(
            index.connection(),
            vault_path.as_str(),
            &old_stem,
        )?;

        // Compute staged writes while still holding the lock (read-only operations)
        let mut writes: Vec<(PathBuf, String)> = Vec::new();
        if query.force && query.rewrite != "none" && !bp.is_empty() {
            for (_, ref_path_str) in &bp {
                let ref_vp = VaultPath::new(ref_path_str)
                    .map_err(|e| ApiError::internal(format!("invalid ref path: {e}")))?;
                let ref_abs = state.vault.resolve(&ref_vp);

                let content = fs::read_to_string(&ref_abs)
                    .map_err(|e| ApiError::internal(format!("failed to read {ref_path_str}: {e}")))?;

                let sentinel = match query.rewrite.as_str() {
                    "unlink" => format!("{DELETE_UNLINK}{display_text}"),
                    _ => format!("{DELETE_PLAIN}{display_text}"),
                };

                let mut replacements: Vec<(String, String)> = Vec::new();
                replacements.push((old_stem.clone(), sentinel.clone()));
                if display_text != old_stem {
                    replacements.push((display_text.clone(), sentinel.clone()));
                }
                let old_rel = helpers::compute_relative_path(ref_vp.as_str(), vault_path.as_str());
                if old_rel != old_stem {
                    replacements.push((old_rel, sentinel.clone()));
                }

                let replacement_refs: Vec<(&str, &str)> = replacements
                    .iter()
                    .map(|(old, new)| (old.as_str(), new.as_str()))
                    .collect();

                let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
                if new_content != content {
                    writes.push((ref_abs, new_content));
                }
            }
        }

        (bp, writes)
    }; // index lock released

    // PRIMARY MUTATION FIRST: delete the file
    fs::remove_file(&abs_path)
        .map_err(|e| ApiError::internal(format!("failed to delete file: {e}")))?;

    // THEN apply backlink rewrites (safe: if this fails, file is already gone
    // and a rebuild will produce correct state)
    if !staged_writes.is_empty() {
        rewriter::apply_staged_writes(&staged_writes)
            .map_err(|e| ApiError::internal(format!("staged write failed: {e}")))?;
    }

    // INCREMENTAL REINDEX (replaces full rebuild)
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        index
            .invalidate_links_to(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .remove_page(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;

        // Re-index rewritten backlink pages
        for (_, ref_path_str) in &backlink_pages {
            let ref_vp = VaultPath::new(ref_path_str)
                .map_err(|e| ApiError::internal(format!("invalid ref path: {e}")))?;
            index
                .index_page(&state.vault, &ref_vp)
                .map_err(|e| ApiError::internal(e.to_string()))?;
            index
                .resolve_links_for_page(&ref_vp)
                .map_err(|e| ApiError::internal(e.to_string()))?;
        }
    }

    Ok(StatusCode::NO_CONTENT.into_response())
}
```

**Step 3: Run tests**

Run: `cargo test delete`

Expected: All delete-related tests pass (existing + new).

### 4b: Fix `move_page` — mutation ordering + incremental reindex

**Step 4: Write test for move incremental reindex**

```rust
#[tokio::test]
async fn move_page_updates_index_incrementally() {
    let (server, _tmp) = setup_server();

    // Create a page
    server
        .post("/api/vault/pages/original.md")
        .json(&serde_json::json!({
            "title": "Movable",
            "body": "Some content."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Create a page that links to it
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({
            "title": "Linker",
            "body": "See [[Movable]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Move the page
    let res = server
        .post("/api/vault/pages-move/original.md")
        .json(&serde_json::json!({
            "destination": "subfolder/moved.md"
        }))
        .await;
    res.assert_status(StatusCode::OK);

    // Verify old path is gone from index
    let res = server.get("/api/vault/pages").await;
    let pages: Vec<serde_json::Value> = res.json();
    assert!(
        !pages.iter().any(|p| p["path"] == "original.md"),
        "old path should not appear in listing"
    );
    assert!(
        pages.iter().any(|p| p["path"] == "subfolder/moved.md"),
        "new path should appear in listing"
    );

    // Verify backlinks to new location work
    let res = server
        .get("/api/vault/index/backlinks/subfolder/moved.md")
        .await;
    res.assert_status(StatusCode::OK);
    let backlinks: Vec<serde_json::Value> = res.json();
    assert_eq!(
        backlinks.len(),
        1,
        "backlink from linker.md should resolve to new location"
    );
}
```

**Step 5: Refactor `move_page` — reorder mutations and use incremental reindex**

Current flow:
1. Find backlinks (lines 538-546)
2. Compute and apply rewrites (lines 548-614) ← writes to disk
3. Rename file (lines 616-622) ← primary mutation AFTER rewrites
4. Full rebuild (lines 625-638)

New flow:

```rust
// In move_page, after computing staged_writes and before applying:

// 1. PRIMARY MUTATION FIRST: rename the file
if let Some(parent) = dest_abs.parent() {
    fs::create_dir_all(parent)
        .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
}
fs::rename(&source_abs, &dest_abs)
    .map_err(|e| ApiError::internal(format!("failed to rename file: {e}")))?;

// 2. THEN apply backlink rewrites
if !staged_writes.is_empty() {
    rewriter::apply_staged_writes(&staged_writes)
        .map_err(|e| ApiError::internal(format!("staged write failed: {e}")))?;
}

// 3. INCREMENTAL REINDEX (replaces full rebuild)
{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    // Remove old page and invalidate links pointing to it
    index
        .invalidate_links_to(&source_vp)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    index
        .remove_page(&source_vp)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    // Index page at new location
    index
        .index_page(&state.vault, &dest_vp)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    index
        .resolve_links_for_page(&dest_vp)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    // Re-index rewritten backlink pages
    for (_, ref_path_str) in &backlink_pages {
        let ref_vp = VaultPath::new(ref_path_str)
            .map_err(|e| ApiError::internal(format!("invalid ref path: {e}")))?;
        index
            .index_page(&state.vault, &ref_vp)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .resolve_links_for_page(&ref_vp)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
}
```

**Step 6: Run tests**

Run: `cargo test move_page`

Expected: All move-related tests pass (existing + new).

### 4c: Fix `move_folder` — same treatment

**Step 7: Refactor `move_folder` in `src/api/folders.rs`**

Apply the same pattern:
1. Compute all rewrites (reading from old locations)
2. Rename the folder (primary mutation)
3. Apply backlink rewrites
4. Incremental reindex:
   - For each page that was in the folder: `invalidate_links_to` + `remove_page` (old path)
   - For each moved page: `index_page` + `resolve_links_for_page` (new path)
   - For each rewritten backlink page: `index_page` + `resolve_links_for_page`

Replace the inline backlink query (folders.rs:323-330) with `helpers::find_backlink_pages(...)`.

**Step 8: Fix `delete_folder` — add index cleanup**

Currently `delete_folder` (folders.rs:219-250) does no index work at all. After deleting a folder with pages, those pages remain as ghost entries in the index.

Add incremental cleanup:

```rust
// After fs::remove_dir / fs::remove_dir_all, add:
{
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    // Walk the index to find pages that were under this folder
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

    for page_path in &orphaned {
        let vp = VaultPath::new(page_path)
            .map_err(|e| ApiError::internal(format!("invalid path: {e}")))?;
        index
            .invalidate_links_to(&vp)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .remove_page(&vp)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
}
```

**Step 9: Run all tests**

Run: `cargo test`

Expected: All pass.

**Step 10: Commit**

```bash
git add src/api/pages.rs src/api/folders.rs tests/api_test.rs
git commit -m "fix(api): incremental reindex for move/delete, fix mutation ordering

Move/delete now perform the primary filesystem mutation (rename/delete)
before applying backlink rewrites. If rewrites fail after the fs mutation,
a rebuild recovers correct state. Previously, rewrites happened first,
leaving corrupted backlinks if the fs mutation failed.

Full index rebuilds replaced with targeted incremental operations:
invalidate_links_to + remove_page + index_page + resolve_links_for_page.

Also adds index cleanup for folder deletion (previously left ghost entries)."
```

---

## Task 5: Contract Tests

Focused tests for edge cases and contracts that weren't covered by the task-specific tests above.

**Files:**
- Modify: `tests/api_test.rs`

**Step 1: Test update resolves links bidirectionally**

```rust
#[tokio::test]
async fn update_page_resolves_links_bidirectionally() {
    let (server, _tmp) = setup_server();

    // Create source with no links
    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({
            "title": "Source",
            "body": "No links yet."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Create target
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({
            "title": "Target",
            "body": "I am the target."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Update source to add a link to target
    let res = server
        .put("/api/vault/pages/source.md")
        .json(&serde_json::json!({
            "body": "Now linking to [[Target]]."
        }))
        .await;
    res.assert_status(StatusCode::OK);

    // Verify backlink exists immediately (no rebuild needed)
    let res = server
        .get("/api/vault/index/backlinks/target.md")
        .await;
    res.assert_status(StatusCode::OK);
    let backlinks: Vec<serde_json::Value> = res.json();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0]["source_path"], "source.md");
}
```

**Step 2: Test delete_folder removes index entries**

```rust
#[tokio::test]
async fn delete_folder_cleans_up_index() {
    let (server, _tmp) = setup_server();

    // Create pages inside a folder
    server
        .post("/api/vault/pages/notes/a.md")
        .json(&serde_json::json!({
            "title": "Note A",
            "body": "First note."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/notes/b.md")
        .json(&serde_json::json!({
            "title": "Note B",
            "body": "Second note."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Verify both appear in listing
    let res = server.get("/api/vault/pages").await;
    let pages: Vec<serde_json::Value> = res.json();
    assert_eq!(pages.len(), 2);

    // Delete the folder recursively
    let res = server
        .delete("/api/vault/folders/notes?recursive=true")
        .await;
    res.assert_status(StatusCode::NO_CONTENT);

    // Verify index is clean — no ghost entries
    let res = server.get("/api/vault/pages").await;
    let pages: Vec<serde_json::Value> = res.json();
    assert_eq!(pages.len(), 0, "deleted folder pages should be gone from index");
}
```

**Step 3: Test list_pages returns stable ordering**

```rust
#[tokio::test]
async fn list_pages_returns_sorted() {
    let (server, _tmp) = setup_server();

    // Create pages in non-alphabetical order
    for name in ["zebra.md", "alpha.md", "middle.md"] {
        server
            .post(&format!("/api/vault/pages/{name}"))
            .json(&serde_json::json!({
                "title": name.trim_end_matches(".md"),
                "body": "content"
            }))
            .await
            .assert_status(StatusCode::CREATED);
    }

    let res = server.get("/api/vault/pages").await;
    let pages: Vec<serde_json::Value> = res.json();
    let paths: Vec<&str> = pages.iter().map(|p| p["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["alpha.md", "middle.md", "zebra.md"]);
}
```

**Step 4: Run all tests**

Run: `cargo test`

Expected: All pass.

**Step 5: Commit**

```bash
git add tests/api_test.rs
git commit -m "test(api): add contract tests for link resolution, folder delete, and ordering

- update_page_resolves_links_bidirectionally: verifies links resolve
  immediately after update without explicit rebuild
- delete_folder_cleans_up_index: verifies folder deletion removes pages
  from the index (was previously leaving ghost entries)
- list_pages_returns_sorted: verifies deterministic path-based ordering"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/api/pages.rs` | Remove `upsert_page_in_index` (119 lines), `find_backlink_pages`, `compute_relative_path`. Replace with `VaultIndex` methods and shared helpers. Fix canonical derivation. Reorder mutations in delete/move. Add incremental reindex. Fix list ordering. |
| `src/api/folders.rs` | Remove duplicated `compute_relative_path`. Replace inline backlink query with shared helper. Reorder mutations in move. Add incremental reindex. Add index cleanup for delete. |
| `src/api/attachments.rs` | Fix list output to strip attachment folder prefix. |
| `src/api/helpers.rs` | **New file.** Shared `find_backlink_pages`, `compute_relative_path`. |
| `src/api/mod.rs` | Register `helpers` module. |
| `tests/api_test.rs` | Add ~7 new integration tests. |

**Net effect:** ~120 lines of duplicated API indexing code removed, replaced by calls to ~3 `VaultIndex` methods that are already tested. Move/delete become O(affected pages) instead of O(vault size). Mutation ordering becomes safe-by-default.
