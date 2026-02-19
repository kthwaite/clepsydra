use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum_test::TestServer;
use chrono::Utc;
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

fn today_str() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------------------
// GET /journal/today
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_today_creates_journal_if_missing() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/journal/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["path"].as_str().unwrap().starts_with("journals/"));
    assert!(body["path"].as_str().unwrap().ends_with(".md"));
    assert!(
        body["meta"]["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "journal")
    );
    // Title should be today's date
    let title = body["meta"]["title"].as_str().unwrap();
    assert_eq!(title, today_str());
}

#[tokio::test]
async fn get_today_returns_existing_journal() {
    let (server, _tmp) = setup_server();

    // Create today's journal
    let first = server.get("/api/vault/journal/today").await;
    first.assert_status_ok();
    let first_body: serde_json::Value = first.json();
    let first_id = first_body["meta"]["id"].as_str().unwrap().to_string();

    // Get it again — should return the same page (same ID)
    let second = server.get("/api/vault/journal/today").await;
    second.assert_status_ok();
    let second_body: serde_json::Value = second.json();
    assert_eq!(second_body["meta"]["id"].as_str().unwrap(), first_id);
}

// ---------------------------------------------------------------------------
// GET /journal/:date
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_by_date_returns_existing() {
    let (server, _tmp) = setup_server();

    // Create a journal via the today endpoint
    server.get("/api/vault/journal/today").await;

    // Now fetch by today's date explicitly
    let date = today_str();
    let res = server
        .get(&format!("/api/vault/journal/{date}"))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["path"].as_str().unwrap(), format!("journals/{date}.md"));
}

#[tokio::test]
async fn get_by_date_returns_404_if_not_found() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/journal/2099-01-01").await;
    res.assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_by_date_rejects_invalid_format() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/journal/not-a-date").await;
    res.assert_status(StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------------------
// POST /journal/today/capture
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capture_appends_to_today() {
    let (server, _tmp) = setup_server();

    // Create today's journal
    server.get("/api/vault/journal/today").await;

    // Capture content
    let res = server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "- [ ] New task [due:: 2026-03-01]" }))
        .await;
    res.assert_status_ok();

    // Get the page and verify content was appended
    let page = server.get("/api/vault/journal/today").await;
    let body: serde_json::Value = page.json();
    assert!(body["body"].as_str().unwrap().contains("New task"));
}

#[tokio::test]
async fn capture_creates_journal_first_if_missing() {
    let (server, _tmp) = setup_server();
    let res = server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "- Quick note" }))
        .await;
    res.assert_status_ok();

    // Verify the journal now exists and contains the note
    let page = server.get("/api/vault/journal/today").await;
    let body: serde_json::Value = page.json();
    assert!(body["body"].as_str().unwrap().contains("Quick note"));
}

#[tokio::test]
async fn capture_appends_multiple_entries() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "First entry" }))
        .await
        .assert_status_ok();

    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "Second entry" }))
        .await
        .assert_status_ok();

    let page = server.get("/api/vault/journal/today").await;
    let body: serde_json::Value = page.json();
    let text = body["body"].as_str().unwrap();
    assert!(text.contains("First entry"));
    assert!(text.contains("Second entry"));
}

// ---------------------------------------------------------------------------
// GET /journal/recent
// ---------------------------------------------------------------------------

#[tokio::test]
async fn recent_returns_last_n_days() {
    let (server, _tmp) = setup_server();

    // Create today's journal
    server.get("/api/vault/journal/today").await;

    // Query recent journals (today should appear)
    let res = server.get("/api/vault/journal/recent?days=3").await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    let items = body.as_array().unwrap();
    assert!(!items.is_empty());
    // The journal_date should be today
    assert_eq!(items[0]["journal_date"].as_str().unwrap(), today_str());
}

#[tokio::test]
async fn recent_defaults_to_7_days() {
    let (server, _tmp) = setup_server();

    server.get("/api/vault/journal/today").await;

    let res = server.get("/api/vault/journal/recent").await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    let items = body.as_array().unwrap();
    assert!(!items.is_empty());
}

// ---------------------------------------------------------------------------
// GET /journal/range
// ---------------------------------------------------------------------------

#[tokio::test]
async fn range_returns_journals_in_date_range() {
    let (server, _tmp) = setup_server();

    // Create today's journal
    server.get("/api/vault/journal/today").await;

    let today = today_str();
    let res = server
        .get(&format!(
            "/api/vault/journal/range?from={today}&to={today}"
        ))
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    let items = body.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["journal_date"].as_str().unwrap(), today);
}

#[tokio::test]
async fn range_returns_empty_for_no_journals() {
    let (server, _tmp) = setup_server();

    let res = server
        .get("/api/vault/journal/range?from=2099-01-01&to=2099-12-31")
        .await;
    res.assert_status_ok();

    let body: serde_json::Value = res.json();
    let items = body.as_array().unwrap();
    assert!(items.is_empty());
}

#[tokio::test]
async fn range_rejects_invalid_dates() {
    let (server, _tmp) = setup_server();

    let res = server
        .get("/api/vault/journal/range?from=bad&to=also-bad")
        .await;
    res.assert_status(StatusCode::BAD_REQUEST);
}
