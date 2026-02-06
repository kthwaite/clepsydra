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

        // 3. Each alias
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
