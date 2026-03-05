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

    // Allow the caller to write files into the vault before indexing.
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
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

#[tokio::test]
async fn get_block_by_id_found() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Buy milk ^abc123DEF0a\n",
        )
        .unwrap();
    });

    let response = server.get("/api/vault/blocks/abc123DEF0a").await;
    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    assert_eq!(body["block_id"], "abc123DEF0a");
    assert!(body["content"].as_str().unwrap().contains("Buy milk"));
    assert_eq!(body["page_path"], "page.md");
}

#[tokio::test]
async fn get_block_by_id_not_found() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\nNo blocks here\n",
        )
        .unwrap();
    });

    let response = server.get("/api/vault/blocks/nonexistent1").await;
    response.assert_status_not_found();
}

#[tokio::test]
async fn search_blocks_by_content() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Buy milk ^abc123DEF0a\n- Walk the dog\n",
        )
        .unwrap();
    });

    let response = server.get("/api/vault/blocks/search?q=milk&limit=8").await;
    response.assert_status_ok();
    let body: Vec<serde_json::Value> = response.json();
    assert_eq!(body.len(), 1);
    assert!(body[0]["content"].as_str().unwrap().contains("milk"));
}

#[tokio::test]
async fn assign_block_id_to_block() {
    let (server, _dir) = setup_server_with_files(|root| {
        std::fs::write(
            root.join("page.md"),
            "---\ntitle: Test\n---\n- Untagged item\n",
        )
        .unwrap();
    });

    // First, find the block's span_start by searching
    let search_response = server.get("/api/vault/blocks/search?q=Untagged").await;
    search_response.assert_status_ok();
    let blocks: Vec<serde_json::Value> = search_response.json();
    assert_eq!(blocks.len(), 1);
    let span_start = blocks[0]["span_start"].as_i64().unwrap();

    // Assign an ID
    let assign_response = server
        .post("/api/vault/blocks/assign-id")
        .json(&serde_json::json!({
            "page_path": "page.md",
            "span_start": span_start
        }))
        .await;
    assign_response.assert_status_ok();

    let result: serde_json::Value = assign_response.json();
    let block_id = result["block_id"].as_str().unwrap();
    assert!(block_id.len() >= 10 && block_id.len() <= 12);

    // Verify the block is now fetchable by ID
    let get_response = server.get(&format!("/api/vault/blocks/{block_id}")).await;
    get_response.assert_status_ok();
}
