/// Detect if the cursor is in a wikilink context.
/// Returns the filter prefix (text between `[[` and cursor) if found.
pub fn wikilink_prefix(line_text: &str, character: usize) -> Option<String> {
    let end = clamp_to_char_boundary(line_text, character);
    let before = &line_text[..end];
    // Find the last unclosed `[[`
    let bracket_pos = before.rfind("[[")?;
    let after_bracket = &before[bracket_pos + 2..];
    // If there's a closing `]]` between the `[[` and cursor, we're not inside a link
    if after_bracket.contains("]]") {
        return None;
    }
    Some(after_bracket.to_string())
}

/// Detect if the cursor is in a block-reference context.
/// Returns the filter prefix (text between `((` and cursor) if found.
pub fn block_ref_prefix(line_text: &str, character: usize) -> Option<String> {
    let end = clamp_to_char_boundary(line_text, character);
    let before = &line_text[..end];
    let paren_pos = before.rfind("((")?;
    let after_paren = &before[paren_pos + 2..];
    if after_paren.contains("))") {
        return None;
    }
    Some(after_paren.to_string())
}

/// Detect if the cursor is in a tag context (#word_boundary).
pub fn tag_prefix(line_text: &str, character: usize) -> Option<String> {
    let end = clamp_to_char_boundary(line_text, character);
    let before = &line_text[..end];
    // `#` is ASCII, so rfind always returns a valid char boundary
    let hash_pos = before.rfind('#')?;
    if hash_pos == 0 || before.as_bytes()[hash_pos - 1].is_ascii_whitespace() {
        let prefix = &before[hash_pos + 1..]; // safe: '#' is single-byte ASCII
        if !prefix.contains(' ') {
            return Some(prefix.to_string());
        }
    }
    None
}

