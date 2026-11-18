use std::collections::HashSet;

use clep_vault::block::{BlockType, CheckboxState, parse_blocks};

#[test]
fn parses_simple_list() {
    let md = "- Item one\n- Item two\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].block_type, BlockType::ListItem);
    assert_eq!(blocks[0].content, "Item one");
    assert_eq!(blocks[0].depth, 0);
    assert!(blocks[0].parent_index.is_none());
    assert_eq!(blocks[1].content, "Item two");
}

#[test]
fn parses_nested_list() {
    let md = "- Parent\n  - Child one\n  - Child two\n- Sibling\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 4);
    assert_eq!(blocks[0].content, "Parent");
    assert_eq!(blocks[0].depth, 0);
    assert_eq!(blocks[1].content, "Child one");
    assert_eq!(blocks[1].depth, 1);
    assert_eq!(blocks[1].parent_index, Some(0));
    assert_eq!(blocks[2].content, "Child two");
    assert_eq!(blocks[2].depth, 1);
    assert_eq!(blocks[2].parent_index, Some(0));
    assert_eq!(blocks[3].content, "Sibling");
    assert_eq!(blocks[3].depth, 0);
    assert!(blocks[3].parent_index.is_none());
}

#[test]
fn parses_block_id() {
    let md = "- Item with id ^abc123DEF0\n- No id\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].block_id.as_deref(), Some("abc123DEF0"));
    assert_eq!(blocks[0].content, "Item with id");
    assert!(blocks[1].block_id.is_none());
}

#[test]
fn parses_inline_properties() {
    let md = "- Buy milk [due:: 2026-03-01] [priority:: A]\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].content, "Buy milk");
    assert_eq!(
        blocks[0].properties.get("due").map(String::as_str),
        Some("2026-03-01")
    );
    assert_eq!(
        blocks[0].properties.get("priority").map(String::as_str),
        Some("A")
    );
}

#[test]
fn parses_checkboxes() {
    let md = "- [ ] Todo\n- [x] Done\n- Regular\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Todo));
    assert_eq!(blocks[1].checkbox, Some(CheckboxState::Done));
    assert_eq!(blocks[2].checkbox, None);
}

#[test]
fn checkbox_sets_status_property() {
    let md = "- [ ] Todo task [due:: 2026-03-01]\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Todo));
    assert_eq!(
        blocks[0].properties.get("status").map(String::as_str),
        Some("todo")
    );
    assert_eq!(
        blocks[0].properties.get("due").map(String::as_str),
        Some("2026-03-01")
    );
}

#[test]
fn parses_cancelled_checkbox() {
    let md = "- [-] Cancelled task\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Cancelled));
    assert_eq!(blocks[0].content, "Cancelled task");
    assert_eq!(
        blocks[0].properties.get("status").map(String::as_str),
        Some("cancelled")
    );
}

#[test]
fn parses_headings() {
    let md = "# Title\n\nSome text.\n\n## Section\n";
    let blocks = parse_blocks(md);
    assert!(
        blocks
            .iter()
            .any(|b| b.block_type == BlockType::Heading && b.content == "Title")
    );
    assert!(
        blocks
            .iter()
            .any(|b| b.block_type == BlockType::Paragraph && b.content == "Some text.")
    );
    assert!(
        blocks
            .iter()
            .any(|b| b.block_type == BlockType::Heading && b.content == "Section")
    );
}

#[test]
fn parses_code_block_with_terminal_block_id() {
    let md = "```rust\nfn main() {}\n^abc123DEF0\n```\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].block_type, BlockType::Code);
    assert_eq!(blocks[0].content, "fn main() {}");
    assert_eq!(blocks[0].block_id.as_deref(), Some("abc123DEF0"));
}

#[test]
fn records_byte_spans() {
    let md = "- First\n- Second\n";
    let blocks = parse_blocks(md);
    // Spans should be within the source markdown bounds
    assert!(blocks[0].span.start < blocks[0].span.end);
    assert!(blocks[1].span.start < blocks[1].span.end);
    assert!(
        blocks[0].span.end <= blocks[1].span.start || blocks[0].span.start != blocks[1].span.start
    );
}

