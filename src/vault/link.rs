use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, TextMergeWithOffset};
use regex::Regex;

/// A link extracted from a page body or frontmatter property.
#[derive(Debug, Clone)]
pub struct Link {
    /// The raw target string (e.g. `"Design Notes"`, `"design.md"`).
    pub target_raw: String,
    /// Byte range in the source body. Synthetic links use `0..0`.
    pub span: Range<usize>,
    /// What kind of link this is.
    pub kind: LinkKind,
}

/// Discriminant for link provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkKind {
    /// `[[target]]` or `[[target|display]]` wikilink.
    Wiki,
    /// Standard markdown `[text](dest)` link.
    Markdown,
    /// A link implied by a frontmatter property value (e.g. `tags`, `aliases`).
    PropertyRef {
        /// The frontmatter field that produced this link.
        source_field: String,
    },
    /// `((block-id))` block reference (transclusion).
    BlockRef,
}

/// Return a lazily compiled regex for wikilinks: `[[target]]` or `[[target|display]]`.
fn wikilink_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap())
}

/// Return a lazily compiled regex for block references: `((10-12 alphanumeric chars))`.
fn block_ref_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\(([A-Za-z0-9]{10,12})\)\)").unwrap())
}

/// Returns `true` if `url` points outside the vault (http, https, mailto, or
/// fragment-only anchors).
fn is_external(url: &str) -> bool {
    url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:")
        || url.starts_with('#')
}

/// Extract all internal links from a Markdown body.
///
/// Uses pulldown-cmark for structure awareness (skipping code blocks and HTML
/// blocks) and a regex pass on `Text` events for wikilinks.
pub fn extract_links(body: &str) -> Vec<Link> {
    let raw_iter = Parser::new_ext(body, Options::empty()).into_offset_iter();
    let parser = TextMergeWithOffset::new(raw_iter);

    let mut links = Vec::new();
    let mut in_code_block = false;
    let mut in_html_block = false;

    for (event, range) in parser {
        match event {
            // --- track code / HTML block depth ---
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Start(Tag::HtmlBlock) => {
                in_html_block = true;
            }
            Event::End(TagEnd::HtmlBlock) => {
                in_html_block = false;
            }

            // --- markdown links ---
            Event::Start(Tag::Link { dest_url, .. }) if !in_code_block && !in_html_block => {
                let url = dest_url.as_ref();
                if !is_external(url) {
                    links.push(Link {
                        target_raw: url.to_string(),
                        span: range,
                        kind: LinkKind::Markdown,
                    });
                }
            }

            // --- wikilinks inside text events ---
            Event::Text(_) if !in_code_block && !in_html_block => {
                // Apply the regex on the original source slice so that match
                // offsets map directly to body byte positions.
                let source_slice = &body[range.start..range.end];
                let re = wikilink_regex();
                for cap in re.captures_iter(source_slice) {
                    let m = cap.get(0).unwrap();
                    let inner = &cap[1];
                    // If `[[target|display]]`, keep only the target (before `|`).
                    let target = match inner.split_once('|') {
                        Some((t, _)) => t,
                        None => inner,
                    };
                    let start = range.start + m.start();
                    let end = range.start + m.end();
                    links.push(Link {
                        target_raw: target.to_string(),
                        span: start..end,
                        kind: LinkKind::Wiki,
                    });
                }

                let block_ref_re = block_ref_regex();
                for cap in block_ref_re.captures_iter(source_slice) {
                    let m = cap.get(0).unwrap();
                    let id = &cap[1];
                    let start = range.start + m.start();
                    let end = range.start + m.end();
                    links.push(Link {
                        target_raw: id.to_string(),
                        span: start..end,
                        kind: LinkKind::BlockRef,
                    });
                }
            }

            // Inline code content — skip entirely.
            Event::Code(_) => {}

            _ => {}
        }
    }

    links
}

/// Build synthetic [`Link`]s from frontmatter property values.
///
/// Each value becomes a `LinkKind::PropertyRef` with span `0..0` (since they
/// do not correspond to positions in the body text).
pub fn extract_property_refs(field_name: &str, values: &[String]) -> Vec<Link> {
    values
        .iter()
        .map(|val| Link {
            target_raw: val.clone(),
            span: 0..0,
            kind: LinkKind::PropertyRef {
                source_field: field_name.to_string(),
            },
        })
        .collect()
}
