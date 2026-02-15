use rusqlite::{Transaction, params};

use crate::vault::canonical::CanonicalName;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives canonical name entries (title, filename, aliases) for a page.
pub struct CanonicalNameDeriver;

impl Deriver for CanonicalNameDeriver {
    fn name(&self) -> &str {
        "canonical_names"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        // 1. Title-derived canonical name
        if let Some(ref title) = page.meta.title {
            let cn = CanonicalName::from_title(title);
            tx.execute(
                "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'title')",
                params![cn.as_str(), page_id],
            )?;
        }

        // 2. Filename-derived canonical name
        let fn_cn = CanonicalName::from_filename(page.vault_path.filename());
        tx.execute(
            "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'filename')",
            params![fn_cn.as_str(), page_id],
        )?;

        // 3. Path-stem canonical name (full path without .md extension).
        // Enables disambiguation of pages with identical filenames in different
        // folders, e.g. [[notes/foo]] resolves to notes/foo.md.
        // Only added when the path has a directory component (otherwise it
        // duplicates the filename-derived entry above).
        let path_str = page.vault_path.as_str();
        let path_stem = path_str.strip_suffix(".md").unwrap_or(path_str);
        if path_stem.contains('/') {
            let path_cn = CanonicalName::from_title(path_stem);
            tx.execute(
                "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'path')",
                params![path_cn.as_str(), page_id],
            )?;
        }

        // 4. Each alias
        for alias in &page.meta.aliases {
            let alias_cn = CanonicalName::from_title(alias);
            tx.execute(
                "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'alias')",
                params![alias_cn.as_str(), page_id],
            )?;
        }

        Ok(())
    }
}
