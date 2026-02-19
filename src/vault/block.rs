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
fn postprocess_content(
    text: &mut String,
) -> (Option<String>, HashMap<String, String>) {
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
            // --- List nesting ---
            Event::Start(Tag::List(_)) => {
                list_depth += 1;
            }
            Event::End(TagEnd::List(_)) => {
                list_depth = list_depth.saturating_sub(1);
            }

            // --- List items ---
            Event::Start(Tag::Item) => {
                // Emit any pending block before starting a new item
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
                // list_depth is 1-based while item is open (the List Start
                // fired before this Item Start), so item depth = list_depth - 1.
                current = Some(BlockBuilder {
                    block_type: BlockType::ListItem,
                    text_parts: Vec::new(),
                    checkbox: None,
                    list_depth: list_depth.saturating_sub(1),
                    span_start: range.start,
                    span_end: range.end,
                });
            }
            Event::End(TagEnd::Item) => {
                if let Some(ref mut builder) = current {
                    builder.span_end = range.end;
                }
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
            }

            // --- Task list markers ---
            Event::TaskListMarker(checked) => {
                if let Some(ref mut builder) = current {
                    builder.checkbox = Some(if checked {
                        CheckboxState::Done
                    } else {
                        CheckboxState::Todo
                    });
                }
            }

            // --- Headings ---
            Event::Start(Tag::Heading { .. }) => {
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
                current = Some(BlockBuilder {
                    block_type: BlockType::Heading,
                    text_parts: Vec::new(),
                    checkbox: None,
                    list_depth: 0,
                    span_start: range.start,
                    span_end: range.end,
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(ref mut builder) = current {
                    builder.span_end = range.end;
                }
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
            }

            // --- Paragraphs ---
            Event::Start(Tag::Paragraph) => {
                // Inside a blockquote, paragraphs are structural wrappers;
                // we emit a Blockquote block instead.
                if in_blockquote {
                    current = Some(BlockBuilder {
                        block_type: BlockType::Blockquote,
                        text_parts: Vec::new(),
                        checkbox: None,
                        list_depth: 0,
                        span_start: blockquote_span_start,
                        span_end: range.end,
                    });
                } else {
                    if let Some(builder) = current.take() {
                        emit_block(&mut blocks, builder);
                    }
                    current = Some(BlockBuilder {
                        block_type: BlockType::Paragraph,
                        text_parts: Vec::new(),
                        checkbox: None,
                        list_depth: 0,
                        span_start: range.start,
                        span_end: range.end,
                    });
                }
            }
            Event::End(TagEnd::Paragraph) => {
                if let Some(ref mut builder) = current {
                    builder.span_end = if in_blockquote {
                        blockquote_span_end
                    } else {
                        range.end
                    };
                }
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
            }

            // --- Code blocks ---
            Event::Start(Tag::CodeBlock(_)) => {
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
                current = Some(BlockBuilder {
                    block_type: BlockType::Code,
                    text_parts: Vec::new(),
                    checkbox: None,
                    list_depth: 0,
                    span_start: range.start,
                    span_end: range.end,
                });
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(ref mut builder) = current {
                    builder.span_end = range.end;
                }
                if let Some(builder) = current.take() {
                    emit_block(&mut blocks, builder);
                }
            }

            // --- Blockquotes ---
            Event::Start(Tag::BlockQuote(_)) => {
                in_blockquote = true;
                blockquote_span_start = range.start;
                blockquote_span_end = range.end;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                in_blockquote = false;
                blockquote_span_end = range.end;
            }

            // --- Text content ---
            Event::Text(text) => {
                if let Some(ref mut builder) = current {
                    builder.text_parts.push(text.to_string());
                }
            }
            Event::Code(code) => {
                if let Some(ref mut builder) = current {
                    // Preserve inline code as backtick-wrapped text
                    builder.text_parts.push(format!("`{code}`"));
                }
            }
            Event::SoftBreak => {
                if let Some(ref mut builder) = current {
                    builder.text_parts.push(" ".to_string());
                }
            }
            Event::HardBreak => {
                if let Some(ref mut builder) = current {
                    builder.text_parts.push("\n".to_string());
                }
            }

            _ => {}
        }
    }

    // Emit any trailing block
    if let Some(builder) = current.take() {
        emit_block(&mut blocks, builder);
    }

    // Compute parent_index and order_index using a depth stack.
    assign_parents_and_order(&mut blocks);

    blocks
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
        parent_index: None,   // assigned later
        order_index: 0,       // assigned later
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
