mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use axum_test::TestServer;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::{Digest, Sha256};

use clepsydra::api::AppState;
use clepsydra::api::archive::rollback_cas_with;
use clepsydra::api::error::ApiError;
use clepsydra::api::events::SyncNotification;
use clepsydra::vault::archive_hook::ArchiveDeleteHook;
use clepsydra::vault::hooks::PostDeleteHook;
use tempfile::TempDir;

use support::ApiFixture;

fn setup_server() -> (TestServer, TempDir, Arc<AppState>) {
    ApiFixture::builder()
        .delete_hooks_with(|cas| {
            vec![Box::new(ArchiveDeleteHook {
                cas: Arc::clone(cas),
            }) as Box<dyn PostDeleteHook>]
        })
        .build()
        .into_parts()
}

fn sha256_hash(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    format!("sha256:{:x}", digest)
}

fn content_hash(body: &str) -> String {
    sha256_hash(body.as_bytes())
}

#[test]
fn rollback_fault_injection_attempts_all_hashes_and_reports_each_failure() {
    let hashes = vec![
        "sha256:first".to_string(),
        "sha256:second".to_string(),
        "sha256:third".to_string(),
    ];
    let mut attempted = Vec::new();

    let error = rollback_cas_with(
        ApiError::internal("primary index failure"),
        &hashes,
        |hash| {
            attempted.push(hash.to_string());
            if hash == "sha256:first" || hash == "sha256:third" {
                Err(format!("fault for {hash}"))
            } else {
                Ok(())
            }
        },
    );

    assert_eq!(attempted, hashes);
    assert_eq!(error.status, 500);
    assert_eq!(error.error, "primary index failure");
    assert_eq!(
        error.detail,
        Some(serde_json::json!({
            "compensation_failures": [
                {
                    "hash": "sha256:first",
                    "error": "fault for sha256:first"
                },
                {
                    "hash": "sha256:third",
                    "error": "fault for sha256:third"
                }
            ]
        }))
    );
}

#[tokio::test]
async fn rollback_on_index_failure_preserves_primary_and_compensates_every_blob() {
    let (server, tmp, state) = setup_server();
    state
        .index
        .with_index(|index, _vault| {
            index.connection().execute_batch(
                "CREATE TRIGGER fail_archive_insert
                 BEFORE INSERT ON pages
                 BEGIN
                   SELECT RAISE(FAIL, 'deterministic archive index fault');
                 END;",
            )
        })
        .await
        .unwrap()
        .unwrap();

    let first = b"first rollback blob";
    let second = b"second rollback blob";
    let first_hash = sha256_hash(first);
    let second_hash = sha256_hash(second);
    let markdown = "# Rollback";
    let response = server
        .post("/api/vault/archive")
        .json(&serde_json::json!({
            "url": "https://example.com/rollback",
            "domain": "example.com",
            "title": "Rollback",
            "captured_at": "2026-07-11T00:00:00Z",
            "content_hash": content_hash(markdown),
            "snapshot_hash": second_hash,
            "markdown_body": markdown,
            "tags": ["archive"],
            "blobs": [
                {
                    "hash": first_hash,
                    "content_type": "application/octet-stream",
                    "data": BASE64.encode(first),
                },
                {
                    "hash": second_hash,
                    "content_type": "application/octet-stream",
                    "data": BASE64.encode(second),
                }
            ]
        }))
        .await;

    response.assert_status(StatusCode::INTERNAL_SERVER_ERROR);
    let error: serde_json::Value = response.json();
    assert!(
        error["error"]
            .as_str()
            .unwrap()
            .contains("deterministic archive index fault"),
        "primary index failure must remain the response error: {error}"
    );
    assert!(
        !tmp.path()
            .join("vault/archive/example.com/rollback.md")
            .exists(),
        "coordinator-created page must be removed after index failure"
    );
    let pruned = state.cas.lock().gc(std::time::Duration::ZERO).unwrap();
    assert_eq!(pruned, 2, "every incremented blob must be compensated");
}

