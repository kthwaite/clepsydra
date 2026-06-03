use std::fs;
use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum_test::TestServer;
use tokio::sync::broadcast;

use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::academic_hook::AcademicMoveHook;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::hooks::PostMoveHook;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

fn production_hooks() -> Arc<Vec<Box<dyn PostMoveHook>>> {
    Arc::new(vec![Box::new(AcademicMoveHook)])
}

/// Set up a test server backed by a fresh vault in a temporary directory.
fn setup_server() -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let index_handle = IndexHandle::spawn(index, vault.clone());

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn bcl_endpoint_returns_nulls_when_unconfigured() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/bcl").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert!(body["birth_date"].is_null());
    assert!(body["bcl_date"].is_null());
    assert!(body["remaining_seconds"].is_null());
}

#[tokio::test]
async fn create_and_get_page() {
    let (server, _tmp) = setup_server();

    // Create a page
    let res = server
        .post("/api/vault/pages/hello.md")
        .json(&serde_json::json!({
            "title": "Hello World",
            "tags": ["greeting"],
            "body": "# Hello\n\nThis is a test page."
        }))
        .await;

    res.assert_status(axum::http::StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    assert_eq!(body["path"], "hello.md");
    assert_eq!(body["meta"]["title"], "Hello World");
    assert_eq!(body["body"], "# Hello\n\nThis is a test page.");

    // Get the page back
    let res = server.get("/api/vault/pages/hello.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["path"], "hello.md");
    assert_eq!(body["meta"]["title"], "Hello World");
}

#[tokio::test]
async fn create_duplicate_returns_409() {
    let (server, _tmp) = setup_server();

    // Create a page
    server
        .post("/api/vault/pages/dup.md")
        .json(&serde_json::json!({ "title": "Dup" }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Try to create the same page again
    let res = server
        .post("/api/vault/pages/dup.md")
        .json(&serde_json::json!({ "title": "Dup Again" }))
        .await;

    res.assert_status(axum::http::StatusCode::CONFLICT);
}

#[tokio::test]
async fn get_nonexistent_returns_404() {
    let (server, _tmp) = setup_server();

    let res = server.get("/api/vault/pages/no-such-page.md").await;
    res.assert_status(axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_page_no_backlinks() {
    let (server, _tmp) = setup_server();

    // Create and then delete
    server
        .post("/api/vault/pages/ephemeral.md")
        .json(&serde_json::json!({ "title": "Ephemeral" }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.delete("/api/vault/pages/ephemeral.md").await;
    res.assert_status(axum::http::StatusCode::NO_CONTENT);

    // Confirm it's gone
    let res = server.get("/api/vault/pages/ephemeral.md").await;
    res.assert_status(axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn path_traversal_rejected() {
    let (server, _tmp) = setup_server();

    // VaultPath rejects `..` components. HTTP normalizes `../` in URL paths,
    // so we test with percent-encoded `..` (%2e%2e) in a path segment that
    // Axum will decode for the wildcard parameter.
    let res = server
        .post("/api/vault/pages/%2e%2e/%2e%2e/etc/passwd")
        .json(&serde_json::json!({ "title": "Evil" }))
        .await;

    let status = res.status_code();
    // Must not succeed — either 400 (VaultPath rejects `..`) or 404 (Axum
    // normalizes it away) are acceptable security outcomes
    assert_ne!(
        status,
        axum::http::StatusCode::CREATED,
        "path traversal must not succeed"
    );
}

#[tokio::test]
async fn list_pages() {
    let (server, _tmp) = setup_server();

    // Create two pages
    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({ "title": "Alpha" }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    server
        .post("/api/vault/pages/beta.md")
        .json(&serde_json::json!({ "title": "Beta" }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let res = server.get("/api/vault/pages").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
}

#[tokio::test]
async fn create_and_list_folder() {
    let (server, _tmp) = setup_server();

    // Create a folder
    let res = server.post("/api/vault/folders/notes").await;
    res.assert_status(axum::http::StatusCode::CREATED);

    // List top-level folders
    let res = server.get("/api/vault/folders").await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();

    // Should contain our "notes" folder (and maybe "_attachments" but that's excluded by default)
    let folder_names: Vec<&str> = body.iter().filter_map(|f| f["name"].as_str()).collect();
    assert!(
        folder_names.contains(&"notes"),
        "expected 'notes' in folders, got: {folder_names:?}"
    );
}

#[tokio::test]
async fn lists_folder_contents_sorted() {
    let (server, _tmp) = setup_server_with_files(&[
        ("topic/Beta.md", "# Beta\n"),
        ("topic/Alpha.md", "# Alpha\n"),
        ("topic/sub/Child.md", "# Child\n"),
    ]);
    let resp = server.get("/api/vault/folders/topic").await;
    resp.assert_status_ok();
    let body: serde_json::Value = resp.json();
    // exactly the two md files in topic/ (sub/Child.md is one level deeper)
    let pages = body["pages"].as_array().expect("pages array");
    assert_eq!(
        pages.len(),
        2,
        "expected exactly 2 pages in topic/: {pages:?}"
    );
    let paths: Vec<&str> = pages.iter().filter_map(|p| p["path"].as_str()).collect();
    assert!(paths.iter().any(|p| p.ends_with("Alpha.md")));
    assert!(paths.iter().any(|p| p.ends_with("Beta.md")));
    // pages sorted by path: Alpha before Beta
    let alpha = paths.iter().position(|p| p.ends_with("Alpha.md")).unwrap();
    let beta = paths.iter().position(|p| p.ends_with("Beta.md")).unwrap();
    assert!(alpha < beta, "Alpha should sort before Beta: {paths:?}");
    // exactly the one subfolder
    let folders = body["folders"].as_array().expect("folders array");
    assert_eq!(
        folders.len(),
        1,
        "expected exactly 1 subfolder: {folders:?}"
    );
    assert!(folders.iter().any(|f| f["name"].as_str() == Some("sub")));
}

#[tokio::test]
async fn list_attachments_empty() {
    let (server, _tmp) = setup_server();

    let res = server.get("/api/vault/attachments").await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();
    assert!(body.is_empty(), "expected empty attachments list");
}

// ---------------------------------------------------------------------------
// Move page tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn move_page_rewrites_backlinks() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // Create target page
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Target content."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Create source page that links to target
    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({"title": "Source", "body": "See [[Target]] here."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild index to register links
    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status_ok();

    // Move target.md -> renamed.md
    let res = server
        .post("/api/vault/pages-move/target.md")
        .json(&serde_json::json!({"destination": "renamed.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);

    // Verify file moved
    assert!(
        !vault_root.join("target.md").exists(),
        "target.md should not exist after move"
    );
    assert!(
        vault_root.join("renamed.md").exists(),
        "renamed.md should exist after move"
    );

    // Verify backlink was rewritten in source.md
    let content = fs::read_to_string(vault_root.join("source.md")).unwrap();
    assert!(
        !content.contains("[[Target]]"),
        "old link should be rewritten, but found: {content}"
    );
    // The new link should reference "renamed" (the new stem)
    assert!(
        content.contains("[[renamed]]"),
        "expected [[renamed]] in rewritten content, but found: {content}"
    );
}

#[tokio::test]
async fn move_page_nonexistent_returns_404() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/pages-move/nonexistent.md")
        .json(&serde_json::json!({"destination": "new.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn move_page_destination_exists_returns_409() {
    let (server, _tmp) = setup_server();

    // Create two pages
    server
        .post("/api/vault/pages/a.md")
        .json(&serde_json::json!({"title": "A"}))
        .await
        .assert_status(StatusCode::CREATED);
    server
        .post("/api/vault/pages/b.md")
        .json(&serde_json::json!({"title": "B"}))
        .await
        .assert_status(StatusCode::CREATED);

    // Try to move a.md -> b.md (b.md already exists)
    let res = server
        .post("/api/vault/pages-move/a.md")
        .json(&serde_json::json!({"destination": "b.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::CONFLICT);
}

// ---------------------------------------------------------------------------
// Delete with backlinks tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_with_backlinks_returns_409() {
    let (server, _tmp) = setup_server();

    // Create target page
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Target content."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Create linker page that links to target
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]] here."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild index to register links
    server.post("/api/vault/index/rebuild").await;

    // DELETE target without force -> 409 with backlinks list
    let res = server.delete("/api/vault/pages/target.md").await;
    assert_eq!(res.status_code(), StatusCode::CONFLICT);

    let body: serde_json::Value = res.json();
    assert!(
        body["detail"]["backlinks"].is_array(),
        "expected backlinks in error detail, got: {body}"
    );
}

#[tokio::test]
async fn delete_force_plain_text_rewrites() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // Create target page
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Target content."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Create linker page that links to target
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]] here."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild index to register links
    server.post("/api/vault/index/rebuild").await;

    // DELETE target?force=true&rewrite=plain_text -> 204
    let res = server
        .delete("/api/vault/pages/target.md?force=true&rewrite=plain_text")
        .await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    // Verify target is deleted
    assert!(!vault_root.join("target.md").exists());

    // Verify linker.md has plain text instead of [[Target]]
    let content = fs::read_to_string(vault_root.join("linker.md")).unwrap();
    assert!(
        !content.contains("[[Target]]"),
        "old link should be rewritten, but found: {content}"
    );
    assert!(
        content.contains("Target"),
        "display text should remain as plain text, but found: {content}"
    );
    // Should NOT have wikilink brackets
    assert!(
        !content.contains("[["),
        "should not have wikilink brackets, but found: {content}"
    );
}

#[tokio::test]
async fn delete_force_unlink_rewrites() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // Create target page
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Target content."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Create linker page that links to target
    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]] here."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild index to register links
    server.post("/api/vault/index/rebuild").await;

    // DELETE target?force=true&rewrite=unlink -> 204
    let res = server
        .delete("/api/vault/pages/target.md?force=true&rewrite=unlink")
        .await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    // Verify target is deleted
    assert!(!vault_root.join("target.md").exists());

    // Verify linker.md has strikethrough text instead of [[Target]]
    let content = fs::read_to_string(vault_root.join("linker.md")).unwrap();
    assert!(
        !content.contains("[[Target]]"),
        "old link should be rewritten, but found: {content}"
    );
    assert!(
        content.contains("~~Target~~"),
        "expected strikethrough ~~Target~~, but found: {content}"
    );
}

// ---------------------------------------------------------------------------
// Index query endpoint tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn index_backlinks() {
    let (server, _tmp) = setup_server();

    // Create target and linker pages
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({"title": "Target", "body": "Target content."}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/linker.md")
        .json(&serde_json::json!({"title": "Linker", "body": "See [[Target]] here."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild to register links
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    // Query backlinks for target.md
    let res = server.get("/api/vault/index/backlinks/target.md").await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1, "expected 1 backlink, got: {body:?}");
    assert_eq!(body[0]["source_path"], "linker.md");
    assert!(
        body[0]["context"].as_str().unwrap().contains("[[Target]]"),
        "expected context to contain [[Target]], got: {}",
        body[0]["context"]
    );
}

#[tokio::test]
async fn index_tags() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/a.md")
        .json(&serde_json::json!({"title": "A", "tags": ["rust", "web"]}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/b.md")
        .json(&serde_json::json!({"title": "B", "tags": ["rust"]}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild index so tags are fresh
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/tags").await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();

    // "rust" should appear with count 2, "web" with count 1
    let rust_entry = body.iter().find(|e| e["tag"] == "rust");
    assert!(rust_entry.is_some(), "expected 'rust' tag, got: {body:?}");
    assert_eq!(rust_entry.unwrap()["count"], 2);

    let web_entry = body.iter().find(|e| e["tag"] == "web");
    assert!(web_entry.is_some(), "expected 'web' tag, got: {body:?}");
    assert_eq!(web_entry.unwrap()["count"], 1);
}

#[tokio::test]
async fn index_stats() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({"title": "Alpha", "tags": ["t1"], "body": "See [[Beta]]."}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/beta.md")
        .json(&serde_json::json!({"title": "Beta", "tags": ["t2"]}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    assert_eq!(body["pages"], 2);
    assert!(body["links_total"].as_i64().unwrap() >= 1);
    assert_eq!(body["tags"], 2); // t1 and t2
}

#[tokio::test]
async fn stats_returns_last_indexed_at_when_pages_exist() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({"title": "Alpha"}))
        .await
        .assert_status(StatusCode::CREATED);
    server
        .post("/api/vault/pages/beta.md")
        .json(&serde_json::json!({"title": "Beta"}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(
        body["last_indexed_at"].is_string(),
        "expected last_indexed_at to be set when pages exist; got {body:?}",
    );
}

#[tokio::test]
async fn stats_returns_null_last_indexed_at_for_empty_vault() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(
        body["last_indexed_at"].is_null(),
        "expected last_indexed_at to be null on empty vault; got {body:?}",
    );
}

#[tokio::test]
async fn similar_returns_pages_sharing_tags() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/a.md")
        .json(&serde_json::json!({"title": "A", "tags": ["foo", "bar"]}))
        .await
        .assert_status(StatusCode::CREATED);
    server
        .post("/api/vault/pages/b.md")
        .json(&serde_json::json!({"title": "B", "tags": ["foo", "bar", "baz"]}))
        .await
        .assert_status(StatusCode::CREATED);
    server
        .post("/api/vault/pages/c.md")
        .json(&serde_json::json!({"title": "C", "tags": ["foo"]}))
        .await
        .assert_status(StatusCode::CREATED);
    server
        .post("/api/vault/pages/d.md")
        .json(&serde_json::json!({"title": "D", "tags": ["unrelated"]}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/similar/a.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().expect("items array");
    let paths: Vec<&str> = items.iter().map(|i| i["path"].as_str().unwrap()).collect();

    assert_eq!(
        paths,
        vec!["b.md", "c.md"],
        "expected b then c (more shared tags first); got {paths:?}"
    );
    assert!(
        !paths.contains(&"d.md"),
        "d has no shared tags and must not appear"
    );
}

#[tokio::test]
async fn similar_returns_empty_for_untagged_page() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/a.md")
        .json(&serde_json::json!({"title": "A"}))
        .await
        .assert_status(StatusCode::CREATED);
    server
        .post("/api/vault/pages/b.md")
        .json(&serde_json::json!({"title": "B", "tags": ["foo"]}))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/similar/a.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(
        body["items"]
            .as_array()
            .map(|a| a.is_empty())
            .unwrap_or(false),
        "expected empty items for untagged page; got {body:?}",
    );
}

#[tokio::test]
async fn index_rebuild() {
    let (server, _tmp) = setup_server();

    // Create a page first
    server
        .post("/api/vault/pages/test.md")
        .json(&serde_json::json!({"title": "Test"}))
        .await
        .assert_status(StatusCode::CREATED);

    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["pages_indexed"].as_i64().unwrap() >= 0);
}

// ---------------------------------------------------------------------------
// Get page by UUID test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_page_by_uuid() {
    let (server, _tmp) = setup_server();

    // Create a page
    let res = server
        .post("/api/vault/pages/uuid-test.md")
        .json(&serde_json::json!({"title": "UUID Test", "body": "Content here."}))
        .await;
    res.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = res.json();

    // The page ID should be in the meta
    let page_id = created["meta"]["id"].as_str().unwrap();

    // Fetch by UUID
    let res = server
        .get(&format!("/api/vault/pages/by-id/{page_id}"))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["path"], "uuid-test.md");
    assert_eq!(body["meta"]["title"], "UUID Test");
    assert_eq!(body["body"], "Content here.");
}

// ---------------------------------------------------------------------------
// Folder move test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn move_folder_rewrites_all_contained_pages() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // Create folder with a page inside
    server
        .post("/api/vault/folders/notes")
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/notes/design.md")
        .json(&serde_json::json!({"title": "Design Notes", "body": "Some design notes."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Create external page that links to the page inside the folder
    server
        .post("/api/vault/pages/index.md")
        .json(&serde_json::json!({"title": "Index", "body": "See [[Design Notes]] for details."}))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild index
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    // Move the folder
    let res = server
        .post("/api/vault/folders-move/notes")
        .json(&serde_json::json!({"destination": "docs"}))
        .await;
    assert_eq!(
        res.status_code(),
        StatusCode::OK,
        "move folder failed: {:?}",
        res.text()
    );

    // Verify old folder is gone, new folder exists
    assert!(
        !vault_root.join("notes").exists(),
        "old folder should not exist"
    );
    assert!(
        vault_root.join("docs/design.md").exists(),
        "page should exist in new folder"
    );

    // Verify backlink in index.md was rewritten
    let content = fs::read_to_string(vault_root.join("index.md")).unwrap();
    assert!(
        !content.contains("[[Design Notes]]"),
        "old link should be rewritten, but found: {content}"
    );
}

// ---------------------------------------------------------------------------
// Helper: set up a test server from pre-written markdown files
// ---------------------------------------------------------------------------

/// Create a vault with pre-populated markdown files, build the index, and
/// return a test server. Each entry is `(relative_path, content)`.
fn setup_server_with_files(files: &[(&str, &str)]) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    for (path, content) in files {
        let abs = root.join(path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let index_handle = IndexHandle::spawn(index, vault.clone());

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

// ---------------------------------------------------------------------------
// Preview mutation (dry-run)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn preview_mutation_returns_plan() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000120
title: Alpha
---
Link to [[Beta]].
";
    let page_b = "\
---
id: 00000000-0000-0000-0000-000000000121
title: Beta
---
Content.
";

    let (server, _tmp) = setup_server_with_files(&[("alpha.md", page_a), ("beta.md", page_b)]);

    let body = serde_json::json!({
        "operation": "move_page",
        "source": "beta.md",
        "destination": "archive/beta.md"
    });

    let resp = server
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

// ---------------------------------------------------------------------------
// Reference intelligence: enriched unresolved endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unresolved_endpoint_includes_candidates() {
    let linker = "\
---
id: 00000000-0000-0000-0000-000000000090
title: Linker
---
See [[Ambig]].
";
    let ambig_a = "\
---
id: 00000000-0000-0000-0000-000000000091
title: Ambig
---
First.
";
    let ambig_b = "\
---
id: 00000000-0000-0000-0000-000000000092
title: Ambig
---
Second.
";

    let (server, _tmp) = setup_server_with_files(&[
        ("linker.md", linker),
        ("ambig-a.md", ambig_a),
        ("subdir/ambig-b.md", ambig_b),
    ]);

    let resp = server.get("/api/vault/index/unresolved").await;
    resp.assert_status_ok();

    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();

    let ambig_item = items
        .iter()
        .find(|item| item["target_raw"].as_str() == Some("Ambig"))
        .expect("should find unresolved link to Ambig");

    assert_eq!(ambig_item["reason"], "ambiguous");
    let candidates = ambig_item["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 2);
    assert!(
        candidates
            .iter()
            .any(|c| c["path"].as_str() == Some("ambig-a.md"))
    );
    assert!(
        candidates
            .iter()
            .any(|c| c["path"].as_str() == Some("subdir/ambig-b.md"))
    );
}

// ---------------------------------------------------------------------------
// Reference intelligence: enriched backlinks endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn backlinks_endpoint_includes_context() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000095
title: Alpha
---
First paragraph here.

This line references [[Beta]] explicitly.

Final paragraph.
";
    let page_b = "\
---
id: 00000000-0000-0000-0000-000000000096
title: Beta
---
Just content.
";

    let (server, _tmp) = setup_server_with_files(&[("alpha.md", page_a), ("beta.md", page_b)]);

    let resp = server.get("/api/vault/index/backlinks/beta.md").await;
    resp.assert_status_ok();

    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();
    assert_eq!(items.len(), 1);

    let item = &items[0];
    assert_eq!(item["source_path"], "alpha.md");
    assert!(
        item["context"].as_str().unwrap().contains("[[Beta]]"),
        "expected context to contain [[Beta]], got: {}",
        item["context"]
    );
}

// ---------------------------------------------------------------------------
// Reference intelligence: create page from unresolved link
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_from_link_creates_page_and_resolves() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000097
title: Alpha
---
See [[Nonexistent]].
";

    let (server, _tmp) = setup_server_with_files(&[("alpha.md", page_a)]);

    // Verify link is unresolved
    let resp = server.get("/api/vault/index/unresolved").await;
    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["target_raw"], "Nonexistent");

    // Create from link
    let create_body = serde_json::json!({
        "target_raw": "Nonexistent",
        "folder": ""
    });
    let resp = server
        .post("/api/vault/index/create-from-link")
        .json(&create_body)
        .await;
    resp.assert_status(StatusCode::CREATED);

    let created: serde_json::Value = resp.json();
    assert_eq!(created["meta"]["title"], "Nonexistent");
    assert!(created["path"].as_str().unwrap().ends_with(".md"));

    // Verify link is now resolved
    let resp = server.get("/api/vault/index/unresolved").await;
    let body: serde_json::Value = resp.json();
    let items = body.as_array().unwrap();
    assert!(
        items.is_empty() || !items.iter().any(|i| i["target_raw"] == "Nonexistent"),
        "link should be resolved, but found: {items:?}"
    );
}

// ---------------------------------------------------------------------------
// Unified indexing tests
// ---------------------------------------------------------------------------

/// Set up a test server with a custom config.toml written before Vault::open.
fn setup_server_with_config(config_content: &str) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    fs::write(root.join(".clepsydra/config.toml"), config_content).unwrap();
    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();
    let index_handle = IndexHandle::spawn(index, vault.clone());
    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });
    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);
    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn create_page_indexes_property_links() {
    let (server, _tmp) = setup_server_with_config("[vault]\nlinkable_properties = []\n");

    let res = server
        .post("/api/vault/pages/props.md")
        .json(&serde_json::json!({
            "title": "Property Test",
            "tags": ["concept", "rust"],
            "body": "Some body text."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // With linkable_properties disabled via config, tags must not emit
    // property_ref links.
    let res = server.get("/api/vault/index/unresolved").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    let links = body.as_array().unwrap();
    let property_links: Vec<&serde_json::Value> = links
        .iter()
        .filter(|l| l["kind"] == "property_ref")
        .collect();
    assert!(
        property_links.is_empty(),
        "expected no property_ref links when linkable_properties is empty, got {}",
        property_links.len()
    );
}

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
    assert_eq!(res.as_bytes().as_ref(), b"fake png data");
}

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
    let body: serde_json::Value = res.json();
    let pages = body["items"].as_array().unwrap();
    assert_eq!(pages.len(), 2);

    // Delete the folder recursively
    let res = server
        .delete("/api/vault/folders/notes?recursive=true")
        .await;
    res.assert_status(StatusCode::NO_CONTENT);

    // Verify index is clean — no ghost entries
    let res = server.get("/api/vault/pages").await;
    let body: serde_json::Value = res.json();
    let pages = body["items"].as_array().unwrap();
    assert_eq!(
        pages.len(),
        0,
        "deleted folder pages should be gone from index"
    );
}

#[tokio::test]
async fn create_page_resolves_links() {
    let (server, _tmp) = setup_server();
    server
        .post("/api/vault/pages/target.md")
        .json(&serde_json::json!({
            "title": "Target Page",
            "body": "I am the target."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/source.md")
        .json(&serde_json::json!({
            "title": "Source Page",
            "body": "Link to [[Target Page]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    let res = server.get("/api/vault/index/backlinks/target.md").await;
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

// ---------------------------------------------------------------------------
// Contract tests: edge cases
// ---------------------------------------------------------------------------

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
    let res = server.get("/api/vault/index/backlinks/target.md").await;
    res.assert_status(StatusCode::OK);
    let backlinks: Vec<serde_json::Value> = res.json();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0]["source_path"], "source.md");
}

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
    let body: serde_json::Value = res.json();
    let pages = body["items"].as_array().unwrap();
    let paths: Vec<&str> = pages.iter().map(|p| p["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["alpha.md", "middle.md", "zebra.md"]);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_pages_pagination() {
    let (server, _tmp) = setup_server();

    for i in 0..5 {
        server
            .post(&format!("/api/vault/pages/page-{i}.md"))
            .json(&serde_json::json!({ "title": format!("Page {i}") }))
            .await
            .assert_status(StatusCode::CREATED);
    }

    // Default returns all
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

    // With limit=2, offset=3
    let res = server.get("/api/vault/pages?limit=2&offset=3").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 2);

    // With offset past end
    let res = server.get("/api/vault/pages?limit=2&offset=10").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 5);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// SSE events endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sse_events_endpoint_returns_stream() {
    use axum::body::Body;
    use axum::http::Request;
    use std::time::Duration;
    use tower::ServiceExt;

    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    clepsydra::vault::init::init_vault(&root).unwrap();

    let vault = clepsydra::vault::Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let index_handle = IndexHandle::spawn(index, vault.clone());

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let request = Request::builder()
        .uri("/api/vault/events")
        .body(Body::empty())
        .unwrap();

    // SSE streams never complete, so use a timeout for the initial response
    let response = tokio::time::timeout(Duration::from_secs(2), app.oneshot(request))
        .await
        .expect("SSE response timed out")
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get("content-type")
        .expect("missing content-type header")
        .to_str()
        .unwrap();
    assert!(
        content_type.contains("text/event-stream"),
        "expected text/event-stream, got: {content_type}"
    );
}

// ---------------------------------------------------------------------------
// Graph endpoint test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn graph_returns_nodes_and_edges() {
    let (server, _tmp) = setup_server();

    // Create two pages that link to each other
    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({
            "title": "Alpha",
            "body": "Link to [[Beta]]"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/beta.md")
        .json(&serde_json::json!({
            "title": "Beta",
            "body": "Link to [[Alpha]]"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild to ensure links are resolved
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let response = server.get("/api/vault/index/graph").await;
    response.assert_status_ok();

    let body: serde_json::Value = response.json();
    let nodes = body["nodes"].as_array().unwrap();
    let edges = body["edges"].as_array().unwrap();
    assert!(
        nodes.len() >= 2,
        "expected at least 2 nodes, got {}",
        nodes.len()
    );
    assert!(!edges.is_empty(), "expected at least 1 edge");

    // Verify node structure
    let node = &nodes[0];
    assert!(node.get("id").is_some());
    assert!(node.get("path").is_some());
    assert!(node.get("title").is_some());

    // Verify edge structure
    let edge = &edges[0];
    assert!(edge.get("source").is_some());
    assert!(edge.get("target").is_some());
    assert!(edge.get("kind").is_some());
}

// ---------------------------------------------------------------------------
// SyncNotification serialization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sync_notification_serializes_to_json() {
    use clepsydra::api::events::SyncNotification;

    let notif = SyncNotification::IndexChanged {
        upserted: vec!["notes/foo.md".to_string()],
        removed: vec!["archive/old.md".to_string()],
    };
    let json = serde_json::to_string(&notif).unwrap();
    assert!(json.contains("index_changed"));
    assert!(json.contains("notes/foo.md"));
    assert!(json.contains("archive/old.md"));
}

// ---------------------------------------------------------------------------
// Mutation handlers emit SyncNotification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_page_emits_sync_notification() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    clepsydra::vault::init::init_vault(&root).unwrap();

    let vault = clepsydra::vault::Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let cas_path = tmp.path().join("cas");
    let cas = ContentStore::open(&cas_path).unwrap();

    let index_handle = IndexHandle::spawn(index, vault.clone());

    let (change_tx, _) = broadcast::channel(64);
    let mut rx = change_tx.subscribe();
    let state = Arc::new(AppState {
        started_at: std::time::Instant::now(),
        vault,
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let test_server = TestServer::new(app).unwrap();

    test_server
        .post("/api/vault/pages/test-notify.md")
        .json(&serde_json::json!({
            "title": "Notify Test",
            "body": "content"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Should have received a notification
    let notification = rx.try_recv().expect("expected sync notification");
    match notification {
        clepsydra::api::events::SyncNotification::IndexChanged { upserted, .. } => {
            assert!(upserted.contains(&"test-notify.md".to_string()));
        }
    }
}

// ---------------------------------------------------------------------------
// Content index endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn content_index_returns_page_details() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/indexed.md")
        .json(&serde_json::json!({
            "title": "Indexed Page",
            "tags": ["rust", "test"],
            "body": "This is the body content for indexing."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // Rebuild to ensure tags are indexed
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let response = server.get("/api/vault/index/content-index").await;
    response.assert_status_ok();

    let body: serde_json::Value = response.json();
    let items = body["items"].as_array().unwrap();
    assert!(!items.is_empty(), "expected at least one entry");

    let entry = items
        .iter()
        .find(|e| e["path"] == "indexed.md")
        .expect("expected to find indexed.md in content index");
    assert_eq!(entry["title"], "Indexed Page");
    let tags = entry["tags"].as_array().unwrap();
    assert!(tags.contains(&serde_json::json!("rust")));
    assert!(tags.contains(&serde_json::json!("test")));
    assert!(
        entry["description"]
            .as_str()
            .unwrap()
            .contains("body content")
    );
}

#[tokio::test]
async fn content_index_groups_tags_and_links_per_page() {
    // Multiple pages with distinct tags and a wikilink graph. The handler must
    // attribute each tag and outbound link to the correct source page; a
    // misgrouped bulk-query refactor would corrupt these per-entry sets.
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/page-a.md")
        .json(&serde_json::json!({
            "title": "Page A",
            "tags": ["alpha", "shared"],
            "body": "Links to [[Page B]] and [[Page C]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/page-b.md")
        .json(&serde_json::json!({
            "title": "Page B",
            "tags": ["beta"],
            "body": "Mentions [[Page C]]."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/pages/page-c.md")
        .json(&serde_json::json!({
            "title": "Page C",
            "tags": ["gamma", "shared"],
            "body": "Has no outbound links."
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/content-index").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().unwrap();

    let by_path: std::collections::HashMap<&str, &serde_json::Value> = items
        .iter()
        .filter_map(|e| e["path"].as_str().map(|p| (p, e)))
        .collect();

    let tags_of = |p: &str| -> Vec<String> {
        by_path.get(p).unwrap_or_else(|| panic!("missing {p}"))["tags"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect()
    };
    let mut a_tags = tags_of("page-a.md");
    a_tags.sort();
    assert_eq!(a_tags, vec!["alpha".to_string(), "shared".to_string()]);
    assert_eq!(tags_of("page-b.md"), vec!["beta".to_string()]);
    let mut c_tags = tags_of("page-c.md");
    c_tags.sort();
    assert_eq!(c_tags, vec!["gamma".to_string(), "shared".to_string()]);

    let links_of = |p: &str| -> Vec<String> {
        by_path[p]["links"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.as_str().map(String::from))
            .collect()
    };
    assert!(
        !links_of("page-a.md").is_empty(),
        "page-a has outbound links"
    );
    assert!(
        !links_of("page-b.md").is_empty(),
        "page-b has outbound links"
    );
    assert!(
        links_of("page-c.md").is_empty(),
        "page-c has no outbound links"
    );
}

// ---------------------------------------------------------------------------
// delete_folder re-resolves affected links
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_blocked_by_unresolved_backlinks() {
    // Set up pages so that [[Target]] is ambiguous (unresolved)
    let target_a = "\
---
id: 00000000-0000-0000-0000-000000000180
title: Target
---
I am the target.
";
    let target_b = "\
---
id: 00000000-0000-0000-0000-000000000181
title: Target
---
I am the duplicate.
";
    let source = "\
---
id: 00000000-0000-0000-0000-000000000182
title: Source
---
See [[Target]].
";

    let (server, _tmp) = setup_server_with_files(&[
        ("target.md", target_a),
        ("sub/target.md", target_b),
        ("source.md", source),
    ]);

    // Try to delete target.md without force — should be blocked
    // even though the link is unresolved (target_id is NULL due to ambiguity)
    let res = server.delete("/api/vault/pages/target.md").await;
    res.assert_status(StatusCode::CONFLICT);
}

#[tokio::test]
async fn delete_folder_re_resolves_affected_links() {
    // Use setup_server_with_files so all pages exist when the index is built
    // in a single pass. This ensures the ambiguity is properly detected
    // (both "Shared" pages exist when resolve_links() runs).
    let main_page = "\
---
id: 00000000-0000-0000-0000-000000000200
title: Main
---
See [[Shared]].
";
    let shared_outside = "\
---
id: 00000000-0000-0000-0000-000000000201
title: Shared
---
I am the real Shared.
";
    let shared_in_folder = "\
---
id: 00000000-0000-0000-0000-000000000202
title: Shared
---
I am the duplicate Shared.
";

    let (server, _tmp) = setup_server_with_files(&[
        ("main.md", main_page),
        ("shared.md", shared_outside),
        ("dups/shared.md", shared_in_folder),
    ]);

    // At this point [[Shared]] is ambiguous (2 candidates), so the link is unresolved
    let res = server.get("/api/vault/index/unresolved").await;
    let unresolved: Vec<serde_json::Value> = res.json();
    let shared_unresolved = unresolved.iter().any(|u| u["target_raw"] == "Shared");
    assert!(
        shared_unresolved,
        "[[Shared]] should be unresolved due to ambiguity"
    );

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

// ---------------------------------------------------------------------------
// Academic API: BibTeX import
// ---------------------------------------------------------------------------

#[tokio::test]
async fn import_bibtex_creates_works() {
    let (server, _tmp) = setup_server();

    let bibtex = r#"
@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  journal = {NeurIPS},
  year = {2017},
  doi = {10.48550/arXiv.1706.03762}
}
@book{bishop2006pattern,
  title = {Pattern Recognition and Machine Learning},
  author = {Bishop, Christopher M.},
  year = {2006},
  publisher = {Springer},
  isbn = {978-0-387-31073-2}
}
"#;

    let response = server
        .post("/api/vault/academic/import/bibtex")
        .text(bibtex)
        .await;
    response.assert_status(StatusCode::OK);

    let body: serde_json::Value = response.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "created");
    assert_eq!(results[0]["cite_key"], "vaswani2017attention");
    assert_eq!(results[1]["status"], "created");
    assert_eq!(results[1]["cite_key"], "bishop2006pattern");

    // Verify works exist via list endpoint
    let list = server.get("/api/vault/academic/works").await;
    let body: serde_json::Value = list.json();
    let works = body["items"].as_array().unwrap();
    assert_eq!(works.len(), 2);
}

#[tokio::test]
async fn import_bibtex_skips_duplicates() {
    let (server, _tmp) = setup_server();

    let bibtex = r#"
@article{test2024,
  title = {Test Paper},
  author = {Test, Author},
  year = {2024}
}
"#;

    // First import
    let r1 = server
        .post("/api/vault/academic/import/bibtex")
        .text(bibtex)
        .await;
    r1.assert_status(StatusCode::OK);
    let body1: serde_json::Value = r1.json();
    assert_eq!(body1["results"][0]["status"], "created");

    // Second import — same cite_key -> skipped
    let r2 = server
        .post("/api/vault/academic/import/bibtex")
        .text(bibtex)
        .await;
    r2.assert_status(StatusCode::OK);
    let body2: serde_json::Value = r2.json();
    assert_eq!(body2["results"][0]["status"], "skipped");
}

#[tokio::test]
async fn import_bibtex_invalid_returns_400() {
    let (server, _tmp) = setup_server();

    let response = server
        .post("/api/vault/academic/import/bibtex")
        .text("@article{broken, title = {missing closing")
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// Academic API: create work
// ---------------------------------------------------------------------------

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
    // Should be in the papers folder
    assert!(
        body["path"]
            .as_str()
            .unwrap()
            .starts_with("library/papers/"),
        "expected path in library/papers/, got: {}",
        body["path"]
    );
}

#[tokio::test]
async fn create_work_book_goes_to_books_folder() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "book",
            "title": "The Art of Computer Programming"
        }))
        .await;

    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    assert!(
        body["path"].as_str().unwrap().starts_with("library/books/"),
        "expected path in library/books/, got: {}",
        body["path"]
    );
}

#[tokio::test]
async fn create_work_invalid_rating_returns_422() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Bad Rating",
            "rating": 6
        }))
        .await;

    assert_eq!(res.status_code(), StatusCode::UNPROCESSABLE_ENTITY);
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

// ---------------------------------------------------------------------------
// Academic API: list and get works
// ---------------------------------------------------------------------------

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
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);

    // Filter by work_type=paper
    let res = server
        .get("/api/vault/academic/works?work_type=paper")
        .await;
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["title"], "ML Paper");

    // Filter by year=2020
    let res = server.get("/api/vault/academic/works?year=2020").await;
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);

    // Filter by status=done
    let res = server.get("/api/vault/academic/works?status=done").await;
    let body: serde_json::Value = res.json();
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["title"], "ML Book");
}

#[tokio::test]
async fn get_work_by_uuid() {
    let (server, _tmp) = setup_server();

    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Get Test Paper",
            "authors": ["Alice"],
            "year": 2021
        }))
        .await;
    res.assert_status(StatusCode::CREATED);
    let created: serde_json::Value = res.json();
    let uuid = created["id"].as_str().unwrap();

    let res = server
        .get(&format!("/api/vault/academic/works/by-id/{uuid}"))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["title"], "Get Test Paper");
    assert_eq!(body["work_type"], "paper");
    assert_eq!(body["year"], 2021);
}

// ---------------------------------------------------------------------------
// Academic API: update work
// ---------------------------------------------------------------------------

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
        .json(&serde_json::json!({ "status": "reading", "rating": 4 }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["status"], "reading");
    assert_eq!(body["rating"], 4);
    assert_eq!(body["title"], "Update Test");
}

#[tokio::test]
async fn update_work_duplicate_cite_key_returns_409() {
    let (server, _tmp) = setup_server();

    let first = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "First",
            "cite_key": "duplicate-key"
        }))
        .await;
    first.assert_status(StatusCode::CREATED);

    let second = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Second",
            "cite_key": "second-key"
        }))
        .await;
    second.assert_status(StatusCode::CREATED);
    let second_body: serde_json::Value = second.json();
    let second_id = second_body["id"].as_str().unwrap();

    let res = server
        .put(&format!("/api/vault/academic/works/by-id/{second_id}"))
        .json(&serde_json::json!({ "cite_key": "duplicate-key" }))
        .await;

    res.assert_status(StatusCode::CONFLICT);
}

// ---------------------------------------------------------------------------
// Academic API: annotations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_and_list_annotations() {
    let (server, _tmp) = setup_server();

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

    let res = server
        .get(&format!(
            "/api/vault/academic/works/by-id/{work_id}/annotations"
        ))
        .await;
    res.assert_status_ok();
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["annotation_type"], "highlight");
}

#[tokio::test]
async fn move_folder_updates_annotation_work_paths_for_moved_works() {
    let (server, _tmp) = setup_server();

    let work_a = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Paper A"
        }))
        .await;
    work_a.assert_status(StatusCode::CREATED);
    let work_a_body: serde_json::Value = work_a.json();
    let work_a_id = work_a_body["id"].as_str().unwrap().to_string();

    let work_b = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Paper B"
        }))
        .await;
    work_b.assert_status(StatusCode::CREATED);
    let work_b_body: serde_json::Value = work_b.json();
    let work_b_id = work_b_body["id"].as_str().unwrap().to_string();

    server
        .post("/api/vault/academic/annotations")
        .json(&serde_json::json!({
            "work_id": work_a_id.clone(),
            "annotation_type": "highlight",
            "body": "A"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/academic/annotations")
        .json(&serde_json::json!({
            "work_id": work_b_id.clone(),
            "annotation_type": "note",
            "body": "B"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/folders-move/library/papers")
        .json(&serde_json::json!({ "destination": "archive/papers" }))
        .await
        .assert_status(StatusCode::OK);

    let ann_a = server
        .get(&format!(
            "/api/vault/academic/works/by-id/{work_a_id}/annotations"
        ))
        .await;
    ann_a.assert_status(StatusCode::OK);
    let ann_a_body: Vec<serde_json::Value> = ann_a.json();
    assert_eq!(ann_a_body.len(), 1);
    assert!(
        ann_a_body[0]["work_path"]
            .as_str()
            .unwrap()
            .starts_with("archive/papers/"),
        "expected updated work_path for annotation A, got: {:?}",
        ann_a_body[0]["work_path"]
    );

    let ann_b = server
        .get(&format!(
            "/api/vault/academic/works/by-id/{work_b_id}/annotations"
        ))
        .await;
    ann_b.assert_status(StatusCode::OK);
    let ann_b_body: Vec<serde_json::Value> = ann_b.json();
    assert_eq!(ann_b_body.len(), 1);
    assert!(
        ann_b_body[0]["work_path"]
            .as_str()
            .unwrap()
            .starts_with("archive/papers/"),
        "expected updated work_path for annotation B, got: {:?}",
        ann_b_body[0]["work_path"]
    );
}

// ---------------------------------------------------------------------------
// Academic library: full lifecycle integration test
// ---------------------------------------------------------------------------

#[tokio::test]
async fn academic_lifecycle_integration() {
    let (server, _tmp) = setup_server();

    // 1. Create a paper with cite_key
    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "work_type": "paper",
            "title": "Attention Is All You Need",
            "authors": ["Vaswani", "Shazeer", "Parmar"],
            "year": 2017,
            "venue": "NeurIPS",
            "cite_key": "vaswani2017attention",
            "status": "unread",
            "tags": ["transformers", "nlp"],
            "body": "The dominant sequence transduction models..."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);
    let work: serde_json::Value = res.json();
    let work_id = work["id"].as_str().unwrap().to_string();
    let work_path = work["path"].as_str().unwrap().to_string();
    assert_eq!(work["title"], "Attention Is All You Need");
    assert_eq!(work["work_type"], "paper");
    assert_eq!(work["cite_key"], "vaswani2017attention");
    assert!(work_path.starts_with("library/papers/"));

    // 2. Create a regular page that references the work via [[cite_key]]
    server
        .post("/api/vault/pages/notes/ml-notes.md")
        .json(&serde_json::json!({
            "title": "ML Notes",
            "body": "Key paper: [[vaswani2017attention]]"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    // 3. Rebuild index to ensure all links are resolved
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    // 4. Verify cite_key resolves — check backlinks for the work
    let res = server
        .get(&format!("/api/vault/index/backlinks/{work_path}"))
        .await;
    res.assert_status_ok();
    let backlinks: Vec<serde_json::Value> = res.json();
    assert!(
        backlinks
            .iter()
            .any(|b| b["source_path"] == "notes/ml-notes.md"),
        "expected backlink from ml-notes.md via cite_key, got: {backlinks:?}"
    );

    // 5. Create an annotation on the paper
    let res = server
        .post("/api/vault/academic/annotations")
        .json(&serde_json::json!({
            "work_id": work_id,
            "annotation_type": "highlight",
            "source_location": {"page": 4, "quote": "self-attention mechanism"},
            "tags": ["key-concept"],
            "body": "The self-attention mechanism is the core innovation."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);
    let ann: serde_json::Value = res.json();
    assert_eq!(ann["work_id"], work_id);
    assert_eq!(ann["annotation_type"], "highlight");

    // 6. List annotations for the work — verify 1 result
    let res = server
        .get(&format!(
            "/api/vault/academic/works/by-id/{work_id}/annotations"
        ))
        .await;
    res.assert_status_ok();
    let annotations: Vec<serde_json::Value> = res.json();
    assert_eq!(annotations.len(), 1);
    assert_eq!(annotations[0]["annotation_type"], "highlight");

    // 7. Update work status to "reading" and add a rating
    let res = server
        .put(&format!("/api/vault/academic/works/by-id/{work_id}"))
        .json(&serde_json::json!({
            "status": "reading",
            "rating": 5
        }))
        .await;
    res.assert_status_ok();
    let updated: serde_json::Value = res.json();
    assert_eq!(updated["status"], "reading");
    assert_eq!(updated["rating"], 5);
    // Title and cite_key should be unchanged
    assert_eq!(updated["title"], "Attention Is All You Need");
    assert_eq!(updated["cite_key"], "vaswani2017attention");

    // 8. Get work by UUID — verify all fields
    let res = server
        .get(&format!("/api/vault/academic/works/by-id/{work_id}"))
        .await;
    res.assert_status_ok();
    let fetched: serde_json::Value = res.json();
    assert_eq!(fetched["title"], "Attention Is All You Need");
    assert_eq!(fetched["work_type"], "paper");
    assert_eq!(fetched["status"], "reading");
    assert_eq!(fetched["rating"], 5);
    assert_eq!(fetched["year"], 2017);
    assert_eq!(fetched["venue"], "NeurIPS");
    assert_eq!(fetched["cite_key"], "vaswani2017attention");

    // 9. List all works — verify 1 work
    let res = server.get("/api/vault/academic/works").await;
    res.assert_status_ok();
    let works_body: serde_json::Value = res.json();
    let works = works_body["items"].as_array().unwrap();
    assert_eq!(works.len(), 1);
    assert_eq!(works[0]["title"], "Attention Is All You Need");

    // 10. Verify cite_key still resolves after update
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server
        .get(&format!("/api/vault/index/backlinks/{work_path}"))
        .await;
    res.assert_status_ok();
    let backlinks: Vec<serde_json::Value> = res.json();
    assert!(
        backlinks
            .iter()
            .any(|b| b["source_path"] == "notes/ml-notes.md"),
        "cite_key should still resolve after update, backlinks: {backlinks:?}"
    );
}

// ---------------------------------------------------------------------------
// Import lifecycle: BibTeX dedup and verification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn import_lifecycle_bibtex_dedup_and_verify() {
    let (server, _tmp) = setup_server();

    // 1. Import two entries via BibTeX
    let bibtex = r#"
@article{alpha2020first,
  title = {First Paper},
  author = {Alpha, Ann},
  year = {2020},
  journal = {Journal A},
  doi = {10.1234/first}
}
@book{beta2021second,
  title = {Second Book},
  author = {Beta, Bob},
  year = {2021},
  publisher = {Publisher B},
  isbn = {978-1-234-56789-0}
}
"#;

    let r = server
        .post("/api/vault/academic/import/bibtex")
        .text(bibtex)
        .await;
    r.assert_status(StatusCode::OK);
    let body: serde_json::Value = r.json();
    assert_eq!(body["results"][0]["status"], "created");
    assert_eq!(body["results"][1]["status"], "created");

    // 2. Re-import same BibTeX — both should be skipped (cite_key dedup)
    let r2 = server
        .post("/api/vault/academic/import/bibtex")
        .text(bibtex)
        .await;
    r2.assert_status(StatusCode::OK);
    let body2: serde_json::Value = r2.json();
    assert_eq!(body2["results"][0]["status"], "skipped");
    assert_eq!(body2["results"][1]["status"], "skipped");

    // 3. Import different entry with same DOI — should be skipped (DOI dedup)
    let bibtex_dup_doi = r#"
@article{different_key,
  title = {Different Title},
  author = {Gamma, Charlie},
  year = {2020},
  doi = {10.1234/first}
}
"#;
    let r3 = server
        .post("/api/vault/academic/import/bibtex")
        .text(bibtex_dup_doi)
        .await;
    r3.assert_status(StatusCode::OK);
    let body3: serde_json::Value = r3.json();
    assert_eq!(
        body3["results"][0]["status"], "skipped",
        "DOI dedup should skip entry with matching DOI regardless of cite_key"
    );

    // 4. Verify works list shows exactly 2
    let list = server.get("/api/vault/academic/works").await;
    let list_body: serde_json::Value = list.json();
    let works = list_body["items"].as_array().unwrap();
    assert_eq!(works.len(), 2, "expected exactly 2 works after dedup");

    // 5. Verify metadata on the paper
    let paper = works
        .iter()
        .find(|w| w["cite_key"] == "alpha2020first")
        .unwrap();
    assert_eq!(paper["work_type"], "paper");
    assert_eq!(paper["year"], 2020);

    // 6. Verify metadata on the book
    let book = works
        .iter()
        .find(|w| w["cite_key"] == "beta2021second")
        .unwrap();
    assert_eq!(book["work_type"], "book");
    assert_eq!(book["year"], 2021);
}

// ---------------------------------------------------------------------------
// Attachment upload tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_and_retrieve_attachment() {
    let (server, _tmp) = setup_server();

    let boundary = "----testboundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nhello world\r\n--{boundary}--\r\n"
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
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dup.txt\"\r\nContent-Type: text/plain\r\n\r\nfirst\r\n--{boundary}--\r\n"
    );
    let ct = format!("multipart/form-data; boundary={boundary}");

    server
        .post("/api/vault/attachments/dup.txt")
        .content_type(&ct)
        .bytes(body.clone().into_bytes().into())
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/attachments/dup.txt")
        .content_type(&ct)
        .bytes(body.into_bytes().into())
        .await
        .assert_status(StatusCode::CONFLICT);
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_pages() {
    let (server, _tmp) = setup_server();

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

    // Rebuild index to populate FTS
    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    // Search for "safety"
    let res = server.get("/api/vault/index/search?q=safety").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    let results = body.as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["path"], "rust.md");

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

// ---------------------------------------------------------------------------
// Pagination: works and content-index
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_works_pagination() {
    let (server, _tmp) = setup_server();

    for i in 0..3 {
        server
            .post("/api/vault/academic/works")
            .json(&serde_json::json!({
                "title": format!("Work {i}"),
                "work_type": "paper",
                "authors": [format!("Author {i}")],
            }))
            .await
            .assert_status(StatusCode::CREATED);
    }

    let res = server.get("/api/vault/academic/works").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["items"].as_array().unwrap().len(), 3);

    let res = server.get("/api/vault/academic/works?limit=1").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 3);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn content_index_pagination() {
    let (server, _tmp) = setup_server();

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

#[tokio::test]
async fn content_index_includes_word_count() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({
            "title": "Alpha",
            "body": "the quick brown fox jumps"
        }))
        .await
        .assert_status(StatusCode::CREATED);

    server
        .post("/api/vault/index/rebuild")
        .await
        .assert_status_ok();

    let res = server.get("/api/vault/index/content-index").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let alpha = body["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["path"] == "alpha.md"))
        .expect("alpha entry");
    assert_eq!(
        alpha["word_count"], 5,
        "expected 5 words for body 'the quick brown fox jumps'; got {alpha:?}"
    );
}

// ---------------------------------------------------------------------------
// Zotero import tests
// ---------------------------------------------------------------------------

/// Create a minimal Zotero-schema SQLite DB for API testing.
fn create_mock_zotero_db_for_api(path: &std::path::Path) {
    use rusqlite::Connection;
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "
        CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        INSERT INTO itemTypes VALUES (1, 'attachment');
        INSERT INTO itemTypes VALUES (2, 'book');
        INSERT INTO itemTypes VALUES (4, 'journalArticle');

        CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
        INSERT INTO fields VALUES (14, 'date');
        INSERT INTO fields VALUES (26, 'DOI');
        INSERT INTO fields VALUES (110, 'title');
        INSERT INTO fields VALUES (11, 'ISBN');
        INSERT INTO fields VALUES (12, 'publisher');
        INSERT INTO fields VALUES (37, 'publicationTitle');

        CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
        INSERT INTO libraries VALUES (1, 'user');

        CREATE TABLE items (
            itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT,
            dateModified TEXT, clientDateModified TEXT, libraryID INT,
            key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0
        );
        CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID));
        CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT UNIQUE);
        CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);

        CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
        CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
        INSERT INTO creatorTypes VALUES (1, 'author');
        CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);

        CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
        CREATE TABLE itemTags (itemID INT, tagID INT, type INT);

        CREATE TABLE collections (
            collectionID INTEGER PRIMARY KEY, collectionName TEXT,
            parentCollectionID INT, libraryID INT, key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0,
            clientDateModified TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);

        CREATE TABLE itemAttachments (
            itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT,
            contentType TEXT, charsetID INT, path TEXT,
            syncState INT DEFAULT 0, storageModTime INT, storageHash TEXT
        );

        -- Insert a journal article
        INSERT INTO items VALUES (1, 4, '2024-01-01', '2024-06-15', '2024-06-15', 1, 'ABC12345', 1, 0);
        INSERT INTO itemDataValues VALUES (1, 'Test Article');
        INSERT INTO itemDataValues VALUES (2, '2023');
        INSERT INTO itemDataValues VALUES (3, '10.1234/test.article');
        INSERT INTO itemDataValues VALUES (4, 'Test Journal');
        INSERT INTO itemData VALUES (1, 110, 1);
        INSERT INTO itemData VALUES (1, 14, 2);
        INSERT INTO itemData VALUES (1, 26, 3);
        INSERT INTO itemData VALUES (1, 37, 4);

        INSERT INTO creators VALUES (1, 'Alice', 'Smith', 0);
        INSERT INTO itemCreators VALUES (1, 1, 1, 0);

        -- Insert a book
        INSERT INTO items VALUES (2, 2, '2024-01-01', '2024-03-01', '2024-03-01', 1, 'DEF67890', 1, 0);
        INSERT INTO itemDataValues VALUES (5, 'Test Book');
        INSERT INTO itemDataValues VALUES (6, '2022');
        INSERT INTO itemDataValues VALUES (7, '978-1234567890');
        INSERT INTO itemDataValues VALUES (8, 'Test Publisher');
        INSERT INTO itemData VALUES (2, 110, 5);
        INSERT INTO itemData VALUES (2, 14, 6);
        INSERT INTO itemData VALUES (2, 11, 7);
        INSERT INTO itemData VALUES (2, 12, 8);

        INSERT INTO creators VALUES (2, 'Bob', 'Jones', 0);
        INSERT INTO itemCreators VALUES (2, 2, 1, 0);
        "
    ).unwrap();
}

#[tokio::test]
async fn import_zotero_creates_works() {
    let (server, tmp) = setup_server();

    // Create mock Zotero DB
    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // Import
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy()
        }))
        .await;

    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "should import 2 items");

    // Verify both were created
    assert!(results.iter().all(|r| r["status"] == "created"));
    assert_eq!(results[0]["cite_key"], "smith2023test");
    assert_eq!(results[1]["cite_key"], "jones2022test");

    // Verify provenance in frontmatter
    let vault_root = tmp.path().join("vault");
    let article_path = results[0]["page_path"].as_str().unwrap();
    let content = fs::read_to_string(vault_root.join(article_path)).unwrap();
    assert!(
        content.contains("source: zotero"),
        "should have import source"
    );
    assert!(
        content.contains("zotero_key: ABC12345"),
        "should have zotero_key"
    );
    assert!(
        content.contains("zotero_item_id: 1"),
        "should have zotero_item_id"
    );
}

#[tokio::test]
async fn import_zotero_dry_run() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "dry_run": true
        }))
        .await;

    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);

    // Verify all would be created
    assert!(results.iter().all(|r| r["status"] == "would_create"));

    // Verify no works were actually created
    let res = server.get("/api/vault/academic/works").await;
    let body: serde_json::Value = res.json();
    assert_eq!(body["total"], 0, "dry run should not create works");
}

