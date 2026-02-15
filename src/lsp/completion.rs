/// Detect if the cursor is in a wikilink context.
/// Returns the filter prefix (text between `[[` and cursor) if found.
pub fn wikilink_prefix(line_text: &str, character: usize) -> Option<String> {
    let before = &line_text[..character.min(line_text.len())];
    let mut i = before.len();
    while i >= 2 {
        i -= 1;
        if i > 0 && &before[i - 1..=i] == "[[" {
            let between = &before[i + 1..];
            if !between.contains("]]") {
                return Some(between.to_string());
            }
        }
    }
    None
}

/// Detect if the cursor is in a tag context (#word_boundary).
pub fn tag_prefix(line_text: &str, character: usize) -> Option<String> {
    let before = &line_text[..character.min(line_text.len())];
    if let Some(hash_pos) = before.rfind('#') {
        if hash_pos == 0 || before.as_bytes()[hash_pos - 1].is_ascii_whitespace() {
            let prefix = &before[hash_pos + 1..];
            if !prefix.contains(' ') {
                return Some(prefix.to_string());
            }
        }
    }
    None
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
}
