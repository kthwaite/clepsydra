//! API endpoints for ingesting web page archives, including associated blobs stored in
//! the CAS.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use url::Host;

use super::AppState;
use super::error::ApiError;
use crate::ServerSettings;
use crate::vault::archive_snapshot::{self, SnapshotResource};
use crate::vault::cas::ContentStore;
use crate::vault::index_policy::IndexMutation;
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::{CreatePageCommand, MutationCoordinator, MutationGuard};
use crate::vault::page::{PageMeta, write_page_content};
use crate::vault::path::VaultPath;

#[derive(Debug, Deserialize, ToSchema)]
pub struct ArchiveRequest {
    pub url: String,
    pub canonical_url: Option<String>,
    pub domain: String,
    pub title: String,
    pub description: Option<String>,
    pub captured_at: String,
    /// sha256 of `markdown_body` exactly as sent. Verified on arrival as a
    /// transport check, then stored as `archive.source_hash`.
    pub content_hash: String,
    /// The SingleFile capture, resources still inlined as `data:` URIs. The
    /// server deconstructs it; the extension does not hash or split it.
    pub snapshot_html: String,
    pub markdown_body: String,
    pub tags: Vec<String>,
    /// Article byline, as parsed by Readability in the page context.
    #[serde(default)]
    pub byline: Option<String>,
    /// Publication name (og:site_name or equivalent).
    #[serde(default)]
    pub site_name: Option<String>,
    /// Publication timestamp declared by the page, verbatim.
    #[serde(default)]
    pub published_time: Option<String>,
    /// BCP-47 language tag declared by the document.
    #[serde(default)]
    pub lang: Option<String>,
    /// Short summary extracted from the article body.
    #[serde(default)]
    pub excerpt: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArchiveResponse {
    pub page_id: String,
    pub vault_path: String,
    pub blobs_stored: u32,
    pub blobs_deduped: u32,
    pub status: ArchiveStatus,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveStatus {
    Created,
    AlreadyExists,
    ContentChanged,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArchiveStatsResponse {
    pub enabled: bool,
    pub blob_count: u64,
    pub total_size_bytes: u64,
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

/// The HTTP body limit implied by a decoded-content budget.
///
/// `max_request_size_mb` budgets decoded snapshot, resource, and Markdown
/// bytes. The request carries base64 resources inside a JSON envelope, so the
/// transport allowance is twice that semantic budget plus one MiB of envelope
/// headroom.
pub(crate) fn archive_body_limit_bytes(max_request_size_mb: u64) -> usize {
    let budget = usize::try_from(max_request_size_mb)
        .unwrap_or(usize::MAX)
        .saturating_mul(1024 * 1024);
    budget.saturating_mul(2).saturating_add(1024 * 1024)
}

/// Immutable response policy for the dedicated archive snapshot view.
///
/// The complete CSP value is assembled once from server configuration. Request
/// headers never participate in the policy.
#[derive(Clone, Debug)]
pub struct ArchiveViewConfig {
    content_security_policy: HeaderValue,
}

impl ArchiveViewConfig {
    pub fn from_server_settings(settings: &ServerSettings) -> Result<Self, String> {
        let raw_host = settings.server_host_for_origin()?;
        let host = match raw_host {
            Host::Domain(host) => host,
            Host::Ipv4(host) => host.to_string(),
            Host::Ipv6(host) => format!("[{host}]"),
        };
        let scheme = if settings.tls.enabled { "https" } else { "http" };
        let origin = format!("{scheme}://{host}:{}", settings.port);
        let policy = format!(
            "sandbox; default-src 'none'; img-src {origin} data:; \
             media-src {origin} data:; style-src 'unsafe-inline' {origin} data:; \
             font-src {origin} data:"
        );
        let content_security_policy = HeaderValue::from_str(&policy)
            .map_err(|error| format!("invalid archive view CSP from server configuration: {error}"))?;
        Ok(Self {
            content_security_policy,
        })
    }
}

impl Default for ArchiveViewConfig {
    fn default() -> Self {
        Self::from_server_settings(&ServerSettings::default())
            .expect("default server settings must produce a valid archive view origin")
    }
}

/// Build the archive router.
///
/// The body limit applies only to archive ingest. Snapshot views and status
/// requests do not consume the ingest budget.
pub fn router() -> Router<Arc<AppState>> {
    router_with_body_limit(
        archive_body_limit_bytes(250),
        ArchiveViewConfig::default(),
    )
}

/// Build the archive router with a specific ingest body size limit (in bytes).
pub fn router_with_body_limit(
    max_bytes: usize,
    view_config: ArchiveViewConfig,
) -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/",
            post(ingest_archive).layer(axum::extract::DefaultBodyLimit::max(max_bytes)),
        )
        .route("/status", get(archive_status))
        .route("/view/{hash}", get(view_snapshot))
        .layer(Extension(view_config))
}

pub fn cas_router() -> Router<Arc<AppState>> {
    Router::new().route("/{hash}", get(serve_blob))
}

const OCTET_STREAM: &str = "application/octet-stream";

/// Content types that execute script when navigated to directly. These are
/// forced to download rather than render, so archived page markup can never run
/// on the vault origin. Images stay inline so archived markdown still renders.
fn is_active_content(content_type: &str) -> bool {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "text/html"
            | "application/xhtml+xml"
            | "image/svg+xml"
            | "text/xml"
            | "application/xml"
            | "application/rdf+xml"
            | "text/xsl"
    )
}

/// Only captured HTML is valid on the dedicated framable route.
fn framable_content_type(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("text/html")
}

fn sandbox_headers(config: &ArchiveViewConfig) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        config.content_security_policy.clone(),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers
}

