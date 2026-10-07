//! The filesystem watcher's batch pipeline: drain queued change events into
//! one batch, index it, report what changed, then reconcile the upserted
//! pages' folders (ADR 0001 layer 2).
//!
//! The server owns the watcher and the notification channel; it plugs both
//! in through [`WatchHost`] and spawns [`run_watch_loop`].

use std::sync::Arc;

use clep_index::hooks::PostMoveHook;
use clep_index::index_handle::IndexHandle;
use clep_index::sync::ChangeEvent;
use clep_vault::Vault;
use clep_vault::path::VaultPath;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::mutation_coordinator::MutationCoordinator;
use crate::reconcile::reconcile_page;

/// What one indexed batch changed, in event order.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BatchChanges {
    pub upserted: Vec<String>,
    pub removed: Vec<String>,
    pub base_registry_changed: bool,
}

impl BatchChanges {
    pub fn from_batch(batch: &[ChangeEvent]) -> Self {
        let mut changes = Self::default();
        for ev in batch {
            match ev {
                ChangeEvent::Upsert(vp) => changes.upserted.push(vp.as_str().to_string()),
                ChangeEvent::Remove(vp) => changes.removed.push(vp.as_str().to_string()),
                ChangeEvent::BaseChanged => changes.base_registry_changed = true,
            }
        }
        changes
    }

    pub fn is_empty(&self) -> bool {
        self.upserted.is_empty() && self.removed.is_empty() && !self.base_registry_changed
    }
}

/// The server-side pieces the watch loop needs: the vault, index and
/// mutation coordinator it works on, plus two callbacks.
pub trait WatchHost: Send + Sync + 'static {
    fn vault(&self) -> &Vault;
    fn index(&self) -> &IndexHandle;
    fn mutation_coordinator(&self) -> &MutationCoordinator;
    /// Hooks fired after a reconcile moves a page.
    fn post_move_hooks(&self) -> Arc<Vec<Box<dyn PostMoveHook>>>;
    /// Sees each raw batch before indexing, so before exclusions drop paths.
    fn batch_received(&self, _batch: &[ChangeEvent]) {}
    /// Called once a batch is indexed, unless the batch changed nothing.
    /// Not called when indexing fails.
    fn batch_indexed(&self, changes: BatchChanges);
}

/// Collect `first` plus every event already queued behind it.
pub fn drain_change_batch(
    first: ChangeEvent,
    rx: &mut UnboundedReceiver<ChangeEvent>,
) -> Vec<ChangeEvent> {
    let mut batch = vec![first];
    while let Ok(event) = rx.try_recv() {
        batch.push(event);
    }
    batch
}

/// Process batches from `rx` until every sender is dropped.
pub async fn run_watch_loop<H: WatchHost>(host: Arc<H>, mut rx: UnboundedReceiver<ChangeEvent>) {
    while let Some(event) = rx.recv().await {
        let batch = drain_change_batch(event, &mut rx);
        process_batch(&*host, batch).await;
    }
}

/// One batch, end to end: [`WatchHost::batch_received`], [`index_batch`],
/// then [`reconcile_upserts`]. The reconcile runs even if indexing failed.
pub async fn process_batch<H: WatchHost + ?Sized>(host: &H, batch: Vec<ChangeEvent>) {
    host.batch_received(&batch);
    let upserts: Vec<VaultPath> = batch
        .iter()
        .filter_map(|e| match e {
            ChangeEvent::Upsert(vp) => Some(vp.clone()),
            _ => None,
        })
        .collect();
    index_batch(host, batch).await;
    reconcile_upserts(host, upserts).await;
}

/// Reindex one batch, log, and report its changes to
/// [`WatchHost::batch_indexed`].
pub async fn index_batch<H: WatchHost + ?Sized>(host: &H, batch: Vec<ChangeEvent>) {
    let changes = BatchChanges::from_batch(&batch);
    match host.index().process_sync_events(batch).await {
        Ok(stats) => {
            if stats.pages_indexed > 0 || stats.pages_removed > 0 {
                tracing::info!(
                    indexed = stats.pages_indexed,
                    skipped = stats.pages_skipped,
                    removed = stats.pages_removed,
                    resolved = stats.links_resolved,
                    deps = stats.deps_reresolved,
                    "sync cycle complete"
                );
            }
            if !changes.is_empty() {
                host.batch_indexed(changes);
            }
        }
        Err(e) => {
            tracing::error!("sync error: {e}");
        }
    }
}

/// Reconcile pages the watcher just saw change: folder-follows-metadata
/// (ADR 0001 layer 2). Runs after the batch is indexed so projection sees
/// fresh frontmatter. A move produces new watch events; reconciling an
/// already-correct page is a no-op, so the loop terminates.
///
/// Excluded paths are skipped, matching indexing: a subtree the vault does
/// not index must not be relocated (or warned about) either.
///
/// Each reconcile runs under the [`MutationCoordinator`] path guard, the same
/// lock the API write path holds across read → write → index. Without it, an
/// in-flight `atomic_replace` can recreate the source file the watcher just
/// renamed, leaving two files carrying one page id. The guard covers the
/// source path only — `reconcile_page` derives its destination internally —
/// which is exactly the path the racing writer holds.
pub async fn reconcile_upserts<H: WatchHost + ?Sized>(host: &H, upserts: Vec<VaultPath>) {
    for vp in upserts {
        if host.vault().is_excluded(&vp) {
            continue;
        }
        let hooks = host.post_move_hooks();
        let target = vp.as_str().to_string();
        let _guard = host
            .mutation_coordinator()
            .lock_paths(std::slice::from_ref(&vp))
            .await;
        let result = host
            .index()
            .with_index(move |index, vault| reconcile_page(vault, index, &target, &hooks))
            .await;
        match result {
            Err(e) | Ok(Err(e)) => tracing::warn!("watcher reconcile failed for {vp}: {e}"),
            Ok(Ok(Some(new_path))) => {
                tracing::info!(
                    "watcher reconcile moved {vp} → {new_path} (folder follows kind/project)"
                );
            }
            Ok(Ok(None)) => {}
        }
    }
}
