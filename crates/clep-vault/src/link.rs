use std::ops::Range;

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd, TextMergeWithOffset};
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

/// Public for the workspace split; not part of the stable API.
///
/// The two values used by the indexed `links_to` predicate.
pub struct NormalizedLinksToTarget {
    pub target_id: String,
    pub target_canonical: String,
}

/// Public for the workspace split; not part of the stable API.
///
/// Normalize UUID-shaped targets to the canonical lowercase/hyphenated form
/// stored in `links.target_id`; ordinary text still uses canonical-name
/// matching.
pub fn normalize_links_to_target(value: &str) -> NormalizedLinksToTarget {
    let target_id = uuid::Uuid::parse_str(value)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| value.to_owned());
    let target_canonical = crate::canonical::CanonicalName::from_title(value)
        .as_str()
        .to_owned();
    NormalizedLinksToTarget {
        target_id,
        target_canonical,
    }
}

/// Return a lazily compiled regex for wikilinks: `[[target]]` or `[[target|display]]`.
fn wikilink_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap())
}

/// A `[[target]]` / `[[target|display]]` wikilink found in the source.
pub(crate) struct WikilinkMatch {
    /// Byte range of the whole `[[…]]`.
    pub(crate) span: Range<usize>,
    /// Byte range of the text between the brackets.
    pub(crate) inner: Range<usize>,
}

/// Finds wikilinks in the source text rather than inside single `Text`
/// events, so that inline markup in the target (`[[__init__]]`, `[[a*b*c]]`)
/// or a link reference definition for the same label (`[Alpha]: x` with
/// `[[Alpha]]`) cannot break one apart.
///
/// The scanner feeds it, while walking the parser events, the source ranges
/// that are live text. A `[[…]]` is a wikilink when both bracket pairs lie in
/// live text and no line break sits between them; what the parser made of the
/// characters in between does not matter.
#[derive(Default)]
pub(crate) struct WikilinkScan {
    live: Vec<Range<usize>>,
}

impl WikilinkScan {
    /// Record the source range of a `Text` event outside code and HTML blocks.
    pub(crate) fn text(&mut self, range: &Range<usize>) {
        self.live.push(range.clone());
    }

    /// Record the outer brackets of a shortcut reference link or a footnote
    /// reference (`[Alpha]`, `[^1]`): they are plain text unless a definition
    /// for that label happens to exist, and must not hide a wikilink.
    pub(crate) fn label_brackets(&mut self, range: &Range<usize>) {
        if range.len() >= 2 {
            self.live.push(range.start..range.start + 1);
            self.live.push(range.end - 1..range.end);
        }
    }

    /// The wikilinks of `content`, in source order.
    pub(crate) fn matches(mut self, content: &str) -> Vec<WikilinkMatch> {
        // Merge touching ranges so that a bracket pair may straddle two.
        self.live.sort_by_key(|range| range.start);
        let mut live: Vec<Range<usize>> = Vec::with_capacity(self.live.len());
        for range in self.live {
            match live.last_mut() {
                Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
                _ => live.push(range),
            }
        }
        let is_live = |range: Range<usize>| {
            let next = live.partition_point(|candidate| candidate.start <= range.start);
            next > 0 && range.end <= live[next - 1].end
        };

        wikilink_regex()
            .captures_iter(content)
            .filter_map(|cap| {
                let span = cap.get(0).unwrap().range();
                let inner = cap.get(1).unwrap().range();
                let on_one_line = !content[span.clone()].contains(['\n', '\r']);
                (on_one_line && is_live(span.start..inner.start) && is_live(inner.end..span.end))
                    .then_some(WikilinkMatch { span, inner })
            })
            .collect()
    }
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

/// Parser options for the link scanners (`extract_links` and the rewriter).
///
/// Only footnotes are switched on, in the same flavour as
/// [`crate::markdown::markdown_options`]: without them a footnote definition
/// such as `[^1]: Ibid.` reads as a link reference definition, its body is
/// never scanned, and every `[^1]` becomes a Markdown link to the footnote
/// text. Every other extension stays off so that link spans do not move.
pub(crate) fn link_scan_options() -> Options {
    Options::ENABLE_FOOTNOTES | Options::ENABLE_OLD_FOOTNOTES
}

/// Extract all internal links from a Markdown body.
///
/// Uses pulldown-cmark for structure awareness (skipping code blocks, inline
/// code and HTML). Wikilinks are found by [`WikilinkScan`]; block references
/// by a regex pass on `Text` events. A Markdown link that lies inside a
/// wikilink is not reported: the wikilink wins. Links are returned in source
/// order.
pub fn extract_links(body: &str) -> Vec<Link> {
    let raw_iter = Parser::new_ext(body, link_scan_options()).into_offset_iter();
    let parser = TextMergeWithOffset::new(raw_iter);

    let mut links = Vec::new();
    let mut wikilinks = WikilinkScan::default();
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
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) if !in_code_block && !in_html_block => {
                if link_type == LinkType::Shortcut {
                    wikilinks.label_brackets(&range);
                }
                // pulldown-cmark ends a collapsed reference link (`[label][]`)
                // after the label; the trailing `[]` is part of the link.
                let span =
                    if link_type == LinkType::Collapsed && body[range.end..].starts_with("[]") {
                        range.start..range.end + 2
                    } else {
                        range
                    };
                let url = dest_url.as_ref();
                if !is_external(url) {
                    links.push(Link {
                        target_raw: url.to_string(),
                        span,
                        kind: LinkKind::Markdown,
                    });
                }
            }

            Event::FootnoteReference(_) if !in_code_block && !in_html_block => {
                wikilinks.label_brackets(&range);
            }

            // --- wikilinks and block references in text events ---
            Event::Text(_) if !in_code_block && !in_html_block => {
                wikilinks.text(&range);

                // Apply the regex on the original source slice so that match
                // offsets map directly to body byte positions.
                let source_slice = &body[range.start..range.end];
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

    let wikilinks = wikilinks.matches(body);
    links.retain(|link| {
        link.kind != LinkKind::Markdown
            || !wikilinks.iter().any(|wikilink| {
                wikilink.span.start <= link.span.start && link.span.end <= wikilink.span.end
            })
    });
    for wikilink in wikilinks {
        let inner = &body[wikilink.inner];
        // If `[[target|display]]`, keep only the target (before `|`).
        let target = match inner.split_once('|') {
            Some((t, _)) => t,
            None => inner,
        };
        links.push(Link {
            target_raw: target.to_string(),
            span: wikilink.span,
            kind: LinkKind::Wiki,
        });
    }
    links.sort_by_key(|link| link.span.start);

    links
}

/// Build synthetic [`Link`]s from frontmatter property values.
///
/// Each value becomes a `LinkKind::PropertyRef` with span `0..0` (since they
/// do not correspond to positions in the body text). Values written in
/// wikilink syntax (`[[Target]]`, `[[Target|display]]`) are unwrapped to the
/// bare target so relation-typed properties resolve like body links.
pub fn extract_property_refs(field_name: &str, values: &[String]) -> Vec<Link> {
    values
        .iter()
        .map(|val| {
            let trimmed = val.trim();
            let target = trimmed
                .strip_prefix("[[")
                .and_then(|s| s.strip_suffix("]]"))
                .map(|inner| match inner.split_once('|') {
                    Some((t, _)) => t,
                    None => inner,
                })
                .unwrap_or(trimmed);
            Link {
                target_raw: target.to_string(),
                span: 0..0,
                kind: LinkKind::PropertyRef {
                    source_field: field_name.to_string(),
                },
            }
        })
        .collect()
}
