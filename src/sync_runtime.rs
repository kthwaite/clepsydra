//! Server-side git sync runtime: the quiesce window, autocommit cadence,
//! scheduled syncs, and the shutdown push (D10, D11).
//!
//! [`SyncEngine`] is synchronous and knows nothing about the server. This
//! module is the other half: it decides *when* the engine runs, holds the
//! vault still while it does, and repairs the index afterwards. Everything
//! that touches git goes through [`tokio::task::spawn_blocking`]; nothing
//! here blocks the runtime.
//!
//! One sync at a time (`sync_lock`), and while one runs: the mutation gate is
//! held shut, the filesystem watcher is paused, and — when the merge changed
//! the working tree — exactly one full index rebuild, reconcile sweep and SSE
//! follow, rather than one per merged file.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::api::AppState;
use crate::api::events::SyncNotification;
use crate::vault::Vault;
use crate::vault::gitsync::engine::{CommitSummary, SyncEngine, SyncReport, SyncStatus};
use crate::vault::gitsync::git::Git;
use crate::vault::gitsync::{self, SyncError};

/// How long a shutdown may spend committing and pushing before the server
/// gives up and exits anyway (D11).
const SHUTDOWN_PUSH_BUDGET: Duration = Duration::from_secs(30);

/// Drives [`SyncEngine`] on behalf of the running server.
pub struct SyncRuntime {
    engine: Arc<SyncEngine>,
    /// Quiet period after the last vault change before an autocommit fires.
    debounce: Duration,
    /// Scheduled full syncs; `None` when `[sync] interval_secs` is `0`.
    interval: Option<Duration>,
    /// One sync at a time — a full sync, an autocommit and a shutdown push
    /// all queue behind it.
    sync_lock: tokio::sync::Mutex<()>,
    /// Woken by every vault change; the debounce loop waits on it.
    dirty: tokio::sync::Notify,
    /// A change is waiting for its quiet period to elapse.
    pending: AtomicBool,
    /// A full sync is running right now.
    syncing: AtomicBool,
    last: parking_lot::Mutex<Option<SyncReport>>,
}

impl SyncRuntime {
    /// The runtime for `vault`, or `None` when the vault is not
    /// sync-initialised (D3) — including when its root is a git repository
    /// that `clep sync init` has never touched, which is logged so a
    /// surprised operator can see why `clep sync` is refusing.
    pub fn detect(vault: &Vault) -> Option<Arc<Self>> {
        let git = Git::new(vault.root());
        let initialised = match gitsync::is_initialised(vault, &git) {
            Ok(initialised) => initialised,
            Err(error) => {
                tracing::info!(
                    "sync: cannot tell whether {} is sync-initialised ({error}); sync is off",
                    vault.root().display()
                );
                return None;
            }
        };
        if !initialised {
            if matches!(git.toplevel(), Ok(Some(_))) {
                tracing::info!(
                    "sync: {} is a git repository but sync is not initialised; run `clep sync init` to enable it",
                    vault.root().display()
                );
            }
            return None;
        }
        match SyncEngine::open_with_git(vault, git) {
            Ok(engine) => {
                let section = &vault.config().sync;
                Some(Self::with_engine(
                    engine,
                    Duration::from_secs(section.autocommit_debounce_secs),
                    (section.interval_secs > 0).then(|| Duration::from_secs(section.interval_secs)),
                ))
            }
            Err(error) => {
                tracing::warn!(
                    "sync: {} is initialised but unusable: {error}",
                    vault.root().display()
                );
                None
            }
        }
    }

    pub fn with_engine(
        engine: SyncEngine,
        debounce: Duration,
        interval: Option<Duration>,
    ) -> Arc<Self> {
        Arc::new(Self {
            engine: Arc::new(engine),
            debounce,
            interval,
            sync_lock: tokio::sync::Mutex::new(()),
            dirty: tokio::sync::Notify::new(),
            pending: AtomicBool::new(false),
            syncing: AtomicBool::new(false),
            last: parking_lot::Mutex::new(None),
        })
    }

