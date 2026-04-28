# Backend Gaps Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Patch four backend gaps — FK cascade fix, pagination on list endpoints, multipart attachment upload, and full-text search via SQLite FTS5.

**Architecture:** Ordered by risk/effort: (1) schema fix is a one-line migration, (2) pagination adds `limit`/`offset` query params to existing list endpoints with a shared `PaginatedResponse<T>` wrapper, (3) attachment upload adds a `POST` handler with `axum::extract::Multipart`, (4) FTS5 adds a virtual table populated during index build with a new search endpoint.

**Tech Stack:** Rust 2024, Axum 0.8 (Multipart extractor), rusqlite (bundled, FTS5 included), SQLite FTS5

---

## Task 1: Fix `links.target_id` FK — add ON DELETE SET NULL

When a target page is deleted, `links.target_id` references become dangling. SQLite doesn't support `ALTER TABLE ... ALTER COLUMN`, so we need a migration that recreates the table.

**Files:**
- Modify: `src/vault/index.rs:100-145` (SCHEMA constant)
- Modify: `src/vault/index.rs:162-186` (add migration logic in `open()`)
- Test: `tests/index_test.rs`

**Step 1: Write the failing test**

Add to `tests/index_test.rs`:

```rust
#[test]
fn delete_target_page_nulls_link_target_id() {
    let tmp = tempfile::TempDir::new().unwrap();
    let vault_root = tmp.path().join("vault");
    init_vault(&vault_root).unwrap();

    let vault = Vault::open(&vault_root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // Create two pages: source links to target
    let source_path = vault_root.join("source.md");
    std::fs::write(
        &source_path,
        "---\ntitle: Source\n---\nSee [[target]].",
    )
    .unwrap();
    let target_path = vault_root.join("target.md");
    std::fs::write(&target_path, "---\ntitle: Target\n---\nContent.").unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Verify link is resolved
    let target_id: String = index
        .connection()
        .query_row(
            "SELECT id FROM pages WHERE path = 'target.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    let link_target: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = (SELECT id FROM pages WHERE path = 'source.md')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_target, Some(target_id.clone()));

    // Delete target page from disk and rebuild
    std::fs::remove_file(&target_path).unwrap();
    index.build(&vault).unwrap();

    // The link's target_id should now be NULL (not a dangling reference)
    let link_target_after: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = (SELECT id FROM pages WHERE path = 'source.md')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_target_after, None);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test delete_target_page_nulls_link_target_id -- --nocapture`

Expected: FAIL — the `target_id` remains as a dangling reference because the FK lacks `ON DELETE SET NULL`.

**Step 3: Update the schema**

In `src/vault/index.rs`, change line 123 in the SCHEMA constant from:

```rust
    target_id       TEXT REFERENCES pages(id),
```

to:

```rust
    target_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
```

Then add a migration in `open()` (after `conn.execute_batch(SCHEMA)?;`) to handle existing databases. SQLite can't alter FK constraints, so we need to check and recreate:

```rust
// Migration: ensure links.target_id has ON DELETE SET NULL.
// Check the current FK definition by inspecting table_info won't show FK
// actions, so we use a pragmatic approach: drop and recreate if the FK
// pragma shows no action for target_id.
let needs_migration: bool = {
    let mut stmt = conn.prepare("PRAGMA foreign_key_list(links)")?;
    let fks: Vec<(String, String)> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(3)?, row.get::<_, String>(6)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    // Look for the target_id FK (from column = "target_id")
    // If on_delete is "NO ACTION" or "NONE", we need to migrate
    fks.iter()
        .any(|(col, on_delete)| col == "target_id" && on_delete != "SET NULL")
};

if needs_migration {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS links_new (
            source_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            target_raw      TEXT NOT NULL,
            target_canonical TEXT,
            target_id       TEXT REFERENCES pages(id) ON DELETE SET NULL,
            target_path     TEXT,
            kind            TEXT NOT NULL,
            source_field    TEXT,
            span_start      INTEGER NOT NULL,
            span_end        INTEGER NOT NULL,
            PRIMARY KEY (source_id, span_start)
        );
        INSERT INTO links_new SELECT * FROM links;
        DROP TABLE links;
        ALTER TABLE links_new RENAME TO links;
        CREATE INDEX IF NOT EXISTS idx_links_target_id ON links(target_id);
        CREATE INDEX IF NOT EXISTS idx_links_target_path ON links(target_path);
        CREATE INDEX IF NOT EXISTS idx_links_target_canonical ON links(target_canonical);
        ",
    )?;
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test delete_target_page_nulls_link_target_id -- --nocapture`

