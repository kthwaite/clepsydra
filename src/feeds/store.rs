#[cfg(test)]
use std::cell::Cell;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Transaction, params, params_from_iter};
use tokio::sync::oneshot;

use super::types::{
    Entry, EntryCursor, EntryFilters, EntryPage, EntryPatch, EntryView, FeedRecord, FeedSummary,
    FetchOutcome, FetchedEntry, ManifestFeed, MarkReadScope,
};

pub const CURRENT_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, thiserror::Error)]
pub enum FeedStoreError {
    #[error("feed database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("feed database schema version {found} is newer than supported version {current}")]
    UnsupportedSchemaVersion { found: i64, current: i64 },
    #[error("{operation} `{path}`: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("feed store worker stopped")]
    WorkerStopped,
    #[error("start feed store worker: {0}")]
    StartWorker(#[source] std::io::Error),
    #[error("invalid stored timestamp `{0}`")]
    InvalidTimestamp(String),
    #[error("invalid entry cursor `{0}`")]
    InvalidCursor(String),
    #[error("invalid feed database path `{0}`")]
    InvalidPath(PathBuf),
    #[error("feed {0} was not found")]
    FeedNotFound(i64),
    #[error("entry {0} was not found")]
    EntryNotFound(i64),
    #[error("serialize feed tags: {0}")]
    SerializeTags(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct FeedStoreHandle {
    tx: mpsc::Sender<Command>,
}

enum Command {
    Reconcile {
        feeds: Vec<ManifestFeed>,
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    ListFeeds {
        reply: oneshot::Sender<Result<Vec<FeedSummary>, FeedStoreError>>,
    },
    DueFeeds {
        now: DateTime<Utc>,
        reply: oneshot::Sender<Result<Vec<FeedRecord>, FeedStoreError>>,
    },
    ApplyFetch {
        feed_id: i64,
        outcome: FetchOutcome,
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    ListEntries {
        filters: EntryFilters,
        reply: oneshot::Sender<Result<EntryPage, FeedStoreError>>,
    },
    PatchEntry {
        id: i64,
        patch: EntryPatch,
        reply: oneshot::Sender<Result<Entry, FeedStoreError>>,
    },
    MarkRead {
        scope: MarkReadScope,
        reply: oneshot::Sender<Result<u64, FeedStoreError>>,
    },
    ScheduleRefresh {
        feed_id: Option<i64>,
        now: DateTime<Utc>,
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    Prune {
        now: DateTime<Utc>,
        retention_days: u64,
        unread_retention_days: u64,
        reply: oneshot::Sender<Result<u64, FeedStoreError>>,
    },
    SnapshotTo {
        destination: PathBuf,
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    #[cfg(test)]
    ResetObservedQueries {
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    #[cfg(test)]
    ObservedQueries {
        reply: oneshot::Sender<Result<usize, FeedStoreError>>,
    },
}

impl FeedStoreHandle {
    pub fn open(path: &Path) -> Result<Self, FeedStoreError> {
        let path = path.to_path_buf();
        let worker_path = path.clone();
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("clepsydra-feed-store".to_owned())
            .spawn(move || match open_connection(&worker_path) {
                Ok(mut connection) => {
                    if ready_tx.send(Ok(())).is_ok() {
                        worker_loop(&mut connection, &worker_path, rx);
                    }
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(FeedStoreError::StartWorker)?;
        ready_rx
            .recv()
            .map_err(|_| FeedStoreError::WorkerStopped)??;
        Ok(Self { tx })
    }

    pub async fn reconcile(&self, feeds: Vec<ManifestFeed>) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::Reconcile { feeds, reply })
            .await
    }

    pub async fn list_feeds(&self) -> Result<Vec<FeedSummary>, FeedStoreError> {
        self.request(|reply| Command::ListFeeds { reply }).await
    }

    pub async fn due_feeds(&self, now: DateTime<Utc>) -> Result<Vec<FeedRecord>, FeedStoreError> {
        self.request(|reply| Command::DueFeeds { now, reply }).await
    }

    pub async fn apply_fetch(
        &self,
        feed_id: i64,
        outcome: FetchOutcome,
    ) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::ApplyFetch {
            feed_id,
            outcome,
            reply,
        })
        .await
    }

    pub async fn list_entries(&self, filters: EntryFilters) -> Result<EntryPage, FeedStoreError> {
        self.request(|reply| Command::ListEntries { filters, reply })
            .await
    }

    pub async fn patch_entry(&self, id: i64, patch: EntryPatch) -> Result<Entry, FeedStoreError> {
        self.request(|reply| Command::PatchEntry { id, patch, reply })
            .await
    }

    pub async fn mark_read(&self, scope: MarkReadScope) -> Result<u64, FeedStoreError> {
        self.request(|reply| Command::MarkRead { scope, reply })
            .await
    }

    pub async fn schedule_refresh(
        &self,
        feed_id: Option<i64>,
        now: DateTime<Utc>,
    ) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::ScheduleRefresh {
            feed_id,
            now,
            reply,
        })
        .await
    }

    pub async fn prune(
        &self,
        now: DateTime<Utc>,
        retention_days: u64,
        unread_retention_days: u64,
    ) -> Result<u64, FeedStoreError> {
        self.request(|reply| Command::Prune {
            now,
            retention_days,
            unread_retention_days,
            reply,
        })
        .await
    }

    pub async fn snapshot_to(&self, destination: PathBuf) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::SnapshotTo { destination, reply })
            .await
    }

    #[cfg(test)]
    async fn reset_observed_queries(&self) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::ResetObservedQueries { reply })
            .await
    }

    #[cfg(test)]
    async fn observed_queries(&self) -> Result<usize, FeedStoreError> {
        self.request(|reply| Command::ObservedQueries { reply })
            .await
    }

    async fn request<T>(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<T, FeedStoreError>>) -> Command,
    ) -> Result<T, FeedStoreError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(make_command(reply_tx))
            .map_err(|_| FeedStoreError::WorkerStopped)?;
        reply_rx.await.map_err(|_| FeedStoreError::WorkerStopped)?
    }
}

