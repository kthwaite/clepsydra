#[cfg(test)]
use std::cell::Cell;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::thread;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params, params_from_iter};
use tokio::sync::oneshot;

use super::types::{
    Entry, EntryCursor, EntryFilters, EntryPage, EntryPatch, EntryView, FeedRecord, FeedSummary,
    FetchOutcome, FetchedEntry, ManifestFeed, MarkReadScope,
};

pub const CURRENT_SCHEMA_VERSION: i64 = 3;
pub const MAX_ENTRY_PAGE_BYTES: usize = 8 * 1_048_576;
pub const MAX_RETAINED_ENTRIES_PER_FEED: usize = 5_000;
pub const MAX_RETAINED_CONTENT_BYTES_PER_FEED: usize = 128 * 1_048_576;
pub const MAX_RETAINED_ENTRIES_GLOBAL: usize = 50_000;
pub const MAX_RETAINED_CONTENT_BYTES_GLOBAL: usize = 1_024 * 1_048_576;
#[derive(Debug, Clone, Copy)]
struct RetentionQuotaLimits {
    per_feed_entries: usize,
    per_feed_content_bytes: usize,
    global_entries: usize,
    global_content_bytes: usize,
}

const RETENTION_QUOTA_LIMITS: RetentionQuotaLimits = RetentionQuotaLimits {
    per_feed_entries: MAX_RETAINED_ENTRIES_PER_FEED,
    per_feed_content_bytes: MAX_RETAINED_CONTENT_BYTES_PER_FEED,
    global_entries: MAX_RETAINED_ENTRIES_GLOBAL,
    global_content_bytes: MAX_RETAINED_CONTENT_BYTES_GLOBAL,
};

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
    #[error("feed database `{0}` is already open by another writer")]
    AlreadyOpen(PathBuf),
    #[error("invalid stored timestamp `{0}`")]
    InvalidTimestamp(String),
    #[error("invalid entry cursor `{0}`")]
    InvalidCursor(String),
    #[error("unsafe feed database path `{path}`: expected {expected}")]
    UnsafePath {
        path: PathBuf,
        expected: &'static str,
    },
    #[error("invalid feed database path `{0}`")]
    InvalidPath(PathBuf),
    #[error("feed {0} was not found")]
    FeedNotFound(i64),
    #[error("entry {0} was not found")]
    EntryNotFound(i64),
    #[error("feed entry {0} exceeds the serialized entry-page byte limit")]
    EntryPageItemTooLarge(i64),
    #[error("serialize feed tags: {0}")]
    SerializeTags(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct FeedStoreHandle {
    inner: Arc<FeedStoreInner>,
}

struct FeedStoreInner {
    tx: mpsc::Sender<Command>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for FeedStoreInner {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
        let Some(worker) = self.worker.take() else {
            return;
        };
        if worker.thread().id() != thread::current().id() {
            let _ = worker.join();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryCounts {
    pub unread: u64,
    pub all: u64,
    pub saved: u64,
}

enum Command {
    Reconcile {
        feeds: Vec<ManifestFeed>,
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    ListFeeds {
        reply: oneshot::Sender<Result<Vec<FeedSummary>, FeedStoreError>>,
    },
    EntryCounts {
        reply: oneshot::Sender<Result<EntryCounts, FeedStoreError>>,
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
    GetEntry {
        id: i64,
        reply: oneshot::Sender<Result<Entry, FeedStoreError>>,
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
    SeedEntries {
        feed_ids: Vec<i64>,
        entries_per_feed: usize,
        reply: oneshot::Sender<Result<(), FeedStoreError>>,
    },
    #[cfg(test)]
    ApplyRetentionQuotas {
        feed_id: i64,
        limits: RetentionQuotaLimits,
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
    Shutdown,
}

impl FeedStoreHandle {
    pub fn open(path: &Path) -> Result<Self, FeedStoreError> {
        let path = path.to_path_buf();
        let worker_path = path.clone();
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("clepsydra-feed-store".to_owned())
            .spawn(move || match open_connection(&worker_path) {
                Ok(mut opened) => {
                    if ready_tx.send(Ok(())).is_ok() {
                        worker_loop(&mut opened, rx);
                    }
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(FeedStoreError::StartWorker)?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(FeedStoreInner {
                    tx,
                    worker: Some(worker),
                }),
            }),
            Ok(Err(error)) => {
                drop(tx);
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                drop(tx);
                let _ = worker.join();
                Err(FeedStoreError::WorkerStopped)
            }
        }
    }

    pub async fn reconcile(&self, feeds: Vec<ManifestFeed>) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::Reconcile { feeds, reply })
            .await
    }

    pub async fn list_feeds(&self) -> Result<Vec<FeedSummary>, FeedStoreError> {
        self.request(|reply| Command::ListFeeds { reply }).await
    }

    pub async fn entry_counts(&self) -> Result<EntryCounts, FeedStoreError> {
        self.request(|reply| Command::EntryCounts { reply }).await
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

    pub async fn get_entry(&self, id: i64) -> Result<Entry, FeedStoreError> {
        self.request(|reply| Command::GetEntry { id, reply }).await
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
    async fn seed_entries(
        &self,
        feed_ids: Vec<i64>,
        entries_per_feed: usize,
    ) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::SeedEntries {
            feed_ids,
            entries_per_feed,
            reply,
        })
        .await
    }

    #[cfg(test)]
    async fn apply_retention_quotas(
        &self,
        feed_id: i64,
        limits: RetentionQuotaLimits,
    ) -> Result<(), FeedStoreError> {
        self.request(|reply| Command::ApplyRetentionQuotas {
            feed_id,
            limits,
            reply,
        })
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
        self.inner
            .tx
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

fn worker_loop(opened: &mut OpenedConnection, rx: mpsc::Receiver<Command>) {
    while let Ok(command) = rx.recv() {
        #[cfg(unix)]
        if opened.poisoned {
            break;
        }
        match command {
            Command::Reconcile { feeds, reply } => {
                let result = reconcile(&mut opened.connection, feeds);
                let _ = reply.send(publish_mutation(opened, result));
            }
            Command::ListFeeds { reply } => {
                let _ = reply.send(list_feeds(&opened.connection, None));
            }
            Command::EntryCounts { reply } => {
                let _ = reply.send(entry_counts(&opened.connection));
            }
            Command::DueFeeds { now, reply } => {
                let _ = reply.send(list_feeds(&opened.connection, Some(now)));
            }
            Command::ApplyFetch {
                feed_id,
                outcome,
                reply,
            } => {
                let result = apply_fetch(&mut opened.connection, feed_id, outcome);
                let _ = reply.send(publish_mutation(opened, result));
            }
            Command::ListEntries { filters, reply } => {
                let _ = reply.send(list_entries(&opened.connection, filters));
            }
            Command::GetEntry { id, reply } => {
                let _ = reply.send(entry_by_id(&opened.connection, id));
            }
            Command::PatchEntry { id, patch, reply } => {
                let result = patch_entry(&mut opened.connection, id, patch);
                let _ = reply.send(publish_mutation(opened, result));
            }
            Command::MarkRead { scope, reply } => {
                let result = mark_read(&opened.connection, scope);
                let _ = reply.send(publish_mutation(opened, result));
            }
            Command::ScheduleRefresh {
                feed_id,
                now,
                reply,
            } => {
                let result = schedule_refresh(&opened.connection, feed_id, now);
                let _ = reply.send(publish_mutation(opened, result));
            }
            Command::Prune {
                now,
                retention_days,
                unread_retention_days,
                reply,
            } => {
                let result = prune(
                    &opened.connection,
                    now,
                    retention_days,
                    unread_retention_days,
                );
                let _ = reply.send(publish_mutation(opened, result));
            }
            Command::SnapshotTo { destination, reply } => {
                let _ = reply.send(snapshot_connection(&opened.connection, &destination));
            }
            #[cfg(test)]
            Command::SeedEntries {
                feed_ids,
                entries_per_feed,
                reply,
            } => {
                let result = seed_test_entries(&mut opened.connection, &feed_ids, entries_per_feed);
                let _ = reply.send(publish_mutation(opened, result));
            }
            #[cfg(test)]
            Command::ApplyRetentionQuotas {
                feed_id,
                limits,
                reply,
            } => {
                let result = apply_test_retention_quotas(&mut opened.connection, feed_id, limits);
                let _ = reply.send(publish_mutation(opened, result));
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
            Command::Shutdown => break,
        }
    }
}

#[cfg(test)]
type TestPathBarrier = (PathBuf, std::sync::Arc<std::sync::Barrier>);

#[cfg(test)]
static AFTER_DATABASE_OPEN_PATH_RESOLVED: std::sync::LazyLock<
    parking_lot::Mutex<Option<TestPathBarrier>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

#[cfg(test)]
static AFTER_SNAPSHOT_SOURCE_OPEN_PATH_RESOLVED: std::sync::LazyLock<
    parking_lot::Mutex<Option<TestPathBarrier>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

#[cfg(test)]
static AFTER_SNAPSHOT_PUBLICATION_PATH_RESOLVED: std::sync::LazyLock<
    parking_lot::Mutex<Option<TestPathBarrier>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

#[cfg(test)]
static AFTER_SNAPSHOT_GENERATION_SHARED_LOCKED: std::sync::LazyLock<
    parking_lot::Mutex<Option<TestPathBarrier>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

#[cfg(test)]
#[derive(Clone, Copy)]
struct IncrementalWalTestControl {
    checkpoint_bytes: u64,
    fail_after_append: bool,
    fail_after_checkpoint_rename: bool,
}

#[cfg(test)]
static INCREMENTAL_WAL_TEST_CONTROLS: std::sync::LazyLock<
    parking_lot::Mutex<BTreeMap<PathBuf, IncrementalWalTestControl>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(BTreeMap::new()));

#[cfg(test)]
fn normalize_test_barrier_path(path: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(path) {
        return path;
    }
    let Some(filename) = path.file_name() else {
        return path.to_path_buf();
    };
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::canonicalize(parent)
        .map(|parent| parent.join(filename))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
fn take_fail_after_durable_wal_append(path: &Path) -> bool {
    let path = normalize_test_barrier_path(path);
    INCREMENTAL_WAL_TEST_CONTROLS
        .lock()
        .get_mut(&path)
        .map(|control| std::mem::take(&mut control.fail_after_append))
        .unwrap_or(false)
}

#[cfg(test)]
fn take_fail_after_checkpoint_rename(path: &Path) -> bool {
    let path = normalize_test_barrier_path(path);
    INCREMENTAL_WAL_TEST_CONTROLS
        .lock()
        .get_mut(&path)
        .map(|control| std::mem::take(&mut control.fail_after_checkpoint_rename))
        .unwrap_or(false)
}

#[cfg(test)]
fn forced_wal_checkpoint_bytes(path: &Path) -> Option<u64> {
    let path = normalize_test_barrier_path(path);
    INCREMENTAL_WAL_TEST_CONTROLS
        .lock()
        .get(&path)
        .map(|control| control.checkpoint_bytes)
        .filter(|threshold| *threshold != u64::MAX)
}

#[cfg(test)]
fn install_test_path_barrier(
    slot: &std::sync::LazyLock<parking_lot::Mutex<Option<TestPathBarrier>>>,
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    let path = normalize_test_barrier_path(&path);
    let prior = slot.lock().replace((path, barrier));
    assert!(prior.is_none(), "test path barrier was already installed");
}

#[cfg(test)]
fn pause_at_test_path_barrier(
    slot: &std::sync::LazyLock<parking_lot::Mutex<Option<TestPathBarrier>>>,
    path: &Path,
) {
    let path = normalize_test_barrier_path(path);
    let barrier = {
        let mut slot = slot.lock();
        match slot.as_ref() {
            Some((expected, _)) if expected == &path => slot.take().map(|(_, barrier)| barrier),
            _ => None,
        }
    };
    if let Some(barrier) = barrier {
        barrier.wait();
        barrier.wait();
    }
}

#[cfg(test)]
fn install_after_database_open_path_resolved_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier(&AFTER_DATABASE_OPEN_PATH_RESOLVED, path, barrier);
}

#[cfg(test)]
pub(crate) fn install_after_snapshot_source_open_path_resolved_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier(&AFTER_SNAPSHOT_SOURCE_OPEN_PATH_RESOLVED, path, barrier);
}

#[cfg(test)]
fn install_after_snapshot_publication_path_resolved_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier(&AFTER_SNAPSHOT_PUBLICATION_PATH_RESOLVED, path, barrier);
}

#[cfg(test)]
fn install_after_snapshot_generation_shared_locked_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier(&AFTER_SNAPSHOT_GENERATION_SHARED_LOCKED, path, barrier);
}

struct PreparedDatabase {
    path: PathBuf,
    #[cfg(unix)]
    directory: std::os::fd::OwnedFd,
    #[cfg(unix)]
    filename: std::ffi::OsString,
    #[cfg(unix)]
    file: std::fs::File,
    #[cfg(unix)]
    wal_filename: std::ffi::OsString,
    #[cfg(unix)]
    wal: Option<std::fs::File>,
    #[cfg(unix)]
    published_wal_len: u64,
    #[cfg(unix)]
    wal_header: Option<[u8; 32]>,
    #[cfg(unix)]
    created: bool,
    #[cfg(unix)]
    _writer_lock: std::fs::File,
    #[cfg(unix)]
    generation_lock: std::fs::File,
}

struct OpenedConnection {
    connection: Connection,
    #[cfg(unix)]
    working_directory: tempfile::TempDir,
    #[cfg(unix)]
    working_path: PathBuf,
    #[cfg(unix)]
    backing: PreparedDatabase,
    #[cfg(unix)]
    poisoned: bool,
}

#[cfg(unix)]
fn verify_retained_file_identity(
    directory: &std::os::fd::OwnedFd,
    filename: &std::ffi::OsStr,
    file: &std::fs::File,
    display_path: &Path,
) -> Result<(), FeedStoreError> {
    use rustix::fs::{AtFlags, FileType, fstat, statat};

    let file_metadata = fstat(file).map_err(|source| FeedStoreError::Io {
        operation: "inspect retained database descriptor",
        path: display_path.to_path_buf(),
        source: source.into(),
    })?;
    let path_metadata =
        statat(directory, filename, AtFlags::SYMLINK_NOFOLLOW).map_err(|source| {
            FeedStoreError::Io {
                operation: "verify retained database identity",
                path: display_path.to_path_buf(),
                source: source.into(),
            }
        })?;
    if FileType::from_raw_mode(file_metadata.st_mode) != FileType::RegularFile
        || FileType::from_raw_mode(path_metadata.st_mode) != FileType::RegularFile
        || file_metadata.st_dev != path_metadata.st_dev
        || file_metadata.st_ino != path_metadata.st_ino
    {
        return Err(FeedStoreError::UnsafePath {
            path: display_path.to_path_buf(),
            expected: "unchanged regular database file",
        });
    }
    Ok(())
}
pub(crate) const FEED_WRITER_LOCK_FILENAME: &str = ".feeds.db.writer.lock";
pub(crate) const FEED_GENERATION_LOCK_FILENAME: &str = ".feeds.db.generation.lock";
#[cfg(unix)]
fn database_lock_filename(database_filename: &std::ffi::OsStr, suffix: &str) -> std::ffi::OsString {
    let mut filename = std::ffi::OsString::from(".");
    filename.push(database_filename);
    filename.push(suffix);
    filename
}

#[cfg(unix)]
pub(crate) fn open_feed_lock_file(
    directory: &std::os::fd::OwnedFd,
    filename: &std::ffi::OsStr,
    directory_path: &Path,
) -> Result<std::fs::File, FeedStoreError> {
    use rustix::fs::{AtFlags, FileType, Mode, OFlags, fchmod, fstat, openat, unlinkat};
    use rustix::io::Errno;

    let path = directory_path.join(filename);
    let create_flags = OFlags::RDWR
        | OFlags::CREATE
        | OFlags::EXCL
        | OFlags::CLOEXEC
        | OFlags::NOFOLLOW
        | OFlags::NONBLOCK;
    let existing_flags = OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
    let (file, created) = match openat(directory, filename, create_flags, Mode::RUSR | Mode::WUSR) {
        Ok(file) => (file, true),
        Err(Errno::EXIST) => (
            openat(directory, filename, existing_flags, Mode::empty()).map_err(|source| {
                FeedStoreError::Io {
                    operation: "open existing feed database lock without following links",
                    path: path.clone(),
                    source: source.into(),
                }
            })?,
            false,
        ),
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "create feed database lock without following links",
                path,
                source: source.into(),
            });
        }
    };
    if created && let Err(source) = fchmod(&file, Mode::RUSR | Mode::WUSR) {
        let _ = unlinkat(directory, filename, AtFlags::empty());
        return Err(FeedStoreError::Io {
            operation: "set owner-only feed database lock mode",
            path,
            source: source.into(),
        });
    }
    let metadata = fstat(&file).map_err(|source| FeedStoreError::Io {
        operation: "inspect feed database lock",
        path: path.clone(),
        source: source.into(),
    })?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(FeedStoreError::UnsafePath {
            path,
            expected: "regular feed database lock file",
        });
    }
    Ok(file.into())
}

#[cfg(unix)]
struct FeedGenerationLock {
    file: std::fs::File,
}

#[cfg(unix)]
impl Drop for FeedGenerationLock {
    fn drop(&mut self) {
        let _ = rustix::fs::flock(&self.file, rustix::fs::FlockOperation::Unlock);
    }
}

#[cfg(unix)]
fn lock_feed_generation_exclusive(
    backing: &PreparedDatabase,
) -> Result<FeedGenerationLock, FeedStoreError> {
    let file = backing
        .generation_lock
        .try_clone()
        .map_err(|source| FeedStoreError::Io {
            operation: "clone feed database generation lock",
            path: backing.path.with_file_name(database_lock_filename(
                &backing.filename,
                ".generation.lock",
            )),
            source,
        })?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::LockExclusive).map_err(|source| {
        FeedStoreError::Io {
            operation: "acquire exclusive feed database generation lock",
            path: backing.path.with_file_name(database_lock_filename(
                &backing.filename,
                ".generation.lock",
            )),
            source: source.into(),
        }
    })?;
    Ok(FeedGenerationLock { file })
}