#[tokio::test]
async fn import_zotero_is_idempotent() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // First import (disable checkpoint so second import sees all items)
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert!(results.iter().all(|r| r["status"] == "created"));

    // Second import — should skip all (dedup by zotero_key)
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert!(
        results.iter().all(|r| r["status"] == "skipped"),
        "second import should skip all items"
    );
}

#[tokio::test]
async fn import_zotero_source_wins_updates() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // First import — creates works
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let first_results = body["results"].as_array().unwrap();
    assert!(first_results.iter().all(|r| r["status"] == "created"));

    // Second import with source_wins — should update (live, not dry_run)
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false,
            "conflict_policy": "source_wins"
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "should have results for both items");
    assert!(
        results.iter().all(|r| r["status"] == "updated"),
        "source_wins live mode should produce 'updated' status; got: {:?}",
        results.iter().map(|r| &r["status"]).collect::<Vec<_>>()
    );

    // Page paths should still be populated
    for r in results {
        assert!(
            r["page_path"].is_string(),
            "page_path should be set for updated items"
        );
    }
}

#[tokio::test]
async fn import_zotero_source_wins_dry_run_would_update() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // First import — creates works
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    res.assert_status_ok();

    // Second import dry_run + source_wins — should report would_update
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false,
            "dry_run": true,
            "conflict_policy": "source_wins"
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert!(
        results.iter().all(|r| r["status"] == "would_update"),
        "dry_run source_wins should produce 'would_update'"
    );
}