Expected: PASS

**Step 5: Run full test suite**

Run: `cargo test`

Expected: All 192+ tests pass.

**Step 6: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "fix(vault): add ON DELETE SET NULL to links.target_id FK"
```

---

## Task 2: Pagination — shared types and pages endpoint

Add `limit`/`offset` pagination to list endpoints. Start with shared pagination types and the pages list endpoint.

**Files:**
- Create: `src/api/pagination.rs`
- Modify: `src/api/mod.rs` (add `pub mod pagination;`)
- Modify: `src/api/pages.rs:103-127` (list_pages handler)
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn list_pages_pagination() {
    let (server, tmp) = setup_server();

    // Create 5 pages
    for i in 0..5 {
        let path = format!("page-{i}.md");
        server
            .post(&format!("/api/vault/pages/{path}"))
            .json(&serde_json::json!({ "title": format!("Page {i}") }))
            .await
            .assert_status(StatusCode::CREATED);
    }

    // Default (no pagination) returns all
    let res = server.get("/api/vault/pages").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 5);

    // With limit=2, offset=0
    let res = server.get("/api/vault/pages?limit=2&offset=0").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
    assert_eq!(body["limit"], 2);
    assert_eq!(body["offset"], 0);

    // With limit=2, offset=3 — should return 2 remaining
    let res = server.get("/api/vault/pages?limit=2&offset=3").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
    assert_eq!(body["offset"], 3);

    // With limit=2, offset=10 — should return empty
    let res = server.get("/api/vault/pages?limit=2&offset=10").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test list_pages_pagination -- --nocapture`

Expected: FAIL — the current endpoint returns `Vec<PageSummary>`, not a paginated wrapper.

**Step 3: Create pagination module**

Create `src/api/pagination.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Query parameters for paginated list endpoints.
///
/// Both fields are optional — if omitted, the endpoint returns all items.
#[derive(Debug, Deserialize)]
pub struct PaginationParams {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// Paginated response wrapper.
#[derive(Debug, Serialize)]
pub struct PaginatedResponse<T: Serialize> {
    pub items: Vec<T>,
    pub total: u32,
    pub limit: Option<u32>,
    pub offset: u32,
}

impl<T: Serialize> PaginatedResponse<T> {
    /// Build a paginated response from a full list.
    ///
    /// If `limit` is None, all items are returned.
    pub fn from_vec(items: Vec<T>, params: &PaginationParams) -> Self {
        let total = items.len() as u32;
        let offset = params.offset.unwrap_or(0);
        let start = offset as usize;

        let paged: Vec<T> = if let Some(limit) = params.limit {
            items.into_iter().skip(start).take(limit as usize).collect()
        } else {
            items.into_iter().skip(start).collect()
        };

        Self {
            items: paged,
            total,
            limit: params.limit,
            offset,
        }
    }
}
```

Add `pub mod pagination;` to `src/api/mod.rs`.

**Step 4: Update list_pages handler**

In `src/api/pages.rs`, modify `list_pages`:

```rust
use super::pagination::{PaginatedResponse, PaginationParams};

async fn list_pages(
    State(state): State<Arc<AppState>>,
    Query(pagination): Query<PaginationParams>,
) -> Result<Json<PaginatedResponse<PageSummary>>, ApiError> {
    let index = state.index.lock();

    let mut stmt = index
        .connection()
        .prepare("SELECT id, path, title, canonical_name FROM pages ORDER BY path")
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let pages: Vec<PageSummary> = stmt
        .query_map([], |row| {
            Ok(PageSummary {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                canonical_name: row.get(3)?,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(PaginatedResponse::from_vec(pages, &pagination)))
}
```

