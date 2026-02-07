use std::ops::Range;

/// Extract a text snippet surrounding a link at `span` in `body`.
///
/// Strategy:
/// 1. Find the paragraph containing the span (split on `\n\n`).
/// 2. If the paragraph fits within `max_chars`, return it.
/// 3. Otherwise, center a window of `max_chars` on the span, trimming
///    to word boundaries and adding `…` at truncation points.
pub fn extract_context(body: &str, span: Range<usize>, max_chars: usize) -> String {
    // Find paragraph boundaries
    let para_start = body[..span.start]
        .rfind("\n\n")
        .map(|i| i + 2)
        .unwrap_or(0);

    let para_end = body[span.end..]
        .find("\n\n")
        .map(|i| span.end + i)
        .unwrap_or(body.len());

    let paragraph = &body[para_start..para_end];

    if paragraph.len() <= max_chars {
        return paragraph.to_string();
    }

    // The span's position relative to the paragraph
    let rel_start = span.start - para_start;
    let rel_end = span.end - para_start;

    // Center a window around the link
    let link_len = rel_end - rel_start;
    let budget = max_chars.saturating_sub(link_len);
    let before_budget = budget / 2;
    let after_budget = budget - before_budget;

    let window_start = rel_start.saturating_sub(before_budget);
    let window_end = (rel_end + after_budget).min(paragraph.len());

    // Snap to word boundaries
    let snapped_start = if window_start > 0 {
        paragraph[window_start..]
            .find(' ')
            .map(|i| window_start + i + 1)
            .unwrap_or(window_start)
    } else {
        0
    };

    let snapped_end = if window_end < paragraph.len() {
        paragraph[..window_end]
            .rfind(' ')
            .unwrap_or(window_end)
    } else {
        paragraph.len()
    };

    let mut result = String::new();
    if snapped_start > 0 {
        result.push('\u{2026}');
    }
    result.push_str(&paragraph[snapped_start..snapped_end]);
    if snapped_end < paragraph.len() {
        result.push('\u{2026}');
    }

    result
}
