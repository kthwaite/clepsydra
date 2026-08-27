//! Deconstruction of a SingleFile snapshot into content-addressed resources.
//!
//! SingleFile inlines every resource as a `data:` URI. That makes the snapshot
//! self-contained, and also makes it enormous, undeduplicated, and impossible to
//! load incrementally: a reader must download every byte of every image before
//! seeing anything. We pull those resources back out into the CAS and leave
//! `cas:<hash>` references behind.
//!
//! Everything here operates on attacker-authored markup. Resource extraction
//! uses bounded local scans; the view security boundary uses lol_html's
//! browser-compatible streaming tokenizer and rewriter.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use lol_html::html_content::Element;
use lol_html::{HtmlRewriter, MemorySettings, Settings, element};
use pulldown_cmark::{Event, Parser, Tag};
use regex::Regex;
use std::collections::BTreeMap;
use std::ops::Range;
use url::Url;

use crate::vault::cas::ContentStore;
use crate::vault::markdown::markdown_options;

const OCTET_STREAM: &str = "application/octet-stream";

/// One resource lifted out of a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotResource {
    /// `sha256:<hex>`, as produced by `ContentStore::hash_bytes`.
    pub hash: String,
    /// The media type as declared in the `data:` URI, parameters included, so it
    /// can be served back verbatim.
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A snapshot with its resources extracted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deconstructed {
    /// The snapshot with every liftable `data:` URI replaced by `cas:<hash>`.
    pub html: String,
    /// Unique resources, in order of first appearance.
    pub resources: Vec<SnapshotResource>,
}

/// A base64 `data:` URI.
///
/// The token is self-delimiting, which is why a regex is the right tool here and
/// a DOM parser is not: these appear in attribute values, in `style` attributes,
/// and inside `<style>` and `@font-face` CSS. A DOM rewriter handles only the
/// first. The media-type group excludes `,` `"` `'` whitespace and `)`, so it
/// cannot run past the URI's own delimiter, and is lazy so it stops at the first
/// `;base64,`.
fn data_uri_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"data:([^,"'\s)]*?);base64,([A-Za-z0-9+/=]*)"#).unwrap())
}

/// Lift every inlined resource out of `html`, replacing it with `cas:<hash>`.
///
/// A `data:` URI that does not decode, or decodes to nothing, is left exactly as
/// it was: inventing a blob for it would be worse than leaving a dead reference
/// that at least records what the page claimed.
pub fn deconstruct(html: &str) -> Deconstructed {
    let mut resources: Vec<SnapshotResource> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut out = String::with_capacity(html.len());
    let mut last_end = 0;

    for caps in data_uri_regex().captures_iter(html) {
        let whole = caps.get(0).expect("group 0 always matches");
        let media_type = caps.get(1).expect("group 1 is not optional").as_str();
        let payload = caps.get(2).expect("group 2 is not optional").as_str();

        let Ok(bytes) = BASE64.decode(payload) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }

        let hash = ContentStore::hash_bytes(&bytes);
        if seen.insert(hash.clone()) {
            resources.push(SnapshotResource {
                hash: hash.clone(),
                content_type: content_type_of(media_type),
                bytes,
            });
        }

        out.push_str(&html[last_end..whole.start()]);
        out.push_str("cas:");
        out.push_str(&hash);
        last_end = whole.end();
    }
    out.push_str(&html[last_end..]);

    Deconstructed {
        html: out,
        resources,
    }
}

