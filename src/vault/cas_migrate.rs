//! One-time move of the CAS into the vault (ADR 0005 / spec §7): copy the
//! blobs this vault references from an old store into `vault.cas_root()`,
//! verify each by hash, and rebuild the destination `cas.db` from blob files
//! plus the frontmatter scan. The source store is never modified; blobs it
//! holds that no page references stay behind.
//!
//! `rebuild_metadata` (in write mode) also clears `rubbish_archive_releases`
//! on the destination — harmless here since the destination is freshly
//! created by this migration.
//!
//! Content types for legacy string blob entries (no `type` in frontmatter)
//! are backfilled from the source's own `cas.db` before the rebuild, when
//! that db is readable — otherwise `clep cas backfill` (which reads the
//! *migrated* `cas.db`) would have nothing to type them from, since a fresh
//! rebuild without this step falls back every untyped hash to
//! `application/octet-stream`. Frontmatter types always win over the source
//! db.

use std::path::{Path, PathBuf};

use crate::vault::Vault;
use crate::vault::cas::{ContentStore, blob_relative_path, list_blob_hashes};
use crate::vault::cas_scan::{ArchiveRefScan, scan_archive_refs};

/// Where the store lived before 2026-08-28; the migration's default source.
pub const LEGACY_DEFAULT_CAS_PATH: &str = "~/.clepsydra/cas";

/// Report of a migration run (or dry run).
#[derive(Debug, Default)]
pub struct MigrateReport {
    /// Hashes copied (or that would be, in a dry run).
    pub copied: Vec<String>,
    /// Referenced hashes the destination already had.
    pub already_present: Vec<String>,
    /// Referenced hashes absent from the source.
    pub missing: Vec<String>,
    /// Source files whose sha256 didn't match their name; not copied.
    pub corrupt: Vec<String>,
    /// Referenced hashes that could not be copied due to an I/O error
    /// reading the source blob or writing the destination blob. The run
    /// still completes and reports everything else.
    pub failed: Vec<String>,
    /// Referenced hashes typed from the source's own `cas.db` because their
    /// frontmatter carried only a legacy, untyped string blob entry.
    /// Frontmatter types always win; this only fills gaps.
    pub types_from_source: u64,
    pub bytes_copied: u64,
    /// Source blobs no live page or rubbish item references.
    pub orphans_left: u64,
    /// Set only when `write` was true.
    pub rebuild: Option<crate::vault::cas::RebuildReport>,
    /// Scan warnings plus one line per missing or corrupt blob.
    pub warnings: Vec<String>,
    pub dry_run: bool,
}

/// Copy every blob this vault references from `source` into `vault.cas_root()`,
/// then rebuild the destination `cas.db`. Never touches `source`.
///
/// A dry run (`write == false`) only computes the report: it does not create
/// the destination directory, copy any bytes, or open a `ContentStore` there.
pub fn migrate(
    vault: &Vault,
    source: &Path,
    write: bool,
) -> Result<MigrateReport, Box<dyn std::error::Error>> {
    if !source.is_dir() {
        return Err(format!("source CAS {} is not a directory", source.display()).into());
    }
    let dest = vault.cas_root();
    let source = std::fs::canonicalize(source)?;
    if dest.exists() && std::fs::canonicalize(&dest)? == source {
        return Err(format!(
            "source and destination are the same store ({})",
            source.display()
        )
        .into());
    }
    let mut report = MigrateReport {
        dry_run: !write,
        ..Default::default()
    };
    let mut scan = scan_archive_refs(vault);
    report.warnings.extend(scan.warnings.iter().cloned());
    report.types_from_source = fill_types_from_source_db(&mut scan, &source, &mut report.warnings);

    for hash in scan.refs.keys() {
        let Some(rel) = blob_relative_path(hash) else {
            report
                .warnings
                .push(format!("{hash}: malformed hash in frontmatter; skipped"));
            continue;
        };
        let to = dest.join(&rel);
        if to.is_file() {
            report.already_present.push(hash.clone());
            continue;
        }
        let from = source.join(&rel);
        // `exists()`, not `is_file()`: a path that exists but isn't a
        // regular file (e.g. a directory sitting where a blob should be)
        // is a per-blob I/O failure below, not "absent from the source".
        if !from.exists() {
            report.missing.push(hash.clone());
            report
                .warnings
                .push(format!("{hash}: not found in {}", source.display()));
            continue;
        }
        let bytes = match std::fs::read(&from) {
            Ok(bytes) => bytes,
            Err(error) => {
                report.failed.push(hash.clone());
                report.warnings.push(format!(
                    "{hash}: failed to read {}: {error}",
                    from.display()
                ));
                continue;
            }
        };
        if ContentStore::hash_bytes(&bytes) != *hash {
            report.corrupt.push(hash.clone());
            report.warnings.push(format!(
                "{hash}: sha256 of {} does not match its name; not copied",
                from.display()
            ));
            continue;
        }
        if write {
            // `to` is guaranteed absent here (the `to.is_file()` check above
            // already `continue`d otherwise). A per-blob write failure (disk
            // full, permissions, a concurrent run racing `atomic_create`'s
            // `AlreadyExists`) must not abort the whole migration — warn and
            // move on, mirroring `missing`/`corrupt`/the read failure above.
            if let Err(error) = copy_blob(&to, &bytes) {
                report.failed.push(hash.clone());
                report
                    .warnings
                    .push(format!("{hash}: failed to write {}: {error}", to.display()));
                continue;
            }
        }
        report.bytes_copied += bytes.len() as u64;
        report.copied.push(hash.clone());
    }

    report.orphans_left = list_blob_hashes(&source)
        .iter()
        .filter(|h| !scan.refs.contains_key(*h))
        .count() as u64;

    if write {
        let store = ContentStore::open(&dest)?;
        report.rebuild = Some(store.rebuild_metadata(&scan, true)?);
    }
    Ok(report)
}

