use crate::vault::cas::ContentStore;
use crate::vault::hooks::PostDeleteHook;
use crate::vault::page::PageMeta;
use crate::vault::path::VaultPath;
use std::sync::Arc;
use uuid::Uuid;

/// Decrements CAS ref_counts when an archive page is deleted.
pub struct ArchiveDeleteHook {
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
}

impl PostDeleteHook for ArchiveDeleteHook {
    fn on_page_deleted(
        &self,
        _path: &VaultPath,
        _page_id: &Uuid,
        meta: &PageMeta,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Check if this page has archive metadata
        let archive = match meta.extra.get("archive") {
            Some(serde_yaml::Value::Mapping(m)) => m,
            _ => return Ok(()), // not an archive page, nothing to do
        };

        let mut unique_hashes = std::collections::HashSet::new();

        // Collect snapshot_hash
        if let Some(serde_yaml::Value::String(hash)) = archive.get("snapshot_hash") {
            unique_hashes.insert(hash.clone());
        }

        // Collect blob hashes
        if let Some(serde_yaml::Value::Sequence(hashes)) = archive.get("blobs") {
            for h in hashes {
                if let serde_yaml::Value::String(hash) = h {
                    unique_hashes.insert(hash.clone());
                }
            }
        }

        if unique_hashes.is_empty() {
            return Ok(());
        }

        let cas = self.cas.lock();
        for hash in unique_hashes {
            let _ = cas.decrement_ref(&hash);
        }

        Ok(())
    }
}
