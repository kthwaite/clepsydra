//! API endpoints for ingesting web page archives, including associated blobs stored in
//! the CAS.
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use bytes::Bytes;
use http_body::{Frame, SizeHint};
use serde::{Deserialize, Serialize};
use url::{Host, Url};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use crate::ServerSettings;
use crate::vault::archive_snapshot::{self, SnapshotResource};
use crate::vault::cas::{ContentStore, OpenBlob, RetrieveLimitedError};
use crate::vault::index::ArchiveUrlOwner;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubbish_item_id: Option<String>,
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
    pub snapshot_view_version: u32,
    pub enabled: bool,
    pub blob_count: u64,
    pub total_size_bytes: u64,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ArchiveLookupQuery {
    /// http(s) source URL to look up.
    pub url: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArchiveLookupResponse {
    pub status: ArchiveLookupStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveLookupStatus {
    Active,
    Rubbish,
    None,
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
const ARCHIVE_RESOURCE_WORKING_SET_MB: u64 = 256;

/// Maximum bytes admitted for one archived resource. This is the same
/// configured limit enforced during ingest, so accepted captures remain
/// renderable.
pub(crate) fn archive_resource_limit_bytes(max_blob_size_mb: u64) -> usize {
    usize::try_from(max_blob_size_mb)
        .unwrap_or(usize::MAX)
        .saturating_mul(1024 * 1024)
}

/// Bound parallel resource buffers to approximately 256 MiB while allowing at
/// most eight concurrent reads for small configured blob limits.
pub fn archive_resource_concurrency(max_blob_size_mb: u64) -> usize {
    let per_blob_mb = max_blob_size_mb.max(1);
    usize::try_from(ARCHIVE_RESOURCE_WORKING_SET_MB / per_blob_mb)
        .unwrap_or(1)
        .clamp(1, 8)
}

/// Immutable response policy for the dedicated archive snapshot view.
///
/// Every policy string is assembled once from server configuration. The
/// request's `Host` header only *selects* one of them; its bytes never reach a
/// response header.
#[derive(Clone, Debug)]
pub struct ArchiveViewConfig {
    /// The bind origin. Also the fallback for absent, unknown, or malformed hosts.
    bind: AllowedOrigin,
    /// `server.public_origins`, validated, normalised, deduplicated, in order.
    public: Vec<AllowedOrigin>,
}

#[derive(Clone, Debug)]
struct AllowedOrigin {
    /// The origin exactly as the CSP names it, e.g. `https://clepsydra.localhost`.
    source: String,
    /// Parsed form used to compare against a request `Host`.
    url: Url,
    content_security_policy: HeaderValue,
}

impl AllowedOrigin {
    fn new(source: String) -> Result<Self, String> {
        let url = Url::parse(&source).map_err(|error| format!("{source}: {error}"))?;
        let policy = format!(
            "sandbox; default-src 'none'; img-src {source} data:; \
             media-src {source} data:; style-src 'unsafe-inline' {source} data:; \
             font-src {source} data:"
        );
        let content_security_policy = HeaderValue::from_str(&policy)
            .map_err(|error| format!("invalid archive view CSP for {source}: {error}"))?;
        Ok(Self {
            source,
            url,
            content_security_policy,
        })
    }

    /// Does a raw `Host` header value (`host[:port]`) name this origin?
    ///
    /// The scheme comes from this entry, so a listed `https://` name never
    /// matches an `http://` request policy and vice versa. Anything that is not
    /// a plain host-and-port is rejected before parsing.
    fn matches_host(&self, host: &str) -> bool {
        let plain_host_bytes = host.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        });
        if host.is_empty() || !plain_host_bytes {
            return false;
        }
        Url::parse(&format!("{}://{host}", self.url.scheme()))
            .map(|candidate| candidate.origin() == self.url.origin())
            .unwrap_or(false)
    }
}

/// Validate one `server.public_origins` entry and normalise it to its ASCII
/// origin serialisation (lowercase host, default port dropped).
fn validate_public_origin(raw: &str) -> Result<String, &'static str> {
    // Checked before parsing: the URL parser may reject `*` with a generic error.
    if raw.contains('*') {
        return Err("must not contain a wildcard");
    }
    let url = Url::parse(raw.trim()).map_err(|_| "must be an absolute http(s) origin")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("must use the http or https scheme");
    }
    match url.host().ok_or("must name a host")? {
        Host::Ipv4(address) if address.is_unspecified() => {
            return Err("must name a concrete host, not an unspecified address");
        }
        Host::Ipv6(address) if address.is_unspecified() => {
            return Err("must name a concrete host, not an unspecified address");
        }
        _ => {}
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not carry credentials");
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("must be a bare origin without path, query, or fragment");
    }
    Ok(url.origin().ascii_serialization())
}

