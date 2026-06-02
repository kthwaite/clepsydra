//! FTS search for the `clepsydra grep` CLI subcommand.

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
}
