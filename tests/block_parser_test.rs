use clepsydra::vault::block::{parse_blocks, BlockType, CheckboxState};

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
    assert!(blocks
        .iter()
        .any(|b| b.block_type == BlockType::Heading && b.content == "Title"));
    assert!(blocks
        .iter()
        .any(|b| b.block_type == BlockType::Paragraph && b.content == "Some text."));
    assert!(blocks
        .iter()
        .any(|b| b.block_type == BlockType::Heading && b.content == "Section"));
}

#[test]
fn parses_code_block() {
    let md = "```rust\nfn main() {}\n```\n";
    let blocks = parse_blocks(md);
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].block_type, BlockType::Code);
    assert!(blocks[0].content.contains("fn main() {}"));
}

#[test]
fn records_byte_spans() {
    let md = "- First\n- Second\n";
    let blocks = parse_blocks(md);
    // Spans should be within the source markdown bounds
    assert!(blocks[0].span.start < blocks[0].span.end);
    assert!(blocks[1].span.start < blocks[1].span.end);
    assert!(
        blocks[0].span.end <= blocks[1].span.start
            || blocks[0].span.start != blocks[1].span.start
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
    assert!(blocks
        .iter()
        .any(|b| b.block_type == BlockType::Blockquote && b.content == "Some quoted text"));
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