#[cfg(unix)]
pub(crate) fn lock_feed_generation_shared(
    directory: &std::os::fd::OwnedFd,
    directory_path: &Path,
    database_filename: &std::ffi::OsStr,
) -> Result<std::fs::File, FeedStoreError> {
    let filename = database_lock_filename(database_filename, ".generation.lock");
    let file = open_feed_lock_file(directory, &filename, directory_path)?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::LockShared).map_err(|source| {
        FeedStoreError::Io {
            operation: "acquire shared feed database generation lock",
            path: directory_path.join(&filename),
            source: source.into(),
        }
    })?;
    Ok(file)
}

#[cfg(unix)]
fn prepare_database_path(path: &Path) -> Result<PreparedDatabase, FeedStoreError> {
    use rustix::fs::{FileType, Mode, OFlags, fchmod, fstat, mkdirat, open, openat};
    use rustix::io::Errno;

    let filename = path
        .file_name()
        .ok_or_else(|| FeedStoreError::InvalidPath(path.to_path_buf()))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let is_metadata_directory = parent.file_name() == Some(Path::new(".clepsydra").as_os_str());
    let trusted_parent = if is_metadata_directory {
        parent
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
    } else {
        parent
    };
    let trusted_parent =
        std::fs::canonicalize(trusted_parent).map_err(|source| FeedStoreError::Io {
            operation: "resolve trusted feed database parent",
            path: trusted_parent.to_path_buf(),
            source,
        })?;
    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
    let mut directory =
        open(&trusted_parent, directory_flags, Mode::empty()).map_err(|source| {
            FeedStoreError::Io {
                operation: "open trusted feed database parent without following links",
                path: trusted_parent.clone(),
                source: source.into(),
            }
        })?;
    let database_parent = if is_metadata_directory {
        let metadata_name = Path::new(".clepsydra").as_os_str();
        let metadata_path = trusted_parent.join(metadata_name);
        let created = match mkdirat(&directory, metadata_name, Mode::RWXU) {
            Ok(()) => true,
            Err(Errno::EXIST) => false,
            Err(source) => {
                return Err(FeedStoreError::Io {
                    operation: "create owner-only feed database directory",
                    path: metadata_path,
                    source: source.into(),
                });
            }
        };
        directory = openat(&directory, metadata_name, directory_flags, Mode::empty()).map_err(
            |source| FeedStoreError::Io {
                operation: "open feed database directory without following links",
                path: metadata_path.clone(),
                source: source.into(),
            },
        )?;
        if created {
            fchmod(&directory, Mode::RWXU).map_err(|source| FeedStoreError::Io {
                operation: "set owner-only feed database directory mode",
                path: metadata_path.clone(),
                source: source.into(),
            })?;
        }
        metadata_path
    } else {
        trusted_parent
    };

    let writer_lock_filename = database_lock_filename(filename, ".writer.lock");
    let writer_lock = open_feed_lock_file(&directory, &writer_lock_filename, &database_parent)?;
    match rustix::fs::flock(
        &writer_lock,
        rustix::fs::FlockOperation::NonBlockingLockExclusive,
    ) {
        Ok(()) => {}
        Err(rustix::io::Errno::WOULDBLOCK) => {
            return Err(FeedStoreError::AlreadyOpen(database_parent.join(filename)));
        }
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "acquire exclusive feed database writer ownership",
                path: database_parent.join(&writer_lock_filename),
                source: source.into(),
            });
        }
    }
    let generation_lock_filename = database_lock_filename(filename, ".generation.lock");
    let generation_lock =
        open_feed_lock_file(&directory, &generation_lock_filename, &database_parent)?;
    let database_path = database_parent.join(filename);
    let create_flags = OFlags::RDWR
        | OFlags::CREATE
        | OFlags::EXCL
        | OFlags::CLOEXEC
        | OFlags::NOFOLLOW
        | OFlags::NONBLOCK;
    let existing_flags = OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
    let (file, created) = match openat(&directory, filename, create_flags, Mode::RUSR | Mode::WUSR)
    {
        Ok(file) => (file, true),
        Err(Errno::EXIST) => (
            openat(&directory, filename, existing_flags, Mode::empty()).map_err(|source| {
                FeedStoreError::Io {
                    operation: "open existing feed database without following links",
                    path: database_path.clone(),
                    source: source.into(),
                }
            })?,
            false,
        ),
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "create feed database without following links",
                path: database_path,
                source: source.into(),
            });
        }
    };
    if created {
        fchmod(&file, Mode::RUSR | Mode::WUSR).map_err(|source| FeedStoreError::Io {
            operation: "set owner-only feed database mode",
            path: database_path.clone(),
            source: source.into(),
        })?;
    }
    let metadata = fstat(&file).map_err(|source| FeedStoreError::Io {
        operation: "inspect opened feed database",
        path: database_path.clone(),
        source: source.into(),
    })?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(FeedStoreError::UnsafePath {
            path: database_path,
            expected: "regular file",
        });
    }
    let mut wal_filename = filename.to_os_string();
    wal_filename.push("-wal");
    let wal_path = database_path.with_file_name(&wal_filename);
    let wal = match openat(&directory, &wal_filename, existing_flags, Mode::empty()) {
        Ok(wal) => {
            let metadata = fstat(&wal).map_err(|source| FeedStoreError::Io {
                operation: "inspect opened feed database WAL",
                path: wal_path.clone(),
                source: source.into(),
            })?;
            if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
                return Err(FeedStoreError::UnsafePath {
                    path: wal_path,
                    expected: "regular feed database WAL",
                });
            }
            Some(std::fs::File::from(wal))
        }
        Err(Errno::NOENT) => None,
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "open existing feed database WAL without following links",
                path: wal_path,
                source: source.into(),
            });
        }
    };
    let published_wal_len = wal
        .as_ref()
        .map(std::fs::File::metadata)
        .transpose()
        .map_err(|source| FeedStoreError::Io {
            operation: "inspect retained feed database WAL length",
            path: database_path.with_file_name(&wal_filename),
            source,
        })?
        .map_or(0, |metadata| metadata.len());
    let wal_header = wal
        .as_ref()
        .map(|wal| read_wal_header(wal, &database_path.with_file_name(&wal_filename)))
        .transpose()?
        .flatten();
    Ok(PreparedDatabase {
        path: database_path,
        directory,
        filename: filename.to_os_string(),
        file: file.into(),
        wal_filename,
        wal,
        published_wal_len,
        wal_header,
        created,
        _writer_lock: writer_lock,
        generation_lock,
    })
}

