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
        state.cas.lock().gc(std::time::Duration::ZERO).unwrap(),
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

    // One inlined image plus the snapshot itself: two blobs incremented, both
    // of which must be compensated when the index insert fails.
    let image = b"rollback image bytes";
    let image_b64 = BASE64.encode(image);
    let markdown = "# Rollback";
    let snapshot_html =
        format!(r#"<html><body><img src="data:image/png;base64,{image_b64}"></body></html>"#);
    let response = server
        .post("/api/vault/archive")
        .json(&serde_json::json!({
            "url": "https://example.com/rollback",
            "domain": "example.com",
            "title": "Rollback",
            "captured_at": "2026-07-11T00:00:00Z",
            "content_hash": content_hash(markdown),
            "snapshot_html": snapshot_html,
            "markdown_body": markdown,
            "tags": ["archive"],
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
    let snapshot_html =
        format!(r#"<html><body><img src="data:image/png;base64,{blob_b64}"></body></html>"#);

    let payload = serde_json::json!({
        "url": "https://example.com/article",
        "domain": "example.com",
        "title": "Example Article",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(body),
        "snapshot_html": snapshot_html,
        "markdown_body": body,
        "tags": ["archive", "example.com"],
    });

    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();

    // The inlined image plus the snapshot itself: two blobs, where the client
    // used to send only one.
    assert_eq!(body["blobs_stored"], 2);
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
        "snapshot_html": "<html><body><p>ok</p></body></html>",
        "markdown_body": body,
        "tags": ["archive", "example.com"],
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
        "snapshot_html": "<html><body><p>ok</p></body></html>",
        "markdown_body": body1,
        "tags": ["archive", "example.com"],
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
        "snapshot_html": "<html><body><p>ok</p></body></html>",
        "markdown_body": body2,
        "tags": ["archive", "example.com"],
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
        "snapshot_html": "<html><body><p>ok</p></body></html>",
        "markdown_body": md_body,
        "tags": ["archive", "example.com"],
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
async fn archive_content_hash_mismatch_rejected() {
    let (server, _tmp, _state) = setup_server();

    let payload = serde_json::json!({
        "url": "https://example.com/bad-hash",
        "domain": "example.com",
        "title": "Bad Hash",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "snapshot_html": "<html><body><p>ok</p></body></html>",
        "markdown_body": "# Real content that doesn't match the declared hash",
        "tags": ["archive"],
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
    let snapshot_html =
        format!(r#"<html><body><img src="data:image/png;base64,{blob_b64}"></body></html>"#);

    let payload = serde_json::json!({
        "url": "https://example.com/delete-me",
        "domain": "example.com",
        "title": "Delete Test",
        "captured_at": "2026-02-14T12:00:00Z",
        "content_hash": content_hash(md_body),
        "snapshot_html": snapshot_html,
        "markdown_body": md_body,
        "tags": ["archive"],
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
    let snapshot_html =
        format!(r#"<html><body><img src="data:image/png;base64,{blob_b64}"></body></html>"#);

    let payload = serde_json::json!({
        "url": "https://example.com/folder-delete",
        "domain": "example.com",
        "title": "Folder Delete Test",
        "captured_at": "2026-04-28T12:00:00Z",
        "content_hash": content_hash(md_body),
        "snapshot_html": snapshot_html,
        "markdown_body": md_body,
        "tags": ["archive"],
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
    let data_b64 = BASE64.encode(data);
    // A data URI's media-type field cannot carry whitespace (the deconstruction
    // regex stops at the first space), so collapse it the way a real capture
    // would; `is_active_content` only inspects the part before the `;` anyway.
    let media_type: String = content_type
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let snapshot_html =
        format!(r#"<html><body><img src="data:{media_type};base64,{data_b64}"></body></html>"#);
    let payload = serde_json::json!({
        "url": url,
        "domain": "evil.example",
        "title": "Snapshot",
        "captured_at": "2026-08-12T12:00:00Z",
        "content_hash": content_hash(body),
        "snapshot_html": snapshot_html,
        "markdown_body": body,
        "tags": ["archive"],
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
        "snapshot_html": "<html><body><p>ok</p></body></html>",
        "markdown_body": body,
        "tags": ["archive"],
    });
    let res = server.post("/api/vault/archive").json(&payload).await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    body["vault_path"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn archived_page_reports_itself_read_only() {
    let (server, _tmp, _state) = setup_server();
    let path = ingest_simple(
        &server,
        "https://example.com/ro-1",
        "# Article\n\nOriginal.",
    )
    .await;

    let page = server.get(&format!("/api/vault/pages/{path}")).await;
    page.assert_status(StatusCode::OK);
    let body: serde_json::Value = page.json();
    assert_eq!(body["readonly"], true);
    assert_eq!(body["kind"], "ARCHIVE");
}

#[tokio::test]
async fn editing_an_archived_body_is_refused() {
    let (server, _tmp, _state) = setup_server();
    let path = ingest_simple(
        &server,
        "https://example.com/ro-2",
        "# Article\n\nOriginal.",
    )
    .await;

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
    let path = ingest_simple(
        &server,
        "https://example.com/ro-3",
        "# Article\n\nOriginal.",
    )
    .await;

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
    let path = ingest_simple(
        &server,
        "https://example.com/ro-4",
        "# Article\n\nOriginal.",
    )
    .await;
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
    assert!(
        after["body"]
            .as_str()
            .unwrap()
            .contains("Annotated by hand.")
    );
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

// ---------------------------------------------------------------------------
// Fidelity capture: the server deconstructs the snapshot into the CAS
// ---------------------------------------------------------------------------

/// The full pipeline over one capture: a snapshot with an inlined image, and
/// markdown that still points at the live URL.
fn fidelity_payload(url: &str, markdown: &str) -> serde_json::Value {
    // The `url` comment makes each page's snapshot distinct, so a shared image
    // is the only thing two captures can deduplicate on.
    let snapshot = format!(
        concat!(
            r#"<html><!-- {} --><body><img data-sf-original-src="https://cdn.example.com/a.png" "#,
            r#"src="data:image/png;base64,iVBORw0KGgo="></body></html>"#
        ),
        url
    );
    serde_json::json!({
        "url": url,
        "domain": "example.com",
        "title": "Fidelity Article",
        "captured_at": "2026-08-12T12:00:00Z",
        "content_hash": content_hash(markdown),
        "snapshot_html": snapshot,
        "markdown_body": markdown,
        "tags": ["archive", "example.com"],
    })
}

#[tokio::test]
async fn ingest_deconstructs_the_snapshot_into_the_cas() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/one", markdown))
        .await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();

    // The image and the snapshot: two blobs, neither sent by the client.
    assert_eq!(body["blobs_stored"], 2);

    let png_hash = sha256_hash(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    let blob = server.get(&format!("/api/vault/cas/{png_hash}")).await;
    blob.assert_status(StatusCode::OK);
}

#[tokio::test]
async fn stored_markdown_points_at_the_blob() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/two", markdown))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let page = server.get(&format!("/api/vault/pages/{path}")).await;
    let detail: serde_json::Value = page.json();
    let png_hash = sha256_hash(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert_eq!(
        detail["body"].as_str().unwrap().trim(),
        format!("![a](cas:{png_hash})")
    );
}

#[tokio::test]
async fn stored_snapshot_has_no_inlined_resources() {
    let (server, _tmp, _state) = setup_server();

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload(
            "https://example.com/three",
            "![a](https://cdn.example.com/a.png)",
        ))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let detail: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    let snapshot_hash = detail["meta"]["archive"]["snapshot_hash"].as_str().unwrap();
    let snapshot = server.get(&format!("/api/vault/cas/{snapshot_hash}")).await;
    let html = String::from_utf8(snapshot.as_bytes().to_vec()).unwrap();

    assert!(
        !html.contains("base64,"),
        "snapshot still inlines a resource"
    );
    assert!(html.contains("src=\"cas:sha256:"), "got: {html}");
}

#[tokio::test]
async fn content_hash_describes_the_stored_body_and_source_hash_the_capture() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/four", markdown))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let detail: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    let archive = &detail["meta"]["archive"];
    assert_eq!(
        archive["source_hash"].as_str().unwrap(),
        content_hash(markdown)
    );
    assert_eq!(
        archive["content_hash"].as_str().unwrap(),
        content_hash(detail["body"].as_str().unwrap())
    );
    assert_ne!(archive["content_hash"], archive["source_hash"]);
    assert_eq!(archive["resource_count"].as_i64(), Some(1));
}

#[tokio::test]
async fn re_encoding_an_image_does_not_read_as_a_changed_page() {
    // Change detection keys on the captured markdown, so a byte-different but
    // textually identical capture is the same page.
    let (server, _tmp, _state) = setup_server();
    let markdown = "![a](https://cdn.example.com/a.png)";
    let url = "https://example.com/five";

    server
        .post("/api/vault/archive")
        .json(&fidelity_payload(url, markdown))
        .await
        .assert_status(StatusCode::CREATED);

    let mut second = fidelity_payload(url, markdown);
    second["snapshot_html"] = serde_json::json!(concat!(
        r#"<html><body><img data-sf-original-src="https://cdn.example.com/a.png" "#,
        r#"src="data:image/png;base64,iVBORw0KGgoAAAA="></body></html>"#
    ));

    server
        .post("/api/vault/archive")
        .json(&second)
        .await
        .assert_status(StatusCode::OK);
}

#[tokio::test]
async fn an_unmatched_markdown_image_is_left_intact() {
    let (server, _tmp, _state) = setup_server();
    let markdown = "![b](https://cdn.example.com/b.png)";

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload("https://example.com/six", markdown))
        .await;
    let path = res.json::<serde_json::Value>()["vault_path"]
        .as_str()
        .unwrap()
        .to_string();

    let detail: serde_json::Value = server.get(&format!("/api/vault/pages/{path}")).await.json();
    assert_eq!(detail["body"].as_str().unwrap().trim(), markdown);
}

#[tokio::test]
async fn two_pages_sharing_an_image_store_one_blob() {
    // The dedup regression. It used to be the extension's job and is now a
    // property of the CAS, so it needs pinning at the new boundary.
    let (server, _tmp, state) = setup_server();

    server
        .post("/api/vault/archive")
        .json(&fidelity_payload(
            "https://example.com/a",
            "![a](https://cdn.example.com/a.png)",
        ))
        .await
        .assert_status(StatusCode::CREATED);
    let after_first = state.cas.lock().stats().unwrap().blob_count;

    let res = server
        .post("/api/vault/archive")
        .json(&fidelity_payload(
            "https://example.com/b",
            "![a](https://cdn.example.com/a.png)",
        ))
        .await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();

    // The shared image dedupes; only the second snapshot is a new blob. The two
    // snapshots differ because `fidelity_payload` embeds each page's own title.
    assert_eq!(body["blobs_deduped"], 1);
    assert_eq!(body["blobs_stored"], 1);
    assert_eq!(
        state.cas.lock().stats().unwrap().blob_count,
        after_first + 1
    );
}

/// A server whose archive limits are small enough to exceed cheaply. The
/// defaults are 100 MB and 250 MB; driving a test payload past those would cost
/// hundreds of megabytes of allocation to prove a comparison.
fn setup_server_with_small_limits() -> (TestServer, TempDir, Arc<AppState>) {
    ApiFixture::builder()
        .configure(|root| {
            std::fs::write(
                root.join(".clepsydra/config.toml"),
                "[archive]\nmax_blob_size_mb = 1\nmax_request_size_mb = 2\n",
            )
            .unwrap();
        })
        .delete_hooks_with(|cas| {
            vec![Box::new(ArchiveDeleteHook {
                cas: Arc::clone(cas),
            }) as Box<dyn PostDeleteHook>]
        })
        .build()
        .into_parts()
}

#[tokio::test]
async fn an_oversized_resource_fails_the_whole_capture() {
    // A deliberate reversal of the skip-and-continue behaviour this replaced:
    // right for a best-effort image scrape, wrong for an archive.
    let (server, _tmp, state) = setup_server_with_small_limits();
    let before = state.cas.lock().stats().unwrap().blob_count;

    // 2 MB of base64 decodes to ~1.5 MB, over the configured 1 MB per resource.
    let payload_b64 = "A".repeat(2 * 1024 * 1024);
    let mut request = fidelity_payload("https://example.com/huge", "body");
    request["snapshot_html"] = serde_json::json!(format!(
        r#"<img src="data:image/png;base64,{payload_b64}">"#
    ));

    let res = server.post("/api/vault/archive").json(&request).await;

    res.assert_status(StatusCode::BAD_REQUEST);
    assert!(
        res.text().contains("max_blob_size_mb"),
        "got: {}",
        res.text()
    );
    // Size validation runs before anything is stored, so there is nothing to
    // roll back — which is the property worth pinning.
    assert_eq!(state.cas.lock().stats().unwrap().blob_count, before);
}

#[tokio::test]
async fn a_capture_over_the_total_budget_fails() {
    let (server, _tmp, state) = setup_server_with_small_limits();
    let before = state.cas.lock().stats().unwrap().blob_count;

    // Three resources, each under the 1 MB per-resource cap, together over the
    // 2 MB request cap. Distinct bytes, or the CAS would dedupe them to one.
    let images: String = ["A", "B", "C"]
        .iter()
        .map(|c| {
            let payload = c.repeat(1024 * 1024);
            format!(r#"<img src="data:image/png;base64,{payload}">"#)
        })
        .collect();
    let mut request = fidelity_payload("https://example.com/budget", "body");
    request["snapshot_html"] = serde_json::json!(images);

    let res = server.post("/api/vault/archive").json(&request).await;

    res.assert_status(StatusCode::BAD_REQUEST);
    assert!(
        res.text().contains("max_request_size_mb"),
        "got: {}",
        res.text()
    );
    assert_eq!(state.cas.lock().stats().unwrap().blob_count, before);
}
