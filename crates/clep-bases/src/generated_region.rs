//! Portable, byte-preserving generated Markdown regions.
use std::collections::HashSet;
use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::base_render::RenderSelection;

const OPEN: &str = "<!-- clep:generated";
const CLOSE: &str = "<!-- /clep:generated -->";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedRegionDescriptor {
    pub version: u32,
    pub id: String,
    #[serde(flatten)]
    pub selection: RenderSelection,
    pub output_hash: String,
}

#[derive(Debug)]
pub struct GeneratedRegion {
    pub descriptor: GeneratedRegionDescriptor,
    pub span: Range<usize>,
    pub payload: Range<usize>,
    pub modified: bool,
}

#[derive(Debug, Error)]
#[error("invalid generated region: {0}")]
pub struct RegionError(pub String);

fn invalid(message: impl Into<String>) -> RegionError {
    RegionError(message.into())
}

/// Only top-level HTML blocks can contain directives. Code and nested examples
/// remain literal Markdown, including comments inside blockquotes and lists.
fn html_blocks(markdown: &str) -> Vec<Range<usize>> {
    let mut depth = 0usize;
    let mut start = None;
    let mut blocks = Vec::new();
    for (event, range) in Parser::new_ext(markdown, Options::all()).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if depth == 0 && tag == Tag::HtmlBlock {
                    start = Some(range.start);
                }
                depth += 1;
            }
            Event::End(tag) => {
                depth = depth.saturating_sub(1);
                if depth == 0
                    && tag == TagEnd::HtmlBlock
                    && let Some(start) = start.take()
                {
                    blocks.push(start..range.end);
                }
            }
            _ => {}
        }
    }
    blocks
}

fn standalone_comment(block: &str) -> bool {
    block
        .find("-->")
        .is_none_or(|end| block[end + 3..].trim().is_empty())
}

pub fn parse_regions(markdown: &str) -> Result<Vec<GeneratedRegion>, RegionError> {
    let mut regions = Vec::new();
    let mut pending: Option<(GeneratedRegionDescriptor, usize, usize)> = None;
    let mut ids = HashSet::new();
    for range in html_blocks(markdown) {
        let block = &markdown[range.clone()];
        let trimmed = block.trim();
        if !standalone_comment(trimmed) {
            continue;
        }
        if trimmed.starts_with(OPEN) {
            if pending.is_some() {
                return Err(invalid("nested regions are not supported"));
            }
            let leading = block.len() - block.trim_start().len();
            let end = trimmed
                .find("-->")
                .ok_or_else(|| invalid("unterminated header"))?;
            let header_content = &trimmed[OPEN.len()..end];
            if !header_content.starts_with('\n') && !header_content.starts_with("\r\n") {
                return Err(invalid("header configuration must start on a new line"));
            }
            let config: toml::Table = toml::from_str(header_content)
                .map_err(|error| invalid(format!("invalid header: {error}")))?;
            if config.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "version"
                        | "id"
                        | "base"
                        | "view"
                        | "template"
                        | "filter"
                        | "sort"
                        | "limit"
                        | "output_hash"
                )
            }) {
                return Err(invalid("unknown descriptor field"));
            }
            let descriptor: GeneratedRegionDescriptor = toml::Value::Table(config)
                .try_into()
                .map_err(|error| invalid(format!("invalid header: {error}")))?;
            if descriptor.version != 1 {
                return Err(invalid("unsupported version"));
            }
            let id = uuid::Uuid::parse_str(&descriptor.id).map_err(|_| invalid("invalid UUID"))?;
            if !ids.insert(id) {
                return Err(invalid("duplicate region UUID"));
            }
            let hash = descriptor
                .output_hash
                .strip_prefix("blake3:")
                .ok_or_else(|| invalid("unsupported output fingerprint"))?;
            if hash.len() != 64
                || !hash
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                return Err(invalid("invalid output fingerprint"));
            }
            pending = Some((
                descriptor,
                range.start + leading,
                range.start + leading + end + 3,
            ));
        } else if trimmed.starts_with("<!-- /clep:generated") {
            if trimmed != CLOSE {
                return Err(invalid("invalid end marker"));
            }
            let (descriptor, start, payload_start) = pending
                .take()
                .ok_or_else(|| invalid("end marker without a header"))?;
            let end_start = range.start + block.len() - block.trim_start().len();
            let payload = payload_start..end_start;
            let modified = descriptor.output_hash != fingerprint(&markdown[payload.clone()]);
            regions.push(GeneratedRegion {
                descriptor,
                span: start..end_start + CLOSE.len(),
                payload,
                modified,
            });
        }
    }
    if pending.is_some() {
        return Err(invalid("missing end marker"));
    }
    Ok(regions)
}

