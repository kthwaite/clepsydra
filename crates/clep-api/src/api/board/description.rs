//! The Task card description: a Task page's body markdown, minus the
//! checklist items the board already counts in `checks`, capped at a block
//! boundary.

use std::ops::Range;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};

use crate::vault::block::parse_blocks;
use crate::vault::markdown::markdown_options;

/// Upper bound on the description length, in Unicode scalars.
pub(crate) const DESCRIPTION_MAX_CHARS: usize = 1500;

/// Derive a Task card description from a Task page body.
///
/// Removes every block the board counts in `checks` (a block carrying a
/// `status` property: `- [ ]`, `- [x]`, `- [-]`, or `[status:: …]`). A
/// counted list item goes with its nested children. The rest is trimmed and
/// capped at the last block end within [`DESCRIPTION_MAX_CHARS`]; a first
/// block longer than the cap is kept whole rather than cut mid-block.
/// Returns `None` when nothing is left.
pub(crate) fn task_description(body: &str) -> Option<String> {
    let stripped = strip_counted_checks(body);
    let capped = cap_at_block_boundary(stripped.trim(), DESCRIPTION_MAX_CHARS).trim();
    (!capped.is_empty()).then(|| capped.to_string())
}

/// Remove the source of every block that carries a `status` property, the
/// same set `count_checks` counts.
fn strip_counted_checks(body: &str) -> String {
    let items = item_ranges(body);
    let mut cuts: Vec<Range<usize>> = parse_blocks(body)
        .into_iter()
        .filter(|block| block.properties.contains_key("status"))
        .map(|block| innermost_item(&items, block.span.start).unwrap_or(block.span))
        .map(|range| widen_to_line_start(body, range))
        .collect();
    if cuts.is_empty() {
        return body.to_string();
    }
    cuts.sort_by_key(|range| range.start);
    let mut out = String::with_capacity(body.len());
    let mut pos = 0;
    for cut in cuts {
        if cut.start >= pos {
            out.push_str(&body[pos..cut.start]);
        }
        pos = pos.max(cut.end);
    }
    out.push_str(&body[pos..]);
    out
}

/// Source ranges of every list item, in document order.
fn item_ranges(body: &str) -> Vec<Range<usize>> {
    Parser::new_ext(body, markdown_options())
        .into_offset_iter()
        .filter_map(|(event, range)| matches!(event, Event::Start(Tag::Item)).then_some(range))
        .collect()
}

/// The innermost list item whose range contains `offset`.
fn innermost_item(items: &[Range<usize>], offset: usize) -> Option<Range<usize>> {
    items
        .iter()
        .filter(|item| item.contains(&offset))
        .max_by_key(|item| item.start)
        .cloned()
}

/// Extend `range` back over the indentation before it on its line.
fn widen_to_line_start(body: &str, range: Range<usize>) -> Range<usize> {
    let line_start = body[..range.start].rfind('\n').map_or(0, |i| i + 1);
    if body[line_start..range.start]
        .chars()
        .all(|c| c == ' ' || c == '\t')
    {
        line_start..range.end
    } else {
        range
    }
}

/// Cut `text` at the last block end within `max` scalars. When the first
/// top-level block alone exceeds `max`, keep that block whole.
fn cap_at_block_boundary(text: &str, max: usize) -> &str {
    if text.chars().count() <= max {
        return text;
    }
    let mut depth = 0usize;
    let mut best: Option<usize> = None;
    let mut first_top: Option<usize> = None;
    for (event, range) in Parser::new_ext(text, markdown_options()).into_offset_iter() {
        match event {
            Event::Start(_) => depth += 1,
            Event::End(end) => {
                depth = depth.saturating_sub(1);
                if depth == 0 && first_top.is_none() {
                    first_top = Some(range.end);
                }
                if !is_block_boundary(end) {
                    continue;
                }
                if text[..range.end].chars().count() <= max {
                    best = Some(range.end);
                } else if first_top.is_some() {
                    // Block ends arrive in source order, so no later end fits.
                    break;
                }
            }
            _ => {}
        }
    }
    &text[..best.or(first_top).unwrap_or(text.len())]
}

/// Whether ending `end` leaves complete block-level markdown behind. Inline
/// tags and table parts (a table is kept whole) are not boundaries.
fn is_block_boundary(end: TagEnd) -> bool {
    !matches!(
        end,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
    )
}

#[cfg(test)]
mod tests {
    use super::{DESCRIPTION_MAX_CHARS, task_description};

    #[test]
    fn strips_checklist_items_and_keeps_prose_lists_and_links() {
        let body = "Intro with **bold** and [[Some Page]].\n\n\
                    - [ ] first check\n- [x] done check\n- [-] cancelled check\n\n\
                    Middle prose.\n\n\
                    - plain item\n- another [link](https://example.com)\n\n\
                    Closing prose.\n";
        let got = task_description(body).unwrap();
        assert!(!got.contains("check"), "checklist items stripped: {got:?}");
        assert!(got.contains("Intro with **bold** and [[Some Page]]."));
        assert!(got.contains("- plain item"));
        assert!(got.contains("[link](https://example.com)"));
        assert!(got.ends_with("Closing prose."));
    }

    #[test]
    fn strips_nested_checklist_items_with_their_indentation() {
        let body = "- parent\n  - [ ] nested check\n  - kept child\n";
        let got = task_description(body).unwrap();
        assert_eq!(got, "- parent\n  - kept child");
    }

    #[test]
    fn strips_checklist_items_in_loose_lists() {
        let body = "Prose.\n\n- [ ] loose one\n\n- [x] loose two\n";
        assert_eq!(task_description(body).as_deref(), Some("Prose."));
    }

    #[test]
    fn strips_blocks_with_an_inline_status_property() {
        // The board counts every block carrying a `status` property.
        let body = "Prose.\n\nfollow up [status:: todo]\n";
        assert_eq!(task_description(body).as_deref(), Some("Prose."));
    }

    #[test]
    fn none_for_empty_or_checklist_only_body() {
        assert_eq!(task_description(""), None);
        assert_eq!(task_description("  \n\n "), None);
        assert_eq!(task_description("- [ ] a\n- [x] b\n"), None);
    }

    #[test]
    fn caps_at_a_block_boundary() {
        let para = vec!["word"; 100].join(" "); // 499 chars per paragraph
        let body = format!("{para}\n\n{para}\n\n{para}\n\n{para}\n");
        let got = task_description(&body).unwrap();
        // Three paragraphs would be 1501 chars, so the cut lands after two.
        assert_eq!(got, format!("{para}\n\n{para}"));
        assert!(got.chars().count() <= DESCRIPTION_MAX_CHARS);
    }

    #[test]
    fn caps_multibyte_text_without_splitting_scalars() {
        let para = "界".repeat(600);
        let body = format!("{para}\n\n{para}\n\n{para}\n");
        let got = task_description(&body).unwrap();
        assert!(got.chars().count() <= DESCRIPTION_MAX_CHARS);
        assert_eq!(got, format!("{para}\n\n{para}"));
    }

    #[test]
    fn keeps_a_single_oversized_first_block_whole() {
        let para = "x".repeat(DESCRIPTION_MAX_CHARS + 200);
        let got = task_description(&format!("{para}\n\nnext\n")).unwrap();
        assert_eq!(got, para);
    }
}
