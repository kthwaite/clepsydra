use clepsydra::vault::context::extract_context;

#[test]
fn extracts_sentence_around_link() {
    let body = "Some preamble.\n\nThis paragraph mentions [[Alpha]] in the middle of a sentence. More text follows.\n\nAnother paragraph.";
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(body, link_start..link_end, 100);
    assert!(snippet.contains("[[Alpha]]"));
    assert!(snippet.contains("mentions"));
    assert!(
        !snippet.contains("preamble"),
        "should not include other paragraphs"
    );
}

#[test]
fn truncates_long_context_with_ellipsis() {
    let body = "A very long paragraph that goes on and on before mentioning [[Target]] and then continues with more and more text that extends well past the context window limit we set.";
    let link_start = body.find("[[Target]]").unwrap();
    let link_end = link_start + "[[Target]]".len();
    let snippet = extract_context(body, link_start..link_end, 60);
    assert!(snippet.len() <= 70); // slack for ellipsis
    assert!(snippet.contains("[[Target]]"));
}

#[test]
fn handles_link_at_start_of_body() {
    let body = "[[Alpha]] starts this paragraph.";
    let snippet = extract_context(body, 0.."[[Alpha]]".len(), 100);
    assert!(snippet.starts_with("[[Alpha]]"));
}

#[test]
fn handles_link_at_end_of_body() {
    let body = "Paragraph ending with [[Alpha]]";
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(body, link_start..link_end, 100);
    assert!(snippet.ends_with("[[Alpha]]"));
}

#[test]
fn zero_max_chars_does_not_panic() {
    // Regression: with max_chars == 0, word-boundary snapping could drive
    // snapped_end below snapped_start, panicking on a reversed slice. The LSP
    // `references` path calls this with max_context_chars == 0.
    let body = "word one two three\n\nlink to [[X]] here\n";
    let link_start = body.find("[[X]]").unwrap();
    let link_end = link_start + "[[X]]".len();
    let _ = extract_context(body, link_start..link_end, 0);
}

// ---------------------------------------------------------------------------
// UTF-8 char boundary regressions
// ---------------------------------------------------------------------------

#[test]
fn multibyte_before_link_does_not_panic() {
    // Regression: `window_start` is derived by byte arithmetic
    // (`rel_start - before_budget`) and was used to slice the paragraph
    // directly. With multi-byte characters ahead of the link it can land in
    // the middle of a character, panicking.
    let body = format!("{}[[Alpha]] tail text goes here", "é".repeat(10));
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(&body, link_start..link_end, 20);
    assert!(snippet.contains("[[Alpha]]"));
}

#[test]
fn multibyte_after_link_does_not_panic() {
    // Regression: `window_end` (`rel_end + after_budget`) was used to slice
    // the paragraph and can land mid-character when the text following the
    // link is multi-byte.
    let body = format!("abcdefghij[[Alpha]]{}", "é".repeat(10));
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(&body, link_start..link_end, 18);
    assert!(snippet.contains("[[Alpha]]"));
}

#[test]
fn multibyte_sweep_never_panics() {
    // Exhaustive sweep across budgets and multi-byte widths (2-, 3- and
    // 4-byte characters) with and without spaces to snap to.
    let fillers = ["é", "→", "🕰", "éa", "→ ", "🕰 ", "a🕰"];
    for filler in fillers {
        for pad in 1..12usize {
            let before = filler.repeat(pad);
            let after = filler.repeat(pad);
            let body = format!("{before}[[Alpha]]{after}");
            let link_start = body.find("[[Alpha]]").unwrap();
            let link_end = link_start + "[[Alpha]]".len();
            for max_chars in 0..40usize {
                let snippet = extract_context(&body, link_start..link_end, max_chars);
                assert!(
                    body.contains(snippet.trim_matches('\u{2026}')),
                    "snippet {snippet:?} not a substring of {body:?} \
                     (filler={filler:?}, pad={pad}, max_chars={max_chars})"
                );
            }
        }
    }
}

#[test]
fn multibyte_paragraph_split_is_respected() {
    let body = "Öffnungszeiten stehen hier.\n\nDer Absatz erwähnt [[Alpha]] genau hier.\n\nNächster Absatz.";
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(body, link_start..link_end, 100);
    assert!(snippet.contains("[[Alpha]]"));
    assert!(!snippet.contains("Öffnungszeiten"));
    assert!(!snippet.contains("Nächster"));
}

#[test]
fn max_chars_counts_characters_not_bytes() {
    // `max_chars` is documented as a character budget; a paragraph of 30
    // multi-byte characters must survive a 40-character budget untruncated.
    let body = "🕰".repeat(30);
    let snippet = extract_context(&body, 0..4, 40);
    assert_eq!(snippet, body, "no truncation expected within the budget");
    assert!(!snippet.contains('\u{2026}'));
}

#[test]
fn truncated_snippet_respects_char_budget() {
    let body = format!("{} [[Alpha]] {}", "é".repeat(60), "é".repeat(60));
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(&body, link_start..link_end, 40);
    let content_chars = snippet.chars().filter(|c| *c != '\u{2026}').count();
    assert!(
        content_chars <= 40,
        "snippet had {content_chars} chars, budget was 40: {snippet:?}"
    );
    assert!(snippet.contains("[[Alpha]]"));
}

#[test]
fn spaceless_script_keeps_the_link() {
    // Word-boundary snapping walks to the next/previous space. In scripts
    // written without spaces there is none inside the window, and snapping
    // used to walk clean past the link, yielding a snippet that never showed
    // the link it was meant to contextualise.
    let body = format!("{}[[Alpha]]{}", "時計".repeat(20), "水時計".repeat(20));
    let link_start = body.find("[[Alpha]]").unwrap();
    let link_end = link_start + "[[Alpha]]".len();
    let snippet = extract_context(&body, link_start..link_end, 30);
    assert!(
        snippet.contains("[[Alpha]]"),
        "snippet lost the link: {snippet:?}"
    );
}

#[test]
fn non_boundary_span_does_not_panic() {
    // Spans are read from the index but applied to the file as it is on disk,
    // so an edit since the last index run can leave them mid-character.
    let body = "序文です。\n\n段落に🕰があります。\n\n終わり。";
    for start in 0..body.len() {
        for end in start..body.len() {
            let snippet = extract_context(body, start..end, 12);
            assert!(
                body.contains(snippet.trim_matches('\u{2026}')),
                "snippet {snippet:?} not a substring of body (start={start}, end={end})"
            );
        }
    }
}

#[test]
fn span_past_end_of_body_does_not_panic() {
    let body = "A paragraph with a 🕰 in it.";
    let _ = extract_context(body, body.len() + 5..body.len() + 20, 30);
    let _ = extract_context(body, 10..usize::MAX, 30);
    // Reversed spans are clamped rather than slicing backwards.
    let (start, end) = (20usize, 5usize);
    let _ = extract_context(body, start..end, 30);
}