pub fn fingerprint(payload: &str) -> String {
    format!("blake3:{}", blake3::hash(payload.as_bytes()).to_hex())
}

pub fn ensure_inert_output(markdown: &str) -> Result<(), RegionError> {
    for range in html_blocks(markdown) {
        let block = markdown[range].trim();
        if standalone_comment(block)
            && (block.starts_with(OPEN) || block.starts_with("<!-- /clep:generated"))
        {
            return Err(invalid(
                "template output cannot contain generated directives",
            ));
        }
    }
    Ok(())
}

pub fn format_region(
    id: &str,
    selection: &RenderSelection,
    markdown: &str,
) -> Result<String, RegionError> {
    ensure_inert_output(markdown)?;
    uuid::Uuid::parse_str(id).map_err(|_| invalid("invalid UUID"))?;
    let payload = format!(
        "\n\n{}\n\n",
        markdown.replace("\r\n", "\n").trim_matches('\n')
    );
    let descriptor = GeneratedRegionDescriptor {
        version: 1,
        id: id.to_owned(),
        selection: selection.clone(),
        output_hash: fingerprint(&payload),
    };
    let header = toml::to_string(&descriptor).map_err(|error| invalid(error.to_string()))?;
    // HTML comment termination must not be introduced through a TOML string.
    if header.contains("-->") {
        return Err(invalid("configuration contains an HTML comment terminator"));
    }
    Ok(format!("{OPEN}\n{header}-->{payload}{CLOSE}"))
}

pub fn replace_region(
    markdown: &str,
    region: &GeneratedRegion,
    selection: &RenderSelection,
    output: &str,
) -> Result<String, RegionError> {
    let replacement = format_region(&region.descriptor.id, selection, output)?;
    let mut result = String::with_capacity(markdown.len() - region.span.len() + replacement.len());
    result.push_str(&markdown[..region.span.start]);
    result.push_str(&replacement);
    result.push_str(&markdown[region.span.end..]);
    Ok(result)
}

/// Insert only between top-level blocks, never into a fence or nested content.
pub fn insert_region(
    markdown: &str,
    offset: usize,
    id: &str,
    selection: &RenderSelection,
    output: &str,
) -> Result<String, RegionError> {
    if !markdown.is_char_boundary(offset) {
        return Err(invalid("insertion offset is not a UTF-8 boundary"));
    }
    let regions = parse_regions(markdown)?;
    if regions
        .iter()
        .any(|region| region.span.start < offset && offset < region.span.end)
    {
        return Err(invalid("cannot insert inside a generated region"));
    }
    let mut depth = 0usize;
    for (event, range) in Parser::new_ext(markdown, Options::all()).into_offset_iter() {
        match event {
            Event::Start(_) => {
                if depth == 0 && range.start < offset && offset < range.end {
                    return Err(invalid("insertion must be between Markdown blocks"));
                }
                depth += 1;
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    let region = format_region(id, selection, output)?;
    let before = &markdown[..offset];
    let after = &markdown[offset..];
    let mut result = String::with_capacity(markdown.len() + region.len() + 4);
    result.push_str(before);
    if !before.is_empty() && !before.ends_with("\n\n") {
        result.push_str("\n\n");
    }
    result.push_str(&region);
    if !after.starts_with("\n\n") {
        result.push_str("\n\n");
    }
    result.push_str(after);
    Ok(result)
}
