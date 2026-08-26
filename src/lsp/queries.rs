//! Shared index queries used by multiple LSP request handlers.
use crate::vault::index_handle::IndexHandle;

/// Resolve a canonical name to the vault path of the first matching page.
/// Returns `None` if there is no match or the query fails (matching the
/// previous inline `.ok()` behavior).
pub async fn canonical_to_vault_path(index: &IndexHandle, canonical: &str) -> Option<String> {
    let canonical = canonical.to_string();
    index
        .with_index(move |idx, _vault| {
            idx.connection()
                .query_row(
                    "SELECT p.path FROM canonical_names cn \
                     JOIN pages p ON cn.page_id = p.id \
                     WHERE cn.canonical_name = ?1 LIMIT 1",
                    rusqlite::params![canonical],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .await
        .ok()
        .flatten()
}

/// A block resolved by its ID: defining page and body span.
pub struct BlockLookup {
    pub path: String,
    pub content: String,
    pub span_start: usize,
    pub span_end: usize,
}

/// Resolve a block ID to its defining page and span. `None` when the ID is
/// unknown or the query fails.
pub async fn block_by_id(index: &IndexHandle, block_id: &str) -> Option<BlockLookup> {
    let block_id = block_id.to_string();
    index
        .with_index(move |idx, _vault| {
            idx.connection()
                .query_row(
                    "SELECT p.path, b.content, b.span_start, b.span_end \
                     FROM blocks b JOIN pages p ON p.id = b.page_id \
                     WHERE b.block_id = ?1 LIMIT 1",
                    rusqlite::params![block_id],
                    |row| {
                        Ok(BlockLookup {
                            path: row.get(0)?,
                            content: row.get(1)?,
                            span_start: row.get::<_, i64>(2)? as usize,
                            span_end: row.get::<_, i64>(3)? as usize,
                        })
                    },
                )
                .ok()
        })
        .await
        .ok()
        .flatten()
}

/// A page location containing a `((block_id))` reference.
pub struct BlockRefSource {
    pub source_path: String,
    pub span_start: i64,
    pub span_end: i64,
}

/// Every indexed `((block_id))` reference, ordered by page then position.
/// Empty on unknown ID or query failure.
pub async fn block_ref_sources(index: &IndexHandle, block_id: &str) -> Vec<BlockRefSource> {
    let block_id = block_id.to_string();
    index
        .with_index(
            move |idx, _vault| -> std::result::Result<Vec<_>, rusqlite::Error> {
                let mut stmt = idx.connection().prepare(
                    "SELECT p.path, l.span_start, l.span_end \
                 FROM links l JOIN pages p ON p.id = l.source_id \
                 WHERE l.target_block_id = ?1 \
                 ORDER BY p.path, l.span_start",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![block_id], |row| {
                        Ok(BlockRefSource {
                            source_path: row.get(0)?,
                            span_start: row.get(1)?,
                            span_end: row.get(2)?,
                        })
                    })?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(rows)
            },
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::test_support::make_backend;

    #[tokio::test]
    async fn resolves_known_canonical_name() {
        let (backend, _tmp) = make_backend(&[("Target.md", "---\ntitle: Target\n---\nbody\n")]);
        let path = canonical_to_vault_path(&backend.state().unwrap().index, "target").await;
        assert_eq!(path.as_deref(), Some("Target.md"));
    }

    #[tokio::test]
    async fn unknown_name_returns_none() {
        let (backend, _tmp) = make_backend(&[("Target.md", "# Target\n")]);
        assert!(
            canonical_to_vault_path(&backend.state().unwrap().index, "nope")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn block_by_id_resolves_defining_page() {
        let (backend, _tmp) =
            make_backend(&[("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n")]);
        let hit = block_by_id(&backend.state().unwrap().index, "blk123XYZ99")
            .await
            .expect("block found");
        assert_eq!(hit.path, "Ref.md");
        assert!(hit.content.contains("A fact worth citing"));
        assert!(hit.span_end > hit.span_start);
    }

    #[tokio::test]
    async fn block_by_id_unknown_returns_none() {
        let (backend, _tmp) = make_backend(&[("Ref.md", "# Ref\nplain\n")]);
        assert!(
            block_by_id(&backend.state().unwrap().index, "nope123456")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn block_ref_sources_lists_referrers() {
        let (backend, _tmp) = make_backend(&[
            ("Ref.md", "# Ref\n\nA fact worth citing ^blk123XYZ99\n"),
            ("Src.md", "# Src\n\nsee ((blk123XYZ99))\n"),
        ]);
        let sources = block_ref_sources(&backend.state().unwrap().index, "blk123XYZ99").await;
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].source_path, "Src.md");
        assert!(sources[0].span_end > sources[0].span_start);
    }
}
