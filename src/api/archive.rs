//! API endpoints for ingesting web page archives, including associated blobs stored in
//! the CAS.
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
use crate::vault::cas::ContentStore;
use crate::vault::index_policy::IndexMutation;
use crate::vault::mutation_coordinator::{CreatePageCommand, MutationCoordinator, MutationGuard};
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

#[derive(Debug, Deserialize, Clone)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompensationFailure {
    pub hash: String,
    pub error: String,
}

#[doc(hidden)]
pub fn compensate_hashes<E>(
    hashes: &[String],
    mut decrement: impl FnMut(&str) -> Result<(), E>,
) -> Vec<CompensationFailure>
where
    E: std::fmt::Display,
{
    let mut failures = Vec::new();
    for hash in hashes {
        if let Err(error) = decrement(hash) {
            failures.push(CompensationFailure {
                hash: hash.clone(),
                error: error.to_string(),
            });
        }
    }
    failures
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(hidden)]
pub enum PageCompensationAction {
    DeleteIndex,
    RebuildIndex,
}

#[doc(hidden)]
pub async fn compensate_page_with<
    Remove,
    RemoveFuture,
    RemoveError,
    Repair,
    RepairFuture,
    RepairError,
>(
    page_path: &str,
    remove_file: Remove,
    repair_index: Repair,
) -> Vec<CompensationFailure>
where
    Remove: FnOnce() -> RemoveFuture,
    RemoveFuture: Future<Output = Result<(), RemoveError>>,
    RemoveError: std::fmt::Display,
    Repair: FnOnce(PageCompensationAction) -> RepairFuture,
    RepairFuture: Future<Output = Result<(), RepairError>>,
    RepairError: std::fmt::Display,
{
    let mut failures = Vec::new();
    let action = match remove_file().await {
        Ok(()) => PageCompensationAction::DeleteIndex,
        Err(error) => {
            failures.push(CompensationFailure {
                hash: format!("page-file:{page_path}"),
                error: error.to_string(),
            });
            PageCompensationAction::RebuildIndex
        }
    };
    if let Err(error) = repair_index(action).await {
        let operation = match action {
            PageCompensationAction::DeleteIndex => "page-index-delete",
            PageCompensationAction::RebuildIndex => "page-index-rebuild",
        };
        failures.push(CompensationFailure {
            hash: format!("{operation}:{page_path}"),
            error: error.to_string(),
        });
    }
    failures
}
async fn lock_archive_page_compensation(
    coordinator: &MutationCoordinator,
    page_path: &VaultPath,
) -> MutationGuard {
    coordinator
        .lock_paths(std::slice::from_ref(page_path))
        .await
}

fn attach_compensation_failures(
    mut primary: ApiError,
    failures: &[CompensationFailure],
) -> ApiError {
    if failures.is_empty() {
        return primary;
    }
    let mut detail = match primary.detail.take() {
        Some(serde_json::Value::Object(detail)) => detail,
        Some(existing) => {
            let mut detail = serde_json::Map::new();
            detail.insert("primary_detail".to_string(), existing);
            detail
        }
        None => serde_json::Map::new(),
    };
    detail.insert(
        "compensation_failures".to_string(),
        serde_json::to_value(failures).expect("compensation failures serialize"),
    );
    primary.detail = Some(serde_json::Value::Object(detail));
    primary
}

#[doc(hidden)]
pub fn rollback_cas_with<E>(
    primary: ApiError,
    hashes: &[String],
    decrement: impl FnMut(&str) -> Result<(), E>,
) -> ApiError
where
    E: std::fmt::Display,
{
    let failures = compensate_hashes(hashes, decrement);
    for failure in &failures {
        tracing::error!(
            hash = %failure.hash,
            error = %failure.error,
            primary_error = %primary.error,
            "archive CAS compensation failed"
        );
    }
    attach_compensation_failures(primary, &failures)
}

