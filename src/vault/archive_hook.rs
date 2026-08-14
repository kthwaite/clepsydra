use crate::vault::cas::ContentStore;
use crate::vault::hooks::PostDeleteHook;
use crate::vault::page::PageMeta;
use crate::vault::path::VaultPath;
use std::collections::BTreeSet;
use std::sync::Arc;
use uuid::Uuid;

/// Decrements CAS ref_counts when an archive page is deleted.
pub struct ArchiveDeleteHook {
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
}

/// Return the deduplicated captured-archive CAS references encoded by the
/// established `[archive]` page metadata convention.
pub(crate) fn captured_archive_hashes(meta: &PageMeta) -> BTreeSet<String> {
    let Some(toml::Value::Table(archive)) = meta.extra.get("archive") else {
        return BTreeSet::new();
    };

    let mut hashes = BTreeSet::new();
    if let Some(toml::Value::String(hash)) = archive.get("snapshot_hash") {
        hashes.insert(hash.clone());
    }
    if let Some(toml::Value::Array(blob_hashes)) = archive.get("blobs") {
        for value in blob_hashes {
            if let toml::Value::String(hash) = value {
                hashes.insert(hash.clone());
            }
        }
    }
    hashes
}

impl PostDeleteHook for ArchiveDeleteHook {
    fn on_page_deleted(
        &self,
        _path: &VaultPath,
        _page_id: &Uuid,
        meta: &PageMeta,
    ) -> Result<(), Box<dyn std::error::Error>> {
        tracing::debug!("ArchiveDeleteHook: page deleted, checking for archive metadata");
        let unique_hashes = captured_archive_hashes(meta);
        if unique_hashes.is_empty() {
            return Ok(());
        }

        let cas = self.cas.lock();
        let mut failures = Vec::new();
        for hash in unique_hashes {
            if let Err(error) = cas.decrement_ref(&hash) {
                failures.push(format!("{hash}: {error}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to decrement archive CAS references: {}",
                failures.join("; ")
            )
            .into())
        }
    }
}
