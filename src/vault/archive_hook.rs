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

        let cas = self.cas.lock();

        // Decrement snapshot_hash ref
        if let Some(serde_yaml::Value::String(hash)) = archive.get("snapshot_hash") {
            let _ = cas.decrement_ref(hash); // ignore error if blob already gone
        }

        // Decrement blob hashes (stored under "blobs" key by ingest_archive)
        if let Some(serde_yaml::Value::Sequence(hashes)) = archive.get("blobs") {
            for h in hashes {
                if let serde_yaml::Value::String(hash) = h {
                    let _ = cas.decrement_ref(hash);
                }
            }
        }

        Ok(())
    }
}
