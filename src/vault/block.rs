use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, TextMergeWithOffset};
use regex::Regex;

/// The structural type of a block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockType {
    Paragraph,
    ListItem,
    Heading,
    Code,
    Blockquote,
}

/// Checkbox state for task-list items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckboxState {
    Todo,
    Done,
    Cancelled,
}

/// A single block extracted from a markdown document.
#[derive(Debug, Clone)]
pub struct Block {
    /// Structural type of this block.
    pub block_type: BlockType,
    /// Raw text content with `^id` and `[key:: value]` stripped.
    pub content: String,
    /// Block identifier (e.g. `abc123DEF0` from `^abc123DEF0`).
    pub block_id: Option<String>,
    /// Inline properties extracted from `[key:: value]` syntax.
    pub properties: HashMap<String, String>,
    /// Checkbox state for task-list items.
    pub checkbox: Option<CheckboxState>,
    /// Nesting depth: 0 = top-level.
    pub depth: usize,
    /// Index of the parent block in the returned `Vec`, if nested.
    pub parent_index: Option<usize>,
    /// Sibling ordering within the same parent (0-based).
    pub order_index: usize,
    /// Byte range in the source markdown.
    pub span: Range<usize>,
}

/// Lazily compiled regex for block IDs: `^abc123DEF0` at end of text.
fn block_id_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+\^([A-Za-z0-9]{10,12})\s*$").unwrap())
}

/// Lazily compiled regex for inline properties: `[key:: value]`.
fn inline_property_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([A-Za-z_][\w-]*)::\s+([^\]]+)\]").unwrap())
}

/// Lazily compiled regex for cancelled checkbox: `[-] ` at start of text.
fn cancelled_checkbox_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[-\]\s*").unwrap())
}

/// Strip a block ID from the end of `text`, returning the ID if found.
fn extract_block_id(text: &mut String) -> Option<String> {
    let re = block_id_regex();
    if let Some(caps) = re.captures(text.as_str()) {
        let id = caps[1].to_string();
        let match_start = caps.get(0).unwrap().start();
        text.truncate(match_start);
        Some(id)
    } else {
        None
    }
}

/// Strip all `[key:: value]` inline properties from `text`, returning them.
fn extract_inline_properties(text: &mut String) -> HashMap<String, String> {
    let re = inline_property_regex();
    let mut props = HashMap::new();
    let mut result = String::with_capacity(text.len());
    let mut last_end = 0;

    for caps in re.captures_iter(text.as_str()) {
        let m = caps.get(0).unwrap();
        let key = caps[1].to_string();
        let value = caps[2].trim().to_string();
        result.push_str(&text[last_end..m.start()]);
        last_end = m.end();
        props.insert(key, value);
    }

    if !props.is_empty() {
        result.push_str(&text[last_end..]);
        *text = result;
    }

    props
}

/// Check if text starts with `[-]` (cancelled checkbox not handled by
/// pulldown-cmark). Returns `true` if found and strips the prefix from `text`.
fn extract_cancelled_checkbox(text: &mut String) -> bool {
    let re = cancelled_checkbox_regex();
    if let Some(m) = re.find(text.as_str()) {
        let after = text[m.end()..].to_string();
        *text = after;
        true
    } else {
        false
    }
}

/// Post-process raw content: extract block ID, inline properties, and trim.
fn postprocess_content(text: &mut String) -> (Option<String>, HashMap<String, String>) {
    let block_id = extract_block_id(text);
    let properties = extract_inline_properties(text);
    *text = text.trim().to_string();
    (block_id, properties)
}

/// Internal state for tracking the current block being built.
#[derive(Debug)]
struct BlockBuilder {
    block_type: BlockType,
    text_parts: Vec<String>,
    checkbox: Option<CheckboxState>,
    list_depth: usize,
    span_start: usize,
    span_end: usize,
}

/// Emit the in-progress builder (if any), clearing `current`.
fn flush_current(blocks: &mut Vec<Block>, current: &mut Option<BlockBuilder>) {
    if let Some(builder) = current.take() {
        emit_block(blocks, builder);
    }
}

/// Flush any in-progress block and start a fresh builder of `block_type`.
fn start_block_builder(
    blocks: &mut Vec<Block>,
    current: &mut Option<BlockBuilder>,
    block_type: BlockType,
    list_depth: usize,
    span_start: usize,
    span_end: usize,
) {
    flush_current(blocks, current);
    *current = Some(BlockBuilder {
        block_type,
        text_parts: Vec::new(),
        checkbox: None,
        list_depth,
        span_start,
        span_end,
    });
}