**Step 5: Fix existing tests**

Some existing tests call `GET /api/vault/pages` and expect `Vec<PageSummary>` directly. They now receive `PaginatedResponse<PageSummary>`, so update any assertions to access `.items` (e.g., `body["items"].as_array()`). Search for any test using `GET /api/vault/pages` and fix accordingly.

Common pattern fix:
```rust
// Before:
let pages: Vec<serde_json::Value> = res.json();
// After:
let body: serde_json::Value = res.json();
let pages = body["items"].as_array().unwrap();
```

**Step 6: Run tests**

Run: `cargo test`

Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/api/pagination.rs src/api/mod.rs src/api/pages.rs tests/api_test.rs
git commit -m "feat(api): add pagination to pages list endpoint"
```

---

## Task 3: Pagination — academic works and content-index endpoints

Extend pagination to the remaining list endpoints.

**Files:**
- Modify: `src/api/academic.rs:683-739` (list_works handler)
- Modify: `src/api/index_routes.rs:607-682` (content_index handler)
- Test: `tests/api_test.rs`

**Step 1: Write failing tests**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn list_works_pagination() {
    let (server, _tmp) = setup_server();

    // Create 3 works
    for i in 0..3 {
        server
            .post("/api/vault/academic/works")
            .json(&serde_json::json!({
                "title": format!("Work {i}"),
                "work_type": "article",
                "authors": [format!("Author {i}")],
            }))
            .await
            .assert_status(StatusCode::CREATED);
    }

    // Default returns all
    let res = server.get("/api/vault/academic/works").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["items"].as_array().unwrap().len(), 3);

    // With limit=1
    let res = server.get("/api/vault/academic/works?limit=1").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn content_index_pagination() {
    let (server, _tmp) = setup_server();

    // Create 3 pages
    for i in 0..3 {
        server
            .post(&format!("/api/vault/pages/p{i}.md"))
            .json(&serde_json::json!({ "title": format!("P{i}") }))
            .await
            .assert_status(StatusCode::CREATED);
    }

    let res = server.get("/api/vault/index/content-index?limit=2").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test list_works_pagination content_index_pagination -- --nocapture`

Expected: FAIL

**Step 3: Update list_works handler**

In `src/api/academic.rs`, add pagination to `list_works`. Import the pagination types:

```rust
use super::pagination::{PaginatedResponse, PaginationParams};
```

Change `ListWorksQuery` to also include pagination fields OR accept pagination as a separate `Query` extractor. The simplest approach — merge pagination into `ListWorksQuery`:

```rust
#[derive(Debug, Deserialize)]
pub struct ListWorksQuery {
    pub work_type: Option<String>,
    pub status: Option<String>,
    pub year: Option<i32>,
    pub author: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}
```

Update the handler return type to `PaginatedResponse<WorkSummary>` and use `PaginatedResponse::from_vec()` with a `PaginationParams` derived from the query.

**Step 4: Update content_index handler**

In `src/api/index_routes.rs`, add `Query(pagination): Query<PaginationParams>` to `content_index` and wrap the result in `PaginatedResponse`.

**Step 5: Fix any existing tests**

Update any tests that query `/academic/works` or `/index/content-index` to expect the `PaginatedResponse` shape (`body["items"]`).

**Step 6: Run all tests**

