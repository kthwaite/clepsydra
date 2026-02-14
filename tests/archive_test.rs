use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum_test::TestServer;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use clepsydra::api::{AppState, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::academic_hook::AcademicMoveHook;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::hooks::PostMoveHook;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

fn production_hooks() -> Vec<Box<dyn PostMoveHook>> {
    vec![Box::new(AcademicMoveHook)]
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

    let (change_tx, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        vault,
        index: Arc::new(parking_lot::Mutex::new(index)),
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: vec![],
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);

    let server = TestServer::new(app).unwrap();
    (server, tmp)
}

fn sha256_hash(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("sha256:{:x}", digest)
}

// ---------------------------------------------------------------------------
// Archive ingest tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn archive_ingest_creates_page_and_stores_blobs() {
    let (server, _tmp) = setup_server();

    let blob_data = b"fake image data for testing";
    let blob_hash = sha256_hash(blob_data);
    let blob_b64 = BASE64.encode(blob_data);

    let payload = serde_json::json!({
        "url": "https://example.com/article",
        "domain": "example.com",
        "title": "Example Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000001",
        "snapshot_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000002",
        "markdown_body": "# Example Article\n\nThis is the archived content.",
        "tags": ["archive", "example.com"],
        "blobs": [{
            "hash": blob_hash,
            "content_type": "image/png",
            "data": blob_b64,
        }],
    });

    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();

    assert_eq!(body["blobs_stored"], 1);
    assert_eq!(body["blobs_deduped"], 0);
    assert_eq!(body["status"], "created");
    assert!(
        body["vault_path"].as_str().unwrap().starts_with("archive/"),
        "expected vault_path to start with 'archive/', got: {}",
        body["vault_path"]
    );

    // Verify blob is retrievable via CAS
    let blob_url = format!("/api/vault/cas/{}", blob_hash);
    let blob_res = server.get(&blob_url).await;
    blob_res.assert_status(StatusCode::OK);
    assert_eq!(blob_res.as_bytes().as_ref(), blob_data);
}

#[tokio::test]
async fn archive_duplicate_url_same_content_returns_200() {
    let (server, _tmp) = setup_server();

    let content_hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let payload = serde_json::json!({
        "url": "https://example.com/dup-article",
        "domain": "example.com",
        "title": "Dup Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash,
        "snapshot_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "markdown_body": "# Dup Article\n\nSome content.",
        "tags": ["archive", "example.com"],
        "blobs": [],
    });

    // First ingest
    let res1 = server.post("/api/vault/archive").json(&payload).await;
    res1.assert_status(StatusCode::CREATED);
    let body1: serde_json::Value = res1.json();
    assert_eq!(body1["status"], "created");

    // Second ingest — same URL, same content_hash
    let res2 = server.post("/api/vault/archive").json(&payload).await;
    assert_eq!(res2.status_code(), StatusCode::OK);
    let body2: serde_json::Value = res2.json();
    assert_eq!(body2["status"], "already_exists");
}

#[tokio::test]
async fn archive_duplicate_url_different_content_returns_409() {
    let (server, _tmp) = setup_server();

    let payload1 = serde_json::json!({
        "url": "https://example.com/conflict-article",
        "domain": "example.com",
        "title": "Conflict Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "snapshot_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "markdown_body": "# Conflict Article\n\nOriginal content.",
        "tags": ["archive", "example.com"],
        "blobs": [],
    });

    // First ingest
    let res1 = server.post("/api/vault/archive").json(&payload1).await;
    res1.assert_status(StatusCode::CREATED);

    // Second ingest — same URL, different content_hash
    let payload2 = serde_json::json!({
        "url": "https://example.com/conflict-article",
        "domain": "example.com",
        "title": "Conflict Article",
        "captured_at": "2026-02-14T13:00:00Z",
        "content_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "snapshot_hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        "markdown_body": "# Conflict Article\n\nUpdated content.",
        "tags": ["archive", "example.com"],
        "blobs": [],
    });

    let res2 = server.post("/api/vault/archive").json(&payload2).await;
    assert_eq!(res2.status_code(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn archive_status_returns_stats() {
    let (server, _tmp) = setup_server();

    let res = server.get("/api/vault/archive/status").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["enabled"], true);
    assert_eq!(body["blob_count"], 0);
}

#[tokio::test]
async fn archive_page_is_readable_via_pages_api() {
    let (server, _tmp) = setup_server();

    let payload = serde_json::json!({
        "url": "https://example.com/readable-article",
        "domain": "example.com",
        "title": "Readable Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        "snapshot_hash": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        "markdown_body": "# Readable Article\n\nArchived content for reading.",
        "tags": ["archive", "example.com"],
        "blobs": [],
    });

    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let archive_body: serde_json::Value = res.json();
    let vault_path = archive_body["vault_path"].as_str().unwrap();

    // GET the page via the pages API
    let page_url = format!("/api/vault/pages/{}", vault_path);
    let page_res = server.get(&page_url).await;
    page_res.assert_status(StatusCode::OK);
    let page_body: serde_json::Value = page_res.json();

    assert_eq!(page_body["meta"]["title"], "Readable Article");
    assert!(
        page_body["body"]
            .as_str()
            .unwrap()
            .contains("Archived content for reading."),
        "expected body to contain archive content, got: {}",
        page_body["body"]
    );

    // Verify tags include "archive"
    let tags = page_body["meta"]["tags"].as_array().unwrap();
    assert!(
        tags.iter().any(|t| t == "archive"),
        "expected 'archive' tag, got: {tags:?}"
    );
}

#[tokio::test]
async fn archive_blob_deduplication() {
    let (server, _tmp) = setup_server();

    // Shared blob between two archives
    let shared_blob_data = b"shared image bytes";
    let shared_blob_hash = sha256_hash(shared_blob_data);
    let shared_blob_b64 = BASE64.encode(shared_blob_data);

    let payload1 = serde_json::json!({
        "url": "https://example.com/page-one",
        "domain": "example.com",
        "title": "Page One",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": "sha256:7777777777777777777777777777777777777777777777777777777777777777",
        "snapshot_hash": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
        "markdown_body": "# Page One\n\nFirst page.",
        "tags": ["archive", "example.com"],
        "blobs": [{
            "hash": shared_blob_hash.clone(),
            "content_type": "image/jpeg",
            "data": shared_blob_b64.clone(),
        }],
    });

    // First archive — blob is new
    let res1 = server.post("/api/vault/archive").json(&payload1).await;
    res1.assert_status(StatusCode::CREATED);
    let body1: serde_json::Value = res1.json();
    assert_eq!(body1["blobs_stored"], 1);
    assert_eq!(body1["blobs_deduped"], 0);

    let payload2 = serde_json::json!({
        "url": "https://example.com/page-two",
        "domain": "example.com",
        "title": "Page Two",
        "captured_at": "2026-02-14T12:01:00Z",
        "content_hash": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        "snapshot_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
        "markdown_body": "# Page Two\n\nSecond page with same image.",
        "tags": ["archive", "example.com"],
        "blobs": [{
            "hash": shared_blob_hash,
            "content_type": "image/jpeg",
            "data": shared_blob_b64,
        }],
    });

    // Second archive — same blob already stored, should be deduped
    let res2 = server.post("/api/vault/archive").json(&payload2).await;
    res2.assert_status(StatusCode::CREATED);
    let body2: serde_json::Value = res2.json();
    assert_eq!(
        body2["blobs_stored"], 0,
        "expected 0 new blobs stored on second ingest"
    );
    assert_eq!(
        body2["blobs_deduped"], 1,
        "expected 1 deduped blob on second ingest"
    );
}