    /// One whole sync inside the quiesce window (D10): commit, fetch, merge,
    /// resolve, push — then, when the tree changed, rebuild the index once.
    pub async fn run_full_sync(&self, state: &AppState) -> Result<SyncReport, SyncError> {
        let _window = self.sync_lock.lock().await;
        self.syncing.store(true, Ordering::SeqCst);
        let result = self.run_full_sync_inner(state).await;
        self.syncing.store(false, Ordering::SeqCst);
        result
    }

    async fn run_full_sync_inner(&self, state: &AppState) -> Result<SyncReport, SyncError> {
        let exclusion = state.mutation_coordinator.exclude_mutations().await;
        state.watcher_paused.store(true, Ordering::SeqCst);

        let engine = Arc::clone(&self.engine);
        let outcome = tokio::task::spawn_blocking(move || engine.full_sync()).await;
        let report = match outcome {
            Ok(Ok(report)) => report,
            Ok(Err(error)) => {
                state.watcher_paused.store(false, Ordering::SeqCst);
                drop(exclusion);
                return Err(error);
            }
            Err(join) => {
                state.watcher_paused.store(false, Ordering::SeqCst);
                drop(exclusion);
                return Err(SyncError::Config(format!("sync task panicked: {join}")));
            }
        };

        if report.tree_changed() {
            rebuild_after_sync(state).await;
        }
        // Whatever was outstanding is in the commit this sync just made.
        self.pending.store(false, Ordering::SeqCst);
        state.watcher_paused.store(false, Ordering::SeqCst);
        drop(exclusion);
        *self.last.lock() = Some(report.clone());
        Ok(report)
    }

    /// Commit what is outstanding, without touching the network. A commit
    /// never changes the working tree, so this holds the mutation gate but
    /// neither pauses the watcher nor rebuilds the index (D10).
    pub async fn autocommit(&self, state: &AppState) -> Result<Option<CommitSummary>, SyncError> {
        let _window = self.sync_lock.lock().await;
        let exclusion = state.mutation_coordinator.exclude_mutations().await;
        let engine = Arc::clone(&self.engine);
        let outcome = tokio::task::spawn_blocking(move || engine.commit_local()).await;
        drop(exclusion);
        let committed = match outcome {
            Ok(result) => result?,
            Err(join) => {
                return Err(SyncError::Config(format!(
                    "autocommit task panicked: {join}"
                )));
            }
        };
        self.pending.store(false, Ordering::SeqCst);
        Ok(committed)
    }

    /// The shutdown path (D11): commit and push under a hard time budget, so
    /// an unreachable remote cannot hold the process open.
    pub async fn shutdown_push(&self, state: &AppState) -> Result<SyncReport, SyncError> {
        let pushed = tokio::time::timeout(SHUTDOWN_PUSH_BUDGET, async {
            let _window = self.sync_lock.lock().await;
            let exclusion = state.mutation_coordinator.exclude_mutations().await;
            let engine = Arc::clone(&self.engine);
            let outcome = tokio::task::spawn_blocking(move || engine.commit_and_push()).await;
            drop(exclusion);
            match outcome {
                Ok(result) => result,
                Err(join) => Err(SyncError::Config(format!(
                    "shutdown push task panicked: {join}"
                ))),
            }
        })
        .await
        .unwrap_or_else(|_| Err(SyncError::Config("shutdown push timed out".to_string())))?;
        *self.last.lock() = Some(pushed.clone());
        Ok(pushed)
    }

    pub async fn status(&self) -> Result<SyncStatus, SyncError> {
        let engine = Arc::clone(&self.engine);
        match tokio::task::spawn_blocking(move || engine.status()).await {
            Ok(result) => result,
            Err(join) => Err(SyncError::Config(format!("status task panicked: {join}"))),
        }
    }

    /// A vault change is waiting for its quiet period to elapse.
    pub fn pending_autocommit(&self) -> bool {
        self.pending.load(Ordering::SeqCst)
    }

    /// A full sync is running right now.
    pub fn syncing(&self) -> bool {
        self.syncing.load(Ordering::SeqCst)
    }

    pub fn last_report(&self) -> Option<SyncReport> {
        self.last.lock().clone()
    }

