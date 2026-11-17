use std::ops::Range;

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd, TextMergeWithOffset};
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

/// Rewrite links in Markdown `content`, using separate replacement targets for
/// wikilinks (vault names/paths) and Markdown links (source-relative URLs).
///
/// Each entry is `(old_target, new_target)`. Only the matching syntax is
/// rewritten; wikilink display text and Markdown link labels are preserved.
/// For a Markdown link only the destination bytes change: the label, the
/// title, padding and angle brackets stay as written. The new destination is
/// written in a form that parses back to `new_target` (angle brackets when it
/// contains spaces, backslash escapes where needed); a link whose new
/// destination has no such form is left untouched.
///
/// Special `new_target` prefixes trigger delete-rewrite modes:
/// - `\x00PLAIN:text` replaces `[[target]]` with `text` (plain text, no syntax)
/// - `\x00UNLINK:text` replaces `[[target]]` with `~~text~~` (strikethrough)
///
/// A reference-style link (`[x][r]` with `[r]: target`) is rewritten at its
/// definition; the usages stay as written.
///
/// Links inside code blocks, inline code, and HTML blocks are left untouched.
pub fn rewrite_links_in_content(
    content: &str,
    wikilink_replacements: &[(&str, &str)],
    markdown_replacements: &[(&str, &str)],
) -> String {
    if wikilink_replacements.is_empty() && markdown_replacements.is_empty() {
        return content.to_string();
    }

    let edits = collect_edits(content, wikilink_replacements, markdown_replacements);
    apply_edits(content, edits)
}

