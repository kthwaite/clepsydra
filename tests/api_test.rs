use std::fs;
use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum_test::TestServer;
use tokio::sync::broadcast;

use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

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

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: vec![],
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
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
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 2);
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
    server.post("/api/vault/index/rebuild").await.assert_status_ok();

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
    server.post("/api/vault/index/rebuild").await.assert_status_ok();

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

    server.post("/api/vault/index/rebuild").await.assert_status_ok();

    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();

    assert_eq!(body["pages"], 2);
    assert!(body["links_total"].as_i64().unwrap() >= 1);
    assert_eq!(body["tags"], 2); // t1 and t2
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

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: vec![],
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

    let (server, _tmp) =
        setup_server_with_files(&[("alpha.md", page_a), ("beta.md", page_b)]);

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
    assert!(candidates.iter().any(|c| c["path"].as_str() == Some("ambig-a.md")));
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
    fs::write(root.join("config.toml"), config_content).unwrap();
    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: vec![],
    });
    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);
    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn create_page_indexes_property_links() {
    let (server, _tmp) = setup_server_with_config(
        "[vault]\nlinkable_properties = [\"tags\"]\n",
    );

    let res = server
        .post("/api/vault/pages/props.md")
        .json(&serde_json::json!({
            "title": "Property Test",
            "tags": ["concept", "rust"],
            "body": "Some body text."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // The unresolved endpoint will show property_ref links since "concept"
    // and "rust" won't resolve to any page
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
    let res = server
        .get("/api/vault/index/backlinks/target.md")
        .await;
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
    let pages: Vec<serde_json::Value> = res.json();
    let paths: Vec<&str> = pages.iter().map(|p| p["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["alpha.md", "middle.md", "zebra.md"]);
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

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: vec![],
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

    let (change_tx, _) = broadcast::channel(64);
    let mut rx = change_tx.subscribe();
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: vec![],
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

    let body: Vec<serde_json::Value> = response.json();
    assert!(!body.is_empty(), "expected at least one entry");

    let entry = body
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
        body["path"].as_str().unwrap().starts_with("library/papers/"),
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
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 2);

    // Filter by work_type=paper
    let res = server
        .get("/api/vault/academic/works?work_type=paper")
        .await;
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["title"], "ML Paper");

    // Filter by year=2020
    let res = server
        .get("/api/vault/academic/works?year=2020")
        .await;
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);

    // Filter by status=done
    let res = server
        .get("/api/vault/academic/works?status=done")
        .await;
    let body: Vec<serde_json::Value> = res.json();
    assert_eq!(body.len(), 1);
    assert_eq!(body[0]["title"], "ML Book");
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
        backlinks.iter().any(|b| b["source_path"] == "notes/ml-notes.md"),
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
        .get(&format!("/api/vault/academic/works/by-id/{work_id}/annotations"))
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
    let works: Vec<serde_json::Value> = res.json();
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
        backlinks.iter().any(|b| b["source_path"] == "notes/ml-notes.md"),
        "cite_key should still resolve after update, backlinks: {backlinks:?}"
    );
}

