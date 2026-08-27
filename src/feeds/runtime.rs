use std::error::Error;
use std::path::Path;
#[cfg(test)]
use std::sync::Arc;

use parking_lot::RwLock;
use tokio::sync::{Mutex, Notify, Semaphore};

use super::network::CheckedHttpClient;
use super::store::FeedStoreHandle;
use super::types::ManifestWarning;
use crate::FeedsSettings;

/// Resources that exist only while the Feeds feature is enabled.
pub struct FeedRuntime {
    /// Serialized feed/entry storage backed by `.clepsydra/feeds.db`.
    pub feeds: FeedStoreHandle,
    /// Checked HTTP client enforcing the RSS network boundary.
    pub feed_client: CheckedHttpClient,
    /// Bounds subscribe discovery independently of manifest serialization.
    pub feed_discovery_semaphore: Semaphore,
    /// Shared wake-up for manifest edits and explicit refresh requests.
    pub feed_refresh: Notify,
    /// Diagnostics from the current raw manifest. Warning-bearing manifests do
    /// not replace the last-good subscription set.
    pub feed_manifest_diagnostics: RwLock<Vec<ManifestWarning>>,
    /// Serializes API read/transform/CAS membership mutations.
    pub feed_manifest_lock: Mutex<()>,
    #[cfg(test)]
    pub(crate) feed_before_reconcile_commit_hook:
        parking_lot::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) feed_after_list_snapshot_hook:
        parking_lot::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) feed_before_opml_parse_hook: parking_lot::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Feed scheduler limits resolved from the application configuration.
    pub feed_settings: FeedsSettings,
}

impl FeedRuntime {
    /// Open the feed database and checked network client for one vault.
    pub fn open(vault_root: &Path, settings: &FeedsSettings) -> Result<Self, Box<dyn Error>> {
        let feeds = FeedStoreHandle::open(&vault_root.join(".clepsydra/feeds.db"))?;
        let feed_client = CheckedHttpClient::new(settings.max_response_bytes)?;
        Ok(Self {
            feeds,
            feed_client,
            feed_discovery_semaphore: Semaphore::new(settings.fetch_concurrency.max(1)),
            feed_refresh: Notify::new(),
            feed_manifest_diagnostics: RwLock::new(Vec::new()),
            feed_manifest_lock: Mutex::new(()),
            #[cfg(test)]
            feed_before_reconcile_commit_hook: parking_lot::Mutex::new(None),
            #[cfg(test)]
            feed_after_list_snapshot_hook: parking_lot::Mutex::new(None),
            #[cfg(test)]
            feed_before_opml_parse_hook: parking_lot::Mutex::new(None),
            feed_settings: settings.clone(),
        })
    }
}
