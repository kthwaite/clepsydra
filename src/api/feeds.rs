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
use crate::feeds::scheduler::reconcile_feed_manifest;
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
pub struct FeedListResponse {
    pub groups: Vec<FeedGroupDto>,
    pub diagnostics: Vec<FeedDiagnosticDto>,
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

async fn read_manifest(state: &AppState) -> Result<ManifestSnapshot, ApiError> {
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
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| ApiError::bad_request("feeds.md must contain valid UTF-8"))?;
    Ok(ManifestSnapshot {
        existed,
        bytes,
        text,
        revision,
    })
}

fn require_revision(snapshot: &ManifestSnapshot, expected: &str) -> Result<(), ApiError> {
    if snapshot.revision == expected {
        Ok(())
    } else {
        Err(ApiError::revision_conflict(snapshot.revision.clone()))
    }
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
            reconcile_feed_manifest(state)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
            Ok(revision)
        }
        Err(MutationError::Stale(_)) => {
            let current = read_manifest(state).await?;
            Err(ApiError::revision_conflict(current.revision))
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
    reconcile_feed_manifest(&state)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let snapshot = read_manifest(&state).await?;
    let feeds = state.feeds.list_feeds().await.map_err(feed_store_error)?;
    let diagnostics = state
        .feed_manifest_diagnostics
        .read()
        .clone()
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(FeedListResponse {
        groups: grouped_feeds(feeds),
        diagnostics,
        manifest_revision: snapshot.revision,
    }))
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
    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest(&state).await?;
    require_revision(&snapshot, &request.expected_revision)?;

    let discovered = crate::feeds::fetch::discover_feed_url(&state.feed_client, &request.url)
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
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
    let snapshot = read_manifest(&state).await?;
    require_revision(&snapshot, &request.expected_revision)?;
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
    let snapshot = read_manifest(&state).await?;
    require_revision(&snapshot, &request.expected_revision)?;
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
            view: query.view.unwrap_or(EntryViewDto::Unread).into(),
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
    for attribute in element.attributes().with_checks(false) {
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
    let mut reader = Reader::from_str(source);
    let mut buffer = Vec::new();
    let mut outline_stack: Vec<Option<String>> = Vec::new();
    let mut feeds = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element))
                if element.name().as_ref().eq_ignore_ascii_case(b"outline") =>
            {
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
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(ApiError::bad_request(format!("invalid OPML: {error}"))),
        }
        buffer.clear();
    }
    Ok(feeds)
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
    let _manifest_guard = state.feed_manifest_lock.lock().await;
    let snapshot = read_manifest(&state).await?;
    require_revision(&snapshot, &request.expected_revision)?;
    let imported = parse_opml(&request.opml)?;
    let mut seen: HashSet<String> = manifest::parse(&snapshot.text)
        .feeds
        .into_iter()
        .map(|feed| feed.url)
        .collect();
    let mut candidate = snapshot.text.clone();
    let mut added = 0;
    for feed in imported {
        if !seen.insert(feed.url.clone()) {
            continue;
        }
        candidate = manifest::add_feed(
            &candidate,
            &feed.group,
            &feed.url,
            feed.title.as_deref(),
            &[],
        )
        .map_err(ApiError::bad_request)?;
        added += 1;
    }
    let revision = if added == 0 {
        snapshot.revision
    } else {
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
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, StatusCode, header};
    use chrono::{DateTime, TimeZone, Utc};
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tower::ServiceExt;

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
