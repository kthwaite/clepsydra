//! Pure hover-content formatting helpers.

/// Markdown shown when hovering a link that resolves to a page.
///
/// Bold title, code-span path, an italic backlink count, a `---` rule, then
/// the preview (see the `resolved_format_exact` test for the exact layout).
pub fn format_hover_resolved(
    path: &str,
    title: Option<&str>,
    preview: &str,
    backlink_count: usize,
) -> String {
    let display_title = title.unwrap_or(path);
    let noun = if backlink_count == 1 {
        "backlink"
    } else {
        "backlinks"
    };
    format!("**{display_title}**\n`{path}`\n*{backlink_count} {noun}*\n\n---\n\n{preview}")
}

/// Markdown shown when hovering a link with no resolvable target.
///
/// Produces: `*Unresolved link:* \`{target_raw}\``
pub fn format_hover_unresolved(target_raw: &str) -> String {
    format!("*Unresolved link:* `{target_raw}`")
}

/// Markdown shown when hovering a `((block-id))` that resolves.
pub fn format_hover_block(block_id: &str, path: &str, content: &str) -> String {
    format!("**Block `(({block_id}))`**\n`{path}`\n\n---\n\n{content}")
}

/// Markdown shown when hovering a `((block-id))` with no indexed block.
pub fn format_hover_block_unresolved(block_id: &str) -> String {
    format!("*Unresolved block reference:* `(({block_id}))`")
}

/// Returns the first `max_lines` lines of `body`, joined with `\n`.
/// Callers are responsible for stripping any frontmatter before calling.
pub fn extract_preview(body: &str, max_lines: usize) -> String {
    body.lines().take(max_lines).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_uses_title_when_present() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "preview", 2);
        assert!(s.contains("**Alpha**"));
        assert!(s.contains("A.md"));
        assert!(s.contains("preview"));
        assert!(s.contains("*2 backlinks*"));
    }

    #[test]
    fn resolved_falls_back_to_path() {
        let s = format_hover_resolved("A.md", None, "p", 0);
        // When no title, path is used as display title (bold) and also shown as code
        assert!(s.contains("**A.md**"));
        assert!(s.contains("*0 backlinks*"));
    }

    #[test]
    fn resolved_format_exact() {
        let s = format_hover_resolved("A.md", Some("Alpha"), "hello", 1);
        assert_eq!(s, "**Alpha**\n`A.md`\n*1 backlink*\n\n---\n\nhello");
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

    #[test]
    fn block_hover_format_exact() {
        let s = format_hover_block("blk123XYZ99", "Ref.md", "A fact");
        assert_eq!(s, "**Block `((blk123XYZ99))`**\n`Ref.md`\n\n---\n\nA fact");
    }

    #[test]
    fn block_hover_unresolved_format_exact() {
        let s = format_hover_block_unresolved("nope123456");
        assert_eq!(s, "*Unresolved block reference:* `((nope123456))`");
    }
}