#[cfg(not(unix))]
fn prepare_database_path(path: &Path) -> Result<PreparedDatabase, FeedStoreError> {
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
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(FeedStoreError::UnsafePath {
                path: path.to_path_buf(),
                expected: "regular file",
            });
        }
        Ok(_) => {
            return Ok(PreparedDatabase {
                path: path.to_path_buf(),
            });
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "inspect feed database",
                path: path.to_path_buf(),
                source,
            });
        }
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| PreparedDatabase {
            path: path.to_path_buf(),
        })
        .map_err(|source| FeedStoreError::Io {
            operation: "create feed database",
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(unix)]
fn copy_file_contents(
    source: &std::fs::File,
    destination: &mut std::fs::File,
    source_path: &Path,
    destination_path: &Path,
) -> Result<(), FeedStoreError> {
    use std::io::{Seek, SeekFrom};

    let mut source = source.try_clone().map_err(|source| FeedStoreError::Io {
        operation: "clone private database source",
        path: source_path.to_path_buf(),
        source,
    })?;
    source
        .seek(SeekFrom::Start(0))
        .map_err(|source| FeedStoreError::Io {
            operation: "rewind private database source",
            path: source_path.to_path_buf(),
            source,
        })?;
    destination
        .seek(SeekFrom::Start(0))
        .and_then(|_| destination.set_len(0))
        .map_err(|source| FeedStoreError::Io {
            operation: "prepare private database destination",
            path: destination_path.to_path_buf(),
            source,
        })?;
    std::io::copy(&mut source, &mut *destination).map_err(|source| FeedStoreError::Io {
        operation: "copy private database contents",
        path: destination_path.to_path_buf(),
        source,
    })?;
    destination.sync_all().map_err(|source| FeedStoreError::Io {
        operation: "sync private database contents",
        path: destination_path.to_path_buf(),
        source,
    })
}

#[cfg(unix)]
fn read_wal_header(file: &std::fs::File, path: &Path) -> Result<Option<[u8; 32]>, FeedStoreError> {
    use std::io::{Read, Seek, SeekFrom};

    let length = file
        .metadata()
        .map_err(|source| FeedStoreError::Io {
            operation: "inspect feed database WAL",
            path: path.to_path_buf(),
            source,
        })?
        .len();
    if length == 0 {
        return Ok(None);
    }
    if length < 32 {
        return Err(FeedStoreError::UnsafePath {
            path: path.to_path_buf(),
            expected: "complete SQLite WAL header",
        });
    }
    let mut file = file.try_clone().map_err(|source| FeedStoreError::Io {
        operation: "clone feed database WAL",
        path: path.to_path_buf(),
        source,
    })?;
    file.seek(SeekFrom::Start(0))
        .and_then(|_| {
            let mut header = [0_u8; 32];
            file.read_exact(&mut header)?;
            Ok(header)
        })
        .map(Some)
        .map_err(|source| FeedStoreError::Io {
            operation: "read feed database WAL header",
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(unix)]
fn copy_private_wal(
    source_wal: &std::fs::File,
    source_wal_path: &Path,
    private_directory: &Path,
) -> Result<(), FeedStoreError> {
    use std::os::unix::fs::OpenOptionsExt;

    let destination_path = private_directory.join("feeds.db-wal");
    let mut destination = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&destination_path)
        .map_err(|source| FeedStoreError::Io {
            operation: "create private feed database WAL",
            path: destination_path.clone(),
            source,
        })?;
    copy_file_contents(
        source_wal,
        &mut destination,
        source_wal_path,
        &destination_path,
    )
}

#[cfg(unix)]
fn create_private_working_copy(
    source_directory: &std::os::fd::OwnedFd,
    source_filename: &std::ffi::OsStr,
    source: &std::fs::File,
    retained_wal: Option<&std::fs::File>,
    source_path: &Path,
) -> Result<(tempfile::TempDir, PathBuf), FeedStoreError> {
    use rustix::fs::{FileType, Mode, OFlags, fstat, openat};
    use rustix::io::Errno;
    use std::os::unix::fs::OpenOptionsExt;

    let directory = tempfile::tempdir().map_err(|source| FeedStoreError::Io {
        operation: "create private feed database directory",
        path: std::env::temp_dir(),
        source,
    })?;
    let private_directory =
        std::fs::canonicalize(directory.path()).map_err(|source| FeedStoreError::Io {
            operation: "resolve private feed database directory",
            path: directory.path().to_path_buf(),
            source,
        })?;
    let path = private_directory.join("feeds.db");
    let mut destination = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|source| FeedStoreError::Io {
            operation: "create private feed database",
            path: path.clone(),
            source,
        })?;
    copy_file_contents(source, &mut destination, source_path, &path)?;

    let mut wal_name = source_filename.to_os_string();
    wal_name.push("-wal");
    let wal_path = source_path.with_file_name(&wal_name);
    if let Some(wal) = retained_wal {
        copy_private_wal(wal, &wal_path, &private_directory)?;
    } else {
        match openat(
            source_directory,
            &wal_name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(wal) => {
                let metadata = fstat(&wal).map_err(|source| FeedStoreError::Io {
                    operation: "inspect retained feed database WAL",
                    path: wal_path.clone(),
                    source: source.into(),
                })?;
                if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
                    return Err(FeedStoreError::UnsafePath {
                        path: wal_path,
                        expected: "regular feed database WAL",
                    });
                }
                copy_private_wal(&std::fs::File::from(wal), &wal_path, &private_directory)?;
            }
            Err(Errno::NOENT) => {}
            Err(source) => {
                return Err(FeedStoreError::Io {
                    operation: "open retained feed database WAL",
                    path: wal_path,
                    source: source.into(),
                });
            }
        }
    }
    Ok((directory, path))
}

#[cfg(unix)]
fn create_private_snapshot(
    connection: &Connection,
) -> Result<(tempfile::TempDir, PathBuf), FeedStoreError> {
    let directory = tempfile::tempdir().map_err(|source| FeedStoreError::Io {
        operation: "create private feed snapshot directory",
        path: std::env::temp_dir(),
        source,
    })?;
    let private_directory =
        std::fs::canonicalize(directory.path()).map_err(|source| FeedStoreError::Io {
            operation: "resolve private feed snapshot directory",
            path: directory.path().to_path_buf(),
            source,
        })?;
    let path = private_directory.join("feeds.db");
    let path_text = path
        .to_str()
        .ok_or_else(|| FeedStoreError::InvalidPath(path.clone()))?;
    connection.execute("VACUUM INTO ?1", [path_text])?;
    Ok((directory, path))
}

#[cfg(unix)]
fn publish_checkpointed_main(
    source_path: &Path,
    backing: &mut PreparedDatabase,
) -> Result<(), FeedStoreError> {
    use rustix::fs::{
        AtFlags, FileType, Mode, OFlags, fchmod, fstat, fsync, openat, renameat, unlinkat,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static PUBLICATION_COUNTER: AtomicU64 = AtomicU64::new(0);

    let counter = PUBLICATION_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_name = format!(".feeds.db.publish-{}-{counter}", std::process::id());
    let temporary = openat(
        &backing.directory,
        &temporary_name,
        OFlags::RDWR
            | OFlags::CREATE
            | OFlags::EXCL
            | OFlags::CLOEXEC
            | OFlags::NOFOLLOW
            | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|source| FeedStoreError::Io {
        operation: "create descriptor-bound feed database publication",
        path: backing.path.clone(),
        source: source.into(),
    })?;
    if let Err(source) = fchmod(&temporary, Mode::RUSR | Mode::WUSR) {
        let _ = unlinkat(&backing.directory, &temporary_name, AtFlags::empty());
        return Err(FeedStoreError::Io {
            operation: "set owner-only feed database publication mode",
            path: backing.path.clone(),
            source: source.into(),
        });
    }
    let mut temporary_file = std::fs::File::from(temporary);
    let source_file = std::fs::File::open(source_path).map_err(|source| FeedStoreError::Io {
        operation: "open private checkpointed feed database",
        path: source_path.to_path_buf(),
        source,
    })?;
    source_file
        .sync_all()
        .map_err(|source| FeedStoreError::Io {
            operation: "sync private checkpointed feed database",
            path: source_path.to_path_buf(),
            source,
        })?;
    if let Err(error) = copy_file_contents(
        &source_file,
        &mut temporary_file,
        source_path,
        &backing.path,
    ) {
        let _ = unlinkat(&backing.directory, &temporary_name, AtFlags::empty());
        return Err(error);
    }
    if let Err(source) = renameat(
        &backing.directory,
        &temporary_name,
        &backing.directory,
        &backing.filename,
    ) {
        let _ = unlinkat(&backing.directory, &temporary_name, AtFlags::empty());
        return Err(FeedStoreError::Io {
            operation: "atomically publish checkpointed feed database",
            path: backing.path.clone(),
            source: source.into(),
        });
    }
    fsync(&backing.directory).map_err(|source| FeedStoreError::Io {
        operation: "sync checkpointed feed database directory",
        path: backing.path.clone(),
        source: source.into(),
    })?;
    let file = openat(
        &backing.directory,
        &backing.filename,
        OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|source| FeedStoreError::Io {
        operation: "reopen published checkpointed feed database",
        path: backing.path.clone(),
        source: source.into(),
    })?;
    let metadata = fstat(&file).map_err(|source| FeedStoreError::Io {
        operation: "inspect published checkpointed feed database",
        path: backing.path.clone(),
        source: source.into(),
    })?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(FeedStoreError::UnsafePath {
            path: backing.path.clone(),
            expected: "regular checkpointed feed database",
        });
    }
    backing.file = file.into();
    Ok(())
}

#[cfg(unix)]
fn open_public_wal(backing: &mut PreparedDatabase) -> Result<bool, FeedStoreError> {
    use rustix::fs::{Mode, OFlags, fchmod, fsync, openat};

    if backing.wal.is_some() {
        return Ok(false);
    }
    let wal_path = backing.path.with_file_name(&backing.wal_filename);
    let wal = openat(
        &backing.directory,
        &backing.wal_filename,
        OFlags::RDWR
            | OFlags::CREATE
            | OFlags::EXCL
            | OFlags::CLOEXEC
            | OFlags::NOFOLLOW
            | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|source| FeedStoreError::Io {
        operation: "create descriptor-bound feed database WAL",
        path: wal_path.clone(),
        source: source.into(),
    })?;
    fchmod(&wal, Mode::RUSR | Mode::WUSR).map_err(|source| FeedStoreError::Io {
        operation: "set owner-only feed database WAL mode",
        path: wal_path,
        source: source.into(),
    })?;
    backing.wal = Some(wal.into());
    fsync(&backing.directory).map_err(|source| FeedStoreError::Io {
        operation: "sync newly created feed database WAL entry",
        path: backing.path.clone(),
        source: source.into(),
    })?;
    Ok(true)
}

#[cfg(unix)]
enum WalPublication {
    Unchanged,
    Appended,
    Reset,
}

#[cfg(unix)]
fn append_private_wal(opened: &mut OpenedConnection) -> Result<WalPublication, FeedStoreError> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let private_wal_path = opened.working_path.with_file_name("feeds.db-wal");
    let private_wal = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&private_wal_path)
    {
        Ok(file) => file,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WalPublication::Unchanged);
        }
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "open private feed database WAL",
                path: private_wal_path,
                source,
            });
        }
    };
    private_wal
        .sync_all()
        .map_err(|source| FeedStoreError::Io {
            operation: "sync private feed database WAL",
            path: private_wal_path.clone(),
            source,
        })?;
    let private_len = private_wal
        .metadata()
        .map_err(|source| FeedStoreError::Io {
            operation: "inspect private feed database WAL",
            path: private_wal_path.clone(),
            source,
        })?
        .len();
    let private_header = read_wal_header(&private_wal, &private_wal_path)?;
    if private_len == opened.backing.published_wal_len {
        return if private_header == opened.backing.wal_header {
            Ok(WalPublication::Unchanged)
        } else {
            Ok(WalPublication::Reset)
        };
    }
    if private_len < opened.backing.published_wal_len
        || (opened.backing.published_wal_len > 0 && private_header != opened.backing.wal_header)
    {
        return Ok(WalPublication::Reset);
    }

    let prior_len = opened.backing.published_wal_len;
    open_public_wal(&mut opened.backing)?;
    let wal_path = opened
        .backing
        .path
        .with_file_name(&opened.backing.wal_filename);
    let public_wal = opened.backing.wal.as_mut().expect("public WAL was opened");
    verify_retained_file_identity(
        &opened.backing.directory,
        &opened.backing.wal_filename,
        public_wal,
        &wal_path,
    )?;
    let public_len = public_wal
        .metadata()
        .map_err(|source| FeedStoreError::Io {
            operation: "inspect public feed database WAL length",
            path: wal_path.clone(),
            source,
        })?
        .len();
    if public_len != prior_len {
        return Err(FeedStoreError::UnsafePath {
            path: wal_path,
            expected: "unchanged public feed database WAL length",
        });
    }

    let mut source = private_wal
        .try_clone()
        .map_err(|source| FeedStoreError::Io {
            operation: "clone private feed database WAL",
            path: private_wal_path.clone(),
            source,
        })?;
    source
        .seek(SeekFrom::Start(prior_len))
        .map_err(|source| FeedStoreError::Io {
            operation: "seek private feed database WAL",
            path: private_wal_path.clone(),
            source,
        })?;
    public_wal
        .seek(SeekFrom::Start(prior_len))
        .map_err(|source| FeedStoreError::Io {
            operation: "seek public feed database WAL",
            path: wal_path.clone(),
            source,
        })?;
    let mut remaining = private_len - prior_len;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let amount = usize::try_from(remaining.min(buffer.len() as u64))
            .expect("bounded WAL copy amount fits usize");
        source
            .read_exact(&mut buffer[..amount])
            .map_err(|source| FeedStoreError::Io {
                operation: "read new private feed database WAL bytes",
                path: private_wal_path.clone(),
                source,
            })?;
        public_wal
            .write_all(&buffer[..amount])
            .map_err(|source| FeedStoreError::Io {
                operation: "append public feed database WAL bytes",
                path: wal_path.clone(),
                source,
            })?;
        remaining -= amount as u64;
    }
    public_wal.sync_all().map_err(|source| FeedStoreError::Io {
        operation: "sync appended public feed database WAL",
        path: wal_path.clone(),
        source,
    })?;
    verify_retained_file_identity(
        &opened.backing.directory,
        &opened.backing.wal_filename,
        public_wal,
        &wal_path,
    )?;
    opened.backing.published_wal_len = private_len;
    opened.backing.wal_header = private_header;

    #[cfg(test)]
    if take_fail_after_durable_wal_append(&opened.backing.path) {
        return Err(FeedStoreError::Io {
            operation: "publish feed database WAL",
            path: wal_path,
            source: std::io::Error::other("injected failure after durable WAL append"),
        });
    }
    Ok(WalPublication::Appended)
}

