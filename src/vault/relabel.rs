//! One-off migration: rename authored pages to the canonical filename scheme
//! (docs/adr/0002), rewriting inbound links via the move planner. Idempotent:
//! pages already in canonical form are skipped.

use chrono::{DateTime, Utc};

use super::Vault;
use super::block_id::generate_short_id;
use super::index::{IndexError, VaultIndex};
use super::mutation::{MutationOp, MutationPlanner};
use super::mutation_coordinator::MutationCoordinator;
use super::page::Page;
use super::page_filename::page_filename;
use super::path::{VaultPath, is_canonical_page_filename};

/// Outcome of a relabel run.
#[derive(Debug, Default, PartialEq)]
pub struct RelabelReport {
    /// Pages renamed to canonical form. Under `dry_run`, this counts the pages
    /// that *would* be renamed — no file is moved and no link is rewritten.
    pub renamed: usize,
    pub skipped: usize,
}

/// Compute the canonical target path for a page, preserving its folder, using
/// `short_id` as the filename's id segment. Callers pass a freshly-generated
/// random id for real moves, or a literal placeholder for dry-run previews.
fn target_path(
    folder: Option<&str>,
    created: DateTime<Utc>,
    title: &str,
    short_id: &str,
) -> String {
    let filename = page_filename(created, title, short_id);
    match folder {
        Some(f) => format!("{f}/{filename}"),
        None => filename,
    }
}

/// Relabel every page in the index. With `dry_run`, plans but does not execute.
pub fn relabel(
    vault: &Vault,
    index: &mut VaultIndex,
    dry_run: bool,
) -> Result<RelabelReport, IndexError> {
    // Snapshot the page paths up front so we don't hold a borrow of the index
    // (or iterate a table we are concurrently mutating) during the moves.
    let rows: Vec<String> = {
        let mut stmt = index
            .connection()
            .prepare("SELECT path FROM pages ORDER BY path")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?
    };

    let mut report = RelabelReport::default();
    for path in rows {
        let vp = VaultPath::new(&path).map_err(|e| IndexError::Other(e.to_string()))?;
        if is_canonical_page_filename(vp.filename()) {
            report.skipped += 1;
            continue;
        }

        let abs = vault.resolve(&vp);
        let page =
            Page::from_file(&abs, vp.clone()).map_err(|e| IndexError::Other(e.to_string()))?;

        let created = page.meta.created_at.or(page.meta.updated_at);
        let Some(created) = created else {
            // No timestamp to derive the date prefix from: leave it, warn.
            tracing::warn!("relabel: skipping {path} (no created_at/updated_at)");
            report.skipped += 1;
            continue;
        };

        let title = page.meta.title.clone().unwrap_or_default();

        if dry_run {
            // Preview only: the id segment is random per page, so print a stable
            // placeholder rather than a value that changes every run.
            let preview = target_path(vp.parent(), created, &title, "<shortid>");
            println!("relabel: {path} -> {preview}");
            report.renamed += 1;
            continue;
        }

        let dest = target_path(vp.parent(), created, &title, &generate_short_id());

        let command = MutationPlanner::new(vault, index)
            .plan(&MutationOp::MovePage {
                source: path.clone(),
                destination: dest.clone(),
            })?
            .into_batch_command(vault)?;
        MutationCoordinator::execute_batch_direct(vault, index, &[], command)
            .map_err(|error| IndexError::Other(error.to_string()))?;
        report.renamed += 1;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// Build a temp vault populated with `pages` (rel-path, content), open the
    /// index and run a full build. Returns the owned `TempDir` (so the vault
    /// outlives the test), the `Vault`, and the built `VaultIndex`.
    fn fixture_with_pages(pages: &[(&str, &str)]) -> (tempfile::TempDir, Vault, VaultIndex) {
        let tmp = tempfile::tempdir().unwrap();
        for (rel, content) in pages {
            let abs = tmp.path().join(rel);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(&abs, content).unwrap();
        }
        let db_path = tmp.path().join(".clepsydra/index.db");
        // Use the full deriver chain (not open_bare) so that LinkDeriver runs
        // and inbound wikilinks land in the `links` table — otherwise there are
        // no backlinks for MovePage to rewrite.
        let mut index = VaultIndex::open(&db_path).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (tmp, vault, index)
    }

    /// List the `.md` filenames directly under `folder` in the vault.
    fn list_filenames(vault: &Vault, folder: &str) -> Vec<String> {
        let dir = vault.root().join(folder);
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".md"))
            .collect()
    }

    #[test]
    fn relabels_old_names_and_skips_canonical() {
        let (_tmp, vault, mut index) = fixture_with_pages(&[
            (
                "notes/My Note.md",
                "---\nid: 0190f8a0-0000-7000-8000-00000000000a\ntitle: My Note\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody",
            ),
            (
                "notes/20260101.x.aaaa0000.md",
                "---\nid: 0190f8a0-0000-7000-8000-00000000000b\ncreated_at: 2026-01-01T00:00:00Z\n---\nbody",
            ),
        ]);

        let report = relabel(&vault, &mut index, false).unwrap();
        assert_eq!(report.renamed, 1);
        assert_eq!(report.skipped, 1);

        // The old-style file is gone; a canonical one exists in notes/.
        let names = list_filenames(&vault, "notes");
        assert!(names.iter().all(|n| is_canonical_page_filename(n)));
        assert!(names.iter().any(|n| n.starts_with("20260531.my-note.")));

        // Idempotency: a second pass renames nothing and skips both.
        let report2 = relabel(&vault, &mut index, false).unwrap();
        assert_eq!(report2.renamed, 0);
        assert_eq!(report2.skipped, 2);
    }

    /// The whole point of routing through `MutationOp::MovePage` is that
    /// inbound `[[wikilinks]]` are rewritten to point at the renamed file.
    /// `linker.md` is given an already-canonical name so it is itself skipped
    /// and its path stays stable for read-back.
    #[test]
    fn rewrites_inbound_wikilinks_on_relabel() {
        let (_tmp, vault, mut index) = fixture_with_pages(&[
            (
                "notes/My Note.md",
                "---\nid: 0190f8a0-0000-7000-8000-00000000001a\ntitle: My Note\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody",
            ),
            (
                "notes/20260101.linker.bbbb0000.md",
                "---\nid: 0190f8a0-0000-7000-8000-00000000001b\ncreated_at: 2026-01-01T00:00:00Z\n---\nsee [[My Note]] for details",
            ),
        ]);

        let report = relabel(&vault, &mut index, false).unwrap();
        assert_eq!(report.renamed, 1);
        assert_eq!(report.skipped, 1);

        // The linker page kept its (canonical) name; read its body back.
        let linker_abs =
            vault.resolve(&VaultPath::new("notes/20260101.linker.bbbb0000.md").unwrap());
        let body = fs::read_to_string(&linker_abs).unwrap();

        // The wikilink now targets the renamed file's canonical stem...
        assert!(
            body.contains("[[20260531.my-note."),
            "expected rewritten wikilink, got: {body}"
        );
        // ...and no longer targets the old title.
        assert!(
            !body.contains("[[My Note]]"),
            "old wikilink target should be gone, got: {body}"
        );
    }
}
