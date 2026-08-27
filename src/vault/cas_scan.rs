//! Vault-wide CAS reference scan: counts captured-archive references and tracks content types.

use crate::vault::archive_hook::{captured_archive_hashes, captured_blob_types};
use crate::vault::page::parse_or_repair_frontmatter;
use crate::vault::Vault;
use std::collections::BTreeMap;
use walkdir::WalkDir;

#[derive(Debug, Default)]
pub struct ArchiveRefScan {
    /// hash → reference count (live pages + rubbish items; one per page per unique hash).
    pub refs: BTreeMap<String, u32>,
    /// hash → content type (from typed blob entries; snapshot hashes map to "text/html").
    pub types: BTreeMap<String, String>,
    pub warnings: Vec<String>,
    /// Track hashes seen (in walk order) to implement first-writer-wins for types.
    #[doc(hidden)]
    seen_hashes: std::collections::HashSet<String>,
}

/// Scan all live pages and rubbish items for captured-archive references.
///
/// Counts each unique hash per page (live or rubbish) contributing +1 to the ref count.
/// Uses meta from `parse_or_repair_frontmatter` even when it returns a warning —
/// an unparseable page yields default meta contributing nothing, but the warning is recorded.
pub fn scan_archive_refs(vault: &Vault) -> ArchiveRefScan {
    let mut scan = ArchiveRefScan::default();

    // Scan live pages
    scan_live_pages(vault, &mut scan);

    // Scan rubbish items
    scan_rubbish_items(vault, &mut scan);

    scan
}

fn scan_live_pages(vault: &Vault, scan: &mut ArchiveRefScan) {
    // Collect and sort paths for deterministic first-writer-wins semantics
    let mut paths = Vec::new();
    for entry in WalkDir::new(vault.root())
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(vault.root()) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".clepsydra/") {
            continue;
        }
        let Ok(vault_path) = crate::vault::path::VaultPath::new(&rel_str) else {
            continue;
        };
        if vault.is_excluded(&vault_path) {
            continue;
        }
        paths.push(path.to_path_buf());
    }

    // Sort paths for deterministic order
    paths.sort();

    // Process in sorted order
    for path in paths {
        if let Ok(content) = std::fs::read_to_string(&path) {
            scan_page_content(&content, scan);
        }
    }
}