/// Publish one blob's bytes at `to` (a path inside the destination's
/// fan-out), creating its parent directory first. `atomic_create` — not
/// `atomic_replace`, which requires an existing destination to read
/// permissions from — is the correct primitive: callers only reach here for
/// a `to` that doesn't exist yet.
fn copy_blob(to: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(to.parent().expect("fan-out parent"))?;
    crate::vault::atomic_file::atomic_create(to, bytes)?;
    Ok(())
}

/// Fill in a content type, from the source's own `cas.db`, for every
/// referenced hash the frontmatter scan left untyped (a legacy string blob
/// entry with no `type`). Frontmatter types always win — only gaps are
/// filled. Returns the number of hashes filled.
///
/// Not fatal: a source with no `cas.db`, or one that can't be opened or
/// queried, contributes nothing here (one warning for the latter case) and
/// `rebuild_metadata` falls back to `application/octet-stream` as before.
fn fill_types_from_source_db(
    scan: &mut ArchiveRefScan,
    source: &Path,
    warnings: &mut Vec<String>,
) -> u64 {
    let db_path = source.join("cas.db");
    if !db_path.is_file() {
        return 0;
    }
    let source_types = match read_source_blob_types(&db_path) {
        Ok(types) => types,
        Err(error) => {
            warnings.push(format!(
                "{}: could not read content types from source cas.db: {error}",
                db_path.display()
            ));
            return 0;
        }
    };
    let untyped_refs: Vec<String> = scan
        .refs
        .keys()
        .filter(|hash| !scan.types.contains_key(*hash))
        .cloned()
        .collect();
    let mut filled = 0u64;
    for hash in untyped_refs {
        if let Some(content_type) = source_types.get(&hash) {
            scan.types.insert(hash, content_type.clone());
            filled += 1;
        }
    }
    filled
}

/// Read every `hash -> content_type` row from a `cas.db` at `db_path`,
/// opened read-only so a concurrently running server holding the source
/// store's exclusive lock is never contended.
fn read_source_blob_types(
    db_path: &Path,
) -> Result<std::collections::BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )?;
    let mut statement = conn.prepare("SELECT hash, content_type FROM blobs")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut types = std::collections::BTreeMap::new();
    for row in rows {
        let (hash, content_type) = row?;
        types.insert(hash, content_type);
    }
    Ok(types)
}

