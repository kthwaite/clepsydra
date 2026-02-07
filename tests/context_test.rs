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