Run: `cargo test`

Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/api/academic.rs src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): add pagination to works and content-index endpoints"
```

---

## Task 4: Attachment upload endpoint

Add `POST /api/vault/attachments/{*path}` for multipart file upload.

**Files:**
- Modify: `src/api/attachments.rs` (add upload handler + route)
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn upload_and_retrieve_attachment() {
    let (server, _tmp) = setup_server();

    // Upload a file via multipart
    let boundary = "----testboundary";
    let file_content = b"hello world";
    let body = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\n\
         Content-Type: text/plain\r\n\
         \r\n\
         {}\r\n\
         --{boundary}--\r\n",
        std::str::from_utf8(file_content).unwrap()
    );

    let res = server
        .post("/api/vault/attachments/test.txt")
        .content_type(&format!("multipart/form-data; boundary={boundary}"))
        .bytes(body.into_bytes().into())
        .await;

    res.assert_status(StatusCode::CREATED);
    let info: serde_json::Value = res.json();
    assert_eq!(info["name"], "test.txt");
    assert_eq!(info["path"], "test.txt");

    // Retrieve it
    let res = server.get("/api/vault/attachments/test.txt").await;
    res.assert_status(StatusCode::OK);
    assert_eq!(res.text(), "hello world");
}

#[tokio::test]
async fn upload_attachment_conflict() {
    let (server, _tmp) = setup_server();

    let boundary = "----testboundary";
    let body = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"file\"; filename=\"dup.txt\"\r\n\
         Content-Type: text/plain\r\n\
         \r\n\
         first\r\n\
         --{boundary}--\r\n"
    );
    let ct = format!("multipart/form-data; boundary={boundary}");

    // First upload succeeds
    server
        .post("/api/vault/attachments/dup.txt")
        .content_type(&ct)
        .bytes(body.clone().into_bytes().into())
        .await
        .assert_status(StatusCode::CREATED);

    // Second upload to same path returns 409 Conflict
    server
        .post("/api/vault/attachments/dup.txt")
        .content_type(&ct)
        .bytes(body.into_bytes().into())
        .await
        .assert_status(StatusCode::CONFLICT);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test upload_and_retrieve_attachment upload_attachment_conflict -- --nocapture`

Expected: FAIL — 404 because POST route doesn't exist.

**Step 3: Implement upload handler**

In `src/api/attachments.rs`:

Add the import:
```rust
use axum::extract::Multipart;
use axum::routing::post;
```

Add POST route to the router:
```rust
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_attachments))
        .route("/{*path}", get(get_attachment).post(upload_attachment).delete(delete_attachment))
}
```

Add the handler:
```rust
async fn upload_attachment(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let rel_path = format!("{attachment_folder}/{path}");

    let vault_path = VaultPath::new(&rel_path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);

    // Conflict check
    if abs_path.exists() {
        return Err(ApiError::conflict(format!(
            "attachment already exists: {path}"
        )));
    }

    // Create parent directories
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // Read the first field from multipart
    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("invalid multipart: {e}")))?
        .ok_or_else(|| ApiError::bad_request("no file field in multipart body".to_string()))?;

    let bytes = field
        .bytes()
        .await
        .map_err(|e| ApiError::bad_request(format!("failed to read file: {e}")))?;

    fs::write(&abs_path, &bytes)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    let size = bytes.len() as u64;
    let name = abs_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok((
        StatusCode::CREATED,
        Json(AttachmentInfo {
            name,
            path,
            size,
        }),
    )
        .into_response())
}
```

**Step 4: Run tests**

Run: `cargo test upload_and_retrieve_attachment upload_attachment_conflict -- --nocapture`

Expected: PASS

**Step 5: Run full test suite**

Run: `cargo test`

Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/api/attachments.rs tests/api_test.rs
git commit -m "feat(api): add multipart POST endpoint for attachment upload"
```

---

## Task 5: Full-text search — FTS5 table and index population

Add an FTS5 virtual table and populate it during index build.

**Files:**
- Modify: `src/vault/index.rs:100-145` (SCHEMA — add FTS table)
- Modify: `src/vault/index.rs` (build method — populate FTS table)
- Modify: `src/vault/index.rs` (index_page method — populate FTS on single-page index)
- Modify: `src/vault/index.rs` (remove_page method — remove from FTS)
- Test: `tests/index_test.rs`

**Step 1: Write the failing test**

Add to `tests/index_test.rs`:

```rust
#[test]
fn fts_search_returns_matching_pages() {
    let tmp = tempfile::TempDir::new().unwrap();
    let vault_root = tmp.path().join("vault");
    init_vault(&vault_root).unwrap();

    let vault = Vault::open(&vault_root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // Create pages with distinctive content
    std::fs::write(
        vault_root.join("quantum.md"),
        "---\ntitle: Quantum Mechanics\n---\nThe study of subatomic particles and wave functions.",
    )
    .unwrap();
    std::fs::write(
        vault_root.join("cooking.md"),
        "---\ntitle: Cooking Basics\n---\nHow to make a perfect sourdough bread.",
    )
    .unwrap();
    std::fs::write(
        vault_root.join("physics.md"),
        "---\ntitle: Classical Physics\n---\nNewton's laws and wave mechanics.",
    )
    .unwrap();

    index.build(&vault).unwrap();

    // Search for "wave"
    let results = index.search("wave", 10).unwrap();
    assert_eq!(results.len(), 2);

    // Both quantum and physics should match, cooking should not
    let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.contains(&"quantum.md"));
    assert!(paths.contains(&"physics.md"));
    assert!(!paths.contains(&"cooking.md"));
}

