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
            let (kind_str, source_field, target_canonical, target_block_id) = match &link.kind {
                LinkKind::Wiki => {
                    let cn = CanonicalName::new(&link.target_raw);
                    ("wiki", None, Some(cn.as_str().to_owned()), None)
                }
                LinkKind::Markdown => {
                    let cn = CanonicalName::new(&link.target_raw);
                    ("markdown", None, Some(cn.as_str().to_owned()), None)
                }
                LinkKind::PropertyRef { source_field } => {
                    let cn = CanonicalName::new(&link.target_raw);
                    (
                        "property_ref",
                        Some(source_field.clone()),
                        Some(cn.as_str().to_owned()),
                        None,
                    )
                }
                LinkKind::BlockRef => ("block_ref", None, None, Some(link.target_raw.clone())),
            };
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, target_block_id, kind, source_field, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    page_id,
                    link.target_raw,
                    target_canonical,
                    target_block_id,
                    kind_str,
                    source_field,
                    link.span.start as i64,
                    link.span.end as i64,
                ],
            )?;
        }

        // Property ref links (negative span_start to avoid PK collision)
        for (i, link) in page.prop_links.iter().enumerate() {
            let (kind_str, source_field, target_canonical) = match &link.kind {
                LinkKind::Wiki => {
                    let cn = CanonicalName::new(&link.target_raw);
                    ("wiki", None, Some(cn.as_str().to_owned()))
                }
                LinkKind::Markdown => {
                    let cn = CanonicalName::new(&link.target_raw);
                    ("markdown", None, Some(cn.as_str().to_owned()))
                }
                LinkKind::PropertyRef { source_field } => {
                    let cn = CanonicalName::new(&link.target_raw);
                    (
                        "property_ref",
                        Some(source_field.clone()),
                        Some(cn.as_str().to_owned()),
                    )
                }
                LinkKind::BlockRef => ("block_ref", None, None),
            };
            let neg_span = -((i as i64) + 1);
            tx.execute(
                "INSERT OR IGNORE INTO links (source_id, target_raw, target_canonical, target_block_id, kind, source_field, span_start, span_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    page_id,
                    link.target_raw,
                    target_canonical,
                    None::<String>,
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
