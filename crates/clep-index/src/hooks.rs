use crate::index::VaultIndex;
use clep_vault::Vault;
use clep_vault::path::VaultPath;
use uuid::Uuid;

/// Hook invoked after a page has been moved to a new path.
///
/// Domain modules (e.g. academic-library) implement this trait to react to
/// page moves. Returned paths identify pages whose bytes the hook modified and
/// therefore must be reindexed before the transaction can be finalized.
pub trait PostMoveHook: Send + Sync {
    fn on_page_moved(
        &self,
        old_path: &VaultPath,
        new_path: &VaultPath,
        page_id: &Uuid,
        vault: &Vault,
        index: &VaultIndex,
    ) -> Result<Vec<VaultPath>, Box<dyn std::error::Error>>;
}

/// Hook invoked after a page has been deleted.
///
/// Domain modules implement this to clean up related resources.
pub trait PostDeleteHook: Send + Sync {
    fn on_page_deleted(
        &self,
        path: &VaultPath,
        page_id: &Uuid,
        meta: &clep_vault::page::PageMeta,
    ) -> Result<(), Box<dyn std::error::Error>>;
}

/// Hook invoked while a rubbish item is being purged, before its files are
/// removed. The item ID supplies idempotency; the page identity is carried
/// for truthful diagnostics.
pub trait RubbishPurgeHook: Send + Sync {
    /// Release whatever this hook holds on behalf of the item (captured
    /// archive references, for instance). Must be idempotent per `item_id`.
    fn on_rubbish_purge(
        &self,
        item_id: Uuid,
        original_path: &VaultPath,
        page_id: &Uuid,
        meta: &clep_vault::page::PageMeta,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// Whether an earlier purge of `item_id` already released this hook's
    /// resources, in which case the item can no longer be restored.
    fn purge_committed(
        &self,
        item_id: Uuid,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>>;
}