    /// Start the cadence loops (D11) and hand back their handles; the caller
    /// aborts them when the server stops.
    ///
    /// Three tasks, because listening and debouncing have to run at once: one
    /// marks the vault dirty from the change stream, one commits after the
    /// quiet period, and one (only with `interval_secs > 0`) runs scheduled
    /// full syncs.
    pub fn spawn_background(self: &Arc<Self>, state: Arc<AppState>) -> Vec<JoinHandle<()>> {
        let mut handles = Vec::with_capacity(3);

        let listener = Arc::clone(self);
        let listener_state = Arc::clone(&state);
        handles.push(tokio::spawn(async move {
            let mut rx = listener_state.change_tx.subscribe();
            loop {
                match rx.recv().await {
                    Ok(SyncNotification::IndexChanged { .. })
                    | Ok(SyncNotification::BaseRegistryChanged) => {
                        // A sync's own rebuild notification is not a reason
                        // to commit again.
                        if listener.syncing() {
                            continue;
                        }
                        listener.pending.store(true, Ordering::SeqCst);
                        listener.dirty.notify_one();
                    }
                    // Feed data lives outside the vault tree.
                    Ok(SyncNotification::FeedChanged) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        tracing::debug!(
                            "sync: autocommit listener lagged {missed} notification(s)"
                        );
                        rx = listener_state.change_tx.subscribe();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }));

        let committer = Arc::clone(self);
        let committer_state = Arc::clone(&state);
        handles.push(tokio::spawn(async move {
            loop {
                committer.dirty.notified().await;
                // Extend the quiet period for as long as changes keep coming.
                while tokio::time::timeout(committer.debounce, committer.dirty.notified())
                    .await
                    .is_ok()
                {}
                match committer.autocommit(&committer_state).await {
                    Ok(Some(commit)) => tracing::info!(
                        "sync: autocommitted {} file(s) as {}",
                        commit.files,
                        commit.sha
                    ),
                    Ok(None) => {}
                    Err(error) => tracing::warn!("sync: autocommit failed: {error}"),
                }
            }
        }));

        if let Some(interval) = self.interval {
            let scheduled = Arc::clone(self);
            handles.push(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    match scheduled.run_full_sync(&state).await {
                        Ok(report) => tracing::info!("sync: scheduled sync: {}", report.one_line()),
                        Err(error) => tracing::warn!("sync: scheduled sync failed: {error}"),
                    }
                }
            }));
        }

        handles
    }
}

