use std::fs;
use std::io::Write;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use super::events::SyncNotification;
use crate::vault::cas::ContentStore;
use crate::vault::page::{PageMeta, write_page_content};
use crate::vault::path::VaultPath;

#[derive(Debug, Deserialize)]
pub struct ArchiveRequest {
    pub url: String,
    pub canonical_url: Option<String>,
    pub domain: String,
    pub title: String,
    pub description: Option<String>,
    pub captured_at: String,
    pub content_hash: String,
    pub snapshot_hash: String,
    pub markdown_body: String,
    pub tags: Vec<String>,
    pub blobs: Vec<BlobUpload>,
}

#[derive(Debug, Deserialize)]
pub struct BlobUpload {
    pub hash: String,
    pub content_type: String,
    pub data: String, // base64
}

#[derive(Debug, Serialize)]
pub struct ArchiveResponse {
    pub page_id: String,
    pub vault_path: String,
    pub blobs_stored: u32,
    pub blobs_deduped: u32,
    pub status: ArchiveStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveStatus {
    Created,
    AlreadyExists,
    ContentChanged,
}

/// Build the archive router.
///
/// The body limit for the ingest endpoint is set by the caller via
/// `archive_router_with_limit` to respect the configured `max_request_size_mb`.
/// This default uses 100 MB.
pub fn router() -> Router<Arc<AppState>> {
    router_with_body_limit(100 * 1024 * 1024)
}

/// Build the archive router with a specific body size limit (in bytes).
pub fn router_with_body_limit(max_bytes: usize) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", post(ingest_archive))
        .route("/status", get(archive_status))
        .layer(axum::extract::DefaultBodyLimit::max(max_bytes))
}

pub fn cas_router() -> Router<Arc<AppState>> {
    Router::new().route("/{hash}", get(serve_blob))
}

/// Convert a title to a URL-safe slug, truncated to `max_len` characters.
pub(crate) fn slugify(title: &str, max_len: usize) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    // Collapse runs of dashes, trim leading/trailing dashes
    let collapsed: String = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let char_count = collapsed.chars().count();
    if char_count > max_len {
        let truncated: String = collapsed.chars().take(max_len).collect();
        // Truncate at a dash boundary if possible (rfind on '-' is safe: ASCII char)
        match truncated.rfind('-') {
            Some(pos) if pos > truncated.len() / 2 => truncated[..pos].to_string(),
            _ => truncated,
        }
    } else {
        collapsed
    }
}

async fn serve_blob(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let cas = state.cas.lock();
    let (data, content_type) = cas
        .retrieve(&hash)
        .map_err(|_| ApiError::not_found(format!("blob not found: {hash}")))?;

    Ok((StatusCode::OK, [(header::CONTENT_TYPE, content_type)], data).into_response())
}

async fn archive_status(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let cas = state.cas.lock();
    let stats = cas
        .stats()
        .map_err(|e| ApiError::internal(format!("stats: {e}")))?;

    Ok((
        StatusCode::OK,
        Json(serde_json::json!({
            "enabled": state.vault.config().archive.enabled,
            "blob_count": stats.blob_count,
            "total_size_bytes": stats.total_size_bytes,
        })),
    )
        .into_response())
}