/// Scan `content` for links matching any replacement and return edits.
fn collect_edits(
    content: &str,
    wikilink_replacements: &[(&str, &str)],
    markdown_replacements: &[(&str, &str)],
) -> Vec<Edit> {
    let raw_iter = Parser::new_ext(content, crate::link::link_scan_options()).into_offset_iter();
    let parser = TextMergeWithOffset::new(raw_iter);
    let mut in_code_block = false;
    let mut in_html_block = false;
    // Labels of reference-style links (`[x][r]`, `[r][]`, `[r]`) whose
    // destination matches a replacement, with that replacement.
    let mut matched_references: Vec<(String, &str, &str)> = Vec::new();
    let mut edits = Vec::new();
    let mut pending_link: Option<PendingLink<'_>> = None;

    for (event, range) in parser {
        match event {
            // --- track code / HTML block depth ---
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::HtmlBlock) => in_html_block = true,
            Event::End(TagEnd::HtmlBlock) => in_html_block = false,

            // --- inline markdown links [text](url "title") ---
            Event::Start(Tag::Link {
                link_type: LinkType::Inline,
                dest_url,
                ..
            }) if !in_code_block && !in_html_block => {
                let url = dest_url.as_ref();
                pending_link = markdown_replacements
                    .iter()
                    .find(|(old, _)| *old == url)
                    .map(|(old, new)| PendingLink {
                        old_url: old,
                        new_url: new,
                        // Just past the opening `[`; label events push it on.
                        label_end: range.start + 1,
                    });
            }
            // --- reference-style links: the destination is in the definition ---
            Event::Start(Tag::Link {
                link_type: LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut,
                dest_url,
                id,
                ..
            }) if !in_code_block && !in_html_block => {
                let url = dest_url.as_ref();
                if let Some((old, new)) = markdown_replacements.iter().find(|(old, _)| *old == url)
                {
                    matched_references.push((id.to_string(), old, new));
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some(link) = pending_link.take()
                    && let Some(edit) = rewrite_markdown_link(
                        content,
                        link.label_end..range.end,
                        link.old_url,
                        link.new_url,
                    )
                {
                    edits.push(edit);
                }
            }

            // --- wikilinks in text events ---
            Event::Text(_) if !in_code_block && !in_html_block => {
                if let Some(link) = pending_link.as_mut() {
                    link.label_end = link.label_end.max(range.end);
                }
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

                    if let Some((_old, new)) =
                        wikilink_replacements.iter().find(|(old, _)| *old == target)
                    {
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

            // Anything else inside a link label (inline code, emphasis,
            // images, …) is skipped, but moves the end of the label on.
            _ => {
                if let Some(link) = pending_link.as_mut() {
                    link.label_end = link.label_end.max(range.end);
                }
            }
        }
    }

    if !matched_references.is_empty() {
        edits.extend(reference_definition_edits(content, matched_references));
    }

    edits
}

/// Edits for the link reference definitions behind the reference-style links
/// in `references` (`(label, old_url, new_url)`); each definition is edited
/// once. A definition that no matching link uses is not touched.
fn reference_definition_edits(content: &str, references: Vec<(String, &str, &str)>) -> Vec<Edit> {
    // Definitions produce no event; they are read from the parser's table.
    let parser = Parser::new_ext(content, crate::link::link_scan_options());
    let definitions = parser.reference_definitions();

    let mut edits: Vec<Edit> = Vec::new();
    for (label, old_url, new_url) in references {
        let Some(def) = definitions.get(&label) else {
            continue;
        };
        if edits
            .iter()
            .any(|edit| def.span.contains(&edit.range.start))
        {
            continue;
        }
        if let Some(from) = definition_destination_start(content, def.span.clone())
            && let Some(edit) = rewrite_destination(content, from..def.span.end, old_url, new_url)
        {
            edits.push(edit);
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

/// An inline Markdown link whose destination matches a replacement, open
/// between its `Start` and `End` events.
struct PendingLink<'a> {
    old_url: &'a str,
    new_url: &'a str,
    /// End of the last label event seen so far: the `](` that opens the
    /// destination is searched for from here, never inside the label.
    label_end: usize,
}

/// Replace just the destination of an inline Markdown link. `tail` runs from
/// the end of the label's content to the end of the link, so it holds
/// `](destination "title")`. Returns `None`, leaving the link as written, if
/// the bytes found do not read back as `old_url` (e.g. a destination on a
/// continuation line behind a `>` blockquote marker).
fn rewrite_markdown_link(
    content: &str,
    tail: Range<usize>,
    old_url: &str,
    new_url: &str,
) -> Option<Edit> {
    let open = tail.start + content[tail.clone()].find("](")? + 2;
    rewrite_destination(content, open..tail.end, old_url, new_url)
}

/// Offset just past the `[label]:` that opens the link reference definition
/// at `span`.
fn definition_destination_start(content: &str, span: Range<usize>) -> Option<usize> {
    let bytes = content.as_bytes();
    let mut i = span.start + content[span.clone()].find('[')? + 1;
    while i < span.end {
        match bytes[i] {
            b'\\' => i += 2,
            b']' => break,
            _ => i += 1,
        }
    }
    (bytes.get(i + 1) == Some(&b':') && i + 2 <= span.end).then_some(i + 2)
}

/// Replace the link destination that starts at or after `within.start`
/// (leading whitespace is skipped) if it reads back as `old_url`.
fn rewrite_destination(
    content: &str,
    within: Range<usize>,
    old_url: &str,
    new_url: &str,
) -> Option<Edit> {
    // Delete sentinels are wikilink-only: never write one into a destination.
    // An empty destination cannot be written in a reference definition.
    if new_url.starts_with('\x00') || new_url.is_empty() {
        return None;
    }
    let (range, angle) = locate_destination(content, within.start, within.end)?;
    let found = &content[range.clone()];
    let found_reads_as_old = if angle {
        destination_parses_to(&format!("<{found}>"), old_url)
    } else {
        destination_parses_to(found, old_url)
    };
    if !found_reads_as_old {
        return None;
    }
    let replacement = encode_destination(new_url, angle)?;
    Some(Edit { range, replacement })
}

/// Locate the CommonMark link destination that starts at or after `from`
/// (leading whitespace is skipped). Returns its byte range, without the angle
/// brackets, and whether it is written in the `<…>` form.
fn locate_destination(content: &str, from: usize, end: usize) -> Option<(Range<usize>, bool)> {
    let bytes = content.as_bytes();
    let mut pos = from;
    while pos < end && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }

    if pos < end && bytes[pos] == b'<' {
        let start = pos + 1;
        let mut i = start;
        while i < end {
            match bytes[i] {
                b'\\' if i + 1 < end && bytes[i + 1].is_ascii_punctuation() => i += 2,
                b'>' => return Some((start..i, true)),
                b'<' | b'\n' | b'\r' => return None,
                _ => i += 1,
            }
        }
        return None;
    }

    // Bare form: ends at whitespace, a control character, or the first
    // unbalanced `)`; backslash-escaped punctuation never ends it.
    let mut depth = 0usize;
    let mut i = pos;
    while i < end {
        match bytes[i] {
            b'\\' if i + 1 < end && bytes[i + 1].is_ascii_punctuation() => i += 2,
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' if depth == 0 => break,
            b')' => {
                depth -= 1;
                i += 1;
            }
            b if b.is_ascii_whitespace() || b.is_ascii_control() => break,
            _ => i += 1,
        }
    }
    Some((pos..i, false))
}

/// Write `url` as a link destination that parses back to exactly `url`.
/// Keeps the `<…>` form when the link already used it, otherwise prefers the
/// bare form and falls back to `<…>` (needed for spaces). Returns the text to
/// put in place of the old destination: for an angle-bracket link that is the
/// inside of the brackets. `None` if no form round-trips (e.g. a line break).
fn encode_destination(url: &str, angle: bool) -> Option<String> {
    let bare = [url.to_string(), escape_destination(url, "\\()<&")];
    let angled = [url.to_string(), escape_destination(url, "\\<>&")];

    if angle {
        return angled
            .into_iter()
            .find(|inner| destination_parses_to(&format!("<{inner}>"), url));
    }
    bare.into_iter()
        .find(|dest| destination_parses_to(dest, url))
        .or_else(|| {
            angled
                .into_iter()
                .map(|inner| format!("<{inner}>"))
                .find(|dest| destination_parses_to(dest, url))
        })
}

/// Backslash-escape every character of `url` that is in `special`.
fn escape_destination(url: &str, special: &str) -> String {
    let mut escaped = String::with_capacity(url.len());
    for ch in url.chars() {
        if special.contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// True if `[x](destination)` is one inline link whose target is `url`.
fn destination_parses_to(destination: &str, url: &str) -> bool {
    let probe = format!("[x]({destination})");
    Parser::new_ext(&probe, Options::empty())
        .into_offset_iter()
        .any(|(event, range)| {
            matches!(
                event,
                Event::Start(Tag::Link { link_type: LinkType::Inline, ref dest_url, .. })
                    if dest_url.as_ref() == url && range == (0..probe.len())
            )
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