#[tokio::test]
async fn import_zotero_manual_reports_skipped_when_no_diffs() {
    // The mock DB items are imported, then re-imported with manual policy.
    // Because the data is identical (same mock DB), the second import should
    // report "skipped" (no diffs between source and local).
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // First import
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(
        body["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "created")
    );

    // Second import with manual policy — no changes in source, so expect "skipped"
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false,
            "conflict_policy": "manual"
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    // Identical source data ⇒ no diffs ⇒ manual policy skips silently.
    for r in results {
        assert_eq!(
            r["status"].as_str().unwrap(),
            "skipped",
            "manual policy with no diffs should produce 'skipped'"
        );
    }
}

/// Create a Zotero mock DB with only the journal article (has DOI), and also
/// pre-create the matching work via the API so that the zotero_key path is NOT
/// set (no import provenance). The subsequent Zotero import must go through the
/// DOI/cite_key dedup path (handle_doi_existing).
#[tokio::test]
async fn import_zotero_doi_path_skip() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // Pre-create the article via the works API (no Zotero provenance).
    // The mock article has DOI "10.1234/test.article".
    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "title": "Test Article",
            "work_type": "paper",
            "authors": ["Alice Smith"],
            "year": 2023,
            "venue": "Test Journal",
            "external_ids": { "doi": "10.1234/test.article" }
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // Now import from Zotero — the article should be matched by DOI (not zotero_key)
    // and skipped (default policy = skip).
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();

    // The article (DOI match) should be skipped; the book (no DOI pre-existing) created.
    let article = results.iter().find(|r| {
        r["cite_key"]
            .as_str()
            .map(|k| k.contains("smith") || k.contains("2023"))
            .unwrap_or(false)
    });
    assert!(article.is_some(), "should find article result");
    assert_eq!(
        article.unwrap()["status"],
        "skipped",
        "DOI-matched article should be skipped"
    );
}