#[cfg(unix)]
fn restore_last_durable_state(
    opened: &mut OpenedConnection,
    wal_existed: bool,
    wal_len: u64,
    wal_header: Option<[u8; 32]>,
) -> Result<(), FeedStoreError> {
    use rustix::fs::{AtFlags, fsync, unlinkat};

    let wal_path = opened
        .backing
        .path
        .with_file_name(&opened.backing.wal_filename);
    if wal_existed {
        let wal = opened
            .backing
            .wal
            .as_mut()
            .ok_or_else(|| FeedStoreError::UnsafePath {
                path: wal_path.clone(),
                expected: "retained durable feed database WAL",
            })?;
        wal.set_len(wal_len)
            .and_then(|()| wal.sync_all())
            .map_err(|source| FeedStoreError::Io {
                operation: "restore durable feed database WAL prefix",
                path: wal_path.clone(),
                source,
            })?;
    } else if opened.backing.wal.take().is_some() {
        unlinkat(
            &opened.backing.directory,
            &opened.backing.wal_filename,
            AtFlags::empty(),
        )
        .map_err(|source| FeedStoreError::Io {
            operation: "remove failed feed database WAL publication",
            path: wal_path,
            source: source.into(),
        })?;
        fsync(&opened.backing.directory).map_err(|source| FeedStoreError::Io {
            operation: "sync failed feed database WAL rollback",
            path: opened.backing.path.clone(),
            source: source.into(),
        })?;
    }
    verify_retained_file_identity(
        &opened.backing.directory,
        &opened.backing.filename,
        &opened.backing.file,
        &opened.backing.path,
    )?;
    if let Some(wal) = opened.backing.wal.as_ref() {
        verify_retained_file_identity(
            &opened.backing.directory,
            &opened.backing.wal_filename,
            wal,
            &opened
                .backing
                .path
                .with_file_name(&opened.backing.wal_filename),
        )?;
    }
    opened.backing.published_wal_len = wal_len;
    opened.backing.wal_header = wal_header;
    rebuild_private_connection(opened)
}
#[cfg(unix)]
fn configure_private_connection(connection: &Connection) -> Result<(), FeedStoreError> {
    connection.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA foreign_keys = ON;
        ",
    )?;
    Ok(())
}

#[cfg(unix)]
fn rebuild_private_connection(opened: &mut OpenedConnection) -> Result<(), FeedStoreError> {
    let wal_path = opened
        .backing
        .path
        .with_file_name(&opened.backing.wal_filename);
    opened.backing.published_wal_len = opened
        .backing
        .wal
        .as_ref()
        .map(std::fs::File::metadata)
        .transpose()
        .map_err(|source| FeedStoreError::Io {
            operation: "inspect durable feed database WAL during recovery",
            path: wal_path.clone(),
            source,
        })?
        .map_or(0, |metadata| metadata.len());
    opened.backing.wal_header = opened
        .backing
        .wal
        .as_ref()
        .map(|wal| read_wal_header(wal, &wal_path))
        .transpose()?
        .flatten();
    let (working_directory, working_path) = create_private_working_copy(
        &opened.backing.directory,
        &opened.backing.filename,
        &opened.backing.file,
        opened.backing.wal.as_ref(),
        &opened.backing.path,
    )?;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(&working_path, flags)?;
    configure_private_connection(&connection)?;
    let old_connection = std::mem::replace(&mut opened.connection, connection);
    let old_directory = std::mem::replace(&mut opened.working_directory, working_directory);
    opened.working_path = working_path;
    drop(old_connection);
    drop(old_directory);
    Ok(())
}

#[cfg(unix)]
fn checkpoint_private_connection(opened: &mut OpenedConnection) -> Result<(), FeedStoreError> {
    use rustix::fs::{AtFlags, fsync, unlinkat};
    use rustix::io::Errno;

    let busy: i64 = opened
        .connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy != 0 {
        return Err(FeedStoreError::Io {
            operation: "checkpoint private feed database WAL",
            path: opened.working_path.clone(),
            source: std::io::Error::other("SQLite WAL checkpoint remained busy"),
        });
    }
    publish_checkpointed_main(&opened.working_path, &mut opened.backing)?;

    #[cfg(test)]
    if take_fail_after_checkpoint_rename(&opened.backing.path) {
        rebuild_private_connection(opened)?;
        return Ok(());
    }

    let cleanup = (|| -> Result<(), FeedStoreError> {
        if opened.backing.wal.is_some() {
            match unlinkat(
                &opened.backing.directory,
                &opened.backing.wal_filename,
                AtFlags::empty(),
            ) {
                Ok(()) | Err(Errno::NOENT) => {}
                Err(source) => {
                    return Err(FeedStoreError::Io {
                        operation: "remove checkpointed feed database WAL",
                        path: opened
                            .backing
                            .path
                            .with_file_name(&opened.backing.wal_filename),
                        source: source.into(),
                    });
                }
            }
            opened.backing.wal = None;
        }
        let mut shm_filename = opened.backing.filename.clone();
        shm_filename.push("-shm");
        match unlinkat(&opened.backing.directory, &shm_filename, AtFlags::empty()) {
            Ok(()) | Err(Errno::NOENT) => {}
            Err(source) => {
                return Err(FeedStoreError::Io {
                    operation: "remove obsolete feed database SHM",
                    path: opened.backing.path.with_file_name(shm_filename),
                    source: source.into(),
                });
            }
        }
        fsync(&opened.backing.directory).map_err(|source| FeedStoreError::Io {
            operation: "sync checkpointed feed database sidecar removal",
            path: opened.backing.path.clone(),
            source: source.into(),
        })?;
        opened.backing.published_wal_len = 0;
        opened.backing.wal_header = None;
        Ok(())
    })();
    if cleanup.is_err() {
        rebuild_private_connection(opened)?;
    }
    Ok(())
}

#[cfg(unix)]
fn wal_checkpoint_threshold(path: &Path) -> u64 {
    #[cfg(not(test))]
    let _ = path;
    #[cfg(test)]
    if let Some(forced) = forced_wal_checkpoint_bytes(path) {
        return forced;
    }
    64 * 1024 * 1024
}

fn publish_mutation<T>(
    opened: &mut OpenedConnection,
    result: Result<T, FeedStoreError>,
) -> Result<T, FeedStoreError> {
    let value = result?;
    #[cfg(unix)]
    {
        if opened.poisoned {
            return Err(FeedStoreError::WorkerStopped);
        }
        let _generation_lock = lock_feed_generation_exclusive(&opened.backing)?;
        let baseline_wal_existed = opened.backing.wal.is_some();
        let baseline_wal_len = opened.backing.published_wal_len;
        let baseline_wal_header = opened.backing.wal_header;
        let publication = match append_private_wal(opened) {
            Ok(publication) => publication,
            Err(error) => {
                if let Err(recovery_error) = restore_last_durable_state(
                    opened,
                    baseline_wal_existed,
                    baseline_wal_len,
                    baseline_wal_header,
                ) {
                    opened.poisoned = true;
                    return Err(recovery_error);
                }
                return Err(error);
            }
        };
        match publication {
            WalPublication::Unchanged => {}
            WalPublication::Reset => {
                if let Err(error) = checkpoint_private_connection(opened) {
                    if let Err(recovery_error) = restore_last_durable_state(
                        opened,
                        baseline_wal_existed,
                        baseline_wal_len,
                        baseline_wal_header,
                    ) {
                        opened.poisoned = true;
                        return Err(recovery_error);
                    }
                    return Err(error);
                }
            }
            WalPublication::Appended => {
                if opened.backing.published_wal_len
                    >= wal_checkpoint_threshold(&opened.backing.path)
                    && checkpoint_private_connection(opened).is_err()
                    && rebuild_private_connection(opened).is_err()
                {
                    opened.poisoned = true;
                }
            }
        }
    }
    Ok(value)
}
fn initialize_connection(connection: &mut Connection) -> Result<(), FeedStoreError> {
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
        PRAGMA synchronous = FULL;
        PRAGMA wal_autocheckpoint = 0;
        ",
    )?;
    initialize_schema(connection, schema_version)?;
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(())
}