const STORED_CAS_URL_PREFIX: &[u8] = b"cas:sha256:";
const SERVED_CAS_URL_PREFIX: &[u8] = b"/api/vault/cas/";
const SHA256_HEX_LEN: usize = 64;

fn cas_url_boundary(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b'"' | b'\'' | b')' | b'>')
}

fn cas_url_start_boundary(data: &[u8], start: usize) -> bool {
    start == 0
        || data[start - 1].is_ascii_whitespace()
        || matches!(data[start - 1], b'"' | b'\'' | b'(' | b'=' | b',')
}

fn find_cas_url(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut search_start = from;
    while let Some(offset) = data[search_start..]
        .windows(STORED_CAS_URL_PREFIX.len())
        .position(|window| window == STORED_CAS_URL_PREFIX)
    {
        let start = search_start + offset;
        let hash_start = start + STORED_CAS_URL_PREFIX.len();
        let end = hash_start + SHA256_HEX_LEN;
        let canonical_hash = end <= data.len()
            && data[hash_start..end]
                .iter()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
        let bounded = canonical_hash
            && cas_url_start_boundary(data, start)
            && (end == data.len() || cas_url_boundary(data[end]));
        if bounded {
            return Some((start, end));
        }
        search_start = start + 1;
    }
    None
}