/// Set the in-progress builder's `span_end` then flush it (used by the End arms
/// of Item / Heading / CodeBlock).
fn finish_block(blocks: &mut Vec<Block>, current: &mut Option<BlockBuilder>, span_end: usize) {
    if let Some(builder) = current.as_mut() {
        builder.span_end = span_end;
    }
    flush_current(blocks, current);
}

/// Apply a task-list checkbox marker to the in-progress builder.
fn set_checkbox(current: &mut Option<BlockBuilder>, checked: bool) {
    if let Some(builder) = current.as_mut() {
        builder.checkbox = Some(if checked {
            CheckboxState::Done
        } else {
            CheckboxState::Todo
        });
    }
}

/// Handle `Start(Paragraph)`. Inside a blockquote a paragraph is a structural
/// wrapper, so we (re)start a Blockquote builder spanning from the blockquote
/// start WITHOUT flushing the current builder (matches the original); otherwise
/// start a normal Paragraph builder.
fn handle_paragraph_start(
    blocks: &mut Vec<Block>,
    current: &mut Option<BlockBuilder>,
    in_blockquote: bool,
    blockquote_span_start: usize,
    range_start: usize,
    range_end: usize,
) {
    if in_blockquote {
        *current = Some(BlockBuilder {
            block_type: BlockType::Blockquote,
            text_parts: Vec::new(),
            checkbox: None,
            list_depth: 0,
            span_start: blockquote_span_start,
            span_end: range_end,
        });
    } else {
        start_block_builder(
            blocks,
            current,
            BlockType::Paragraph,
            0,
            range_start,
            range_end,
        );
    }
}

/// Handle `End(Paragraph)`: set the builder's span_end (blockquote end when in a
/// blockquote, else the paragraph range end), then flush.
fn handle_paragraph_end(
    blocks: &mut Vec<Block>,
    current: &mut Option<BlockBuilder>,
    in_blockquote: bool,
    blockquote_span_end: usize,
    range_end: usize,
) {
    if let Some(builder) = current.as_mut() {
        builder.span_end = if in_blockquote {
            blockquote_span_end
        } else {
            range_end
        };
    }
    flush_current(blocks, current);
}

/// Append inline text to the in-progress builder (no-op if none open).
fn append_text(current: &mut Option<BlockBuilder>, text: String) {
    if let Some(builder) = current.as_mut() {
        builder.text_parts.push(text);
    }
}

/// Parse a markdown document into a flat list of blocks with parent-child
/// relationships encoded via `parent_index`.
///
/// Uses pulldown-cmark with all extensions enabled (including task lists).
/// Follows the same `TextMergeWithOffset` pattern as `extract_links` in
/// `src/vault/link.rs`.
pub fn parse_blocks(markdown: &str) -> Vec<Block> {
    let opts = Options::all();
    let raw_iter = Parser::new_ext(markdown, opts).into_offset_iter();
    let parser = TextMergeWithOffset::new(raw_iter);

    let mut blocks: Vec<Block> = Vec::new();
    let mut current: Option<BlockBuilder> = None;
    let mut list_depth: usize = 0;
    let mut in_blockquote = false;
    let mut blockquote_span_start: usize = 0;
    let mut blockquote_span_end: usize = 0;

    for (event, range) in parser {
        match event {
            Event::Start(Tag::List(_)) => list_depth += 1,
            Event::End(TagEnd::List(_)) => list_depth = list_depth.saturating_sub(1),
            Event::Start(Tag::Item) => start_block_builder(
                &mut blocks,
                &mut current,
                BlockType::ListItem,
                list_depth.saturating_sub(1),
                range.start,
                range.end,
            ),
            Event::End(TagEnd::Item) => finish_block(&mut blocks, &mut current, range.end),
            Event::TaskListMarker(checked) => set_checkbox(&mut current, checked),
            Event::Start(Tag::Heading { .. }) => start_block_builder(
                &mut blocks,
                &mut current,
                BlockType::Heading,
                0,
                range.start,
                range.end,
            ),
            Event::End(TagEnd::Heading(_)) => finish_block(&mut blocks, &mut current, range.end),
            Event::Start(Tag::Paragraph) => handle_paragraph_start(
                &mut blocks,
                &mut current,
                in_blockquote,
                blockquote_span_start,
                range.start,
                range.end,
            ),
            Event::End(TagEnd::Paragraph) => handle_paragraph_end(
                &mut blocks,
                &mut current,
                in_blockquote,
                blockquote_span_end,
                range.end,
            ),
            Event::Start(Tag::CodeBlock(_)) => start_block_builder(
                &mut blocks,
                &mut current,
                BlockType::Code,
                0,
                range.start,
                range.end,
            ),
            Event::End(TagEnd::CodeBlock) => finish_block(&mut blocks, &mut current, range.end),
            Event::Start(Tag::BlockQuote(_)) => {
                in_blockquote = true;
                blockquote_span_start = range.start;
                blockquote_span_end = range.end;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                in_blockquote = false;
                blockquote_span_end = range.end;
            }
            Event::Text(text) => append_text(&mut current, text.to_string()),
            Event::Code(code) => append_text(&mut current, format!("`{code}`")),
            Event::SoftBreak => append_text(&mut current, " ".to_string()),
            Event::HardBreak => append_text(&mut current, "\n".to_string()),
            _ => {}
        }
    }

    flush_current(&mut blocks, &mut current);

    // Compute parent_index and order_index using a depth stack.
    assign_parents_and_order(&mut blocks);

    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flush_current_emits_and_clears() {
        let mut blocks = Vec::new();
        let mut current = Some(BlockBuilder {
            block_type: BlockType::Paragraph,
            text_parts: vec!["hi".to_string()],
            checkbox: None,
            list_depth: 0,
            span_start: 0,
            span_end: 2,
        });
        flush_current(&mut blocks, &mut current);
        assert!(current.is_none());
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].content, "hi");
    }

    #[test]
    fn set_checkbox_maps_checked_flag() {
        let mut current = Some(BlockBuilder {
            block_type: BlockType::ListItem,
            text_parts: Vec::new(),
            checkbox: None,
            list_depth: 0,
            span_start: 0,
            span_end: 0,
        });
        set_checkbox(&mut current, true);
        assert_eq!(
            current.as_ref().unwrap().checkbox,
            Some(CheckboxState::Done)
        );
        set_checkbox(&mut current, false);
        assert_eq!(
            current.as_ref().unwrap().checkbox,
            Some(CheckboxState::Todo)
        );
    }
}