#[test]
fn fts_search_matches_title() {
    let tmp = tempfile::TempDir::new().unwrap();
    let vault_root = tmp.path().join("vault");
    init_vault(&vault_root).unwrap();

    let vault = Vault::open(&vault_root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    std::fs::write(
        vault_root.join("note.md"),
        "---\ntitle: Zettelkasten Method\n---\nA note-taking approach.",
    )
    .unwrap();

    index.build(&vault).unwrap();

    let results = index.search("zettelkasten", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].path, "note.md");
}

#[test]
fn fts_search_removed_page_not_returned() {
    let tmp = tempfile::TempDir::new().unwrap();
    let vault_root = tmp.path().join("vault");
    init_vault(&vault_root).unwrap();

    let vault = Vault::open(&vault_root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let page_path = vault_root.join("ephemeral.md");
    std::fs::write(&page_path, "---\ntitle: Ephemeral\n---\nTemporary content.").unwrap();

    index.build(&vault).unwrap();
    assert_eq!(index.search("ephemeral", 10).unwrap().len(), 1);

    // Remove from disk and rebuild
    std::fs::remove_file(&page_path).unwrap();
    index.build(&vault).unwrap();

    assert_eq!(index.search("ephemeral", 10).unwrap().len(), 0);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test fts_search -- --nocapture`

Expected: FAIL — `search()` method doesn't exist.

**Step 3: Add FTS5 table to schema**

In `src/vault/index.rs`, append to the SCHEMA constant (before the closing `"#`):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    page_id UNINDEXED,
    path UNINDEXED,
    title,
    body,
    content='',
    tokenize='porter unicode61'
);
```

Note: `content=''` makes this an "external content" FTS table — we manually manage inserts/deletes. `page_id` and `path` are stored but not indexed (UNINDEXED) for result retrieval.

**Step 4: Add SearchResult type and search method**

Add to `src/vault/index.rs`:

```rust
/// A single full-text search result.
#[derive(Debug)]
pub struct SearchResult {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
    pub snippet: String,
    pub rank: f64,
}

impl VaultIndex {
    /// Full-text search across page titles and bodies.
    ///
    /// Returns up to `limit` results ordered by relevance (best first).
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>, IndexError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.page_id, f.path, p.title,
                    snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32),
                    rank
             FROM pages_fts f
             JOIN pages p ON p.id = f.page_id
             WHERE pages_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2"
        )?;

        let results = stmt
            .query_map(params![query, limit as u32], |row| {
                Ok(SearchResult {
                    page_id: row.get(0)?,
                    path: row.get(1)?,
                    title: row.get(2)?,
                    snippet: row.get(3)?,
                    rank: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(results)
    }
}
```

**Step 5: Populate FTS during full build**

In the `build()` method, after each page is upserted to the `pages` table (in the pass 2 loop), insert into FTS. Find the upsert block and add after it:

```rust
// Insert into FTS (delete old entry first)
tx.execute(
    "DELETE FROM pages_fts WHERE page_id = ?1",
    params![page_id_str],
)?;
tx.execute(
    "INSERT INTO pages_fts (page_id, path, title, body) VALUES (?1, ?2, ?3, ?4)",
    params![
        page_id_str,
        pf.vault_path.as_str(),
        pf.meta.title.as_deref().unwrap_or(""),
        &pf.body,
    ],
)?;
```

**Step 6: Populate FTS during incremental index_page**

In the `index_page()` method, after the page is upserted, add the same FTS insert logic.

**Step 7: Clean up FTS during remove_page**

In the `remove_page()` method, before or after the page DELETE, remove from FTS:

```rust
// Also remove from FTS
let page_id: Option<String> = self.conn
    .query_row(
        "SELECT id FROM pages WHERE path = ?1",
        params![vault_path.as_str()],
        |row| row.get(0),
    )
    .ok();

if let Some(ref pid) = page_id {
    self.conn.execute("DELETE FROM pages_fts WHERE page_id = ?1", params![pid])?;
}
```

Do this BEFORE the `DELETE FROM pages` statement so we can still look up the page_id.

**Step 8: Clean up FTS during full build prune**

In the `build()` method, there's a section that prunes pages removed from disk. Find where it does `DELETE FROM pages WHERE path = ?1` for removed paths and add a matching FTS delete.

**Step 9: Run tests**

Run: `cargo test fts_search -- --nocapture`

Expected: All 3 FTS tests pass.

**Step 10: Run full test suite**

Run: `cargo test`

Expected: All tests pass.

**Step 11: Commit**

```bash
git add src/vault/index.rs tests/index_test.rs
git commit -m "feat(vault): add FTS5 full-text search with porter tokenizer"
```

---

## Task 6: Full-text search — API endpoint

Expose the search functionality via a REST endpoint.

**Files:**
- Modify: `src/api/index_routes.rs` (add search route + handler)
- Test: `tests/api_test.rs`

**Step 1: Write the failing test**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn search_pages() {
    let (server, _tmp) = setup_server();

    // Create pages with distinct content
    server
        .post("/api/vault/pages/rust.md")
        .json(&serde_json::json!({
            "title": "Rust Programming",
            "body": "Rust is a systems programming language focused on safety."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/python.md")
        .json(&serde_json::json!({
            "title": "Python Programming",
            "body": "Python is a dynamic scripting language."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Search for "safety"
    let res = server.get("/api/vault/index/search?q=safety").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    let results = body.as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], "rust.md");
    assert!(results[0]["snippet"].as_str().unwrap().contains("safety"));

    // Search for "programming" matches both
    let res = server.get("/api/vault/index/search?q=programming").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body.as_array().unwrap().len(), 2);

    // Search with limit
    let res = server
        .get("/api/vault/index/search?q=programming&limit=1")
        .await;
    let body: serde_json::Value = res.json();
    assert_eq!(body.as_array().unwrap().len(), 1);

    // Missing query param returns 400
    let res = server.get("/api/vault/index/search").await;
    res.assert_status(StatusCode::BAD_REQUEST);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test search_pages -- --nocapture`

Expected: FAIL — no `/search` route exists.

**Step 3: Add search endpoint**

In `src/api/index_routes.rs`:

Add query struct:
```rust
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<u32>,
}
```

Add response struct:
```rust
#[derive(Debug, Serialize)]
pub struct SearchResultEntry {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
    pub snippet: String,
}
```

Add the route to the router:
```rust
.route("/search", get(search))
```

Add the handler:
```rust
async fn search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SearchResultEntry>>, ApiError> {
    let q = query
        .q
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request("missing 'q' query parameter".to_string()))?;

    let limit = query.limit.unwrap_or(20) as usize;

    let index = state.index.lock();
    let results = index
        .search(&q, limit)
        .map_err(|e| ApiError::internal(format!("search failed: {e}")))?;

    let entries: Vec<SearchResultEntry> = results
        .into_iter()
        .map(|r| SearchResultEntry {
            page_id: r.page_id,
            path: r.path,
            title: r.title,
            snippet: r.snippet,
        })
        .collect();

    Ok(Json(entries))
}
```

**Step 4: Run tests**

Run: `cargo test search_pages -- --nocapture`

Expected: PASS

**Step 5: Run full test suite**

Run: `cargo test`

Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): add GET /index/search endpoint for full-text search"
```

---

## Task 7: Frontend search hook + final verification

Add a frontend API hook for search so the UI can consume it later, then run full verification.

**Files:**
- Modify: `ui/src/api/types.ts` (add SearchResult type)
- Modify: `ui/src/api/index.ts` (add useSearch hook)
- Modify: `ui/src/api/types.ts` (update PaginatedResponse type if needed for pages)

**Step 1: Add search types and hook**

In `ui/src/api/types.ts`, add:

```typescript
export interface SearchResult {
  page_id: string;
  path: string;
  title: string | null;
  snippet: string;
}
```

In `ui/src/api/index.ts`, add:

```typescript
import type { SearchResult } from "./types";

async function fetchSearch(query: string, limit?: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (limit) params.set("limit", String(limit));
  const res = await fetch(`/api/vault/index/search?${params}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

export function useSearch(query: string, limit?: number) {
  return useQuery({
    queryKey: ["index", "search", query, limit],
    queryFn: () => fetchSearch(query, limit),
    enabled: query.length > 0,
  });
}
```

**Step 2: Update pages hook for paginated response**

The list pages endpoint now returns `PaginatedResponse<PageSummary>` instead of `PageSummary[]`. Update `ui/src/api/types.ts`:

```typescript
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number | null;
  offset: number;
}
```

Update `ui/src/api/pages.ts` `fetchPages` return type:

```typescript
async function fetchPages(): Promise<PaginatedResponse<PageSummary>> {
  const res = await fetch("/api/vault/pages");
  if (!res.ok) throw new Error(`Failed to fetch pages: ${res.status}`);
  return res.json();
}
```

Update `usePages` return type accordingly. Then update consumers in `ui/src/components/PageList.tsx` and `ui/src/routes/index.tsx` to access `.items` from the response (e.g., `pages?.items` instead of `pages`).

**Step 3: Run frontend verification**

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/ui && bun run format
cd /Users/kit/Source/_p.pkm/clepsydra/ui && bun run typecheck
cd /Users/kit/Source/_p.pkm/clepsydra/ui && bun run build
```

**Step 4: Run backend tests**

```bash
cd /Users/kit/Source/_p.pkm/clepsydra && cargo test
```

**Step 5: Commit**

```bash
git add ui/src/api/ ui/src/components/PageList.tsx ui/src/routes/index.tsx
git commit -m "feat(ui): add search hook and update pages hook for paginated response"
```

---

## Dependency Graph

```
Task 1 (FK fix)          — independent, do first
Task 2 (pagination base) — independent of Task 1
Task 3 (pagination rest) — depends on Task 2
Task 4 (attachment upload) — independent
Task 5 (FTS5 index)      — independent
Task 6 (FTS5 endpoint)   — depends on Task 5
Task 7 (frontend hooks + verify) — depends on Tasks 2, 3, 6
```

Tasks 1, 2, 4, 5 can proceed in parallel after Task 1 is done.

---

## Notes for Implementer

1. **SQLite FTS5 bundled:** The `rusqlite` dependency already uses `features = ["bundled"]`, which includes FTS5 support. No additional feature flags needed.

2. **Multipart in Axum 0.8:** `axum::extract::Multipart` is available out of the box — no extra dependency needed. The extractor consumes the request body, so it must be the last extractor in the handler signature (after `State` and `Path`).

3. **FTS5 `content=''`:** Using external-content mode means we manage inserts/deletes manually. This avoids duplicating page content in the FTS shadow tables. The trade-off: we must remember to delete/insert on every page change.

4. **FTS5 tokenizer:** `porter unicode61` gives stemming (so "programming" matches "program") and Unicode support. This is a good default for a knowledge base.

5. **Pagination backward compatibility:** The `PaginatedResponse` wrapper changes the shape of list endpoint responses. Frontend consumers must be updated (Task 7). The `limit` field being optional means if no `limit` param is provided, all items are returned (backward-compatible behavior for the data, just wrapped differently).

6. **FK migration safety:** The `links` table migration (Task 1) uses CREATE-INSERT-DROP-RENAME, which is atomic within SQLite. Indexes must be recreated after the rename. The migration check uses `PRAGMA foreign_key_list()` which returns FK definitions including the on_delete action.
