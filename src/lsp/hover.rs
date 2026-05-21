//! Pure hover-content formatting helpers.

/// Markdown shown when hovering a link that resolves to a page.
///
/// Produces: `**{display_title}**\n`{path}`\n\n---\n\n{preview}`
pub fn format_hover_resolved(path: &str, title: Option<&str>, preview: &str) -> String {
    let display_title = title.unwrap_or(path);
    format!("**{display_title}**\n`{path}`\n\n---\n\n{preview}")
}

/// Markdown shown when hovering a link with no resolvable target.
///
/// Produces: `*Unresolved link:* \`{target_raw}\``
pub fn format_hover_unresolved(target_raw: &str) -> String {
    format!("*Unresolved link:* `{target_raw}`")
}

/// First `max_lines` non-frontmatter body lines, joined with newlines.
pub fn extract_preview(body: &str, max_lines: usize) -> String {
    body.lines().take(max_lines).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_uses_title_when_present() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "preview");
        assert!(s.contains("**Alpha**"));
        assert!(s.contains("A.md"));
        assert!(s.contains("preview"));
    }

    #[test]
    fn resolved_falls_back_to_path() {
        let s = format_hover_resolved("A.md", None, "p");
        // When no title, path is used as display title (bold) and also shown as code
        assert!(s.contains("**A.md**"));
    }

    #[test]
    fn resolved_format_exact() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "hello");
        assert_eq!(s, "**Alpha**\n`A.md`\n\n---\n\nhello");
    }

    #[test]
    fn unresolved_mentions_target() {
        let s = format_hover_unresolved("Ghost");
        assert!(s.contains("Ghost"));
        assert_eq!(s, "*Unresolved link:* `Ghost`");
    }

    #[test]
    fn preview_truncates_to_max_lines() {
        let p = extract_preview("a\nb\nc\nd", 2);
        assert_eq!(p, "a\nb");
    }

    #[test]
    fn preview_fewer_lines_than_max() {
        let p = extract_preview("a\nb", 10);
        assert_eq!(p, "a\nb");
    }
}
