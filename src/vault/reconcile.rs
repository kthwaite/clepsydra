//! Reconcile: move drifted pages to their projected folder via the MovePage
//! planner. Idempotent and conservative (see projection.rs). Never called from
//! the read-only index build — only from serve startup, LSP save, and assign.

use super::Vault;
use super::hooks::PostMoveHook;
use super::index::{IndexError, VaultIndex};
use super::mutation::{MutationOp, MutationPlanner};
use super::page::Page;
use super::path::VaultPath;
use super::projection::project_path;

/// Reconcile a single page. Returns `Some(new_path)` if it was moved, else
/// `None`. Reads declared kind/project from the file's frontmatter. `hooks`
/// fire after a move (e.g. `AcademicMoveHook` rewrites work paths in
/// annotations); pass `&[]` when no post-move side effects are wanted.
pub fn reconcile_page(
    vault: &Vault,
    index: &mut VaultIndex,
    path: &str,
    hooks: &[Box<dyn PostMoveHook>],
) -> Result<Option<String>, IndexError> {
    let vp = VaultPath::new(path).map_err(|e| IndexError::Other(e.to_string()))?;
    let abs = vault.resolve(&vp);
    if !abs.exists() {
        return Ok(None);
    }
    let page = Page::from_file(&abs, vp.clone()).map_err(|e| IndexError::Other(e.to_string()))?;
    let Some(dest) = project_path(path, page.meta.kind, page.meta.project.as_deref()) else {
        return Ok(None);
    };
    // Collision-free by construction (Plan 2), but guard anyway.
    let dest_vp = VaultPath::new(&dest).map_err(|e| IndexError::Other(e.to_string()))?;
    if vault.resolve(&dest_vp).exists() {
        return Ok(None);
    }
    // Plan the move; the planner's immutable borrow of `index` ends when `plan`
    // is returned, freeing `index` for the mutable `execute` call.
    let plan = {
        let planner = MutationPlanner::new(vault, index);
        planner.plan(&MutationOp::MovePage {
            source: path.to_string(),
            destination: dest.clone(),
        })?
    };
    plan.execute(vault, index, hooks)?;
    Ok(Some(dest))
}

/// Reconcile every page in the index. Returns the number moved. Best-effort:
/// a page that fails to reconcile is logged and skipped, and the sweep continues.
/// `hooks` are forwarded to every per-page reconcile (see `reconcile_page`).
pub fn reconcile_all(
    vault: &Vault,
    index: &mut VaultIndex,
    hooks: &[Box<dyn PostMoveHook>],
) -> Result<usize, IndexError> {
    // Snapshot the page paths up front so we don't hold a borrow of the index
    // (or iterate a table we are concurrently mutating) during the moves.
    let paths: Vec<String> = {
        let mut stmt = index
            .connection()
            .prepare("SELECT path FROM pages ORDER BY path")?;
        stmt.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?
    };
    let mut moved = 0;
    for path in paths {
        match reconcile_page(vault, index, &path, hooks) {
            Ok(Some(_)) => moved += 1,
            Ok(None) => {}
            Err(e) => tracing::warn!("reconcile: skipping {path}: {e}"),
        }
    }
    Ok(moved)
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

    #[test]
    fn moves_declared_kind_and_is_idempotent() {
        let (_tmp, vault, mut index) = fixture_with_pages(&[(
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-00000000000c\ntype: quote\n---\nbody",
        )]);
        let dest = reconcile_page(&vault, &mut index, "notes/q.md", &[]).unwrap();
        assert_eq!(dest.as_deref(), Some("quotes/q.md"));
        assert_eq!(
            reconcile_page(&vault, &mut index, "quotes/q.md", &[]).unwrap(),
            None
        );
    }

    #[test]
    fn leaves_undeclared_pages_untouched() {
        let (_tmp, vault, mut index) = fixture_with_pages(&[(
            "notes/sub/x.md",
            "---\nid: 0190f8a0-0000-7000-8000-00000000000d\n---\nbody",
        )]);
        assert_eq!(
            reconcile_page(&vault, &mut index, "notes/sub/x.md", &[]).unwrap(),
            None
        );
    }

    #[test]
    fn skips_when_destination_exists() {
        // `notes/q.md` declares `type: quote` (projects to `quotes/q.md`), but a
        // file already lives there. The collision guard must refuse the move.
        let (_tmp, vault, mut index) = fixture_with_pages(&[
            (
                "notes/q.md",
                "---\nid: 0190f8a0-0000-7000-8000-00000000000e\ntype: quote\n---\nbody",
            ),
            (
                "quotes/q.md",
                "---\nid: 0190f8a0-0000-7000-8000-00000000000f\n---\noccupied",
            ),
        ]);
        assert_eq!(
            reconcile_page(&vault, &mut index, "notes/q.md", &[]).unwrap(),
            None
        );
        // Source untouched; destination not overwritten.
        assert!(vault.resolve(&VaultPath::new("notes/q.md").unwrap()).exists());
        let dest_body =
            fs::read_to_string(vault.resolve(&VaultPath::new("quotes/q.md").unwrap())).unwrap();
        assert!(dest_body.contains("occupied"), "destination overwritten: {dest_body}");
    }
}