/// Resolve canonical, origin-independent stored CAS URLs for the browser.
fn rewrite_cas_urls(data: Vec<u8>) -> Vec<u8> {
    let mut occurrences = 0usize;
    let mut search_start = 0;
    while let Some((_, end)) = find_cas_url(&data, search_start) {
        occurrences += 1;
        search_start = end;
    }
    if occurrences == 0 {
        return data;
    }

    let extra_bytes = occurrences.saturating_mul(SERVED_CAS_URL_PREFIX.len() - b"cas:".len());
    let mut rewritten = Vec::with_capacity(data.len().saturating_add(extra_bytes));
    let mut copied_through = 0;
    search_start = 0;
    while let Some((start, end)) = find_cas_url(&data, search_start) {
        rewritten.extend_from_slice(&data[copied_through..start]);
        rewritten.extend_from_slice(SERVED_CAS_URL_PREFIX);
        copied_through = start + b"cas:".len();
        search_start = end;
    }
    rewritten.extend_from_slice(&data[copied_through..]);
    rewritten
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

/// Reject a capture that exceeds the configured limits.
///
/// Unlike the resource scrape this replaced, an oversized capture fails the
/// whole archive rather than being trimmed: a snapshot missing arbitrary
/// resources is not a snapshot. The per-resource limit also bounds what
/// SingleFile is configured to inline, so hitting it here means the extension's
/// limit and the server's disagree.
fn validate_resource_sizes(
    resources: &[SnapshotResource],
    snapshot_len: usize,
    markdown_len: usize,
    max_blob_size_mb: u64,
    max_request_size_mb: u64,
) -> Result<(), ApiError> {
    let max_blob_bytes = max_blob_size_mb.saturating_mul(1024 * 1024);
    let max_request_bytes = max_request_size_mb.saturating_mul(1024 * 1024);
    let request_size_overflow = || {
        ApiError::bad_request(format!(
            "capture size overflow, over max_request_size_mb ({max_request_size_mb} MB)"
        ))
    };
    let mut total = u64::try_from(snapshot_len)
        .ok()
        .and_then(|snapshot| {
            u64::try_from(markdown_len)
                .ok()
                .and_then(|markdown| snapshot.checked_add(markdown))
        })
        .ok_or_else(&request_size_overflow)?;
    for resource in resources {
        let size = u64::try_from(resource.bytes.len()).map_err(|_| request_size_overflow())?;
        if size > max_blob_bytes {
            return Err(ApiError::bad_request(format!(
                "archived resource {} is {} bytes, over max_blob_size_mb ({} MB)",
                resource.hash, size, max_blob_size_mb
            )));
        }
        total = total.checked_add(size).ok_or_else(&request_size_overflow)?;
    }
    if total > max_request_bytes {
        return Err(ApiError::bad_request(format!(
            "capture is {total} bytes, over max_request_size_mb ({max_request_size_mb} MB)"
        )));
    }
    Ok(())
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

/// The four hashes an archive page records, all computed by the server.
struct ArchiveHashes {
    /// Over the markdown as captured, before rewriting. Change detection keys on
    /// this, so a re-encoded image does not read as "the page changed".
    source_hash: String,
    /// Over the markdown as stored, after rewriting. Archived bodies are
    /// write-protected on the stated grounds that this describes the stored
    /// body, so it must be computed post-rewrite or that justification fails.
    content_hash: String,
    snapshot_hash: String,
    /// Every deconstructed resource, excluding the snapshot itself. The delete
    /// hook decrements each of these.
    resource_hashes: Vec<String>,
}

/// Build the PageMeta (with nested `archive` TOML table) for an ingest request.
fn build_archive_meta(req: &ArchiveRequest, hashes: &ArchiveHashes) -> PageMeta {
    fn ts(s: &str) -> toml::Value {
        toml::Value::String(s.to_string())
    }
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();
    // Declared explicitly rather than left to folder inference, so an archived
    // page is distinguishable from an ordinary note wherever it is filed.
    meta.kind = Some(Kind::Archive);

    let mut archive_map = toml::Table::new();
    archive_map.insert("url".into(), ts(&req.url));
    if let Some(ref canonical_url) = req.canonical_url {
        archive_map.insert("canonical_url".into(), ts(canonical_url));
    }
    archive_map.insert("domain".into(), ts(&req.domain));
    archive_map.insert("captured_at".into(), ts(&req.captured_at));
    archive_map.insert("content_hash".into(), ts(&hashes.content_hash));
    archive_map.insert("source_hash".into(), ts(&hashes.source_hash));
    archive_map.insert("snapshot_hash".into(), ts(&hashes.snapshot_hash));
    archive_map.insert(
        "resource_count".into(),
        toml::Value::Integer(hashes.resource_hashes.len() as i64),
    );
    if let Some(ref description) = req.description {
        archive_map.insert("description".into(), ts(description));
    }
    for (key, value) in [
        ("byline", &req.byline),
        ("site_name", &req.site_name),
        ("published_time", &req.published_time),
        ("lang", &req.lang),
        ("excerpt", &req.excerpt),
    ] {
        if let Some(value) = value.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
            archive_map.insert(key.into(), ts(value));
        }
    }

    if !hashes.resource_hashes.is_empty() {
        let blobs: Vec<toml::Value> = hashes
            .resource_hashes
            .iter()
            .map(|h| toml::Value::String(h.clone()))
            .collect();
        archive_map.insert("blobs".into(), toml::Value::Array(blobs));
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

#[utoipa::path(
    get,
    path = "/archive/view/{hash}",
    context_path = "/api/vault",
    tag = "Archive",
    params(("hash" = String, Path, description = "Archived snapshot blob hash")),
    responses(
        (status = 200, description = "Sandboxed archived HTML snapshot", body = String, content_type = "text/html"),
        (status = 404, description = "Snapshot blob not found", body = ApiError),
        (status = 415, description = "Blob is not an HTML snapshot", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn view_snapshot(
    State(state): State<Arc<AppState>>,
    Extension(config): Extension<ArchiveViewConfig>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let (data, content_type) = {
        let cas = state.cas.lock();
        cas.retrieve(&hash)
            .map_err(|_| ApiError::not_found(format!("snapshot not found: {hash}")))?
    };
    if !framable_content_type(&content_type) {
        let error = ApiError {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE.as_u16(),
            error: format!("snapshot is not text/html: {content_type}"),
            detail: None,
            hint: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-clepsydra-archive-content-type",
            HeaderValue::from_str(&content_type)
                .unwrap_or_else(|_| HeaderValue::from_static(OCTET_STREAM)),
        );
        return Ok((StatusCode::UNSUPPORTED_MEDIA_TYPE, headers, Json(error)).into_response());
    }

    Ok((
        StatusCode::OK,
        sandbox_headers(&config),
        rewrite_cas_urls(data),
    )
        .into_response())
}

#[utoipa::path(
    get,
    path = "/cas/{hash}",
    context_path = "/api/vault",
    tag = "Archive",
    params(("hash" = String, Path, description = "Content-addressed blob hash")),
    responses(
        (status = 200, description = "Archived blob bytes", body = String, content_type = "application/octet-stream"),
        (status = 404, description = "Blob not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn serve_blob(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Response, ApiError> {
    let cas = state.cas.lock();
    let (data, content_type) = cas
        .retrieve(&hash)
        .map_err(|_| ApiError::not_found(format!("blob not found: {hash}")))?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static(OCTET_STREAM)),
    );
    // Blob bytes are authored by whatever page was archived. They are served
    // from the vault's own origin, alongside an unauthenticated API, so they
    // must never be treated as trusted same-origin content.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if is_active_content(&content_type) {
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }

    Ok((StatusCode::OK, headers, data).into_response())
}

#[utoipa::path(
    get,
    path = "/archive/status",
    context_path = "/api/vault",
    tag = "Archive",
    responses(
        (status = 200, description = "Archive service status", body = ArchiveStatsResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn archive_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ArchiveStatsResponse>, ApiError> {
    let cas = state.cas.lock();
    let stats = cas
        .stats()
        .map_err(|e| ApiError::internal(format!("stats: {e}")))?;

    Ok(Json(ArchiveStatsResponse {
        enabled: state.vault.config().archive.enabled,
        blob_count: stats.blob_count,
        total_size_bytes: stats.total_size_bytes,
    }))
}

#[utoipa::path(
    post,
    path = "/archive",
    context_path = "/api/vault",
    tag = "Archive",
    request_body = ArchiveRequest,
    responses(
        (status = 200, description = "Archive already exists", body = ArchiveResponse),
        (status = 201, description = "Archive created", body = ArchiveResponse),
        (status = 400, description = "Invalid archive payload", body = ApiError),
        (status = 403, description = "Archiving disabled", body = ApiError),
        (status = 409, description = "Archive content conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn ingest_archive(
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
    // The verified transport hash is exactly "the markdown as captured".
    let source_hash = req.content_hash.clone();

    let prefix = archive_config.default_path_prefix.clone();
    let max_blob_size_mb = archive_config.max_blob_size_mb;
    let max_request_size_mb = archive_config.max_request_size_mb;

    // Serializes the whole ingest: the duplicate-URL check, path-collision
    // resolution, the CAS/file writes, and the index commit. Without it, two
    // concurrent captures of the same URL could both pass the duplicate check
    // and race to create two pages for one archive.
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
        if existing_hash == source_hash {
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
        }
        return Err(ApiError::conflict_with_detail(
            format!("archive exists with different content: {}", req.url),
            serde_json::json!({
                "existing_hash": existing_hash,
                "new_hash": source_hash,
                "page_id": page_id,
                "vault_path": vault_path,
            }),
        ));
    }

    // 2. Validate path BEFORE touching CAS (prevents orphaned blobs on bad input)
    let slug = slugify(&req.title, 80);
    let vault_root = state.vault.root();
    let page_path =
        resolve_page_path(&prefix, &req.domain, &slug, |c| vault_root.join(c).exists())?;

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    // 3. Deconstruct the snapshot and rewrite both artifacts from one map. The
    //    server is the only component that decides what a resource's identity
    //    is; splitting that across the extension let the markdown and the
    //    snapshot disagree about what they referenced.
    let deconstructed = archive_snapshot::deconstruct(&req.snapshot_html);
    validate_resource_sizes(
        &deconstructed.resources,
        deconstructed.html.len(),
        req.markdown_body.len(),
        max_blob_size_mb,
        max_request_size_mb,
    )?;

    // The map is built from the rewritten snapshot, because it pairs each
    // `data-sf-original-src` with the `cas:` reference that just replaced that
    // element's `src`.
    let url_map = archive_snapshot::original_url_map(&deconstructed.html, &req.url);
    let markdown_body =
        archive_snapshot::rewrite_markdown_images(&req.markdown_body, &url_map, &req.url);
    let content_hash = ContentStore::hash_bytes(markdown_body.as_bytes());

    let snapshot_bytes = deconstructed.html.into_bytes();
    let snapshot_hash = ContentStore::hash_bytes(&snapshot_bytes);

    let resource_hashes: Vec<String> = deconstructed
        .resources
        .iter()
        .map(|r| r.hash.clone())
        .collect();

    let mut to_store: Vec<(String, Vec<u8>, String)> = deconstructed
        .resources
        .into_iter()
        .map(|r| (r.hash, r.bytes, r.content_type))
        .collect();
    to_store.push((
        snapshot_hash.clone(),
        snapshot_bytes,
        "text/html".to_string(),
    ));

    let (blobs_stored, blobs_deduped, stored_hashes) =
        match store_decoded_blobs(&state.cas, &to_store) {
            Ok(stored) => stored,
            Err(failure) => {
                return Err(rollback_cas(failure.primary, &state, &failure.ref_hashes));
            }
        };

    // 4. Create and index the page through the reviewed Created policy.
    let meta = build_archive_meta(
        &req,
        &ArchiveHashes {
            source_hash,
            content_hash,
            snapshot_hash,
            resource_hashes,
        },
    );
    let page_id = meta.id.to_string();
    let expected_page_content = write_page_content(&meta, &markdown_body);
    let notify = super::mutation_notifier(state.as_ref());
    if let Err(error) = state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path.clone(),
                meta,
                body: markdown_body,
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

    // 5. Return response
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
    // archive_body_limit_bytes tests
    // ---------------------------------------------------------------------------

    #[test]
    fn the_body_limit_exceeds_the_decoded_budget_it_guards() {
        // If these ever converge, an over-budget capture 413s before
        // validate_resource_sizes can report which limit it broke.
        let budget_bytes = 250 * 1024 * 1024;
        assert!(archive_body_limit_bytes(250) > budget_bytes);
    }

    #[test]
    fn markdown_bytes_count_toward_the_capture_budget() {
        let resources = Vec::new();
        let error = validate_resource_sizes(&resources, 1024 * 1024, 1024 * 1024 + 1, 100, 2)
            .expect_err("snapshot plus markdown exceeds two MiB");
        assert!(error.error.contains("max_request_size_mb"));
    }

    #[test]
    fn semantic_limits_saturate_for_unrepresentable_budgets() {
        validate_resource_sizes(&[], 1, 1, u64::MAX, u64::MAX)
            .expect("unrepresentable MiB ceilings should behave as unbounded byte ceilings");
    }

    #[test]
    fn body_limit_is_twice_budget_plus_envelope_headroom() {
        assert_eq!(archive_body_limit_bytes(2), 5 * 1024 * 1024);
    }

    #[test]
    fn body_limit_saturates_for_unrepresentable_budgets() {
        assert_eq!(archive_body_limit_bytes(u64::MAX), usize::MAX);
    }

    #[cfg(target_pointer_width = "32")]
    #[test]
    fn body_limit_saturates_when_budget_exceeds_usize() {
        assert_eq!(
            archive_body_limit_bytes(u64::from(u32::MAX) + 1),
            usize::MAX
        );
    }

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
    fn archive_kind_folder_matches_configured_prefix() {
        // If these drift, declaring Kind::Archive would relocate every existing
        // archived page on the next projection sweep.
        assert_eq!(
            Kind::Archive.canonical_folder(),
            crate::vault::config::ArchiveSection::default().default_path_prefix,
        );
    }

    #[test]
    fn declaring_archive_kind_leaves_existing_pages_in_place() {
        use crate::vault::projection::project_path;
        assert_eq!(
            project_path("archive/example.com/a-post.md", Some(Kind::Archive), None),
            None,
            "an archived page must not move when its kind is declared"
        );
    }

    #[test]
    fn build_archive_meta_declares_the_archive_kind() {
        let req = request_fixture();
        let meta = build_archive_meta(&req, &hashes_fixture());
        assert_eq!(meta.kind, Some(Kind::Archive));
    }

    #[test]
    fn build_archive_meta_carries_readability_provenance() {
        let mut req = request_fixture();
        req.byline = Some("Ada Lovelace".to_string());
        req.site_name = Some("Example Weekly".to_string());
        req.published_time = Some("2026-07-01T09:30:00Z".to_string());
        req.lang = Some("en-GB".to_string());
        req.excerpt = Some("A short summary.".to_string());

        let meta = build_archive_meta(&req, &hashes_fixture());
        let archive = match meta.extra.get("archive") {
            Some(toml::Value::Table(m)) => m,
            other => panic!("expected archive mapping, got {other:?}"),
        };
        let get = |k: &str| archive.get(k).and_then(|v| v.as_str());
        assert_eq!(get("byline"), Some("Ada Lovelace"));
        assert_eq!(get("site_name"), Some("Example Weekly"));
        assert_eq!(get("published_time"), Some("2026-07-01T09:30:00Z"));
        assert_eq!(get("lang"), Some("en-GB"));
        assert_eq!(get("excerpt"), Some("A short summary."));
    }

    #[test]
    fn build_archive_meta_omits_blank_provenance_fields() {
        let mut req = request_fixture();
        req.byline = Some("   ".to_string());
        req.lang = None;

        let meta = build_archive_meta(&req, &hashes_fixture());
        let archive = match meta.extra.get("archive") {
            Some(toml::Value::Table(m)) => m,
            other => panic!("expected archive mapping, got {other:?}"),
        };
        assert!(
            !archive.contains_key("byline"),
            "blank byline must be dropped"
        );
        assert!(!archive.contains_key("lang"), "absent lang must be dropped");
    }

    fn request_fixture() -> ArchiveRequest {
        ArchiveRequest {
            url: "https://example.com/test".to_string(),
            canonical_url: None,
            domain: "example.com".to_string(),
            title: "Test Article".to_string(),
            description: None,
            captured_at: "2026-01-01T00:00:00Z".to_string(),
            content_hash: "sha256:abc".to_string(),
            snapshot_html: String::new(),
            markdown_body: "# Test".to_string(),
            tags: vec!["archive".to_string()],
            byline: None,
            site_name: None,
            published_time: None,
            lang: None,
            excerpt: None,
        }
    }

    fn hashes_fixture() -> ArchiveHashes {
        ArchiveHashes {
            source_hash: "sha256:src".to_string(),
            content_hash: "sha256:content".to_string(),
            snapshot_hash: "sha256:snap".to_string(),
            resource_hashes: vec!["sha256:img".to_string()],
        }
    }

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
            snapshot_html: String::new(),
            markdown_body: "# Test".to_string(),
            tags: vec!["archive".to_string()],
            ..request_fixture()
        };
        let meta = build_archive_meta(&req, &hashes_fixture());
        assert!(
            meta.extra.contains_key("archive"),
            "meta.extra should have 'archive' key"
        );
        assert_eq!(meta.title, Some("Test Article".to_string()));
    }

    #[test]
    fn build_archive_meta_lists_only_resource_blobs() {
        let meta = build_archive_meta(&request_fixture(), &hashes_fixture());

        let archive = match meta.extra.get("archive") {
            Some(toml::Value::Table(m)) => m,
            other => panic!("expected archive mapping, got {other:?}"),
        };
        let blobs: Vec<&str> = archive["blobs"]
            .as_array()
            .expect("blobs array present")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(blobs, vec!["sha256:img"]);
        assert_eq!(archive["resource_count"].as_integer(), Some(1));
        assert_eq!(archive["snapshot_hash"].as_str(), Some("sha256:snap"));
        assert_eq!(archive["source_hash"].as_str(), Some("sha256:src"));
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