#[cfg(test)]
thread_local! {
    static OBSERVED_LIST_ENTRY_QUERIES: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
fn reset_observed_query_count() {
    OBSERVED_LIST_ENTRY_QUERIES.with(|count| count.set(0));
}

#[cfg(test)]
fn increment_observed_query_count() {
    OBSERVED_LIST_ENTRY_QUERIES.with(|count| count.set(count.get() + 1));
}

#[cfg(test)]
fn observed_query_count() -> usize {
    OBSERVED_LIST_ENTRY_QUERIES.with(Cell::get)
}

fn worker_loop(connection: &mut Connection, source: &Path, rx: mpsc::Receiver<Command>) {
    while let Ok(command) = rx.recv() {
        match command {
            Command::Reconcile { feeds, reply } => {
                let _ = reply.send(reconcile(connection, feeds));
            }
            Command::ListFeeds { reply } => {
                let _ = reply.send(list_feeds(connection, None));
            }
            Command::DueFeeds { now, reply } => {
                let _ = reply.send(list_feeds(connection, Some(now)));
            }
            Command::ApplyFetch {
                feed_id,
                outcome,
                reply,
            } => {
                let _ = reply.send(apply_fetch(connection, feed_id, outcome));
            }
            Command::ListEntries { filters, reply } => {
                let _ = reply.send(list_entries(connection, filters));
            }
            Command::PatchEntry { id, patch, reply } => {
                let _ = reply.send(patch_entry(connection, id, patch));
            }
            Command::MarkRead { scope, reply } => {
                let _ = reply.send(mark_read(connection, scope));
            }
            Command::ScheduleRefresh {
                feed_id,
                now,
                reply,
            } => {
                let _ = reply.send(schedule_refresh(connection, feed_id, now));
            }
            Command::Prune {
                now,
                retention_days,
                unread_retention_days,
                reply,
            } => {
                let _ = reply.send(prune(
                    connection,
                    now,
                    retention_days,
                    unread_retention_days,
                ));
            }
            Command::SnapshotTo { destination, reply } => {
                let _ = reply.send(snapshot_database(source, &destination));
            }
            #[cfg(test)]
            Command::ResetObservedQueries { reply } => {
                reset_observed_query_count();
                let _ = reply.send(Ok(()));
            }
            #[cfg(test)]
            Command::ObservedQueries { reply } => {
                let _ = reply.send(Ok(observed_query_count()));
            }
        }
    }
}

fn open_connection(path: &Path) -> Result<Connection, FeedStoreError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|source| FeedStoreError::Io {
            operation: "create feed database directory",
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let mut connection = Connection::open(path)?;
    let schema_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if schema_version > CURRENT_SCHEMA_VERSION {
        return Err(FeedStoreError::UnsupportedSchemaVersion {
            found: schema_version,
            current: CURRENT_SCHEMA_VERSION,
        });
    }
    connection.execute_batch(
        "
        PRAGMA foreign_keys = OFF;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        ",
    )?;
    initialize_schema(&mut connection, schema_version)?;
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(connection)
}

fn initialize_schema(
    connection: &mut Connection,
    schema_version: i64,
) -> Result<(), FeedStoreError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS feed (
            id INTEGER PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            site_url TEXT,
            title TEXT NOT NULL DEFAULT '',
            title_override TEXT,
            group_name TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            subscribed INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            added_at TEXT NOT NULL,
            etag TEXT,
            last_modified TEXT,
            last_fetch_at TEXT,
            next_fetch_at TEXT NOT NULL,
            error_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        );
        ",
    )?;
    for (name, declaration) in [
        ("site_url", "TEXT"),
        ("title", "TEXT NOT NULL DEFAULT ''"),
        ("title_override", "TEXT"),
        ("group_name", "TEXT NOT NULL DEFAULT ''"),
        ("tags", "TEXT NOT NULL DEFAULT '[]'"),
        ("subscribed", "INTEGER NOT NULL DEFAULT 1"),
        ("sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("added_at", "TEXT NOT NULL DEFAULT ''"),
        ("etag", "TEXT"),
        ("last_modified", "TEXT"),
        ("last_fetch_at", "TEXT"),
        ("next_fetch_at", "TEXT NOT NULL DEFAULT ''"),
        ("error_count", "INTEGER NOT NULL DEFAULT 0"),
        ("last_error", "TEXT"),
    ] {
        ensure_column(connection, "feed", name, declaration)?;
    }
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS entry (
            id INTEGER PRIMARY KEY,
            feed_id INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
            guid TEXT NOT NULL,
            url TEXT,
            title TEXT NOT NULL DEFAULT '',
            author TEXT,
            content_html TEXT,
            published_at TEXT,
            fetched_at TEXT NOT NULL,
            read_at TEXT,
            bookmarked_at TEXT,
            UNIQUE(feed_id, guid)
        );
        CREATE TABLE IF NOT EXISTS entry_tag (
            entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY(entry_id, tag)
        );
        ",
    )?;
    for (name, declaration) in [
        ("url", "TEXT"),
        ("title", "TEXT NOT NULL DEFAULT ''"),
        ("author", "TEXT"),
        ("content_html", "TEXT"),
        ("published_at", "TEXT"),
        ("fetched_at", "TEXT NOT NULL DEFAULT ''"),
        ("read_at", "TEXT"),
        ("bookmarked_at", "TEXT"),
    ] {
        ensure_column(connection, "entry", name, declaration)?;
    }
    if schema_version < 2 {
        let migration_now = datetime_to_db(Utc::now());
        connection.execute(
            "UPDATE feed SET added_at = ?1 WHERE added_at = ''",
            [&migration_now],
        )?;
        connection.execute(
            "UPDATE feed SET next_fetch_at = ?1 WHERE next_fetch_at = ''",
            [&migration_now],
        )?;
        connection.execute(
            "
            UPDATE entry
            SET fetched_at = COALESCE(NULLIF(published_at, ''), ?1)
            WHERE fetched_at = ''
            ",
            [&migration_now],
        )?;
        connection.execute(
            "UPDATE feed SET group_name = '' WHERE group_name IS NULL",
            [],
        )?;
        if !column_is_not_null(connection, "feed", "group_name")? {
            rebuild_feed_table(connection)?;
        }
        for (table, column) in [
            ("feed", "added_at"),
            ("feed", "last_fetch_at"),
            ("feed", "next_fetch_at"),
            ("entry", "published_at"),
            ("entry", "fetched_at"),
            ("entry", "read_at"),
            ("entry", "bookmarked_at"),
        ] {
            normalize_timestamp_column(connection, table, column)?;
        }
    }
    connection.execute_batch(
        "
        CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_feed_guid
            ON entry(feed_id, guid);
        CREATE INDEX IF NOT EXISTS idx_entry_sort
            ON entry(COALESCE(published_at, fetched_at) DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_entry_feed_unread
            ON entry(feed_id) WHERE read_at IS NULL;
        PRAGMA user_version = 2;
        ",
    )?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), FeedStoreError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column);
    if !exists {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
        ))?;
    }
    Ok(())
}

fn column_is_not_null(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, FeedStoreError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, bool>(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns
        .into_iter()
        .find_map(|(name, not_null)| (name == column).then_some(not_null))
        .unwrap_or(false))
}

fn rebuild_feed_table(connection: &mut Connection) -> Result<(), FeedStoreError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "
        DROP TABLE IF EXISTS feed__migration_v2;
        CREATE TABLE feed__migration_v2 (
            id INTEGER PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            site_url TEXT,
            title TEXT NOT NULL DEFAULT '',
            title_override TEXT,
            group_name TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            subscribed INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            added_at TEXT NOT NULL,
            etag TEXT,
            last_modified TEXT,
            last_fetch_at TEXT,
            next_fetch_at TEXT NOT NULL,
            error_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        );
        INSERT INTO feed__migration_v2 (
            id, url, site_url, title, title_override, group_name, tags, subscribed,
            sort_order, added_at, etag, last_modified, last_fetch_at, next_fetch_at,
            error_count, last_error
        )
        SELECT
            id, url, site_url, COALESCE(title, ''), title_override,
            COALESCE(group_name, ''), COALESCE(tags, '[]'), COALESCE(subscribed, 1),
            COALESCE(sort_order, 0), added_at, etag, last_modified, last_fetch_at,
            next_fetch_at, COALESCE(error_count, 0), last_error
        FROM feed;
        DROP TABLE feed;
        ALTER TABLE feed__migration_v2 RENAME TO feed;
        ",
    )?;
    transaction.commit()?;
    Ok(())
}

