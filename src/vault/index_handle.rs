use std::sync::mpsc;

use super::Vault;
use super::index::{BacklinkWithContext, BuildStats, IndexError, SearchResult, VaultIndex};
use super::path::VaultPath;
use super::sync::{ChangeEvent, SyncEngine, SyncStats};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A closure sent to the index thread for execution.
type IndexFn = Box<dyn FnOnce(&mut VaultIndex, &Vault) + Send>;

// ---------------------------------------------------------------------------
// IndexHandle
// ---------------------------------------------------------------------------

/// Channel-based handle for accessing [`VaultIndex`] from async code.
///
/// The underlying `VaultIndex` and `Vault` live on a dedicated OS thread.
/// All access goes through closures sent over an [`mpsc`] channel, with
/// results returned via [`tokio::sync::oneshot`] channels.
///
/// `IndexHandle` is `Clone + Send + Sync` and cheap to share.
#[derive(Clone)]
pub struct IndexHandle {
    tx: mpsc::Sender<IndexFn>,
}

impl IndexHandle {
    /// Spawn the index thread and return a handle.
    ///
    /// The thread owns both `index` and `vault`, running closures sent
    /// through the channel until the last `IndexHandle` is dropped.
    pub fn spawn(mut index: VaultIndex, vault: Vault) -> Self {
        let (tx, rx) = mpsc::channel::<IndexFn>();

        std::thread::Builder::new()
            .name("vault-index".into())
            .spawn(move || {
                while let Ok(f) = rx.recv() {
                    f(&mut index, &vault);
                }
            })
            .expect("failed to spawn vault-index thread");

        Self { tx }
    }

    /// Send a closure to the index thread and await the result.
    ///
    /// The closure receives `&mut VaultIndex` and `&Vault` and must
    /// return a value that is `Send + 'static`.
    pub async fn with_index<F, R>(&self, f: F) -> Result<R, IndexError>
    where
        F: FnOnce(&mut VaultIndex, &Vault) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();

        let closure: IndexFn = Box::new(move |index, vault| {
            let result = f(index, vault);
            // If the receiver was dropped, silently discard.
            let _ = resp_tx.send(result);
        });

        self.tx
            .send(closure)
            .map_err(|_| IndexError::Other("index thread shut down".into()))?;

        resp_rx
            .await
            .map_err(|_| IndexError::Other("index thread dropped response".into()))
    }

    // ------------------------------------------------------------------
    // Convenience methods
    // ------------------------------------------------------------------

    /// Full (re-)build of the index.
    pub async fn build(&self) -> Result<BuildStats, IndexError> {
        self.with_index(|index, vault| index.build(vault))
            .await?
    }

    /// Resolve all unresolved links across the index.
    pub async fn resolve_links(&self) -> Result<(), IndexError> {
        self.with_index(|index, _vault| index.resolve_links())
            .await?
    }

    /// Index (or re-index) a single page.
    pub async fn index_page(&self, vp: VaultPath) -> Result<bool, IndexError> {
        self.with_index(move |index, vault| index.index_page(vault, &vp))
            .await?
    }

    /// Remove a page from the index.
    pub async fn remove_page(&self, vp: VaultPath) -> Result<bool, IndexError> {
        self.with_index(move |index, _vault| index.remove_page(&vp))
            .await?
    }

    /// Resolve links for a specific page (outgoing + incoming).
    pub async fn resolve_links_for_page(&self, vp: VaultPath) -> Result<usize, IndexError> {
        self.with_index(move |index, _vault| index.resolve_links_for_page(&vp))
            .await?
    }

    /// Process a batch of sync events (file creates/modifies/deletes).
    pub async fn process_sync_events(
        &self,
        events: Vec<ChangeEvent>,
    ) -> Result<SyncStats, IndexError> {
        self.with_index(move |index, vault| {
            SyncEngine::process_events(&events, vault, index)
        })
        .await?
    }

    /// Find backlinks to a page with surrounding context.
    pub async fn backlinks(
        &self,
        vp: VaultPath,
        max_context_chars: usize,
    ) -> Result<Vec<BacklinkWithContext>, IndexError> {
        self.with_index(move |index, vault| {
            index.backlinks_with_context(vault, &vp, max_context_chars)
        })
        .await?
    }

    /// Full-text search across page titles and bodies.
    pub async fn search(
        &self,
        query: String,
        limit: usize,
    ) -> Result<Vec<SearchResult>, IndexError> {
        self.with_index(move |index, _vault| index.search(&query, limit))
            .await?
    }

    /// Find pages that link to the given page.
    pub async fn reverse_deps(&self, vp: VaultPath) -> Result<Vec<VaultPath>, IndexError> {
        self.with_index(move |index, _vault| index.reverse_deps(&vp))
            .await?
    }

    /// Invalidate resolved links pointing to a page.
    pub async fn invalidate_links_to(&self, vp: VaultPath) -> Result<usize, IndexError> {
        self.with_index(move |index, _vault| index.invalidate_links_to(&vp))
            .await?
    }
}
