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
