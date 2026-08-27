//! One-time backfill: replace legacy string entries in `[archive] blobs`
//! with `{hash, type}` tables, types looked up in the CAS metadata DB
//! (docs/adr/0005). Dry run by default.

use std::path::Path;

use rusqlite::OptionalExtension;
use walkdir::WalkDir;

use super::Vault;
use super::archive_hook::captured_blob_types;
use super::atomic_file::atomic_replace;
use super::page::{parse_or_repair_frontmatter, write_page_content};
use super::path::VaultPath;

/// Outcome of a backfill sweep (or dry run).
#[derive(Debug, Default)]
pub struct BackfillReport {
    /// Pages whose `[archive] blobs` entries were typed (or, on a dry run,
    /// that would be typed).
    pub updated: Vec<String>,
    /// Pages skipped with a problem (unparseable frontmatter, missing
    /// content-type, publication failure).
    pub warnings: Vec<String>,
    pub dry_run: bool,
}

/// Walk the vault and return every non-excluded `.md` page, sorted by path.
/// Mirrors `conflict::conflicted_pages` (src/vault/conflict.rs:28).
fn candidate_pages(vault: &Vault) -> Vec<VaultPath> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault.root())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
    {
        let Ok(rel_path) = entry.path().strip_prefix(vault.root()) else {
            continue;
        };
        let rel_str = rel_path.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".clepsydra/") {
            continue;
        }
        let Ok(vault_path) = VaultPath::new(&rel_str) else {
            continue;
        };
        if vault.is_excluded(&vault_path) {
            continue;
        }
        out.push(vault_path);
    }
    out.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    out
}

/// Type every legacy string entry in `[archive] blobs` as a `{hash, type}`
/// table, looking up the content type in `cas_db`. With `write = false`
/// (dry run), reports what would change and touches nothing.
///
/// A hash with no matching row in `cas.db` is left as a string entry and
/// reported as a warning. Pages whose frontmatter cannot be fully read
/// (conflict markers, malformed TOML) are reported and left alone — the
/// sweep never rewrites what it did not fully read. `.clepsydra/` (including
/// `.clepsydra/rubbish/`) is never swept; readers tolerate the legacy shape
/// there forever (spec §7).
pub fn backfill(vault: &Vault, cas_db: &Path, write: bool) -> BackfillReport {
    backfill_with_publication(vault, cas_db, write, atomic_replace)
}

