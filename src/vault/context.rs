use std::ops::Range;

/// Byte offset of the character boundary `n` characters before `at` in `s`.
///
/// Clamps to the start of `s` when there are fewer than `n` characters
/// available. `at` must already be a character boundary.
fn back_chars(s: &str, at: usize, n: usize) -> usize {
    s[..at]
        .char_indices()
        .rev()
        .take(n)
        .last()
        .map_or(at, |(i, _)| i)
}

/// Byte offset of the character boundary `n` characters after `at` in `s`.
///
/// Clamps to the end of `s` when there are fewer than `n` characters
/// available. `at` must already be a character boundary.
fn forward_chars(s: &str, at: usize, n: usize) -> usize {
    s[at..]
        .char_indices()
        .take(n)
        .last()
        .map_or(at, |(i, c)| at + i + c.len_utf8())
}

/// Round `i` down to the nearest character boundary in `s`.
fn floor_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Round `i` up to the nearest character boundary in `s`.
fn ceil_boundary(s: &str, i: usize) -> usize {
    let mut i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Extract a text snippet surrounding a link at `span` in `body`.
///
/// `span` is a byte range into `body`; `max_chars` budgets the snippet in
/// *characters*, so multi-byte text gets as much visible context as ASCII.
///
/// Strategy:
/// 1. Find the paragraph containing the span (split on `\n\n`).
/// 2. If the paragraph fits within `max_chars`, return it.
/// 3. Otherwise, center a window of `max_chars` on the span, trimming
///    to word boundaries and adding `…` at truncation points.
pub fn extract_context(body: &str, span: Range<usize>, max_chars: usize) -> String {
    // Spans come from the index but are applied to the file as it is on disk
    // now, so they can be stale: clamp them into `body` and onto character
    // boundaries before slicing.
    let span_start = floor_boundary(body, span.start);
    let span_end = ceil_boundary(body, span.end.max(span_start));

    // Find paragraph boundaries
    let para_start = body[..span_start].rfind("\n\n").map(|i| i + 2).unwrap_or(0);

    let para_end = body[span_end..]
        .find("\n\n")
        .map(|i| span_end + i)
        .unwrap_or(body.len());

    let paragraph = &body[para_start..para_end];

    if paragraph.chars().count() <= max_chars {
        return paragraph.to_string();
    }

    // The span's position relative to the paragraph, in bytes; both ends are
    // character boundaries because `para_start` and the span ends are.
    let rel_start = span_start - para_start;
    let rel_end = span_end - para_start;

    // Center a window around the link. Budgets are counted in characters and
    // resolved back to byte offsets that always land on a character boundary.
    let link_chars = paragraph[rel_start..rel_end].chars().count();
    let budget = max_chars.saturating_sub(link_chars);
    let before_budget = budget / 2;
    let after_budget = budget - before_budget;

    let window_start = back_chars(paragraph, rel_start, before_budget);
    let window_end = forward_chars(paragraph, rel_end, after_budget);

    // Snap to word boundaries. A space is one byte, so the offsets `find` and
    // `rfind` yield are character boundaries too.
    let snapped_start = if window_start > 0 {
        paragraph[window_start..]
            .find(' ')
            .map(|i| window_start + i + 1)
            .unwrap_or(window_start)
    } else {
        0
    };

    let snapped_end = if window_end < paragraph.len() {
        paragraph[..window_end].rfind(' ').unwrap_or(window_end)
    } else {
        paragraph.len()
    };

    // Never snap across the link itself. Scripts written without spaces (CJK,
    // Thai) and long unbroken runs such as URLs otherwise push the window
    // clean past the span we are supposed to be showing context for.
    let snapped_start = snapped_start.min(rel_start);
    let snapped_end = snapped_end.max(rel_end).max(snapped_start);

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