fn scan_rubbish_items(vault: &Vault, scan: &mut ArchiveRefScan) {
    let rubbish_dir = vault.root().join(".clepsydra/rubbish");
    if !rubbish_dir.exists() {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(&rubbish_dir) {
        for entry_result in entries {
            if let Ok(entry) = entry_result {
                let dir_name = entry.file_name();
                let dir_name_str = dir_name.to_string_lossy();

                // Skip dirs starting with . (covers .purge-* tombstones)
                if dir_name_str.starts_with('.') {
                    continue;
                }

                let page_path = entry.path().join("page.md");
                match std::fs::read_to_string(&page_path) {
                    Ok(content) => {
                        scan_page_content(&content, scan);
                    }
                    Err(_) => {
                        // Missing page.md or other read error
                        scan.warnings
                            .push(format!("Failed to read rubbish item page: {}", dir_name_str));
                    }
                }
            }
        }
    }
}

fn scan_page_content(content: &str, scan: &mut ArchiveRefScan) {
    let (meta, _, _, warning) = parse_or_repair_frontmatter(content);

    // Record warning if present (KEY RULE: use meta even when warning returned)
    if let Some(w) = warning {
        scan.warnings.push(w);
    }

    // Count references for each unique hash
    let hashes = captured_archive_hashes(&meta);
    for hash in &hashes {
        *scan.refs.entry(hash.clone()).or_insert(0) += 1;
    }

    // Merge blob types from the page: first writer wins (only type unseen hashes)
    let blob_types = captured_blob_types(&meta);
    for (hash, ct) in blob_types {
        if !scan.seen_hashes.contains(hash.as_str()) {
            scan.types.insert(hash.clone(), ct);
        }
    }

    // Add snapshot_hash type if present (defaults to "text/html", but only if not seen)
    if let Some(toml::Value::String(snapshot)) = meta.extra.get("archive")
        .and_then(|archive| {
            if let toml::Value::Table(t) = archive {
                t.get("snapshot_hash")
            } else {
                None
            }
        })
    {
        if !scan.seen_hashes.contains(snapshot.as_str()) {
            scan.types
                .entry(snapshot.clone())
                .or_insert_with(|| "text/html".into());
        }
    }

    // Mark all hashes as seen (even untyped ones from this page) after typing decisions
    for hash in &hashes {
        scan.seen_hashes.insert(hash.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H1: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const H2: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn archive_page(blob_entry: &str) -> String {
        format!(
            "+++\nid = \"01900000-0000-7000-8000-000000000001\"\ntitle = \"A\"\n\
             created_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\
             [archive]\nurl = \"https://x\"\ndomain = \"x\"\ncaptured_at = \"2026-01-01T00:00:00Z\"\n\
             snapshot_hash = \"{H1}\"\nblobs = [{blob_entry}]\n+++\nbody\n"
        )
    }

    fn make_vault(pages: &[(&str, &str)]) -> (tempfile::TempDir, Vault) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        for (rel, content) in pages {
            let abs = root.join(rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(abs, content).unwrap();
        }
        let vault = Vault::open(&root).unwrap();
        (tmp, vault)
    }

    #[test]
    fn counts_live_pages_rubbish_and_snapshot_types() {
        let page_a = archive_page(&format!("{{ hash = \"{H2}\", type = \"image/png\" }}"));
        let page_b = archive_page(&format!("\"{H2}\"")); // legacy string entry
        let (_tmp, vault) = make_vault(&[("archive/x/a.md", &page_a)]);
        // rubbish item holding page_b:
        let item = vault.root().join(".clepsydra/rubbish/0190aaaa-0000-7000-8000-000000000001");
        std::fs::create_dir_all(&item).unwrap();
        std::fs::write(item.join("page.md"), &page_b).unwrap();
        std::fs::write(item.join("manifest.json"), "{}").unwrap();
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.refs.get(H1), Some(&2));            // both pages capture the snapshot
        assert_eq!(scan.refs.get(H2), Some(&2));
        assert_eq!(scan.types.get(H1).map(String::as_str), Some("text/html")); // snapshot
        assert_eq!(scan.types.get(H2).map(String::as_str), Some("image/png")); // typed entry wins
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn purge_tombstone_dirs_are_ignored() {
        let (_tmp, vault) = make_vault(&[]);
        let tomb = vault.root().join(".clepsydra/rubbish/.purge-0190aaaa-0000-7000-8000-000000000002");
        std::fs::create_dir_all(&tomb).unwrap();
        let scan = scan_archive_refs(&vault);
        assert!(scan.refs.is_empty());
    }

    #[test]
    fn unreadable_rubbish_page_warns_not_panics() {
        let (_tmp, vault) = make_vault(&[]);
        let item = vault.root().join(".clepsydra/rubbish/0190aaaa-0000-7000-8000-000000000003");
        std::fs::create_dir_all(&item).unwrap(); // no page.md
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.warnings.len(), 1);
    }

    #[test]
    fn legacy_yaml_frontmatter_counts_refs() {
        let legacy_page = format!(
            "---\nid: 01900000-0000-7000-8000-000000000004\ntitle: \"Legacy\"\n\
             archive:\n  url: https://example.com\n  \
             snapshot_hash: {H1}\n---\nbody\n"
        );
        let (_tmp, vault) = make_vault(&[("legacy.md", &legacy_page)]);
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.refs.get(H1), Some(&1));
        assert_eq!(scan.types.get(H1).map(String::as_str), Some("text/html"));
        assert!(scan.warnings.is_empty());
    }

    #[test]
    fn typed_entry_first_reader_wins_over_later_retype() {
        let page_a = archive_page(&format!("{{ hash = \"{H2}\", type = \"image/png\" }}")); // typed as image
        let page_b = archive_page(&format!("{{ hash = \"{H2}\", type = \"text/plain\" }}")); // tries to retype
        let (_tmp, vault) = make_vault(&[
            ("archive/01.md", &page_a),
            ("archive/02.md", &page_b),
        ]);
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.refs.get(H2), Some(&2));
        // First writer's type wins
        assert_eq!(scan.types.get(H2).map(String::as_str), Some("image/png"));
    }

    #[test]
    fn untyped_legacy_blob_stays_absent_even_if_later_typed() {
        let page_a = archive_page(&format!("\"{H2}\"")); // legacy string entry, no type
        let page_b = archive_page(&format!("{{ hash = \"{H2}\", type = \"image/png\" }}")); // typed
        let (_tmp, vault) = make_vault(&[
            ("archive/01.md", &page_a),
            ("archive/02.md", &page_b),
        ]);
        let scan = scan_archive_refs(&vault);
        assert_eq!(scan.refs.get(H2), Some(&2));
        // First writer's decision (no type) prevails
        assert!(scan.types.get(H2).is_none());
    }
}