impl ArchiveViewConfig {
    pub fn from_server_settings(settings: &ServerSettings) -> Result<Self, String> {
        let raw_host = settings.server_host_for_origin()?;
        let host = match raw_host {
            Host::Domain(host) => host,
            Host::Ipv4(host) => host.to_string(),
            Host::Ipv6(host) => format!("[{host}]"),
        };
        let scheme = if settings.tls.enabled {
            "https"
        } else {
            "http"
        };
        let bind = AllowedOrigin::new(format!("{scheme}://{host}:{}", settings.port)).map_err(
            |error| format!("invalid archive view origin from server configuration: {error}"),
        )?;

        let mut public: Vec<AllowedOrigin> = Vec::with_capacity(settings.public_origins.len());
        for (index, raw) in settings.public_origins.iter().enumerate() {
            let source = validate_public_origin(raw)
                .map_err(|reason| format!("server.public_origins[{index}] {reason}: {raw:?}"))?;
            let origin = AllowedOrigin::new(source)?;
            let already_listed = origin.url.origin() == bind.url.origin()
                || public
                    .iter()
                    .any(|listed| listed.url.origin() == origin.url.origin());
            if !already_listed {
                public.push(origin);
            }
        }
        Ok(Self { bind, public })
    }

    /// The policy for the origin the browser addressed, or the bind-origin
    /// policy when `host` is absent, malformed, or not configured.
    pub fn policy_for_host(&self, host: Option<&str>) -> &HeaderValue {
        let Some(host) = host else {
            return &self.bind.content_security_policy;
        };
        std::iter::once(&self.bind)
            .chain(self.public.iter())
            .find(|origin| origin.matches_host(host))
            .map_or(&self.bind.content_security_policy, |origin| {
                &origin.content_security_policy
            })
    }

    /// Every origin the viewer may name, bind origin first. For startup logs.
    pub fn allowed_origins(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.bind.source.as_str())
            .chain(self.public.iter().map(|origin| origin.source.as_str()))
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
    router_with_body_limit(archive_body_limit_bytes(250), ArchiveViewConfig::default())
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
        .route("/lookup", get(lookup_archive))
        .route(
            "/view/{snapshot_hash}",
            get(view_snapshot).head(head_snapshot),
        )
        .layer(Extension(view_config))
}

pub fn cas_router() -> Router<Arc<AppState>> {
    Router::new().route("/{hash}", get(serve_blob))
}

const OCTET_STREAM: &str = "application/octet-stream";
const SNAPSHOT_VIEW_VERSION: u32 = 1;
const ARCHIVE_DIAGNOSTIC_HEADER: &str = "x-clepsydra-archive-diagnostic";
const ARCHIVE_UNCAPTURED_RESOURCE_COUNT_HEADER: &str =
    "x-clepsydra-archive-uncaptured-resource-count";

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

fn validate_http_url(field: &str, raw: &str) -> Result<(), ApiError> {
    let has_http_prefix = raw
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || raw
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"));
    let parsed = Url::parse(raw).ok();
    let valid = has_http_prefix
        && !raw.chars().any(char::is_whitespace)
        && parsed.as_ref().is_some_and(|url| {
            matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
        });
    if valid {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{field} must be an absolute HTTP(S) URL"
        )))
    }
}

/// The host the browser addressed: the `Host` header, or the request-target
/// authority for HTTP/2 requests, which carry `:authority` instead.
fn request_host(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| {
            uri.authority()
                .map(|authority| authority.as_str().to_owned())
        })
}

fn sandbox_headers(config: &ArchiveViewConfig, host: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        config.policy_for_host(host).clone(),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers
}

enum LoadedSnapshot {
    Body {
        data: Vec<u8>,
        content_type: String,
        uncaptured_resource_count: usize,
    },
}

fn without_body(response: Response) -> Response {
    let (parts, _) = response.into_parts();
    Response::from_parts(parts, Body::empty())
}

fn unsupported_snapshot_response(content_type: &str) -> Response {
    let error = ApiError {
        status: StatusCode::UNSUPPORTED_MEDIA_TYPE.as_u16(),
        error: format!("snapshot is not text/html: {content_type}"),
        detail: None,
        hint: None,
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-clepsydra-archive-content-type",
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static(OCTET_STREAM)),
    );
    (StatusCode::UNSUPPORTED_MEDIA_TYPE, headers, Json(error)).into_response()
}