/// Repair the index after a merge rewrote the working tree: one full build
/// and link resolve, one SSE telling every client to refetch, then the same
/// folder-follows-metadata sweep `serve` runs at startup — pages that arrived
/// from another device can be filed in the wrong folder for their frontmatter
/// just as local ones can.
async fn rebuild_after_sync(state: &AppState) {
    if let Err(error) = crate::api::index_routes::rebuild_index_and_notify(state).await {
        tracing::warn!("sync: index rebuild after merge failed: {error}");
        return;
    }
    if crate::run_startup_reconcile(state).await > 0 {
        // The sweep moved pages after the rebuild's notification went out.
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: vec!["*".to_string()],
            removed: vec![],
        });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use super::*;
    use crate::api::AppState;
    use crate::api::events::SyncNotification;
    use crate::env_test_support::EnvGuard;
    use crate::vault::Vault;
    use crate::vault::gitsync::engine::{PushStatus, SyncEngine};
    use crate::vault::gitsync::testing::{self, TestRepos};
    use crate::vault::path::VaultPath;

    /// Point the whole process at an empty global git config for as long as
    /// the guard lives, so a `Git` built by production code (`Git::new`, as
    /// [`SyncRuntime::detect`] uses) cannot read — or be broken by — the
    /// developer's real `~/.gitconfig`. Callers must be `#[serial]`.
    pub(crate) struct GitEnv {
        _global: EnvGuard,
        _nosystem: EnvGuard,
    }

    pub(crate) fn isolate_git_process_wide() -> GitEnv {
        GitEnv {
            _global: EnvGuard::set("GIT_CONFIG_GLOBAL", testing::empty_global_config()),
            _nosystem: EnvGuard::set("GIT_CONFIG_NOSYSTEM", "1"),
        }
    }

    /// A server state over a sync-initialised vault (`TestRepos`'s clone `a`,
    /// which already carries the D3 marker and a `[sync]` author), with its
    /// [`SyncRuntime`] rebuilt over an isolated [`testing::git`] so the test
    /// never touches the developer's git configuration.
    pub(crate) async fn synced_state() -> (Arc<AppState>, TestRepos) {
        synced_state_with_debounce(Duration::from_secs(300)).await
    }

    pub(crate) async fn synced_state_with_debounce(
        debounce: Duration,
    ) -> (Arc<AppState>, TestRepos) {
        let repos = TestRepos::new();
        // `TestRepos` sets the D3 marker by hand; running `init` over it adds
        // the managed `.gitignore`, so the server's own scratch files
        // (`cache.db`, `feeds.db`, the CAS store) stay out of every commit
        // exactly as they do in a real vault.
        gitsync::init::init(
            &Vault::open(&repos.a).unwrap(),
            &testing::git(&repos.a),
            gitsync::init::InitOpts {
                remote: None,
                author: None,
                lfs: gitsync::init::LfsPolicy::Skip,
                prompt: None,
                legacy_cas: None,
            },
        )
        .unwrap();
        let mut state = crate::build_app_state_with_settings(
            &repos.a,
            &crate::FeedsSettings::default(),
            crate::FeatureFlags::default(),
        )
        .await
        .unwrap();
        let vault = Vault::open(&repos.a).unwrap();
        let engine = SyncEngine::open_with_git(&vault, testing::git(&repos.a)).unwrap();
        Arc::get_mut(&mut state)
            .expect("a freshly built AppState is uniquely owned")
            .sync = Some(SyncRuntime::with_engine(engine, debounce, None));
        (state, repos)
    }

    fn page(id: &str, title: &str) -> String {
        format!("+++\nid = \"{id}\"\ntitle = \"{title}\"\n+++\n")
    }

    /// Wait until a `spawn_background` listener has subscribed to the change
    /// stream, so a notification sent next is actually delivered.
    async fn await_listener(state: &Arc<AppState>) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while state.change_tx.receiver_count() == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the autocommit listener never subscribed"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn detect_is_none_for_plain_vault_and_some_after_init() {
        let _env = isolate_git_process_wide();
        let (state, _tmp) = crate::state_test_support::make_state().await;
        assert!(state.sync.is_none(), "a plain vault has no sync runtime");

        let repos = TestRepos::new();
        let state = crate::build_app_state_with_settings(
            &repos.a,
            &crate::FeedsSettings::default(),
            crate::FeatureFlags::default(),
        )
        .await
        .unwrap();
        assert!(
            state.sync.is_some(),
            "a sync-initialised vault gets a sync runtime"
        );
    }

    #[tokio::test]
    async fn run_full_sync_commits_pulls_reindexes_and_notifies() {
        let (state, repos) = synced_state().await;

        // Device B publishes a page first.
        testing::write(
            &repos.b,
            "notes/from-b.md",
            &page("0192b6c0-0000-7000-8000-0000000000b1", "From B"),
        );
        SyncEngine::open_with_git(&Vault::open(&repos.b).unwrap(), testing::git(&repos.b))
            .unwrap()
            .full_sync()
            .unwrap();

        let mut rx = state.change_tx.subscribe();
        testing::write(
            &repos.a,
            "notes/local.md",
            &page("0192b6c0-0000-7000-8000-0000000000a1", "Local"),
        );

        let report = state
            .sync
            .as_ref()
            .unwrap()
            .run_full_sync(&state)
            .await
            .unwrap();

        assert!(report.committed.is_some(), "the local page is committed");
        assert!(report.tree_changed(), "the merge brought B's page in");
        assert!(repos.a.join("notes/from-b.md").is_file());

        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("no SSE within 5s of a tree-changing sync")
            .unwrap();
        assert!(
            matches!(event, SyncNotification::IndexChanged { ref upserted, .. } if upserted == &["*".to_string()]),
            "{event:?}"
        );

        let found = state
            .index
            .with_index(|index, _| {
                index
                    .connection()
                    .query_row(
                        "SELECT 1 FROM pages WHERE path = ?1",
                        ["notes/from-b.md"],
                        |_| Ok(()),
                    )
                    .is_ok()
            })
            .await
            .unwrap();
        assert!(found, "the pulled page is indexed");
        assert!(
            !state.watcher_paused.load(Ordering::SeqCst),
            "the watcher is un-paused when the window closes"
        );
        assert!(state.sync.as_ref().unwrap().last_report().is_some());
    }

    /// The gate `run_full_sync` holds for the whole sync window: while it is
    /// taken, a new mutation waits instead of writing into a merging tree.
    #[tokio::test]
    async fn mutations_wait_for_the_sync_window() {
        let (state, _repos) = synced_state().await;
        let exclusion = state.mutation_coordinator.exclude_mutations().await;

        let mutating = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                state
                    .mutation_coordinator
                    .lock_paths(&[VaultPath::new("x.md").unwrap()])
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !mutating.is_finished(),
            "the gate blocks new mutations while the sync window is held"
        );

        drop(exclusion);
        tokio::time::timeout(Duration::from_secs(5), mutating)
            .await
            .expect("the mutation did not proceed within 5s of the window closing")
            .unwrap();
    }

    #[tokio::test]
    async fn autocommit_marks_pending_on_an_index_change() {
        // A debounce long enough that the commit itself cannot fire first.
        let (state, repos) = synced_state_with_debounce(Duration::from_secs(600)).await;
        let runtime = Arc::clone(state.sync.as_ref().unwrap());
        let handles = runtime.spawn_background(Arc::clone(&state));
        let before = testing::git(&repos.a).log_count().unwrap();

        std::fs::write(
            repos.a.join("auto.md"),
            page("0192b6c0-0000-7000-8000-0000000000c1", "Auto"),
        )
        .unwrap();
        // The listener subscribes inside its own task; a broadcast send with
        // no receivers yet would be dropped on the floor.
        await_listener(&state).await;
        state
            .change_tx
            .send(SyncNotification::IndexChanged {
                upserted: vec!["auto.md".into()],
                removed: vec![],
            })
            .unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !runtime.pending_autocommit() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "an index change did not mark an autocommit pending"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            testing::git(&repos.a).log_count().unwrap(),
            before,
            "nothing is committed before the quiet period elapses"
        );
        for handle in handles {
            handle.abort();
        }
    }

    #[tokio::test]
    async fn autocommit_fires_after_quiet_period() {
        let (state, repos) = synced_state_with_debounce(Duration::from_millis(200)).await;
        let runtime = Arc::clone(state.sync.as_ref().unwrap());
        let handles = runtime.spawn_background(Arc::clone(&state));
        let before = testing::git(&repos.a).log_count().unwrap();

        std::fs::write(
            repos.a.join("auto.md"),
            page("0192b6c0-0000-7000-8000-0000000000c1", "Auto"),
        )
        .unwrap();
        // The listener subscribes inside its own task; a broadcast send with
        // no receivers yet would be dropped on the floor.
        await_listener(&state).await;
        state
            .change_tx
            .send(SyncNotification::IndexChanged {
                upserted: vec!["auto.md".into()],
                removed: vec![],
            })
            .unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while testing::git(&repos.a).log_count().unwrap() == before {
            assert!(
                tokio::time::Instant::now() < deadline,
                "autocommit did not fire"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // `pending` is cleared once the commit that covers the change is in,
        // which is a moment after the commit object itself exists.
        while runtime.pending_autocommit() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the autocommit stayed marked pending after committing"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        for handle in handles {
            handle.abort();
        }
    }

    #[tokio::test]
    async fn shutdown_push_commits_and_pushes() {
        let (state, repos) = synced_state().await;
        std::fs::write(
            repos.a.join("bye.md"),
            page("0192b6c0-0000-7000-8000-0000000000d1", "Bye"),
        )
        .unwrap();

        let report = state
            .sync
            .as_ref()
            .unwrap()
            .shutdown_push(&state)
            .await
            .unwrap();
        assert!(matches!(report.push, PushStatus::Pushed), "{report:?}");

        let b = testing::git(&repos.b);
        b.fetch("origin", "main").unwrap();
        assert_eq!(
            b.ahead_behind("origin/main")
                .unwrap()
                .map(|(_, behind)| behind > 0),
            Some(true),
            "the pushed commit is visible to the other clone"
        );
    }
}
