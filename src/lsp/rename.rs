use crate::vault::canonical::CanonicalName;
use crate::vault::page::{parse_frontmatter, write_page_content};

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

/// Compute the shortest unique suffix for each path that distinguishes it
/// from all others in the set.
///
/// Strips `.md` extensions first, then walks up path segments until each
/// suffix is unique. Example: `["notes/foo.md", "projects/foo.md"]` yields
/// `["notes/foo", "projects/foo"]`.
pub fn shortest_unique_prefixes(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|path| {
            let stripped = path.strip_suffix(".md").unwrap_or(path);
            let segments: Vec<&str> = stripped.split('/').collect();

            // Try increasingly long suffixes until unique
            for len in 1..=segments.len() {
                let suffix = segments[segments.len() - len..].join("/");
                let matches = paths
                    .iter()
                    .filter(|other| {
                        let other_stripped = other.strip_suffix(".md").unwrap_or(other);
                        other_stripped.ends_with(&suffix)
                    })
                    .count();
                if matches == 1 {
                    return suffix;
                }
            }
            // Fallback: full path without .md
            stripped.to_string()
        })
        .collect()
}

/// Update frontmatter title in full document text. Returns new full text.
///
/// Parses the existing frontmatter, replaces the title, and re-serializes.
/// Returns `None` if frontmatter parsing fails.
pub fn update_frontmatter_title(full_text: &str, new_title: &str) -> Option<String> {
    let (mut meta, body) = parse_frontmatter(full_text).ok()?;
    meta.title = Some(new_title.to_string());
    Some(write_page_content(&meta, &body))
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
    fn shortest_prefix_simple_disambiguation() {
        let paths = vec!["notes/foo.md".to_string(), "projects/foo.md".to_string()];
        let prefixes = shortest_unique_prefixes(&paths);
        assert_eq!(prefixes, vec!["notes/foo", "projects/foo"]);
    }

    #[test]
    fn shortest_prefix_already_unique() {
        let paths = vec!["notes/alpha.md".to_string(), "notes/beta.md".to_string()];
        let prefixes = shortest_unique_prefixes(&paths);
        assert_eq!(prefixes, vec!["alpha", "beta"]);
    }

    #[test]
    fn shortest_prefix_deep_nesting() {
        let paths = vec![
            "a/shared/foo.md".to_string(),
            "b/shared/foo.md".to_string(),
        ];
        let prefixes = shortest_unique_prefixes(&paths);
        assert_eq!(prefixes, vec!["a/shared/foo", "b/shared/foo"]);
    }

    #[test]
    fn update_title_in_frontmatter() {
        let content = "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: Old Title\n---\nBody text here.\n";
        let result = update_frontmatter_title(content, "New Title");
        assert!(result.is_some());
        let new_text = result.unwrap();
        assert!(new_text.contains("title: New Title"));
        assert!(new_text.contains("Body text here."));
        assert!(!new_text.contains("Old Title"));
    }
}
