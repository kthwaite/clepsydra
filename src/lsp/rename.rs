use crate::vault::canonical::CanonicalName;
use crate::vault::page::{parse_or_repair_frontmatter, write_page_content};
use tower_lsp::lsp_types::{Position, PrepareRenameResponse, Range};

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

/// If `line_text` is a frontmatter `title:` line, return the rename range and
/// placeholder for the (possibly quoted) title value on `line_number`.
///
/// Replicates the exact logic from `prepare_rename` Case 2 so the inline
/// arithmetic can be replaced with a single call here.
pub fn frontmatter_title_rename_range(
    line_text: &str,
    line_number: u32,
) -> Option<PrepareRenameResponse> {
    let trimmed = line_text.trim_start();
    let rest = trimmed.strip_prefix("title:")?;
    let value = rest.trim();

    // Strip surrounding quotes if present (replicates prepare_rename exactly,
    // including the absence of a len >= 2 guard on the slice).
    let title_value = if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        &value[1..value.len() - 1]
    } else {
        value.trim_end_matches('\n')
    };

    // Compute character offset of the title value within line_text.
    let value_start_in_line = if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        // Position after the opening quote
        line_text.find(value).unwrap_or(0) + 1
    } else {
        // Position at start of the trimmed value
        line_text.find(value).unwrap_or(0)
    };
    let value_end_in_line = value_start_in_line + title_value.len();

    let range = Range {
        start: Position {
            line: line_number,
            character: value_start_in_line as u32,
        },
        end: Position {
            line: line_number,
            character: value_end_in_line as u32,
        },
    };

    Some(PrepareRenameResponse::RangeWithPlaceholder {
        range,
        placeholder: title_value.to_string(),
    })
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

    #[test]
    fn frontmatter_title_unquoted() {
        let r = frontmatter_title_rename_range("title: My Note", 0).unwrap();
        match r {
            PrepareRenameResponse::RangeWithPlaceholder { placeholder, range } => {
                assert_eq!(placeholder, "My Note");
                assert_eq!(range.start.line, 0);
                assert_eq!(range.start.character, 7); // "title: " is 7 chars
                assert_eq!(range.end.character, 7 + 7); // "My Note" is 7 chars
            }
            _ => panic!("expected RangeWithPlaceholder"),
        }
    }

    #[test]
    fn frontmatter_title_double_quoted() {
        let r = frontmatter_title_rename_range("title: \"My Note\"", 3).unwrap();
        match r {
            PrepareRenameResponse::RangeWithPlaceholder { placeholder, range } => {
                assert_eq!(placeholder, "My Note");
                assert_eq!(range.start.line, 3);
                // "title: \"" is 8 chars; value starts at char 8
                assert_eq!(range.start.character, 8);
                assert_eq!(range.end.character, 8 + 7); // "My Note" is 7 chars
            }
            _ => panic!("expected RangeWithPlaceholder"),
        }
    }

    #[test]
    fn non_title_line_returns_none() {
        assert!(frontmatter_title_rename_range("tags: [a]", 0).is_none());
    }
}