/// Detect a frontmatter property-key context: the cursor sits in a bare
/// identifier at the start of the line (no `=` yet). Returns the typed
/// prefix. Only meaningful when the cursor is inside `+++` fences.
pub fn property_key_prefix(line_text: &str, character: usize) -> Option<String> {
    let end = clamp_to_char_boundary(line_text, character);
    let before = &line_text[..end];
    if before.contains('=') {
        return None;
    }
    let trimmed = before.trim_start();
    // Keys start at column 0 (no leading indent in TOML frontmatter).
    if trimmed.len() != before.len() {
        return None;
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Detect a frontmatter property-value string context: the cursor is inside
/// an unclosed double-quoted string on a `key = …` line (scalar or array
/// element). Returns `(key, typed_prefix)`.
pub fn property_value_prefix(line_text: &str, character: usize) -> Option<(String, String)> {
    let end = clamp_to_char_boundary(line_text, character);
    let before = &line_text[..end];
    let (key_part, value_part) = before.split_once('=')?;
    let key = key_part.trim();
    if key.is_empty()
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    // Inside a string iff the value side carries an odd number of quotes.
    if value_part.matches('"').count() % 2 == 0 {
        return None;
    }
    let after_quote = &value_part[value_part.rfind('"')? + 1..];
    // A wikilink inside the string is the relation completer's context.
    if after_quote.contains("[[") {
        return None;
    }
    Some((key.to_string(), after_quote.to_string()))
}

/// Clamp a byte offset to the nearest valid UTF-8 char boundary at or before it.
fn clamp_to_char_boundary(s: &str, offset: usize) -> usize {
    let offset = offset.min(s.len());
    // Walk backwards to find a valid char boundary (at most 3 bytes for UTF-8)
    let mut i = offset;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- wikilink_prefix tests ----

    #[test]
    fn wikilink_empty_prefix() {
        assert_eq!(wikilink_prefix("some [[", 7), Some("".to_string()));
    }

    #[test]
    fn wikilink_partial_prefix() {
        assert_eq!(wikilink_prefix("some [[Des", 10), Some("Des".to_string()));
    }

    #[test]
    fn wikilink_no_context() {
        assert_eq!(wikilink_prefix("some text", 9), None);
    }

    #[test]
    fn wikilink_closed() {
        // Cursor after a closed wikilink — not inside one
        assert_eq!(wikilink_prefix("some [[done]] more", 18), None);
    }

    #[test]
    fn wikilink_single_bracket() {
        // Only one bracket — not a wikilink
        assert_eq!(wikilink_prefix("some [partial", 13), None);
    }

    #[test]
    fn wikilink_cursor_inside_link() {
        assert_eq!(
            wikilink_prefix("text [[Design Notes", 19),
            Some("Design Notes".to_string())
        );
    }

    // ---- tag_prefix tests ----

    #[test]
    fn tag_at_start_of_line() {
        assert_eq!(tag_prefix("#pro", 4), Some("pro".to_string()));
    }

    #[test]
    fn tag_after_whitespace() {
        assert_eq!(tag_prefix("some #tag", 9), Some("tag".to_string()));
    }

    #[test]
    fn tag_empty_prefix() {
        assert_eq!(tag_prefix("word #", 6), Some("".to_string()));
    }

    #[test]
    fn tag_no_context() {
        assert_eq!(tag_prefix("no tag here", 11), None);
    }

    #[test]
    fn tag_in_middle_of_word() {
        // # not preceded by whitespace or at start
        assert_eq!(tag_prefix("foo#bar", 7), None);
    }

    #[test]
    fn tag_with_space_in_prefix() {
        // Space after # means this is not a tag
        assert_eq!(tag_prefix("# heading text", 14), None);
    }

    // ---- UTF-8 safety tests ----

    #[test]
    fn wikilink_with_multibyte_chars() {
        // 你 is 3 bytes in UTF-8
        assert_eq!(wikilink_prefix("你好 [[Des", 13), Some("Des".to_string()));
    }

    #[test]
    fn tag_with_multibyte_chars() {
        assert_eq!(tag_prefix("你好 #tag", 11), Some("tag".to_string()));
    }

    #[test]
    fn wikilink_offset_mid_codepoint() {
        // Offset 1 is mid-codepoint of 你 (3-byte char) — should not panic
        let result = wikilink_prefix("你[[x", 1);
        assert!(result.is_none());
    }

    #[test]
    fn tag_offset_mid_codepoint() {
        let result = tag_prefix("你#tag", 1);
        assert!(result.is_none());
    }

    // ---- property_key_prefix tests ----

    #[test]
    fn key_prefix_at_line_start() {
        assert_eq!(property_key_prefix("sta", 3), Some("sta".to_string()));
        assert_eq!(property_key_prefix("", 0), Some("".to_string()));
    }

    #[test]
    fn key_prefix_rejects_after_equals_or_indent() {
        assert_eq!(property_key_prefix("status = \"re", 12), None);
        assert_eq!(property_key_prefix("  sta", 5), None);
        assert_eq!(property_key_prefix("some words", 10), None);
    }

    // ---- property_value_prefix tests ----

    #[test]
    fn value_prefix_inside_open_string() {
        assert_eq!(
            property_value_prefix("status = \"rea", 13),
            Some(("status".to_string(), "rea".to_string()))
        );
        assert_eq!(
            property_value_prefix("status = \"", 10),
            Some(("status".to_string(), "".to_string()))
        );
    }

    #[test]
    fn value_prefix_inside_array_element() {
        assert_eq!(
            property_value_prefix("themes = [\"mem", 14),
            Some(("themes".to_string(), "mem".to_string()))
        );
    }

    #[test]
    fn value_prefix_rejects_closed_string_and_wikilinks() {
        assert_eq!(property_value_prefix("status = \"reading\"", 18), None);
        // `[[` inside the string belongs to the relation completer.
        assert_eq!(property_value_prefix("series = [\"[[Sol", 16), None);
        assert_eq!(property_value_prefix("no equals here", 14), None);
    }

    // ---- block_ref_prefix tests ----

    #[test]
    fn block_ref_empty_prefix() {
        assert_eq!(block_ref_prefix("see ((", 6), Some("".to_string()));
    }

    #[test]
    fn block_ref_partial_prefix() {
        assert_eq!(block_ref_prefix("see ((meet", 10), Some("meet".to_string()));
    }

    #[test]
    fn block_ref_no_context() {
        assert_eq!(block_ref_prefix("plain text", 10), None);
    }

    #[test]
    fn block_ref_closed() {
        assert_eq!(block_ref_prefix("((abc123XYZ99)) more", 20), None);
    }

    #[test]
    fn block_ref_single_paren() {
        assert_eq!(block_ref_prefix("call (arg", 9), None);
    }

    #[test]
    fn block_ref_mid_codepoint_offset_is_safe() {
        // Offset 1 is mid-codepoint of 你 (3 bytes) — must not panic.
        assert!(block_ref_prefix("你((x", 1).is_none());
    }
}
