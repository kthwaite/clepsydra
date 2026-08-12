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
    fn leaves_malformed_base64_verbatim() {
        let html = r#"<img src="data:image/png;base64,!!!!"><p>after</p>"#;

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
}
