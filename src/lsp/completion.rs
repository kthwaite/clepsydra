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
        assert_eq!(
            wikilink_prefix("你好 [[Des", 13),
            Some("Des".to_string())
        );
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
}
