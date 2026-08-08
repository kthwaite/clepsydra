use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Row, sqlite::SqliteRow};

use super::{fetch, manifest};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/feeds", get(list_feeds).post(subscribe))
        .route("/feeds/refresh", post(refresh))
        .route("/feeds/export", get(export_opml))
        .route("/feeds/import", post(import_opml))
        .route("/feeds/{id}", axum::routing::patch(update_feed).delete(unsubscribe))
        .route("/entries", get(list_entries))
        .route("/entries/mark-read", post(mark_read))
        .route("/entries/{id}", axum::routing::patch(update_entry))
}

// ---------------------------------------------------------------- errors

pub enum ApiError {
    NotFound,
    BadRequest(String),
    Conflict(String),
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m),
            ApiError::Internal(e) => {
                tracing::error!("internal error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError::Internal(e.into())
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn manifest_api_error(error: super::ManifestUpdateError) -> ApiError {
    match error {
        super::ManifestUpdateError::InvalidSource(warnings) => {
            ApiError::Conflict(format!("manifest contains warnings: {}", warnings.join("; ")))
        }
        super::ManifestUpdateError::InvalidCandidate(warnings) => {
            ApiError::BadRequest(format!("manifest update is invalid: {}", warnings.join("; ")))
        }
        super::ManifestUpdateError::Conflict => {
            ApiError::Conflict("manifest changed during update".to_string())
        }
        super::ManifestUpdateError::Rejected(message) => ApiError::BadRequest(message),
        super::ManifestUpdateError::ItemNotFound => ApiError::NotFound,
        super::ManifestUpdateError::Internal(error) => ApiError::Internal(error),
    }
}

// ---------------------------------------------------------------- feeds

#[derive(Serialize)]
struct FeedOut {
    id: i64,
    url: String,
    site_url: Option<String>,
    title: String,
    group: Option<String>,
    tags: Vec<String>,
    sort_order: i64,
    unread_count: i64,
    last_fetch_at: Option<String>,
    error_count: i64,
    last_error: Option<String>,
}

fn feed_out(row: &SqliteRow) -> FeedOut {
    let title: String = row.get("title");
    let title_override: Option<String> = row.get("title_override");
    let url: String = row.get("url");
    let effective_title = title_override
        .filter(|t| !t.is_empty())
        .unwrap_or(if title.is_empty() { url.clone() } else { title });
    FeedOut {
        id: row.get("id"),
        url,
        site_url: row.get("site_url"),
        title: effective_title,
        group: row.get("group_name"),
        tags: serde_json::from_str(row.get::<String, _>("tags").as_str()).unwrap_or_default(),
        sort_order: row.get("sort_order"),
        unread_count: row.try_get("unread_count").unwrap_or(0),
        last_fetch_at: row.get("last_fetch_at"),
        error_count: row.get("error_count"),
        last_error: row.get("last_error"),
    }
}

#[derive(Serialize)]
struct FeedsResponse {
    feeds: Vec<FeedOut>,
    warnings: Vec<String>,
}

async fn list_feeds(State(state): State<AppState>) -> ApiResult<Json<FeedsResponse>> {
    let rows = sqlx::query(
        "SELECT f.*, (SELECT COUNT(*) FROM entry e WHERE e.feed_id = f.id AND e.read_at IS NULL) AS unread_count
         FROM feed f WHERE f.subscribed = 1 ORDER BY f.sort_order",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(FeedsResponse {
        feeds: rows.iter().map(feed_out).collect(),
        warnings: state.manifest_warnings.lock().unwrap().clone(),
    }))
}

#[derive(Deserialize)]
struct SubscribeIn {
    url: String,
    group: Option<String>,
}

