use crate::vault::canonical::CanonicalName;
use crate::vault::page::{parse_or_repair_frontmatter, write_page_content};

/// Rewrite a wikilink span text with a new target, preserving display text.
///
/// Input: raw text like `[[Old Name]]` or `[[Old|Display]]`
/// Output: `[[New Name]]` or `[[New Name|Display]]`
pub fn rewrite_wikilink(raw_span_text: &str, new_target: &str) -> String {
    // Strip the `[[` prefix and `]]` suffix
    let inner = raw_span_text
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .unwrap_or(raw_span_text);

    if let Some((_old_target, display)) = inner.split_once('|') {
        format!("[[{new_target}|{display}]]")
    } else {
        format!("[[{new_target}]]")
    }
}

/// Check if a link target matches any of the given canonical names.
///
/// Canonicalizes `target_raw` and checks membership in the provided list.
pub fn link_matches_target(target_raw: &str, target_canonical_names: &[String]) -> bool {
    let canonical = CanonicalName::from_title(target_raw);
    target_canonical_names
        .iter()
        .any(|cn| cn == canonical.as_str())
}

/// Update frontmatter title in full document text. Returns new full text.
///
/// Uses `parse_or_repair_frontmatter` which always succeeds, even on
/// malformed YAML (it falls back to defaults).
pub fn update_frontmatter_title(full_text: &str, new_title: &str) -> String {
    let (mut meta, body, _, _) = parse_or_repair_frontmatter(full_text);
    meta.title = Some(new_title.to_string());
    write_page_content(&meta, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_simple_wikilink() {
        let result = rewrite_wikilink("[[Old Name]]", "New Name");
        assert_eq!(result, "[[New Name]]");
    }

    #[test]
    fn rewrite_wikilink_with_display_text() {
        let result = rewrite_wikilink("[[Old|Display Text]]", "New Name");
        assert_eq!(result, "[[New Name|Display Text]]");
    }

    #[test]
    fn link_matches_by_canonical_name() {
        let names = vec!["design notes".to_string(), "design-notes".to_string()];
        assert!(link_matches_target("Design Notes", &names));
    }

    #[test]
    fn link_matches_case_insensitive() {
        let names = vec!["hello world".to_string()];
        assert!(link_matches_target("HELLO WORLD", &names));
        assert!(link_matches_target("Hello World", &names));
        assert!(!link_matches_target("goodbye world", &names));
    }

    #[test]
    fn update_title_in_frontmatter() {
        let content = "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: Old Title\n---\nBody text here.\n";
        let new_text = update_frontmatter_title(content, "New Title");
        assert!(new_text.contains("title: New Title"));
        assert!(new_text.contains("Body text here."));
        assert!(!new_text.contains("Old Title"));
    }
}