#[test]
fn span_covers_source_text() {
    let md = "- First item\n- Second item\n";
    let blocks = parse_blocks(md);
    // The span for each block should index into the original markdown
    let span0 = &md[blocks[0].span.clone()];
    assert!(
        span0.contains("First"),
        "span0 should contain 'First', got {:?}",
        span0
    );
    let span1 = &md[blocks[1].span.clone()];
    assert!(
        span1.contains("Second"),
        "span1 should contain 'Second', got {:?}",
        span1
    );
}

#[test]
fn order_index_tracks_sibling_ordering() {
    let md = "- Alpha\n- Beta\n- Gamma\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].order_index, 0);
    assert_eq!(blocks[1].order_index, 1);
    assert_eq!(blocks[2].order_index, 2);
}

#[test]
fn nested_order_index_resets_per_parent() {
    let md = "- Parent A\n  - Child A1\n  - Child A2\n- Parent B\n  - Child B1\n";
    let blocks = parse_blocks(md);
    // Parent A at depth 0
    assert_eq!(blocks[0].content, "Parent A");
    assert_eq!(blocks[0].order_index, 0);
    // Child A1, A2 at depth 1 under Parent A
    assert_eq!(blocks[1].content, "Child A1");
    assert_eq!(blocks[1].order_index, 0);
    assert_eq!(blocks[2].content, "Child A2");
    assert_eq!(blocks[2].order_index, 1);
    // Parent B at depth 0
    assert_eq!(blocks[3].content, "Parent B");
    assert_eq!(blocks[3].order_index, 1);
    // Child B1 at depth 1 under Parent B
    assert_eq!(blocks[4].content, "Child B1");
    assert_eq!(blocks[4].order_index, 0);
}

#[test]
fn parses_blockquote() {
    let md = "> Some quoted text\n";
    let blocks = parse_blocks(md);
    assert!(
        blocks
            .iter()
            .any(|b| b.block_type == BlockType::Blockquote && b.content == "Some quoted text")
    );
}

#[test]
fn blockquote_paragraphs_have_distinct_source_spans() {
    let md = "> First paragraph.\n>\n> Second paragraph.\n";
    let blocks = parse_blocks(md);

    assert_eq!(blocks.len(), 2);
    assert!(
        blocks
            .iter()
            .all(|block| block.block_type == BlockType::Blockquote)
    );
    assert_ne!(blocks[0].span.start, blocks[1].span.start);
    assert_eq!(&md[blocks[0].span.clone()], "First paragraph.\n");
    assert_eq!(&md[blocks[1].span.clone()], "Second paragraph.\n");
}

#[test]
fn blockquote_paragraphs_and_list_items_have_unique_source_spans() {
    let md = "> Summary\n>\n> - Option A\n> - Option B\n>\n> Outcome\n";
    let blocks = parse_blocks(md);
    let span_starts: HashSet<_> = blocks.iter().map(|block| block.span.start).collect();

    assert_eq!(blocks.len(), 4);
    assert_eq!(span_starts.len(), blocks.len());
    assert_eq!(blocks[0].content, "Summary");
    assert_eq!(blocks[1].content, "Option A");
    assert_eq!(blocks[2].content, "Option B");
    assert_eq!(blocks[3].content, "Outcome");
}

#[test]
fn deeply_nested_list() {
    let md = "- A\n  - B\n    - C\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0].content, "A");
    assert_eq!(blocks[0].depth, 0);
    assert!(blocks[0].parent_index.is_none());
    assert_eq!(blocks[1].content, "B");
    assert_eq!(blocks[1].depth, 1);
    assert_eq!(blocks[1].parent_index, Some(0));
    assert_eq!(blocks[2].content, "C");
    assert_eq!(blocks[2].depth, 2);
    assert_eq!(blocks[2].parent_index, Some(1));
}

