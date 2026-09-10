use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use thiserror::Error;
use tokio::sync::oneshot;
use tokio::task::{JoinError, JoinHandle, JoinSet};

use crate::feeds::fetch::fetch_subscription;
use crate::feeds::runtime::FeedRuntime;

const MANIFEST_PATH: &str = "feeds.md";
const DUE_SWEEP_INTERVAL: StdDuration = StdDuration::from_secs(60);

/// The scheduler's view of the server it runs inside: the feed runtime, the
/// vault root, and a callback invoked after feed storage changes (manifest
/// reconcile or fetch).
#[derive(Clone)]
pub struct FeedHost {
    pub runtime: Arc<FeedRuntime>,
    pub vault_root: PathBuf,
    /// Called after feed storage changed (manifest reconcile or fetch).
    pub on_change: Arc<dyn Fn() + Send + Sync>,
}

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
/// Callers must hold `host.runtime.feed_manifest_lock`. The returned
/// bytes are the exact snapshot that supplied diagnostics and the optional
/// store commit.
/// Public for the workspace split; not part of the stable API.
pub async fn reconcile_feed_manifest_bytes_locked(
    host: &FeedHost,
    bytes: &[u8],
) -> Result<bool, SchedulerError> {
    let runtime = host.runtime.as_ref();
    let path = host.vault_root.join(MANIFEST_PATH);
    let source = String::from_utf8(bytes.to_vec())
        .map_err(|source| SchedulerError::ManifestEncoding { path, source })?;
    let manifest = crate::feeds::manifest::parse(&source);
    #[cfg(any(test, feature = "test-failpoints"))]
    if let Some(hook) = runtime.feed_before_reconcile_commit_hook.lock().clone() {
        hook();
    }
    let is_valid = manifest.warnings.is_empty();
    *runtime.feed_manifest_diagnostics.write() = manifest.warnings;
    if !is_valid {
        return Ok(false);
    }
    runtime.feeds.reconcile(manifest.feeds).await?;
    Ok(true)
}

/// Public for the workspace split; not part of the stable API.
pub async fn reconcile_feed_manifest_locked(
    host: &FeedHost,
) -> Result<(Vec<u8>, bool), SchedulerError> {
    let path = host.vault_root.join(MANIFEST_PATH);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(source) => return Err(SchedulerError::ManifestIo { path, source }),
    };
    let persisted = reconcile_feed_manifest_bytes_locked(host, &bytes).await?;
    Ok((bytes, persisted))
}

/// Reconcile the raw root manifest while serializing the complete snapshot,
/// parse, diagnostics, and store-commit operation with API mutations/lists.
pub async fn reconcile_feed_manifest(host: &FeedHost) -> Result<(), SchedulerError> {
    let _manifest_guard = host.runtime.feed_manifest_lock.lock().await;
    reconcile_feed_manifest_locked(host).await.map(|_| ())
}

/// Public for the workspace split; not part of the stable API.
#[cfg(any(test, feature = "test-failpoints"))]
pub fn set_before_reconcile_commit_hook(
    runtime: &FeedRuntime,
    hook: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    *runtime.feed_before_reconcile_commit_hook.lock() = hook;
}

/// Public for the workspace split; not part of the stable API.
pub async fn run_due_sweep(host: &FeedHost) -> Result<(), SchedulerError> {
    let runtime = host.runtime.as_ref();
    let persisted_reconciliation = {
        let _manifest_guard = runtime.feed_manifest_lock.lock().await;
        let (_, persisted) = reconcile_feed_manifest_locked(host).await?;
        persisted
    };
    if persisted_reconciliation {
        (host.on_change)();
    }
    let now = Utc::now();
    let due = runtime.feeds.due_feeds(now).await?;
    let concurrency = runtime.feed_settings.fetch_concurrency.max(1);
    let interval_minutes = i64::try_from(runtime.feed_settings.fetch_interval_minutes)
        .unwrap_or(i64::MAX / 60)
        .min(i64::MAX / 60);
    let fetch_interval = Duration::minutes(interval_minutes);

    for chunk in due.chunks(concurrency) {
        let mut tasks = JoinSet::new();
        for feed in chunk {
            let client = runtime.feed_client.clone();
            let store = runtime.feeds.clone();
            let feed = feed.clone();
            let max_entry_content_bytes = runtime.feed_settings.max_entry_content_bytes;
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
                Ok(Ok(())) => {
                    (host.on_change)();
                }
                Ok(Err(error)) => tracing::warn!("feed fetch persistence failed: {error}"),
                Err(error) => tracing::warn!("feed fetch task failed: {error}"),
            }
        }
    }

    runtime
        .feeds
        .prune(
            Utc::now(),
            runtime.feed_settings.retention_days,
            runtime.feed_settings.unread_retention_days,
        )
        .await?;
    Ok(())
}

async fn scheduler_loop(host: FeedHost, mut shutdown: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            result = run_due_sweep(&host) => {
                if let Err(error) = result {
                    tracing::warn!("feed scheduler sweep failed: {error}");
                }
            }
        }

        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(DUE_SWEEP_INTERVAL) => {}
            _ = host.runtime.feed_refresh.notified() => {}
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

pub fn spawn_scheduler(host: FeedHost) -> FeedSchedulerGuard {
    let (shutdown, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(scheduler_loop(host, shutdown_rx));
    FeedSchedulerGuard {
        shutdown: Some(shutdown),
        task: Some(task),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{FeedHost, reconcile_feed_manifest};

    /// Proves that `reconcile_feed_manifest` runs against a bare `FeedHost`
    /// with no `AppState` in sight: the scheduler entry point compiles and
    /// reconciles the manifest into feed storage on its own.
    #[tokio::test]
    async fn reconcile_runs_against_a_bare_feed_host() {
        let tmp = tempfile::tempdir().unwrap();
        crate::vault::init::init_vault(tmp.path()).unwrap();
        std::fs::write(
            tmp.path().join("feeds.md"),
            "+++\ntitle = \"Feeds\"\n+++\n\n- [Example](https://example.com/feed.xml)\n",
        )
        .unwrap();
        let runtime = Arc::new(
            crate::feeds::runtime::FeedRuntime::open(tmp.path(), &crate::FeedsSettings::default())
                .unwrap(),
        );
        let host = FeedHost {
            runtime,
            vault_root: tmp.path().to_path_buf(),
            on_change: Arc::new(|| {}),
        };
        reconcile_feed_manifest(&host).await.unwrap();
        assert_eq!(host.runtime.feeds.list_feeds().await.unwrap().len(), 1);
    }
}
