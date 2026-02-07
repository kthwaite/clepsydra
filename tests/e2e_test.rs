use std::fs;
use std::sync::{Arc, Mutex};

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
        index: Arc::new(Mutex::new(index)),
        warnings: Mutex::new(Vec::new()),
        change_tx,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn full_vault_lifecycle() {
    let (server, tmp) = setup_server();
    let vault_root = tmp.path().join("vault");

    // 1. Create page "index.md" with body linking to [[Design Notes]]
    let res = server
        .post("/api/vault/pages/index.md")
        .json(&serde_json::json!({
            "title": "Index",
            "body": "Welcome to [[Design Notes]]."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // 2. Create page "design.md" with title "Design Notes" and tags
    let res = server
        .post("/api/vault/pages/design.md")
        .json(&serde_json::json!({
            "title": "Design Notes",
            "tags": ["architecture"],
            "body": "Architecture documentation."
        }))
        .await;
    res.assert_status(StatusCode::CREATED);

    // 3. POST /index/rebuild
    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status_ok();
    let rebuild: serde_json::Value = res.json();
    // Pages were already indexed during create; rebuild may report them as
    // skipped (hash unchanged) or indexed. Either way it should succeed.
    let total = rebuild["pages_indexed"].as_i64().unwrap()
        + rebuild["pages_skipped"].as_i64().unwrap();
    assert_eq!(total, 2, "expected 2 total pages, got rebuild: {rebuild}");

    // 4. GET /index/backlinks/design.md -> verify index.md is listed
    let res = server.get("/api/vault/index/backlinks/design.md").await;
    res.assert_status_ok();
    let backlinks: Vec<serde_json::Value> = res.json();
    assert_eq!(backlinks.len(), 1, "expected 1 backlink, got: {backlinks:?}");
    assert_eq!(backlinks[0]["source_path"], "index.md");

    // 5. GET /index/tags -> verify "architecture" present
    let res = server.get("/api/vault/index/tags").await;
    res.assert_status_ok();
    let tags: Vec<serde_json::Value> = res.json();
    let arch_tag = tags.iter().find(|t| t["tag"] == "architecture");
    assert!(
        arch_tag.is_some(),
        "expected 'architecture' tag, got: {tags:?}"
    );

    // 6. POST /pages-move/design.md with destination "architecture.md"
    let res = server
        .post("/api/vault/pages-move/design.md")
        .json(&serde_json::json!({"destination": "architecture.md"}))
        .await;
    assert_eq!(res.status_code(), StatusCode::OK);

    // Verify file moved
    assert!(
        !vault_root.join("design.md").exists(),
        "design.md should not exist after move"
    );
    assert!(
        vault_root.join("architecture.md").exists(),
        "architecture.md should exist after move"
    );

    // 7. Read index.md from disk -> verify [[Design Notes]] was rewritten
    let index_content = fs::read_to_string(vault_root.join("index.md")).unwrap();
    assert!(
        !index_content.contains("[[Design Notes]]"),
        "old wikilink should be rewritten, found: {index_content}"
    );

    // 8. GET /index/stats -> verify 2 pages
    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let stats: serde_json::Value = res.json();
    assert_eq!(stats["pages"], 2);

    // 9. DELETE /pages/architecture.md?force=true&rewrite=plain_text
    let res = server
        .delete("/api/vault/pages/architecture.md?force=true&rewrite=plain_text")
        .await;
    assert_eq!(res.status_code(), StatusCode::NO_CONTENT);

    // Verify architecture.md is deleted
    assert!(
        !vault_root.join("architecture.md").exists(),
        "architecture.md should be deleted"
    );

    // 10. Read index.md from disk -> verify no [[ ]] syntax remains
    let index_content = fs::read_to_string(vault_root.join("index.md")).unwrap();
    assert!(
        !index_content.contains("[["),
        "no wikilink brackets should remain, found: {index_content}"
    );
    assert!(
        !index_content.contains("]]"),
        "no wikilink brackets should remain, found: {index_content}"
    );

    // 11. POST /index/rebuild
    let res = server.post("/api/vault/index/rebuild").await;
    res.assert_status_ok();

    // 12. GET /index/stats -> verify 1 page
    let res = server.get("/api/vault/index/stats").await;
    res.assert_status_ok();
    let stats: serde_json::Value = res.json();
    assert_eq!(stats["pages"], 1);
}