async fn subscribe(
    State(state): State<AppState>,
    Json(body): Json<SubscribeIn>,
) -> ApiResult<Json<FeedOut>> {
    let feed_url = fetch::resolve_feed_url(&state, &body.url)
        .await
        .map_err(|e| ApiError::BadRequest(format!("{e:#}")))?;

    let group = body
        .group
        .as_deref()
        .filter(|group| !group.trim().is_empty())
        .unwrap_or("Feeds")
        .trim();
    super::update_manifest(&state, |text| {
        if manifest::parse(text)
            .feeds
            .iter()
            .any(|feed| feed.url == feed_url)
        {
            return Err(super::ManifestUpdateError::Rejected(format!(
                "already subscribed: {feed_url}"
            )));
        }
        Ok((manifest::add_item(text, group, &feed_url), ()))
    })
    .await
    .map_err(manifest_api_error)?;

    let id: i64 = sqlx::query_scalar("SELECT id FROM feed WHERE url = ?")
        .bind(&feed_url)
        .fetch_one(&state.pool)
        .await?;
    // Inline first fetch so the response carries the resolved title.
    if let Err(e) = fetch::fetch_one(&state, id).await {
        tracing::warn!("initial fetch of {feed_url} failed: {e:#}");
    }

    let row = sqlx::query(
        "SELECT f.*, (SELECT COUNT(*) FROM entry e WHERE e.feed_id = f.id AND e.read_at IS NULL) AS unread_count
         FROM feed f WHERE f.id = ?",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(feed_out(&row)))
}

#[derive(Deserialize)]
struct FeedPatch {
    /// New display-name override; empty string clears it.
    title: Option<String>,
    /// Move to this group (section).
    group: Option<String>,
}

async fn feed_url_by_id(state: &AppState, id: i64) -> ApiResult<String> {
    sqlx::query_scalar("SELECT url FROM feed WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn update_feed(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<FeedPatch>,
) -> ApiResult<StatusCode> {
    let url = feed_url_by_id(&state, id).await?;
    super::update_manifest(&state, |source| {
        if !manifest::parse(source).feeds.iter().any(|feed| feed.url == url) {
            return Err(super::ManifestUpdateError::ItemNotFound);
        }
        let mut text = source.to_string();
        if let Some(title) = &body.title {
            let title = (!title.trim().is_empty()).then_some(title.trim());
            text = manifest::set_title(&text, &url, title);
        }
        if let Some(group) = &body.group
            && !group.trim().is_empty()
        {
            text = manifest::move_item(&text, &url, group.trim());
        }
        Ok((text, ()))
    })
    .await
    .map_err(manifest_api_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unsubscribe(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    let url = feed_url_by_id(&state, id).await?;
    super::update_manifest(&state, |text| {
        let (new_text, removed) = manifest::remove_item(text, &url);
        if removed.is_none() {
            return Err(super::ManifestUpdateError::ItemNotFound);
        }
        Ok((new_text, ()))
    })
    .await
    .map_err(manifest_api_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct RefreshIn {
    feed_id: Option<i64>,
}

async fn refresh(
    State(state): State<AppState>,
    body: Option<Json<RefreshIn>>,
) -> ApiResult<StatusCode> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let mut qb = QueryBuilder::new("UPDATE feed SET next_fetch_at = ");
    qb.push_bind(Utc::now());
    qb.push(" WHERE subscribed = 1");
    if let Some(id) = body.feed_id {
        qb.push(" AND id = ").push_bind(id);
    }
    qb.build().execute(&state.pool).await?;
    state.refresh.notify_one();
    Ok(StatusCode::ACCEPTED)
}

// ---------------------------------------------------------------- entries

#[derive(Deserialize)]
struct EntriesQuery {
    unread: Option<bool>,
    bookmarked: Option<bool>,
    feed_id: Option<i64>,
    group: Option<String>,
    tag: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

#[derive(Serialize)]
struct EntryOut {
    id: i64,
    feed_id: i64,
    feed_title: String,
    group: Option<String>,
    url: Option<String>,
    title: String,
    author: Option<String>,
    content_html: Option<String>,
    published_at: Option<String>,
    sort_ts: String,
    read: bool,
    bookmarked: bool,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct EntriesResponse {
    entries: Vec<EntryOut>,
    next_cursor: Option<String>,
}

fn parse_cursor(cursor: &str) -> Option<(String, i64)> {
    let (timestamp, id) = cursor.rsplit_once('|')?;
    chrono::DateTime::parse_from_rfc3339(timestamp).ok()?;
    Some((timestamp.to_string(), id.parse().ok()?))
}

fn parse_required_cursor(cursor: Option<&str>) -> ApiResult<Option<(String, i64)>> {
    cursor
        .map(|value| {
            parse_cursor(value).ok_or_else(|| {
                ApiError::BadRequest(
                    "invalid cursor; expected RFC 3339 timestamp|entry id".to_string(),
                )
            })
        })
        .transpose()
}

async fn list_entries(
    State(state): State<AppState>,
    Query(q): Query<EntriesQuery>,
) -> ApiResult<Json<EntriesResponse>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let cursor = parse_required_cursor(q.cursor.as_deref())?;

    let mut qb = QueryBuilder::new(
        "SELECT e.id, e.feed_id, e.url, e.title, e.author, e.content_html,
                e.published_at, e.read_at, e.bookmarked_at,
                coalesce(e.published_at, e.fetched_at) AS sort_ts,
                f.group_name, f.title AS feed_title, f.title_override, f.url AS feed_url
         FROM entry e JOIN feed f ON f.id = e.feed_id WHERE 1=1",
    );
    if q.unread == Some(true) {
        qb.push(" AND e.read_at IS NULL");
    }
    if q.bookmarked == Some(true) {
        qb.push(" AND e.bookmarked_at IS NOT NULL");
    }
    if let Some(feed_id) = q.feed_id {
        qb.push(" AND e.feed_id = ").push_bind(feed_id);
    }
    if let Some(group) = &q.group {
        qb.push(" AND f.group_name = ").push_bind(group);
    }
    if let Some(tag) = &q.tag {
        qb.push(" AND (EXISTS (SELECT 1 FROM json_each(f.tags) WHERE json_each.value = ")
            .push_bind(tag)
            .push(") OR EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = e.id AND et.tag = ")
            .push_bind(tag)
            .push("))");
    }
    if let Some((timestamp, id)) = cursor {
        qb.push(" AND (coalesce(e.published_at, e.fetched_at) < ")
            .push_bind(timestamp.clone())
            .push(" OR (coalesce(e.published_at, e.fetched_at) = ")
            .push_bind(timestamp)
            .push(" AND e.id < ")
            .push_bind(id)
            .push("))");
    }
    qb.push(" ORDER BY sort_ts DESC, e.id DESC LIMIT ").push_bind(limit);

    let rows = qb.build().fetch_all(&state.pool).await?;

    let ids: Vec<i64> = rows.iter().map(|r| r.get("id")).collect();
    let mut tag_map: std::collections::HashMap<i64, Vec<String>> = Default::default();
    if !ids.is_empty() {
        let mut tq = QueryBuilder::new("SELECT entry_id, tag FROM entry_tag WHERE entry_id IN (");
        let mut sep = tq.separated(", ");
        for id in &ids {
            sep.push_bind(id);
        }
        tq.push(") ORDER BY tag");
        for row in tq.build().fetch_all(&state.pool).await? {
            tag_map
                .entry(row.get("entry_id"))
                .or_default()
                .push(row.get("tag"));
        }
    }

    let entries: Vec<EntryOut> = rows
        .iter()
        .map(|r| {
            let id: i64 = r.get("id");
            let feed_title: String = r.get("feed_title");
            let title_override: Option<String> = r.get("title_override");
            let feed_url: String = r.get("feed_url");
            EntryOut {
                id,
                feed_id: r.get("feed_id"),
                feed_title: title_override
                    .filter(|t| !t.is_empty())
                    .unwrap_or(if feed_title.is_empty() { feed_url } else { feed_title }),
                group: r.get("group_name"),
                url: r.get("url"),
                title: r.get("title"),
                author: r.get("author"),
                content_html: r.get("content_html"),
                published_at: r.get("published_at"),
                sort_ts: r.get("sort_ts"),
                read: r.get::<Option<String>, _>("read_at").is_some(),
                bookmarked: r.get::<Option<String>, _>("bookmarked_at").is_some(),
                tags: tag_map.remove(&id).unwrap_or_default(),
            }
        })
        .collect();

    let next_cursor = (entries.len() as i64 == limit)
        .then(|| entries.last().map(|e| format!("{}|{}", e.sort_ts, e.id)))
        .flatten();

    Ok(Json(EntriesResponse { entries, next_cursor }))
}

#[derive(Deserialize)]
struct EntryPatch {
    read: Option<bool>,
    bookmarked: Option<bool>,
    tags: Option<Vec<String>>,
}

async fn update_entry(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<EntryPatch>,
) -> ApiResult<StatusCode> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM entry WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound);
    }

    let now = Utc::now();
    if let Some(read) = body.read {
        let ts = read.then_some(now);
        sqlx::query("UPDATE entry SET read_at = ? WHERE id = ?")
            .bind(ts)
            .bind(id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(bookmarked) = body.bookmarked {
        let ts = bookmarked.then_some(now);
        sqlx::query("UPDATE entry SET bookmarked_at = ? WHERE id = ?")
            .bind(ts)
            .bind(id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(tags) = body.tags {
        sqlx::query("DELETE FROM entry_tag WHERE entry_id = ?")
            .bind(id)
            .execute(&state.pool)
            .await?;
        for tag in tags {
            let tag = tag.trim().trim_start_matches('#').to_string();
            if tag.is_empty() {
                continue;
            }
            sqlx::query("INSERT OR IGNORE INTO entry_tag (entry_id, tag) VALUES (?, ?)")
                .bind(id)
                .bind(&tag)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct MarkReadIn {
    feed_id: Option<i64>,
    group: Option<String>,
    /// Entries cursor: only entries at or before this boundary are marked, so
    /// entries arriving mid-gesture aren't silently swallowed.
    before: Option<String>,
}

async fn mark_read(
    State(state): State<AppState>,
    body: Option<Json<MarkReadIn>>,
) -> ApiResult<Json<serde_json::Value>> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let cursor = parse_required_cursor(body.before.as_deref())?;
    let mut qb = QueryBuilder::new("UPDATE entry SET read_at = ");
    qb.push_bind(Utc::now());
    qb.push(" WHERE read_at IS NULL");
    if let Some(feed_id) = body.feed_id {
        qb.push(" AND feed_id = ").push_bind(feed_id);
    }
    if let Some(group) = &body.group {
        qb.push(" AND feed_id IN (SELECT id FROM feed WHERE group_name = ")
            .push_bind(group)
            .push(")");
    }
    if let Some((timestamp, id)) = cursor {
        qb.push(" AND (coalesce(published_at, fetched_at) < ")
            .push_bind(timestamp.clone())
            .push(" OR (coalesce(published_at, fetched_at) = ")
            .push_bind(timestamp)
            .push(" AND id <= ")
            .push_bind(id)
            .push("))");
    }
    let res = qb.build().execute(&state.pool).await?;
    Ok(Json(serde_json::json!({ "marked": res.rows_affected() })))
}

// ---------------------------------------------------------------- OPML

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn export_opml(State(state): State<AppState>) -> ApiResult<Response> {
    let rows = sqlx::query(
        "SELECT url, site_url, title, title_override, group_name FROM feed
         WHERE subscribed = 1 ORDER BY sort_order",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut groups: Vec<(Option<String>, Vec<&SqliteRow>)> = Vec::new();
    for row in &rows {
        let g: Option<String> = row.get("group_name");
        match groups.iter_mut().find(|(name, _)| *name == g) {
            Some((_, v)) => v.push(row),
            None => groups.push((g, vec![row])),
        }
    }

    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n<head><title>clepsydra feeds</title></head>\n<body>\n",
    );
    let outline = |row: &SqliteRow| {
        let title: String = row.get("title");
        let title_override: Option<String> = row.get("title_override");
        let url: String = row.get("url");
        let site: Option<String> = row.get("site_url");
        let t = title_override.filter(|t| !t.is_empty()).unwrap_or(title);
        format!(
            "<outline type=\"rss\" text=\"{0}\" title=\"{0}\" xmlUrl=\"{1}\"{2}/>\n",
            xml_escape(&t),
            xml_escape(&url),
            site.map(|s| format!(" htmlUrl=\"{}\"", xml_escape(&s))).unwrap_or_default(),
        )
    };
    for (group, feeds) in groups {
        match group {
            Some(g) => {
                out.push_str(&format!("<outline text=\"{0}\" title=\"{0}\">\n", xml_escape(&g)));
                for f in feeds {
                    out.push_str(&outline(f));
                }
                out.push_str("</outline>\n");
            }
            None => {
                for f in feeds {
                    out.push_str(&outline(f));
                }
            }
        }
    }
    out.push_str("</body>\n</opml>\n");

    Ok((
        [
            ("content-type", "text/x-opml"),
            ("content-disposition", "attachment; filename=\"clepsydra.opml\""),
        ],
        out,
    )
        .into_response())
}

#[derive(Debug)]
struct OpmlItem {
    group: Option<String>,
    title: Option<String>,
    url: String,
}

async fn import_opml(
    State(state): State<AppState>,
    body: String,
) -> ApiResult<Json<serde_json::Value>> {
    let discovered =
        parse_opml(&body).map_err(|error| ApiError::BadRequest(format!("invalid OPML: {error}")))?;
    if discovered.is_empty() {
        return Err(ApiError::BadRequest("no feeds found in OPML".into()));
    }

    let added = super::update_manifest(&state, move |text| {
        let (updated, added) = merge_opml(text, discovered);
        Ok((updated, added))
    })
    .await
    .map_err(manifest_api_error)?;
    if added > 0 {
        state.refresh.notify_one();
    }
    Ok(Json(serde_json::json!({ "added": added })))
}

fn merge_opml(text: &str, discovered: Vec<OpmlItem>) -> (String, usize) {
    let mut existing: std::collections::HashSet<String> =
        manifest::parse(text).feeds.into_iter().map(|feed| feed.url).collect();
    let mut updated = text.to_string();
    let mut added = 0;

    for OpmlItem { group, title, url } in discovered {
        if !existing.insert(url.clone()) {
            continue;
        }
        let item = manifest::render_item(&url, title.as_deref(), &[]);
        updated = manifest::add_item(
            &updated,
            group.as_deref().unwrap_or("Feeds"),
            &item,
        );
        added += 1;
    }
    (updated, added)
}

/// OPML outlines: an `<outline>` without `xmlUrl` is a folder (→ section);
/// one with `xmlUrl` is a feed.
fn parse_opml(body: &str) -> anyhow::Result<Vec<OpmlItem>> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(body);
    reader.config_mut().trim_text(true);
    let mut folders: Vec<String> = Vec::new();
    let mut feeds = Vec::new();

    let handle = |e: &quick_xml::events::BytesStart,
                  folders: &[String],
                  feeds: &mut Vec<OpmlItem>|
     -> anyhow::Result<Option<String>> {
        let mut xml_url = None;
        let mut title = None;
        for attr in e.attributes() {
            let attr = attr?;
            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
            let val = attr.unescape_value()?.to_string();
            match key.as_str() {
                "xmlUrl" => xml_url = Some(val),
                "title" | "text" if title.is_none() => title = Some(val),
                _ => {}
            }
        }
        match xml_url {
            Some(url) => {
                feeds.push(OpmlItem {
                    group: folders.last().cloned(),
                    title,
                    url,
                });
                Ok(None)
            }
            None => Ok(Some(title.unwrap_or_default())),
        }
    };

    loop {
        match reader.read_event()? {
            Event::Start(e) if e.name().as_ref() == b"outline" => {
                if let Some(folder) = handle(&e, &folders, &mut feeds)? {
                    folders.push(folder);
                } else {
                    // A feed opened as a container; push a placeholder so the
                    // matching End pops correctly.
                    folders.push(folders.last().cloned().unwrap_or_default());
                }
            }
            Event::Empty(e) if e.name().as_ref() == b"outline" => {
                handle(&e, &folders, &mut feeds)?;
            }
            Event::End(e) if e.name().as_ref() == b"outline" => {
                folders.pop();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(feeds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opml_folders() {
        let opml = r#"<?xml version="1.0"?><opml version="2.0"><body>
            <outline text="News">
                <outline type="rss" text="World" xmlUrl="https://n.example/rss"/>
            </outline>
            <outline type="rss" text="Loose" xmlUrl="https://l.example/rss"/>
        </body></opml>"#;
        let feeds = parse_opml(opml).unwrap();
        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[0].group.as_deref(), Some("News"));
        assert_eq!(feeds[0].url, "https://n.example/rss");
        assert_eq!(feeds[1].group, None);
    }

    #[test]
    fn required_cursor_distinguishes_missing_valid_and_invalid_values() {
        assert!(matches!(parse_required_cursor(None), Ok(None)));

        assert!(matches!(
            parse_required_cursor(Some("2026-01-01T00:00:00+00:00|42")),
            Ok(Some((timestamp, 42))) if timestamp == "2026-01-01T00:00:00+00:00"
        ));
        assert!(matches!(
            parse_required_cursor(Some("garbage")),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn opml_merge_deduplicates_urls_within_import() {
        let original = "# feeds\n\n## Feeds\n";
        let feeds = vec![
            OpmlItem {
                group: Some("News".to_string()),
                title: Some("First".to_string()),
                url: "https://duplicate.example/feed".to_string(),
            },
            OpmlItem {
                group: Some("Other".to_string()),
                title: Some("Second".to_string()),
                url: "https://duplicate.example/feed".to_string(),
            },
        ];

        let (updated, added) = merge_opml(original, feeds);

        assert_eq!(added, 1);
        let parsed = manifest::parse(&updated);
        assert_eq!(parsed.feeds.len(), 1);
        assert_eq!(parsed.feeds[0].url, "https://duplicate.example/feed");
    }
}
