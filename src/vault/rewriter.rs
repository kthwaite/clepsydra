use std::ops::Range;
use std::path::PathBuf;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, TextMergeWithOffset};
use regex::Regex;

/// Sentinel prefix: replace the entire link syntax with plain text.
pub const DELETE_PLAIN: &str = "\x00PLAIN:";
/// Sentinel prefix: replace the entire link syntax with strikethrough text.
pub const DELETE_UNLINK: &str = "\x00UNLINK:";

/// Return a lazily compiled regex for wikilinks: `[[target]]` or `[[target|display]]`.
fn wikilink_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap())
}

/// An edit to apply: replace `range` bytes in the source with `replacement`.
#[derive(Debug)]
struct Edit {
    range: Range<usize>,
    replacement: String,
}

/// Rewrite links in Markdown `content`, applying the given `replacements`.
///
/// Each entry in `replacements` is `(old_target, new_target)`. Wikilinks whose
/// target matches `old_target` are rewritten to `new_target`, preserving any
/// display text. Standard markdown links whose URL matches `old_target` have
/// their URL replaced.
///
/// Special `new_target` prefixes trigger delete-rewrite modes:
/// - `\x00PLAIN:text` replaces `[[target]]` with `text` (plain text, no syntax)
/// - `\x00UNLINK:text` replaces `[[target]]` with `~~text~~` (strikethrough)
///
/// Links inside code blocks, inline code, and HTML blocks are left untouched.
pub fn rewrite_links_in_content(content: &str, replacements: &[(&str, &str)]) -> String {
    if replacements.is_empty() {
        return content.to_string();
    }

    let edits = collect_edits(content, replacements);
    apply_edits(content, edits)
}

/// Scan `content` for links matching any replacement and return edits.
fn collect_edits(content: &str, replacements: &[(&str, &str)]) -> Vec<Edit> {
    let raw_iter = Parser::new_ext(content, Options::empty()).into_offset_iter();
    let parser = TextMergeWithOffset::new(raw_iter);

    let mut edits = Vec::new();
    let mut in_code_block = false;
    let mut in_html_block = false;

    for (event, range) in parser {
        match event {
            // --- track code / HTML block depth ---
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::HtmlBlock) => in_html_block = true,
            Event::End(TagEnd::HtmlBlock) => in_html_block = false,

            // --- standard markdown links [text](url) ---
            Event::Start(Tag::Link { dest_url, .. }) if !in_code_block && !in_html_block => {
                let url = dest_url.as_ref();
                if let Some((_old, new)) = replacements.iter().find(|(old, _)| *old == url) {
                    // The range covers the entire `[text](url)` syntax.
                    // We need to replace just the URL portion.
                    let link_text = &content[range.start..range.end];
                    if let Some(edit) = rewrite_markdown_link(link_text, new, range.start) {
                        edits.push(edit);
                    }
                }
            }

            // --- wikilinks in text events ---
            Event::Text(_) if !in_code_block && !in_html_block => {
                let source_slice = &content[range.start..range.end];
                let re = wikilink_regex();
                for cap in re.captures_iter(source_slice) {
                    let m = cap.get(0).unwrap();
                    let inner = &cap[1];
                    // Extract target (before `|` if display text is present)
                    let (target, display) = match inner.split_once('|') {
                        Some((t, d)) => (t, Some(d)),
                        None => (inner, None),
                    };

                    if let Some((_old, new)) = replacements.iter().find(|(old, _)| *old == target) {
                        let abs_start = range.start + m.start();
                        let abs_end = range.start + m.end();

                        let replacement = build_wikilink_replacement(new, target, display);
                        edits.push(Edit {
                            range: abs_start..abs_end,
                            replacement,
                        });
                    }
                }
            }

            // Inline code — skip entirely
            Event::Code(_) => {}
            _ => {}
        }
    }

    edits
}

/// Build the replacement string for a wikilink.
fn build_wikilink_replacement(
    new_target: &str,
    _old_target: &str,
    display: Option<&str>,
) -> String {
    // Delete-rewrite: plain text
    if let Some(text) = new_target.strip_prefix(DELETE_PLAIN) {
        return text.to_string();
    }
    // Delete-rewrite: strikethrough
    if let Some(text) = new_target.strip_prefix(DELETE_UNLINK) {
        return format!("~~{text}~~");
    }
    // Normal rewrite
    match display {
        Some(d) => format!("[[{new_target}|{d}]]"),
        None => format!("[[{new_target}]]"),
    }
}

/// Replace just the URL in a markdown link `[text](url)`, returning an Edit
/// whose range is absolute in the document.
fn rewrite_markdown_link(link_text: &str, new_url: &str, base_offset: usize) -> Option<Edit> {
    // Find the last `](` which separates display text from URL.
    let paren_open = link_text.rfind("](")?;
    // URL starts right after `(`
    let url_start = paren_open + 2;
    // Find the closing `)`
    let url_end = link_text[url_start..].find(')')? + url_start;

    Some(Edit {
        range: (base_offset + url_start)..(base_offset + url_end),
        replacement: new_url.to_string(),
    })
}

/// Apply collected edits to `content` in reverse byte-offset order.
fn apply_edits(content: &str, mut edits: Vec<Edit>) -> String {
    // Sort by start descending so that later edits don't invalidate earlier spans.
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.range.start));

    let mut result = content.to_string();
    for edit in edits {
        result.replace_range(edit.range, &edit.replacement);
    }
    result
}

// ---------------------------------------------------------------------------
// Staged writes
// ---------------------------------------------------------------------------

/// Atomically write multiple files via a tmp-then-rename strategy.
///
/// 1. For each `(path, content)`, write to `{path}.clepsydra-tmp`.
/// 2. After **all** tmp files are written, rename each to its final path.
/// 3. On failure at any step, clean up all tmp files.
pub fn apply_staged_writes(writes: &[(PathBuf, String)]) -> Result<(), std::io::Error> {
    let tmp_paths: Vec<PathBuf> = writes
        .iter()
        .map(|(path, _)| {
            let mut tmp = path.as_os_str().to_owned();
            tmp.push(".clepsydra-tmp");
            PathBuf::from(tmp)
        })
        .collect();

    // Phase 1: write all tmp files
    let cleanup = |created_up_to: usize| {
        for tmp in &tmp_paths[..created_up_to] {
            let _ = std::fs::remove_file(tmp);
        }
    };

    for (i, ((_, content), tmp)) in writes.iter().zip(tmp_paths.iter()).enumerate() {
        if let Err(e) = std::fs::write(tmp, content) {
            cleanup(i);
            return Err(e);
        }
    }

    // Phase 2: rename tmp -> final (atomic on POSIX)
    for (i, (tmp, (final_path, _))) in tmp_paths.iter().zip(writes.iter()).enumerate() {
        if let Err(e) = std::fs::rename(tmp, final_path) {
            // Best-effort cleanup of remaining tmp files
            for remaining_tmp in &tmp_paths[i..] {
                let _ = std::fs::remove_file(remaining_tmp);
            }
            return Err(e);
        }
    }

    Ok(())
}
