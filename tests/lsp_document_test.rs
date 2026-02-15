use clepsydra::lsp::document::Document;
use clepsydra::vault::link::LinkKind;
use tower_lsp::lsp_types::Position;

const SIMPLE_DOC: &str = "\
---
title: Test Page
tags: [alpha, beta]
---
Hello world.

This has a [[Wikilink]] in it.
";

#[test]
fn parse_extracts_meta_and_body() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let title = doc.meta.title.as_deref().expect("title should be present");
    assert_eq!(title, "Test Page");
    assert_eq!(doc.meta.tags, vec!["alpha", "beta"]);
    assert!(doc.body.contains("Hello world."));
    assert!(doc.body.contains("[[Wikilink]]"));
    assert!(
        !doc.body.contains("---"),
        "body must not contain frontmatter fences"
    );
}

#[test]
fn body_byte_offset_is_correct() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let tail = &SIMPLE_DOC[doc.body_byte_offset..];
    assert_eq!(tail, doc.body, "SIMPLE_DOC[body_byte_offset..] must equal body");
}

#[test]
fn links_are_extracted() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    assert_eq!(doc.links.len(), 1, "expected exactly one link");
    assert_eq!(doc.links[0].target_raw, "Wikilink");
    assert_eq!(doc.links[0].kind, LinkKind::Wiki);
}

#[test]
fn byte_offset_to_position_body_start() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    // Body offset 0 should map to the first line after the frontmatter.
    let pos = doc.byte_offset_to_position(0);
    // Count the frontmatter lines: "---\n", "title: ...\n", "tags: ...\n", "---\n"
    // That's 4 lines, so the body starts at line index 4.
    assert_eq!(pos.line, 4, "body start should be at line 4 (0-indexed)");
    assert_eq!(pos.character, 0, "body start should be at character 0");
}

#[test]
fn byte_offset_to_position_link_span() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let link = &doc.links[0];

    let start = doc.byte_offset_to_position(link.span.start);
    let end = doc.byte_offset_to_position(link.span.end);

    assert_eq!(start.line, end.line, "wikilink should be on a single line");
    assert!(
        end.character > start.character,
        "end character ({}) must be greater than start character ({})",
        end.character,
        start.character
    );
}

#[test]
fn position_to_byte_offset_roundtrip() {
    let doc = Document::from_text(SIMPLE_DOC, 1);

    // Test several body offsets: start, middle of "Hello", start of link
    let offsets = [0, 5, doc.links[0].span.start, doc.links[0].span.end.saturating_sub(1)];

    for &offset in &offsets {
        let pos = doc.byte_offset_to_position(offset);
        let back = doc
            .position_to_body_byte_offset(pos)
            .unwrap_or_else(|| panic!("roundtrip failed for body offset {offset}: position {pos:?} mapped to None"));
        assert_eq!(
            back, offset,
            "roundtrip failed for body offset {offset}: got {back}"
        );
    }
}

#[test]
fn malformed_frontmatter_treats_whole_file_as_body() {
    let text = "No frontmatter here.\n\nJust plain text with [[Link]].\n";
    let doc = Document::from_text(text, 1);

    assert_eq!(doc.body_byte_offset, 0, "entire text should be the body");
    assert_eq!(doc.body, text);
    assert!(doc.meta.title.is_none(), "default meta should have no title");
    assert_eq!(doc.links.len(), 1, "link should still be extracted");
    assert_eq!(doc.links[0].target_raw, "Link");
}

#[test]
fn link_at_position_finds_link() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let link = &doc.links[0];

    // Position in the middle of the link span.
    let mid_offset = link.span.start + (link.span.end - link.span.start) / 2;
    let mid_pos = doc.byte_offset_to_position(mid_offset);

    let found = doc
        .link_at_position(mid_pos)
        .expect("should find link at mid-span position");
    assert_eq!(found.target_raw, "Wikilink");
}

#[test]
fn link_at_position_returns_none_outside() {
    let doc = Document::from_text(SIMPLE_DOC, 1);

    // Position at the very start of the body ("Hello world.") — no link there.
    let pos = doc.byte_offset_to_position(0);
    assert!(
        doc.link_at_position(pos).is_none(),
        "no link expected at start of body"
    );
}

#[test]
fn link_at_position_returns_none_in_frontmatter() {
    let doc = Document::from_text(SIMPLE_DOC, 1);

    // Position in the frontmatter (line 1, character 0).
    let pos = Position {
        line: 1,
        character: 0,
    };
    assert!(
        doc.link_at_position(pos).is_none(),
        "positions in frontmatter should return None"
    );
}

#[test]
fn link_to_range_produces_valid_range() {
    let doc = Document::from_text(SIMPLE_DOC, 1);
    let link = &doc.links[0];
    let range = doc.link_to_range(link);

    assert!(
        range.start.line <= range.end.line,
        "start line must be <= end line"
    );
    if range.start.line == range.end.line {
        assert!(
            range.start.character < range.end.character,
            "on same line, start character ({}) must be < end character ({})",
            range.start.character,
            range.end.character
        );
    }
}
