use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use crate::feeds::manifest;
use crate::feeds::scheduler::{
    reconcile_feed_manifest_bytes_locked, reconcile_feed_manifest_locked,
};
use crate::feeds::store::{FeedStoreError, FeedStoreHandle};
use crate::feeds::types::{
    Entry, EntryCursor, EntryFilters, EntryPatch, EntryView, FeedSummary, ManifestWarning,
    MarkReadScope,
};
use crate::vault::mutation_coordinator::{
    MutationError, MutationNotification, ReservedManifestCommand,
};
use crate::vault::path::VaultPath;

const DEFAULT_GROUP: &str = "Subscriptions";
const DEFAULT_ENTRY_LIMIT: usize = 50;
const MAX_ENTRY_LIMIT: usize = 100;
const MAX_OPML_BYTES: usize = 1_048_576;
const MAX_OPML_OUTLINES: usize = 10_000;
const MAX_OPML_DEPTH: usize = 32;
const MAX_OPML_ATTRIBUTES_PER_OUTLINE: usize = 32;
const MIN_DISCOVERY_NETWORK_BUDGET: std::time::Duration = std::time::Duration::from_millis(50);

fn deserialize_tri_state<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FeedDto {
    pub id: i64,
    pub url: String,
    pub fetch_url: Option<String>,
    pub site_url: Option<String>,
    pub title: String,
    pub title_override: Option<String>,
    pub group: String,
    pub tags: Vec<String>,
    pub last_fetch_at: Option<DateTime<Utc>>,
    pub next_fetch_at: DateTime<Utc>,
    pub error_count: u32,
    pub last_error: Option<String>,
}