struct AdmittedBody {
    inner: Body,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl http_body::Body for AdmittedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(context)
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn admitted_body(data: Vec<u8>, permit: tokio::sync::OwnedSemaphorePermit) -> Body {
    Body::new(AdmittedBody {
        inner: Body::from(data),
        _permit: permit,
    })
}
fn snapshot_response_with(
    snapshot: LoadedSnapshot,
    config: &ArchiveViewConfig,
    host: Option<&str>,
    body_permit: Option<tokio::sync::OwnedSemaphorePermit>,
) -> Response {
    match snapshot {
        LoadedSnapshot::Body {
            data,
            content_type,
            uncaptured_resource_count,
        } => {
            if !framable_content_type(&content_type) {
                return unsupported_snapshot_response(&content_type);
            }
            let body = match body_permit {
                Some(permit) => admitted_body(data, permit),
                None => Body::from(data),
            };
            let mut headers = sandbox_headers(config, host);
            headers.insert(
                ARCHIVE_UNCAPTURED_RESOURCE_COUNT_HEADER,
                HeaderValue::from_str(&uncaptured_resource_count.to_string())
                    .expect("resource count is a valid header value"),
            );
            (StatusCode::OK, headers, body).into_response()
        }
    }
}

// Ingest, GET, and HEAD share the 2 MiB stored-snapshot ceiling; the 64 MiB
// rewrite ceiling covers expansion of validated CAS URLs.
const MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES: usize = archive_snapshot::ARCHIVE_VIEW_SNAPSHOT_BYTES;

struct PreparedSnapshotBody {
    data: Vec<u8>,
    uncaptured_resource_count: usize,
}

fn prepare_snapshot_body(data: Vec<u8>) -> Result<PreparedSnapshotBody, ApiError> {
    let data = prepare_snapshot_input(data, MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES)?;
    let snapshot = archive_snapshot::neutralize_navigation_bytes_with_diagnostics(data)
        .map_err(|error| ApiError::internal(format!("archived snapshot is corrupt: {error}")))?;
    Ok(PreparedSnapshotBody {
        data: snapshot.html,
        uncaptured_resource_count: snapshot.uncaptured_resource_count,
    })
}

fn validate_snapshot_renderability(snapshot: &str) -> Result<(), ApiError> {
    prepare_snapshot_body(snapshot.as_bytes().to_vec())
        .map(drop)
        .map_err(|error| {
            let reason = error
                .error
                .strip_prefix("archived snapshot is corrupt: ")
                .unwrap_or(&error.error);
            ApiError::bad_request(format!(
                "archived snapshot violates view constraints: {reason}"
            ))
        })
}

fn prepare_snapshot_input(data: Vec<u8>, input_limit: usize) -> Result<Vec<u8>, ApiError> {
    if data.len() > input_limit {
        return Err(ApiError::internal(format!(
            "archived snapshot is corrupt: snapshot size {} exceeds view input limit {}",
            data.len(),
            input_limit
        )));
    }
    let data = rewrite_cas_urls(data);
    if data.len() > archive_snapshot::DEFAULT_REWRITTEN_SNAPSHOT_BYTES {
        return Err(ApiError::internal(format!(
            "archived snapshot is corrupt: CAS rewrite size {} exceeds rewrite input limit {}",
            data.len(),
            archive_snapshot::DEFAULT_REWRITTEN_SNAPSHOT_BYTES
        )));
    }
    Ok(data)
}

#[cfg(test)]
fn prepare_snapshot_body_with(
    data: Vec<u8>,
    input_limit: usize,
    neutralize: impl FnOnce(Vec<u8>) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, ApiError> {
    neutralize(prepare_snapshot_input(data, input_limit)?)
        .map_err(|error| ApiError::internal(format!("archived snapshot is corrupt: {error}")))
}
fn cas_url_boundary(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b'"' | b'\'' | b')' | b'>' | b'#')
}

const STORED_CAS_URL_PREFIX: &[u8] = b"cas:sha256:";
const SERVED_CAS_URL_PREFIX: &[u8] = b"/api/vault/cas/";
const SHA256_HEX_LEN: usize = 64;

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
    if snapshot_len > MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES {
        return Err(ApiError::bad_request(format!(
            "archived snapshot is {snapshot_len} bytes, over shared snapshot view limit ({MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES} bytes)"
        )));
    }
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
        // The same configured per-blob limit is applied when the CAS resource
        // is served, so every accepted resource remains renderable.
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
    /// Every deconstructed resource, excluding the snapshot itself, as
    /// (hash, content type) pairs. The delete hook decrements each hash.
    resources: Vec<(String, String)>,
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
        toml::Value::Integer(hashes.resources.len() as i64),
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

