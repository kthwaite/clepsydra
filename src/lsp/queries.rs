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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::test_support::make_backend;

    #[tokio::test]
    async fn resolves_known_canonical_name() {
        let (backend, _tmp) = make_backend(&[("Target.md", "---\ntitle: Target\n---\nbody\n")]);
        let path = canonical_to_vault_path(&backend.state.index, "target").await;
        assert_eq!(path.as_deref(), Some("Target.md"));
    }

    #[tokio::test]
    async fn unknown_name_returns_none() {
        let (backend, _tmp) = make_backend(&[("Target.md", "# Target\n")]);
        assert!(
            canonical_to_vault_path(&backend.state.index, "nope")
                .await
                .is_none()
        );
    }
}
