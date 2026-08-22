#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFeed {
    pub url: String,
    pub title_override: Option<String>,
    pub group: String,
    pub tags: Vec<String>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestWarning {
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    pub feeds: Vec<ManifestFeed>,
    pub warnings: Vec<ManifestWarning>,
}

use chrono::{DateTime, Utc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedSummary {
    pub id: i64,
    pub url: String,
    pub fetch_url: Option<String>,
    pub site_url: Option<String>,
    pub title: String,
    pub title_override: Option<String>,
    pub group: String,
    pub tags: Vec<String>,
    pub subscribed: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_fetch_at: Option<DateTime<Utc>>,
    pub next_fetch_at: DateTime<Utc>,
    pub error_count: u32,
    pub last_error: Option<String>,
}

pub type FeedRecord = FeedSummary;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedEntry {
    pub guid: String,
    pub url: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub content_html: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOutcome {
    Success {
        fetched_at: DateTime<Utc>,
        next_fetch_at: DateTime<Utc>,
        fetch_url: String,
        etag: Option<String>,
        last_modified: Option<String>,
        title: Option<String>,
        site_url: Option<String>,
        entries: Vec<FetchedEntry>,
    },
    NotModified {
        fetched_at: DateTime<Utc>,
        next_fetch_at: DateTime<Utc>,
        etag: Option<String>,
        last_modified: Option<String>,
    },
    Failure {
        fetched_at: DateTime<Utc>,
        next_fetch_at: DateTime<Utc>,
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryView {
    All,
    Unread,
    Saved,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryCursor {
    pub sort_ts: DateTime<Utc>,
    pub id: i64,
}

impl EntryCursor {
    pub fn encode(&self) -> String {
        format!(
            "{}|{}",
            self.sort_ts
                .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
            self.id
        )
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        if value.trim() != value || value.matches('|').count() != 1 {
            return Err("cursor must be exactly `<RFC3339>|<id>`".to_owned());
        }
        let (timestamp, id) = value
            .split_once('|')
            .ok_or_else(|| "cursor must contain one `|` separator".to_owned())?;
        let sort_ts = DateTime::parse_from_rfc3339(timestamp)
            .map_err(|_| "cursor timestamp must be RFC3339".to_owned())?
            .to_utc();
        let id = id
            .parse::<i64>()
            .map_err(|_| "cursor id must be an integer".to_owned())?;
        if id <= 0 {
            return Err("cursor id must be positive".to_owned());
        }
        let cursor = Self { sort_ts, id };
        if cursor.encode() != value {
            return Err("cursor must use canonical UTC RFC3339 encoding".to_owned());
        }
        Ok(cursor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryFilters {
    pub view: EntryView,
    /// Empty means every feed; otherwise the union of these feed ids.
    pub feed_ids: Vec<i64>,
    /// Empty means every group; otherwise the union of these group names.
    pub groups: Vec<String>,
    pub tag: Option<String>,
    pub limit: usize,
    pub cursor: Option<EntryCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryPage {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<EntryCursor>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntryPatch {
    pub read: Option<bool>,
    pub bookmarked: Option<bool>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MarkReadScope {
    /// Empty means every feed; otherwise the union of these feed ids.
    pub feed_ids: Vec<i64>,
    /// Empty means every group; otherwise the union of these group names.
    pub groups: Vec<String>,
    pub tag: Option<String>,
    pub before: Option<EntryCursor>,
}
