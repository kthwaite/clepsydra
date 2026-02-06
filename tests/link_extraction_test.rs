use clepsydra::vault::link::{LinkKind, extract_links};

#[test]
fn extract_wikilink() {
    let body = "See [[Design Notes]] for details.";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Design Notes");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn extract_wikilink_with_display() {
    let body = "See [[Design Notes|my notes]]";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Design Notes");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn extract_markdown_link() {
    let body = "See [notes](design.md)";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "design.md");
    assert_eq!(links[0].kind, LinkKind::Markdown);
}

#[test]
fn skip_links_in_fenced_code() {
    let body = "```\n[[not a link]]\n```";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "wikilinks inside fenced code blocks must be ignored"
    );
}

#[test]
fn skip_links_in_inline_code() {
    let body = "`[[not a link]]`";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "wikilinks inside inline code must be ignored"
    );
}

#[test]
fn multiple_links_in_paragraph() {
    let body = "[[A]] and [[B]] also [C](c.md)";
    let links = extract_links(body);
    assert_eq!(links.len(), 3);

    let wiki_links: Vec<_> = links.iter().filter(|l| l.kind == LinkKind::Wiki).collect();
    let md_links: Vec<_> = links
        .iter()
        .filter(|l| l.kind == LinkKind::Markdown)
        .collect();
    assert_eq!(wiki_links.len(), 2);
    assert_eq!(md_links.len(), 1);

    let targets: Vec<&str> = links.iter().map(|l| l.target_raw.as_str()).collect();
    assert!(targets.contains(&"A"));
    assert!(targets.contains(&"B"));
    assert!(targets.contains(&"c.md"));
}

#[test]
fn wikilink_with_path() {
    let body = "[[projects/design notes]]";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "projects/design notes");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn skip_links_in_indented_code() {
    // Four-space indent creates an indented code block (needs a preceding blank line).
    let body = "paragraph\n\n    [[link]]\n";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "wikilinks inside indented code blocks must be ignored"
    );
}

#[test]
fn external_url_ignored() {
    let body = "[Google](https://google.com)";
    let links = extract_links(body);
    assert_eq!(links.len(), 0, "external URLs must be skipped");
}

#[test]
fn links_in_blockquote() {
    let body = "> [[quoted link]]";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "quoted link");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}
