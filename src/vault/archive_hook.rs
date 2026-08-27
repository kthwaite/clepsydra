use crate::vault::cas::{CasError, ContentStore, ReleaseOutcome};
use crate::vault::hooks::PostDeleteHook;
use crate::vault::page::PageMeta;
use crate::vault::path::VaultPath;
use std::collections::{BTreeMap, BTreeSet};
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
    if let Some(toml::Value::Array(blob_entries)) = archive.get("blobs") {
        for value in blob_entries {
            match value {
                toml::Value::String(hash) => {
                    hashes.insert(hash.clone());
                }
                toml::Value::Table(entry) => {
                    if let Some(toml::Value::String(hash)) = entry.get("hash") {
                        hashes.insert(hash.clone());
                    }
                }
                _ => {}
            }
        }
    }
    hashes
}

/// Hash → declared content type, from table-shaped `[archive] blobs` entries.
/// Legacy string entries carry no type and are absent from the map.
pub(crate) fn captured_blob_types(meta: &PageMeta) -> BTreeMap<String, String> {
    let Some(toml::Value::Table(archive)) = meta.extra.get("archive") else {
        return BTreeMap::new();
    };
    let mut types = BTreeMap::new();
    if let Some(toml::Value::Array(blob_entries)) = archive.get("blobs") {
        for value in blob_entries {
            if let toml::Value::Table(entry) = value
                && let (Some(toml::Value::String(hash)), Some(toml::Value::String(ct))) =
                    (entry.get("hash"), entry.get("type"))
            {
                types.insert(hash.clone(), ct.clone());
            }
        }
    }
    types
}

/// Release only captured-archive references for one rubbish lifecycle item.
/// The original page identity is carried through this boundary for truthful
/// cleanup diagnostics; the item ID supplies durable idempotency.
pub(crate) fn release_rubbish_archive_refs_for_purge(
    cas: &parking_lot::Mutex<ContentStore>,
    item_id: Uuid,
    original_path: &VaultPath,
    page_id: &Uuid,
    meta: &PageMeta,
) -> Result<ReleaseOutcome, CasError> {
    let hashes = captured_archive_hashes(meta);
    tracing::debug!(
        rubbish_item_id = %item_id,
        original_path = %original_path,
        page_id = %page_id,
        captured_archive_refs = hashes.len(),
        "releasing captured-archive references for rubbish purge"
    );
    cas.lock().release_rubbish_archive_refs(item_id, &hashes)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_archive_hashes_accepts_string_and_table_blobs() {
        let mut meta = PageMeta::new();
        let mut archive = toml::Table::new();
        archive.insert(
            "snapshot_hash".into(),
            toml::Value::String("sha256:1111".into()),
        );
        let mut typed = toml::Table::new();
        typed.insert("hash".into(), toml::Value::String("sha256:2222".into()));
        typed.insert("type".into(), toml::Value::String("image/png".into()));
        archive.insert(
            "blobs".into(),
            toml::Value::Array(vec![
                toml::Value::String("sha256:3333".into()),
                toml::Value::Table(typed),
            ]),
        );
        meta.extra
            .insert("archive".into(), toml::Value::Table(archive));
        let hashes = captured_archive_hashes(&meta);
        assert!(
            hashes.contains("sha256:1111")
                && hashes.contains("sha256:2222")
                && hashes.contains("sha256:3333")
        );
        let types = captured_blob_types(&meta);
        assert_eq!(
            types.get("sha256:2222").map(String::as_str),
            Some("image/png")
        );
        assert!(!types.contains_key("sha256:3333"));
    }
}