fn backfill_with_publication(
    vault: &Vault,
    cas_db: &Path,
    write: bool,
    mut publish: impl FnMut(
        &std::path::Path,
        &[u8],
    ) -> Result<(), super::atomic_file::AtomicPublicationError>,
) -> BackfillReport {
    let mut report = BackfillReport {
        dry_run: !write,
        ..Default::default()
    };

    let conn = match rusqlite::Connection::open_with_flags(
        cas_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(conn) => conn,
        Err(e) => {
            report
                .warnings
                .push(format!("cannot open cas.db at {}: {e}", cas_db.display()));
            return report;
        }
    };

    for vault_path in candidate_pages(vault) {
        let abs = vault.resolve(&vault_path);
        let content = match std::fs::read_to_string(&abs) {
            Ok(c) => c,
            Err(e) => {
                report
                    .warnings
                    .push(format!("{}: cannot read: {e}", vault_path.as_str()));
                continue;
            }
        };
        if !content.contains("[archive]") {
            continue;
        }

        let (meta, body, _rewrote, warning) = parse_or_repair_frontmatter(&content);
        if let Some(w) = warning {
            report
                .warnings
                .push(format!("{}: {w}", vault_path.as_str()));
            continue;
        }

        let Some(toml::Value::Table(archive)) = meta.extra.get("archive") else {
            continue;
        };
        let Some(toml::Value::Array(entries)) = archive.get("blobs") else {
            continue;
        };

        // Entries the page already carries a type for (e.g. a duplicate hash
        // recorded both as a bare string and as a typed table from a partial
        // prior backfill) are resolved from the page itself before touching
        // `cas.db`.
        let known_types = captured_blob_types(&meta);

        let mut changed = false;
        let mut new_entries = Vec::with_capacity(entries.len());
        for entry in entries {
            match entry {
                toml::Value::String(hash) => {
                    let content_type: Option<String> =
                        known_types.get(hash).cloned().or_else(|| {
                            conn.query_row(
                                "SELECT content_type FROM blobs WHERE hash = ?1",
                                rusqlite::params![hash],
                                |row| row.get(0),
                            )
                            .optional()
                            .ok()
                            .flatten()
                        });
                    match content_type {
                        Some(ct) => {
                            let mut typed = toml::Table::new();
                            typed.insert("hash".into(), toml::Value::String(hash.clone()));
                            typed.insert("type".into(), toml::Value::String(ct));
                            new_entries.push(toml::Value::Table(typed));
                            changed = true;
                        }
                        None => {
                            report.warnings.push(format!(
                                "{}: no content_type in cas.db for {hash}",
                                vault_path.as_str()
                            ));
                            new_entries.push(entry.clone());
                        }
                    }
                }
                other => new_entries.push(other.clone()),
            }
        }

        if !changed {
            continue;
        }

        let mut new_meta = meta.clone();
        let Some(toml::Value::Table(archive)) = new_meta.extra.get_mut("archive") else {
            unreachable!("archive table validated above");
        };
        archive.insert("blobs".into(), toml::Value::Array(new_entries));

        if write {
            let new_content = write_page_content(&new_meta, &body);
            if let Err(e) = publish(&abs, new_content.as_bytes()) {
                report
                    .warnings
                    .push(format!("{}: write failed: {e}", vault_path.as_str()));
                continue;
            }
        }
        report.updated.push(vault_path.as_str().to_string());
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn make_cas_db(dir: &std::path::Path, rows: &[(&str, &str)]) -> std::path::PathBuf {
        let db = dir.join("cas.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, \
             content_type TEXT NOT NULL, created_at TEXT NOT NULL, ref_count INTEGER NOT NULL DEFAULT 1);",
        ).unwrap();
        for (hash, ct) in rows {
            conn.execute(
                "INSERT INTO blobs (hash, size, content_type, created_at) VALUES (?1, 1, ?2, '2026-01-01T00:00:00Z')",
                rusqlite::params![hash, ct],
            ).unwrap();
        }
        db
    }

    const H1: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const H2: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn legacy_archive_page(blob_lines: &str) -> String {
        format!(
            "+++\nid = \"01900000-0000-7000-8000-000000000001\"\ntitle = \"A\"\n\
             created_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\
             [archive]\nurl = \"https://x\"\ndomain = \"x\"\ncaptured_at = \"2026-01-01T00:00:00Z\"\n\
             snapshot_hash = \"{H1}\"\nblobs = [{blob_lines}]\n+++\nbody\n"
        )
    }

    #[test]
    fn dry_run_reports_and_writes_nothing() {
        let (tmp, vault) =
            make_vault(&[("archive/x/a.md", &legacy_archive_page(&format!("\"{H2}\"")))]);
        let db = make_cas_db(tmp.path(), &[(H2, "image/png")]);
        let before = std::fs::read_to_string(vault.root().join("archive/x/a.md")).unwrap();
        let report = backfill(&vault, &db, false);
        assert!(report.dry_run);
        assert_eq!(report.updated, vec!["archive/x/a.md"]);
        assert_eq!(
            std::fs::read_to_string(vault.root().join("archive/x/a.md")).unwrap(),
            before
        );
    }

    #[test]
    fn write_replaces_string_entries_with_typed_tables() {
        let (_tmp, vault) =
            make_vault(&[("archive/x/a.md", &legacy_archive_page(&format!("\"{H2}\"")))]);
        let db = make_cas_db(_tmp.path(), &[(H2, "image/png")]);
        let report = backfill(&vault, &db, true);
        assert_eq!(report.updated, vec!["archive/x/a.md"]);
        let after = std::fs::read_to_string(vault.root().join("archive/x/a.md")).unwrap();
        let (meta, _, _, w) = crate::vault::page::parse_or_repair_frontmatter(&after);
        assert!(w.is_none());
        let types = crate::vault::archive_hook::captured_blob_types(&meta);
        assert_eq!(types.get(H2).map(String::as_str), Some("image/png"));
    }

    #[test]
    fn unknown_hash_kept_as_string_with_warning() {
        let (_tmp, vault) =
            make_vault(&[("archive/x/a.md", &legacy_archive_page(&format!("\"{H2}\"")))]);
        let db = make_cas_db(_tmp.path(), &[]); // H2 absent
        let report = backfill(&vault, &db, true);
        assert!(report.updated.is_empty());
        assert_eq!(report.warnings.len(), 1);
    }

    #[test]
    fn already_typed_page_skipped() {
        let typed = format!("{{ hash = \"{H2}\", type = \"image/png\" }}");
        let (_tmp, vault) = make_vault(&[("archive/x/a.md", &legacy_archive_page(&typed))]);
        let db = make_cas_db(_tmp.path(), &[(H2, "image/png")]);
        let report = backfill(&vault, &db, true);
        assert!(report.updated.is_empty() && report.warnings.is_empty());
    }
}
