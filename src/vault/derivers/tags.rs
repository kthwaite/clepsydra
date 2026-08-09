use rusqlite::{Connection, params};

use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives tag rows from a page's frontmatter tags.
pub struct TagDeriver;

impl Deriver for TagDeriver {
    fn name(&self) -> &str {
        "tags"
    }

    fn derive(&self, page: &IndexedPage, page_id: &str, tx: &Connection) -> Result<(), IndexError> {
        for tag in &page.meta.tags {
            tx.execute(
                "INSERT OR IGNORE INTO tags (page_id, tag) VALUES (?1, ?2)",
                params![page_id, tag],
            )?;
        }
        Ok(())
    }
}