/// Convert a `BlockBuilder` into a `Block` and push it onto the result vec.
fn emit_block(blocks: &mut Vec<Block>, builder: BlockBuilder) {
    let mut content = builder.text_parts.join("");

    // For list items without a TaskListMarker, check for `[-]` cancelled pattern
    let checkbox = if builder.block_type == BlockType::ListItem && builder.checkbox.is_none() {
        if extract_cancelled_checkbox(&mut content) {
            Some(CheckboxState::Cancelled)
        } else {
            None
        }
    } else {
        builder.checkbox
    };

    // Post-process: extract block ID and inline properties
    let (block_id, mut properties) = postprocess_content(&mut content);

    // Set status property from checkbox state
    if let Some(state) = checkbox {
        let status = match state {
            CheckboxState::Todo => "todo",
            CheckboxState::Done => "done",
            CheckboxState::Cancelled => "cancelled",
        };
        properties.insert("status".to_string(), status.to_string());
    }

    blocks.push(Block {
        block_type: builder.block_type,
        content,
        block_id,
        properties,
        checkbox,
        depth: builder.list_depth,
        parent_index: None, // assigned later
        order_index: 0,     // assigned later
        span: builder.span_start..builder.span_end,
    });
}

/// Assign `parent_index` and `order_index` to each block based on depth.
///
/// Uses a stack of `(depth, block_index)` pairs. For each block at depth D:
/// - Pop entries with depth >= D (they are not ancestors).
/// - The remaining top-of-stack entry (if any, with depth < D) is the parent.
/// - Push the current block onto the stack.
///
/// `order_index` counts siblings sharing the same parent.
fn assign_parents_and_order(blocks: &mut [Block]) {
    // Stack entries: (depth, index_in_blocks_vec)
    let mut stack: Vec<(usize, usize)> = Vec::new();
    // Track per-parent sibling count: parent_index (None → usize::MAX sentinel) → next order
    let mut sibling_counter: HashMap<usize, usize> = HashMap::new();
    // Sentinel for top-level blocks (no parent)
    const NO_PARENT: usize = usize::MAX;

    for (i, block) in blocks.iter_mut().enumerate() {
        let depth = block.depth;

        // Pop entries at same or deeper level
        while let Some(&(d, _)) = stack.last() {
            if d >= depth {
                stack.pop();
            } else {
                break;
            }
        }

        // Determine parent
        let parent_index = stack.last().map(|&(_, idx)| idx);
        block.parent_index = parent_index;

        // Assign order_index
        let parent_key = parent_index.unwrap_or(NO_PARENT);
        let order = sibling_counter.entry(parent_key).or_insert(0);
        block.order_index = *order;
        *order += 1;

        stack.push((depth, i));
    }
}