#[test]
fn block_id_with_inline_properties() {
    let md = "- Task [priority:: high] ^abc123DEF0\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks[0].content, "Task");
    assert_eq!(blocks[0].block_id.as_deref(), Some("abc123DEF0"));
    assert_eq!(
        blocks[0].properties.get("priority").map(String::as_str),
        Some("high")
    );
}

#[test]
fn empty_input_returns_no_blocks() {
    let blocks = parse_blocks("");
    assert!(blocks.is_empty());
}

#[test]
fn heading_with_block_id() {
    let md = "# My Title ^abc123DEF0\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].block_type, BlockType::Heading);
    assert_eq!(blocks[0].content, "My Title");
    assert_eq!(blocks[0].block_id.as_deref(), Some("abc123DEF0"));
}

/// The fields a loose list must share with its tight twin.
#[derive(Debug, PartialEq)]
struct Shape {
    block_type: BlockType,
    depth: usize,
    parent_index: Option<usize>,
    order_index: usize,
    content: String,
    checkbox: Option<CheckboxState>,
    block_id: Option<String>,
    status: Option<String>,
}

fn shape(md: &str) -> Vec<Shape> {
    parse_blocks(md)
        .into_iter()
        .map(|b| Shape {
            block_type: b.block_type,
            depth: b.depth,
            parent_index: b.parent_index,
            order_index: b.order_index,
            content: b.content,
            checkbox: b.checkbox,
            block_id: b.block_id,
            status: b.properties.get("status").cloned(),
        })
        .collect()
}

#[test]
fn loose_task_list_gives_the_same_blocks_as_the_tight_list() {
    // A blank line between items makes the list loose: pulldown wraps each
    // item's text in a paragraph. The item must still be the block.
    let tight = "- [ ] a\n- [x] b ^abc123DEF0\n- [-] c\n- d\n";
    let loose = "- [ ] a\n\n- [x] b ^abc123DEF0\n\n- [-] c\n\n- d\n";
    let item =
        |order_index, content: &str, checkbox, id: Option<&str>, status: Option<&str>| Shape {
            block_type: BlockType::ListItem,
            depth: 0,
            parent_index: None,
            order_index,
            content: content.to_string(),
            checkbox,
            block_id: id.map(str::to_string),
            status: status.map(str::to_string),
        };
    let expected = || {
        vec![
            item(0, "a", Some(CheckboxState::Todo), None, Some("todo")),
            item(
                1,
                "b",
                Some(CheckboxState::Done),
                Some("abc123DEF0"),
                Some("done"),
            ),
            item(
                2,
                "c",
                Some(CheckboxState::Cancelled),
                None,
                Some("cancelled"),
            ),
            item(3, "d", None, None, None),
        ]
    };
    assert_eq!(shape(tight), expected());
    assert_eq!(shape(loose), expected());
}

#[test]
fn loose_list_item_span_is_the_item_marker_through_its_text_line() {
    // The same source text as the tight item's span: the blank line that
    // separates loose items is not part of the block, so text appended at
    // the span end (a generated ` ^id`) lands on the item's own line.
    let md = "- [ ] a\n\n- b\n\ntail\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 3);
    assert_eq!(&md[blocks[0].span.clone()], "- [ ] a\n");
    assert_eq!(&md[blocks[1].span.clone()], "- b\n");
    assert_eq!(blocks[2].block_type, BlockType::Paragraph);
    assert_eq!(blocks[2].content, "tail");
}

#[test]
fn loose_nested_items_have_the_item_as_parent() {
    let tight = "1. [ ] x\n   - [x] y\n";
    let loose = "1. [ ] x\n\n   - [x] y\n";
    assert_eq!(shape(loose), shape(tight));
    let blocks = parse_blocks(loose);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].content, "x");
    assert_eq!(blocks[1].content, "y");
    assert_eq!(blocks[1].depth, 1);
    assert_eq!(blocks[1].parent_index, Some(0));
}

#[test]
fn loose_list_in_a_blockquote_keeps_its_items() {
    let tight = "> - [x] q\n> - r\n";
    let loose = "> - [x] q\n>\n> - r\n";
    assert_eq!(shape(loose), shape(tight));
    let blocks = parse_blocks(loose);
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].block_type, BlockType::ListItem);
    assert_eq!(blocks[0].content, "q");
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Done));
}