fn open_connection(path: &Path) -> Result<OpenedConnection, FeedStoreError> {
    let prepared = prepare_database_path(path)?;
    #[cfg(unix)]
    {
        verify_retained_file_identity(
            &prepared.directory,
            &prepared.filename,
            &prepared.file,
            &prepared.path,
        )?;
        #[cfg(test)]
        pause_at_test_path_barrier(&AFTER_DATABASE_OPEN_PATH_RESOLVED, &prepared.path);
        let was_created = prepared.created;
        let (working_directory, working_path) = create_private_working_copy(
            &prepared.directory,
            &prepared.filename,
            &prepared.file,
            prepared.wal.as_ref(),
            &prepared.path,
        )?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(&working_path, flags)?;
        let mut opened = OpenedConnection {
            connection,
            working_directory,
            working_path,
            backing: prepared,
            poisoned: false,
        };
        initialize_connection(&mut opened.connection)?;
        if was_created {
            let _generation_lock = lock_feed_generation_exclusive(&opened.backing)?;
            checkpoint_private_connection(&mut opened)?;
        } else {
            publish_mutation(&mut opened, Ok(()))?;
        }
        Ok(opened)
    }
    #[cfg(not(unix))]
    {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut connection = Connection::open_with_flags(&prepared.path, flags)?;
        initialize_connection(&mut connection)?;
        Ok(OpenedConnection { connection })
    }
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
            fetch_url TEXT,
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
        ("fetch_url", "TEXT"),
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
        PRAGMA user_version = 3;
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
            fetch_url TEXT,
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
            id, url, fetch_url, site_url, title, title_override, group_name, tags,
            subscribed, sort_order, added_at, etag, last_modified, last_fetch_at,
            next_fetch_at, error_count, last_error
        )
        SELECT
            id, url, fetch_url, site_url, COALESCE(title, ''), title_override,
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
    let unchanged = {
        let mut statement = connection.prepare(
            "
            SELECT url, title_override, group_name, tags, sort_order
            FROM feed
            WHERE subscribed = 1
            ORDER BY sort_order ASC, id ASC
            ",
        )?;
        let mut rows = statement.query([])?;
        let mut unchanged = true;
        for (sort_order, feed) in feeds.iter().enumerate() {
            let Some(row) = rows.next()? else {
                unchanged = false;
                break;
            };
            let tags = serde_json::to_string(&feed.tags)?;
            unchanged &= row.get::<_, String>(0)? == feed.url;
            unchanged &= row.get::<_, Option<String>>(1)? == feed.title_override;
            unchanged &= row.get::<_, String>(2)? == feed.group;
            unchanged &= row.get::<_, String>(3)? == tags;
            unchanged &= row.get::<_, i64>(4)? == sort_order as i64;
        }
        unchanged && rows.next()?.is_none()
    };
    if unchanged {
        return Ok(());
    }
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
        SELECT id, url, fetch_url, site_url, title, title_override, group_name, tags,
               subscribed, etag, last_modified, last_fetch_at, next_fetch_at,
               error_count, last_error
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
    let tags: String = row.get(7)?;
    let last_fetch_at: Option<String> = row.get(11)?;
    let next_fetch_at: String = row.get(12)?;
    Ok(FeedSummary {
        id: row.get(0)?,
        url: row.get(1)?,
        fetch_url: row.get(2)?,
        site_url: row.get(3)?,
        title: row.get(4)?,
        title_override: row.get(5)?,
        group: row.get(6)?,
        tags: serde_json::from_str(&tags).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        subscribed: row.get(8)?,
        etag: row.get(9)?,
        last_modified: row.get(10)?,
        last_fetch_at: last_fetch_at
            .map(|value| parse_db_datetime(&value))
            .transpose()
            .map_err(timestamp_from_sql_error)?,
        next_fetch_at: parse_db_datetime(&next_fetch_at).map_err(timestamp_from_sql_error)?,
        error_count: row.get(13)?,
        last_error: row.get(14)?,
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
            fetch_url,
            etag,
            last_modified,
            title,
            site_url,
            entries,
        } => {
            let changed = transaction.execute(
                "
                UPDATE feed SET
                    fetch_url = ?1,
                    title = COALESCE(?2, title),
                    site_url = COALESCE(?3, site_url),
                    etag = ?4,
                    last_modified = ?5,
                    last_fetch_at = ?6,
                    next_fetch_at = ?7,
                    error_count = 0,
                    last_error = NULL
                WHERE id = ?8
                ",
                params![
                    fetch_url,
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
                enforce_retention_quotas(&transaction, feed_id, RETENTION_QUOTA_LIMITS)?;
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
            published_at = COALESCE(entry.published_at, excluded.published_at)
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
#[cfg(test)]
fn seed_test_entries(
    connection: &mut Connection,
    feed_ids: &[i64],
    entries_per_feed: usize,
) -> Result<(), FeedStoreError> {
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction.prepare(
            "
            INSERT INTO entry (feed_id, guid, title, fetched_at)
            VALUES (?1, ?2, ?2, ?3)
            ",
        )?;
        for feed_id in feed_ids {
            for index in 0..entries_per_feed {
                statement.execute(params![
                    feed_id,
                    format!("seed-{feed_id}-{index}"),
                    "2026-01-01T00:00:00Z"
                ])?;
            }
        }
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
fn apply_test_retention_quotas(
    connection: &mut Connection,
    feed_id: i64,
    limits: RetentionQuotaLimits,
) -> Result<(), FeedStoreError> {
    let transaction = connection.transaction()?;
    enforce_retention_quotas(&transaction, feed_id, limits)?;
    transaction.commit()?;
    Ok(())
}

fn enforce_retention_quotas(
    transaction: &Transaction<'_>,
    feed_id: i64,
    limits: RetentionQuotaLimits,
) -> Result<(), FeedStoreError> {
    transaction.execute(
        "
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (ORDER BY fetched_at DESC, id DESC) AS retained_count,
                SUM(COALESCE(length(CAST(content_html AS BLOB)), 0)) OVER (
                    ORDER BY fetched_at DESC, id DESC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS retained_bytes
            FROM entry
            WHERE feed_id = ?1 AND bookmarked_at IS NULL
        )
        DELETE FROM entry
        WHERE id IN (
            SELECT id
            FROM ranked
            WHERE retained_count > ?2 OR retained_bytes > ?3
        )
        ",
        params![
            feed_id,
            limits.per_feed_entries as i64,
            limits.per_feed_content_bytes as i64
        ],
    )?;
    transaction.execute(
        "
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (ORDER BY fetched_at DESC, id DESC) AS retained_count,
                SUM(COALESCE(length(CAST(content_html AS BLOB)), 0)) OVER (
                    ORDER BY fetched_at DESC, id DESC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS retained_bytes
            FROM entry
            WHERE bookmarked_at IS NULL
        )
        DELETE FROM entry
        WHERE id IN (
            SELECT id
            FROM ranked
            WHERE retained_count > ?1 OR retained_bytes > ?2
        )
        ",
        params![
            limits.global_entries as i64,
            limits.global_content_bytes as i64
        ],
    )?;
    Ok(())
}

fn entry_counts(connection: &Connection) -> Result<EntryCounts, FeedStoreError> {
    connection
        .query_row(
            "
            SELECT COUNT(*) - COUNT(read_at), COUNT(*), COUNT(bookmarked_at)
            FROM entry
            ",
            [],
            |row| {
                Ok(EntryCounts {
                    unread: row.get(0)?,
                    all: row.get(1)?,
                    saved: row.get(2)?,
                })
            },
        )
        .map_err(Into::into)
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
    let mut rows = statement.query(params_from_iter(values))?;
    let mut entries = Vec::new();
    let mut serialized_entries_bytes = 0_usize;
    let mut has_more = false;
    while let Some(row) = rows.next()? {
        if entries.len() == limit {
            has_more = true;
            break;
        }
        let entry = entry_from_row(row)?;
        let entry_bytes = serialized_entry_size(&entry);
        let candidate_bytes = serialized_entries_bytes
            .saturating_add(usize::from(!entries.is_empty()))
            .saturating_add(entry_bytes);
        if serialized_page_size(candidate_bytes, None) > MAX_ENTRY_PAGE_BYTES {
            if entries.is_empty() {
                return Err(FeedStoreError::EntryPageItemTooLarge(entry.id));
            }
            has_more = true;
            break;
        }
        serialized_entries_bytes = candidate_bytes;
        entries.push(entry);
    }
    drop(rows);
    drop(statement);

    load_entry_tags(connection, &mut entries)?;
    let mut entry_sizes = entries
        .iter()
        .map(serialized_entry_size)
        .collect::<Vec<_>>();
    serialized_entries_bytes = entry_sizes
        .iter()
        .copied()
        .fold(0_usize, usize::saturating_add)
        .saturating_add(entry_sizes.len().saturating_sub(1));
    let next_cursor = loop {
        let cursor = has_more.then(|| entries.last()).flatten().map(entry_cursor);
        if serialized_page_size(serialized_entries_bytes, cursor.as_ref()) <= MAX_ENTRY_PAGE_BYTES {
            break cursor;
        }
        if entries.len() == 1 {
            return Err(FeedStoreError::EntryPageItemTooLarge(entries[0].id));
        }
        has_more = true;
        let removed_bytes = entry_sizes
            .pop()
            .expect("entry sizes remain aligned with entries");
        entries.pop();
        serialized_entries_bytes = serialized_entries_bytes
            .saturating_sub(removed_bytes)
            .saturating_sub(usize::from(!entries.is_empty()));
    };
    Ok(EntryPage {
        entries,
        next_cursor,
    })
}

#[derive(serde::Serialize)]
struct SerializedEntry<'a> {
    id: i64,
    feed_id: i64,
    guid: &'a str,
    url: Option<&'a str>,
    title: &'a str,
    author: Option<&'a str>,
    content_html: Option<&'a str>,
    published_at: Option<&'a DateTime<Utc>>,
    fetched_at: &'a DateTime<Utc>,
    read: bool,
    bookmarked: bool,
    tags: &'a [String],
}

#[derive(Default)]
struct ByteCounter {
    bytes: usize,
}

impl std::io::Write for ByteCounter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buffer.len());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialized_entry_size(entry: &Entry) -> usize {
    serialized_json_size(&SerializedEntry {
        id: entry.id,
        feed_id: entry.feed_id,
        guid: &entry.guid,
        url: entry.url.as_deref(),
        title: &entry.title,
        author: entry.author.as_deref(),
        content_html: entry.content_html.as_deref(),
        published_at: entry.published_at.as_ref(),
        fetched_at: &entry.fetched_at,
        read: entry.read,
        bookmarked: entry.bookmarked,
        tags: &entry.tags,
    })
}

fn serialized_json_size<T: serde::Serialize + ?Sized>(value: &T) -> usize {
    let mut counter = ByteCounter::default();
    serde_json::to_writer(&mut counter, value)
        .expect("serializing a feed entry into an infallible byte counter cannot fail");
    counter.bytes
}

fn serialized_page_size(entries_bytes: usize, next_cursor: Option<&EntryCursor>) -> usize {
    let cursor_bytes = next_cursor
        .map(EntryCursor::encode)
        .as_ref()
        .map_or(4, serialized_json_size);
    r#"{"entries":["#.len() + entries_bytes + r#"],"next_cursor":"#.len() + cursor_bytes + 1
}

fn entry_cursor(entry: &Entry) -> EntryCursor {
    EntryCursor {
        sort_ts: entry.published_at.unwrap_or(entry.fetched_at),
        id: entry.id,
    }
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
    if let (Some(feed_id), 0) = (feed_id, changed) {
        return Err(FeedStoreError::FeedNotFound(feed_id));
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
            (read_at IS NOT NULL AND fetched_at < ?1)
            OR
            (read_at IS NULL AND fetched_at < ?2)
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
    #[cfg(unix)]
    {
        let source = open_snapshot_source(source)?;
        snapshot_database_file(
            &source.directory,
            &source.filename,
            &source.file,
            &source.generation_lock,
            &source.path,
            destination,
        )
    }
    #[cfg(not(unix))]
    {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(source, flags)?;
        snapshot_connection(&connection, destination)
    }
}

#[cfg(unix)]
struct VerifiedSnapshotSource {
    path: PathBuf,
    directory: std::os::fd::OwnedFd,
    filename: std::ffi::OsString,
    file: std::fs::File,
    generation_lock: std::fs::File,
}

#[cfg(unix)]
fn open_snapshot_source(source: &Path) -> Result<VerifiedSnapshotSource, FeedStoreError> {
    use rustix::fs::{FileType, Mode, OFlags, fstat, open, openat};

    let filename = source
        .file_name()
        .ok_or_else(|| FeedStoreError::InvalidPath(source.to_path_buf()))?;
    let parent = source
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(|source_error| FeedStoreError::Io {
        operation: "resolve snapshot source directory",
        path: parent.to_path_buf(),
        source: source_error,
    })?;
    let directory = open(
        &parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|source_error| FeedStoreError::Io {
        operation: "open snapshot source directory without following links",
        path: parent.clone(),
        source: source_error.into(),
    })?;
    let generation_lock = lock_feed_generation_shared(&directory, &parent, filename)?;
    let file = openat(
        &directory,
        filename,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|source_error| FeedStoreError::Io {
        operation: "open snapshot source without following links",
        path: source.to_path_buf(),
        source: source_error.into(),
    })?;
    let metadata = fstat(&file).map_err(|source_error| FeedStoreError::Io {
        operation: "inspect snapshot source",
        path: source.to_path_buf(),
        source: source_error.into(),
    })?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(FeedStoreError::UnsafePath {
            path: source.to_path_buf(),
            expected: "regular snapshot source",
        });
    }
    Ok(VerifiedSnapshotSource {
        path: parent.join(filename),
        directory,
        filename: filename.to_os_string(),
        file: file.into(),
        generation_lock,
    })
}

#[cfg(unix)]
pub(crate) fn snapshot_database_file(
    source_directory: &std::os::fd::OwnedFd,
    source_filename: &std::ffi::OsStr,
    source_file: &std::fs::File,
    _generation_lock: &std::fs::File,
    source_path: &Path,
    destination: &Path,
) -> Result<(), FeedStoreError> {
    verify_retained_file_identity(source_directory, source_filename, source_file, source_path)?;
    #[cfg(test)]
    pause_at_test_path_barrier(&AFTER_SNAPSHOT_SOURCE_OPEN_PATH_RESOLVED, source_path);
    #[cfg(test)]
    pause_at_test_path_barrier(&AFTER_SNAPSHOT_GENERATION_SHARED_LOCKED, source_path);
    let (working_directory, working_path) = create_private_working_copy(
        source_directory,
        source_filename,
        source_file,
        None,
        source_path,
    )?;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(&working_path, flags)?;
    let result = snapshot_connection(&connection, destination);
    drop(working_directory);
    result
}

struct PreparedSnapshotDestination {
    path: PathBuf,
    #[cfg(unix)]
    directory: std::os::fd::OwnedFd,
    #[cfg(unix)]
    filename: std::ffi::OsString,
}

#[cfg(unix)]
fn prepare_snapshot_destination(
    destination: &Path,
) -> Result<PreparedSnapshotDestination, FeedStoreError> {
    use rustix::fs::{Mode, OFlags, open};

    let filename = destination
        .file_name()
        .ok_or_else(|| FeedStoreError::InvalidPath(destination.to_path_buf()))?
        .to_os_string();
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(|source| FeedStoreError::Io {
        operation: "resolve snapshot directory",
        path: parent.to_path_buf(),
        source,
    })?;
    let directory = open(
        &parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|source| FeedStoreError::Io {
        operation: "open snapshot directory without following links",
        path: parent.clone(),
        source: source.into(),
    })?;
    let prepared = PreparedSnapshotDestination {
        path: parent.join(&filename),
        directory,
        filename,
    };
    verify_snapshot_destination_absent(&prepared)?;
    Ok(prepared)
}

#[cfg(unix)]
fn verify_snapshot_destination_absent(
    destination: &PreparedSnapshotDestination,
) -> Result<(), FeedStoreError> {
    use rustix::fs::{AtFlags, statat};
    use rustix::io::Errno;

    match statat(
        &destination.directory,
        &destination.filename,
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Ok(_) => Err(FeedStoreError::UnsafePath {
            path: destination.path.clone(),
            expected: "absent snapshot target",
        }),
        Err(Errno::NOENT) => Ok(()),
        Err(source) => Err(FeedStoreError::Io {
            operation: "inspect snapshot target without following links",
            path: destination.path.clone(),
            source: source.into(),
        }),
    }
}

#[cfg(not(unix))]
fn prepare_snapshot_destination(
    destination: &Path,
) -> Result<PreparedSnapshotDestination, FeedStoreError> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(|source| FeedStoreError::Io {
        operation: "resolve snapshot directory",
        path: parent.to_path_buf(),
        source,
    })?;
    let path = parent.join(
        destination
            .file_name()
            .ok_or_else(|| FeedStoreError::InvalidPath(destination.to_path_buf()))?,
    );
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err(FeedStoreError::UnsafePath {
                path,
                expected: "absent snapshot target",
            });
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(FeedStoreError::Io {
                operation: "inspect snapshot target",
                path,
                source,
            });
        }
    }
    Ok(PreparedSnapshotDestination { path })
}

#[cfg(unix)]
fn publish_private_snapshot(
    source_path: &Path,
    destination: &PreparedSnapshotDestination,
) -> Result<(), FeedStoreError> {
    use rustix::fs::{
        AtFlags, FileType, Mode, OFlags, RenameFlags, fchmod, fstat, fsync, openat, renameat_with,
        statat, unlinkat,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

    verify_snapshot_destination_absent(destination)?;
    let counter = SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_name = format!(".snapshot.publish-{}-{counter}", std::process::id());
    let temporary = openat(
        &destination.directory,
        &temporary_name,
        OFlags::RDWR
            | OFlags::CREATE
            | OFlags::EXCL
            | OFlags::CLOEXEC
            | OFlags::NOFOLLOW
            | OFlags::NONBLOCK,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|source| FeedStoreError::Io {
        operation: "create descriptor-bound snapshot publication",
        path: destination.path.clone(),
        source: source.into(),
    })?;
    if let Err(source) = fchmod(&temporary, Mode::RUSR | Mode::WUSR) {
        let _ = unlinkat(&destination.directory, &temporary_name, AtFlags::empty());
        return Err(FeedStoreError::Io {
            operation: "set owner-only snapshot publication mode",
            path: destination.path.clone(),
            source: source.into(),
        });
    }
    let mut temporary_file = std::fs::File::from(temporary);
    let source_file = match std::fs::File::open(source_path) {
        Ok(file) => file,
        Err(source) => {
            let _ = unlinkat(&destination.directory, &temporary_name, AtFlags::empty());
            return Err(FeedStoreError::Io {
                operation: "open private snapshot publication source",
                path: source_path.to_path_buf(),
                source,
            });
        }
    };
    if let Err(error) = copy_file_contents(
        &source_file,
        &mut temporary_file,
        source_path,
        &destination.path,
    ) {
        let _ = unlinkat(&destination.directory, &temporary_name, AtFlags::empty());
        return Err(error);
    }
    if let Err(source) = renameat_with(
        &destination.directory,
        &temporary_name,
        &destination.directory,
        &destination.filename,
        RenameFlags::NOREPLACE,
    ) {
        let _ = unlinkat(&destination.directory, &temporary_name, AtFlags::empty());
        return Err(FeedStoreError::Io {
            operation: "atomically publish snapshot",
            path: destination.path.clone(),
            source: source.into(),
        });
    }
    fsync(&destination.directory).map_err(|source| FeedStoreError::Io {
        operation: "sync snapshot directory",
        path: destination.path.clone(),
        source: source.into(),
    })?;
    let metadata = fstat(&temporary_file).map_err(|source| FeedStoreError::Io {
        operation: "inspect completed snapshot",
        path: destination.path.clone(),
        source: source.into(),
    })?;
    let path_metadata = statat(
        &destination.directory,
        &destination.filename,
        AtFlags::SYMLINK_NOFOLLOW,
    )
    .map_err(|source| FeedStoreError::Io {
        operation: "verify completed snapshot identity",
        path: destination.path.clone(),
        source: source.into(),
    })?;
    if metadata.st_dev != path_metadata.st_dev
        || metadata.st_ino != path_metadata.st_ino
        || FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
        || FileType::from_raw_mode(path_metadata.st_mode) != FileType::RegularFile
    {
        return Err(FeedStoreError::UnsafePath {
            path: destination.path.clone(),
            expected: "unchanged regular snapshot file",
        });
    }
    Ok(())
}

#[cfg(not(unix))]
fn finish_snapshot_destination(
    destination: &PreparedSnapshotDestination,
) -> Result<(), FeedStoreError> {
    let metadata =
        std::fs::symlink_metadata(&destination.path).map_err(|source| FeedStoreError::Io {
            operation: "inspect completed snapshot",
            path: destination.path.clone(),
            source,
        })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(FeedStoreError::UnsafePath {
            path: destination.path.clone(),
            expected: "non-symlink regular snapshot file",
        });
    }
    Ok(())
}