fn content_type_of(media_type: &str) -> String {
    let trimmed = media_type.trim();
    if trimmed.is_empty() {
        OCTET_STREAM.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Find the end of an HTML tag with browser-like attribute-state recovery.
///
/// Quotes begin values only from the before-attribute-value state. In tag
/// names, attribute names, and unquoted values they are parse-error characters,
/// so malformed quotes cannot swallow a following tag.
fn html_tag_end(html: &str, start: usize) -> Option<usize> {
    #[derive(Clone, Copy)]
    enum State {
        AttributeName,
        AfterAttributeName,
        BeforeAttributeValue,
        SingleQuotedValue,
        DoubleQuotedValue,
        UnquotedValue,
    }

    let mut state = State::AttributeName;
    for (offset, byte) in html.as_bytes()[start..].iter().copied().enumerate() {
        state = match (state, byte) {
            (State::SingleQuotedValue, b'\'') | (State::DoubleQuotedValue, b'"') => {
                State::AfterAttributeName
            }
            (State::SingleQuotedValue | State::DoubleQuotedValue, _) => state,
            (_, b'>') => return Some(start + offset),
            (State::BeforeAttributeValue, byte) if byte.is_ascii_whitespace() => state,
            (State::BeforeAttributeValue, b'\'') => State::SingleQuotedValue,
            (State::BeforeAttributeValue, b'"') => State::DoubleQuotedValue,
            (State::BeforeAttributeValue, _) => State::UnquotedValue,
            (State::AttributeName, b'=') | (State::AfterAttributeName, b'=') => {
                State::BeforeAttributeValue
            }
            (State::AttributeName, byte) if byte.is_ascii_whitespace() => State::AfterAttributeName,
            (State::AfterAttributeName, byte) if byte.is_ascii_whitespace() => state,
            (State::AfterAttributeName, _) => State::AttributeName,
            (State::UnquotedValue, byte) if byte.is_ascii_whitespace() => State::AttributeName,
            _ => state,
        };
    }
    None
}

/// Return whether a tag is closing, its ASCII-insensitive element name, and
/// the byte where attribute recovery begins.
fn html_tag_name(tag: &str) -> Option<(bool, &str, usize)> {
    let bytes = tag.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    let closing = bytes.get(cursor) == Some(&b'/');
    cursor += usize::from(closing);
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if matches!(bytes.get(cursor), None | Some(b'!' | b'?')) {
        return None;
    }
    let start = cursor;
    while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b'/' {
        cursor += 1;
    }
    (cursor > start).then_some((closing, &tag[start..cursor], cursor))
}

#[derive(Clone, Copy)]
enum InertHtmlContent {
    UntilEndTag,
    ThroughEof,
}

/// Classify elements whose text must not be scanned as nested markup.
fn inert_html_content(name: &str) -> Option<InertHtmlContent> {
    if [
        "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript",
    ]
    .iter()
    .any(|candidate| name.eq_ignore_ascii_case(candidate))
    {
        Some(InertHtmlContent::UntilEndTag)
    } else if name.eq_ignore_ascii_case("plaintext") {
        Some(InertHtmlContent::ThroughEof)
    } else {
        None
    }
}

/// Skip an HTML raw-text element through its matching closing tag.
fn raw_text_end(html: &str, start: usize, name: &str) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut cursor = start;

    while let Some(open_offset) = html[cursor..].find('<') {
        let open = cursor + open_offset;
        let mut name_start = open + 1;
        if bytes.get(name_start) != Some(&b'/') {
            cursor = name_start;
            continue;
        }
        name_start += 1;
        let name_end = name_start.checked_add(name.len())?;
        let valid_boundary = bytes
            .get(name_end)
            .is_none_or(|byte| matches!(byte, b'/' | b'>') || byte.is_ascii_whitespace());
        if name_end <= bytes.len()
            && valid_boundary
            && html[name_start..name_end].eq_ignore_ascii_case(name)
        {
            return html_tag_end(html, name_end).map(|close| close + 1);
        }
        cursor = open + 1;
    }
    None
}

/// Read the two exact, quoted attributes used to join snapshot HTML to Markdown.
///
/// Values borrow the tag: scanning does not allocate or copy each element.
fn resource_attributes(tag: &str) -> (Option<&str>, Option<&str>) {
    let bytes = tag.as_bytes();
    let mut cursor = 0;
    let mut original = None;
    let mut hash = None;

    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'/') {
        cursor += 1;
    }
    while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b'/' {
        cursor += 1;
    }

    while cursor < bytes.len() {
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'/')
        {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && bytes[cursor] != b'='
            && bytes[cursor] != b'/'
        {
            cursor += 1;
        }
        if cursor == name_start {
            cursor += 1;
            continue;
        }
        let name = &tag[name_start..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let value = if let Some(&quote @ (b'\'' | b'"')) = bytes.get(cursor) {
            cursor += 1;
            let value_start = cursor;
            while cursor < bytes.len() && bytes[cursor] != quote {
                cursor += 1;
            }
            if cursor == bytes.len() {
                break;
            }
            let value = &tag[value_start..cursor];
            cursor += 1;
            value
        } else {
            let value_start = cursor;
            while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor == value_start {
                continue;
            }
            &tag[value_start..cursor]
        };

        if original.is_none() && name.eq_ignore_ascii_case("data-sf-original-src") {
            original = Some(value);
        } else if hash.is_none() && name.eq_ignore_ascii_case("src") {
            hash = value.strip_prefix("cas:");
        }
    }

    (original, hash)
}

const HTML_NAMESPACE: &str = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";
const MATHML_NAMESPACE: &str = "http://www.w3.org/1998/Math/MathML";
/// Deconstructed snapshots contain markup only; resource bytes have already
/// moved to CAS. At 2 MiB, the densest selected start tag can contain at most
/// about 1,048,573 minimal attributes. The conservative worst case is each
/// attribute retaining lol_html's three `usize` ranges (48 bytes) and also
/// materializing as an `Attribute` (88 bytes): about 136 MiB. Adding the
/// 16 MiB parser arena, 2 MiB input, and at most 64 MiB rewritten output keeps
/// the single permitted rewrite below the existing ~256 MiB admission
/// envelope. Passes run sequentially and drop their parser state before the
/// next pass.
pub const ARCHIVE_VIEW_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_REWRITER_MEMORY_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_REWRITTEN_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_NOSCRIPT_DEPTH: usize = 16;
const REWRITER_CHUNK_BYTES: usize = 16 * 1024;

/// Navigation-neutralized HTML plus diagnostics derived by the same bounded
/// parser pass.
#[derive(Debug, PartialEq, Eq)]
pub struct NeutralizedSnapshot {
    pub html: Vec<u8>,
    pub uncaptured_resource_count: usize,
}

fn restore_noscript(element: &mut Element<'_, '_>) -> Result<(), String> {
    if element.namespace_uri() == HTML_NAMESPACE && element.tag_name() == "clepsydra-noscript" {
        element
            .set_tag_name("noscript")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn remove_refresh_meta(element: &mut Element<'_, '_>) {
    if element.namespace_uri() == HTML_NAMESPACE
        && element.tag_name() == "meta"
        && element.get_attribute("http-equiv").is_some_and(|value| {
            decode_html_entities(&value)
                .trim()
                .eq_ignore_ascii_case("refresh")
        })
    {
        element.remove();
    }
}

fn remove_svg_smil(element: &mut Element<'_, '_>) {
    if element.namespace_uri() == SVG_NAMESPACE
        && matches!(
            element.tag_name().as_str(),
            "animate" | "animatecolor" | "animatemotion" | "animatetransform" | "set"
        )
    {
        element.remove();
    }
}

fn remove_link_hrefs(element: &mut Element<'_, '_>) {
    let namespace = element.namespace_uri();
    let tag = element.tag_name();
    if (matches!(namespace, HTML_NAMESPACE | SVG_NAMESPACE | MATHML_NAMESPACE)
        && matches!(tag.as_str(), "a" | "area"))
        || tag.ends_with(":a")
    {
        element.remove_attribute("href");
        element.remove_attribute("xlink:href");
        let prefixed_hrefs = element
            .attributes()
            .iter()
            .map(|attribute| attribute.name())
            .filter(|attribute| attribute.ends_with(":href"))
            .collect::<Vec<_>>();
        for attribute in prefixed_hrefs {
            element.remove_attribute(&attribute);
        }
    }
}

fn rewriting_error(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    if message.to_ascii_lowercase().contains("memory") {
        format!("archived snapshot rewrite memory limit exceeded: {message}")
    } else {
        format!("archived snapshot rewrite failed: {message}")
    }
}

pub fn neutralize_navigation_bytes(html: Vec<u8>) -> Result<Vec<u8>, String> {
    neutralize_navigation_bytes_with_diagnostics(html).map(|snapshot| snapshot.html)
}

/// Neutralize navigation and count visual-resource references that still point
/// outside the captured `data:`, `cas:`, and served CAS namespaces.
pub fn neutralize_navigation_bytes_with_diagnostics(
    html: Vec<u8>,
) -> Result<NeutralizedSnapshot, String> {
    neutralize_navigation_bytes_with_limits(
        html,
        DEFAULT_REWRITER_MEMORY_BYTES,
        DEFAULT_REWRITTEN_SNAPSHOT_BYTES,
    )
}

fn has_ascii_case_insensitive_prefix(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
}

fn is_uncaptured_resource_reference(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && !has_ascii_case_insensitive_prefix(value, "data:")
        && !has_ascii_case_insensitive_prefix(value, "cas:")
        && !value.starts_with("/api/vault/cas/")
}

fn is_html_space(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn uncaptured_srcset_resource_count(srcset: &str) -> usize {
    let bytes = srcset.as_bytes();
    let mut position = 0usize;
    let mut uncaptured = 0usize;
    while position < bytes.len() {
        while position < bytes.len() && (is_html_space(bytes[position]) || bytes[position] == b',')
        {
            position += 1;
        }
        if position == bytes.len() {
            break;
        }

        let url_start = position;
        while position < bytes.len() && !is_html_space(bytes[position]) {
            position += 1;
        }
        let mut url_end = position;
        while url_end > url_start && bytes[url_end - 1] == b',' {
            url_end -= 1;
        }
        if url_end > url_start && is_uncaptured_resource_reference(&srcset[url_start..url_end]) {
            uncaptured += 1;
        }
        if url_end != position {
            continue;
        }

        let mut parentheses = 0usize;
        while position < bytes.len() {
            match bytes[position] {
                b'(' => parentheses += 1,
                b')' => parentheses = parentheses.saturating_sub(1),
                b',' if parentheses == 0 => {
                    position += 1;
                    break;
                }
                _ => {}
            }
            position += 1;
        }
    }
    uncaptured
}

fn uncaptured_visual_resource_count(element: &Element<'_, '_>) -> usize {
    let uncaptured = |attribute: &str| {
        usize::from(
            element
                .get_attribute(attribute)
                .is_some_and(|value| is_uncaptured_resource_reference(&value)),
        )
    };
    let uncaptured_srcset = || {
        element
            .get_attribute("srcset")
            .map_or(0, |value| uncaptured_srcset_resource_count(&value))
    };
    let namespace = element.namespace_uri();
    let tag = element.tag_name();
    if namespace == HTML_NAMESPACE {
        match tag.as_str() {
            "link"
                if element.get_attribute("rel").is_some_and(|rel| {
                    rel.split_ascii_whitespace()
                        .any(|token| token.eq_ignore_ascii_case("stylesheet"))
                }) =>
            {
                uncaptured("href")
            }
            "img" => uncaptured("src") + uncaptured_srcset(),
            "input"
                if element
                    .get_attribute("type")
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("image")) =>
            {
                uncaptured("src")
            }
            "video" => uncaptured("src") + uncaptured("poster"),
            "audio" | "track" => uncaptured("src"),
            "source" => uncaptured("src") + uncaptured_srcset(),
            _ => 0,
        }
    } else if namespace == SVG_NAMESPACE && tag == "image" {
        uncaptured("href") + uncaptured("xlink:href")
    } else {
        0
    }
}
fn rewrite_pass(
    html: Vec<u8>,
    max_memory_bytes: usize,
    max_output_bytes: usize,
    expose_noscript: bool,
) -> Result<(Vec<u8>, usize, usize, usize), String> {
    use std::cell::{Cell, RefCell};

    let renamed = Cell::new(0usize);
    let handler_calls = Cell::new(0usize);
    let uncaptured_resources = Cell::new(0usize);
    let output = RefCell::new(Vec::new());
    let output_bytes = Cell::new(0usize);
    let sink_error = RefCell::new(None::<String>);
    {
        let mut settings = Settings::new()
            .with_memory_settings(
                MemorySettings::new()
                    .with_preallocated_parsing_buffer_size(0)
                    .with_max_allowed_memory_usage(max_memory_bytes),
            )
            .with_strict(false)
            .with_adjust_charset_on_meta_tag(false);
        // Keep attribute-mutating handlers narrowly selected. Calling
        // `remove_attribute` from a universal handler materializes every
        // attribute on benign elements and defeats the fixed input bound.
        if expose_noscript {
            settings = settings.append_element_content_handler(element!("noscript", |element| {
                handler_calls.set(handler_calls.get() + 1);
                if element.namespace_uri() == HTML_NAMESPACE {
                    element.set_tag_name("clepsydra-noscript")?;
                    renamed.set(renamed.get() + 1);
                }
                Ok(())
            }));
        } else {
            settings = settings
                .append_element_content_handler(element!("clepsydra-noscript", |element| {
                    handler_calls.set(handler_calls.get() + 1);
                    restore_noscript(element).map_err(std::io::Error::other)?;
                    Ok(())
                }))
                .append_element_content_handler(element!("meta[http-equiv]", |element| {
                    handler_calls.set(handler_calls.get() + 1);
                    remove_refresh_meta(element);
                    Ok(())
                }))
                .append_element_content_handler(element!(
                    "animate, animatecolor, animatemotion, animatetransform, set",
                    |element| {
                        handler_calls.set(handler_calls.get() + 1);
                        remove_svg_smil(element);
                        Ok(())
                    }
                ))
                .append_element_content_handler(element!(
                    r#"a, area, [href], [xlink\:href]"#,
                    |element| {
                        handler_calls.set(handler_calls.get() + 1);
                        remove_link_hrefs(element);
                        Ok(())
                    }
                ))
                .append_element_content_handler(element!("base", |element| {
                    handler_calls.set(handler_calls.get() + 1);
                    if element.namespace_uri() == HTML_NAMESPACE {
                        element.remove_attribute("href");
                        element.remove_attribute("target");
                    }
                    Ok(())
                }))
                .append_element_content_handler(element!("form[action]", |element| {
                    handler_calls.set(handler_calls.get() + 1);
                    if element.namespace_uri() == HTML_NAMESPACE {
                        element.remove_attribute("action");
                    }
                    Ok(())
                }))
                .append_element_content_handler(element!("[formaction]", |element| {
                    handler_calls.set(handler_calls.get() + 1);
                    if element.namespace_uri() == HTML_NAMESPACE {
                        element.remove_attribute("formaction");
                    }
                    Ok(())
                }))
                .append_element_content_handler(element!(
                    r#"link[href], img[src], img[srcset], input[src], video[src], video[poster], audio[src], source[src], source[srcset], track[src], image[href], image[xlink\:href]"#,
                    |element| {
                        uncaptured_resources.set(
                            uncaptured_resources.get()
                                + uncaptured_visual_resource_count(element),
                        );
                        Ok(())
                    }
                ));
        }
        let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| {
            if sink_error.borrow().is_some() {
                return;
            }
            let Some(next) = output_bytes.get().checked_add(chunk.len()) else {
                *sink_error.borrow_mut() =
                    Some("archived snapshot rewrite output size overflow".to_string());
                return;
            };
            if next > max_output_bytes {
                *sink_error.borrow_mut() = Some(format!(
                    "archived snapshot rewrite output limit exceeded: maximum {max_output_bytes} bytes"
                ));
                return;
            }
            let mut output = output.borrow_mut();
            if output.try_reserve_exact(chunk.len()).is_err() {
                *sink_error.borrow_mut() =
                    Some("archived snapshot rewrite output allocation failed".to_string());
                return;
            }
            output.extend_from_slice(chunk);
            output_bytes.set(next);
        });
        for chunk in html.chunks(REWRITER_CHUNK_BYTES) {
            rewriter.write(chunk).map_err(rewriting_error)?;
        }
        rewriter.end().map_err(rewriting_error)?;
    }
    if let Some(error) = sink_error.into_inner() {
        return Err(error);
    }
    Ok((
        output.into_inner(),
        renamed.get(),
        handler_calls.get(),
        uncaptured_resources.get(),
    ))
}

fn neutralize_navigation_bytes_with_limits(
    mut html: Vec<u8>,
    max_memory_bytes: usize,
    max_output_bytes: usize,
) -> Result<NeutralizedSnapshot, String> {
    for depth in 0..=MAX_NOSCRIPT_DEPTH {
        let (exposed, renamed, _, _) =
            rewrite_pass(html, max_memory_bytes, max_output_bytes, true)?;
        html = exposed;
        if renamed == 0 {
            let (neutralized, _, _, uncaptured_resource_count) =
                rewrite_pass(html, max_memory_bytes, max_output_bytes, false)?;
            return Ok(NeutralizedSnapshot {
                html: neutralized,
                uncaptured_resource_count,
            });
        }
        if depth == MAX_NOSCRIPT_DEPTH {
            return Err(format!(
                "archived snapshot noscript depth limit exceeded: maximum {MAX_NOSCRIPT_DEPTH}"
            ));
        }
    }
    unreachable!("bounded noscript exposure loop always returns")
}

pub fn neutralize_navigation(html: &str) -> Result<String, String> {
    neutralize_navigation_bytes(html.as_bytes().to_vec())
        .and_then(|output| String::from_utf8(output).map_err(|error| error.to_string()))
}
/// Absolute original URL → the hash of the blob that replaced it.
///
/// Call this on the **deconstructed** snapshot: it pairs each original source
/// URL with the `cas:` reference left in the same element.
pub fn original_url_map(html: &str, base_url: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut cursor = 0;

    while let Some(open_offset) = html[cursor..].find('<') {
        let open = cursor + open_offset;
        if html[open..].starts_with("<!--") {
            let Some(comment_end) = html[open + 4..].find("-->") else {
                break;
            };
            cursor = open + 4 + comment_end + 3;
            continue;
        }

        let Some(close) = html_tag_end(html, open + 1) else {
            break;
        };
        cursor = close + 1;
        if matches!(html.as_bytes().get(open + 1), Some(b'!' | b'?')) {
            continue;
        }

        let tag = &html[open + 1..close];
        if let Some((false, name, _)) = html_tag_name(tag)
            && let Some(inert) = inert_html_content(name)
        {
            cursor = match inert {
                InertHtmlContent::UntilEndTag => {
                    raw_text_end(html, cursor, name).unwrap_or(html.len())
                }
                InertHtmlContent::ThroughEof => html.len(),
            };
        }

        let (Some(original), Some(hash)) = resource_attributes(tag) else {
            continue;
        };
        let raw = original.trim();
        if raw.is_empty() {
            continue;
        }
        // `data-sf-original-src` was written into the DOM and then serialized
        // via `outerHTML`, which HTML-escapes the attribute value — a query
        // string like `?w=800&q=75` comes back as `&amp;q=75`. The markdown is
        // produced by turndown reading the *decoded* DOM attribute, so it still
        // says `&q=75`. Without decoding here, the two never compare equal and
        // the image silently keeps pointing at the live web.
        let decoded = decode_html_entities(raw);
        if decoded.is_empty() {
            continue;
        }
        let key = absolutise(&decoded, base_url).unwrap_or_else(|| decoded.into_owned());
        map.insert(key, hash.to_string());
    }
    map
}

/// Decode the HTML entities that can appear in a captured attribute value.
///
/// Deliberately not exhaustive, and the omission matters: per the WHATWG
/// fragment-serialization algorithm, an *attribute value* escapes only three
/// things — `&` as `&amp;`, U+00A0 as `&nbsp;`, and `"` as `&quot;`. `<`, `>`
/// and `'` are not escaped in attribute position, so `&lt;`/`&gt;`/`&apos;`
/// are accepted here purely as harmless breadth. **`&nbsp;` is not handled**:
/// a URL containing U+00A0 is malformed to begin with, and decoding it would
/// still not make the two sides of the join agree, since turndown's copy would
/// carry the raw character. If a real capture ever produces one, the symptom is
/// the same silent join miss this function exists to prevent — add it then.
///
/// A single left-to-right scan, not a chain of sequential `replace` calls —
/// decoding `&amp;` first in a chain would corrupt the literal text
/// `&amp;lt;` into `<`, when it should decode to the literal text `&lt;`
/// (an ampersand followed by the four characters `lt;`). Scanning finds `&`,
/// consumes the longest match starting there, and moves on, which mirrors how
/// an HTML parser reads entities and gets both cases right.
fn decode_html_entities(input: &str) -> std::borrow::Cow<'_, str> {
    if !input.contains('&') {
        return std::borrow::Cow::Borrowed(input);
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp_pos) = rest.find('&') {
        out.push_str(&rest[..amp_pos]);
        let tail = &rest[amp_pos..];
        match match_entity(tail) {
            Some((decoded, consumed)) => {
                out.push(decoded);
                rest = &tail[consumed..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// If `s` (which starts with `&`) opens a known entity, return the decoded
/// character and how many bytes of `s` it consumed.
fn match_entity(s: &str) -> Option<(char, usize)> {
    const NAMED: &[(&str, char)] = &[
        ("&amp;", '&'),
        ("&lt;", '<'),
        ("&gt;", '>'),
        ("&quot;", '"'),
        ("&apos;", '\''),
    ];
    for (pattern, ch) in NAMED {
        if s.starts_with(pattern) {
            return Some((*ch, pattern.len()));
        }
    }

    let digits_start = s.strip_prefix("&#")?;
    let (is_hex, digits_part) = match digits_start
        .strip_prefix('x')
        .or_else(|| digits_start.strip_prefix('X'))
    {
        Some(hex) => (true, hex),
        None => (false, digits_start),
    };
    let digits_len = digits_part
        .bytes()
        .take_while(|byte| {
            if is_hex {
                byte.is_ascii_hexdigit()
            } else {
                byte.is_ascii_digit()
            }
        })
        .count();
    if digits_len == 0 {
        return None;
    }
    let digits = &digits_part[..digits_len];
    let value = if is_hex {
        u32::from_str_radix(digits, 16).ok()?
    } else {
        digits.parse::<u32>().ok()?
    };
    let ch = char::from_u32(value)?;
    let prefix_len = 2 + usize::from(is_hex);
    let semicolon_len = usize::from(digits_part.as_bytes().get(digits_len) == Some(&b';'));
    Some((ch, prefix_len + digits_len + semicolon_len))
}

/// Point every archived image in `markdown` at its blob.
///
/// An image whose URL is not in the map is left exactly as it was. Dropping it
/// would be a silent lie about what the archive holds; leaving it is at least an
/// honest reference to the live web.
pub fn rewrite_markdown_images(
    markdown: &str,
    map: &BTreeMap<String, String>,
    base_url: &str,
) -> String {
    let mut candidates = Vec::new();
    for (event, source) in Parser::new_ext(markdown, markdown_options()).into_offset_iter() {
        let Event::Start(Tag::Image { dest_url, .. }) = event else {
            continue;
        };
        let Some(hash) = lookup(map, dest_url.as_ref(), base_url) else {
            continue;
        };
        candidates.push(ImageCandidate {
            source,
            label_end: None,
            hash,
        });
    }

    if candidates.is_empty() {
        return markdown.to_string();
    }
    candidates.sort_unstable_by_key(|candidate| (candidate.source.start, candidate.source.end));
    find_image_label_ends(markdown, &mut candidates);

    let mut replacements: Vec<(Range<usize>, &str)> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let source = markdown.get(candidate.source.clone())?;
            let label_end = candidate.label_end?.checked_sub(candidate.source.start)?;
            let destination = image_destination_after_label(source, label_end + 1)?;
            Some((
                candidate.source.start + destination.start
                    ..candidate.source.start + destination.end,
                candidate.hash,
            ))
        })
        .collect();
    replacements.sort_unstable_by_key(|(destination, _)| (destination.start, destination.end));
    let mut previous_end = 0;
    replacements.retain(|(destination, _)| {
        let disjoint = destination.start >= previous_end;
        if disjoint {
            previous_end = destination.end;
        }
        disjoint
    });

    if replacements.is_empty() {
        return markdown.to_string();
    }
    let mut output = String::with_capacity(markdown.len());
    let mut copied_through = 0;
    for (destination, hash) in replacements {
        output.push_str(&markdown[copied_through..destination.start]);
        output.push_str("cas:");
        output.push_str(hash);
        copied_through = destination.end;
    }
    output.push_str(&markdown[copied_through..]);
    output
}
struct ImageCandidate<'a> {
    source: Range<usize>,
    label_end: Option<usize>,
    hash: &'a str,
}

#[cfg(test)]
thread_local! {
    static DESTINATION_SCAN_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn record_destination_scan(bytes: usize) {
    DESTINATION_SCAN_BYTES.with(|count| count.set(count.get().saturating_add(bytes)));
}

#[cfg(test)]
fn reset_destination_scan_bytes() {
    DESTINATION_SCAN_BYTES.with(|count| count.set(0));
}

#[cfg(test)]
fn destination_scan_bytes() -> usize {
    DESTINATION_SCAN_BYTES.with(std::cell::Cell::get)
}

/// Match each image's closing label bracket in one pass over the Markdown.
///
/// Parser source ranges for nested images all end at the outermost image. If
/// each candidate searched that complete range independently, adversarially
/// nested labels would be quadratic. A stack makes every byte participate in
/// at most one label scan.
fn find_image_label_ends(markdown: &str, candidates: &mut [ImageCandidate<'_>]) {
    let bytes = markdown.as_bytes();
    let mut next_candidate = 0;
    let mut candidate_stack: Vec<(usize, usize)> = Vec::new();
    let mut bracket_depth = 0usize;
    let mut escaped = false;

    for (cursor, byte) in bytes.iter().copied().enumerate() {
        #[cfg(test)]
        record_destination_scan(1);

        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }

        if byte == b'[' {
            bracket_depth = bracket_depth.saturating_add(1);
            while candidates
                .get(next_candidate)
                .is_some_and(|candidate| candidate.source.start + 1 == cursor)
            {
                candidate_stack.push((bracket_depth, next_candidate));
                next_candidate += 1;
            }
            continue;
        }
        if byte != b']' {
            continue;
        }

        if candidate_stack
            .last()
            .is_some_and(|(depth, _)| *depth == bracket_depth)
        {
            let (_, candidate_index) = candidate_stack
                .pop()
                .expect("last candidate was checked above");
            let candidate = &mut candidates[candidate_index];
            if cursor < candidate.source.end {
                candidate.label_end = Some(cursor);
            }
        }
        bracket_depth = bracket_depth.saturating_sub(1);
    }
}

/// Locate an inline image destination after a label whose closing bracket is known.
fn image_destination_after_label(source: &str, mut cursor: usize) -> Option<Range<usize>> {
    let bytes = source.as_bytes();
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    cursor += 1;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        #[cfg(test)]
        record_destination_scan(1);
        cursor += 1;
    }

    if bytes.get(cursor) == Some(&b'<') {
        let destination_start = cursor + 1;
        cursor += 1;
        while cursor < bytes.len() {
            #[cfg(test)]
            record_destination_scan(1);
            match bytes[cursor] {
                b'\\' => cursor = (cursor + 2).min(bytes.len()),
                b'>' => {
                    let destination = destination_start..cursor;
                    return valid_image_suffix(bytes, cursor + 1).then_some(destination);
                }
                _ => cursor += 1,
            }
        }
        return None;
    }

    let destination_start = cursor;
    let mut parentheses = 0usize;
    while cursor < bytes.len() {
        #[cfg(test)]
        record_destination_scan(1);
        match bytes[cursor] {
            b'\\' => cursor = (cursor + 2).min(bytes.len()),
            b'(' => {
                parentheses += 1;
                cursor += 1;
            }
            b')' if parentheses == 0 => {
                return (cursor + 1 == bytes.len()).then_some(destination_start..cursor);
            }
            b')' => {
                parentheses -= 1;
                cursor += 1;
            }
            byte if byte.is_ascii_whitespace() && parentheses == 0 => {
                let destination = destination_start..cursor;
                return valid_image_suffix(bytes, cursor).then_some(destination);
            }
            _ => cursor += 1,
        }
    }
    None
}

/// Validate whitespace, an optional title, and the inline image's closing `)`.
fn valid_image_suffix(bytes: &[u8], mut cursor: usize) -> bool {
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        #[cfg(test)]
        record_destination_scan(1);
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b')') {
        return cursor + 1 == bytes.len();
    }

    let Some(&delimiter @ (b'\'' | b'"' | b'(')) = bytes.get(cursor) else {
        return false;
    };
    cursor += 1;
    let mut nested = usize::from(delimiter == b'(');
    while cursor < bytes.len() {
        #[cfg(test)]
        record_destination_scan(1);
        match bytes[cursor] {
            b'\\' => cursor = (cursor + 2).min(bytes.len()),
            b'(' if delimiter == b'(' => {
                nested += 1;
                cursor += 1;
            }
            b')' if delimiter == b'(' => {
                nested -= 1;
                cursor += 1;
                if nested == 0 {
                    break;
                }
            }
            current if delimiter != b'(' && current == delimiter => {
                cursor += 1;
                break;
            }
            _ => cursor += 1,
        }
    }
    if delimiter == b'(' && nested != 0 {
        return false;
    }
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        #[cfg(test)]
        record_destination_scan(1);
        cursor += 1;
    }
    bytes.get(cursor) == Some(&b')') && cursor + 1 == bytes.len()
}

fn lookup<'a>(map: &'a BTreeMap<String, String>, url: &str, base_url: &str) -> Option<&'a str> {
    if let Some(hash) = map.get(url) {
        return Some(hash);
    }
    let absolute = absolutise(url, base_url)?;
    map.get(&absolute).map(String::as_str)
}