#[tokio::test]
async fn import_zotero_doi_path_source_wins() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // Pre-create the article via the works API (no Zotero provenance).
    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "title": "Test Article Old Title",
            "work_type": "paper",
            "authors": ["Alice Smith"],
            "year": 2023,
            "external_ids": { "doi": "10.1234/test.article" }
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // Import with source_wins — the article should be updated via DOI path.
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false,
            "conflict_policy": "source_wins"
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();

    // The article should be updated; the book should be created (new).
    let article = results.iter().find(|r| {
        r["status"].as_str() == Some("updated") || r["status"].as_str() == Some("created")
    });
    assert!(
        article.is_some(),
        "should have at least one updated or created result"
    );

    // Verify that the article was updated (source_wins live mode).
    let updated = results.iter().filter(|r| r["status"] == "updated").count();
    assert!(
        updated >= 1,
        "at least the DOI-matched article should be 'updated'"
    );
}

#[tokio::test]
async fn import_zotero_doi_path_manual() {
    let (server, tmp) = setup_server();

    let zotero_db_path = tmp.path().join("zotero.sqlite");
    create_mock_zotero_db_for_api(&zotero_db_path);

    // Pre-create the article with identical content (no diffs expected).
    let res = server
        .post("/api/vault/academic/works")
        .json(&serde_json::json!({
            "title": "Test Article",
            "work_type": "paper",
            "authors": ["Alice Smith"],
            "year": 2023,
            "venue": "Test Journal",
            "external_ids": { "doi": "10.1234/test.article" }
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // Import with manual policy — should report skipped or conflict for article.
    let res = server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": zotero_db_path.to_string_lossy(),
            "auto_checkpoint": false,
            "conflict_policy": "manual"
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body["results"].as_array().unwrap();

    // Find the article result — it should be skipped or conflict from DOI path.
    let doi_result = results.iter().find(|r| {
        let ck = r["cite_key"].as_str().unwrap_or("");
        ck.contains("smith") || ck.contains("2023")
    });
    assert!(doi_result.is_some(), "should find article result");
    let status = doi_result.unwrap()["status"].as_str().unwrap();
    assert_eq!(
        status, "skipped",
        "manual policy on DOI path with matching fields should yield 'skipped'"
    );
}
