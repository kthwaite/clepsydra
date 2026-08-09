use std::collections::HashSet;

use rusqlite::{Transaction, params};

use crate::vault::block::BlockType;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;

/// Derives block rows and block_properties rows from a page's parsed blocks.
pub struct BlockDeriver;

impl Deriver for BlockDeriver {
    fn name(&self) -> &str {
        "blocks"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        let mut span_starts = HashSet::with_capacity(page.blocks.len());
        for block in &page.blocks {
            if !span_starts.insert(block.span.start) {
                return Err(IndexError::Other(format!(
                    "duplicate block span_start {} while indexing {}",
                    block.span.start,
                    page.vault_path.as_str()
                )));
            }
        }

        for block in &page.blocks {
            let parent_id = block
                .parent_index
                .and_then(|pi| page.blocks.get(pi))
                .and_then(|parent| parent.block_id.as_deref());

            let block_type_str = match block.block_type {
                BlockType::Paragraph => "paragraph",
                BlockType::ListItem => "listitem",
                BlockType::Heading => "heading",
                BlockType::Code => "code",
                BlockType::Blockquote => "blockquote",
            };

            tx.execute(
                "INSERT INTO blocks (block_id, page_id, block_type, parent_id, order_index, content, depth, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    block.block_id,
                    page_id,
                    block_type_str,
                    parent_id,
                    block.order_index as i64,
                    block.content,
                    block.depth as i64,
                    block.span.start as i64,
                    block.span.end as i64,
                ],
            )?;

            for (key, value) in &block.properties {
                tx.execute(
                    "INSERT INTO block_properties (page_id, span_start, key, value) VALUES (?1, ?2, ?3, ?4)",
                    params![page_id, block.span.start as i64, key, value],
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use rusqlite::Connection;

    use super::*;
    use crate::vault::block::Block;
    use crate::vault::canonical::CanonicalName;
    use crate::vault::page::PageMeta;
    use crate::vault::path::VaultPath;

    #[test]
    fn duplicate_span_starts_return_a_domain_error() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE blocks (
                    block_id TEXT,
                    page_id TEXT NOT NULL,
                    block_type TEXT NOT NULL,
                    parent_id TEXT,
                    order_index INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    depth INTEGER NOT NULL,
                    span_start INTEGER NOT NULL,
                    span_end INTEGER NOT NULL,
                    PRIMARY KEY (page_id, span_start)
                );
                CREATE TABLE block_properties (
                    page_id TEXT NOT NULL,
                    span_start INTEGER NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    PRIMARY KEY (page_id, span_start, key)
                );",
            )
            .unwrap();
        let duplicate = |content: &str| Block {
            block_type: BlockType::Paragraph,
            content: content.to_string(),
            block_id: None,
            properties: HashMap::new(),
            checkbox: None,
            depth: 0,
            parent_index: None,
            order_index: 0,
            span: 7..12,
        };
        let page = IndexedPage {
            vault_path: VaultPath::new("duplicate.md").unwrap(),
            abs_path: PathBuf::from("duplicate.md"),
            meta: PageMeta::default(),
            body: "first\nsecond\n".to_string(),
            encrypted: false,
            raw_body: "first\nsecond\n".to_string(),
            content_hash: String::new(),
            body_links: Vec::new(),
            prop_links: Vec::new(),
            canonical: CanonicalName::new("duplicate"),
            blocks: vec![duplicate("first"), duplicate("second")],
        };
        let transaction = connection.transaction().unwrap();

        let error = BlockDeriver
            .derive(&page, "page-id", &transaction)
            .unwrap_err();

        assert!(matches!(error, IndexError::Other(message)
                if message == "duplicate block span_start 7 while indexing duplicate.md"));
    }
}