fn snapshot_connection(connection: &Connection, destination: &Path) -> Result<(), FeedStoreError> {
    let prepared = prepare_snapshot_destination(destination)?;
    #[cfg(unix)]
    {
        let (_snapshot_directory, snapshot_path) = create_private_snapshot(connection)?;
        #[cfg(test)]
        pause_at_test_path_barrier(&AFTER_SNAPSHOT_PUBLICATION_PATH_RESOLVED, &prepared.path);
        publish_private_snapshot(&snapshot_path, &prepared)
    }
    #[cfg(not(unix))]
    {
        let destination_text = prepared
            .path
            .to_str()
            .ok_or_else(|| FeedStoreError::InvalidPath(prepared.path.clone()))?;
        connection.execute("VACUUM INTO ?1", [destination_text])?;
        finish_snapshot_destination(&prepared)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

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
            fetch_url: "https://fetched.example/feed.xml".to_owned(),
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

    #[cfg(unix)]
    #[derive(Debug, PartialEq, Eq)]
    struct DurableDatabaseState {
        main_device: u64,
        main_inode: u64,
        main_bytes: Vec<u8>,
        wal_bytes: Option<Vec<u8>>,
    }

    #[cfg(unix)]
    fn database_wal_path(database: &Path) -> PathBuf {
        let mut path = database.as_os_str().to_os_string();
        path.push("-wal");
        PathBuf::from(path)
    }

    #[cfg(unix)]
    fn durable_database_state(database: &Path) -> DurableDatabaseState {
        use std::os::unix::fs::MetadataExt;

        let metadata = fs::metadata(database).unwrap();
        let wal = database_wal_path(database);
        DurableDatabaseState {
            main_device: metadata.dev(),
            main_inode: metadata.ino(),
            main_bytes: fs::read(database).unwrap(),
            wal_bytes: wal.exists().then(|| fs::read(wal).unwrap()),
        }
    }

    #[cfg(unix)]
    struct IncrementalWalTestControls {
        path: PathBuf,
        prior: Option<super::IncrementalWalTestControl>,
    }

    #[cfg(unix)]
    impl IncrementalWalTestControls {
        fn install(
            database: &Path,
            checkpoint_bytes: u64,
            fail_after_append: bool,
            fail_after_checkpoint_rename: bool,
        ) -> Self {
            let path = super::normalize_test_barrier_path(database);
            let prior = super::INCREMENTAL_WAL_TEST_CONTROLS.lock().insert(
                path.clone(),
                super::IncrementalWalTestControl {
                    checkpoint_bytes,
                    fail_after_append,
                    fail_after_checkpoint_rename,
                },
            );
            Self { path, prior }
        }
    }

    #[cfg(unix)]
    impl Drop for IncrementalWalTestControls {
        fn drop(&mut self) {
            let mut controls = super::INCREMENTAL_WAL_TEST_CONTROLS.lock();
            if let Some(prior) = self.prior {
                controls.insert(self.path.clone(), prior);
            } else {
                controls.remove(&self.path);
            }
        }
    }

    #[cfg(unix)]
    async fn store_with_one_entry() -> (FeedStoreHandle, TempDir, Entry) {
        let (store, temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://incremental.example/feed", "News", &[]),
        )
        .await;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fetched_entry(
                        "incremental-entry",
                        Some(ts("2026-08-09T10:00:00Z")),
                    )],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let entry = entries_by_guid(&store)
            .await
            .remove("incremental-entry")
            .unwrap();
        (store, temp, entry)
    }

    #[cfg(unix)]
    #[serial_test::serial]
    #[tokio::test]
    async fn small_patch_appends_durable_wal_without_replacing_public_main_database() {
        let (store, temp, entry) = store_with_one_entry().await;
        let database = temp.path().join("feeds.db");
        let _controls = IncrementalWalTestControls::install(&database, u64::MAX, false, false);
        let before = durable_database_state(&database);

        let patched = store
            .patch_entry(
                entry.id,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();
        assert!(patched.bookmarked);

        let after = durable_database_state(&database);
        assert_eq!(after.main_device, before.main_device);
        assert_eq!(after.main_inode, before.main_inode);
        assert_eq!(after.main_bytes, before.main_bytes);
        let before_wal = before.wal_bytes.as_deref().unwrap_or_default();
        let after_wal = after
            .wal_bytes
            .as_deref()
            .expect("successful patch must durably publish WAL bytes");
        assert!(after_wal.starts_with(before_wal));
        assert!(after_wal.len() > before_wal.len());

        drop(store);
        let reopened = FeedStoreHandle::open(&database).unwrap();
        let saved = reopened
            .list_entries(filters(EntryView::Saved))
            .await
            .unwrap();
        assert_eq!(saved.entries, vec![patched]);
    }

    #[cfg(unix)]
    #[serial_test::serial]
    #[tokio::test]
    async fn failed_wal_publication_restores_live_and_reopened_state_to_exact_baseline() {
        let (store, temp, entry) = store_with_one_entry().await;
        let database = temp.path().join("feeds.db");
        let baseline_entries = store.list_entries(filters(EntryView::All)).await.unwrap();
        let baseline_files = durable_database_state(&database);
        let _controls = IncrementalWalTestControls::install(&database, u64::MAX, true, false);

        let result = store
            .patch_entry(
                entry.id,
                EntryPatch {
                    read: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await;

        assert!(
            result.is_err(),
            "injected WAL publication failure was ignored"
        );
        assert_eq!(
            store.list_entries(filters(EntryView::All)).await.unwrap(),
            baseline_entries
        );
        assert_eq!(durable_database_state(&database), baseline_files);

        drop(store);
        let reopened = FeedStoreHandle::open(&database).unwrap();
        assert_eq!(
            reopened
                .list_entries(filters(EntryView::All))
                .await
                .unwrap(),
            baseline_entries
        );
    }

    #[cfg(unix)]
    #[serial_test::serial]
    #[tokio::test]
    async fn checkpoint_failure_after_main_rename_reopens_complete_new_state_with_old_wal() {
        let (store, temp, entry) = store_with_one_entry().await;
        let database = temp.path().join("feeds.db");
        let _controls = IncrementalWalTestControls::install(&database, 1, false, true);

        let patched = store
            .patch_entry(
                entry.id,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .expect("durable WAL append makes the mutation successful");
        assert!(patched.bookmarked);
        drop(store);

        let public_wal = database_wal_path(&database);
        assert!(
            fs::metadata(&public_wal).unwrap().len() > 0,
            "old WAL was removed before checkpointed main rename was crash-safe"
        );
        let reopened = FeedStoreHandle::open(&database).unwrap();
        let entries = reopened
            .list_entries(filters(EntryView::All))
            .await
            .unwrap()
            .entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, entry.id);
        assert!(entries[0].bookmarked);
    }

    #[cfg(unix)]
    #[serial_test::serial]
    #[tokio::test]
    async fn unchanged_reconcile_does_not_grow_wal_or_publish_database_files() {
        let (store, temp) = open_test_store().await;
        let database = temp.path().join("feeds.db");
        let feed = manifest_feed("https://unchanged.example/feed", "News", &["daily"]);
        add_feed(&store, feed.clone()).await;
        let _controls = IncrementalWalTestControls::install(&database, u64::MAX, false, false);
        let before = durable_database_state(&database);

        store.reconcile(vec![feed]).await.unwrap();

        assert_eq!(durable_database_state(&database), before);
    }

    #[cfg(unix)]
    #[test]
    fn feed_database_writer_lock_is_exclusive_nonblocking_and_released_with_worker() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("feeds.db");
        let first = FeedStoreHandle::open(&database).unwrap();

        for filename in [".feeds.db.writer.lock", ".feeds.db.generation.lock"] {
            let metadata = fs::symlink_metadata(temp.path().join(filename)).unwrap();
            assert!(metadata.file_type().is_file());
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        }

        let started = std::time::Instant::now();
        let error = match FeedStoreHandle::open(&database) {
            Ok(second) => {
                drop(second);
                panic!("second feed-store writer opened the same database")
            }
            Err(error) => error,
        };
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "writer ownership acquisition blocked instead of failing"
        );
        assert!(
            error.to_string().contains("already open"),
            "writer ownership failure was not clear: {error}"
        );

        drop(first);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let reopened = loop {
            match FeedStoreHandle::open(&database) {
                Ok(store) => break store,
                Err(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("writer lock was not released with worker: {error}"),
            }
        };
        drop(reopened);
    }

    #[cfg(unix)]
    #[serial_test::serial]
    #[tokio::test]
    async fn path_snapshot_holds_one_generation_while_forced_checkpoint_publisher_waits() {
        let (store, temp, entry) = store_with_one_entry().await;
        let database = temp.path().join("feeds.db");
        let destination = temp.path().join("generation-snapshot.db");
        let _controls = IncrementalWalTestControls::install(&database, 1, false, false);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        super::install_after_snapshot_generation_shared_locked_barrier(
            database.canonicalize().unwrap(),
            barrier.clone(),
        );

        let snapshot_database_path = database.clone();
        let snapshot_destination = destination.clone();
        let snapshotter = std::thread::spawn(move || {
            super::snapshot_database(&snapshot_database_path, &snapshot_destination)
        });
        barrier.wait();

        let patch_store = store.clone();
        let mut publisher = tokio::spawn(async move {
            patch_store
                .patch_entry(
                    entry.id,
                    EntryPatch {
                        bookmarked: Some(true),
                        ..EntryPatch::default()
                    },
                )
                .await
        });
        let completed_while_snapshot_locked =
            tokio::time::timeout(std::time::Duration::from_secs(1), &mut publisher)
                .await
                .ok();

        barrier.wait();
        snapshotter.join().unwrap().unwrap();
        assert!(
            completed_while_snapshot_locked.is_none(),
            "checkpoint publisher did not wait for the snapshot generation reader"
        );
        let patched = publisher.await.unwrap().unwrap();
        assert!(patched.bookmarked);

        let snapshot = Connection::open(&destination).unwrap();
        let snapshot_bookmarked: bool = snapshot
            .query_row(
                "SELECT bookmarked_at IS NOT NULL FROM entry WHERE id = ?1",
                [patched.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !snapshot_bookmarked,
            "snapshot mixed the post-checkpoint entry state into its locked old generation"
        );
        drop(snapshot);

        drop(store);
        let reopen_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let reopened = loop {
            match FeedStoreHandle::open(&database) {
                Ok(store) => break store,
                Err(_) if std::time::Instant::now() < reopen_deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("writer lock was not released for semantic reopen: {error}"),
            }
        };
        let reopened_entry = reopened
            .list_entries(filters(EntryView::All))
            .await
            .unwrap()
            .entries
            .into_iter()
            .find(|candidate| candidate.id == patched.id)
            .unwrap();
        assert!(reopened_entry.bookmarked);
    }

    fn persisted_entry_count(path: &Path) -> i64 {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM entry", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn ingestion_and_retention_limits_match_the_approved_hard_caps() {
        assert_eq!(super::MAX_ENTRY_PAGE_BYTES, 8 * 1_048_576);
        assert_eq!(super::MAX_RETAINED_ENTRIES_PER_FEED, 5_000);
        assert_eq!(super::MAX_RETAINED_CONTENT_BYTES_PER_FEED, 128 * 1_048_576);
        assert_eq!(super::MAX_RETAINED_ENTRIES_GLOBAL, 50_000);
        assert_eq!(super::MAX_RETAINED_CONTENT_BYTES_GLOBAL, 1_024 * 1_048_576);
    }

    fn assert_store_open_rejected(path: &Path) {
        if let Ok(store) = FeedStoreHandle::open(path) {
            drop(store);
            panic!("feed store accepted untrusted path `{}`", path.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn startup_rejects_symlinked_or_non_directory_metadata_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let metadata = vault.join(".clepsydra");
        let database = metadata.join("feeds.db");

        fs::write(&metadata, "not a directory").unwrap();
        assert_store_open_rejected(&database);
        fs::remove_file(&metadata).unwrap();

        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, &metadata).unwrap();
        assert_store_open_rejected(&database);
        assert!(
            !outside.join("feeds.db").exists(),
            "startup followed `.clepsydra` and created an external database"
        );
    }

    #[cfg(unix)]
    #[test]
    fn startup_rejects_symlinked_or_non_regular_database() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let metadata = temp.path().join(".clepsydra");
        fs::create_dir(&metadata).unwrap();
        let database = metadata.join("feeds.db");

        fs::create_dir(&database).unwrap();
        assert_store_open_rejected(&database);
        fs::remove_dir(&database).unwrap();

        let readable_target = temp.path().join("readable.db");
        let target = Connection::open(&readable_target).unwrap();
        target
            .execute_batch(
                "
                CREATE TABLE external_sentinel (
                    value TEXT NOT NULL
                );
                INSERT INTO external_sentinel (value) VALUES ('outside');
                ",
            )
            .unwrap();
        drop(target);
        symlink(&readable_target, &database).unwrap();

        assert_store_open_rejected(&database);
    }

    #[cfg(unix)]
    #[test]
    fn startup_rejects_dangling_database_symlink_without_creating_its_writable_target() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let metadata = temp.path().join(".clepsydra");
        fs::create_dir(&metadata).unwrap();
        let writable_target = temp.path().join("outside-created.db");
        let database = metadata.join("feeds.db");
        symlink(&writable_target, &database).unwrap();

        assert_store_open_rejected(&database);
        assert!(
            !writable_target.exists(),
            "startup followed a dangling link and created its target"
        );
    }

    #[cfg(unix)]
    #[test]
    fn newly_created_feed_storage_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let metadata = temp.path().join(".clepsydra");
        let database = metadata.join("feeds.db");

        let store = FeedStoreHandle::open(&database).unwrap();

        assert_eq!(
            fs::metadata(&metadata).unwrap().permissions().mode() & 0o777,
            0o700,
            "feed metadata directory must be owner-only"
        );
        assert_eq!(
            fs::metadata(&database).unwrap().permissions().mode() & 0o777,
            0o600,
            "feed database must be owner-only from first publication"
        );
        drop(store);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_opens_the_verified_regular_database_identity_after_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let metadata = vault.join(".clepsydra");
        let database = metadata.join("feeds.db");
        let trusted_store = FeedStoreHandle::open(&database).unwrap();
        add_feed(
            &trusted_store,
            manifest_feed("https://trusted.example/feed", "Trusted", &[]),
        )
        .await;
        drop(trusted_store);

        let replacement_metadata = vault.join("replacement-metadata");
        fs::create_dir(&replacement_metadata).unwrap();
        let replacement_store =
            FeedStoreHandle::open(&replacement_metadata.join("feeds.db")).unwrap();
        add_feed(
            &replacement_store,
            manifest_feed("https://attacker.example/feed", "Attacker", &[]),
        )
        .await;
        drop(replacement_store);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let verified_database_path = database.canonicalize().unwrap();
        super::install_after_database_open_path_resolved_barrier(
            verified_database_path,
            barrier.clone(),
        );
        let database_for_open = database.clone();
        let opener = std::thread::spawn(move || FeedStoreHandle::open(&database_for_open));

        barrier.wait();
        let displaced_metadata = vault.join("verified-metadata");
        fs::rename(&metadata, &displaced_metadata).unwrap();
        fs::rename(&replacement_metadata, &metadata).unwrap();
        barrier.wait();

        let opened = opener.join().unwrap().unwrap();
        let urls = opened
            .list_feeds()
            .await
            .unwrap()
            .into_iter()
            .map(|feed| feed.url)
            .collect::<Vec<_>>();
        assert_eq!(urls, vec!["https://trusted.example/feed"]);
        opened
            .reconcile(vec![
                manifest_feed("https://trusted.example/feed", "Trusted", &[]),
                manifest_feed("https://written.example/feed", "Written", &[]),
            ])
            .await
            .unwrap();
        drop(opened);

        let read_urls = |path: &Path| {
            let connection = Connection::open(path).unwrap();
            let mut statement = connection
                .prepare("SELECT url FROM feed ORDER BY url")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            read_urls(&displaced_metadata.join("feeds.db")),
            vec![
                "https://trusted.example/feed",
                "https://written.example/feed"
            ],
            "startup writes did not stay on the originally verified database inode"
        );
        assert_eq!(
            read_urls(&metadata.join("feeds.db")),
            vec!["https://attacker.example/feed"],
            "startup mutated the replacement database"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn worker_snapshot_uses_the_stable_open_database_identity() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let live_directory = temp.path().join("live");
        fs::create_dir(&live_directory).unwrap();
        let live_database = live_directory.join("feeds.db");
        let store = FeedStoreHandle::open(&live_database).unwrap();
        add_feed(
            &store,
            manifest_feed("https://trusted.example/feed", "Trusted", &[]),
        )
        .await;

        let attacker_directory = temp.path().join("attacker");
        fs::create_dir(&attacker_directory).unwrap();
        let attacker_store = FeedStoreHandle::open(&attacker_directory.join("feeds.db")).unwrap();
        add_feed(
            &attacker_store,
            manifest_feed("https://attacker.example/feed", "Attacker", &[]),
        )
        .await;
        drop(attacker_store);

        let displaced_directory = temp.path().join("displaced-live");
        fs::rename(&live_directory, &displaced_directory).unwrap();
        symlink(&attacker_directory, &live_directory).unwrap();

        let snapshot = temp.path().join("snapshot.db");
        store.snapshot_to(snapshot.clone()).await.unwrap();
        let snapshot = Connection::open(snapshot).unwrap();
        let mut statement = snapshot
            .prepare("SELECT url FROM feed ORDER BY url")
            .unwrap();
        let urls = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(urls, vec!["https://trusted.example/feed"]);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_destination_stays_in_verified_parent_when_path_is_replaced_before_vacuum() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.db");
        let connection = Connection::open(&source).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE snapshot_probe (
                    value TEXT NOT NULL
                );
                INSERT INTO snapshot_probe (value) VALUES ('trusted');
                ",
            )
            .unwrap();
        drop(connection);

        let destination_parent = temp.path().join("snapshot-output");
        fs::create_dir(&destination_parent).unwrap();
        let destination = destination_parent.join("snapshot.db");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let verified_destination = destination_parent
            .canonicalize()
            .unwrap()
            .join("snapshot.db");
        super::install_after_snapshot_publication_path_resolved_barrier(
            verified_destination,
            barrier.clone(),
        );
        let source_for_snapshot = source.clone();
        let destination_for_snapshot = destination.clone();
        let snapshotter = std::thread::spawn(move || {
            super::snapshot_database(&source_for_snapshot, &destination_for_snapshot)
        });

        barrier.wait();
        let verified_parent = temp.path().join("verified-snapshot-output");
        fs::rename(&destination_parent, &verified_parent).unwrap();
        fs::create_dir(&destination_parent).unwrap();
        barrier.wait();

        let snapshot_result = snapshotter.join().unwrap();
        assert!(
            !destination.exists(),
            "failed identity publication leaked a snapshot beneath the replacement pathname"
        );
        snapshot_result.unwrap();
        let verified_snapshot = verified_parent.join("snapshot.db");
        assert!(
            verified_snapshot.is_file(),
            "snapshot was not created in the descriptor-verified parent"
        );
        assert!(
            !destination.exists(),
            "snapshot followed the replacement destination pathname"
        );
        use std::os::unix::fs::PermissionsExt;

        let snapshot_metadata = fs::symlink_metadata(&verified_snapshot).unwrap();
        assert!(snapshot_metadata.file_type().is_file());
        assert_eq!(snapshot_metadata.permissions().mode() & 0o777, 0o600);
        let snapshot = Connection::open(verified_snapshot).unwrap();
        let value: String = snapshot
            .query_row("SELECT value FROM snapshot_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "trusted");
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

    fn create_version_two_database(path: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "
                PRAGMA user_version = 2;
                CREATE TABLE feed (
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
                INSERT INTO feed (
                    id, url, title, group_name, tags, subscribed, sort_order, added_at,
                    next_fetch_at
                ) VALUES (
                    42, 'https://v2.example/feed', 'Version two', 'Legacy', '[\"legacy\"]',
                    1, 0, '2026-08-01T00:00:00Z', '2026-08-09T00:00:00Z'
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
                current: 3
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
    async fn version_two_migration_adds_fetch_url_without_changing_manifest_identity() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("feeds.db");
        create_version_two_database(&path);

        let store = FeedStoreHandle::open(&path).unwrap();
        let feed = store.list_feeds().await.unwrap().remove(0);

        assert_eq!(feed.id, 42);
        assert_eq!(feed.url, "https://v2.example/feed");
        assert_eq!(feed.fetch_url, None);
        drop(store);
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let fetch_url_column: i64 = connection
            .query_row(
                "
                SELECT COUNT(*)
                FROM pragma_table_info('feed')
                WHERE name = 'fetch_url' AND type = 'TEXT'
                ",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 3);
        assert_eq!(fetch_url_column, 1);
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
        assert_eq!(version, 3);
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
    async fn refetch_preserves_first_seen_fetched_at_and_known_published_at() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let mut first = fetched_entry("stable-guid", Some(ts("2026-08-09T10:00:00Z")));
        first.fetched_at = ts("2026-08-09T12:00:00Z");
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

        let mut edited = fetched_entry("stable-guid", Some(ts("2026-08-09T10:05:00Z")));
        edited.title = "Edited upstream title".to_owned();
        edited.fetched_at = ts("2026-08-09T12:30:00Z");
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![edited],
                    ts("2026-08-09T12:30:00Z"),
                    ts("2026-08-09T13:00:00Z"),
                ),
            )
            .await
            .unwrap();

        let stored = entries_by_guid(&store).await.remove("stable-guid").unwrap();
        assert_eq!(stored.title, "Edited upstream title");
        assert_eq!(stored.fetched_at, ts("2026-08-09T12:00:00Z"));
        assert_eq!(stored.published_at, Some(ts("2026-08-09T10:00:00Z")));
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

    #[tokio::test]
    async fn entry_page_stays_below_eight_mebibytes_and_returns_a_cursor_when_byte_limited() {
        const MAX_PAGE_BYTES: usize = 8 * 1_048_576;

        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let entries = (0..9)
            .map(|index| {
                let mut entry = fetched_entry(
                    &format!("large-{index}"),
                    Some(ts("2026-08-09T10:00:00Z") + Duration::seconds(index)),
                );
                entry.content_html = Some("x".repeat(1_048_576));
                entry
            })
            .collect();
        store
            .apply_fetch(
                feed_id,
                success(
                    entries,
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();

        let page = store
            .list_entries(EntryFilters {
                limit: 9,
                ..filters(EntryView::All)
            })
            .await
            .unwrap();
        let serialized_entries = page
            .entries
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "id": entry.id,
                    "feed_id": entry.feed_id,
                    "guid": entry.guid,
                    "url": entry.url,
                    "title": entry.title,
                    "author": entry.author,
                    "content_html": entry.content_html,
                    "published_at": entry.published_at,
                    "fetched_at": entry.fetched_at,
                    "read": entry.read,
                    "bookmarked": entry.bookmarked,
                    "tags": entry.tags,
                })
            })
            .collect::<Vec<_>>();
        let payload = serde_json::to_vec(&serde_json::json!({
            "entries": serialized_entries,
            "next_cursor": page.next_cursor.as_ref().map(EntryCursor::encode),
        }))
        .unwrap();

        assert!(payload.len() <= MAX_PAGE_BYTES);
        assert!(page.entries.len() < 9);
        assert!(page.next_cursor.is_some());
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
    async fn canonical_fetch_url_persists_without_replacing_manifest_identity() {
        let (store, temp) = open_test_store().await;
        let manifest_url = "https://redirector.example/subscription";
        let canonical_url = "https://feeds.example/canonical.xml";
        let feed_id = add_feed(&store, manifest_feed(manifest_url, "News", &[])).await;
        store
            .apply_fetch(
                feed_id,
                FetchOutcome::Success {
                    fetched_at: ts("2026-08-09T11:00:00Z"),
                    next_fetch_at: ts("2026-08-09T11:30:00Z"),
                    fetch_url: canonical_url.to_owned(),
                    etag: Some("\"canonical-v1\"".to_owned()),
                    last_modified: None,
                    title: Some("Canonical feed".to_owned()),
                    site_url: Some("https://feeds.example/".to_owned()),
                    entries: Vec::new(),
                },
            )
            .await
            .unwrap();

        store
            .reconcile(vec![manifest_feed(manifest_url, "Renamed group", &[])])
            .await
            .unwrap();
        let stored = store.list_feeds().await.unwrap().remove(0);
        assert_eq!(stored.url, manifest_url);
        assert_eq!(stored.fetch_url.as_deref(), Some(canonical_url));
        assert_eq!(stored.etag.as_deref(), Some("\"canonical-v1\""));

        drop(store);
        let reopened = FeedStoreHandle::open(&temp.path().join("feeds.db")).unwrap();
        let stored = reopened.list_feeds().await.unwrap().remove(0);
        assert_eq!(stored.url, manifest_url);
        assert_eq!(stored.fetch_url.as_deref(), Some(canonical_url));
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
    async fn future_publisher_timestamp_cannot_bypass_retention() {
        let (store, _temp) = open_test_store().await;
        let now = ts("2026-08-09T12:00:00Z");
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let mut entry = fetched_entry("future-dated", Some(ts("2126-08-09T12:00:00Z")));
        entry.fetched_at = now - Duration::days(91);
        store
            .apply_fetch(
                feed_id,
                success(vec![entry], now, now + Duration::minutes(30)),
            )
            .await
            .unwrap();

        let removed = store.prune(now, 30, 90).await.unwrap();

        assert_eq!(removed, 1);
        assert!(!entries_by_guid(&store).await.contains_key("future-dated"));
    }

    #[tokio::test]
    async fn retained_entries_are_capped_per_feed_for_fresh_guid_growth() {
        let (store, temp) = open_test_store().await;
        let path = temp.path().join("feeds.db");
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        store.seed_entries(vec![feed_id], 5_000).await.unwrap();
        let fresh = fetched_entry("fresh-guid", Some(ts("2026-08-09T11:00:00Z")));

        store
            .apply_fetch(
                feed_id,
                success(
                    vec![fresh],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();

        assert_eq!(persisted_entry_count(&path), 5_000);
        let fresh_count: i64 = Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM entry WHERE feed_id = ?1 AND guid = 'fresh-guid'",
                [feed_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fresh_count, 1);
    }

    #[tokio::test]
    async fn retained_entries_are_capped_globally_for_fresh_guid_growth() {
        let (store, temp) = open_test_store().await;
        let path = temp.path().join("feeds.db");
        store
            .reconcile(
                (0..11)
                    .map(|index| {
                        manifest_feed(&format!("https://feed-{index}.example/rss"), "News", &[])
                    })
                    .collect(),
            )
            .await
            .unwrap();
        let feed_ids = store
            .list_feeds()
            .await
            .unwrap()
            .into_iter()
            .map(|feed| feed.id)
            .collect::<Vec<_>>();
        store
            .seed_entries(feed_ids[..10].to_vec(), 5_000)
            .await
            .unwrap();
        let fresh_feed_id = feed_ids[10];

        store
            .apply_fetch(
                fresh_feed_id,
                success(
                    vec![fetched_entry(
                        "global-fresh-guid",
                        Some(ts("2026-08-09T11:00:00Z")),
                    )],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();

        assert_eq!(persisted_entry_count(&path), 50_000);
        let fresh_count: i64 = Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM entry WHERE feed_id = ?1 AND guid = 'global-fresh-guid'",
                [fresh_feed_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fresh_count, 1);
    }

    #[tokio::test]
    async fn per_feed_count_quota_keeps_bookmarks_outside_the_publisher_budget() {
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
                        fetched_entry("bookmarked-oldest", None),
                        fetched_entry("unbookmarked-evicted", None),
                        fetched_entry("unbookmarked-old", None),
                        fetched_entry("unbookmarked-fresh", None),
                    ],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let bookmarked = entries_by_guid(&store).await["bookmarked-oldest"].id;
        store
            .patch_entry(
                bookmarked,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();

        store
            .apply_retention_quotas(
                feed_id,
                super::RetentionQuotaLimits {
                    per_feed_entries: 2,
                    per_feed_content_bytes: 1_024,
                    global_entries: 100,
                    global_content_bytes: 1_024,
                },
            )
            .await
            .unwrap();

        let retained = entries_by_guid(&store).await;
        assert_eq!(retained.len(), 3);
        assert!(retained["bookmarked-oldest"].bookmarked);
        assert!(!retained.contains_key("unbookmarked-evicted"));
        assert!(retained.contains_key("unbookmarked-old"));
        assert!(retained.contains_key("unbookmarked-fresh"));
    }

    #[tokio::test]
    async fn per_feed_byte_quota_keeps_bookmark_bodies_outside_the_publisher_budget() {
        let (store, _temp) = open_test_store().await;
        let feed_id = add_feed(
            &store,
            manifest_feed("https://one.example/feed", "News", &[]),
        )
        .await;
        let mut bookmarked = fetched_entry("bookmarked-body", None);
        bookmarked.content_html = Some("mark".to_owned());
        let mut evicted = fetched_entry("unbookmarked-body-evicted", None);
        evicted.content_html = Some("gone".to_owned());
        let mut unbookmarked = fetched_entry("unbookmarked-body-retained", None);
        unbookmarked.content_html = Some("body".to_owned());
        let mut fresh = fetched_entry("fresh-without-body", None);
        fresh.content_html = None;
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![bookmarked, evicted, unbookmarked, fresh],
                    ts("2026-08-09T12:00:00Z"),
                    ts("2026-08-09T12:30:00Z"),
                ),
            )
            .await
            .unwrap();
        let bookmarked = entries_by_guid(&store).await["bookmarked-body"].id;
        store
            .patch_entry(
                bookmarked,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();

        store
            .apply_retention_quotas(
                feed_id,
                super::RetentionQuotaLimits {
                    per_feed_entries: 100,
                    per_feed_content_bytes: 4,
                    global_entries: 100,
                    global_content_bytes: 1_024,
                },
            )
            .await
            .unwrap();

        let retained = entries_by_guid(&store).await;
        assert_eq!(retained.len(), 3);
        assert!(retained["bookmarked-body"].bookmarked);
        assert_eq!(
            retained["unbookmarked-body-retained"]
                .content_html
                .as_deref(),
            Some("body")
        );
        assert!(!retained.contains_key("unbookmarked-body-evicted"));
        assert!(retained.contains_key("fresh-without-body"));
    }

    #[tokio::test]
    async fn global_count_quota_cannot_evict_an_unrelated_feed_bookmark() {
        let (store, _temp) = open_test_store().await;
        store
            .reconcile(vec![
                manifest_feed("https://bookmarks.example/feed", "News", &[]),
                manifest_feed("https://old.example/feed", "News", &[]),
                manifest_feed("https://victim.example/feed", "News", &[]),
                manifest_feed("https://attacker.example/feed", "News", &[]),
            ])
            .await
            .unwrap();
        let feed_ids = store
            .list_feeds()
            .await
            .unwrap()
            .into_iter()
            .map(|feed| feed.id)
            .collect::<Vec<_>>();
        for (feed_id, guid) in feed_ids.iter().copied().zip([
            "unrelated-bookmark",
            "unbookmarked-evicted",
            "unbookmarked-old",
            "attacker-fresh",
        ]) {
            store
                .apply_fetch(
                    feed_id,
                    success(
                        vec![fetched_entry(guid, None)],
                        ts("2026-08-09T12:00:00Z"),
                        ts("2026-08-09T12:30:00Z"),
                    ),
                )
                .await
                .unwrap();
        }
        let bookmarked = entries_by_guid(&store).await["unrelated-bookmark"].id;
        store
            .patch_entry(
                bookmarked,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();

        store
            .apply_retention_quotas(
                feed_ids[3],
                super::RetentionQuotaLimits {
                    per_feed_entries: 100,
                    per_feed_content_bytes: 1_024,
                    global_entries: 2,
                    global_content_bytes: 1_024,
                },
            )
            .await
            .unwrap();

        let retained = entries_by_guid(&store).await;
        assert_eq!(retained.len(), 3);
        assert!(retained["unrelated-bookmark"].bookmarked);
        assert!(!retained.contains_key("unbookmarked-evicted"));
        assert!(retained.contains_key("unbookmarked-old"));
        assert!(retained.contains_key("attacker-fresh"));
    }

    #[tokio::test]
    async fn global_byte_quota_cannot_charge_an_unrelated_bookmark_body() {
        let (store, _temp) = open_test_store().await;
        store
            .reconcile(vec![
                manifest_feed("https://bookmarks.example/feed", "News", &[]),
                manifest_feed("https://old.example/feed", "News", &[]),
                manifest_feed("https://victim.example/feed", "News", &[]),
                manifest_feed("https://attacker.example/feed", "News", &[]),
            ])
            .await
            .unwrap();
        let feed_ids = store
            .list_feeds()
            .await
            .unwrap()
            .into_iter()
            .map(|feed| feed.id)
            .collect::<Vec<_>>();
        let mut bookmark = fetched_entry("unrelated-bookmark-body", None);
        bookmark.content_html = Some("mark".to_owned());
        let mut evicted = fetched_entry("unbookmarked-body-evicted", None);
        evicted.content_html = Some("gone".to_owned());
        let mut old = fetched_entry("unbookmarked-body-retained", None);
        old.content_html = Some("body".to_owned());
        let mut fresh = fetched_entry("attacker-fresh-without-body", None);
        fresh.content_html = None;
        for (feed_id, entry) in feed_ids
            .iter()
            .copied()
            .zip([bookmark, evicted, old, fresh])
        {
            store
                .apply_fetch(
                    feed_id,
                    success(
                        vec![entry],
                        ts("2026-08-09T12:00:00Z"),
                        ts("2026-08-09T12:30:00Z"),
                    ),
                )
                .await
                .unwrap();
        }
        let bookmarked = entries_by_guid(&store).await["unrelated-bookmark-body"].id;
        store
            .patch_entry(
                bookmarked,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();

        store
            .apply_retention_quotas(
                feed_ids[3],
                super::RetentionQuotaLimits {
                    per_feed_entries: 100,
                    per_feed_content_bytes: 1_024,
                    global_entries: 100,
                    global_content_bytes: 4,
                },
            )
            .await
            .unwrap();

        let retained = entries_by_guid(&store).await;
        assert_eq!(retained.len(), 3);
        assert!(retained["unrelated-bookmark-body"].bookmarked);
        assert_eq!(
            retained["unbookmarked-body-retained"]
                .content_html
                .as_deref(),
            Some("body")
        );
        assert!(!retained.contains_key("unbookmarked-body-evicted"));
        assert!(retained.contains_key("attacker-fresh-without-body"));
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
    #[tokio::test]
    async fn global_counts_follow_upserts_entry_state_and_pruning() {
        let (store, _temp) = open_test_store().await;
        let initial = store.entry_counts().await.unwrap();
        assert_eq!((initial.unread, initial.all, initial.saved), (0, 0, 0));

        let feed_id = add_feed(
            &store,
            manifest_feed("https://counts.example/feed", "Counts", &[]),
        )
        .await;
        let first_fetch_at = ts("2026-08-09T12:00:00Z");
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![
                        fetched_entry("one", Some(ts("2026-08-07T12:00:00Z"))),
                        fetched_entry("two", Some(ts("2026-08-08T12:00:00Z"))),
                    ],
                    first_fetch_at,
                    first_fetch_at + Duration::minutes(30),
                ),
            )
            .await
            .unwrap();
        let after_fetch = store.entry_counts().await.unwrap();
        assert_eq!(
            (after_fetch.unread, after_fetch.all, after_fetch.saved),
            (2, 2, 0)
        );

        let second_fetch_at = ts("2026-08-09T13:00:00Z");
        store
            .apply_fetch(
                feed_id,
                success(
                    vec![
                        fetched_entry("one", Some(ts("2026-08-07T12:00:00Z"))),
                        fetched_entry("three", Some(ts("2026-08-09T11:00:00Z"))),
                    ],
                    second_fetch_at,
                    second_fetch_at + Duration::minutes(30),
                ),
            )
            .await
            .unwrap();
        let after_upsert = store.entry_counts().await.unwrap();
        assert_eq!(
            (after_upsert.unread, after_upsert.all, after_upsert.saved),
            (3, 3, 0),
            "updating one GUID and inserting another must not double-count the upsert"
        );

        let entries = entries_by_guid(&store).await;
        store
            .patch_entry(
                entries["one"].id,
                EntryPatch {
                    read: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();
        let after_read = store.entry_counts().await.unwrap();
        assert_eq!(
            (after_read.unread, after_read.all, after_read.saved),
            (2, 3, 0)
        );

        store
            .patch_entry(
                entries["one"].id,
                EntryPatch {
                    read: Some(false),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();
        store
            .patch_entry(
                entries["two"].id,
                EntryPatch {
                    bookmarked: Some(true),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();
        let after_unread_and_bookmark = store.entry_counts().await.unwrap();
        assert_eq!(
            (
                after_unread_and_bookmark.unread,
                after_unread_and_bookmark.all,
                after_unread_and_bookmark.saved,
            ),
            (3, 3, 1)
        );

        assert_eq!(store.mark_read(MarkReadScope::default()).await.unwrap(), 3);
        let after_mark_all_read = store.entry_counts().await.unwrap();
        assert_eq!(
            (
                after_mark_all_read.unread,
                after_mark_all_read.all,
                after_mark_all_read.saved,
            ),
            (0, 3, 1)
        );

        store
            .patch_entry(
                entries["three"].id,
                EntryPatch {
                    read: Some(false),
                    ..EntryPatch::default()
                },
            )
            .await
            .unwrap();
        let after_mark_unread = store.entry_counts().await.unwrap();
        assert_eq!(
            (
                after_mark_unread.unread,
                after_mark_unread.all,
                after_mark_unread.saved,
            ),
            (1, 3, 1)
        );

        assert_eq!(
            store
                .prune(ts("2027-01-09T13:00:00Z"), 30, 90)
                .await
                .unwrap(),
            2
        );
        let after_prune = store.entry_counts().await.unwrap();
        assert_eq!(
            (after_prune.unread, after_prune.all, after_prune.saved),
            (0, 1, 1)
        );
    }
}