    if !hashes.resources.is_empty() {
        let blobs: Vec<toml::Value> = hashes
            .resources
            .iter()
            .map(|(hash, content_type)| {
                let mut entry = toml::Table::new();
                entry.insert("hash".into(), toml::Value::String(hash.clone()));
                entry.insert("type".into(), toml::Value::String(content_type.clone()));
                toml::Value::Table(entry)
            })
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

async fn acquire_archive_view_permit(
    semaphore: Arc<tokio::sync::Semaphore>,
) -> Result<tokio::sync::OwnedSemaphorePermit, ApiError> {
    semaphore
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("archive snapshot viewer is unavailable"))
}

fn limited_snapshot_error(hash: &str, error: RetrieveLimitedError) -> ApiError {
    match error {
        RetrieveLimitedError::TooLarge { size, limit } => ApiError::internal(format!(
            "archived snapshot is corrupt: snapshot size {size} exceeds view input limit {limit}"
        )),
        RetrieveLimitedError::Store(_) => {
            ApiError::not_found(format!("snapshot not found: {hash}"))
        }
    }
}

fn limited_blob_error(hash: &str, error: RetrieveLimitedError) -> ApiError {
    match error {
        RetrieveLimitedError::TooLarge { size, limit } => ApiError::internal(format!(
            "archived resource is corrupt: blob size {size} exceeds resource limit {limit}"
        )),
        RetrieveLimitedError::Store(_) => ApiError::not_found(format!("blob not found: {hash}")),
    }
}

enum SnapshotLoadError {
    Retrieval(ApiError),
    Transformation(ApiError),
}

impl From<SnapshotLoadError> for ApiError {
    fn from(error: SnapshotLoadError) -> Self {
        match error {
            SnapshotLoadError::Retrieval(error) | SnapshotLoadError::Transformation(error) => error,
        }
    }
}

fn open_snapshot(store: &ContentStore, hash: &str) -> Result<OpenBlob, SnapshotLoadError> {
    store
        .open_limited(hash, MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES)
        .map_err(|error| SnapshotLoadError::Retrieval(limited_snapshot_error(hash, error)))
}

fn load_snapshot(opened: OpenBlob, hash: &str) -> Result<LoadedSnapshot, SnapshotLoadError> {
    let content_type = opened.content_type().to_string();
    if !framable_content_type(&content_type) {
        return Ok(LoadedSnapshot::Body {
            data: Vec::new(),
            content_type,
            uncaptured_resource_count: 0,
        });
    }
    let (data, content_type) = opened
        .read_limited(MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES)
        .map_err(|error| SnapshotLoadError::Retrieval(limited_snapshot_error(hash, error)))?;
    let prepared = prepare_snapshot_body(data).map_err(SnapshotLoadError::Transformation)?;
    Ok(LoadedSnapshot::Body {
        data: prepared.data,
        content_type,
        uncaptured_resource_count: prepared.uncaptured_resource_count,
    })
}

fn transformation_error_response(error: ApiError) -> Response {
    let diagnostic = error
        .error
        .strip_prefix("archived snapshot is corrupt: ")
        .unwrap_or(&error.error);
    let diagnostic = HeaderValue::from_str(diagnostic)
        .unwrap_or_else(|_| HeaderValue::from_static("snapshot transformation failed"));
    let mut response = error.into_response();
    response
        .headers_mut()
        .insert(ARCHIVE_DIAGNOSTIC_HEADER, diagnostic);
    response
}

#[utoipa::path(
    get,
    path = "/archive/view/{snapshot_hash}",
    context_path = "/api/vault",
    tag = "Archive",
    params(("snapshot_hash" = String, Path, description = "Archived snapshot blob hash")),
    responses(
        (
            status = 200,
            description = "Sandboxed archived HTML snapshot",
            body = String,
            content_type = "text/html",
            headers(
                ("X-Clepsydra-Archive-Uncaptured-Resource-Count" = u64, description = "Count of render resources not captured in the archive")
            )
        ),
        (status = 404, description = "Snapshot blob not found", body = ApiError),
        (status = 415, description = "Blob is not an HTML snapshot", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn view_snapshot(
    State(state): State<Arc<AppState>>,
    Extension(config): Extension<ArchiveViewConfig>,
    Path(hash): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let host = request_host(&headers, &uri);
    let permit = acquire_archive_view_permit(Arc::clone(&state.archive_view_semaphore)).await?;
    let cas = Arc::clone(&state.cas);
    let worker_hash = hash.clone();
    let (snapshot, permit) = tokio::task::spawn_blocking(move || {
        let opened = {
            let cas = cas.lock();
            open_snapshot(&cas, &worker_hash)?
        };
        let snapshot = load_snapshot(opened, &worker_hash)?;
        Ok::<_, SnapshotLoadError>((snapshot, permit))
    })
    .await
    .map_err(|error| ApiError::internal(format!("archive snapshot worker failed: {error}")))?
    .map_err(ApiError::from)?;

    Ok(snapshot_response_with(
        snapshot,
        &config,
        host.as_deref(),
        Some(permit),
    ))
}

async fn run_head_inspection<T, F>(inspection: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(inspection)
        .await
        .map_err(|error| ApiError::internal(format!("archive HEAD worker failed: {error}")))
}

#[utoipa::path(
    head,
    path = "/archive/view/{snapshot_hash}",
    context_path = "/api/vault",
    tag = "Archive",
    params(("snapshot_hash" = String, Path, description = "Archived snapshot blob hash")),
    responses(
        (
            status = 200,
            description = "Validated archived HTML snapshot metadata",
            headers(
                ("X-Clepsydra-Archive-Uncaptured-Resource-Count" = u64, description = "Count of render resources not captured in the archive")
            )
        ),
        (status = 404, description = "Snapshot blob not found"),
        (
            status = 415,
            description = "Blob is not an HTML snapshot",
            headers(
                ("X-Clepsydra-Archive-Content-Type" = String, description = "Stored snapshot media type")
            )
        ),
        (
            status = 500,
            description = "Snapshot validation or internal server error",
            headers(
                ("X-Clepsydra-Archive-Diagnostic" = String, description = "Safe snapshot transformation diagnostic")
            )
        )
    )
)]
pub async fn head_snapshot(
    State(state): State<Arc<AppState>>,
    Extension(config): Extension<ArchiveViewConfig>,
    Path(hash): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let host = request_host(&headers, &uri);
    let permit = match acquire_archive_view_permit(Arc::clone(&state.archive_view_semaphore)).await
    {
        Ok(permit) => permit,
        Err(error) => return without_body(error.into_response()),
    };
    let cas = Arc::clone(&state.cas);
    let worker_hash = hash.clone();
    let snapshot = run_head_inspection(move || {
        let _permit = permit;
        let opened = {
            let cas = cas.lock();
            open_snapshot(&cas, &worker_hash)?
        };
        load_snapshot(opened, &worker_hash)
    })
    .await;
    without_body(match snapshot {
        Ok(Ok(snapshot)) => snapshot_response_with(snapshot, &config, host.as_deref(), None),
        Ok(Err(SnapshotLoadError::Retrieval(error))) | Err(error) => error.into_response(),
        Ok(Err(SnapshotLoadError::Transformation(error))) => transformation_error_response(error),
    })
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
    let resource_limit =
        archive_resource_limit_bytes(state.vault.config().archive.max_blob_size_mb);
    let permit = Arc::clone(&state.archive_resource_semaphore)
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("archive resource service is unavailable"))?;
    let cas = Arc::clone(&state.cas);
    let worker_hash = hash.clone();
    let (data, content_type, permit) = tokio::task::spawn_blocking(move || {
        let opened = {
            let cas = cas.lock();
            cas.open_limited(&worker_hash, resource_limit)
                .map_err(|error| limited_blob_error(&worker_hash, error))?
        };
        let (data, content_type) = opened
            .read_limited(resource_limit)
            .map_err(|error| limited_blob_error(&worker_hash, error))?;
        Ok::<_, ApiError>((data, content_type, permit))
    })
    .await
    .map_err(|error| ApiError::internal(format!("archive resource worker failed: {error}")))??;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or_else(|_| HeaderValue::from_static(OCTET_STREAM)),
    );
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

    Ok((StatusCode::OK, headers, admitted_body(data, permit)).into_response())
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
        snapshot_view_version: SNAPSHOT_VIEW_VERSION,
        enabled: state.vault.config().archive.enabled,
        blob_count: stats.blob_count,
        total_size_bytes: stats.total_size_bytes,
    }))
}