impl From<FeedSummary> for FeedDto {
    fn from(feed: FeedSummary) -> Self {
        Self {
            id: feed.id,
            url: feed.url,
            fetch_url: feed.fetch_url,
            site_url: feed.site_url,
            title: feed.title,
            title_override: feed.title_override,
            group: feed.group,
            tags: feed.tags,
            last_fetch_at: feed.last_fetch_at,
            next_fetch_at: feed.next_fetch_at,
            error_count: feed.error_count,
            last_error: feed.last_error,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeedGroupDto {
    pub name: String,
    pub feeds: Vec<FeedDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeedDiagnosticDto {
    pub line: usize,
    pub message: String,
}

impl From<ManifestWarning> for FeedDiagnosticDto {
    fn from(warning: ManifestWarning) -> Self {
        Self {
            line: warning.line,
            message: warning.message,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeedEntryCountsDto {
    pub unread: u64,
    pub all: u64,
    pub saved: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeedListResponse {
    pub groups: Vec<FeedGroupDto>,
    pub diagnostics: Vec<FeedDiagnosticDto>,
    pub counts: FeedEntryCountsDto,
    pub manifest_revision: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SubscribeFeedRequest {
    pub url: String,
    pub group: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub expected_revision: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateFeedRequest {
    pub expected_revision: String,
    pub group: Option<String>,
    #[serde(
        default,
        alias = "title_override",
        deserialize_with = "deserialize_tri_state"
    )]
    pub title: Option<Option<String>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteFeedRequest {
    pub expected_revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeedMutationResponse {
    pub feed: FeedDto,
    pub manifest_revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ManifestMutationResponse {
    pub manifest_revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RefreshFeedsResponse {
    pub scheduled: usize,
}

#[derive(Debug, Clone, Copy, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum EntryViewDto {
    All,
    Unread,
    Saved,
}

impl From<EntryViewDto> for EntryView {
    fn from(view: EntryViewDto) -> Self {
        match view {
            EntryViewDto::All => Self::All,
            EntryViewDto::Unread => Self::Unread,
            EntryViewDto::Saved => Self::Saved,
        }
    }
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct FeedEntriesQuery {
    pub view: Option<EntryViewDto>,
    #[serde(alias = "feed_id")]
    pub feed: Option<i64>,
    pub group: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FeedEntryDto {
    pub id: i64,
    pub feed_id: i64,
    pub guid: String,
    pub url: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub content_html: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub fetched_at: DateTime<Utc>,
    pub read: bool,
    pub bookmarked: bool,
    pub tags: Vec<String>,
}

impl From<Entry> for FeedEntryDto {
    fn from(entry: Entry) -> Self {
        Self {
            id: entry.id,
            feed_id: entry.feed_id,
            guid: entry.guid,
            url: entry.url,
            title: entry.title,
            author: entry.author,
            content_html: entry.content_html,
            published_at: entry.published_at,
            fetched_at: entry.fetched_at,
            read: entry.read,
            bookmarked: entry.bookmarked,
            tags: entry.tags,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeedEntryPageResponse {
    pub entries: Vec<FeedEntryDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchFeedEntryRequest {
    pub read: Option<bool>,
    pub bookmarked: Option<bool>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MarkFeedEntriesReadRequest {
    #[serde(alias = "feed_id")]
    pub feed: Option<i64>,
    pub group: Option<String>,
    pub tag: Option<String>,
    pub before: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MarkFeedEntriesReadResponse {
    pub marked: u64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ImportOpmlRequest {
    pub expected_revision: String,
    pub opml: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ImportOpmlResponse {
    pub added: usize,
    pub manifest_revision: String,
}

struct ManifestSnapshot {
    existed: bool,
    bytes: Vec<u8>,
    text: String,
    revision: String,
}

async fn read_manifest_raw(state: &AppState) -> Result<(bool, Vec<u8>, String), ApiError> {
    let path = state.vault.root().join("feeds.md");
    let (existed, bytes) = match tokio::fs::read(&path).await {
        Ok(bytes) => (true, bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (false, Vec::new()),
        Err(error) => {
            return Err(ApiError::internal(format!(
                "read feed manifest {}: {error}",
                path.display()
            )));
        }
    };
    let revision = blake3::hash(&bytes).to_hex().to_string();
    Ok((existed, bytes, revision))
}

async fn read_manifest(state: &AppState) -> Result<ManifestSnapshot, ApiError> {
    let (existed, bytes, revision) = read_manifest_raw(state).await?;
    decode_manifest(existed, bytes, revision)
}

fn decode_manifest(
    existed: bool,
    bytes: Vec<u8>,
    revision: String,
) -> Result<ManifestSnapshot, ApiError> {
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| ApiError::bad_request("feeds.md must contain valid UTF-8"))?;
    Ok(ManifestSnapshot {
        existed,
        bytes,
        text,
        revision,
    })
}

async fn read_manifest_for_mutation(
    state: &AppState,
    expected: &str,
) -> Result<ManifestSnapshot, ApiError> {
    let (existed, bytes, revision) = read_manifest_raw(state).await?;
    if revision != expected {
        return Err(ApiError::revision_conflict(revision));
    }
    decode_manifest(existed, bytes, revision)
}

async fn publish_manifest(
    state: &AppState,
    snapshot: ManifestSnapshot,
    content: String,
) -> Result<String, ApiError> {
    let revision = blake3::hash(content.as_bytes()).to_hex().to_string();
    let result = state
        .mutation_coordinator
        .write_reserved_manifest(
            &state.vault,
            ReservedManifestCommand {
                path: VaultPath::new("feeds.md").expect("reserved path is normalized"),
                expected_content: snapshot.existed.then_some(snapshot.bytes),
                content: content.into_bytes(),
            },
            &|_: MutationNotification| {},
        )
        .await;
    match result {
        Ok(_) => {
            state.feed_refresh.notify_one();
            reconcile_feed_manifest_locked(state)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            Ok(revision)
        }
        Err(MutationError::Stale(_)) => {
            let (_, _, current_revision) = read_manifest_raw(state).await?;
            Err(ApiError::revision_conflict(current_revision))
        }
        Err(error) => Err(super::mutation_error(error)),
    }
}

fn feed_store_error(error: FeedStoreError) -> ApiError {
    match error {
        FeedStoreError::FeedNotFound(id) => ApiError::not_found(format!("feed {id} was not found")),
        FeedStoreError::EntryNotFound(id) => {
            ApiError::not_found(format!("entry {id} was not found"))
        }
        FeedStoreError::InvalidCursor(message) => ApiError::bad_request(message),
        error => ApiError::internal(error.to_string()),
    }
}

fn subscribed_feeds(feeds: Vec<FeedSummary>) -> Vec<FeedSummary> {
    feeds.into_iter().filter(|feed| feed.subscribed).collect()
}

fn grouped_feeds(feeds: Vec<FeedSummary>) -> Vec<FeedGroupDto> {
    let mut groups: Vec<FeedGroupDto> = Vec::new();
    for feed in subscribed_feeds(feeds) {
        if let Some(group) = groups.iter_mut().find(|group| group.name == feed.group) {
            group.feeds.push(feed.into());
        } else {
            groups.push(FeedGroupDto {
                name: feed.group.clone(),
                feeds: vec![feed.into()],
            });
        }
    }
    groups
}

async fn feed_by_id(store: &FeedStoreHandle, id: i64) -> Result<FeedSummary, ApiError> {
    store
        .list_feeds()
        .await
        .map_err(feed_store_error)?
        .into_iter()
        .find(|feed| feed.id == id && feed.subscribed)
        .ok_or_else(|| ApiError::not_found(format!("feed {id} was not found")))
}

#[utoipa::path(
    get,
    path = "",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    responses(
        (status = 200, body = FeedListResponse),
        (status = 400, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn list_feeds(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FeedListResponse>, ApiError> {
    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest(&state).await?;
    reconcile_feed_manifest_bytes_locked(&state, &snapshot.bytes)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let (feeds, counts) = tokio::try_join!(state.feeds.list_feeds(), state.feeds.entry_counts())
        .map_err(feed_store_error)?;
    let diagnostics = state
        .feed_manifest_diagnostics
        .read()
        .clone()
        .into_iter()
        .map(Into::into)
        .collect();
    let response = FeedListResponse {
        groups: grouped_feeds(feeds),
        diagnostics,
        counts: FeedEntryCountsDto {
            unread: counts.unread,
            all: counts.all,
            saved: counts.saved,
        },
        manifest_revision: snapshot.revision,
    };
    #[cfg(test)]
    if let Some(hook) = state.feed_after_list_snapshot_hook.lock().clone() {
        hook();
    }
    Ok(Json(response))
}

#[cfg(test)]
pub(crate) fn set_after_list_snapshot_hook(
    state: &AppState,
    hook: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    *state.feed_after_list_snapshot_hook.lock() = hook;
}

#[utoipa::path(
    post,
    path = "",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    request_body = SubscribeFeedRequest,
    responses(
        (status = 201, body = FeedMutationResponse),
        (status = 400, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn subscribe_feed(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SubscribeFeedRequest>,
) -> Result<(StatusCode, Json<FeedMutationResponse>), ApiError> {
    {
        let _preflight_guard = state.feed_manifest_lock.lock().await;
        let (_, _, current_revision) = read_manifest_raw(&state).await?;
        if current_revision != request.expected_revision {
            return Err(ApiError::revision_conflict(current_revision));
        }
    }

    let deadline = tokio::time::Instant::now() + state.feed_client.deadline();
    let permit_deadline = deadline - MIN_DISCOVERY_NETWORK_BUDGET;
    let permit = tokio::time::timeout_at(permit_deadline, state.feed_discovery_semaphore.acquire())
        .await
        .map_err(|_| ApiError::bad_request("feed discovery deadline exceeded while queued"))?
        .map_err(|_| ApiError::internal("feed discovery is unavailable"))?;
    if deadline.saturating_duration_since(tokio::time::Instant::now())
        < MIN_DISCOVERY_NETWORK_BUDGET
    {
        drop(permit);
        return Err(ApiError::bad_request(
            "feed discovery deadline exceeded while queued",
        ));
    }
    let discovered = tokio::time::timeout_at(
        deadline,
        crate::feeds::fetch::discover_feed_url_before(&state.feed_client, &request.url, deadline),
    )
    .await
    .map_err(|_| ApiError::bad_request("feed discovery deadline exceeded"))?
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    drop(permit);

    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest_for_mutation(&state, &request.expected_revision).await?;
    let url = discovered.as_str();
    if manifest::parse(&snapshot.text)
        .feeds
        .iter()
        .any(|feed| feed.url == url)
    {
        return Err(ApiError::conflict(format!(
            "feed is already subscribed: {url}"
        )));
    }
    let group = request.group.as_deref().unwrap_or(DEFAULT_GROUP);
    let tags = request.tags.iter().map(String::as_str).collect::<Vec<_>>();
    let candidate = manifest::add_feed(&snapshot.text, group, url, request.title.as_deref(), &tags)
        .map_err(ApiError::bad_request)?;
    let revision = publish_manifest(&state, snapshot, candidate).await?;
    let feed = state
        .feeds
        .list_feeds()
        .await
        .map_err(feed_store_error)?
        .into_iter()
        .find(|feed| feed.url == url && feed.subscribed)
        .ok_or_else(|| ApiError::internal("new feed was not reconciled"))?;
    state
        .feeds
        .schedule_refresh(Some(feed.id), Utc::now())
        .await
        .map_err(feed_store_error)?;
    state.feed_refresh.notify_one();
    Ok((
        StatusCode::CREATED,
        Json(FeedMutationResponse {
            feed: feed.into(),
            manifest_revision: revision,
        }),
    ))
}

#[utoipa::path(
    patch,
    path = "/{id}",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    params(("id" = i64, Path, description = "Feed identifier")),
    request_body = UpdateFeedRequest,
    responses(
        (status = 200, body = FeedMutationResponse),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn update_feed(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(request): Json<UpdateFeedRequest>,
) -> Result<Json<FeedMutationResponse>, ApiError> {
    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest_for_mutation(&state, &request.expected_revision).await?;
    let feed = feed_by_id(&state.feeds, id).await?;
    let group = request.group.as_deref().unwrap_or(&feed.group);
    let title = match request.title.as_ref() {
        None => feed.title_override.as_deref(),
        Some(Some(title)) => Some(title.as_str()),
        Some(None) => None,
    };
    let candidate = manifest::update_feed(&snapshot.text, &feed.url, group, title)
        .map_err(ApiError::bad_request)?;
    let revision = publish_manifest(&state, snapshot, candidate).await?;
    let feed = feed_by_id(&state.feeds, id).await?;
    Ok(Json(FeedMutationResponse {
        feed: feed.into(),
        manifest_revision: revision,
    }))
}

#[utoipa::path(
    delete,
    path = "/{id}",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    params(("id" = i64, Path, description = "Feed identifier")),
    request_body = DeleteFeedRequest,
    responses(
        (status = 200, body = ManifestMutationResponse),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn delete_feed(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(request): Json<DeleteFeedRequest>,
) -> Result<Json<ManifestMutationResponse>, ApiError> {
    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest_for_mutation(&state, &request.expected_revision).await?;
    let feed = feed_by_id(&state.feeds, id).await?;
    let candidate =
        manifest::remove_feed(&snapshot.text, &feed.url).map_err(ApiError::bad_request)?;
    let revision = publish_manifest(&state, snapshot, candidate).await?;
    Ok(Json(ManifestMutationResponse {
        manifest_revision: revision,
    }))
}

#[utoipa::path(
    post,
    path = "/refresh",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    responses(
        (status = 202, body = RefreshFeedsResponse),
        (status = 500, body = ApiError)
    )
)]
pub async fn refresh_feeds(
    State(state): State<Arc<AppState>>,
) -> Result<(StatusCode, Json<RefreshFeedsResponse>), ApiError> {
    let scheduled =
        subscribed_feeds(state.feeds.list_feeds().await.map_err(feed_store_error)?).len();
    state
        .feeds
        .schedule_refresh(None, Utc::now())
        .await
        .map_err(feed_store_error)?;
    state.feed_refresh.notify_one();
    Ok((
        StatusCode::ACCEPTED,
        Json(RefreshFeedsResponse { scheduled }),
    ))
}

#[utoipa::path(
    post,
    path = "/refresh/{id}",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    params(("id" = i64, Path, description = "Feed identifier")),
    responses(
        (status = 202, body = RefreshFeedsResponse),
        (status = 404, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn refresh_feed(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<(StatusCode, Json<RefreshFeedsResponse>), ApiError> {
    state
        .feeds
        .schedule_refresh(Some(id), Utc::now())
        .await
        .map_err(feed_store_error)?;
    state.feed_refresh.notify_one();
    Ok((
        StatusCode::ACCEPTED,
        Json(RefreshFeedsResponse { scheduled: 1 }),
    ))
}

#[utoipa::path(
    get,
    path = "/entries",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    params(FeedEntriesQuery),
    responses(
        (status = 200, body = FeedEntryPageResponse),
        (status = 400, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn list_entries(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FeedEntriesQuery>,
) -> Result<Json<FeedEntryPageResponse>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_ENTRY_LIMIT);
    if limit == 0 || limit > MAX_ENTRY_LIMIT {
        return Err(ApiError::bad_request(format!(
            "limit must be between 1 and {MAX_ENTRY_LIMIT}"
        )));
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(EntryCursor::parse)
        .transpose()
        .map_err(ApiError::bad_request)?;
    let page = state
        .feeds
        .list_entries(EntryFilters {
            view: query.view.unwrap_or(EntryViewDto::All).into(),
            feed_id: query.feed,
            group: query.group,
            tag: query.tag,
            limit,
            cursor,
        })
        .await
        .map_err(feed_store_error)?;
    Ok(Json(FeedEntryPageResponse {
        entries: page.entries.into_iter().map(Into::into).collect(),
        next_cursor: page.next_cursor.map(|cursor| cursor.encode()),
    }))
}

#[utoipa::path(
    patch,
    path = "/entries/{id}",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    params(("id" = i64, Path, description = "Entry identifier")),
    request_body = PatchFeedEntryRequest,
    responses(
        (status = 200, body = FeedEntryDto),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn patch_entry(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(request): Json<PatchFeedEntryRequest>,
) -> Result<Json<FeedEntryDto>, ApiError> {
    if request.read.is_none() && request.bookmarked.is_none() && request.tags.is_none() {
        return Err(ApiError::bad_request(
            "entry patch must include read, bookmarked, or tags",
        ));
    }
    let entry = state
        .feeds
        .patch_entry(
            id,
            EntryPatch {
                read: request.read,
                bookmarked: request.bookmarked,
                tags: request.tags,
            },
        )
        .await
        .map_err(feed_store_error)?;
    Ok(Json(entry.into()))
}

#[utoipa::path(
    post,
    path = "/entries/mark-read",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    request_body = MarkFeedEntriesReadRequest,
    responses(
        (status = 200, body = MarkFeedEntriesReadResponse),
        (status = 400, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn mark_entries_read(
    State(state): State<Arc<AppState>>,
    Json(request): Json<MarkFeedEntriesReadRequest>,
) -> Result<Json<MarkFeedEntriesReadResponse>, ApiError> {
    let before = request
        .before
        .as_deref()
        .map(EntryCursor::parse)
        .transpose()
        .map_err(ApiError::bad_request)?;
    let marked = state
        .feeds
        .mark_read(MarkReadScope {
            feed_id: request.feed,
            group: request.group,
            tag: request.tag,
            before,
        })
        .await
        .map_err(feed_store_error)?;
    Ok(Json(MarkFeedEntriesReadResponse { marked }))
}

#[derive(Debug)]
struct ImportedFeed {
    group: String,
    url: String,
    title: Option<String>,
}

fn outline_attributes(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<(Option<String>, Option<String>), ApiError> {
    let mut url = None;
    let mut title = None;
    for (index, attribute) in element.attributes().with_checks(false).enumerate() {
        if index >= MAX_OPML_ATTRIBUTES_PER_OUTLINE {
            return Err(ApiError::bad_request(format!(
                "OPML outline exceeds {MAX_OPML_ATTRIBUTES_PER_OUTLINE} attributes"
            )));
        }
        let attribute = attribute.map_err(|error| ApiError::bad_request(error.to_string()))?;
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|error| ApiError::bad_request(error.to_string()))?
            .into_owned();
        if attribute.key.as_ref().eq_ignore_ascii_case(b"xmlUrl") {
            url = Some(value);
        } else if attribute.key.as_ref().eq_ignore_ascii_case(b"text")
            || (title.is_none() && attribute.key.as_ref().eq_ignore_ascii_case(b"title"))
        {
            title = Some(value);
        }
    }
    Ok((url, title))
}

fn parse_opml(source: &str) -> Result<Vec<ImportedFeed>, ApiError> {
    if source.len() > MAX_OPML_BYTES {
        return Err(ApiError::bad_request(format!(
            "OPML document exceeds {MAX_OPML_BYTES} bytes"
        )));
    }
    let mut reader = Reader::from_str(source);
    let mut buffer = Vec::new();
    let mut outline_stack: Vec<Option<String>> = Vec::new();
    let mut outline_count = 0usize;
    let mut feeds = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element))
                if element.name().as_ref().eq_ignore_ascii_case(b"outline") =>
            {
                outline_count += 1;
                if outline_count > MAX_OPML_OUTLINES {
                    return Err(ApiError::bad_request(format!(
                        "OPML document exceeds {MAX_OPML_OUTLINES} outlines"
                    )));
                }
                if outline_stack.len() >= MAX_OPML_DEPTH {
                    return Err(ApiError::bad_request(format!(
                        "OPML outline nesting exceeds depth {MAX_OPML_DEPTH}"
                    )));
                }
                let (url, title) = outline_attributes(&reader, &element)?;
                if let Some(url) = url {
                    let group = outline_stack
                        .iter()
                        .rev()
                        .find_map(|group| group.as_deref())
                        .unwrap_or(DEFAULT_GROUP)
                        .to_owned();
                    feeds.push(ImportedFeed { group, url, title });
                    outline_stack.push(None);
                } else {
                    outline_stack.push(title.filter(|title| !title.trim().is_empty()));
                }
            }
            Ok(Event::Empty(element))
                if element.name().as_ref().eq_ignore_ascii_case(b"outline") =>
            {
                outline_count += 1;
                if outline_count > MAX_OPML_OUTLINES {
                    return Err(ApiError::bad_request(format!(
                        "OPML document exceeds {MAX_OPML_OUTLINES} outlines"
                    )));
                }
                if outline_stack.len() >= MAX_OPML_DEPTH {
                    return Err(ApiError::bad_request(format!(
                        "OPML outline nesting exceeds depth {MAX_OPML_DEPTH}"
                    )));
                }
                let (url, title) = outline_attributes(&reader, &element)?;
                if let Some(url) = url {
                    let group = outline_stack
                        .iter()
                        .rev()
                        .find_map(|group| group.as_deref())
                        .unwrap_or(DEFAULT_GROUP)
                        .to_owned();
                    feeds.push(ImportedFeed { group, url, title });
                }
            }
            Ok(Event::End(element)) if element.name().as_ref().eq_ignore_ascii_case(b"outline") => {
                outline_stack.pop();
            }
            Ok(Event::DocType(_)) => {
                return Err(ApiError::bad_request("OPML document types are not allowed"));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(ApiError::bad_request(format!("invalid OPML: {error}"))),
        }
        buffer.clear();
    }
    Ok(feeds)
}

#[cfg(test)]
pub(crate) fn set_before_opml_parse_hook(
    state: &AppState,
    hook: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    *state.feed_before_opml_parse_hook.lock() = hook;
}

#[utoipa::path(
    post,
    path = "/import",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    request_body = ImportOpmlRequest,
    responses(
        (status = 200, body = ImportOpmlResponse),
        (status = 400, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn import_opml(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ImportOpmlRequest>,
) -> Result<Json<ImportOpmlResponse>, ApiError> {
    {
        let _preflight_guard = state.feed_manifest_lock.lock().await;
        let (_, _, current_revision) = read_manifest_raw(&state).await?;
        if current_revision != request.expected_revision {
            return Err(ApiError::revision_conflict(current_revision));
        }
    }

    #[cfg(test)]
    let before_parse_hook = state.feed_before_opml_parse_hook.lock().clone();
    let opml = request.opml;
    let imported = tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        if let Some(hook) = before_parse_hook {
            hook();
        }
        parse_opml(&opml)
    })
    .await
    .map_err(|error| ApiError::internal(format!("OPML parser task failed: {error}")))??;

    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest_for_mutation(&state, &request.expected_revision).await?;
    let mut seen: HashSet<String> = manifest::parse(&snapshot.text)
        .feeds
        .into_iter()
        .map(|feed| feed.url)
        .collect();
    let mut additions = Vec::new();
    for feed in imported {
        if !seen.insert(feed.url.clone()) {
            continue;
        }
        additions.push(manifest::FeedAddition {
            group: feed.group,
            url: feed.url,
            title_override: feed.title,
            tags: Vec::new(),
        });
    }
    let added = additions.len();
    let revision = if additions.is_empty() {
        snapshot.revision
    } else {
        let candidate =
            manifest::add_feeds(&snapshot.text, additions).map_err(ApiError::bad_request)?;
        publish_manifest(&state, snapshot, candidate).await?
    };
    Ok(Json(ImportOpmlResponse {
        added,
        manifest_revision: revision,
    }))
}

fn escape_xml(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            character => escaped.push(character),
        }
    }
    escaped
}

fn render_opml(feeds: Vec<FeedSummary>) -> String {
    let groups = grouped_feeds(feeds);
    let mut output = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head><title>Clepsydra feeds</title></head>\n  <body>\n",
    );
    for group in groups {
        output.push_str("    <outline text=\"");
        output.push_str(&escape_xml(&group.name));
        output.push_str("\">\n");
        for feed in group.feeds {
            output.push_str("      <outline type=\"rss\" text=\"");
            output.push_str(&escape_xml(
                feed.title_override.as_deref().unwrap_or(&feed.title),
            ));
            output.push_str("\" xmlUrl=\"");
            output.push_str(&escape_xml(&feed.url));
            output.push_str("\"/>\n");
        }
        output.push_str("    </outline>\n");
    }
    output.push_str("  </body>\n</opml>\n");
    output
}

#[utoipa::path(
    get,
    path = "/export",
    context_path = "/api/vault/feeds",
    tag = "Feeds",
    responses(
        (status = 200, body = String, content_type = "application/xml"),
        (status = 500, body = ApiError)
    )
)]
pub async fn export_opml(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let feeds = state.feeds.list_feeds().await.map_err(feed_store_error)?;
    Ok((
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/xml; charset=utf-8"),
        )],
        render_opml(feeds),
    )
        .into_response())
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_feeds).post(subscribe_feed))
        .route(
            "/{id}",
            axum::routing::patch(update_feed).delete(delete_feed),
        )
        .route("/refresh", post(refresh_feeds))
        .route("/refresh/{id}", post(refresh_feed))
        .route("/entries", get(list_entries))
        .route("/entries/{id}", axum::routing::patch(patch_entry))
        .route("/entries/mark-read", post(mark_entries_read))
        .route("/import", post(import_opml))
        .route("/export", get(export_opml))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, StatusCode, header};
    use axum::response::{IntoResponse, Response};
    use chrono::{DateTime, TimeZone, Utc};
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use super::{
        MAX_OPML_ATTRIBUTES_PER_OUTLINE, MAX_OPML_BYTES, MAX_OPML_DEPTH, MAX_OPML_OUTLINES,
        parse_opml, set_after_list_snapshot_hook, set_before_opml_parse_hook,
    };

    use crate::api::AppState;
    use crate::feeds::manifest;
    use crate::feeds::scheduler::reconcile_feed_manifest;
    use crate::feeds::types::{
        EntryCursor, EntryFilters, EntryView, FetchOutcome, FetchedEntry, ManifestFeed,
    };
    use crate::vault::page::page_revision;
    use crate::{FeedsSettings, build_app_state_with_feeds};

    struct FeedTestApp {
        app: Router,
        state: Arc<AppState>,
        _temp: TempDir,
    }

    async fn feed_test_app(manifest: &str) -> FeedTestApp {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("feeds.md"), manifest.as_bytes()).unwrap();
        let state = build_app_state_with_feeds(&root, &FeedsSettings::default())
            .await
            .unwrap();
        reconcile_feed_manifest(&state).await.unwrap();
        let app = Router::new()
            .nest("/api/vault", crate::api::api_router())
            .with_state(Arc::clone(&state));
        FeedTestApp {
            app,
            state,
            _temp: temp,
        }
    }

    async fn feed_test_app_with_client(
        manifest: &str,
        settings: FeedsSettings,
        client: crate::feeds::network::CheckedHttpClient,
    ) -> FeedTestApp {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("feeds.md"), manifest.as_bytes()).unwrap();
        let mut state = build_app_state_with_feeds(&root, &settings).await.unwrap();
        Arc::get_mut(&mut state)
            .expect("fresh fixture state should be uniquely owned")
            .feed_client = client;
        reconcile_feed_manifest(&state).await.unwrap();
        let app = Router::new()
            .nest("/api/vault", crate::api::api_router())
            .with_state(Arc::clone(&state));
        FeedTestApp {
            app,
            state,
            _temp: temp,
        }
    }

    fn rss_document(guid: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel>\
             <title>Fixture</title><link>https://fixture.example</link>\
             <description>Fixture feed</description><item><guid>{guid}</guid>\
             <title>Entry</title><link>https://fixture.example/entry</link></item>\
             </channel></rss>"
        )
    }

    #[derive(Clone)]
    struct GatedFeedServer {
        started: tokio::sync::mpsc::UnboundedSender<String>,
        release: tokio::sync::watch::Receiver<bool>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
    }

    async fn gated_feed_response(
        axum::extract::State(mut state): axum::extract::State<GatedFeedServer>,
        uri: axum::http::Uri,
    ) -> Response {
        let active = state.active.fetch_add(1, Ordering::AcqRel) + 1;
        state.max_active.fetch_max(active, Ordering::AcqRel);
        state.started.send(uri.path().to_owned()).unwrap();
        loop {
            let released = *state.release.borrow();
            if released {
                break;
            }
            state.release.changed().await.unwrap();
        }
        state.active.fetch_sub(1, Ordering::AcqRel);
        (
            [(header::CONTENT_TYPE, "application/rss+xml")],
            rss_document(uri.path()),
        )
            .into_response()
    }

    async fn spawn_gated_feed_server() -> (
        std::net::SocketAddr,
        tokio::sync::mpsc::UnboundedReceiver<String>,
        tokio::sync::watch::Sender<bool>,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started_tx, started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .fallback(gated_feed_response)
            .with_state(GatedFeedServer {
                started: started_tx,
                release: release_rx,
                active,
                max_active: Arc::clone(&max_active),
            });
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, started_rx, release_tx, max_active, server)
    }

    async fn delayed_discovery_response(uri: axum::http::Uri) -> Response {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if uri.path() == "/start" {
            (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                "<html><head><link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\"></head></html>"
            )
                .into_response()
        } else {
            (
                [(header::CONTENT_TYPE, "application/rss+xml")],
                rss_document("deadline"),
            )
                .into_response()
        }
    }

    async fn spawn_delayed_discovery_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>)
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().fallback(delayed_discovery_response);
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, server)
    }

    async fn request_json(
        app: &Router,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(value) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        };
        (status, value)
    }

    fn fixture_time(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 9, hour, 0, 0)
            .single()
            .unwrap()
    }

    fn fetched_entry(guid: &str, hour: u32) -> FetchedEntry {
        FetchedEntry {
            guid: guid.to_owned(),
            url: Some(format!("https://entries.example/{guid}")),
            title: guid.to_owned(),
            author: None,
            content_html: None,
            published_at: Some(fixture_time(hour)),
            fetched_at: fixture_time(hour),
        }
    }

    async fn seed_unread_entries(state: &Arc<AppState>, entries: Vec<FetchedEntry>) -> i64 {
        state
            .feeds
            .reconcile(vec![ManifestFeed {
                url: "https://fixture.example/rss".to_owned(),
                title_override: Some("Fixture".to_owned()),
                group: "Fixtures".to_owned(),
                tags: vec!["fixture".to_owned()],
                line: 1,
            }])
            .await
            .unwrap();
        let feed_id = state.feeds.list_feeds().await.unwrap()[0].id;
        state
            .feeds
            .apply_fetch(
                feed_id,
                FetchOutcome::Success {
                    fetched_at: fixture_time(12),
                    next_fetch_at: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                    fetch_url: "https://fixture.example/rss".to_owned(),
                    etag: None,
                    last_modified: None,
                    title: Some("Fixture".to_owned()),
                    site_url: Some("https://fixture.example".to_owned()),
                    entries,
                },
            )
            .await
            .unwrap();
        feed_id
    }

    async fn unread_entries(state: &Arc<AppState>) -> Vec<crate::feeds::types::Entry> {
        state
            .feeds
            .list_entries(EntryFilters {
                view: EntryView::Unread,
                feed_id: None,
                group: None,
                tag: None,
                limit: 100,
                cursor: None,
            })
            .await
            .unwrap()
            .entries
    }

    fn entry_ids(response: &Value) -> Vec<i64> {
        response["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_i64().unwrap())
            .collect()
    }

    #[tokio::test]
    async fn list_entries_defaults_to_all() {
        let fixture = feed_test_app("").await;
        seed_unread_entries(
            &fixture.state,
            vec![
                fetched_entry("read-entry", 11),
                fetched_entry("unread-entry", 10),
            ],
        )
        .await;
        let seeded = unread_entries(&fixture.state).await;
        let read_id = seeded
            .iter()
            .find(|entry| entry.guid == "read-entry")
            .unwrap()
            .id;
        let unread_id = seeded
            .iter()
            .find(|entry| entry.guid == "unread-entry")
            .unwrap()
            .id;

        let (status, _) = request_json(
            &fixture.app,
            Method::PATCH,
            &format!("/api/vault/feeds/entries/{read_id}"),
            Some(json!({ "read": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, all) =
            request_json(&fixture.app, Method::GET, "/api/vault/feeds/entries", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(entry_ids(&all), [read_id, unread_id]);

        let (status, hidden) = request_json(
            &fixture.app,
            Method::GET,
            "/api/vault/feeds/entries?view=unread",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(entry_ids(&hidden), [unread_id]);
    }

    #[tokio::test]
    async fn malformed_mark_read_cursor_is_bad_request_and_changes_nothing() {
        let fixture = feed_test_app("").await;
        seed_unread_entries(
            &fixture.state,
            vec![fetched_entry("older", 10), fetched_entry("newer", 11)],
        )
        .await;

        let (status, _) = request_json(
            &fixture.app,
            Method::POST,
            "/api/vault/feeds/entries/mark-read",
            Some(json!({ "before": "not-a-cursor" })),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(unread_entries(&fixture.state).await.len(), 2);
    }

    #[tokio::test]
    async fn absent_mark_read_cursor_marks_the_complete_scope() {
        let fixture = feed_test_app("").await;
        seed_unread_entries(
            &fixture.state,
            vec![fetched_entry("older", 10), fetched_entry("newer", 11)],
        )
        .await;

        let (status, body) = request_json(
            &fixture.app,
            Method::POST,
            "/api/vault/feeds/entries/mark-read",
            Some(json!({})),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["marked"], 2);
        assert!(unread_entries(&fixture.state).await.is_empty());
    }

    #[tokio::test]
    async fn mark_read_boundary_leaves_entries_arriving_after_the_gesture_unread() {
        let fixture = feed_test_app("").await;
        let feed_id = seed_unread_entries(
            &fixture.state,
            vec![fetched_entry("older", 10), fetched_entry("boundary", 11)],
        )
        .await;
        let existing = unread_entries(&fixture.state).await;
        let newest = &existing[0];
        let boundary = EntryCursor {
            sort_ts: newest.published_at.unwrap_or(newest.fetched_at),
            id: newest.id,
        }
        .encode();

        fixture
            .state
            .feeds
            .apply_fetch(
                feed_id,
                FetchOutcome::Success {
                    fetched_at: fixture_time(12),
                    next_fetch_at: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                    fetch_url: "https://fixture.example/rss".to_owned(),
                    etag: None,
                    last_modified: None,
                    title: Some("Fixture".to_owned()),
                    site_url: Some("https://fixture.example".to_owned()),
                    entries: vec![fetched_entry("arrived-late", 12)],
                },
            )
            .await
            .unwrap();

        let (status, body) = request_json(
            &fixture.app,
            Method::POST,
            "/api/vault/feeds/entries/mark-read",
            Some(json!({ "before": boundary })),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["marked"], 2);
        let unread = unread_entries(&fixture.state).await;
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].guid, "arrived-late");
    }

    #[tokio::test]
    async fn warning_manifest_preserves_the_last_good_subscription_set() {
        let fixture =
            feed_test_app("## Stable\n- [Stable](https://stable.example/rss) #stable\n").await;
        let before = fixture.state.feeds.list_feeds().await.unwrap();
        assert_eq!(before.len(), 1);

        std::fs::write(
            fixture.state.vault.root().join("feeds.md"),
            "## Replacement\n- [Replacement](https://replacement.example/rss)\n- [Broken]()\n",
        )
        .unwrap();
        reconcile_feed_manifest(&fixture.state).await.unwrap();

        let after = fixture.state.feeds.list_feeds().await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].url, "https://stable.example/rss");
        assert_eq!(after[0].group, "Stable");
        assert_eq!(after[0].tags, ["stable"]);
    }

    #[tokio::test]
    async fn list_is_grouped_and_reports_diagnostics_with_the_raw_manifest_revision() {
        let fixture =
            feed_test_app("## Stable\n- [Stable](https://stable.example/rss) #stable\n").await;
        let warning_manifest =
            "## Replacement\n- [Replacement](https://replacement.example/rss)\n- [Broken]()\n";
        std::fs::write(
            fixture.state.vault.root().join("feeds.md"),
            warning_manifest,
        )
        .unwrap();
        reconcile_feed_manifest(&fixture.state).await.unwrap();

        let (status, body) =
            request_json(&fixture.app, Method::GET, "/api/vault/feeds", None).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["manifest_revision"], page_revision(warning_manifest));
        assert_eq!(body["groups"].as_array().unwrap().len(), 1);
        assert_eq!(body["groups"][0]["name"], "Stable");
        assert_eq!(
            body["groups"][0]["feeds"][0]["url"],
            "https://stable.example/rss"
        );
        assert_eq!(body["diagnostics"].as_array().unwrap().len(), 1);
        assert_eq!(body["diagnostics"][0]["line"], 3);
        assert!(
            body["diagnostics"][0]["message"]
                .as_str()
                .unwrap()
                .contains("malformed")
        );
    }

    #[tokio::test]
    async fn feed_list_counts_follow_entry_read_and_bookmark_mutations() {
        let fixture = feed_test_app("").await;
        seed_unread_entries(
            &fixture.state,
            vec![fetched_entry("older", 10), fetched_entry("newer", 11)],
        )
        .await;

        let (status, initial) =
            request_json(&fixture.app, Method::GET, "/api/vault/feeds", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            initial["counts"],
            json!({ "unread": 2, "all": 2, "saved": 0 })
        );

        let older = unread_entries(&fixture.state)
            .await
            .into_iter()
            .find(|entry| entry.guid == "older")
            .unwrap();
        let (status, _) = request_json(
            &fixture.app,
            Method::PATCH,
            &format!("/api/vault/feeds/entries/{}", older.id),
            Some(json!({ "read": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, after_read) =
            request_json(&fixture.app, Method::GET, "/api/vault/feeds", None).await;
        assert_eq!(
            after_read["counts"],
            json!({ "unread": 1, "all": 2, "saved": 0 })
        );

        let (status, _) = request_json(
            &fixture.app,
            Method::PATCH,
            &format!("/api/vault/feeds/entries/{}", older.id),
            Some(json!({ "read": false, "bookmarked": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, after_unread_and_bookmark) =
            request_json(&fixture.app, Method::GET, "/api/vault/feeds", None).await;
        assert_eq!(
            after_unread_and_bookmark["counts"],
            json!({ "unread": 2, "all": 2, "saved": 1 })
        );

        let (status, marked) = request_json(
            &fixture.app,
            Method::POST,
            "/api/vault/feeds/entries/mark-read",
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(marked["marked"], 2);
        let (_, after_mark_all_read) =
            request_json(&fixture.app, Method::GET, "/api/vault/feeds", None).await;
        assert_eq!(
            after_mark_all_read["counts"],
            json!({ "unread": 0, "all": 2, "saved": 1 })
        );
    }

    #[tokio::test]
    async fn membership_mutations_return_structured_current_revision_conflicts() {
        let manifest = "## Stable\n- [Stable](https://stable.example/rss)\n";
        let fixture = feed_test_app(manifest).await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        let current_revision = page_revision(manifest);
        let requests = [
            (
                Method::POST,
                "/api/vault/feeds".to_owned(),
                json!({
                    "url": "http://127.0.0.1:9/new-feed",
                    "expected_revision": "stale"
                }),
            ),
            (
                Method::PATCH,
                format!("/api/vault/feeds/{feed_id}"),
                json!({ "title": "Changed", "expected_revision": "stale" }),
            ),
            (
                Method::DELETE,
                format!("/api/vault/feeds/{feed_id}"),
                json!({ "expected_revision": "stale" }),
            ),
            (
                Method::POST,
                "/api/vault/feeds/import".to_owned(),
                json!({
                    "expected_revision": "stale",
                    "opml": "<?xml version=\"1.0\"?><opml version=\"2.0\"><body><outline type=\"rss\" xmlUrl=\"https://import.example/rss\"/></body></opml>"
                }),
            ),
        ];

        for (method, uri, body) in requests {
            let (status, body) = request_json(&fixture.app, method, &uri, Some(body)).await;
            assert_eq!(status, StatusCode::CONFLICT, "{uri}");
            assert_eq!(body["status"], 409, "{uri}");
            assert_eq!(body["detail"]["code"], "revision_conflict", "{uri}");
            assert_eq!(
                body["detail"]["current_revision"], current_revision,
                "{uri}"
            );
            assert_eq!(
                std::fs::read(fixture.state.vault.root().join("feeds.md")).unwrap(),
                manifest.as_bytes(),
                "stale {uri} must not publish"
            );
        }
    }

    #[tokio::test]
    async fn stale_revision_precedes_invalid_utf8_for_every_membership_mutation() {
        let fixture = feed_test_app("## Stable\n- [Stable](https://stable.example/rss)\n").await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        let invalid = b"## Invalid\n- \xff\n".to_vec();
        std::fs::write(fixture.state.vault.root().join("feeds.md"), &invalid).unwrap();
        let raw_revision = blake3::hash(&invalid).to_hex().to_string();
        let requests = [
            (
                Method::POST,
                "/api/vault/feeds".to_owned(),
                json!({
                    "url": "http://127.0.0.1:9/new-feed",
                    "expected_revision": "stale"
                }),
            ),
            (
                Method::PATCH,
                format!("/api/vault/feeds/{feed_id}"),
                json!({ "group": "Changed", "expected_revision": "stale" }),
            ),
            (
                Method::DELETE,
                format!("/api/vault/feeds/{feed_id}"),
                json!({ "expected_revision": "stale" }),
            ),
            (
                Method::POST,
                "/api/vault/feeds/import".to_owned(),
                json!({
                    "expected_revision": "stale",
                    "opml": "<opml><body><outline xmlUrl=\"https://import.example/rss\"/></body></opml>"
                }),
            ),
        ];

        for (method, uri, body) in requests {
            let (status, response) = request_json(&fixture.app, method, &uri, Some(body)).await;
            assert_eq!(status, StatusCode::CONFLICT, "{uri}");
            assert_eq!(response["status"], 409, "{uri}");
            assert_eq!(response["detail"]["code"], "revision_conflict", "{uri}");
            assert_eq!(
                response["detail"]["current_revision"], raw_revision,
                "{uri}"
            );
            assert_eq!(
                std::fs::read(fixture.state.vault.root().join("feeds.md")).unwrap(),
                invalid,
                "{uri} must not normalize or replace invalid raw bytes"
            );
        }
    }

    #[tokio::test]
    async fn current_revision_with_invalid_utf8_is_a_bad_request() {
        let fixture = feed_test_app("## Stable\n- [Stable](https://stable.example/rss)\n").await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        let invalid = b"## Invalid\n- \xff\n".to_vec();
        std::fs::write(fixture.state.vault.root().join("feeds.md"), &invalid).unwrap();
        let raw_revision = blake3::hash(&invalid).to_hex().to_string();
        let requests = [
            (
                Method::POST,
                "/api/vault/feeds".to_owned(),
                json!({
                    "url": "http://127.0.0.1:9/new-feed",
                    "expected_revision": raw_revision
                }),
            ),
            (
                Method::PATCH,
                format!("/api/vault/feeds/{feed_id}"),
                json!({ "group": "Changed", "expected_revision": raw_revision }),
            ),
            (
                Method::DELETE,
                format!("/api/vault/feeds/{feed_id}"),
                json!({ "expected_revision": raw_revision }),
            ),
            (
                Method::POST,
                "/api/vault/feeds/import".to_owned(),
                json!({
                    "expected_revision": raw_revision,
                    "opml": "<opml><body><outline xmlUrl=\"https://import.example/rss\"/></body></opml>"
                }),
            ),
        ];

        for (method, uri, body) in requests {
            let (status, _) = request_json(&fixture.app, method, &uri, Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(
                std::fs::read(fixture.state.vault.root().join("feeds.md")).unwrap(),
                invalid,
                "{uri} must leave invalid raw bytes untouched"
            );
        }
    }

    #[tokio::test]
    async fn publication_race_to_invalid_utf8_returns_the_raw_revision_conflict() {
        let manifest = "## Stable\n- [Stable](https://stable.example/rss)\n";
        let fixture = feed_test_app(manifest).await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        let invalid = b"## Invalid\n- \xff\n".to_vec();
        let external_path = fixture.state.vault.root().join("invalid-feeds.md");
        std::fs::write(&external_path, &invalid).unwrap();
        let destination = fixture.state.vault.root().join("feeds.md");
        fixture
            .state
            .mutation_coordinator
            .set_before_update_publish_hook(Some(Arc::new(move |path| {
                assert_eq!(path.as_str(), "feeds.md");
                std::fs::rename(&external_path, &destination).unwrap();
            })));

        let (status, body) = request_json(
            &fixture.app,
            Method::PATCH,
            &format!("/api/vault/feeds/{feed_id}"),
            Some(json!({
                "group": "Changed",
                "expected_revision": page_revision(manifest)
            })),
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["status"], 409);
        assert_eq!(body["detail"]["code"], "revision_conflict");
        assert_eq!(
            body["detail"]["current_revision"],
            blake3::hash(&invalid).to_hex().to_string()
        );
        assert_eq!(
            std::fs::read(fixture.state.vault.root().join("feeds.md")).unwrap(),
            invalid
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn older_reconcile_cannot_overwrite_a_newer_manifest_patch() {
        let manifest = "## Old\n- [Fixture](https://fixture.example/rss)\n";
        let fixture = feed_test_app(manifest).await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        let first_hook = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(parking_lot::Mutex::new(release_rx));
        crate::feeds::scheduler::set_before_reconcile_commit_hook(
            &fixture.state,
            Some(Arc::new({
                let first_hook = Arc::clone(&first_hook);
                let release_rx = Arc::clone(&release_rx);
                move || {
                    if first_hook.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        entered_tx.send(()).unwrap();
                        release_rx.lock().recv().unwrap();
                    }
                }
            })),
        );
        let old_reconcile = tokio::spawn({
            let state = Arc::clone(&fixture.state);
            async move { reconcile_feed_manifest(&state).await }
        });
        tokio::task::spawn_blocking(move || {
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap()
        })
        .await
        .unwrap();

        let mut patch = tokio::spawn({
            let app = fixture.app.clone();
            async move {
                request_json(
                    &app,
                    Method::PATCH,
                    &format!("/api/vault/feeds/{feed_id}"),
                    Some(json!({
                        "group": "New",
                        "expected_revision": page_revision(manifest)
                    })),
                )
                .await
            }
        });
        let early_patch = tokio::time::timeout(Duration::from_millis(50), &mut patch).await;
        let patch_was_serialized = early_patch.is_err();
        release_tx.send(()).unwrap();
        old_reconcile.await.unwrap().unwrap();
        let (status, _) = match early_patch {
            Ok(result) => result.unwrap(),
            Err(_) => patch.await.unwrap(),
        };
        crate::feeds::scheduler::set_before_reconcile_commit_hook(&fixture.state, None);

        assert!(
            patch_was_serialized,
            "manifest mutation must wait for the older reconcile snapshot to commit"
        );
        assert_eq!(status, StatusCode::OK);
        let feeds = fixture.state.feeds.list_feeds().await.unwrap();
        assert_eq!(feeds.len(), 1);
        assert_eq!(feeds[0].group, "New");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn list_groups_diagnostics_and_revision_come_from_one_serialized_snapshot() {
        let valid_manifest = "## Old\n- [Fixture](https://fixture.example/rss)\n";
        let old_manifest = "## Old\n- [Fixture](https://fixture.example/rss)\n- [Broken]()\n";
        let new_manifest = "## New\n- [Fixture](https://fixture.example/rss)\n";
        let fixture = feed_test_app(valid_manifest).await;
        std::fs::write(fixture.state.vault.root().join("feeds.md"), old_manifest).unwrap();
        reconcile_feed_manifest(&fixture.state).await.unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(parking_lot::Mutex::new(release_rx));
        set_after_list_snapshot_hook(
            &fixture.state,
            Some(Arc::new({
                let release_rx = Arc::clone(&release_rx);
                move || {
                    entered_tx.send(()).unwrap();
                    release_rx.lock().recv().unwrap();
                }
            })),
        );
        let listing = tokio::spawn({
            let app = fixture.app.clone();
            async move { request_json(&app, Method::GET, "/api/vault/feeds", None).await }
        });
        tokio::task::spawn_blocking(move || {
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap()
        })
        .await
        .unwrap();

        std::fs::write(fixture.state.vault.root().join("feeds.md"), new_manifest).unwrap();
        let mut newer_reconcile = tokio::spawn({
            let state = Arc::clone(&fixture.state);
            async move { reconcile_feed_manifest(&state).await }
        });
        let early_reconcile =
            tokio::time::timeout(Duration::from_millis(50), &mut newer_reconcile).await;
        let reconcile_was_serialized = early_reconcile.is_err();
        release_tx.send(()).unwrap();
        let (status, body) = listing.await.unwrap();
        match early_reconcile {
            Ok(result) => result.unwrap().unwrap(),
            Err(_) => newer_reconcile.await.unwrap().unwrap(),
        }
        set_after_list_snapshot_hook(&fixture.state, None);

        assert!(
            reconcile_was_serialized,
            "external reconciliation must wait until list response snapshotting completes"
        );
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["manifest_revision"], page_revision(old_manifest));
        assert_eq!(body["groups"][0]["name"], "Old");
        assert_eq!(body["diagnostics"].as_array().unwrap().len(), 1);
        assert_eq!(body["diagnostics"][0]["line"], 3);
        assert_eq!(
            fixture.state.feeds.list_feeds().await.unwrap()[0].group,
            "New"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn slow_discovery_does_not_block_current_patch_delete_or_import() {
        for operation in ["patch", "delete", "import"] {
            let (address, mut started, release, _max_active, server) =
                spawn_gated_feed_server().await;
            let client =
                crate::feeds::network::CheckedHttpClient::for_test(1_048_576, "feed.test", address)
                    .unwrap()
                    .with_deadline(Duration::from_secs(2));
            let manifest = "## Existing\n- [Existing](https://existing.example/rss)\n";
            let fixture =
                feed_test_app_with_client(manifest, FeedsSettings::default(), client).await;
            let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
            let subscribe = tokio::spawn({
                let app = fixture.app.clone();
                let url = format!("http://feed.test:{}/slow", address.port());
                async move {
                    request_json(
                        &app,
                        Method::POST,
                        "/api/vault/feeds",
                        Some(json!({
                            "url": url,
                            "expected_revision": page_revision(manifest)
                        })),
                    )
                    .await
                }
            });
            tokio::time::timeout(Duration::from_secs(1), started.recv())
                .await
                .expect("slow discovery did not reach the local fixture")
                .expect("slow discovery fixture closed");

            let (method, uri, body) = match operation {
                "patch" => (
                    Method::PATCH,
                    format!("/api/vault/feeds/{feed_id}"),
                    json!({
                        "group": "Changed",
                        "expected_revision": page_revision(manifest)
                    }),
                ),
                "delete" => (
                    Method::DELETE,
                    format!("/api/vault/feeds/{feed_id}"),
                    json!({ "expected_revision": page_revision(manifest) }),
                ),
                "import" => (
                    Method::POST,
                    "/api/vault/feeds/import".to_owned(),
                    json!({
                        "expected_revision": page_revision(manifest),
                        "opml": "<opml><body><outline xmlUrl=\"https://import.example/rss\"/></body></opml>"
                    }),
                ),
                _ => unreachable!(),
            };
            let mut mutation = tokio::spawn({
                let app = fixture.app.clone();
                async move { request_json(&app, method, &uri, Some(body)).await }
            });
            let early_mutation =
                tokio::time::timeout(Duration::from_millis(200), &mut mutation).await;
            let completed_while_discovery_pending = early_mutation.is_ok();
            release.send(true).unwrap();
            let (mutation_status, _) = match early_mutation {
                Ok(result) => result.unwrap(),
                Err(_) => mutation.await.unwrap(),
            };
            let (subscribe_status, _) = tokio::time::timeout(Duration::from_secs(2), subscribe)
                .await
                .unwrap()
                .unwrap();
            server.abort();

            assert!(
                completed_while_discovery_pending,
                "{operation} was blocked behind unrelated feed discovery"
            );
            assert_eq!(mutation_status, StatusCode::OK, "{operation}");
            assert_eq!(
                subscribe_status,
                StatusCode::CONFLICT,
                "the slow subscribe must recheck revision after discovery"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn subscribe_discovery_uses_the_configured_concurrency_cap() {
        let (address, mut started, release, max_active, server) = spawn_gated_feed_server().await;
        let client =
            crate::feeds::network::CheckedHttpClient::for_test(1_048_576, "feed.test", address)
                .unwrap()
                .with_deadline(Duration::from_secs(2));
        let settings = FeedsSettings {
            fetch_concurrency: 2,
            ..FeedsSettings::default()
        };
        let fixture = feed_test_app_with_client("", settings, client).await;
        let mut subscriptions = Vec::new();
        for index in 0..3 {
            let app = fixture.app.clone();
            let url = format!("http://feed.test:{}/feed-{index}", address.port());
            subscriptions.push(tokio::spawn(async move {
                request_json(
                    &app,
                    Method::POST,
                    "/api/vault/feeds",
                    Some(json!({
                        "url": url,
                        "expected_revision": page_revision("")
                    })),
                )
                .await
            }));
        }

        let first_started = tokio::time::timeout(Duration::from_secs(1), started.recv())
            .await
            .ok()
            .flatten()
            .is_some();
        let second_started = tokio::time::timeout(Duration::from_secs(1), started.recv())
            .await
            .ok()
            .flatten()
            .is_some();
        let third_started_early = if first_started && second_started {
            tokio::time::timeout(Duration::from_millis(100), started.recv())
                .await
                .ok()
                .flatten()
                .is_some()
        } else {
            false
        };
        release.send(true).unwrap();
        for subscription in subscriptions {
            let (status, _) = tokio::time::timeout(Duration::from_secs(2), subscription)
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(status, StatusCode::CREATED | StatusCode::CONFLICT),
                "unexpected subscribe status {status}"
            );
        }
        server.abort();

        assert!(
            first_started && second_started,
            "two discoveries should run together"
        );
        assert!(
            !third_started_early,
            "a third discovery exceeded fetch_concurrency"
        );
        assert_eq!(max_active.load(Ordering::Acquire), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn subscribe_deadline_includes_waiting_for_the_discovery_permit() {
        let (address, mut started, release, _max_active, server) = spawn_gated_feed_server().await;
        let client =
            crate::feeds::network::CheckedHttpClient::for_test(1_048_576, "feed.test", address)
                .unwrap()
                .with_deadline(Duration::from_millis(300));
        let settings = FeedsSettings {
            fetch_concurrency: 1,
            ..FeedsSettings::default()
        };
        let fixture = feed_test_app_with_client("", settings, client).await;
        let first = tokio::spawn({
            let app = fixture.app.clone();
            let url = format!("http://feed.test:{}/first", address.port());
            async move {
                request_json(
                    &app,
                    Method::POST,
                    "/api/vault/feeds",
                    Some(json!({
                        "url": url,
                        "expected_revision": page_revision("")
                    })),
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(1), started.recv())
            .await
            .unwrap()
            .unwrap();
        let mut second = tokio::spawn({
            let app = fixture.app.clone();
            let url = format!("http://feed.test:{}/second", address.port());
            async move {
                request_json(
                    &app,
                    Method::POST,
                    "/api/vault/feeds",
                    Some(json!({
                        "url": url,
                        "expected_revision": page_revision("")
                    })),
                )
                .await
            }
        });

        let second_before_release =
            tokio::time::timeout(Duration::from_millis(600), &mut second).await;
        let permit_wait_was_bounded = second_before_release.is_ok();
        let second_reached_server = tokio::time::timeout(Duration::from_millis(50), started.recv())
            .await
            .ok()
            .flatten()
            .is_some();
        release.send(true).unwrap();
        let (second_status, second_body) = match second_before_release {
            Ok(result) => result.unwrap(),
            Err(_) => second.await.unwrap(),
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), first).await;
        server.abort();

        assert!(
            permit_wait_was_bounded,
            "subscribe deadline did not include semaphore queue time"
        );
        assert!(
            !second_reached_server,
            "expired queued discovery must not start an HTTP request"
        );
        assert_eq!(second_status, StatusCode::BAD_REQUEST);
        assert!(
            second_body["error"]
                .as_str()
                .unwrap()
                .to_ascii_lowercase()
                .contains("deadline")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn subscribe_discovery_uses_one_deadline_across_html_and_feed_requests() {
        let (address, server) = spawn_delayed_discovery_server().await;
        let client =
            crate::feeds::network::CheckedHttpClient::for_test(1_048_576, "feed.test", address)
                .unwrap()
                .with_deadline(Duration::from_millis(300));
        let fixture = feed_test_app_with_client("", FeedsSettings::default(), client).await;

        let (status, body) = tokio::time::timeout(
            Duration::from_secs(1),
            request_json(
                &fixture.app,
                Method::POST,
                "/api/vault/feeds",
                Some(json!({
                    "url": format!("http://feed.test:{}/start", address.port()),
                    "expected_revision": page_revision("")
                })),
            ),
        )
        .await
        .expect("subscribe exceeded the local end-to-end test bound");
        server.abort();

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap()
                .to_ascii_lowercase()
                .contains("deadline"),
            "deadline failure should remain typed and actionable: {body}"
        );
    }

    #[tokio::test]
    async fn targeted_refresh_schedules_the_feed_and_notifies_the_scheduler() {
        let fixture = feed_test_app("## Fixture\n- [Fixture](https://fixture.example/rss)\n").await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        fixture
            .state
            .feeds
            .apply_fetch(
                feed_id,
                FetchOutcome::Failure {
                    fetched_at: fixture_time(12),
                    next_fetch_at: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                    error: "fixture bookkeeping".to_owned(),
                },
            )
            .await
            .unwrap();
        let notified = fixture.state.feed_refresh.notified();
        tokio::pin!(notified);
        let mut changes = fixture.state.change_tx.subscribe();

        let (status, _) = request_json(
            &fixture.app,
            Method::POST,
            &format!("/api/vault/feeds/refresh/{feed_id}"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::ACCEPTED);
        tokio::time::timeout(Duration::from_millis(100), &mut notified)
            .await
            .expect("refresh handler did not notify the scheduler");
        let due = fixture.state.feeds.due_feeds(Utc::now()).await.unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, feed_id);
        let feed = fixture.state.feeds.list_feeds().await.unwrap().remove(0);
        assert_eq!(
            feed.last_fetch_at,
            Some(fixture_time(12)),
            "202 Accepted schedules work; it must not claim a completed fetch"
        );
        assert_eq!(feed.last_error.as_deref(), Some("fixture bookkeeping"));
        assert!(matches!(
            changes.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn stale_import_revision_precedes_every_opml_parse_rejection() {
        let manifest = "## Stable\n- [Stable](https://stable.example/rss)\n";
        let fixture = feed_test_app(manifest).await;
        set_before_opml_parse_hook(
            &fixture.state,
            Some(Arc::new(|| {
                panic!("stale OPML import must not invoke the parser")
            })),
        );
        let oversized = " ".repeat(MAX_OPML_BYTES + 1);
        let documents = [
            "<opml><body><outline".to_owned(),
            oversized,
            "<!DOCTYPE opml><opml><body></body></opml>".to_owned(),
        ];

        for opml in documents {
            let (status, body) = request_json(
                &fixture.app,
                Method::POST,
                "/api/vault/feeds/import",
                Some(json!({
                    "expected_revision": "stale",
                    "opml": opml
                })),
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(body["status"], 409);
            assert_eq!(body["detail"]["code"], "revision_conflict");
            assert_eq!(body["detail"]["current_revision"], page_revision(manifest));
            assert_eq!(
                std::fs::read(fixture.state.vault.root().join("feeds.md")).unwrap(),
                manifest.as_bytes()
            );
        }
        set_before_opml_parse_hook(&fixture.state, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn opml_parse_releases_manifest_lock_and_rechecks_revision_before_publish() {
        let manifest = "## Stable\n- [Stable](https://stable.example/rss)\n";
        let fixture = feed_test_app(manifest).await;
        let feed_id = fixture.state.feeds.list_feeds().await.unwrap()[0].id;
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(parking_lot::Mutex::new(release_rx));
        set_before_opml_parse_hook(
            &fixture.state,
            Some(Arc::new({
                let release_rx = Arc::clone(&release_rx);
                move || {
                    entered_tx.send(()).unwrap();
                    release_rx.lock().recv().unwrap();
                }
            })),
        );
        let import = tokio::spawn({
            let app = fixture.app.clone();
            async move {
                request_json(
                    &app,
                    Method::POST,
                    "/api/vault/feeds/import",
                    Some(json!({
                        "expected_revision": page_revision(manifest),
                        "opml": "<opml><body><outline text=\"Imported\" xmlUrl=\"https://imported.example/rss\"/></body></opml>"
                    })),
                )
                .await
            }
        });
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::task::spawn_blocking(move || entered_rx.recv().unwrap()),
        )
        .await
        .expect("OPML parser did not reach the deterministic blocking seam")
        .unwrap();

        let (patch_status, patch_body) = tokio::time::timeout(
            Duration::from_secs(1),
            request_json(
                &fixture.app,
                Method::PATCH,
                &format!("/api/vault/feeds/{feed_id}"),
                Some(json!({
                    "group": "Changed",
                    "expected_revision": page_revision(manifest)
                })),
            ),
        )
        .await
        .expect("OPML parsing held the manifest mutation lock");
        assert_eq!(patch_status, StatusCode::OK);
        let patched_revision = patch_body["manifest_revision"].as_str().unwrap().to_owned();
        release_tx.send(()).unwrap();
        let (import_status, import_body) = tokio::time::timeout(Duration::from_secs(1), import)
            .await
            .unwrap()
            .unwrap();
        set_before_opml_parse_hook(&fixture.state, None);

        assert_eq!(import_status, StatusCode::CONFLICT);
        assert_eq!(import_body["status"], 409);
        assert_eq!(import_body["detail"]["code"], "revision_conflict");
        assert_eq!(import_body["detail"]["current_revision"], patched_revision);
        let parsed = manifest::parse(
            &std::fs::read_to_string(fixture.state.vault.root().join("feeds.md")).unwrap(),
        );
        assert_eq!(parsed.feeds[0].group, "Changed");
        assert!(
            parsed
                .feeds
                .iter()
                .all(|feed| feed.url != "https://imported.example/rss")
        );
    }

    fn assert_opml_bad_request(source: &str, contract: &str) {
        let error = parse_opml(source).unwrap_err();
        assert_eq!(error.status, 400, "{contract}");
    }

    #[test]
    fn opml_rejects_documents_exceeding_each_structural_limit() {
        let oversized = format!(
            "<opml><body>{}</body></opml>",
            " ".repeat(MAX_OPML_BYTES + 1)
        );
        assert_opml_bad_request(&oversized, "byte limit");

        let too_many_outlines = format!(
            "<opml><body>{}</body></opml>",
            "<outline/>".repeat(MAX_OPML_OUTLINES + 1)
        );
        assert!(
            too_many_outlines.len() <= MAX_OPML_BYTES,
            "outline-count fixture must stay below the byte limit"
        );
        assert_opml_bad_request(&too_many_outlines, "outline count");

        let depth = MAX_OPML_DEPTH + 1;
        let too_deep = format!(
            "<opml><body>{}{}</body></opml>",
            "<outline text=\"group\">".repeat(depth),
            "</outline>".repeat(depth)
        );
        assert!(depth <= MAX_OPML_OUTLINES);
        assert!(
            too_deep.len() <= MAX_OPML_BYTES,
            "depth fixture must stay below the byte limit"
        );
        assert_opml_bad_request(&too_deep, "outline depth");

        let attributes = (0..MAX_OPML_ATTRIBUTES_PER_OUTLINE)
            .map(|index| format!(" a{index}=\"x\""))
            .collect::<String>();
        let too_many_attributes = format!(
            "<opml><body><outline xmlUrl=\"https://one.example/rss\"{attributes}/></body></opml>"
        );
        assert!(
            too_many_attributes.len() <= MAX_OPML_BYTES,
            "attribute fixture must stay below the byte limit"
        );
        assert_opml_bad_request(&too_many_attributes, "attributes per outline");
    }

    #[test]
    fn opml_accepts_each_exact_structural_boundary() {
        let prefix = "<opml><body>";
        let suffix = "</body></opml>";
        assert!(MAX_OPML_BYTES >= prefix.len() + suffix.len());
        let exact_bytes = format!(
            "{prefix}{}{suffix}",
            " ".repeat(MAX_OPML_BYTES - prefix.len() - suffix.len())
        );
        assert_eq!(exact_bytes.len(), MAX_OPML_BYTES);
        parse_opml(&exact_bytes).unwrap();

        let exact_outlines = format!(
            "<opml><body>{}</body></opml>",
            "<outline/>".repeat(MAX_OPML_OUTLINES)
        );
        assert!(exact_outlines.len() <= MAX_OPML_BYTES);
        parse_opml(&exact_outlines).unwrap();

        let exact_depth = format!(
            "<opml><body>{}{}</body></opml>",
            "<outline text=\"group\">".repeat(MAX_OPML_DEPTH),
            "</outline>".repeat(MAX_OPML_DEPTH)
        );
        parse_opml(&exact_depth).unwrap();

        let attributes = (0..MAX_OPML_ATTRIBUTES_PER_OUTLINE.saturating_sub(1))
            .map(|index| format!(" a{index}=\"x\""))
            .collect::<String>();
        let exact_attributes = format!(
            "<opml><body><outline xmlUrl=\"https://one.example/rss\"{attributes}/></body></opml>"
        );
        assert_eq!(parse_opml(&exact_attributes).unwrap().len(), 1);
    }

    #[test]
    fn opml_rejects_doctype_declarations() {
        assert_opml_bad_request("<!DOCTYPE opml><opml><body></body></opml>", "DOCTYPE");
    }

    #[serial_test::serial]
    #[tokio::test]
    async fn opml_import_performs_one_final_manifest_validation_for_the_batch() {
        let fixture = feed_test_app("").await;
        let mut opml = String::from("<opml><body><outline text=\"Batch\">");
        for index in 0..256 {
            opml.push_str(&format!(
                "<outline text=\"Feed {index}\" xmlUrl=\"https://batch-{index}.example/rss\"/>"
            ));
        }
        opml.push_str("</outline></body></opml>");
        manifest::reset_observed_parse_count();

        let (status, body) = request_json(
            &fixture.app,
            Method::POST,
            "/api/vault/feeds/import",
            Some(json!({
                "expected_revision": page_revision(""),
                "opml": opml
            })),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["added"], 256);
        assert!(
            manifest::observed_parse_count() <= 3,
            "batch import must parse the source once, validate one final candidate, and reconcile once"
        );
    }

    #[tokio::test]
    async fn opml_import_deduplicates_existing_and_same_import_urls() {
        let manifest = "## Existing\n- [Existing](https://existing.example/rss)\n";
        let fixture = feed_test_app(manifest).await;
        let opml = r#"<?xml version="1.0"?>
<opml version="2.0"><body>
  <outline text="Existing duplicate" type="rss" xmlUrl="https://existing.example/rss"/>
  <outline text="News">
    <outline text="New first" type="rss" xmlUrl="https://new.example/rss"/>
    <outline text="New duplicate" type="rss" xmlUrl="https://new.example/rss"/>
  </outline>
  <outline text="Other"><outline text="New third" type="rss" xmlUrl="https://new.example/rss"/></outline>
</body></opml>"#;

        let (status, body) = request_json(
            &fixture.app,
            Method::POST,
            "/api/vault/feeds/import",
            Some(json!({
                "expected_revision": page_revision(manifest),
                "opml": opml
            })),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["added"], 1);
        let updated = std::fs::read_to_string(fixture.state.vault.root().join("feeds.md")).unwrap();
        let parsed = manifest::parse(&updated);
        assert!(parsed.warnings.is_empty());
        assert_eq!(parsed.feeds.len(), 2);
        assert_eq!(
            parsed
                .feeds
                .iter()
                .filter(|feed| feed.url == "https://existing.example/rss")
                .count(),
            1
        );
        let imported = parsed
            .feeds
            .iter()
            .find(|feed| feed.url == "https://new.example/rss")
            .unwrap();
        assert_eq!(imported.group, "News");
        assert_eq!(imported.title_override.as_deref(), Some("New first"));
    }
}