/// The legacy default store, if it exists and holds a `cas.db` (a hint target
/// for doctor/serve).
pub fn legacy_store_with_blobs() -> Option<PathBuf> {
    let path = crate::expand_tilde(LEGACY_DEFAULT_CAS_PATH)?;
    (path.join("cas.db").is_file()).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::vault::cas::{ContentStore, blob_relative_path};
    use std::fs;

    /// Bytes → (hash, bytes). Distinct inputs give distinct blobs.
    fn blob(bytes: &[u8]) -> (String, Vec<u8>) {
        (ContentStore::hash_bytes(bytes), bytes.to_vec())
    }

    fn write_blob(root: &std::path::Path, hash: &str, bytes: &[u8]) {
        let p = root.join(blob_relative_path(hash).unwrap());
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    /// Vault with one archive page referencing `snap` (snapshot, text/html) and
    /// `img` (typed image/png), and a second page referencing `gone` (never in
    /// the source). Source store holds snap, img, and an orphan.
    fn fixture() -> (tempfile::TempDir, Vault, std::path::PathBuf, [String; 4]) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let (snap, snap_b) = blob(b"<html>snap</html>");
        let (img, img_b) = blob(b"\x89PNG img");
        let (orphan, orphan_b) = blob(b"orphan");
        let (gone, _) = blob(b"gone");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), format!(
            "+++\nid = \"01900000-0000-7000-8000-00000000000a\"\ntitle = \"A\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\n[archive]\nsnapshot_hash = \"{snap}\"\nblobs = [{{ hash = \"{img}\", type = \"image/png\" }}]\n+++\nbody\n")).unwrap();
        fs::write(root.join("notes/b.md"), format!(
            "+++\nid = \"01900000-0000-7000-8000-00000000000b\"\ntitle = \"B\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\n[archive]\nsnapshot_hash = \"{gone}\"\n+++\nbody\n")).unwrap();
        let source = tmp.path().join("old-cas");
        write_blob(&source, &snap, &snap_b);
        write_blob(&source, &img, &img_b);
        write_blob(&source, &orphan, &orphan_b);
        fs::write(source.join("cas.db"), b"not copied").unwrap();
        let vault = Vault::open(&root).unwrap(); // default cas_path → <root>/.clepsydra/cas
        (tmp, vault, source, [snap, img, orphan, gone])
    }

    #[test]
    fn dry_run_reports_the_plan_and_creates_nothing() {
        let (_tmp, vault, source, [snap, img, _orphan, gone]) = fixture();
        let report = migrate(&vault, &source, false).unwrap();
        assert!(report.dry_run);
        assert_eq!(
            report.copied,
            vec![img.clone(), snap.clone()]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
        );
        assert_eq!(report.missing, vec![gone]);
        assert_eq!(report.orphans_left, 1);
        assert!(report.rebuild.is_none());
        assert!(
            !vault.cas_root().exists(),
            "dry run must not create the store"
        );
    }

    #[test]
    fn write_copies_referenced_blobs_verifies_them_and_rebuilds_cas_db() {
        let (_tmp, vault, source, [snap, img, orphan, gone]) = fixture();
        let report = migrate(&vault, &source, true).unwrap();
        let dest = vault.cas_root();
        assert!(dest.join(blob_relative_path(&snap).unwrap()).exists());
        assert!(dest.join(blob_relative_path(&img).unwrap()).exists());
        assert!(
            !dest.join(blob_relative_path(&orphan).unwrap()).exists(),
            "orphans stay behind"
        );
        assert_eq!(report.missing, vec![gone.clone()]);
        assert!(report.warnings.iter().any(|w| w.contains(&gone)));
        assert_eq!(
            fs::read(source.join("cas.db")).unwrap(),
            b"not copied",
            "source untouched"
        );
        let rebuild = report.rebuild.expect("write rebuilds cas.db");
        assert_eq!(rebuild.rows_written, 2);
        let conn = rusqlite::Connection::open(dest.join("cas.db")).unwrap();
        let ty: String = conn
            .query_row(
                "SELECT content_type FROM blobs WHERE hash = ?1",
                [&img],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ty, "image/png");
        let ty: String = conn
            .query_row(
                "SELECT content_type FROM blobs WHERE hash = ?1",
                [&snap],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ty, "text/html");
        drop(conn);
        // second run: nothing left to copy
        let again = migrate(&vault, &source, true).unwrap();
        assert!(again.copied.is_empty());
        assert_eq!(again.already_present.len(), 2);
    }

    #[test]
    fn corrupt_source_blob_is_skipped_with_warning() {
        let (_tmp, vault, source, [_snap, img, _orphan, _gone]) = fixture();
        fs::write(source.join(blob_relative_path(&img).unwrap()), b"tampered").unwrap();
        let report = migrate(&vault, &source, true).unwrap();
        assert_eq!(report.corrupt, vec![img.clone()]);
        assert!(
            !vault
                .cas_root()
                .join(blob_relative_path(&img).unwrap())
                .exists()
        );
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains(&img) && w.contains("sha256"))
        );
    }

    #[test]
    fn same_store_and_missing_source_are_errors() {
        let (_tmp, vault, source, _) = fixture();
        assert!(migrate(&vault, &vault.cas_root(), false).is_err());
        assert!(migrate(&vault, &source.join("nope"), false).is_err());
    }

    #[test]
    fn unreadable_source_blob_is_skipped_with_warning_others_still_copied() {
        let (_tmp, vault, source, [snap, img, _orphan, _gone]) = fixture();
        // Replace the img blob file with a directory of the same name, so
        // `from.exists()` is true but `fs::read` fails — an I/O failure
        // distinct from "missing" or "corrupt".
        let img_path = source.join(blob_relative_path(&img).unwrap());
        fs::remove_file(&img_path).unwrap();
        fs::create_dir_all(&img_path).unwrap();

        let report = migrate(&vault, &source, true).unwrap();

        assert_eq!(report.failed, vec![img.clone()]);
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains(&img) && w.contains(&img_path.display().to_string())),
            "warning must name the hash and the path: {:?}",
            report.warnings
        );
        // The other referenced blob is unaffected.
        assert!(
            vault
                .cas_root()
                .join(blob_relative_path(&snap).unwrap())
                .exists()
        );
        assert!(report.rebuild.is_some(), "run still completes and rebuilds");
    }

    #[test]
    fn rubbish_item_reference_is_migrated() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let (rub_hash, rub_bytes) = blob(b"<html>rubbish snap</html>");
        let item = root.join(".clepsydra/rubbish/0190aaaa-0000-7000-8000-000000000001");
        fs::create_dir_all(&item).unwrap();
        fs::write(item.join("page.md"), format!(
            "+++\nid = \"01900000-0000-7000-8000-00000000000c\"\ntitle = \"C\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\n[archive]\nsnapshot_hash = \"{rub_hash}\"\n+++\nbody\n"
        )).unwrap();
        fs::write(item.join("manifest.json"), "{}").unwrap();
        let source = tmp.path().join("old-cas");
        write_blob(&source, &rub_hash, &rub_bytes);
        fs::write(source.join("cas.db"), b"not copied").unwrap();
        let vault = Vault::open(&root).unwrap();

        let report = migrate(&vault, &source, true).unwrap();

        assert_eq!(report.copied, vec![rub_hash.clone()]);
        let dest = vault.cas_root();
        assert!(dest.join(blob_relative_path(&rub_hash).unwrap()).exists());
        let conn = rusqlite::Connection::open(dest.join("cas.db")).unwrap();
        let ref_count: i64 = conn
            .query_row(
                "SELECT ref_count FROM blobs WHERE hash = ?1",
                [&rub_hash],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ref_count, 1);
    }

    #[test]
    fn legacy_string_entries_get_content_type_from_source_cas_db() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let (snap, snap_b) = blob(b"<html>snap</html>");
        let (img, img_b) = blob(b"\x89PNG img");
        let (pdf, pdf_b) = blob(b"%PDF-1.4 doc");
        fs::create_dir_all(root.join("notes")).unwrap();
        // `img` is typed in frontmatter; `pdf` is only a legacy string
        // entry (no `type`), so it depends on the source cas.db.
        fs::write(root.join("notes/a.md"), format!(
            "+++\nid = \"01900000-0000-7000-8000-00000000000a\"\ntitle = \"A\"\ncreated_at = \"2026-01-01T00:00:00Z\"\nupdated_at = \"2026-01-01T00:00:00Z\"\n\n[archive]\nsnapshot_hash = \"{snap}\"\nblobs = [{{ hash = \"{img}\", type = \"image/png\" }}, \"{pdf}\"]\n+++\nbody\n")).unwrap();
        let source = tmp.path().join("old-cas");
        write_blob(&source, &snap, &snap_b);
        write_blob(&source, &img, &img_b);
        write_blob(&source, &pdf, &pdf_b);

        // Source cas.db types `img` with a CONFLICTING type (frontmatter
        // must still win) and `pdf` with its real type (its only source of
        // truth, since it has no frontmatter type).
        let conn = rusqlite::Connection::open(source.join("cas.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE blobs (
                hash TEXT PRIMARY KEY,
                size INTEGER,
                content_type TEXT,
                created_at TEXT,
                ref_count INTEGER
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO blobs (hash, size, content_type, created_at, ref_count) \
             VALUES (?1, 0, 'text/plain', '2026-01-01T00:00:00Z', 1)",
            [&img],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO blobs (hash, size, content_type, created_at, ref_count) \
             VALUES (?1, 0, 'application/pdf', '2026-01-01T00:00:00Z', 1)",
            [&pdf],
        )
        .unwrap();
        drop(conn);
        let source_db_before = fs::read(source.join("cas.db")).unwrap();

        let vault = Vault::open(&root).unwrap();
        let report = migrate(&vault, &source, true).unwrap();

        assert_eq!(
            report.types_from_source, 1,
            "only pdf lacked a frontmatter type"
        );
        assert_eq!(
            fs::read(source.join("cas.db")).unwrap(),
            source_db_before,
            "source cas.db untouched"
        );

        let dest = vault.cas_root();
        let dest_conn = rusqlite::Connection::open(dest.join("cas.db")).unwrap();
        let img_ty: String = dest_conn
            .query_row(
                "SELECT content_type FROM blobs WHERE hash = ?1",
                [&img],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(img_ty, "image/png", "frontmatter type wins over source db");
        let pdf_ty: String = dest_conn
            .query_row(
                "SELECT content_type FROM blobs WHERE hash = ?1",
                [&pdf],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pdf_ty, "application/pdf",
            "legacy string entry typed from source cas.db"
        );
        let rebuild = report.rebuild.expect("write rebuilds cas.db");
        assert!(!rebuild.untyped_blobs.contains(&pdf));
    }
}
