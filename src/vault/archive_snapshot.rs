//! Deconstruction of a SingleFile snapshot into content-addressed resources.
//!
//! SingleFile inlines every resource as a `data:` URI. That makes the snapshot
//! self-contained, and also makes it enormous, undeduplicated, and impossible to
//! load incrementally: a reader must download every byte of every image before
//! seeing anything. We pull those resources back out into the CAS and leave
//! `cas:<hash>` references behind.
//!
//! Everything here operates on attacker-authored markup. It parses nothing and
//! executes nothing — it matches a self-delimiting token and rewrites it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use regex::Regex;
use std::collections::BTreeMap;
use url::Url;

use crate::vault::cas::ContentStore;

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

/// One HTML tag, so an original URL is only ever paired with a `cas:` reference
/// that sits on the same element.
fn tag_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap())
}

/// `data-sf-original-src="…"`, written by SingleFile's `saveOriginalURLs`.
fn original_src_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"data-sf-original-src\s*=\s*["']([^"']*)["']"#).unwrap())
}

/// `src="cas:…"`. The leading `(?:^|\s)` keeps this off `data-sf-original-src`,
/// which ends in `-src`; anchoring `src\s*=` keeps it off `srcset`.
fn cas_src_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?:^|\s)src\s*=\s*["']cas:([^"']*)["']"#).unwrap())
}

/// A markdown inline image, with an optional quoted title.
fn markdown_image_regex() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"!\[([^\]]*)\]\(\s*([^()\s]+)((?:\s+"[^"]*")?)\s*\)"#).unwrap())
}

/// Absolute original URL → the hash of the blob that replaced it.
///
/// Call this on the **deconstructed** snapshot: it pairs the
/// `data-sf-original-src` SingleFile recorded with the `cas:` reference
/// `deconstruct` left in that element's `src`. That pairing is the only link
/// between the markdown — which still carries live URLs — and the blobs.
pub fn original_url_map(html: &str, base_url: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for tag in tag_regex().find_iter(html) {
        let tag = tag.as_str();
        let (Some(original), Some(hash)) = (
            original_src_regex().captures(tag),
            cas_src_regex().captures(tag),
        ) else {
            continue;
        };
        let raw = original[1].trim();
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
        map.insert(key, hash[1].to_string());
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
    let end = digits_part.find(';')?;
    let digits = &digits_part[..end];
    if digits.is_empty() {
        return None;
    }
    let value = if is_hex {
        u32::from_str_radix(digits, 16).ok()?
    } else {
        digits.parse::<u32>().ok()?
    };
    let ch = char::from_u32(value)?;
    let prefix_len = 2 + usize::from(is_hex);
    Some((ch, prefix_len + digits.len() + 1))
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
    markdown_image_regex()
        .replace_all(markdown, |caps: &regex::Captures<'_>| {
            let alt = &caps[1];
            let url = &caps[2];
            let title = &caps[3];
            match lookup(map, url, base_url) {
                Some(hash) => format!("![{alt}](cas:{hash}{title})"),
                None => caps[0].to_string(),
            }
        })
        .into_owned()
}

fn lookup(map: &BTreeMap<String, String>, url: &str, base_url: &str) -> Option<String> {
    if let Some(hash) = map.get(url) {
        return Some(hash.clone());
    }
    let absolute = absolutise(url, base_url)?;
    map.get(&absolute).cloned()
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
    fn leaves_an_unmatched_image_intact() {
        // Silently dropping it would produce markdown that claims an image was
        // archived when it was not.
        let map = one_entry("https://cdn.example.com/a.png", "sha256:aa");

        let out = rewrite_markdown_images("![b](https://cdn.example.com/b.png)", &map, BASE);

        assert_eq!(out, "![b](https://cdn.example.com/b.png)");
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
