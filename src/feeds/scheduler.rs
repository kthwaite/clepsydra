use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use thiserror::Error;
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle, JoinSet};

use crate::api::AppState;
use crate::feeds::fetch::fetch_subscription;

const MANIFEST_PATH: &str = "feeds.md";
const DUE_SWEEP_INTERVAL: StdDuration = StdDuration::from_secs(60);

#[derive(Debug, Error)]
pub enum SchedulerError {
    #[error("read feed manifest `{path}`: {source}")]
    ManifestIo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("feed manifest `{path}` is not UTF-8: {source}")]
    ManifestEncoding {
        path: PathBuf,
        #[source]
        source: std::string::FromUtf8Error,
    },
    #[error(transparent)]
    Store(#[from] crate::feeds::store::FeedStoreError),
}

/// Reconcile one serialized raw-manifest snapshot into feed storage.
///
/// Callers must hold `state.feed_manifest_lock`. The returned bytes are the
/// exact snapshot that supplied diagnostics and the optional store commit.
pub(crate) async fn reconcile_feed_manifest_bytes_locked(
    state: &AppState,
    bytes: &[u8],
) -> Result<(), SchedulerError> {
    let path = state.vault.root().join(MANIFEST_PATH);
    let source = String::from_utf8(bytes.to_vec())
        .map_err(|source| SchedulerError::ManifestEncoding { path, source })?;
    let manifest = crate::feeds::manifest::parse(&source);
    #[cfg(test)]
    if let Some(hook) = state.feed_before_reconcile_commit_hook.lock().clone() {
        hook();
    }
    let is_valid = manifest.warnings.is_empty();
    *state.feed_manifest_diagnostics.write() = manifest.warnings;
    if is_valid {
        state.feeds.reconcile(manifest.feeds).await?;
    }
    Ok(())
}

pub(crate) async fn reconcile_feed_manifest_locked(
    state: &AppState,
) -> Result<Vec<u8>, SchedulerError> {
    let path = state.vault.root().join(MANIFEST_PATH);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(source) => return Err(SchedulerError::ManifestIo { path, source }),
    };
    reconcile_feed_manifest_bytes_locked(state, &bytes).await?;
    Ok(bytes)
}

/// Reconcile the raw root manifest while serializing the complete snapshot,
/// parse, diagnostics, and store-commit operation with API mutations/lists.
pub async fn reconcile_feed_manifest(state: &AppState) -> Result<(), SchedulerError> {
    let _manifest_guard = state.feed_manifest_lock.lock().await;
    reconcile_feed_manifest_locked(state).await.map(|_| ())
}

#[cfg(test)]
pub(crate) fn set_before_reconcile_commit_hook(
    state: &AppState,
    hook: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    *state.feed_before_reconcile_commit_hook.lock() = hook;
}

async fn run_due_sweep(state: &Arc<AppState>) -> Result<(), SchedulerError> {
    reconcile_feed_manifest(state).await?;

    let now = Utc::now();
    let due = state.feeds.due_feeds(now).await?;
    let concurrency = state.feed_settings.fetch_concurrency.max(1);
    let interval_minutes = i64::try_from(state.feed_settings.fetch_interval_minutes)
        .unwrap_or(i64::MAX / 60)
        .min(i64::MAX / 60);
    let fetch_interval = Duration::minutes(interval_minutes);

    for chunk in due.chunks(concurrency) {
        let mut tasks = JoinSet::new();
        for feed in chunk {
            let client = state.feed_client.clone();
            let store = state.feeds.clone();
            let feed = feed.clone();
            let max_entry_content_bytes = state.feed_settings.max_entry_content_bytes;
            tasks.spawn(async move {
                let outcome = fetch_subscription(
                    &client,
                    &feed,
                    Utc::now(),
                    fetch_interval,
                    max_entry_content_bytes,
                )
                .await;
                store.apply_fetch(feed.id, outcome).await
            });
        }
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!("feed fetch persistence failed: {error}"),
                Err(error) => tracing::warn!("feed fetch task failed: {error}"),
            }
        }
    }

    state
        .feeds
        .prune(
            Utc::now(),
            state.feed_settings.retention_days,
            state.feed_settings.unread_retention_days,
        )
        .await?;
    Ok(())
}

