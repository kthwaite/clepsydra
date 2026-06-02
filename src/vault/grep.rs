//! FTS search for the `clepsydra grep` CLI subcommand.

use crate::vault::index::{IndexError, SearchResult, VaultIndex};

/// Run an FTS search. When `raw` is false the query is quoted as a literal
/// phrase via [`fts_quote`]; when true it is passed straight to FTS5 `MATCH`,
/// exposing the full operator syntax.
pub fn run(
    index: &VaultIndex,
    query: &str,
    limit: usize,
    raw: bool,
) -> Result<Vec<SearchResult>, IndexError> {
    let prepared = if raw { query.to_string() } else { fts_quote(query) };
    index.search(&prepared, limit)
}

/// Quote a raw user query as a single FTS5 phrase: surround in double quotes
/// and double any embedded `"`. This makes arbitrary input safe to pass to
/// `MATCH` — stray quotes or bare operators become literal tokens instead of
/// FTS5 syntax errors.
pub fn fts_quote(query: &str) -> String {
    let escaped = query.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_quote_wraps_plain_phrase() {
        assert_eq!(fts_quote("hello world"), "\"hello world\"");
    }

    #[test]
    fn fts_quote_doubles_embedded_quotes() {
        // he said "hi" -> "he said ""hi"""
        assert_eq!(fts_quote("he said \"hi\""), "\"he said \"\"hi\"\"\"");
    }

    #[test]
    fn fts_quote_neutralizes_operators() {
        // A bare FTS5 operator becomes a literal token inside the phrase.
        assert_eq!(fts_quote("foo OR bar"), "\"foo OR bar\"");
    }

    use crate::vault::index::VaultIndex;
    use crate::vault::Vault;

    /// Build a temp vault with one note, return (TempDir, Vault, VaultIndex).
    fn vault_with_note(filename: &str, body: &str) -> (tempfile::TempDir, Vault, VaultIndex) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(root.join(filename), body).unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (dir, vault, index)
    }

    #[test]
    fn run_finds_a_seeded_note() {
        let (_dir, _vault, index) = vault_with_note(
            "Photosynthesis.md",
            "---\ntitle: Photosynthesis\n---\nChloroplasts capture sunlight.\n",
        );
        let results = run(&index, "chloroplasts", 20, false).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "Photosynthesis.md");
        assert!(results[0].snippet.contains("<mark>"));
    }

    #[test]
    fn run_literal_query_with_quotes_does_not_error() {
        let (_dir, _vault, index) = vault_with_note(
            "Quote.md",
            "---\ntitle: Quote\n---\nbody text\n",
        );
        // Without --raw, an embedded quote must not produce an FTS5 error.
        let results = run(&index, "stray \" quote", 20, false).unwrap();
        assert!(results.is_empty());
    }
}
