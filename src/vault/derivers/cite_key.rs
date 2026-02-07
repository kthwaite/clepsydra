use rusqlite::{Transaction, params};

use crate::vault::canonical::CanonicalName;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives a canonical name entry from the `cite_key` frontmatter field,
/// enabling wikilink resolution via cite keys (e.g. `[[vaswani2017attention]]`).
pub struct CiteKeyDeriver;

impl Deriver for CiteKeyDeriver {
    fn name(&self) -> &str {
        "cite_key"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        let cite_key = match page.meta.extra.get("cite_key") {
            Some(v) => match v.as_str() {
                Some(s) if !s.is_empty() => s,
                _ => return Ok(()),
            },
            None => return Ok(()),
        };

        let cn = CanonicalName::new(cite_key);
        tx.execute(
            "INSERT OR IGNORE INTO canonical_names (canonical_name, page_id, source) VALUES (?1, ?2, 'cite_key')",
            params![cn.as_str(), page_id],
        )?;

        Ok(())
    }
}