async fn ingest_archive(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ArchiveRequest>,
) -> Result<Response, ApiError> {
    let archive_config = &state.vault.config().archive;

    if !archive_config.enabled {
        return Err(ApiError::forbidden(
            "archiving is disabled in server configuration".to_string(),
        ));
    }

    // Verify content_hash matches markdown_body (don't trust client-provided hash)
    let computed_content_hash = ContentStore::hash_bytes(req.markdown_body.as_bytes());
    if computed_content_hash != req.content_hash {
        return Err(ApiError::bad_request(format!(
            "content_hash mismatch: declared={}, computed={}",
            req.content_hash, computed_content_hash
        )));
    }

    // Enforce per-blob and total request size limits
    let max_blob_bytes = archive_config.max_blob_size_mb * 1024 * 1024;
    let max_request_bytes = archive_config.max_request_size_mb * 1024 * 1024;
    let mut total_blob_bytes: u64 = 0;
    for blob in &req.blobs {
        // Estimate decoded size from base64 length (3/4 ratio)
        let estimated_size = (blob.data.len() as u64) * 3 / 4;
        if estimated_size > max_blob_bytes {
            return Err(ApiError::bad_request(format!(
                "blob {} exceeds max_blob_size_mb ({} MB)",
                blob.hash, archive_config.max_blob_size_mb
            )));
        }
        total_blob_bytes += estimated_size;
    }
    if total_blob_bytes > max_request_bytes {
        return Err(ApiError::bad_request(format!(
            "total blob size (~{} bytes) exceeds max_request_size_mb ({} MB)",
            total_blob_bytes, archive_config.max_request_size_mb
        )));
    }

    let prefix = &archive_config.default_path_prefix;

    // Serialize the entire mutating section to prevent concurrent races
    // (duplicate URL check + path collision + file write + index commit).
    let _ingest_guard = state.archive_ingest_lock.lock().await;

    // 1. Check for existing archive of this URL via the index
    let existing = {
        let index = state.index.lock();
        index
            .find_by_archive_url(&req.url)
            .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
    };

    if let Some((page_id, vault_path, existing_hash)) = existing {
        if existing_hash == req.content_hash {
            return Ok((
                StatusCode::OK,
                Json(ArchiveResponse {
                    page_id,
                    vault_path,
                    blobs_stored: 0,
                    blobs_deduped: 0,
                    status: ArchiveStatus::AlreadyExists,
                }),
            )
                .into_response());
        } else {
            return Err(ApiError::conflict_with_detail(
                format!("archive exists with different content: {}", req.url),
                serde_json::json!({
                    "existing_hash": existing_hash,
                    "new_hash": req.content_hash,
                    "page_id": page_id,
                    "vault_path": vault_path,
                }),
            ));
        }
    }

    // 2. Validate path BEFORE touching CAS (prevents orphaned blobs on bad input)
    let slug = slugify(&req.title, 80);
    let slug = if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    };

    let base_path = format!("{}/{}/{}.md", prefix, req.domain, slug);
    let mut page_path = base_path.clone();

    // Handle path collisions with numeric suffix
    let vault_root = state.vault.root();
    let mut counter = 1u32;
    while vault_root.join(&page_path).exists() {
        page_path = format!("{}/{}/{}-{}.md", prefix, req.domain, slug, counter);
        counter += 1;
        if counter > 1000 {
            return Err(ApiError::internal(
                "too many path collisions for archive page".to_string(),
            ));
        }
    }

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    // 3. Decode and verify all blobs before storing anything (fail fast).
    //    Deduplicate by hash so duplicate entries don't inflate ref_counts.
    let mut seen_hashes = std::collections::HashSet::new();
    let mut decoded_blobs: Vec<(String, Vec<u8>, String)> = Vec::with_capacity(req.blobs.len());
    for blob in &req.blobs {
        if !seen_hashes.insert(blob.hash.clone()) {
            continue; // skip duplicate hash within same request
        }

        let data = BASE64
            .decode(&blob.data)
            .map_err(|e| ApiError::bad_request(format!("invalid base64 in blob: {e}")))?;

        let computed_hash = ContentStore::hash_bytes(&data);
        if computed_hash != blob.hash {
            return Err(ApiError::bad_request(format!(
                "blob hash mismatch: declared={}, computed={}",
                blob.hash, computed_hash
            )));
        }

        decoded_blobs.push((blob.hash.clone(), data, blob.content_type.clone()));
    }

    // 4. Store blobs in CAS (track stored hashes for rollback on downstream failure)
    let mut blobs_stored: u32 = 0;
    let mut blobs_deduped: u32 = 0;
    let mut stored_hashes: Vec<String> = Vec::new();

    for (hash, data, content_type) in &decoded_blobs {
        let cas = state.cas.lock();
        let result = cas
            .store(data, content_type)
            .map_err(|e| ApiError::internal(format!("CAS store error: {e}")))?;

        if result.already_existed {
            blobs_deduped += 1;
        } else {
            blobs_stored += 1;
        }
        stored_hashes.push(hash.clone());
    }

    // Helper: rollback CAS ref_counts on downstream failure
    let rollback_cas = |state: &AppState, hashes: &[String]| {
        let cas = state.cas.lock();
        for hash in hashes {
            let _ = cas.decrement_ref(hash);
        }
    };

    // 5. Create the vault page
    let abs_path = state.vault.resolve(&vault_path);

    if let Some(parent) = abs_path.parent()
        && let Err(e) = fs::create_dir_all(parent)
    {
        rollback_cas(&state, &stored_hashes);
        return Err(ApiError::internal(format!("failed to create directories: {e}")));
    }

    // Build PageMeta with archive metadata in extra
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();

    // Build archive metadata as a nested YAML mapping
    let mut archive_map = serde_yaml::Mapping::new();
    archive_map.insert(
        serde_yaml::Value::String("url".to_string()),
        serde_yaml::Value::String(req.url.clone()),
    );
    if let Some(ref canonical_url) = req.canonical_url {
        archive_map.insert(
            serde_yaml::Value::String("canonical_url".to_string()),
            serde_yaml::Value::String(canonical_url.clone()),
        );
    }
    archive_map.insert(
        serde_yaml::Value::String("domain".to_string()),
        serde_yaml::Value::String(req.domain.clone()),
    );
    archive_map.insert(
        serde_yaml::Value::String("captured_at".to_string()),
        serde_yaml::Value::String(req.captured_at.clone()),
    );
    archive_map.insert(
        serde_yaml::Value::String("content_hash".to_string()),
        serde_yaml::Value::String(req.content_hash.clone()),
    );
    archive_map.insert(
        serde_yaml::Value::String("snapshot_hash".to_string()),
        serde_yaml::Value::String(req.snapshot_hash.clone()),
    );
    if let Some(ref description) = req.description {
        archive_map.insert(
            serde_yaml::Value::String("description".to_string()),
            serde_yaml::Value::String(description.clone()),
        );
    }

    // Store blob hashes in frontmatter from the deduplicated set,
    // excluding snapshot_hash to avoid double ref_count decrement on delete.
    let non_snapshot_blobs: Vec<serde_yaml::Value> = decoded_blobs
        .iter()
        .filter(|(h, _, _)| *h != req.snapshot_hash)
        .map(|(h, _, _)| serde_yaml::Value::String(h.clone()))
        .collect();
    if !non_snapshot_blobs.is_empty() {
        archive_map.insert(
            serde_yaml::Value::String("blobs".to_string()),
            serde_yaml::Value::Sequence(non_snapshot_blobs),
        );
    }

    meta.extra.insert(
        "archive".to_string(),
        serde_yaml::Value::Mapping(archive_map),
    );

    let page_body = &req.markdown_body;

    // Write file atomically: create_new ensures we don't overwrite a file
    // created by a concurrent endpoint (e.g. POST /pages).
    let content = write_page_content(&meta, page_body);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs_path)
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(content.as_bytes()) {
                let _ = fs::remove_file(&abs_path);
                rollback_cas(&state, &stored_hashes);
                return Err(ApiError::internal(format!("failed to write file: {e}")));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            rollback_cas(&state, &stored_hashes);
            return Err(ApiError::conflict(format!(
                "path already exists (concurrent write): {}",
                vault_path.as_str()
            )));
        }
        Err(e) => {
            rollback_cas(&state, &stored_hashes);
            return Err(ApiError::internal(format!("failed to create file: {e}")));
        }
    }

    let page_id = meta.id.to_string();

    // 6. Index the page.
    // create_new above guarantees we own this file, so remove_file on
    // index failure is safe — no concurrent endpoint could have written it.
    {
        let mut index = state.index.lock();
        if let Err(e) = index.index_page(&state.vault, &vault_path) {
            let _ = fs::remove_file(&abs_path);
            rollback_cas(&state, &stored_hashes);
            return Err(ApiError::internal(e.to_string()));
        }
        // resolve_links failure is non-fatal (page exists, just links unresolved)
        let _ = index.resolve_links_for_page(&vault_path);
    }

    // 7. Broadcast change
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // 8. Return response
    Ok((
        StatusCode::CREATED,
        Json(ArchiveResponse {
            page_id,
            vault_path: vault_path.as_str().to_string(),
            blobs_stored,
            blobs_deduped,
            status: ArchiveStatus::Created,
        }),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World", 80), "hello-world");
    }

    #[test]
    fn slugify_special_chars() {
        assert_eq!(
            slugify("The Architecture of Open-Source Applications!", 80),
            "the-architecture-of-open-source-applications"
        );
    }

    #[test]
    fn slugify_truncates() {
        let long_title = "a ".repeat(50); // 100 chars worth
        let slug = slugify(&long_title, 20);
        assert!(slug.len() <= 20);
    }

    #[test]
    fn slugify_unicode() {
        // Unicode alphanumeric chars should be preserved
        assert_eq!(slugify("Über die Grenzen", 80), "über-die-grenzen");
    }

    #[test]
    fn slugify_empty() {
        assert_eq!(slugify("", 80), "");
    }

    #[test]
    fn slugify_all_special() {
        assert_eq!(slugify("---!!!", 80), "");
    }

    #[test]
    fn slugify_cjk_no_panic() {
        // CJK characters are multi-byte in UTF-8; byte-based truncation would panic
        let title = "漢".repeat(40); // 40 CJK chars, 120 bytes
        let slug = slugify(&title, 20);
        assert_eq!(slug.chars().count(), 20);
        // Verify it doesn't panic and is valid UTF-8
        assert!(slug.is_ascii() || !slug.is_empty() || slug.len() > 0);
    }

    #[test]
    fn slugify_mixed_unicode_truncation() {
        // Mix of ASCII and multi-byte chars
        let title = "café résumé à la mode extrêmement long titre pour tester";
        let slug = slugify(title, 30);
        assert!(slug.chars().count() <= 30);
    }
}