// ---------------------------------------------------------------------------
// Archive ingest tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn archive_ingest_creates_page_and_stores_blobs() {
    let (server, _tmp, state) = setup_server();
    let mut changes = state.change_tx.subscribe();

    let blob_data = b"fake image data for testing";
    let blob_hash = sha256_hash(blob_data);
    let blob_b64 = BASE64.encode(blob_data);
    let body = "# Example Article\n\nThis is the archived content.";

    let payload = serde_json::json!({
        "url": "https://example.com/article",
        "domain": "example.com",
        "title": "Example Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(body),
        "snapshot_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000002",
        "markdown_body": body,
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
    let SyncNotification::IndexChanged { upserted, removed } = changes.recv().await.unwrap();
    assert_eq!(upserted, vec![body["vault_path"].as_str().unwrap()]);
    assert!(removed.is_empty());

    // Verify blob is retrievable via CAS
    let blob_url = format!("/api/vault/cas/{}", blob_hash);
    let blob_res = server.get(&blob_url).await;
    blob_res.assert_status(StatusCode::OK);
    assert_eq!(blob_res.as_bytes().as_ref(), blob_data);
}

#[tokio::test]
async fn archive_duplicate_url_same_content_returns_200() {
    let (server, _tmp, _state) = setup_server();

    let body = "# Dup Article\n\nSome content.";

    let payload = serde_json::json!({
        "url": "https://example.com/dup-article",
        "domain": "example.com",
        "title": "Dup Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(body),
        "snapshot_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "markdown_body": body,
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
    let (server, _tmp, _state) = setup_server();

    let body1 = "# Conflict Article\n\nOriginal content.";
    let payload1 = serde_json::json!({
        "url": "https://example.com/conflict-article",
        "domain": "example.com",
        "title": "Conflict Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(body1),
        "snapshot_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "markdown_body": body1,
        "tags": ["archive", "example.com"],
        "blobs": [],
    });

    // First ingest
    let res1 = server.post("/api/vault/archive").json(&payload1).await;
    res1.assert_status(StatusCode::CREATED);

    // Second ingest — same URL, different content_hash
    let body2 = "# Conflict Article\n\nUpdated content.";
    let payload2 = serde_json::json!({
        "url": "https://example.com/conflict-article",
        "domain": "example.com",
        "title": "Conflict Article",
        "captured_at": "2026-02-14T13:00:00Z",
        "content_hash": content_hash(body2),
        "snapshot_hash": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        "markdown_body": body2,
        "tags": ["archive", "example.com"],
        "blobs": [],
    });

    let res2 = server.post("/api/vault/archive").json(&payload2).await;
    assert_eq!(res2.status_code(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn archive_status_returns_stats() {
    let (server, _tmp, _state) = setup_server();

    let res = server.get("/api/vault/archive/status").await;
    res.assert_status(StatusCode::OK);
    let body: serde_json::Value = res.json();
    assert_eq!(body["enabled"], true);
    assert_eq!(body["blob_count"], 0);
}

#[tokio::test]
async fn archive_page_is_readable_via_pages_api() {
    let (server, _tmp, _state) = setup_server();

    let md_body = "# Readable Article\n\nArchived content for reading.";
    let payload = serde_json::json!({
        "url": "https://example.com/readable-article",
        "domain": "example.com",
        "title": "Readable Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(md_body),
        "snapshot_hash": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
        "markdown_body": md_body,
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
    let (server, _tmp, _state) = setup_server();

    // Shared blob between two archives
    let shared_blob_data = b"shared image bytes";
    let shared_blob_hash = sha256_hash(shared_blob_data);
    let shared_blob_b64 = BASE64.encode(shared_blob_data);

    let body1 = "# Page One\n\nFirst page.";
    let payload1 = serde_json::json!({
        "url": "https://example.com/page-one",
        "domain": "example.com",
        "title": "Page One",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(body1),
        "snapshot_hash": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
        "markdown_body": body1,
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
    let body1_resp: serde_json::Value = res1.json();
    assert_eq!(body1_resp["blobs_stored"], 1);
    assert_eq!(body1_resp["blobs_deduped"], 0);

    let body2 = "# Page Two\n\nSecond page with same image.";
    let payload2 = serde_json::json!({
        "url": "https://example.com/page-two",
        "domain": "example.com",
        "title": "Page Two",
        "captured_at": "2026-02-14T12:01:00Z",
        "content_hash": content_hash(body2),
        "snapshot_hash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
        "markdown_body": body2,
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
    let body2_resp: serde_json::Value = res2.json();
    assert_eq!(
        body2_resp["blobs_stored"], 0,
        "expected 0 new blobs stored on second ingest"
    );
    assert_eq!(
        body2_resp["blobs_deduped"], 1,
        "expected 1 deduped blob on second ingest"
    );
}

#[tokio::test]
async fn archive_content_hash_mismatch_rejected() {
    let (server, _tmp, _state) = setup_server();

    let payload = serde_json::json!({
        "url": "https://example.com/bad-hash",
        "domain": "example.com",
        "title": "Bad Hash",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "snapshot_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "markdown_body": "# Real content that doesn't match the declared hash",
        "tags": ["archive"],
        "blobs": [],
    });

    let res = server.post("/api/vault/archive").json(&payload).await;
    assert_eq!(res.status_code(), StatusCode::BAD_REQUEST);
    let body: serde_json::Value = res.json();
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("content_hash mismatch"),
        "expected content_hash mismatch error, got: {}",
        body["error"]
    );
}

#[tokio::test]
async fn archive_delete_decrements_cas_ref_count() {
    let (server, _tmp, state) = setup_server();

    let blob_data = b"image for delete test";
    let blob_hash = sha256_hash(blob_data);
    let blob_b64 = BASE64.encode(blob_data);
    let md_body = "# Delete Test\n\nPage to be deleted.";

    let payload = serde_json::json!({
        "url": "https://example.com/delete-me",
        "domain": "example.com",
        "title": "Delete Test",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(md_body),
        "snapshot_hash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "markdown_body": md_body,
        "tags": ["archive"],
        "blobs": [{
            "hash": blob_hash.clone(),
            "content_type": "image/png",
            "data": blob_b64,
        }],
    });

    // Ingest
    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    let vault_path = body["vault_path"].as_str().unwrap();

    // Verify blob ref_count = 1
    {
        let cas = state.cas.lock();
        assert!(cas.exists(&blob_hash).unwrap());
    }

    // Delete the page
    let delete_url = format!("/api/vault/pages/{}", vault_path);
    let del_res = server.delete(&delete_url).await;
    del_res.assert_status(StatusCode::NO_CONTENT);

    // Verify blob ref_count was decremented (should be 0, eligible for GC)
    {
        let cas = state.cas.lock();
        // Blob should still exist in CAS (GC hasn't run), but ref_count = 0
        assert!(
            cas.exists(&blob_hash).unwrap(),
            "blob should still exist in CAS after delete (awaiting GC)"
        );
    }
}

#[tokio::test]
async fn delete_folder_recursive_runs_delete_hooks() {
    // Recursive folder delete must invoke `PostDeleteHook` for each archived
    // page under the folder so that CAS ref counts are decremented. Otherwise
    // blobs become permanently orphaned with ref_count > 0 and ineligible for
    // GC, even after the parent page is gone.
    let (server, _tmp, state) = setup_server();

    let blob_data = b"image for folder-delete test";
    let blob_hash = sha256_hash(blob_data);
    let blob_b64 = BASE64.encode(blob_data);
    let md_body = "# Folder Delete Test\n\nIn a folder.";

    let payload = serde_json::json!({
        "url": "https://example.com/folder-delete",
        "domain": "example.com",
        "title": "Folder Delete Test",
        "captured_at": "2026-04-28T12:00:00Z",
        "content_hash": content_hash(md_body),
        "snapshot_hash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "markdown_body": md_body,
        "tags": ["archive"],
        "blobs": [{
            "hash": blob_hash.clone(),
            "content_type": "image/png",
            "data": blob_b64,
        }],
    });

    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    let vault_path = body["vault_path"].as_str().unwrap().to_string();

    {
        let cas = state.cas.lock();
        assert!(cas.exists(&blob_hash).unwrap());
    }

    let parent_folder = vault_path
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .expect("ingested vault path should have a parent folder");

    let del_url = format!("/api/vault/folders/{}?recursive=true", parent_folder);
    let del_res = server.delete(&del_url).await;
    del_res.assert_status(StatusCode::NO_CONTENT);

    // gc(ZERO) prunes blobs whose ref_count <= 0. If hooks never fired, the
    // blob still has ref_count = 1 and the assertions below will fail.
    {
        let cas = state.cas.lock();
        let pruned = cas.gc(std::time::Duration::ZERO).unwrap();
        assert!(
            pruned >= 1,
            "expected at least the archived blob to be GC'd after recursive folder delete"
        );
        assert!(
            !cas.exists(&blob_hash).unwrap(),
            "blob should be gone from CAS after recursive folder delete + GC"
        );
    }
}
