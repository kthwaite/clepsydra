use std::path::Path;
use std::sync::Arc;

use axum::Router;
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

fn setup_server_with_files(pre_index: impl FnOnce(&Path)) -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    pre_index(&root);

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

/// End-to-end test for the block references workflow:
/// block lookup, search, backlinks with block_ref kind, assign-id, and re-fetch.
#[tokio::test]
async fn full_block_refs_workflow() {
    let (server, _tmp) = setup_server_with_files(|vault_root| {
        let page_a = "---\nid: 00000000-0000-0000-0000-aaaaaaaaaaaa\ntitle: Page A\n---\n- Important note ^abc123DEF0a\n- Another note\n";
        let page_b = "---\nid: 00000000-0000-0000-0000-bbbbbbbbbbbb\ntitle: Page B\n---\nSee ((abc123DEF0a)) for the reference\n";

        std::fs::write(vault_root.join("page-a.md"), page_a).unwrap();
        std::fs::write(vault_root.join("page-b.md"), page_b).unwrap();
    });

    // --- Step 1: Get block by ID ---
    let res = server.get("/api/vault/blocks/abc123DEF0a").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["block_id"].as_str().unwrap(), "abc123DEF0a");
    assert!(
        body["content"].as_str().unwrap().contains("Important note"),
        "block content should contain 'Important note', got: {}",
        body["content"]
    );
    assert_eq!(body["page_path"].as_str().unwrap(), "page-a.md");

    // --- Step 2: Search blocks ---
    let res = server.get("/api/vault/blocks/search?q=Important").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body.as_array().unwrap();
    assert_eq!(results.len(), 1, "search should return 1 result: {body:?}");
    assert!(
        results[0]["content"]
            .as_str()
            .unwrap()
            .contains("Important note"),
        "search result should contain 'Important note'"
    );

    // --- Step 3: Check backlinks on page-a.md ---
    let res = server.get("/api/vault/index/backlinks/page-a.md").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let backlinks = body.as_array().unwrap();
    let block_ref_backlink = backlinks
        .iter()
        .find(|bl| bl["kind"].as_str().unwrap() == "block_ref");
    assert!(
        block_ref_backlink.is_some(),
        "should have a block_ref backlink, got: {body:?}"
    );
    let bl = block_ref_backlink.unwrap();
    assert_eq!(
        bl["source_path"].as_str().unwrap(),
        "page-b.md",
        "block_ref backlink should come from page-b.md"
    );

    // --- Step 4: Assign block ID to "Another note" ---
    // First, find the block via search to get its span_start
    let res = server.get("/api/vault/blocks/search?q=Another+note").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let results = body.as_array().unwrap();
    assert!(
        !results.is_empty(),
        "search for 'Another note' should return results"
    );
    let another_block = &results[0];
    let span_start = another_block["span_start"].as_i64().unwrap();

    let res = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page-a.md",
            "span_start": span_start,
        }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    let new_block_id = body["block_id"].as_str().unwrap();
    assert!(
        new_block_id.len() >= 10 && new_block_id.len() <= 12,
        "assigned block_id should be 10-12 chars, got: '{new_block_id}' (len={})",
        new_block_id.len()
    );
    assert!(
        new_block_id.chars().all(|c| c.is_ascii_alphanumeric()),
        "assigned block_id should be alphanumeric, got: '{new_block_id}'"
    );

    // --- Step 5: Verify assigned block is fetchable ---
    let res = server
        .get(&format!("/api/vault/blocks/{new_block_id}"))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["block_id"].as_str().unwrap(), new_block_id);
    assert!(
        body["content"].as_str().unwrap().contains("Another note"),
        "fetched block should contain 'Another note', got: {}",
        body["content"]
    );
}