fn normalize_timestamp_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<(), FeedStoreError> {
    let mut statement = connection.prepare(&format!(
        "SELECT id, {column} FROM {table} WHERE {column} IS NOT NULL AND {column} <> ''"
    ))?;
    let values = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (id, value) in values {
        let normalized = datetime_to_db(parse_db_datetime(&value)?);
        if normalized != value {
            connection.execute(
                &format!("UPDATE {table} SET {column} = ?1 WHERE id = ?2"),
                params![normalized, id],
            )?;
        }
    }
    Ok(())
}
fn reconcile(connection: &mut Connection, feeds: Vec<ManifestFeed>) -> Result<(), FeedStoreError> {
    let transaction = connection.transaction()?;
    transaction.execute("UPDATE feed SET subscribed = 0", [])?;
    let now = datetime_to_db(Utc::now());
    for (sort_order, feed) in feeds.into_iter().enumerate() {
        let tags = serde_json::to_string(&feed.tags)?;
        transaction.execute(
            "
            INSERT INTO feed (
                url, title_override, group_name, tags, subscribed, sort_order, added_at,
                next_fetch_at
            ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?6)
            ON CONFLICT(url) DO UPDATE SET
                title_override = excluded.title_override,
                group_name = excluded.group_name,
                tags = excluded.tags,
                subscribed = 1,
                sort_order = excluded.sort_order
            ",
            params![
                feed.url,
                feed.title_override,
                feed.group,
                tags,
                sort_order as i64,
                now
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn list_feeds(
    connection: &Connection,
    due_at: Option<DateTime<Utc>>,
) -> Result<Vec<FeedSummary>, FeedStoreError> {
    let mut sql = String::from(
        "
        SELECT id, url, site_url, title, title_override, group_name, tags, subscribed,
               etag, last_modified, last_fetch_at, next_fetch_at, error_count, last_error
        FROM feed
        ",
    );
    let mut values = Vec::new();
    if let Some(now) = due_at {
        sql.push_str(" WHERE subscribed = 1 AND next_fetch_at <= ?1");
        values.push(Value::Text(datetime_to_db(now)));
    }
    sql.push_str(" ORDER BY sort_order ASC, id ASC");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(values), feed_from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn feed_from_row(row: &rusqlite::Row<'_>) -> Result<FeedSummary, rusqlite::Error> {
    let tags: String = row.get(6)?;
    let last_fetch_at: Option<String> = row.get(10)?;
    let next_fetch_at: String = row.get(11)?;
    Ok(FeedSummary {
        id: row.get(0)?,
        url: row.get(1)?,
        site_url: row.get(2)?,
        title: row.get(3)?,
        title_override: row.get(4)?,
        group: row.get(5)?,
        tags: serde_json::from_str(&tags).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        subscribed: row.get(7)?,
        etag: row.get(8)?,
        last_modified: row.get(9)?,
        last_fetch_at: last_fetch_at
            .map(|value| parse_db_datetime(&value))
            .transpose()
            .map_err(timestamp_from_sql_error)?,
        next_fetch_at: parse_db_datetime(&next_fetch_at).map_err(timestamp_from_sql_error)?,
        error_count: row.get(12)?,
        last_error: row.get(13)?,
    })
}

fn apply_fetch(
    connection: &mut Connection,
    feed_id: i64,
    outcome: FetchOutcome,
) -> Result<(), FeedStoreError> {
    let transaction = connection.transaction()?;
    let changed = match outcome {
        FetchOutcome::Success {
            fetched_at,
            next_fetch_at,
            etag,
            last_modified,
            title,
            site_url,
            entries,
        } => {
            let changed = transaction.execute(
                "
                UPDATE feed SET
                    title = COALESCE(?1, title),
                    site_url = COALESCE(?2, site_url),
                    etag = ?3,
                    last_modified = ?4,
                    last_fetch_at = ?5,
                    next_fetch_at = ?6,
                    error_count = 0,
                    last_error = NULL
                WHERE id = ?7
                ",
                params![
                    title,
                    site_url,
                    etag,
                    last_modified,
                    datetime_to_db(fetched_at),
                    datetime_to_db(next_fetch_at),
                    feed_id
                ],
            )?;
            if changed != 0 {
                upsert_entries(&transaction, feed_id, entries)?;
            }
            changed
        }
        FetchOutcome::NotModified {
            fetched_at,
            next_fetch_at,
            etag,
            last_modified,
        } => transaction.execute(
            "
            UPDATE feed SET
                etag = COALESCE(?1, etag),
                last_modified = COALESCE(?2, last_modified),
                last_fetch_at = ?3,
                next_fetch_at = ?4,
                error_count = 0,
                last_error = NULL
            WHERE id = ?5
            ",
            params![
                etag,
                last_modified,
                datetime_to_db(fetched_at),
                datetime_to_db(next_fetch_at),
                feed_id
            ],
        )?,
        FetchOutcome::Failure {
            fetched_at,
            next_fetch_at,
            error,
        } => transaction.execute(
            "
            UPDATE feed SET
                last_fetch_at = ?1,
                next_fetch_at = ?2,
                error_count = error_count + 1,
                last_error = ?3
            WHERE id = ?4
            ",
            params![
                datetime_to_db(fetched_at),
                datetime_to_db(next_fetch_at),
                error,
                feed_id
            ],
        )?,
    };
    if changed == 0 {
        return Err(FeedStoreError::FeedNotFound(feed_id));
    }
    transaction.commit()?;
    Ok(())
}

fn upsert_entries(
    transaction: &Transaction<'_>,
    feed_id: i64,
    entries: Vec<FetchedEntry>,
) -> Result<(), FeedStoreError> {
    let mut statement = transaction.prepare_cached(
        "
        INSERT INTO entry (
            feed_id, guid, url, title, author, content_html, published_at, fetched_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(feed_id, guid) DO UPDATE SET
            url = excluded.url,
            title = excluded.title,
            author = excluded.author,
            content_html = excluded.content_html,
            published_at = excluded.published_at,
            fetched_at = excluded.fetched_at
        ",
    )?;
    for entry in entries {
        statement.execute(params![
            feed_id,
            entry.guid,
            entry.url,
            entry.title,
            entry.author,
            entry.content_html,
            entry.published_at.map(datetime_to_db),
            datetime_to_db(entry.fetched_at)
        ])?;
    }
    Ok(())
}

fn list_entries(
    connection: &Connection,
    filters: EntryFilters,
) -> Result<EntryPage, FeedStoreError> {
    let mut sql = String::from(
        "
        SELECT e.id, e.feed_id, e.guid, e.url, e.title, e.author, e.content_html,
               e.published_at, e.fetched_at, e.read_at IS NOT NULL,
               e.bookmarked_at IS NOT NULL
        FROM entry e
        JOIN feed f ON f.id = e.feed_id
        WHERE 1 = 1
        ",
    );
    let mut values = Vec::new();
    match filters.view {
        EntryView::All => {}
        EntryView::Unread => sql.push_str(" AND e.read_at IS NULL"),
        EntryView::Saved => sql.push_str(" AND e.bookmarked_at IS NOT NULL"),
    }
    if let Some(feed_id) = filters.feed_id {
        push_parameter(&mut sql, &mut values, " AND e.feed_id = ", feed_id.into());
    }
    if let Some(group) = filters.group {
        push_parameter(&mut sql, &mut values, " AND f.group_name = ", group.into());
    }
    if let Some(tag) = filters.tag {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = e.id AND et.tag = ",
        );
        push_placeholder(&mut sql, &mut values, tag.into());
        sql.push(')');
    }
    if let Some(cursor) = filters.cursor {
        let timestamp = datetime_to_db(cursor.sort_ts);
        sql.push_str(" AND (COALESCE(e.published_at, e.fetched_at) < ");
        push_placeholder(&mut sql, &mut values, timestamp.clone().into());
        sql.push_str(" OR (COALESCE(e.published_at, e.fetched_at) = ");
        push_placeholder(&mut sql, &mut values, timestamp.into());
        sql.push_str(" AND e.id < ");
        push_placeholder(&mut sql, &mut values, cursor.id.into());
        sql.push_str("))");
    }
    sql.push_str(" ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC LIMIT ");
    let limit = filters.limit.clamp(1, 500);
    push_placeholder(&mut sql, &mut values, ((limit + 1) as i64).into());

    #[cfg(test)]
    increment_observed_query_count();
    let mut statement = connection.prepare(&sql)?;
    let mut entries = statement
        .query_map(params_from_iter(values), entry_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = entries.len() > limit;
    if has_more {
        entries.truncate(limit);
    }
    load_entry_tags(connection, &mut entries)?;
    let next_cursor = has_more
        .then(|| entries.last())
        .flatten()
        .map(|entry| EntryCursor {
            sort_ts: entry.published_at.unwrap_or(entry.fetched_at),
            id: entry.id,
        });
    Ok(EntryPage {
        entries,
        next_cursor,
    })
}

fn entry_from_row(row: &rusqlite::Row<'_>) -> Result<Entry, rusqlite::Error> {
    let published_at: Option<String> = row.get(7)?;
    let fetched_at: String = row.get(8)?;
    Ok(Entry {
        id: row.get(0)?,
        feed_id: row.get(1)?,
        guid: row.get(2)?,
        url: row.get(3)?,
        title: row.get(4)?,
        author: row.get(5)?,
        content_html: row.get(6)?,
        published_at: published_at
            .map(|value| parse_db_datetime(&value))
            .transpose()
            .map_err(timestamp_from_sql_error)?,
        fetched_at: parse_db_datetime(&fetched_at).map_err(timestamp_from_sql_error)?,
        read: row.get(9)?,
        bookmarked: row.get(10)?,
        tags: Vec::new(),
    })
}

fn load_entry_tags(connection: &Connection, entries: &mut [Entry]) -> Result<(), FeedStoreError> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut sql = String::from("SELECT entry_id, tag FROM entry_tag WHERE entry_id IN (");
    let mut values = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        if index != 0 {
            sql.push_str(", ");
        }
        push_placeholder(&mut sql, &mut values, entry.id.into());
    }
    sql.push_str(") ORDER BY entry_id, tag");

    #[cfg(test)]
    increment_observed_query_count();
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(values), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut tags_by_entry = BTreeMap::<i64, Vec<String>>::new();
    for row in rows {
        let (entry_id, tag) = row?;
        tags_by_entry.entry(entry_id).or_default().push(tag);
    }
    for entry in entries {
        entry.tags = tags_by_entry.remove(&entry.id).unwrap_or_default();
    }
    Ok(())
}

fn entry_tags(connection: &Connection, entry_id: i64) -> Result<Vec<String>, FeedStoreError> {
    #[cfg(test)]
    increment_observed_query_count();
    let mut statement =
        connection.prepare("SELECT tag FROM entry_tag WHERE entry_id = ?1 ORDER BY tag")?;
    Ok(statement
        .query_map([entry_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn patch_entry(
    connection: &mut Connection,
    id: i64,
    patch: EntryPatch,
) -> Result<Entry, FeedStoreError> {
    let transaction = connection.transaction()?;
    if !entry_exists(&transaction, id)? {
        return Err(FeedStoreError::EntryNotFound(id));
    }
    let now = datetime_to_db(Utc::now());
    if let Some(read) = patch.read {
        transaction.execute(
            "UPDATE entry SET read_at = ?1 WHERE id = ?2",
            params![read.then_some(now.clone()), id],
        )?;
    }
    if let Some(bookmarked) = patch.bookmarked {
        transaction.execute(
            "UPDATE entry SET bookmarked_at = ?1 WHERE id = ?2",
            params![bookmarked.then_some(now), id],
        )?;
    }
    if let Some(tags) = patch.tags {
        transaction.execute("DELETE FROM entry_tag WHERE entry_id = ?1", [id])?;
        for tag in normalize_tags(tags) {
            transaction.execute(
                "INSERT INTO entry_tag(entry_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
    }
    transaction.commit()?;
    entry_by_id(connection, id)
}

fn entry_exists(transaction: &Transaction<'_>, id: i64) -> Result<bool, FeedStoreError> {
    Ok(transaction
        .query_row("SELECT 1 FROM entry WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn normalize_tags(tags: Vec<String>) -> BTreeSet<String> {
    tags.into_iter()
        .filter_map(|tag| {
            let normalized = tag.trim().trim_start_matches('#').trim();
            (!normalized.is_empty()).then(|| normalized.to_owned())
        })
        .collect()
}

fn entry_by_id(connection: &Connection, id: i64) -> Result<Entry, FeedStoreError> {
    let mut entry = connection
        .query_row(
            "
            SELECT id, feed_id, guid, url, title, author, content_html, published_at,
                   fetched_at, read_at IS NOT NULL, bookmarked_at IS NOT NULL
            FROM entry WHERE id = ?1
            ",
            [id],
            entry_from_row,
        )
        .optional()?
        .ok_or(FeedStoreError::EntryNotFound(id))?;
    entry.tags = entry_tags(connection, id)?;
    Ok(entry)
}

fn mark_read(connection: &Connection, scope: MarkReadScope) -> Result<u64, FeedStoreError> {
    let mut sql = String::from(
        "
        UPDATE entry SET read_at = ?1
        WHERE read_at IS NULL
        ",
    );
    let mut values = vec![Value::Text(datetime_to_db(Utc::now()))];
    if let Some(feed_id) = scope.feed_id {
        push_parameter(&mut sql, &mut values, " AND feed_id = ", feed_id.into());
    }
    if let Some(group) = scope.group {
        sql.push_str(" AND feed_id IN (SELECT id FROM feed WHERE group_name = ");
        push_placeholder(&mut sql, &mut values, group.into());
        sql.push(')');
    }
    if let Some(tag) = scope.tag {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = entry.id AND et.tag = ",
        );
        push_placeholder(&mut sql, &mut values, tag.into());
        sql.push(')');
    }
    if let Some(before) = scope.before {
        let timestamp = datetime_to_db(before.sort_ts);
        sql.push_str(" AND (COALESCE(published_at, fetched_at) < ");
        push_placeholder(&mut sql, &mut values, timestamp.clone().into());
        sql.push_str(" OR (COALESCE(published_at, fetched_at) = ");
        push_placeholder(&mut sql, &mut values, timestamp.into());
        sql.push_str(" AND id <= ");
        push_placeholder(&mut sql, &mut values, before.id.into());
        sql.push_str("))");
    }
    Ok(connection.execute(&sql, params_from_iter(values))? as u64)
}

fn schedule_refresh(
    connection: &Connection,
    feed_id: Option<i64>,
    now: DateTime<Utc>,
) -> Result<(), FeedStoreError> {
    let changed = if let Some(feed_id) = feed_id {
        connection.execute(
            "UPDATE feed SET next_fetch_at = ?1 WHERE id = ?2 AND subscribed = 1",
            params![datetime_to_db(now), feed_id],
        )?
    } else {
        connection.execute(
            "UPDATE feed SET next_fetch_at = ?1 WHERE subscribed = 1",
            [datetime_to_db(now)],
        )?
    };
    if feed_id.is_some() && changed == 0 {
        return Err(FeedStoreError::FeedNotFound(feed_id.unwrap()));
    }
    Ok(())
}

fn prune(
    connection: &Connection,
    now: DateTime<Utc>,
    retention_days: u64,
    unread_retention_days: u64,
) -> Result<u64, FeedStoreError> {
    let read_cutoff = retention_cutoff(now, retention_days);
    let unread_cutoff = retention_cutoff(now, unread_retention_days);
    Ok(connection.execute(
        "
        DELETE FROM entry
        WHERE bookmarked_at IS NULL
          AND (
            (read_at IS NOT NULL AND COALESCE(published_at, fetched_at) < ?1)
            OR
            (read_at IS NULL AND COALESCE(published_at, fetched_at) < ?2)
          )
        ",
        params![datetime_to_db(read_cutoff), datetime_to_db(unread_cutoff)],
    )? as u64)
}

fn retention_cutoff(now: DateTime<Utc>, days: u64) -> DateTime<Utc> {
    let seconds = days.saturating_mul(86_400).min(i64::MAX as u64) as i64;
    now.checked_sub_signed(Duration::seconds(seconds))
        .unwrap_or(DateTime::<Utc>::MIN_UTC)
}

fn push_parameter(sql: &mut String, values: &mut Vec<Value>, prefix: &str, value: Value) {
    sql.push_str(prefix);
    push_placeholder(sql, values, value);
}

fn push_placeholder(sql: &mut String, values: &mut Vec<Value>, value: Value) {
    values.push(value);
    sql.push('?');
    sql.push_str(&values.len().to_string());
}

fn datetime_to_db(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Nanos, true)
}

fn parse_db_datetime(value: &str) -> Result<DateTime<Utc>, FeedStoreError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.to_utc())
        .map_err(|_| FeedStoreError::InvalidTimestamp(value.to_owned()))
}

fn timestamp_from_sql_error(error: FeedStoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

pub fn snapshot_database(source: &Path, destination: &Path) -> Result<(), FeedStoreError> {
    if source == destination {
        return Err(FeedStoreError::InvalidPath(destination.to_path_buf()));
    }
    if let Some(parent) = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|source| FeedStoreError::Io {
            operation: "create snapshot directory",
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let destination_text = destination
        .to_str()
        .ok_or_else(|| FeedStoreError::InvalidPath(destination.to_path_buf()))?;
    let connection = Connection::open(source)?;
    connection.execute("VACUUM INTO ?1", [destination_text])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::Path;

    use chrono::{DateTime, Duration, SecondsFormat, Utc};
    use rusqlite::{Connection, OptionalExtension};
    use tempfile::TempDir;

    use super::{FeedStoreError, FeedStoreHandle};
    use crate::feeds::types::{
        Entry, EntryCursor, EntryFilters, EntryPatch, EntryView, FetchOutcome, FetchedEntry,
        ManifestFeed, MarkReadScope,
    };

    fn ts(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value).unwrap().to_utc()
    }

    fn manifest_feed(url: &str, group: &str, tags: &[&str]) -> ManifestFeed {
        ManifestFeed {
            url: url.to_owned(),
            title_override: None,
            group: group.to_owned(),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            line: 1,
        }
    }

    fn fetched_entry(guid: &str, published_at: Option<DateTime<Utc>>) -> FetchedEntry {
        FetchedEntry {
            guid: guid.to_owned(),
            url: Some(format!("https://entries.example/{guid}")),
            title: guid.to_owned(),
            author: Some("Feed Author".to_owned()),
            content_html: Some(format!("<p>{guid}</p>")),
            published_at,
            fetched_at: ts("2026-08-09T12:00:00Z"),
        }
    }

    fn success(
        entries: Vec<FetchedEntry>,
        fetched_at: DateTime<Utc>,
        next_fetch_at: DateTime<Utc>,
    ) -> FetchOutcome {
        FetchOutcome::Success {
            fetched_at,
            next_fetch_at,
            etag: Some("\"feed-v1\"".to_owned()),
            last_modified: Some("Sun, 09 Aug 2026 11:30:00 GMT".to_owned()),
            title: Some("Fetched title".to_owned()),
            site_url: Some("https://one.example/".to_owned()),
            entries,
        }
    }

    fn filters(view: EntryView) -> EntryFilters {
        EntryFilters {
            view,
            feed_id: None,
            group: None,
            tag: None,
            limit: 50,
            cursor: None,
        }
    }

    async fn open_test_store() -> (FeedStoreHandle, TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let store = FeedStoreHandle::open(&temp.path().join("feeds.db")).unwrap();
        (store, temp)
    }

    async fn add_feed(store: &FeedStoreHandle, feed: ManifestFeed) -> i64 {
        store.reconcile(vec![feed]).await.unwrap();
        store.list_feeds().await.unwrap().remove(0).id
    }

    async fn entries_by_guid(store: &FeedStoreHandle) -> BTreeMap<String, Entry> {
        store
            .list_entries(filters(EntryView::All))
            .await
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| (entry.guid.clone(), entry))
            .collect()
    }

    fn create_legacy_database(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "
                PRAGMA user_version = 1;
                CREATE TABLE feed (
                    id INTEGER PRIMARY KEY,
                    url TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL DEFAULT '',
                    group_name TEXT,
                    subscribed INTEGER NOT NULL DEFAULT 1,
                    added_at TEXT NOT NULL,
                    next_fetch_at TEXT NOT NULL
                );
                INSERT INTO feed (
                    id, url, title, group_name, subscribed, added_at, next_fetch_at
                ) VALUES (
                    41, 'https://legacy.example/feed', 'Legacy title', 'Legacy', 1,
                    '2026-08-01T00:00:00Z', '2026-08-09T00:00:00Z'
                );
                ",
            )
            .unwrap();
    }

    #[test]
    fn opening_a_future_schema_version_is_rejected_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("feeds.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "
                PRAGMA user_version = 99;
                CREATE TABLE future_sentinel (
                    id INTEGER PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT INTO future_sentinel (id, value) VALUES (7, 'preserve-me');
                ",
            )
            .unwrap();
        drop(connection);

        let error = match FeedStoreHandle::open(&path) {
            Ok(store) => {
                drop(store);
                panic!("future schema version was accepted")
            }
            Err(error) => error,
        };
        assert!(matches!(
            error,
            FeedStoreError::UnsupportedSchemaVersion {
                found: 99,
                current: 2
            }
        ));

        let reopened = Connection::open(&path).unwrap();
        let version: i64 = reopened
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let sentinel: String = reopened
            .query_row(
                "SELECT value FROM future_sentinel WHERE id = 7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let feed_table: Option<String> = reopened
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(version, 99);
        assert_eq!(sentinel, "preserve-me");
        assert!(feed_table.is_none());
    }

    #[tokio::test]
    async fn version_one_migration_repairs_nullable_group_and_enforces_v2_invariant() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("feeds.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "
                PRAGMA user_version = 1;
                CREATE TABLE feed (
                    id INTEGER PRIMARY KEY,
                    url TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL DEFAULT '',
                    group_name TEXT,
                    subscribed INTEGER NOT NULL DEFAULT 1,
                    added_at TEXT NOT NULL,
                    next_fetch_at TEXT NOT NULL
                );
                INSERT INTO feed (
                    id, url, title, group_name, subscribed, added_at, next_fetch_at
                ) VALUES (
                    73, 'https://nullable-group.example/feed', 'Preserved title', NULL, 1,
                    '2026-08-01T00:00:00Z', '2026-08-09T00:00:00Z'
                );
                ",
            )
            .unwrap();
        drop(connection);

        let store = FeedStoreHandle::open(&path).unwrap();
        let migrated = store.list_feeds().await.unwrap().remove(0);
        assert_eq!(migrated.id, 73);
        assert_eq!(migrated.url, "https://nullable-group.example/feed");
        assert_eq!(migrated.title, "Preserved title");
        assert_eq!(migrated.group, "");
        drop(store);

        let reopened = Connection::open(&path).unwrap();
        let version: i64 = reopened
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let stored_group: String = reopened
            .query_row("SELECT group_name FROM feed WHERE id = 73", [], |row| {
                row.get(0)
            })
            .unwrap();
        let group_not_null: i64 = reopened
            .query_row(
                "
                SELECT \"notnull\"
                FROM pragma_table_info('feed')
                WHERE name = 'group_name'
                ",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 2);
        assert_eq!(stored_group, "");
        assert_eq!(group_not_null, 1);
    }

    #[tokio::test]
    async fn schema_initialization_is_idempotent_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("feeds.db");
        let store = FeedStoreHandle::open(&path).unwrap();
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &["rust"]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fetched_entry("persisted", Some(ts("2026-08-09T10:00:00Z")))],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        drop(store);

        let reopened = FeedStoreHandle::open(&path).unwrap();
        assert_eq!(reopened.list_feeds().await.unwrap()[0].id, feed_id);
        let entries = reopened
            .list_entries(filters(EntryView::All))
            .await
            .unwrap()
            .entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].guid, "persisted");
    }

    #[tokio::test]
    async fn opening_a_version_one_database_migrates_it_without_losing_feeds() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("feeds.db");
        create_legacy_database(&path);

        let store = FeedStoreHandle::open(&path).unwrap();
        let mut feed = manifest_feed("https://legacy.example/feed", "Updated", &["migrated"]);
        feed.title_override = Some("Manifest title".to_owned());
        store.reconcile(vec![feed]).await.unwrap();
        let migrated = store.list_feeds().await.unwrap().remove(0);

        assert_eq!(migrated.id, 41);
        assert_eq!(migrated.title_override.as_deref(), Some("Manifest title"));
        assert_eq!(migrated.group, "Updated");
        assert_eq!(migrated.tags, vec!["migrated"]);
        assert_eq!(migrated.error_count, 0);

        store
            .apply_fetch(
                migrated.id,
                success(
                    vec![fetched_entry(
                        "after-migration",
                        Some(ts("2026-08-09T10:00:00Z")),
                    )],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .list_entries(filters(EntryView::All))
                .await
                .unwrap()
                .entries
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn reconciliation_updates_manifest_metadata_and_softly_unsubscribes_missing_feeds() {
        let (store, _temp) = open_test_store().await;
        let mut one = manifest_feed("https://one.example/feed", "News", &["rust"]);
        one.title_override = Some("One".to_owned());
        let two = manifest_feed("https://two.example/feed", "News", &["web"]);
        store.reconcile(vec![one, two]).await.unwrap();

        let mut updated_two = manifest_feed("https://two.example/feed", "Work", &["daily", "web"]);
        updated_two.title_override = Some("Two updated".to_owned());
        let three = manifest_feed("https://three.example/feed", "Work", &[]);
        store.reconcile(vec![updated_two, three]).await.unwrap();
        store
            .reconcile(vec![
                {
                    let mut feed =
                        manifest_feed("https://two.example/feed", "Work", &["daily", "web"]);
                    feed.title_override = Some("Two updated".to_owned());
                    feed
                },
                manifest_feed("https://three.example/feed", "Work", &[]),
            ])
            .await
            .unwrap();

        let feeds = store.list_feeds().await.unwrap();
        assert_eq!(feeds.len(), 3);
        let by_url: BTreeMap<_, _> = feeds
            .into_iter()
            .map(|feed| (feed.url.clone(), feed))
            .collect();
        assert!(!by_url["https://one.example/feed"].subscribed);
        assert!(by_url["https://two.example/feed"].subscribed);
        assert_eq!(by_url["https://two.example/feed"].group, "Work");
        assert_eq!(
            by_url["https://two.example/feed"].title_override.as_deref(),
            Some("Two updated")
        );
        assert_eq!(
            by_url["https://two.example/feed"].tags,
            vec!["daily", "web"]
        );
        assert!(by_url["https://three.example/feed"].subscribed);
    }

    #[tokio::test]
    async fn entry_upsert_is_idempotent_and_preserves_authored_state() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let first = fetched_entry("guid-1", Some(ts("2026-08-09T10:00:00Z")));
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![first],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let original = entries_by_guid(&store).await.remove("guid-1").unwrap();
        store
            .patch_entry(
                original.id,
                EntryPatch {
                    read: Some(true),
                    bookmarked: Some(true),
                    tags: Some(vec!["research".to_owned()]),
                },
            )
            .await
            .unwrap();

        let mut changed = fetched_entry("guid-1", Some(ts("2026-08-09T10:05:00Z")));
        changed.title = "Updated upstream title".to_owned();
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![changed.clone()],
                    ts("2026-08-09T12:30:00Z"),
                    ts("2026-08-09T13:00:00Z"),
                ),
            )
            .await
            .unwrap();
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![changed],
                    ts("2026-08-09T12:30:00Z"),
                    ts("2026-08-09T13:00:00Z"),
                ),
            )
            .await
            .unwrap();

        let entries = store
            .list_entries(filters(EntryView::All))
            .await
            .unwrap()
            .entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, original.id);
        assert_eq!(entries[0].title, "Updated upstream title");
        assert!(entries[0].read);
        assert!(entries[0].bookmarked);
        assert_eq!(entries[0].tags, vec!["research"]);
    }

    #[tokio::test]
    async fn entry_pages_order_by_effective_timestamp_then_descending_id() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let mut newest_without_published = fetched_entry("fetched-newest", None);
        newest_without_published.fetched_at = ts("2026-08-09T11:00:00Z");
        let tie_a = fetched_entry("tie-a", Some(ts("2026-08-09T10:00:00Z")));
        let tie_b = fetched_entry("tie-b", Some(ts("2026-08-09T10:00:00Z")));
        let older = fetched_entry("older", Some(ts("2026-08-09T09:00:00Z")));
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![tie_a, tie_b, older, newest_without_published],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();

        let first = store
            .list_entries(EntryFilters {
                limit: 2,
                ..filters(EntryView::All)
            })
            .await
            .unwrap();
        assert_eq!(
            first
                .entries
                .iter()
                .map(|entry| entry.guid.as_str())
                .collect::<Vec<_>>(),
            vec!["fetched-newest", "tie-b"]
        );
        let boundary = first.next_cursor.expect("more entries remain");

        let second = store
            .list_entries(EntryFilters {
                limit: 2,
                cursor: Some(boundary),
                ..filters(EntryView::All)
            })
            .await
            .unwrap();
        assert_eq!(
            second
                .entries
                .iter()
                .map(|entry| entry.guid.as_str())
                .collect::<Vec<_>>(),
            vec!["tie-a", "older"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn cursor_encoding_is_canonical_and_parsing_is_strict() {
        let cursor = EntryCursor {
            sort_ts: ts("2026-08-09T10:00:00Z"),
            id: 42,
        };
        let encoded = cursor.encode();
        assert_eq!(
            encoded,
            format!(
                "{}|42",
                cursor.sort_ts.to_rfc3339_opts(SecondsFormat::Secs, true)
            )
        );
        assert_eq!(EntryCursor::parse(&encoded).unwrap(), cursor);

        for malformed in [
            "",
            "2026-08-09T10:00:00Z",
            "2026-08-09T10:00:00Z|",
            "|42",
            "2026-08-09 10:00:00Z|42",
            "2026-08-09T10:00:00Z|not-an-id",
            "2026-08-09T10:00:00Z|42|extra",
            " 2026-08-09T10:00:00Z|42",
            "2026-08-09T10:00:00Z|42 ",
        ] {
            assert!(
                EntryCursor::parse(malformed).is_err(),
                "accepted malformed cursor {malformed:?}"
            );
        }
    }

    #[tokio::test]
    async fn listing_intersects_view_feed_group_and_entry_tag_filters() {
        let (store, _temp) = open_test_store().await;
        let first_manifest = manifest_feed("https://one.example/feed", "News", &["feed-tag"]);
        let second_manifest = manifest_feed("https://two.example/feed", "Work", &[]);
        store
            .reconcile(vec![first_manifest, second_manifest])
            .await
            .unwrap();
        let feeds = store.list_feeds().await.unwrap();
        let first_id = feeds
            .iter()
            .find(|feed| feed.url == "https://one.example/feed")
            .unwrap()
            .id;
        let second_id = feeds
            .iter()
            .find(|feed| feed.url == "https://two.example/feed")
            .unwrap()
            .id;
        store
            .apply_fetch(
                first_id,
                success(
                    vec![
                        fetched_entry("news-unread", Some(ts("2026-08-09T10:00:00Z"))),
                        fetched_entry("news-saved", Some(ts("2026-08-09T09:00:00Z"))),
                    ],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        store
            .apply_fetch(
                second_id,
                success(
                    vec![fetched_entry(
                        "work-tagged",
                        Some(ts("2026-08-09T08:00:00Z")),
                    )],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let entries = entries_by_guid(&store).await;
        store
            .patch_entry(
                entries["news-saved"].id,
                EntryPatch {
                    read: Some(true),
                    bookmarked: Some(true),
                    tags: Some(vec!["research".to_owned()]),
                },
            )
            .await
            .unwrap();
        store
            .patch_entry(
                entries["work-tagged"].id,
                EntryPatch {
                    tags: Some(vec!["research".to_owned()]),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();

        let saved = store.list_entries(filters(EntryView::Saved)).await.unwrap();
        assert_eq!(saved.entries.len(), 1);
        assert_eq!(saved.entries[0].guid, "news-saved");

        let news_unread = store
            .list_entries(EntryFilters {
                view: EntryView::Unread,
                group: Some("News".to_owned()),
                ..filters(EntryView::Unread)
            })
            .await
            .unwrap();
        assert_eq!(news_unread.entries.len(), 1);
        assert_eq!(news_unread.entries[0].guid, "news-unread");

        let work_research = store
            .list_entries(EntryFilters {
                feed_id: Some(second_id),
                group: Some("Work".to_owned()),
                tag: Some("research".to_owned()),
                ..filters(EntryView::All)
            })
            .await
            .unwrap();
        assert_eq!(work_research.entries.len(), 1);
        assert_eq!(work_research.entries[0].guid, "work-tagged");

        let impossible_intersection = store
            .list_entries(EntryFilters {
                feed_id: Some(second_id),
                group: Some("News".to_owned()),
                tag: Some("research".to_owned()),
                ..filters(EntryView::All)
            })
            .await
            .unwrap();
        assert!(impossible_intersection.entries.is_empty());
    }

    #[tokio::test]
    async fn listing_many_entries_loads_all_tags_in_one_batched_query() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let fetched = (0..40)
            .map(|index| fetched_entry(&format!("entry-{index}"), Some(ts("2026-08-09T10:00:00Z"))))
            .collect();
        store
            .apply_fetch(
                feed_id,
                success(
                    fetched,
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let seeded = entries_by_guid(&store).await;
        for (guid, entry) in &seeded {
            let index = guid.strip_prefix("entry-").unwrap();
            store
                .patch_entry(
                    entry.id,
                    EntryPatch {
                        tags: Some(vec![
                            format!("topic-{index}"),
                            format!("topic-{index},child"),
                            format!("topic-{index}\u{1f}child"),
                        ]),
                        ..EntryPatch::default()
                    },
                )
                .await
                .unwrap();
        }

        store.reset_observed_queries().await.unwrap();
        let page = store.list_entries(filters(EntryView::All)).await.unwrap();
        let observed_queries = store.observed_queries().await.unwrap();

        assert_eq!(page.entries.len(), 40);
        for entry in page.entries {
            let index = entry.guid.strip_prefix("entry-").unwrap();
            assert_eq!(entry.tags.len(), 3);
            assert!(entry.tags.contains(&format!("topic-{index}")));
            assert!(entry.tags.contains(&format!("topic-{index},child")));
            assert!(entry.tags.contains(&format!("topic-{index}\u{1f}child")));
        }
        assert!(
            observed_queries <= 2,
            "list_entries executed {observed_queries} queries for 40 entries"
        );
    }

    #[tokio::test]
    async fn patch_entry_changes_read_bookmark_and_normalized_tag_state() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fetched_entry("patch-me", Some(ts("2026-08-09T10:00:00Z")))],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let entry = entries_by_guid(&store).await.remove("patch-me").unwrap();

        let patched = store
            .patch_entry(
                entry.id,
                EntryPatch {
                    read: Some(true),
                    bookmarked: Some(true),
                    tags: Some(vec![
                        "#research".to_owned(),
                        " research ".to_owned(),
                        "rust".to_owned(),
                    ]),
                },
            )
            .await
            .unwrap();
        assert!(patched.read);
        assert!(patched.bookmarked);
        assert_eq!(patched.tags, vec!["research", "rust"]);
        assert!(
            store
                .list_entries(filters(EntryView::Unread))
                .await
                .unwrap()
                .entries
                .is_empty()
        );
        assert_eq!(
            store
                .list_entries(filters(EntryView::Saved))
                .await
                .unwrap()
                .entries[0]
                .id,
            entry.id
        );

        let unpatched = store
            .patch_entry(
                entry.id,
                EntryPatch {
                    read: Some(false),
                    bookmarked: Some(false),
                    tags: Some(Vec::new()),
                },
            )
            .await
            .unwrap();
        assert!(!unpatched.read);
        assert!(!unpatched.bookmarked);
        assert!(unpatched.tags.is_empty());
    }

    #[tokio::test]
    async fn bulk_mark_read_honors_the_gesture_boundary_cursor() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![
                        fetched_entry("old-a", Some(ts("2026-08-09T10:00:00Z"))),
                        fetched_entry("old-b", Some(ts("2026-08-09T09:00:00Z"))),
                    ],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let visible = store
            .list_entries(EntryFilters {
                limit: 2,
                ..filters(EntryView::Unread)
            })
            .await
            .unwrap();
        let boundary_entry = visible.entries.first().unwrap();
        let boundary = EntryCursor {
            sort_ts: boundary_entry
                .published_at
                .unwrap_or(boundary_entry.fetched_at),
            id: boundary_entry.id,
        };

        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fetched_entry(
                        "arrived-later",
                        Some(ts("2026-08-09T11:00:00Z")),
                    )],
                    ts("2026-08-09T12:05:00Z"),
                    ts("2026-08-09T12:35:00Z"),
                ),
            )
            .await
            .unwrap();
        let changed = store
            .mark_read(MarkReadScope {
                feed_id: Some(feed_id),
                before: Some(boundary),
                ..MarkReadScope::default()
            })
            .await
            .unwrap();
        assert_eq!(changed, 2);

        let unread = store
            .list_entries(filters(EntryView::Unread))
            .await
            .unwrap();
        assert_eq!(unread.entries.len(), 1);
        assert_eq!(unread.entries[0].guid, "arrived-later");
    }

    #[tokio::test]
    async fn soft_unsubscription_retains_entries_but_removes_the_feed_from_due_work() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fetched_entry("retained", Some(ts("2026-08-09T10:00:00Z")))],
                    ts("2026-08-09T11:00:00Z"),
                    ts("2026-08-09T11:30:00Z"),
                ),
            )
            .await
            .unwrap();

        store.reconcile(Vec::new()).await.unwrap();
        let feeds = store.list_feeds().await.unwrap();
        assert_eq!(feeds.len(), 1);
        assert!(!feeds[0].subscribed);
        assert_eq!(
            store
                .list_entries(filters(EntryView::All))
                .await
                .unwrap()
                .entries[0]
                .guid,
            "retained"
        );
        assert!(
            store
                .due_feeds(ts("2026-08-09T12:00:00Z"))
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn successful_and_not_modified_fetches_persist_conditional_validators() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    Vec::new(),
                    ts("2026-08-09T11:00:00Z"),
                    ts("2026-08-09T11:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let after_success = store.list_feeds().await.unwrap().remove(0);
        assert_eq!(after_success.etag.as_deref(), Some("\"feed-v1\""));
        assert_eq!(
            after_success.last_modified.as_deref(),
            Some("Sun, 09 Aug 2026 11:30:00 GMT")
        );

        store
            .apply_fetch(
                feed_id,
                FetchOutcome::NotModified {
                    fetched_at: ts("2026-08-09T11:30:00Z"),
                    next_fetch_at: ts("2026-08-09T12:00:00Z"),
                    etag: None,
                    last_modified: None,
                },
            )
            .await
            .unwrap();
        let after_not_modified = store.list_feeds().await.unwrap().remove(0);
        assert_eq!(after_not_modified.etag.as_deref(), Some("\"feed-v1\""));
        assert_eq!(
            after_not_modified.last_modified.as_deref(),
            Some("Sun, 09 Aug 2026 11:30:00 GMT")
        );
        assert_eq!(
            after_not_modified.last_fetch_at,
            Some(ts("2026-08-09T11:30:00Z"))
        );
        assert_eq!(after_not_modified.next_fetch_at, ts("2026-08-09T12:00:00Z"));
    }

    #[tokio::test]
    async fn failure_backoff_bookkeeping_increments_and_a_success_resets_it() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                FetchOutcome::Failure {
                    fetched_at: ts("2026-08-09T10:00:00Z"),
                    next_fetch_at: ts("2026-08-09T11:00:00Z"),
                    error: "timeout".to_owned(),
                },
            )
            .await
            .unwrap();
        store
            .apply_fetch(
                feed_id,
                FetchOutcome::Failure {
                    fetched_at: ts("2026-08-09T11:00:00Z"),
                    next_fetch_at: ts("2026-08-09T13:00:00Z"),
                    error: "HTTP 503".to_owned(),
                },
            )
            .await
            .unwrap();
        let failed = store.list_feeds().await.unwrap().remove(0);
        assert_eq!(failed.error_count, 2);
        assert_eq!(failed.last_error.as_deref(), Some("HTTP 503"));
        assert_eq!(failed.last_fetch_at, Some(ts("2026-08-09T11:00:00Z")));
        assert_eq!(failed.next_fetch_at, ts("2026-08-09T13:00:00Z"));
        assert!(
            store
                .due_feeds(ts("2026-08-09T12:59:59Z"))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store.due_feeds(ts("2026-08-09T13:00:00Z")).await.unwrap()[0].id,
            feed_id
        );

        store
            .apply_fetch(
                feed_id,
                success(
                    Vec::new(),
                    ts("2026-08-09T13:00:00Z"),
                    ts("2026-08-09T13:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let recovered = store.list_feeds().await.unwrap().remove(0);
        assert_eq!(recovered.error_count, 0);
        assert!(recovered.last_error.is_none());
    }

    #[tokio::test]
    async fn schedule_refresh_makes_one_or_all_subscribed_feeds_due_at_the_requested_time() {
        let (store, _temp) = open_test_store().await;
        store
            .reconcile(vec![
                manifest_feed("https://one.example/feed", "News", &[]),
                manifest_feed("https://two.example/feed", "News", &[]),
            ])
            .await
            .unwrap();
        let feeds = store.list_feeds().await.unwrap();
        for feed in &feeds {
            store
                .apply_fetch(
                    feed.id,
                    success(
                        Vec::new(),
                        ts("2026-08-09T11:00:00Z"),
                        ts("2026-08-09T13:00:00Z"),
                    ),
                )
                .await
                .unwrap();
        }
        let one_id = feeds
            .iter()
            .find(|feed| feed.url == "https://one.example/feed")
            .unwrap()
            .id;
        let refresh_at = ts("2026-08-09T12:00:00Z");

        store
            .schedule_refresh(Some(one_id), refresh_at)
            .await
            .unwrap();
        let due_one = store.due_feeds(refresh_at).await.unwrap();
        assert_eq!(due_one.len(), 1);
        assert_eq!(due_one[0].id, one_id);

        store.schedule_refresh(None, refresh_at).await.unwrap();
        assert_eq!(store.due_feeds(refresh_at).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn prune_keeps_bookmarks_and_applies_read_and_unread_horizons() {
        let (store, _temp) = open_test_store().await;
        let now = ts("2026-08-09T12:00:00Z");
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let matrix = [
            ("bookmarked-old", 120),
            ("unread-89-days", 89),
            ("unread-91-days", 91),
            ("read-29-days", 29),
            ("read-31-days", 31),
        ];
        let entries = matrix
            .into_iter()
            .map(|(guid, days)| {
                let mut entry = fetched_entry(guid, Some(now - Duration::days(days)));
                entry.fetched_at = now - Duration::days(days);
                entry
            })
            .collect();
        store
            .apply_fetch(feed_id, success(entries, now, now + Duration::minutes(30)))
            .await
            .unwrap();
        let seeded = entries_by_guid(&store).await;
        store
            .patch_entry(
                seeded["bookmarked-old"].id,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();
        for guid in ["read-29-days", "read-31-days"] {
            store
                .patch_entry(
                    seeded[guid].id,
                    EntryPatch {
                        read: Some(true),
                        ..EntryPatch::default()
                    },
                )
                .await
                .unwrap();
        }

        let removed = store.prune(now, 30, 90).await.unwrap();
        assert_eq!(removed, 2);
        let remaining = entries_by_guid(&store).await;
        assert!(remaining.contains_key("bookmarked-old"));
        assert!(remaining.contains_key("unread-89-days"));
        assert!(!remaining.contains_key("unread-91-days"));
        assert!(remaining.contains_key("read-29-days"));
        assert!(!remaining.contains_key("read-31-days"));
    }

    #[tokio::test]
    async fn worker_snapshot_reopens_as_a_consistent_database() {
        let (store, source_dir) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fetched_entry("saved", Some(ts("2026-08-09T10:00:00Z")))],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let entry = entries_by_guid(&store).await.remove("saved").unwrap();
        store
            .patch_entry(
                entry.id,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();

        let snapshot = source_dir.path().join("snapshot.db");
        store.snapshot_to(snapshot.clone()).await.unwrap();
        let reopened = FeedStoreHandle::open(&snapshot).unwrap();
        assert_eq!(reopened.list_feeds().await.unwrap()[0].id, feed_id);
        let saved = reopened
            .list_entries(filters(EntryView::Saved))
            .await
            .unwrap();
        assert_eq!(saved.entries.len(), 1);
        assert_eq!(saved.entries[0].guid, "saved");
        assert!(saved.entries[0].bookmarked);
    }
}