async fn scheduler_loop(state: Arc<AppState>, mut shutdown: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            result = run_due_sweep(&state) => {
                if let Err(error) = result {
                    tracing::warn!("feed scheduler sweep failed: {error}");
                }
            }
        }

        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(DUE_SWEEP_INTERVAL) => {}
            _ = state.feed_refresh.notified() => {}
        }
    }
}

#[derive(Debug, Error)]
#[error("feed scheduler task failed: {0}")]
pub struct SchedulerShutdownError(#[from] JoinError);

/// Owned cancellation and join guard for the feed scheduler.
pub struct FeedSchedulerGuard {
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl FeedSchedulerGuard {
    pub async fn shutdown(mut self) -> Result<(), SchedulerShutdownError> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.await?;
        }
        Ok(())
    }
}

impl Drop for FeedSchedulerGuard {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

pub fn spawn_scheduler(state: Arc<AppState>) -> FeedSchedulerGuard {
    let (shutdown, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(scheduler_loop(state, shutdown_rx));
    FeedSchedulerGuard {
        shutdown: Some(shutdown),
        task: Some(task),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use chrono::{TimeZone, Utc};
    use tempfile::TempDir;

    use super::{reconcile_feed_manifest, spawn_scheduler};
    use crate::api::AppState;
    use crate::feeds::types::FetchOutcome;
    use crate::{FeedsSettings, build_app_state_with_feeds};

    struct SchedulerFixture {
        state: Arc<AppState>,
        _temp: TempDir,
    }

    async fn scheduler_fixture(manifest: &str) -> SchedulerFixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join("feeds.md"), manifest).unwrap();
        let state = build_app_state_with_feeds(&root, &FeedsSettings::default())
            .await
            .unwrap();
        reconcile_feed_manifest(&state).await.unwrap();

        // Keep the deterministic fixture feed outside the due set. A scheduler
        // bug must not turn this local contract test into a network request.
        if let Some(feed) = state.feeds.list_feeds().await.unwrap().first() {
            state
                .feeds
                .apply_fetch(
                    feed.id,
                    FetchOutcome::Failure {
                        fetched_at: Utc.with_ymd_and_hms(2026, 8, 9, 0, 0, 0).unwrap(),
                        next_fetch_at: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                        error: "fixture bookkeeping".to_owned(),
                    },
                )
                .await
                .unwrap();
        }

        SchedulerFixture { state, _temp: temp }
    }

    #[tokio::test]
    async fn refresh_notification_reconciles_before_the_next_timer_tick() {
        let fixture = scheduler_fixture("## Before\n- [Fixture](http://127.0.0.1:9/rss)\n").await;
        let scheduler = spawn_scheduler(Arc::clone(&fixture.state));

        // Allow the scheduler's immediate startup sweep to finish, then require
        // the notifier—not the long periodic interval—to observe this edit.
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(
            fixture.state.vault.root().join("feeds.md"),
            "## After\n- [Fixture](http://127.0.0.1:9/rss)\n",
        )
        .unwrap();
        fixture.state.feed_refresh.notify_one();

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let feeds = fixture.state.feeds.list_feeds().await.unwrap();
                if feeds.len() == 1 && feeds[0].group == "After" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("refresh notification did not wake the scheduler");

        scheduler.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_cancels_and_joins_without_waiting_for_the_next_tick() {
        let fixture = scheduler_fixture("").await;
        let scheduler = spawn_scheduler(Arc::clone(&fixture.state));

        tokio::time::timeout(Duration::from_secs(1), scheduler.shutdown())
            .await
            .expect("scheduler shutdown waited for its periodic tick")
            .unwrap();

        // A joined worker cannot consume later notifications.
        std::fs::write(
            fixture.state.vault.root().join("feeds.md"),
            "## After shutdown\n- https://after.example/rss\n",
        )
        .unwrap();
        fixture.state.feed_refresh.notify_one();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(fixture.state.feeds.list_feeds().await.unwrap().is_empty());
    }
}
