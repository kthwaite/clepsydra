use rusqlite::{Connection, params};

use crate::derivation::{Deriver, IndexedPage};
use crate::index::IndexError;

/// Derives editable and computed tag rows from a page's effective Kind tags.
pub struct TagDeriver;

impl Deriver for TagDeriver {
    fn name(&self) -> &str {
        "tags"
    }

    fn derive(&self, page: &IndexedPage, page_id: &str, tx: &Connection) -> Result<(), IndexError> {
        let kind = clep_vault::kind::resolve(page.vault_path.as_str(), page.meta.kind).0;
        for tag in clep_vault::kind::editable_tags(kind, &page.meta.tags) {
            tx.execute(
                "INSERT INTO tags (page_id, tag, computed) VALUES (?1, ?2, 0)",
                params![page_id, tag],
            )?;
        }
        tx.execute(
            "INSERT INTO tags (page_id, tag, computed) VALUES (?1, ?2, 1)",
            params![page_id, kind.computed_tag()],
        )?;
        Ok(())
    }
}
