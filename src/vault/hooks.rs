use crate::vault::path::VaultPath;
use uuid::Uuid;

/// Hook invoked after a page has been moved to a new path.
///
/// Domain modules (e.g. academic-library) implement this trait to react to
/// page moves — updating their own indexes, caches, or external state.
pub trait PostMoveHook: Send + Sync {
    fn on_page_moved(
        &self,
        old_path: &VaultPath,
        new_path: &VaultPath,
        page_id: &Uuid,
    ) -> Result<(), Box<dyn std::error::Error>>;
}