#[test]
fn loose_definition_gives_the_same_blocks_as_the_tight_definition() {
    let tight = "Term\n: Def one\n: [-] two\n";
    let loose = "Term\n\n: Def one\n\n: [-] two\n";
    assert_eq!(shape(loose), shape(tight));
    let blocks = parse_blocks(loose);
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[1].content, "Def one");
    // A definition is never a task, loose or tight.
    assert_eq!(blocks[2].content, "[-] two");
    assert!(blocks[2].checkbox.is_none());
}

#[test]
fn later_paragraphs_of_a_list_item_stay_their_own_blocks() {
    // Only the lead paragraph is the item's text. A continuation paragraph
    // was a Paragraph block before and still is.
    let md = "- [ ] a\n\n  second\n\n- b\n";
    let blocks = parse_blocks(md);
    let summary: Vec<(BlockType, &str, Option<CheckboxState>)> = blocks
        .iter()
        .map(|b| (b.block_type.clone(), b.content.as_str(), b.checkbox))
        .collect();
    assert_eq!(
        summary,
        vec![
            (BlockType::ListItem, "a", Some(CheckboxState::Todo)),
            (BlockType::Paragraph, "second", None),
            (BlockType::ListItem, "b", None),
        ]
    );
    let starts: HashSet<usize> = blocks.iter().map(|b| b.span.start).collect();
    assert_eq!(starts.len(), blocks.len());
}

#[test]
fn item_with_a_continuation_paragraph_in_a_blockquote_is_not_dropped() {
    let md = "> - [ ] a\n>\n>   second\n";
    let blocks = parse_blocks(md);
    let summary: Vec<(BlockType, &str, Option<CheckboxState>)> = blocks
        .iter()
        .map(|b| (b.block_type.clone(), b.content.as_str(), b.checkbox))
        .collect();
    assert_eq!(
        summary,
        vec![
            (BlockType::ListItem, "a", Some(CheckboxState::Todo)),
            (BlockType::Blockquote, "second", None),
        ]
    );
}

#[test]
fn inline_property_values_keep_their_punctuation() {
    // Property values are data: quotes, dashes and dots stay as typed, not
    // typographic replacements.
    let blocks = parse_blocks("- t [k:: it's a--b...] [q:: \"x\"] [r:: a---b]\n");
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].content, "t");
    let prop = |key: &str| blocks[0].properties.get(key).map(String::as_str);
    assert_eq!(prop("k"), Some("it's a--b..."));
    assert_eq!(prop("q"), Some("\"x\""));
    assert_eq!(prop("r"), Some("a---b"));
}

#[test]
fn block_content_keeps_its_punctuation() {
    let content = |md: &str| parse_blocks(md)[0].content.clone();
    assert_eq!(content("don't -- stop...\n"), "don't -- stop...");
    assert_eq!(
        content("- [ ] say \"hi\" to 'them'\n"),
        "say \"hi\" to 'them'"
    );
    assert_eq!(content("# It's a heading\n"), "It's a heading");
    assert_eq!(content("> quote's end...\n"), "quote's end...");
    // A wikilink target in block text must stay resolvable.
    assert_eq!(content("- see [[Bob's page]]\n"), "see [[Bob's page]]");
}

#[test]
fn literal_punctuation_does_not_change_block_structure() {
    let md = "- [x] it's done ^abc123DEF0\n  - \"child\" -- one\n\nPara...\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0].checkbox, Some(CheckboxState::Done));
    assert_eq!(blocks[0].block_id.as_deref(), Some("abc123DEF0"));
    assert_eq!(blocks[0].content, "it's done");
    assert_eq!(blocks[1].parent_index, Some(0));
    assert_eq!(blocks[1].content, "\"child\" -- one");
    assert_eq!(blocks[2].block_type, BlockType::Paragraph);
    assert_eq!(blocks[2].content, "Para...");
}
