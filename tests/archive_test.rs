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
fn archive_delete_hook_reports_cas_decrement_failure() {
    use clepsydra::vault::hooks::PostDeleteHook;
    use clepsydra::vault::page::PageMeta;
    use clepsydra::vault::path::VaultPath;

    let (_server, _tmp, state) = setup_server();
    let valid_hash = state
        .cas
        .lock()
        .store(b"valid sibling", "application/octet-stream")
        .unwrap()
        .hash;
    let mut archive = toml::Table::new();
    archive.insert(
        "snapshot_hash".to_string(),
        toml::Value::String("invalid".to_string()),
    );
    archive.insert(
        "blobs".to_string(),
        toml::Value::Array(vec![toml::Value::String(valid_hash)]),
    );
    let mut meta = PageMeta::new();
    meta.extra
        .insert("archive".to_string(), toml::Value::Table(archive));
    let hook = ArchiveDeleteHook {
        cas: Arc::clone(&state.cas),
    };

    let error = hook
        .on_page_deleted(
            &VaultPath::new("archive/invalid.md").unwrap(),
            &uuid::Uuid::now_v7(),
            &meta,
        )
        .unwrap_err();

    assert!(error.to_string().contains("hash must start with 'sha256:'"));
    assert_eq!(
        state
            .cas
            .lock()
            .gc(std::time::Duration::ZERO)
            .unwrap(),
        1,
        "a failing decrement must not prevent later references from being compensated"
    );
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
    let SyncNotification::IndexChanged { upserted, removed } = changes.recv().await.unwrap() else {
        panic!("expected IndexChanged")
    };
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

    // The page declares Kind::Archive, whose computed tag is "archive". The
    // extension still sends that tag, but it is now the canonical classification
    // rather than a user-editable one, so it is reported under computed_tags and
    // deduplicated out of the editable list instead of appearing twice.
    assert_eq!(page_body["kind"], "ARCHIVE");
    assert_eq!(
        page_body["inferred"], false,
        "the archive endpoint declares the kind rather than leaving it to folder inference"
    );
    let computed = page_body["computed_tags"].as_array().unwrap();
    assert!(
        computed.iter().any(|t| t == "archive"),
        "expected 'archive' among computed tags, got: {computed:?}"
    );
    let tags = page_body["meta"]["tags"].as_array().unwrap();
    assert!(
        !tags.iter().any(|t| t == "archive"),
        "'archive' must not be duplicated into editable tags, got: {tags:?}"
    );
    assert!(
        tags.iter().any(|t| t == "example.com"),
        "domain tag should remain editable, got: {tags:?}"
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

/// Ingest a single blob of the given content type and return its CAS URL.
async fn ingest_blob(server: &TestServer, url: &str, content_type: &str, data: &[u8]) -> String {
    let hash = sha256_hash(data);
    let body = "# Snapshot\n\nbody";
    let payload = serde_json::json!({
        "url": url,
        "domain": "evil.example",
        "title": "Snapshot",
        "captured_at": "2026-08-12T12:00:00Z",
        "content_hash": content_hash(body),
        "snapshot_hash": hash,
        "markdown_body": body,
        "tags": ["archive"],
        "blobs": [{
            "hash": hash,
            "content_type": content_type,
            "data": BASE64.encode(data),
        }],
    });
    server
        .post("/api/vault/archive")
        .json(&payload)
        .await
        .assert_status(StatusCode::CREATED);
    format!("/api/vault/cas/{hash}")
}

#[tokio::test]
async fn serve_blob_sets_sandbox_csp_and_nosniff() {
    let (server, _tmp, _state) = setup_server();
    let url = ingest_blob(
        &server,
        "https://evil.example/a",
        "image/png",
        b"\x89PNG fake bytes",
    )
    .await;

    let res = server.get(&url).await;
    res.assert_status(StatusCode::OK);

    let csp = res
        .headers()
        .get("content-security-policy")
        .expect("blobs must carry a CSP")
        .to_str()
        .unwrap()
        .to_string();
    assert!(csp.contains("sandbox"), "CSP was {csp:?}");
    assert!(csp.contains("default-src 'none'"), "CSP was {csp:?}");

    assert_eq!(
        res.headers()
            .get("x-content-type-options")
            .map(|v| v.to_str().unwrap()),
        Some("nosniff")
    );
}

#[tokio::test]
async fn serve_blob_forces_download_for_active_content_types() {
    let (server, _tmp, _state) = setup_server();

    for (index, content_type) in [
        "text/html",
        "text/html; charset=utf-8",
        "application/xhtml+xml",
        "image/svg+xml",
        "application/xml",
    ]
    .iter()
    .enumerate()
    {
        let url = ingest_blob(
            &server,
            &format!("https://evil.example/active-{index}"),
            content_type,
            format!("<script>alert({index})</script>").as_bytes(),
        )
        .await;

        let res = server.get(&url).await;
        res.assert_status(StatusCode::OK);
        assert_eq!(
            res.headers()
                .get("content-disposition")
                .map(|v| v.to_str().unwrap()),
            Some("attachment"),
            "{content_type} must not render inline from the vault origin"
        );
    }
}

#[tokio::test]
async fn serve_blob_keeps_images_inline() {
    let (server, _tmp, _state) = setup_server();
    let url = ingest_blob(
        &server,
        "https://evil.example/inline",
        "image/png",
        b"\x89PNG other bytes",
    )
    .await;

    let res = server.get(&url).await;
    res.assert_status(StatusCode::OK);
    assert!(
        res.headers().get("content-disposition").is_none(),
        "images must stay inline so archived markdown still renders"
    );
}

// ---------------------------------------------------------------------------
// Read-only archive bodies
// ---------------------------------------------------------------------------

/// Ingest an archive and return its vault path.
async fn ingest_simple(server: &TestServer, url: &str, body: &str) -> String {
    let payload = serde_json::json!({
        "url": url,
        "domain": "example.com",
        "title": "Protected Article",
        "captured_at": "2026-08-12T12:00:00Z",
        "content_hash": content_hash(body),
        "snapshot_hash": "sha256:00000000000000000000000000000000000000000000000000000000000000ff",
        "markdown_body": body,
        "tags": ["archive"],
        "blobs": [],
    });
    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    body["vault_path"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn archived_page_reports_itself_read_only() {
    let (server, _tmp, _state) = setup_server();
    let path = ingest_simple(&server, "https://example.com/ro-1", "# Article\n\nOriginal.").await;

    let page = server.get(&format!("/api/vault/pages/{path}")).await;
    page.assert_status(StatusCode::OK);
    let body: serde_json::Value = page.json();
    assert_eq!(body["readonly"], true);
    assert_eq!(body["kind"], "ARCHIVE");
}

#[tokio::test]
async fn editing_an_archived_body_is_refused() {
    let (server, _tmp, _state) = setup_server();
    let path = ingest_simple(&server, "https://example.com/ro-2", "# Article\n\nOriginal.").await;

    let page: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    let res = server
        .put(&format!("/api/vault/pages/{path}"))
        .json(&serde_json::json!({
            "body": "# Article\n\nTampered.",
            "expected_revision": page["revision"],
        }))
        .await;

    res.assert_status(StatusCode::FORBIDDEN);

    // And the stored body is untouched.
    let after: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    assert!(
        after["body"].as_str().unwrap().contains("Original."),
        "body should be unchanged, got: {}",
        after["body"]
    );
}

#[tokio::test]
async fn metadata_edits_to_an_archived_page_still_work() {
    let (server, _tmp, _state) = setup_server();
    let path = ingest_simple(&server, "https://example.com/ro-3", "# Article\n\nOriginal.").await;

    let page: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    // Filing and tagging an archive is the whole point of having it in a vault,
    // so protection must not extend to metadata.
    let res = server
        .put(&format!("/api/vault/pages/{path}"))
        .json(&serde_json::json!({
            "expected_revision": page["revision"],
            "tags": ["archive", "example.com", "to-read"],
        }))
        .await;

    assert!(
        res.status_code().is_success(),
        "metadata-only update should succeed, got {}: {}",
        res.status_code(),
        res.text()
    );
}

#[tokio::test]
async fn clearing_readonly_unlocks_the_body() {
    let (server, _tmp, _state) = setup_server();
    let path = ingest_simple(&server, "https://example.com/ro-4", "# Article\n\nOriginal.").await;
    let url = format!("/api/vault/pages/{path}");

    // Unlock. This is a metadata-only write, so the guard lets it through even
    // though the page is protected at the moment it is made.
    let page: serde_json::Value = server.get(&url).await.json();
    let unlock = server
        .put(&url)
        .json(&serde_json::json!({
            "expected_revision": page["revision"],
            "readonly": false,
        }))
        .await;
    assert!(
        unlock.status_code().is_success(),
        "unlocking should succeed, got {}: {}",
        unlock.status_code(),
        unlock.text()
    );

    let unlocked: serde_json::Value = server.get(&url).await.json();
    assert_eq!(unlocked["readonly"], false);

    // Now the body may be edited.
    let edit = server
        .put(&url)
        .json(&serde_json::json!({
            "expected_revision": unlocked["revision"],
            "body": "# Article\n\nAnnotated by hand.",
        }))
        .await;
    assert!(
        edit.status_code().is_success(),
        "editing an unlocked archive should succeed, got {}: {}",
        edit.status_code(),
        edit.text()
    );

    let after: serde_json::Value = server.get(&url).await.json();
    assert!(after["body"].as_str().unwrap().contains("Annotated by hand."));
}

#[tokio::test]
async fn readonly_can_be_declared_on_any_page() {
    let (server, _tmp, _state) = setup_server();
    let create = server
        .post("/api/vault/pages")
        .json(&serde_json::json!({
            "title": "Locked Note",
            "body": "Do not edit.",
        }))
        .await;
    assert!(create.status_code().is_success(), "{}", create.text());
    let created: serde_json::Value = create.json();
    let url = format!("/api/vault/pages/{}", created["path"].as_str().unwrap());

    let page: serde_json::Value = server.get(&url).await.json();
    assert_eq!(page["readonly"], false, "notes are editable by default");

    let lock = server
        .put(&url)
        .json(&serde_json::json!({
            "expected_revision": page["revision"],
            "readonly": true,
        }))
        .await;
    assert!(lock.status_code().is_success(), "{}", lock.text());

    let locked: serde_json::Value = server.get(&url).await.json();
    let res = server
        .put(&url)
        .json(&serde_json::json!({
            "expected_revision": locked["revision"],
            "body": "Edited anyway.",
        }))
        .await;
    res.assert_status(StatusCode::FORBIDDEN);
}