fn rollback_cas(primary: ApiError, state: &AppState, hashes: &[String]) -> ApiError {
    let cas = state.cas.lock();
    rollback_cas_with(primary, hashes, |hash| cas.decrement_ref(hash))
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

/// Validate per-blob and total request sizes against configured MB limits.
fn validate_blob_sizes(
    blobs: &[BlobUpload],
    max_blob_size_mb: u64,
    max_request_size_mb: u64,
) -> Result<(), ApiError> {
    let max_blob_bytes = max_blob_size_mb * 1024 * 1024;
    let max_request_bytes = max_request_size_mb * 1024 * 1024;
    let mut total_blob_bytes: u64 = 0;
    for blob in blobs {
        let estimated_size = (blob.data.len() as u64) * 3 / 4;
        if estimated_size > max_blob_bytes {
            return Err(ApiError::bad_request(format!(
                "blob {} exceeds max_blob_size_mb ({} MB)",
                blob.hash, max_blob_size_mb
            )));
        }
        total_blob_bytes += estimated_size;
    }
    if total_blob_bytes > max_request_bytes {
        return Err(ApiError::bad_request(format!(
            "total blob size (~{} bytes) exceeds max_request_size_mb ({} MB)",
            total_blob_bytes, max_request_size_mb
        )));
    }
    Ok(())
}

/// Decode base64 blobs, dedup by hash, and verify each against its declared hash.
/// Returns `(hash, bytes, content_type)` per unique blob.
fn decode_and_verify_blobs(
    blobs: &[BlobUpload],
) -> Result<Vec<(String, Vec<u8>, String)>, ApiError> {
    let mut seen_hashes = std::collections::HashSet::new();
    let mut decoded_blobs: Vec<(String, Vec<u8>, String)> = Vec::with_capacity(blobs.len());
    for blob in blobs {
        if !seen_hashes.insert(blob.hash.clone()) {
            continue;
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
    Ok(decoded_blobs)
}

/// Resolve a non-colliding `{prefix}/{domain}/{slug}.md` page path. Empty slug
/// falls back to "untitled". `path_exists` lets tests inject collisions.
fn resolve_page_path(
    prefix: &str,
    domain: &str,
    slug: &str,
    path_exists: impl Fn(&str) -> bool,
) -> Result<String, ApiError> {
    let slug = if slug.is_empty() { "untitled" } else { slug };
    let mut page_path = format!("{prefix}/{domain}/{slug}.md");
    let mut counter = 1u32;
    while path_exists(&page_path) {
        page_path = format!("{prefix}/{domain}/{slug}-{counter}.md");
        counter += 1;
        if counter > 1000 {
            return Err(ApiError::internal(
                "too many path collisions for archive page".to_string(),
            ));
        }
    }
    Ok(page_path)
}

/// Build the PageMeta (with nested `archive` TOML table) for an ingest request.
/// `decoded_blobs` supplies the non-snapshot blob hash list stored in frontmatter.
fn build_archive_meta(
    req: &ArchiveRequest,
    decoded_blobs: &[(String, Vec<u8>, String)],
) -> PageMeta {
    fn ts(s: &str) -> toml::Value {
        toml::Value::String(s.to_string())
    }
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();

    let mut archive_map = toml::Table::new();
    archive_map.insert("url".into(), ts(&req.url));
    if let Some(ref canonical_url) = req.canonical_url {
        archive_map.insert("canonical_url".into(), ts(canonical_url));
    }
    archive_map.insert("domain".into(), ts(&req.domain));
    archive_map.insert("captured_at".into(), ts(&req.captured_at));
    archive_map.insert("content_hash".into(), ts(&req.content_hash));
    archive_map.insert("snapshot_hash".into(), ts(&req.snapshot_hash));
    if let Some(ref description) = req.description {
        archive_map.insert("description".into(), ts(description));
    }

    let non_snapshot_blobs: Vec<toml::Value> = decoded_blobs
        .iter()
        .filter(|(h, _, _)| *h != req.snapshot_hash)
        .map(|(h, _, _)| toml::Value::String(h.clone()))
        .collect();
    if !non_snapshot_blobs.is_empty() {
        archive_map.insert("blobs".into(), toml::Value::Array(non_snapshot_blobs));
    }

    meta.extra
        .insert("archive".to_string(), toml::Value::Table(archive_map));
    meta
}

#[derive(Debug)]
struct StoreBlobsFailure {
    primary: ApiError,
    ref_hashes: Vec<String>,
}

fn store_decoded_blobs_with<E>(
    decoded: &[(String, Vec<u8>, String)],
    mut store: impl FnMut(&[u8], &str) -> Result<bool, E>,
) -> Result<(u32, u32, Vec<String>), StoreBlobsFailure>
where
    E: std::fmt::Display,
{
    let mut stored = 0;
    let mut deduped = 0;
    let mut ref_hashes = Vec::new();
    for (hash, data, content_type) in decoded {
        let already_existed = match store(data, content_type) {
            Ok(already_existed) => already_existed,
            Err(error) => {
                return Err(StoreBlobsFailure {
                    primary: ApiError::internal(format!("CAS store error: {error}")),
                    ref_hashes,
                });
            }
        };
        if already_existed {
            deduped += 1;
        } else {
            stored += 1;
        }
        ref_hashes.push(hash.clone());
    }
    Ok((stored, deduped, ref_hashes))
}

/// Store decoded blobs in the CAS (locking per-iteration, matching the original),
/// returning `(stored, deduped, ref_hashes)`. `ref_hashes` lists EVERY touched
/// blob — both newly stored and deduplicated — because each had its ref-count
/// incremented and so must be decremented if a later step fails (rollback).
fn store_decoded_blobs(
    cas: &parking_lot::Mutex<ContentStore>,
    decoded: &[(String, Vec<u8>, String)],
) -> Result<(u32, u32, Vec<String>), StoreBlobsFailure> {
    store_decoded_blobs_with(decoded, |data, content_type| {
        cas.lock()
            .store(data, content_type)
            .map(|result| result.already_existed)
    })
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

    validate_blob_sizes(
        &req.blobs,
        archive_config.max_blob_size_mb,
        archive_config.max_request_size_mb,
    )?;

    let prefix = archive_config.default_path_prefix.clone();

    // Serialize the entire mutating section to prevent concurrent races
    // (duplicate URL check + path collision + file write + index commit).
    let _ingest_guard = state.archive_ingest_lock.lock().await;

    // 1. Check for existing archive of this URL via the index
    let url_for_lookup = req.url.clone();
    let existing = state
        .index
        .with_index(move |index, _vault| index.find_by_archive_url(&url_for_lookup))
        .await
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?;

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
    let vault_root = state.vault.root();
    let page_path =
        resolve_page_path(&prefix, &req.domain, &slug, |c| vault_root.join(c).exists())?;

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    // 3. Decode and verify all blobs before storing anything (fail fast).
    let decoded_blobs = decode_and_verify_blobs(&req.blobs)?;

    let (blobs_stored, blobs_deduped, stored_hashes) =
        match store_decoded_blobs(&state.cas, &decoded_blobs) {
            Ok(stored) => stored,
            Err(failure) => {
                return Err(rollback_cas(failure.primary, &state, &failure.ref_hashes));
            }
        };

    // 5. Create and index the page through the reviewed Created policy.
    let meta = build_archive_meta(&req, &decoded_blobs);
    let page_id = meta.id.to_string();
    let expected_page_content = write_page_content(&meta, &req.markdown_body);
    let notify = super::mutation_notifier(&state);
    if let Err(error) = state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path.clone(),
                meta,
                body: req.markdown_body,
            },
            notify,
        )
        .await
    {
        let mut compensation_failures = Vec::new();
        if error.filesystem_applied() {
            let _compensation_guard =
                lock_archive_page_compensation(&state.mutation_coordinator, &vault_path).await;
            let absolute = state.vault.resolve(&vault_path);
            let path = vault_path.as_str().to_string();
            let index_path = vault_path.clone();
            let repair_state = Arc::clone(&state);
            compensation_failures.extend(
                compensate_page_with(
                    &path,
                    || async {
                        match tokio::fs::read_to_string(&absolute).await {
                            Ok(current) if current == expected_page_content => {
                                tokio::fs::remove_file(&absolute)
                                    .await
                                    .map_err(|error| error.to_string())
                            }
                            Ok(_) => {
                                Err("archive page changed before compensation; preserving file"
                                    .to_string())
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                            Err(error) => Err(error.to_string()),
                        }
                    },
                    |action| async move {
                        let mutation = match action {
                            PageCompensationAction::DeleteIndex => IndexMutation::Deleted,
                            PageCompensationAction::RebuildIndex => IndexMutation::Created,
                        };
                        repair_state
                            .index
                            .apply_mutation(index_path, mutation)
                            .await
                            .map_err(|error| error.to_string())
                    },
                )
                .await,
            );
        }
        {
            let cas = state.cas.lock();
            compensation_failures.extend(compensate_hashes(&stored_hashes, |hash| {
                cas.decrement_ref(hash)
            }));
        }
        for failure in &compensation_failures {
            tracing::error!(
                target = %failure.hash,
                error = %failure.error,
                primary_error = %error,
                "archive compensation failed"
            );
        }
        let primary = crate::api::mutation_error(error);
        return Err(attach_compensation_failures(
            primary,
            &compensation_failures,
        ));
    }

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

    // ---------------------------------------------------------------------------
    // slugify tests (existing)
    // ---------------------------------------------------------------------------

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
        assert!(slug.is_ascii() || !slug.is_empty() || !slug.is_empty());
    }

    #[test]
    fn slugify_mixed_unicode_truncation() {
        // Mix of ASCII and multi-byte chars
        let title = "café résumé à la mode extrêmement long titre pour tester";
        let slug = slugify(title, 30);
        assert!(slug.chars().count() <= 30);
    }

    // ---------------------------------------------------------------------------
    // validate_blob_sizes tests
    // ---------------------------------------------------------------------------

    #[test]
    fn validate_blob_sizes_accepts_within_limits() {
        // 1 MB limit per blob, 10 MB total; data well under that
        let blobs = vec![BlobUpload {
            hash: String::new(),
            content_type: String::new(),
            data: "A".repeat(100),
        }];
        assert!(validate_blob_sizes(&blobs, 1, 10).is_ok());
    }

    #[test]
    fn validate_blob_sizes_rejects_oversized_blob() {
        // 1 MB limit; ~1.5 MB of base64 data → estimated ~1.125 MB decoded
        let blobs = vec![BlobUpload {
            hash: "testhash".to_string(),
            content_type: String::new(),
            // 1.5 MB of base64 chars → estimated decoded size = 1.5*1024*1024 * 3/4 > 1 MB
            data: "A".repeat(2 * 1024 * 1024),
        }];
        let err = validate_blob_sizes(&blobs, 1, 100).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("testhash") || msg.contains("max_blob_size_mb"));
    }

    #[test]
    fn validate_blob_sizes_rejects_oversized_request_total() {
        // 2 MB per blob, but 3 MB total limit; two blobs each ~1.5 MB decoded
        let large_data = "A".repeat(2 * 1024 * 1024); // ~1.5 MB decoded
        let blobs = vec![
            BlobUpload {
                hash: String::new(),
                content_type: String::new(),
                data: large_data.clone(),
            },
            BlobUpload {
                hash: String::new(),
                content_type: String::new(),
                data: large_data,
            },
        ];
        // per-blob limit = 2 MB (each passes), total limit = 2 MB (combined ~3 MB fails)
        let err = validate_blob_sizes(&blobs, 2, 2).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("max_request_size_mb") || msg.contains("total blob size"));
    }

    // ---------------------------------------------------------------------------
    // decode_and_verify_blobs tests
    // ---------------------------------------------------------------------------

    #[test]
    fn decode_and_verify_blobs_valid() {
        let data = b"hello archive blob";
        let hash = ContentStore::hash_bytes(data);
        let b64 = BASE64.encode(data);
        let blobs = vec![BlobUpload {
            hash: hash.clone(),
            content_type: "text/plain".to_string(),
            data: b64,
        }];
        let result = decode_and_verify_blobs(&blobs).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, hash);
        assert_eq!(result[0].1, data);
        assert_eq!(result[0].2, "text/plain");
    }

    #[test]
    fn decode_and_verify_blobs_deduplicates() {
        let data = b"duplicate blob data";
        let hash = ContentStore::hash_bytes(data);
        let b64 = BASE64.encode(data);
        let blob = BlobUpload {
            hash: hash.clone(),
            content_type: "image/png".to_string(),
            data: b64,
        };
        let blobs = vec![blob.clone(), blob];
        let result = decode_and_verify_blobs(&blobs).unwrap();
        assert_eq!(
            result.len(),
            1,
            "duplicate blob should be deduped to 1 entry"
        );
    }

    #[test]
    fn decode_and_verify_blobs_rejects_hash_mismatch() {
        let data = b"some data";
        let b64 = BASE64.encode(data);
        let blobs = vec![BlobUpload {
            hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_string(),
            content_type: "text/plain".to_string(),
            data: b64,
        }];
        let err = decode_and_verify_blobs(&blobs).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("hash mismatch") || msg.contains("mismatch"));
    }

    #[test]
    fn decode_and_verify_blobs_rejects_invalid_base64() {
        let blobs = vec![BlobUpload {
            hash: "sha256:anything".to_string(),
            content_type: "text/plain".to_string(),
            data: "not-valid-base64!!!".to_string(),
        }];
        let err = decode_and_verify_blobs(&blobs).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("base64") || msg.contains("invalid"));
    }

    // ---------------------------------------------------------------------------
    // resolve_page_path tests
    // ---------------------------------------------------------------------------

    #[test]
    fn resolve_page_path_empty_slug_becomes_untitled() {
        let path = resolve_page_path("archive", "example.com", "", |_| false).unwrap();
        assert!(
            path.contains("untitled"),
            "empty slug should fall back to 'untitled', got: {path}"
        );
    }

    #[test]
    fn resolve_page_path_collision_appends_counter() {
        let base = "archive/example.com/my-article.md";
        // path_exists returns true only for the base path, forcing one counter increment
        let path =
            resolve_page_path("archive", "example.com", "my-article", |c| c == base).unwrap();
        assert_ne!(path, base, "collided path should differ from base");
        assert!(
            path.contains("-1"),
            "collision should append -1 counter, got: {path}"
        );
    }

    #[test]
    fn resolve_page_path_too_many_collisions_returns_err() {
        // Every candidate "exists" -> the counter blows past 1000 and bails out.
        let result = resolve_page_path("archive", "example.com", "slug", |_| true);
        let err = result.expect_err("unbounded collisions should error");
        assert!(
            format!("{err:?}").contains("too many path collisions"),
            "unexpected error: {err:?}"
        );
    }

    // ---------------------------------------------------------------------------
    // build_archive_meta tests
    // ---------------------------------------------------------------------------

    #[test]
    fn build_archive_meta_sets_archive_key() {
        let req = ArchiveRequest {
            url: "https://example.com/test".to_string(),
            canonical_url: None,
            domain: "example.com".to_string(),
            title: "Test Article".to_string(),
            description: None,
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            content_hash: "sha256:abc".to_string(),
            snapshot_hash: "sha256:def".to_string(),
            markdown_body: "# Test".to_string(),
            tags: vec!["archive".to_string()],
            blobs: vec![],
        };
        let meta = build_archive_meta(&req, &[]);
        assert!(
            meta.extra.contains_key("archive"),
            "meta.extra should have 'archive' key"
        );
        assert_eq!(meta.title, Some("Test Article".to_string()));
    }

    #[test]
    fn build_archive_meta_includes_optional_fields_and_filters_snapshot_blob() {
        let req = ArchiveRequest {
            url: "https://example.com/test".to_string(),
            canonical_url: Some("https://example.com/canonical".to_string()),
            domain: "example.com".to_string(),
            title: "Test Article".to_string(),
            description: Some("a description".to_string()),
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            content_hash: "sha256:abc".to_string(),
            snapshot_hash: "sha256:snap".to_string(),
            markdown_body: "# Test".to_string(),
            tags: vec![],
            blobs: vec![],
        };
        // One ordinary blob plus the snapshot blob; only the former should appear.
        let decoded = vec![
            ("sha256:img".to_string(), vec![1u8], "image/png".to_string()),
            (
                "sha256:snap".to_string(),
                vec![2u8],
                "text/html".to_string(),
            ),
        ];
        let meta = build_archive_meta(&req, &decoded);

        let archive = match meta.extra.get("archive") {
            Some(toml::Value::Table(m)) => m,
            other => panic!("expected archive mapping, got {other:?}"),
        };
        let get = |k: &str| archive.get(k);
        assert_eq!(
            get("canonical_url").and_then(|v| v.as_str()),
            Some("https://example.com/canonical")
        );
        assert_eq!(
            get("description").and_then(|v| v.as_str()),
            Some("a description")
        );
        let blobs = get("blobs")
            .and_then(|v| v.as_array())
            .expect("blobs array present");
        let blob_hashes: Vec<&str> = blobs.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(
            blob_hashes,
            vec!["sha256:img"],
            "snapshot_hash must be excluded from the blobs list"
        );
    }

    // ---------------------------------------------------------------------------
    // store_decoded_blobs tests (real CAS over tempdir)
    // ---------------------------------------------------------------------------

    #[test]
    fn store_decoded_blobs_new_and_dedup() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cas = parking_lot::Mutex::new(ContentStore::open(&tmp.path().join("cas")).unwrap());
        let decoded = vec![("h".to_string(), b"abc".to_vec(), "text/plain".to_string())];

        // First store: should be new
        let (stored, deduped, hashes) = store_decoded_blobs(&cas, &decoded).unwrap();
        assert_eq!(stored, 1);
        assert_eq!(deduped, 0);
        assert_eq!(hashes.len(), 1);

        // Second store of the same data: should be deduped
        let (stored2, deduped2, _) = store_decoded_blobs(&cas, &decoded).unwrap();
        assert_eq!(stored2, 0);
        assert_eq!(deduped2, 1);
    }

    #[test]
    fn store_failure_returns_every_previously_incremented_hash() {
        let decoded = vec![
            (
                "sha256:first".to_string(),
                vec![1],
                "first/type".to_string(),
            ),
            (
                "sha256:second".to_string(),
                vec![2],
                "second/type".to_string(),
            ),
            (
                "sha256:third".to_string(),
                vec![3],
                "third/type".to_string(),
            ),
        ];
        let mut attempts = 0;

        let failure = store_decoded_blobs_with(&decoded, |_data, _content_type| {
            attempts += 1;
            if attempts == 2 {
                Err("deterministic store failure")
            } else {
                Ok(false)
            }
        })
        .unwrap_err();

        assert_eq!(attempts, 2);
        assert_eq!(
            failure.primary.error,
            "CAS store error: deterministic store failure"
        );
        assert_eq!(failure.ref_hashes, vec!["sha256:first"]);
    }

    #[test]
    fn rollback_attempts_every_hash_and_collects_failures_in_order() {
        let hashes = vec![
            "sha256:first".to_string(),
            "sha256:second".to_string(),
            "sha256:third".to_string(),
        ];
        let mut attempted = Vec::new();

        let failures = compensate_hashes(&hashes, |hash| {
            attempted.push(hash.to_string());
            if hash == "sha256:first" || hash == "sha256:third" {
                Err(format!("cannot decrement {hash}"))
            } else {
                Ok(())
            }
        });

        assert_eq!(attempted, hashes);
        assert_eq!(
            failures,
            vec![
                CompensationFailure {
                    hash: "sha256:first".to_string(),
                    error: "cannot decrement sha256:first".to_string(),
                },
                CompensationFailure {
                    hash: "sha256:third".to_string(),
                    error: "cannot decrement sha256:third".to_string(),
                },
            ]
        );
    }

    #[test]
    fn rollback_error_context_preserves_primary_error() {
        let primary = ApiError::internal("index creation failed");
        let failures = vec![CompensationFailure {
            hash: "sha256:cleanup".to_string(),
            error: "CAS unavailable".to_string(),
        }];

        let error = attach_compensation_failures(primary, &failures);

        assert_eq!(error.status, 500);
        assert_eq!(error.error, "index creation failed");
        assert_eq!(
            error.detail,
            Some(serde_json::json!({
                "compensation_failures": [{
                    "hash": "sha256:cleanup",
                    "error": "CAS unavailable",
                }]
            }))
        );
    }

    #[tokio::test]
    async fn page_compensation_rebuilds_index_after_file_removal_failure_and_aggregates_errors() {
        let mut actions = Vec::new();
        let failures = compensate_page_with(
            "archives/page.md",
            || async { Err::<(), _>("file is busy") },
            |action| {
                actions.push(action);
                async { Err::<(), _>("index unavailable") }
            },
        )
        .await;

        assert_eq!(actions, vec![PageCompensationAction::RebuildIndex]);
        assert_eq!(
            failures,
            vec![
                CompensationFailure {
                    hash: "page-file:archives/page.md".to_string(),
                    error: "file is busy".to_string(),
                },
                CompensationFailure {
                    hash: "page-index-rebuild:archives/page.md".to_string(),
                    error: "index unavailable".to_string(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn page_compensation_deletes_index_only_after_file_removal_succeeds() {
        let mut actions = Vec::new();
        let failures = compensate_page_with(
            "archives/page.md",
            || async { Ok::<(), String>(()) },
            |action| {
                actions.push(action);
                async { Ok::<(), String>(()) }
            },
        )
        .await;

        assert!(failures.is_empty());
        assert_eq!(actions, vec![PageCompensationAction::DeleteIndex]);
    }

    #[tokio::test]
    async fn archive_compensation_waits_for_the_page_mutation_lock() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let page_path = VaultPath::new("archives/page.md").unwrap();
        let mutation_guard = coordinator
            .lock_paths(std::slice::from_ref(&page_path))
            .await;
        let contender = Arc::clone(&coordinator);
        let contender_path = page_path.clone();
        let compensation = tokio::spawn(async move {
            lock_archive_page_compensation(&contender, &contender_path).await
        });
        let mut compensation = Box::pin(compensation);

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut compensation)
                .await
                .is_err(),
            "archive compensation entered while a page mutation guard was held"
        );

        drop(mutation_guard);
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut compensation)
            .await
            .expect("archive compensation remained blocked after mutation completed")
            .unwrap();
    }
}
