use rusqlite::{Transaction, params};

use crate::vault::canonical::CanonicalName;
use crate::vault::derivation::{Deriver, IndexedPage};
use crate::vault::index::IndexError;
use crate::vault::link::LinkKind;

/// Derives link rows (body links + property ref links) for a page.
pub struct LinkDeriver;

impl Deriver for LinkDeriver {
    fn name(&self) -> &str {
        "links"
    }

    fn derive(
        &self,
        page: &IndexedPage,
        page_id: &str,
        tx: &Transaction,
    ) -> Result<(), IndexError> {
        // Body links (non-negative span_start)
        for link in &page.body_links {
            let (kind_str, source_field) = match &link.kind {
                LinkKind::Wiki => ("wiki", None),
                LinkKind::Markdown => ("markdown", None),
                LinkKind::PropertyRef { source_field } => {
                    ("property_ref", Some(source_field.clone()))
                }
                LinkKind::BlockRef => ("block_ref", None),
            };
            let target_canonical = CanonicalName::new(&link.target_raw);
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, kind, source_field, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    page_id,
                    link.target_raw,
                    target_canonical.as_str(),
                    kind_str,
                    source_field,
                    link.span.start as i64,
                    link.span.end as i64,
                ],
            )?;
        }

        // Property ref links (negative span_start to avoid PK collision)
        for (i, link) in page.prop_links.iter().enumerate() {
            let (kind_str, source_field) = match &link.kind {
                LinkKind::Wiki => ("wiki", None),
                LinkKind::Markdown => ("markdown", None),
                LinkKind::PropertyRef { source_field } => {
                    ("property_ref", Some(source_field.clone()))
                }
                LinkKind::BlockRef => ("block_ref", None),
            };
            let target_canonical = CanonicalName::new(&link.target_raw);
            let neg_span = -((i as i64) + 1);
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, kind, source_field, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    page_id,
                    link.target_raw,
                    target_canonical.as_str(),
                    kind_str,
                    source_field,
                    neg_span,
                    0i64,
                ],
            )?;
        }

        Ok(())
    }
}