/// Capture ownership for a source URL.
///
/// Read-only companion to `POST /archive`: the extension calls it before a
/// capture to say whether this URL already lives in the vault (or its
/// Rubbish Bin) without sending a snapshot.
#[utoipa::path(
    get,
    path = "/archive/lookup",
    context_path = "/api/vault",
    tag = "Archive",
    params(ArchiveLookupQuery),
    responses(
        (status = 200, description = "Capture ownership for the URL", body = ArchiveLookupResponse),
        (status = 400, description = "Invalid url parameter", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn lookup_archive(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ArchiveLookupQuery>,
) -> Result<Json<ArchiveLookupResponse>, ApiError> {
    validate_http_url("url", &query.url)?;

    let url = query.url.clone();
    let owner = state
        .index
        .with_index(move |index, _vault| index.find_by_archive_url(&url))
        .await
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?;

    let response = match owner {
        None => ArchiveLookupResponse {
            status: ArchiveLookupStatus::None,
            page_id: None,
            vault_path: None,
            captured_at: None,
        },
        Some(ArchiveUrlOwner::Active { page_id, path, .. }) => {
            let id = page_id.clone();
            let captured_at = state
                .index
                .with_index(move |index, _vault| index.archive_captured_at(&id))
                .await
                .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
                .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?;
            ArchiveLookupResponse {
                status: ArchiveLookupStatus::Active,
                page_id: Some(page_id),
                vault_path: Some(path),
                captured_at,
            }
        }
        Some(ArchiveUrlOwner::Rubbish {
            page_id,
            original_path,
            ..
        }) => ArchiveLookupResponse {
            status: ArchiveLookupStatus::Rubbish,
            page_id: Some(page_id),
            vault_path: Some(original_path),
            captured_at: None,
        },
    };
    Ok(Json(response))
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

    validate_http_url("url", &req.url)?;
    if let Some(canonical_url) = req.canonical_url.as_deref() {
        validate_http_url("canonical_url", canonical_url)?;
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

    if let Some(owner) = existing {
        match owner {
            ArchiveUrlOwner::Active {
                page_id,
                path,
                source_hash: existing_hash,
            } => {
                if existing_hash == source_hash {
                    return Ok((
                        StatusCode::OK,
                        Json(ArchiveResponse {
                            page_id,
                            vault_path: path,
                            rubbish_item_id: None,
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
                        "vault_path": path,
                    }),
                ));
            }
            ArchiveUrlOwner::Rubbish {
                item_id,
                page_id,
                original_path,
            } => {
                return Ok((
                    StatusCode::OK,
                    Json(ArchiveResponse {
                        page_id,
                        vault_path: original_path,
                        rubbish_item_id: Some(item_id),
                        blobs_stored: 0,
                        blobs_deduped: 0,
                        status: ArchiveStatus::AlreadyExists,
                    }),
                )
                    .into_response());
            }
        }
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

    // Run the exact bounded GET transformation before any derived hashes, CAS
    // references, or page/index mutations. Its output is deliberately dropped:
    // the immutable deconstructed snapshot remains the stored source artifact.
    validate_snapshot_renderability(&deconstructed.html)?;

    // The map is built from the rewritten snapshot, because it pairs each
    // `data-sf-original-src` with the `cas:` reference that just replaced that
    // element's `src`.
    let url_map = archive_snapshot::original_url_map(&deconstructed.html, &req.url);
    let markdown_body =
        archive_snapshot::rewrite_markdown_images(&req.markdown_body, &url_map, &req.url);
    let content_hash = ContentStore::hash_bytes(markdown_body.as_bytes());

    let snapshot_bytes = deconstructed.html.into_bytes();
    let snapshot_hash = ContentStore::hash_bytes(&snapshot_bytes);

    let resources: Vec<(String, String)> = deconstructed
        .resources
        .iter()
        .map(|r| (r.hash.clone(), r.content_type.clone()))
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
            resources,
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
            rubbish_item_id: None,
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

    fn settings_with_public_origins(origins: &[&str]) -> ServerSettings {
        ServerSettings {
            host: "vault.example".to_string(),
            port: 7443,
            dev_mode: false,
            tls: crate::TlsSettings {
                enabled: true,
                cert_path: None,
                key_path: None,
            },
            public_origins: origins.iter().map(|origin| origin.to_string()).collect(),
        }
    }

    fn policy_origin_count(policy: &HeaderValue, origin: &str) -> usize {
        policy.to_str().unwrap().matches(origin).count()
    }

    #[test]
    fn configured_hosts_and_ports_are_formatted_as_concrete_csp_origins() {
        let explicit = |host: &str, port: u16, tls_enabled: bool| ServerSettings {
            host: host.to_string(),
            port,
            dev_mode: false,
            tls: crate::TlsSettings {
                enabled: tls_enabled,
                cert_path: None,
                key_path: None,
            },
            public_origins: Vec::new(),
        };
        let cases = [
            (ServerSettings::default(), "http://localhost:16667"),
            (
                explicit("vault.example", 7443, true),
                "https://vault.example:7443",
            ),
            (explicit("127.0.0.1", 3000, false), "http://127.0.0.1:3000"),
            (explicit("[::1]", 7443, true), "https://[::1]:7443"),
            (explicit("::1", 8080, false), "http://[::1]:8080"),
        ];

        for (settings, expected_origin) in cases {
            let config = ArchiveViewConfig::from_server_settings(&settings).unwrap();
            let policy = config.policy_for_host(None);

            assert_eq!(
                policy_origin_count(policy, expected_origin),
                4,
                "CSP did not use {expected_origin:?} in every resource directive: {policy:?}"
            );
        }
    }

    #[test]
    fn host_header_selects_a_listed_origin_and_never_reaches_the_policy() {
        let config = ArchiveViewConfig::from_server_settings(&settings_with_public_origins(&[
            "https://clepsydra.localhost",
            "http://tunnel.example:8080",
        ]))
        .unwrap();
        let bind = "https://vault.example:7443";

        let listed = config.policy_for_host(Some("clepsydra.localhost"));
        assert_eq!(
            policy_origin_count(listed, "https://clepsydra.localhost"),
            4
        );
        assert_eq!(policy_origin_count(listed, "vault.example"), 0);
        assert_eq!(
            policy_origin_count(listed, "tunnel.example"),
            0,
            "other listed origins must not widen the policy"
        );

        // An explicit default port names the same origin.
        assert_eq!(
            config.policy_for_host(Some("clepsydra.localhost:443")),
            listed
        );
        // Case-insensitive host.
        assert_eq!(config.policy_for_host(Some("Clepsydra.LOCALHOST")), listed);
        // A listed non-default port must match exactly.
        assert_eq!(
            policy_origin_count(
                config.policy_for_host(Some("tunnel.example:8080")),
                "http://tunnel.example:8080"
            ),
            4
        );
        assert_eq!(
            policy_origin_count(config.policy_for_host(Some("tunnel.example")), bind),
            4,
            "port mismatch is a different origin"
        );

        // The bind origin itself.
        assert_eq!(
            policy_origin_count(config.policy_for_host(Some("vault.example:7443")), bind),
            4
        );

        // Unknown, absent, or malformed hosts fall back to the bind origin.
        for host in [
            None,
            Some(""),
            Some("attacker.example"),
            Some("clepsydra.localhost/evil"),
            Some("clepsydra.localhost?x"),
            Some("user@clepsydra.localhost"),
            Some("clepsydra.localhost; img-src https://evil.example"),
            Some("clepsydra.localhost\u{0}"),
        ] {
            let policy = config.policy_for_host(host);
            assert_eq!(
                policy_origin_count(policy, bind),
                4,
                "host {host:?}: {policy:?}"
            );
            assert!(
                !policy.to_str().unwrap().contains("evil"),
                "request bytes reached the policy for {host:?}: {policy:?}"
            );
        }
    }

    #[test]
    fn public_origins_are_validated_and_normalised() {
        let config = ArchiveViewConfig::from_server_settings(&settings_with_public_origins(&[
            "HTTPS://Clepsydra.LOCALHOST:443/",
        ]))
        .unwrap();
        assert_eq!(
            config.allowed_origins().collect::<Vec<_>>(),
            vec!["https://vault.example:7443", "https://clepsydra.localhost"]
        );

        let rejected = [
            ("clepsydra.localhost", "absolute"),
            ("ftp://clepsydra.localhost", "http or https"),
            ("https://*.ts.net", "wildcard"),
            ("https://0.0.0.0", "unspecified"),
            ("https://[::]", "unspecified"),
            ("https://user@clepsydra.localhost", "credentials"),
            ("https://clepsydra.localhost/api", "bare origin"),
            ("https://clepsydra.localhost?x=1", "bare origin"),
            ("https://clepsydra.localhost#top", "bare origin"),
        ];
        for (raw, expected_reason) in rejected {
            let error =
                ArchiveViewConfig::from_server_settings(&settings_with_public_origins(&[raw]))
                    .expect_err(raw);
            assert!(
                error.contains("server.public_origins[0]") && error.contains(expected_reason),
                "{raw}: {error}"
            );
        }
    }

    #[test]
    fn duplicate_public_origins_collapse_into_one_entry() {
        let settings = ServerSettings {
            public_origins: vec![
                "http://localhost:16667".to_string(),
                "https://a.example".to_string(),
                "https://a.example:443".to_string(),
            ],
            ..ServerSettings::default()
        };
        let config = ArchiveViewConfig::from_server_settings(&settings).unwrap();
        assert_eq!(
            config.allowed_origins().collect::<Vec<_>>(),
            vec!["http://localhost:16667", "https://a.example"]
        );
    }

    #[tokio::test]
    async fn archive_view_permit_stays_with_blocking_worker() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = acquire_archive_view_permit(Arc::clone(&semaphore))
            .await
            .unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        started_rx.recv().unwrap();

        let blocked = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            acquire_archive_view_permit(Arc::clone(&semaphore)),
        )
        .await;
        assert!(
            blocked.is_err(),
            "a concurrent working set acquired a permit"
        );

        release_tx.send(()).unwrap();
        worker.await.unwrap();
        let _permit = acquire_archive_view_permit(semaphore).await.unwrap();
    }
    #[tokio::test]
    async fn admitted_body_holds_permit_until_body_drop() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let body = admitted_body(vec![1, 2, 3], permit);
        assert_eq!(semaphore.available_permits(), 0);
        drop(body);
        assert_eq!(semaphore.available_permits(), 1);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn head_snapshot_inspection_runs_off_runtime_worker() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let timed_out = Arc::new(AtomicBool::new(false));
        let worker_timed_out = Arc::clone(&timed_out);
        let inspection = tokio::spawn(run_head_inspection(move || {
            started_tx.send(()).unwrap();
            if release_rx
                .recv_timeout(std::time::Duration::from_secs(2))
                .is_err()
            {
                worker_timed_out.store(true, Ordering::SeqCst);
            }
        }));

        started_rx.await.unwrap();
        assert!(
            !timed_out.load(Ordering::SeqCst),
            "blocking inspection parked the current-thread runtime"
        );
        release_tx.send(()).unwrap();
        inspection.await.unwrap().unwrap();
    }

    #[test]
    fn shared_two_mib_snapshot_cap_is_exact_at_ingest_and_view_boundaries() {
        use std::cell::Cell;

        let rewrites = Cell::new(0);
        let input_limit = MAX_ARCHIVE_VIEW_SNAPSHOT_BYTES;
        assert_eq!(input_limit, 2 * 1024 * 1024);
        validate_resource_sizes(&[], input_limit, 0, 100, 250)
            .expect("an exactly 2 MiB snapshot must be accepted at ingest");
        let ingest_error = validate_resource_sizes(&[], input_limit + 1, 0, 100, 250)
            .expect_err("an over-limit snapshot must be rejected at ingest");
        assert!(ingest_error.error.contains("shared snapshot view limit"));
        let at_limit = vec![b' '; input_limit];
        let result = prepare_snapshot_body_with(at_limit, input_limit, |html| {
            rewrites.set(rewrites.get() + 1);
            assert_eq!(html.len(), input_limit);
            Ok(html)
        });
        assert!(result.is_ok());
        assert_eq!(rewrites.get(), 1);

        let over_limit = vec![b' '; input_limit + 1];
        let error = prepare_snapshot_body_with(over_limit, input_limit, |_| {
            rewrites.set(rewrites.get() + 1);
            Ok(Vec::new())
        })
        .unwrap_err();
        assert_eq!(
            rewrites.get(),
            1,
            "over-limit input reached the rewriter seam"
        );
        assert_eq!(error.status, 500);
        assert!(error.error.contains("archived snapshot is corrupt"));
        assert!(error.error.contains("view input limit"));
        assert!(error.error.contains(&input_limit.to_string()));
    }

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
    fn configured_blob_limit_is_the_resource_serving_limit() {
        let fifty_mib = 50 * 1024 * 1024;
        let resources = vec![SnapshotResource {
            hash: "sha256:test".to_string(),
            bytes: vec![0; fifty_mib],
            content_type: "video/mp4".to_string(),
        }];
        validate_resource_sizes(&resources, 1, 1, 100, 250)
            .expect("a 50 MiB resource is valid under the default 100 MiB blob limit");
        assert_eq!(archive_resource_limit_bytes(100), 100 * 1024 * 1024);
        assert_eq!(archive_resource_concurrency(100), 2);
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
            resources: vec![("sha256:img".to_string(), "image/png".to_string())],
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

        let archive = meta
            .extra
            .get("archive")
            .and_then(|v| v.as_table())
            .unwrap();
        let blobs = archive.get("blobs").and_then(|v| v.as_array()).unwrap();
        assert_eq!(blobs.len(), 1);
        let entry = blobs[0].as_table().unwrap();
        assert_eq!(
            entry.get("hash").and_then(|v| v.as_str()),
            Some("sha256:img")
        );
        assert_eq!(
            entry.get("type").and_then(|v| v.as_str()),
            Some("image/png")
        );
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