fn absolutise(raw: &str, base_url: &str) -> Option<String> {
    let base = Url::parse(base_url).ok()?;
    base.join(raw).ok().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgo=";

    #[test]
    fn lifts_an_inlined_image_into_a_resource() {
        let html = format!(r#"<img src="data:image/png;base64,{PNG}">"#);

        let result = deconstruct(&html);

        assert_eq!(result.resources.len(), 1);
        assert_eq!(result.resources[0].content_type, "image/png");
        let hash = &result.resources[0].hash;
        assert_eq!(result.html, format!(r#"<img src="cas:{hash}">"#));
    }

    #[test]
    fn stores_one_resource_for_repeated_bytes() {
        let html = format!(
            r#"<img src="data:image/png;base64,{PNG}"><img src="data:image/png;base64,{PNG}">"#
        );

        let result = deconstruct(&html);

        assert_eq!(result.resources.len(), 1);
        let hash = &result.resources[0].hash;
        assert_eq!(result.html.matches(&format!("cas:{hash}")).count(), 2);
    }

    #[test]
    fn rewrites_data_uris_inside_css() {
        let html = format!(r#"<style>body{{background:url(data:image/png;base64,{PNG})}}</style>"#);

        let result = deconstruct(&html);

        assert_eq!(result.resources.len(), 1);
        let hash = &result.resources[0].hash;
        assert!(
            result.html.contains(&format!("url(cas:{hash})")),
            "got: {}",
            result.html
        );
    }

    #[test]
    fn keeps_media_type_parameters() {
        let html = r#"<link href="data:text/css;charset=utf-8;base64,Ym9keXt9">"#;

        let result = deconstruct(html);

        assert_eq!(result.resources[0].content_type, "text/css;charset=utf-8");
    }

    #[test]
    fn defaults_a_missing_media_type() {
        let html = r#"<img src="data:;base64,Ym9keXt9">"#;

        let result = deconstruct(html);

        assert_eq!(result.resources[0].content_type, "application/octet-stream");
    }

    #[test]
    fn leaves_singlefiles_empty_resource_alone() {
        // SingleFile writes `data:,` for a resource it could not fetch. There is
        // nothing to store, and rewriting it would invent a blob that never
        // existed.
        let html = r#"<img src="data:,">"#;

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }

    #[test]
    fn leaves_an_empty_payload_verbatim() {
        let html = r#"<img src="data:image/png;base64,!!!!"><p>after</p>"#;

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }

    #[test]
    fn leaves_undecodable_base64_verbatim() {
        let html = r#"<img src="data:image/png;base64,A!!!"><p>after</p>"#;

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }

    #[test]
    fn decoded_bytes_match_the_declared_payload() {
        let html = format!(r#"<img src="data:image/png;base64,{PNG}">"#);

        let result = deconstruct(&html);

        assert_eq!(
            result.resources[0].bytes,
            vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[test]
    fn a_snapshot_with_no_resources_is_returned_unchanged() {
        let html = "<html><body><p>plain</p></body></html>";

        let result = deconstruct(html);

        assert!(result.resources.is_empty());
        assert_eq!(result.html, html);
    }

    const BASE: &str = "https://example.com/posts/one";

    #[test]
    fn maps_an_original_url_to_the_hash_that_replaced_it() {
        let html =
            r#"<img data-sf-original-src="https://cdn.example.com/a.png" src="cas:sha256:aa">"#;

        let map = original_url_map(html, BASE);

        assert_eq!(
            map.get("https://cdn.example.com/a.png"),
            Some(&"sha256:aa".to_string())
        );
    }

    #[test]
    fn absolutises_a_relative_original_url() {
        // SingleFile records the raw attribute value, so it is relative whenever
        // the page's markup was. The markdown carries absolute URLs, because
        // Readability resolves them. The map is what has to bridge that.
        let html = r#"<img data-sf-original-src="/img/a.png" src="cas:sha256:bb">"#;

        let map = original_url_map(html, BASE);

        assert_eq!(
            map.get("https://example.com/img/a.png"),
            Some(&"sha256:bb".to_string())
        );
    }

    #[test]
    fn ignores_an_element_whose_src_was_not_deconstructed() {
        let html = r#"<img data-sf-original-src="https://cdn.example.com/a.png" src="data:,">"#;

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn does_not_confuse_srcset_with_src() {
        let html = concat!(
            r#"<img data-sf-original-srcset="https://cdn.example.com/wide.png 2x" "#,
            r#"data-sf-original-src="https://cdn.example.com/a.png" src="cas:sha256:cc" "#,
            r#"srcset="cas:sha256:dd 2x">"#
        );

        let map = original_url_map(html, BASE);

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("https://cdn.example.com/a.png"),
            Some(&"sha256:cc".to_string())
        );
    }

    #[test]
    fn scans_double_quoted_original_url_with_apostrophe_and_greater_than() {
        let html = r#"<img data-sf-original-src="https://cdn.example/a'b>c.png?x=1&amp;y=2" src="cas:sha256:aa">"#;

        let map = original_url_map(html, BASE);

        assert_eq!(
            map.get("https://cdn.example/a'b%3Ec.png?x=1&y=2"),
            Some(&"sha256:aa".to_string())
        );
    }

    #[test]
    fn scans_exact_case_insensitive_single_quoted_attributes() {
        let html = concat!(
            "<img DATA-SF-ORIGINAL-SRCSET='https://cdn.example/wide.png 2x'\n",
            " DATA-SF-ORIGINAL-SRC='https://cdn.example/a\"b.png'\n",
            " SRCSET='cas:sha256:distractor 2x'\n",
            " SRC='cas:sha256:bb'>"
        );

        let map = original_url_map(html, BASE);

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("https://cdn.example/a%22b.png"),
            Some(&"sha256:bb".to_string())
        );
    }

    #[test]
    fn ignores_resource_like_markup_inside_comments() {
        let html = concat!(
            "<!-- <img data-sf-original-src=",
            r#""https://cdn.example/comment>a.png" src="cas:sha256:comment"> -->"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn ignores_resource_like_markup_inside_script_and_style_text() {
        let html = concat!(
            r#"<script>const image = '<img data-sf-original-src="https://cdn.example/script>a.png" src="cas:sha256:script">';</script>"#,
            r#"<style>/* <img data-sf-original-src="https://cdn.example/style>b.png" src="cas:sha256:style"> */</style>"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn matches_only_a_bounded_case_insensitive_textarea_end_tag() {
        let html = concat!(
            r#"<TEXTAREA><img data-sf-original-src="https://cdn.example/inert>a.png" src="cas:sha256:inert">"#,
            r#"</textarea-extra><img data-sf-original-src="https://cdn.example/still-inert>b.png" src="cas:sha256:still-inert">"#,
            r#"</TeXtArEa><img data-sf-original-src="https://cdn.example/genuine.png" src="cas:sha256:genuine">"#
        );

        let map = original_url_map(html, BASE);

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("https://cdn.example/genuine.png"),
            Some(&"sha256:genuine".to_string())
        );
    }

    #[test]
    fn ignores_resource_like_markup_inside_title_text() {
        let html = r#"<title><img data-sf-original-src="https://cdn.example/title>b.png" src="cas:sha256:title"></TITLE>"#;

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn ignores_resource_like_markup_inside_xmp_and_iframe_text() {
        let html = concat!(
            r#"<xmp><img data-sf-original-src="https://cdn.example/xmp>a.png" src="cas:sha256:xmp"></xmp>"#,
            r#"<IFRAME><img data-sf-original-src="https://cdn.example/iframe>b.png" src="cas:sha256:iframe"></iframe>"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn ignores_resource_like_markup_inside_noembed_and_noframes_text() {
        let html = concat!(
            r#"<noembed><img data-sf-original-src="https://cdn.example/noembed>a.png" src="cas:sha256:noembed"></noembed>"#,
            r#"<NOFRAMES><img data-sf-original-src="https://cdn.example/noframes>b.png" src="cas:sha256:noframes"></noframes>"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn skips_noscript_text_then_maps_a_post_close_resource() {
        let html = concat!(
            r#"<NoScRiPt><img data-sf-original-src="https://cdn.example/noscript>a.png" src="cas:sha256:noscript"></NOSCRIPT>"#,
            r#"<img data-sf-original-src="https://cdn.example/after.png" src="cas:sha256:after">"#
        );

        let map = original_url_map(html, BASE);

        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("https://cdn.example/after.png"),
            Some(&"sha256:after".to_string())
        );
    }

    #[test]
    fn plaintext_consumes_resource_like_markup_through_eof() {
        let html = concat!(
            "<plaintext>",
            r#"<img data-sf-original-src="https://cdn.example/plaintext>a.png" src="cas:sha256:plaintext">"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn ignores_resource_like_attributes_in_declarations_and_processing_instructions() {
        let html = concat!(
            r#"<!DOCTYPE img data-sf-original-src="https://cdn.example/doctype>a.png" src="cas:sha256:doctype">"#,
            r#"<?capture data-sf-original-src="https://cdn.example/pi>b.png" src="cas:sha256:pi"?>"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    #[test]
    fn pairs_within_one_tag_only() {
        let html = concat!(
            r#"<img data-sf-original-src="https://cdn.example.com/a.png">"#,
            r#"<img src="cas:sha256:ee">"#
        );

        let map = original_url_map(html, BASE);

        assert!(map.is_empty());
    }

    fn one_entry(url: &str, hash: &str) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();
        map.insert(url.to_string(), hash.to_string());
        map
    }

    #[test]
    fn rewrites_a_markdown_image_to_its_blob() {
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images(
            "text\n\n![a cat](https://cdn.example.com/a.png)\n",
            &map,
            BASE,
        );

        assert_eq!(out, "text\n\n![a cat](cas:sha256:aa)\n");
    }

    #[test]
    fn preserves_an_image_title() {
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images(
            r#"![a cat](https://cdn.example.com/a.png "Fig 1")"#,
            &map,
            BASE,
        );

        assert_eq!(out, r#"![a cat](cas:sha256:aa "Fig 1")"#);
    }

    #[test]
    fn rewrites_a_balanced_parenthesized_destination_only() {
        let markdown = concat!(
            "before [ordinary](https://cdn.example/plot_(final).png \"Link\")\n",
            "![plot](https://cdn.example/plot_(final).png \"Final\") after"
        );
        let map = one_entry("https://cdn.example/plot_(final).png", "sha256:plot");

        let out = rewrite_markdown_images(markdown, &map, BASE);

        assert_eq!(
            out,
            concat!(
                "before [ordinary](https://cdn.example/plot_(final).png \"Link\")\n",
                "![plot](cas:sha256:plot \"Final\") after"
            )
        );
    }

    #[test]
    fn rewrites_an_angle_bracket_destination_with_spaces_only() {
        let markdown = r#"before ![spaced](<https://cdn.example/a b.png> "Caption") after"#;
        let map = one_entry("https://cdn.example/a b.png", "sha256:spaced");

        let out = rewrite_markdown_images(markdown, &map, BASE);

        assert_eq!(
            out,
            r#"before ![spaced](<cas:sha256:spaced> "Caption") after"#
        );
    }

    #[test]
    fn rewrites_disjoint_destinations_in_nested_images() {
        let markdown = concat!(
            "before ![outer ![inner](https://cdn.example/inner.png \"Inner\") tail]",
            "(https://cdn.example/outer.png \"Outer\") after"
        );
        let mut map = one_entry("https://cdn.example/inner.png", "sha256:inner");
        map.insert(
            "https://cdn.example/outer.png".to_string(),
            "sha256:outer".to_string(),
        );

        let out = rewrite_markdown_images(markdown, &map, BASE);

        assert_eq!(
            out,
            concat!(
                "before ![outer ![inner](cas:sha256:inner \"Inner\") tail]",
                "(cas:sha256:outer \"Outer\") after"
            )
        );
    }

    #[test]
    fn nested_image_destination_scanning_is_linearly_bounded() {
        const DEPTH: usize = 128;
        const URL: &str = "https://cdn.example/deep.png";
        let mut markdown = String::new();
        for _ in 0..DEPTH {
            markdown.push_str("![");
        }
        markdown.push_str("leaf");
        for _ in 0..DEPTH {
            markdown.push_str("](");
            markdown.push_str(URL);
            markdown.push(')');
        }
        let map = one_entry(URL, "sha256:deep");

        reset_destination_scan_bytes();
        let out = rewrite_markdown_images(&markdown, &map, BASE);
        let scanned = destination_scan_bytes();

        assert_eq!(out, markdown.replace(URL, "cas:sha256:deep"));
        assert!(
            scanned <= markdown.len().saturating_mul(2),
            "destination discovery scanned {scanned} bytes for {} bytes of Markdown",
            markdown.len()
        );
    }

    #[test]
    fn leaves_an_unmatched_image_intact() {
        // Silently dropping it would produce markdown that claims an image was
        // archived when it was not.
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images("![b](https://cdn.example.com/b.png)", &map, BASE);

        assert_eq!(out, "![b](https://cdn.example.com/b.png)");
    }

    #[test]
    fn standards_parser_recovers_latest_malformed_attribute_bypass() {
        let html = concat!(
            r#"<div x=""='>"#,
            r#"<meta http-equiv=refresh content="0;url=https://meta.example">"#,
            r#"<img src=cas:sha256:image alt=kept>"#
        );

        let neutralized = neutralize_navigation(html).unwrap();
        assert!(!neutralized.contains("meta.example"), "{neutralized}");
        assert!(
            neutralized.contains("cas:sha256:image"),
            "resource URL was lost: {neutralized}"
        );
        assert!(
            neutralized.contains("alt=kept"),
            "resource presentation was lost: {neutralized}"
        );
    }

    #[test]
    fn leaves_ordinary_links_alone() {
        // A link should still point at the live web; only images become blobs.
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images("[see it](https://cdn.example.com/a.png)", &map, BASE);

        assert_eq!(out, "[see it](https://cdn.example.com/a.png)");
    }

    #[test]
    fn matches_a_relative_markdown_url_against_an_absolute_map_key() {
        let map = one_entry("https://example.com/img/a.png", "sha256:aa");

        let out = rewrite_markdown_images("![a](/img/a.png)", &map, BASE);

        assert_eq!(out, "![a](cas:sha256:aa)");
    }

    #[test]
    fn deconstruct_and_map_compose_end_to_end() {
        let html = format!(
            r#"<img data-sf-original-src="https://cdn.example.com/a.png" src="data:image/png;base64,{PNG}">"#
        );

        let deconstructed = deconstruct(&html);
        let map = original_url_map(&deconstructed.html, BASE);
        let out = rewrite_markdown_images("![a](https://cdn.example.com/a.png)", &map, BASE);

        let hash = &deconstructed.resources[0].hash;
        assert_eq!(out, format!("![a](cas:{hash})"));
    }

    #[test]
    fn joins_runtime_balanced_url_when_cas_src_is_unquoted() {
        let html = concat!(
            r#"<img loading=lazy alt="large relay bitmap" "#,
            r#"src=cas:sha256:relay "#,
            r#"data-sf-original-src="http://localhost:34989/large_(relay).bmp?sig=(abc)&amp;variant=full">"#
        );
        let markdown = "![large relay bitmap](http://localhost:34989/large_(relay).bmp?sig=(abc)&variant=full)";

        // The exact parser event/range and balanced scanner succeed when the
        // map is supplied directly; the runtime miss originated in HTML join
        // extraction, where SingleFile serialized this `src` without quotes.
        let direct_map = one_entry(
            "http://localhost:34989/large_(relay).bmp?sig=(abc)&variant=full",
            "sha256:relay",
        );
        assert_eq!(
            rewrite_markdown_images(markdown, &direct_map, "http://localhost:34989/article"),
            "![large relay bitmap](cas:sha256:relay)"
        );

        let map = original_url_map(html, "http://localhost:34989/article");
        let out = rewrite_markdown_images(markdown, &map, "http://localhost:34989/article");

        assert_eq!(out, "![large relay bitmap](cas:sha256:relay)");
    }

    #[test]
    fn neutralization_preserves_raw_content_comments_and_resources() {
        let html = concat!(
            r#"<style>.example::after { content: "<a href=https://live.example>"; }</style>"#,
            r#"<textarea><form action=https://live.example></textarea>"#,
            r#"<!-- <meta http-equiv=refresh content="0; url=https://live.example"> -->"#,
            r#"<a href=https://remove.example>Visible</a>"#,
            r#"<link rel=stylesheet href=cas:sha256:style>"#,
            r#"<img src=cas:sha256:image alt=kept>"#
        );

        let neutralized = neutralize_navigation(html).unwrap();
        assert!(
            neutralized
                .contains(r#".example::after { content: "<a href=https://live.example>"; }"#)
        );
        assert!(neutralized.contains("<textarea>"));
        assert!(neutralized.contains("<form action=https://live.example>"));
        assert!(neutralized.contains("<!-- <meta http-equiv=refresh"));
        assert!(neutralized.contains("<a>Visible</a>"));
        assert!(neutralized.contains("href=cas:sha256:style"));
        assert!(neutralized.contains("src=cas:sha256:image"));
        assert!(neutralized.contains("alt=kept"));
    }

    #[test]
    fn standards_parser_recovers_all_malformed_navigation_vectors() {
        let malformed = [
            r#"<meta/http-equiv=refresh content="0;url=https://solidus-meta.example">"#,
            r#"<a/href=https://solidus-anchor.example data-label=kept>Visible solidus</a>"#,
            r#"<!--><a href=https://empty-comment.example>Visible comment</a>"#,
            r#"<!---><meta http-equiv=refresh content="0;url=https://abrupt-comment.example">"#,
            r#"<!-- --!><meta http-equiv=refresh content="0;url=https://bang-comment.example">"#,
            r#"<div a'><meta http-equiv=refresh content="0;url=https://single-quote.example">"#,
            r#"<div a"><meta http-equiv=refresh content="0;url=https://double-quote.example">"#,
            r#"<div x=""='><meta http-equiv=refresh content="0;url=https://latest.example">"#,
            r#"<meta http-equiv="&#114efresh" content="0;url=https://numeric.example">"#,
            r#"<img/src=cas:sha256:image alt=kept>"#,
        ]
        .join("");

        let neutralized = neutralize_navigation(&malformed).unwrap();
        for forbidden in [
            "solidus-meta.example",
            "solidus-anchor.example",
            "empty-comment.example",
            "abrupt-comment.example",
            "bang-comment.example",
            "single-quote.example",
            "double-quote.example",
            "latest.example",
            "numeric.example",
        ] {
            assert!(
                !neutralized.contains(forbidden),
                "{forbidden:?} survived: {neutralized}"
            );
        }
        assert!(neutralized.contains("Visible solidus"));
        assert!(neutralized.contains("Visible comment"));
        assert!(neutralized.contains("cas:sha256:image"));
        assert!(neutralized.contains("alt=kept"));
    }

    #[test]
    fn neutralization_matches_script_disabled_noscript_rendering() {
        let html = concat!(
            r#"<noscript><a href=https://noscript.example><img src=cas:sha256:noscript alt="Fallback">Fallback text</a>"#,
            r#"<meta http-equiv=refresh content="0;url=https://refresh.example"></noscript>"#
        );

        let neutralized = neutralize_navigation(html).unwrap();
        assert!(!neutralized.contains("noscript.example"), "{neutralized}");
        assert!(!neutralized.contains("refresh.example"), "{neutralized}");
        assert!(neutralized.contains("Fallback text"), "{neutralized}");
        assert!(neutralized.contains("cas:sha256:noscript"), "{neutralized}");
        assert!(neutralized.contains("alt=\"Fallback\""), "{neutralized}");
    }

    #[test]
    fn neutralization_preserves_and_secures_template_contents() {
        let html = concat!(
            r#"<template id=captured><style>.captured { color: red }</style>"#,
            r#"<a href=https://template.example>Template text</a>"#,
            r#"<meta http-equiv=refresh content="0;url=https://refresh.example">"#,
            r#"<img src=cas:sha256:template alt="Template image"></template>"#
        );

        let neutralized = neutralize_navigation(html).unwrap();
        assert!(!neutralized.contains("template.example"), "{neutralized}");
        assert!(!neutralized.contains("refresh.example"), "{neutralized}");
        assert!(neutralized.contains("<template"), "{neutralized}");
        assert!(
            neutralized.contains(".captured { color: red }"),
            "{neutralized}"
        );
        assert!(neutralized.contains("Template text"), "{neutralized}");
        assert!(neutralized.contains("cas:sha256:template"), "{neutralized}");
        assert!(
            neutralized.contains("alt=\"Template image\""),
            "{neutralized}"
        );
    }

    #[test]
    fn neutralization_removes_svg_smil_navigation_synthesis() {
        let html = concat!(
            r#"<svg><a id=target><text>Visible SVG link</text>"#,
            r#"<animate attributeName=href values="https://one.example;https://two.example">"#,
            r#"<set attributeName="xlink:href" to="https://set.example">"#,
            r#"<animateTransform attributeName=href from="https://from.example" to="https://to.example">"#,
            r#"</a><image href=cas:sha256:image></svg>"#
        );

        let neutralized = neutralize_navigation(html).unwrap();
        for forbidden in [
            "<animate",
            "<set",
            "one.example",
            "two.example",
            "set.example",
            "from.example",
            "to.example",
        ] {
            assert!(!neutralized.contains(forbidden), "{neutralized}");
        }
        assert!(neutralized.contains("Visible SVG link"), "{neutralized}");
        assert!(neutralized.contains("cas:sha256:image"), "{neutralized}");
    }

    #[test]
    fn benign_dense_attributes_do_not_enter_navigation_handlers() {
        let html = format!("<div {}>Visible</div>", "data-x=x ".repeat(4096)).into_bytes();
        let (_, renamed, handler_calls, _) =
            rewrite_pass(html, 16 * 1024 * 1024, 64 * 1024 * 1024, false).unwrap();
        assert_eq!(renamed, 0);
        assert_eq!(handler_calls, 0);
    }

    #[test]
    fn streaming_neutralizer_names_memory_and_output_limit_failures() {
        let memory_error =
            neutralize_navigation_bytes_with_limits(b"<div>visible</div>".to_vec(), 1, 1024)
                .unwrap_err();
        assert!(memory_error.contains("memory limit"), "{memory_error}");

        let output_error =
            neutralize_navigation_bytes_with_limits(b"<div>visible</div>".to_vec(), 1024 * 1024, 4)
                .unwrap_err();
        assert!(output_error.contains("output limit"), "{output_error}");
    }

    #[test]
    fn nested_noscript_layers_are_exposed_and_neutralized() {
        let html = concat!(
            "<template><noscript><noscript>",
            "<a href=https://nested.example>Nested visible</a>",
            "<meta http-equiv=refresh content='0;url=https://refresh.example'>",
            "<img src=cas:sha256:nested alt=Nested>",
            "</noscript></noscript></template>"
        );

        let neutralized = neutralize_navigation(html).unwrap();
        assert!(!neutralized.contains("nested.example"), "{neutralized}");
        assert!(!neutralized.contains("refresh.example"), "{neutralized}");
        assert!(neutralized.contains("Nested visible"), "{neutralized}");
        assert!(neutralized.contains("cas:sha256:nested"), "{neutralized}");
        assert_eq!(neutralized.matches("<noscript").count(), 2, "{neutralized}");
    }

    #[test]
    fn nested_noscript_depth_is_bounded_before_rewrite() {
        let too_deep = format!(
            "{}<a href=https://deep.example>visible</a>{}",
            "<noscript>".repeat(MAX_NOSCRIPT_DEPTH + 1),
            "</noscript>".repeat(MAX_NOSCRIPT_DEPTH + 1)
        );
        let depth_error = neutralize_navigation(&too_deep).unwrap_err();
        assert!(
            depth_error.contains("noscript depth limit"),
            "{depth_error}"
        );
    }

    // -------------------------------------------------------------------
    // C1 regression: entity-escaped original URLs must still join.
    // -------------------------------------------------------------------

    #[test]
    fn maps_an_original_url_whose_query_string_was_entity_escaped() {
        // `outerHTML` serialization escapes `&` as `&amp;` in the attribute
        // SingleFile wrote, but turndown reads the decoded DOM attribute for
        // the markdown, so the markdown still carries a literal `&`. The map
        // has to bridge that or every multi-parameter query URL misses.
        let html = concat!(
            r#"<img data-sf-original-src="https://cdn.example.com/a.png?w=800&amp;q=75" "#,
            r#"src="cas:sha256:aa">"#
        );

        let map = original_url_map(html, BASE);

        assert_eq!(
            map.get("https://cdn.example.com/a.png?w=800&q=75"),
            Some(&"sha256:aa".to_string())
        );
    }

    #[test]
    fn rewrite_end_to_end_survives_an_entity_escaped_query_string() {
        // The full join: a snapshot attribute HTML-escaped by `outerHTML`
        // (`&` -> `&amp;`), paired against markdown carrying the *decoded*
        // URL turndown reads from the live DOM. `original_url_map` has to
        // decode the snapshot's copy, or this pairing never matches and the
        // image is left pointing at the live web.
        let html = concat!(
            r#"<img data-sf-original-src="https://cdn.example.com/a.png?w=800&amp;q=75" "#,
            r#"src="cas:sha256:aa">"#
        );
        let map = original_url_map(html, BASE);

        let out =
            rewrite_markdown_images("![a](https://cdn.example.com/a.png?w=800&q=75)", &map, BASE);

        assert_eq!(out, "![a](cas:sha256:aa)");
    }

    #[test]
    fn decode_html_entities_handles_named_and_numeric_references() {
        assert_eq!(decode_html_entities("a&amp;b"), "a&b");
        assert_eq!(decode_html_entities("a&lt;b&gt;c"), "a<b>c");
        assert_eq!(decode_html_entities(r#"a&quot;b&apos;c"#), r#"a"b'c"#);
        assert_eq!(decode_html_entities("a&#39;b"), "a'b");
        assert_eq!(decode_html_entities("a&#x26;b"), "a&b");
    }

    #[test]
    fn decode_html_entities_does_not_double_decode_amp_lt() {
        // `&amp;lt;` in serialized markup is the literal text "&lt;" (an
        // ampersand followed by "lt;") — the page never contained a `<`. A
        // naive sequential replace (expand `&amp;` everywhere, then `&lt;`
        // everywhere) would corrupt this into `<`. A single left-to-right scan
        // must not.
        assert_eq!(decode_html_entities("&amp;lt;"), "&lt;");
    }
}
