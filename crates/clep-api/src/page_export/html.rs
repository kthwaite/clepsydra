//! Markdown-to-HTML rendering. All asset access belongs to the snapshot's loader.

use base64::{Engine, engine::general_purpose::STANDARD};
use pulldown_cmark::{BlockQuoteKind, CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};

use super::{comments_only, raster_png, safe_external_url, skip_until_end};

const STYLE: &str = include_str!("html.css");

const FONTS: [(&str, &str, &str, &[u8]); 5] = [
    (
        "Geist",
        "normal",
        "100 900",
        include_bytes!("../../assets/fonts/geist-latin-wght-normal.woff2"),
    ),
    (
        "Geist",
        "italic",
        "100 900",
        include_bytes!("../../assets/fonts/geist-latin-wght-italic.woff2"),
    ),
    (
        "Instrument Serif",
        "normal",
        "400",
        include_bytes!("../../assets/fonts/instrument-serif-latin-400-normal.woff2"),
    ),
    (
        "Instrument Serif",
        "italic",
        "400",
        include_bytes!("../../assets/fonts/instrument-serif-latin-400-italic.woff2"),
    ),
    (
        "JetBrains Mono",
        "normal",
        "100 800",
        include_bytes!("../../assets/fonts/jetbrains-mono-latin-wght-normal.woff2"),
    ),
];

pub(super) fn render(
    title: &str,
    markdown: &str,
    mut load_image: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    // Wiki parsing is enabled only at this presentation boundary: destinations are
    // never exported. Code spans/blocks remain literal parser events.
    let options = clep_vault::markdown::markdown_options() | Options::ENABLE_WIKILINKS;
    let events = presentable(Parser::new_ext(markdown, options), &mut load_image)?;
    let mut body = String::with_capacity(markdown.len() * 2);
    pulldown_cmark::html::push_html(&mut body, events.into_iter());
    let title = escape(title);
    let mut fonts = String::new();
    for (family, style, weight, bytes) in FONTS {
        fonts.push_str(&format!(
            "@font-face {{\n  font-family: \"{family}\";\n  font-style: {style};\n  font-weight: {weight};\n  font-display: swap;\n  src: url(data:font/woff2;base64,{}) format(\"woff2\");\n}}\n",
            STANDARD.encode(bytes)
        ));
    }
    Ok(format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"color-scheme\" content=\"light\">\n<title>{title}</title>\n<style>\n{fonts}{STYLE}</style>\n</head>\n<body>\n<main>\n<h1 class=\"title\">{title}</h1>\n{body}</main>\n</body>\n</html>\n"
    ))
}

/// Rewrite the parser's events into ones `push_html` may print verbatim:
/// destinations become labels or data URIs, and only line breaks survive as HTML.
fn presentable<'a>(
    mut source: impl Iterator<Item = Event<'a>>,
    load_image: &mut impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<Vec<Event<'a>>, String> {
    let mut events = Vec::new();
    // Whether each open link was kept as an anchor, so its end matches.
    let mut links = Vec::new();
    while let Some(event) = source.next() {
        match event {
            Event::Start(Tag::Heading {
                level, id, classes, ..
            }) => {
                // Custom attributes would let a page attach event handlers.
                events.push(Event::Start(Tag::Heading {
                    level,
                    id,
                    classes,
                    attrs: Vec::new(),
                }));
            }
            Event::Start(Tag::MetadataBlock(kind)) => {
                skip_until_end(&mut source, TagEnd::MetadataBlock(kind));
            }
            Event::Start(Tag::Link {
                link_type: LinkType::WikiLink { has_pothole: false },
                dest_url,
                ..
            }) => {
                // An unaliased wiki path has no separate label. Export only its leaf.
                skip_until_end(&mut source, TagEnd::Link);
                let leaf = dest_url.rsplit('/').next().unwrap_or(&dest_url);
                let leaf = leaf.strip_suffix(".md").unwrap_or(leaf);
                events.push(Event::Text(CowStr::from(leaf.to_owned())));
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                let target = if link_type == LinkType::Email {
                    format!("mailto:{dest_url}")
                } else {
                    dest_url.to_string()
                };
                let keep =
                    !matches!(link_type, LinkType::WikiLink { .. }) && safe_external_url(&target);
                if keep {
                    events.push(Event::Start(Tag::Link {
                        link_type,
                        dest_url,
                        title,
                        id,
                    }));
                }
                links.push(keep);
            }
            Event::End(TagEnd::Link) => {
                if links.pop().ok_or("Unexpected Markdown link boundary")? {
                    events.push(Event::End(TagEnd::Link));
                }
            }
            Event::Start(Tag::Image {
                link_type,
                dest_url,
                title,
                id,
            }) => {
                // The source has already been validated/resolved by the snapshot.
                let data = image_data_uri(load_image(&dest_url)?)?;
                events.push(Event::Start(Tag::Image {
                    link_type,
                    dest_url: CowStr::from(data),
                    title,
                    id,
                }));
            }
            Event::Start(Tag::HtmlBlock) => {
                let mut html = String::new();
                for event in source.by_ref() {
                    match event {
                        Event::End(TagEnd::HtmlBlock) => break,
                        Event::Html(text) => html.push_str(&text),
                        _ => return Err("Unsupported HTML block in HTML export".into()),
                    }
                }
                if is_line_break(&html) {
                    events.push(Event::Html(CowStr::from("<br>\n")));
                } else if !comments_only(&html) {
                    return Err("HTML export does not support raw HTML".into());
                }
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                if is_line_break(&html) {
                    events.push(Event::InlineHtml(CowStr::from("<br>")));
                } else if !comments_only(&html) {
                    return Err("HTML export does not support raw HTML".into());
                }
            }
            Event::InlineMath(tex) => events.push(Event::InlineHtml(CowStr::from(format!(
                "<code class=\"math\">{}</code>",
                escape(&tex)
            )))),
            // Display math sits inside a paragraph, so it must stay a phrasing element.
            // Display math sits inside a paragraph, so it must stay a phrasing element.
            Event::DisplayMath(tex) => events.push(Event::InlineHtml(CowStr::from(format!(
                "<code class=\"math math-display\">{}</code>",
                escape(&tex)
            )))),
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                let name = callout_name(kind);
                events.push(Event::Html(CowStr::from(format!(
                    "<blockquote class=\"callout callout-{}\">\n<p class=\"callout-label\">{name}</p>\n",
                    name.to_ascii_lowercase()
                ))));
            }
            Event::End(TagEnd::BlockQuote(Some(_))) => {
                events.push(Event::Html(CowStr::from("</blockquote>\n")));
            }
            event => events.push(event),
        }
    }
    Ok(events)
}

fn callout_name(kind: BlockQuoteKind) -> &'static str {
    match kind {
        BlockQuoteKind::Note => "Note",
        BlockQuoteKind::Tip => "Tip",
        BlockQuoteKind::Important => "Important",
        BlockQuoteKind::Warning => "Warning",
        BlockQuoteKind::Caution => "Caution",
    }
}

fn is_line_break(html: &str) -> bool {
    matches!(html.trim(), "<br>" | "<br/>" | "<br />")
}

/// Inline an image as freshly encoded PNG pixels: undecodable or non-raster
/// payloads are rejected, and source metadata (EXIF, GPS) never reaches the file.
fn image_data_uri(bytes: Vec<u8>) -> Result<String, String> {
    let (png, _, _) = raster_png(bytes)?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// The rendered body, without the embedded stylesheet.
    fn html(markdown: &str) -> String {
        let document = render("A saved title", markdown, |_| {
            Err("No image expected".into())
        })
        .unwrap();
        document.split_once("</style>").unwrap().1.to_owned()
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        png.into_inner()
    }

    #[test]
    fn preserves_visible_content_without_private_targets_or_metadata() {
        let output = html(
            "---\nsecret: private-frontmatter\n---\n# Heading\n\n[[private/folder/secret.md|Public label]] and [[notes/Plain leaf.md]] and [safe](https://example.org/guide) and [local](clepsydra://private-target) and [rel](other/page.md).\n\n<!-- generated-private-marker -->\n\n**bold** *italic* ~~removed~~",
        );
        for visible in [
            "Heading</h1>",
            "Public label",
            "Plain leaf",
            "<a href=\"https://example.org/guide\">safe</a>",
            "local",
            "rel",
            "<strong>bold</strong>",
            "<em>italic</em>",
            "<del>removed</del>",
        ] {
            assert!(output.contains(visible), "missing {visible}");
        }
        for hidden in [
            "private/folder",
            "secret.md",
            "notes/",
            "Plain leaf.md",
            "private-target",
            "other/page",
            "private-frontmatter",
            "generated-private-marker",
        ] {
            assert!(!output.contains(hidden), "leaked {hidden}");
        }
    }

    #[test]
    fn code_spans_and_blocks_stay_literal_and_escaped() {
        let output = html(
            "`[[literal|code]] <b>`\n\n```mermaid\ngraph TD; A-->B\n[[literal-block|code]] <script>\n\tsecond line\n```",
        );
        assert!(output.contains("<code>[[literal|code]] &lt;b&gt;</code>"));
        assert!(output.contains("class=\"language-mermaid\""));
        assert!(output.contains("A--&gt;B"));
        assert!(output.contains("[[literal-block|code]] &lt;script&gt;"));
        assert!(output.contains("\tsecond line"));
        assert!(!output.contains("<script"));
    }

    #[test]
    fn keeps_nested_lists_ordered_starts_and_task_checkboxes() {
        let output = html(
            "3. Third\n   - Nested bullet\n\n     7. Nested seventh\n4. Fourth\n\n- [ ] Open task\n- [x] Done task",
        );
        assert!(output.contains("<ol start=\"3\">"));
        assert!(output.contains("<ol start=\"7\">"));
        assert!(output.find("<ul>").unwrap() < output.find("Nested bullet").unwrap());
        assert_eq!(output.matches("type=\"checkbox\"").count(), 2);
        assert_eq!(output.matches("disabled").count(), 2);
        assert_eq!(output.matches("checked").count(), 1);
    }

    #[test]
    fn renders_tables_with_alignment_and_footnotes() {
        let output = html(
            "| Name | Count |\n| :--- | ---: |\n| **Alpha** | 3 |\n\nA claim[^source].\n\n[^source]: Supporting *evidence* from [the source](https://example.org/evidence).\n",
        );
        assert!(output.contains("<table>"));
        assert!(output.contains("<th style=\"text-align: right\">Count</th>"));
        assert!(output.contains("<td style=\"text-align: left\"><strong>Alpha</strong></td>"));
        assert!(output.contains("class=\"footnote-reference\""));
        assert!(output.contains("class=\"footnote-definition\""));
        assert!(output.contains("<em>evidence</em>"));
        assert!(output.contains("href=\"https://example.org/evidence\""));
    }

    #[test]
    fn inlines_images_as_data_uris() {
        let bytes = png(4, 2);
        let output = render(
            "Illustrated",
            "![Chart & key](attachments/chart.png)",
            |path| {
                assert_eq!(path, "attachments/chart.png");
                Ok(bytes.clone())
            },
        )
        .unwrap();
        let decoded = image::load_from_memory(&embedded_png(&output)).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (4, 2));
        assert!(output.contains("alt=\"Chart &amp; key\""));
        assert!(!output.contains("attachments/chart.png"));
    }

    /// The bytes of the single image data URI, which must be PNG.
    fn embedded_png(output: &str) -> Vec<u8> {
        let (_, rest) = output.split_once("src=\"data:image/png;base64,").unwrap();
        let (encoded, _) = rest.split_once('"').unwrap();
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap()
    }

    #[test]
    fn reencodes_images_without_their_metadata() {
        let mut jpeg = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(3, 3)
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        let jpeg = jpeg.into_inner();
        // Insert an APP1 Exif segment carrying a recognisable marker after SOI.
        let payload = b"Exif\0\0GPS-SECRET-MARKER";
        let mut tagged = jpeg[..2].to_vec();
        tagged.extend_from_slice(&[0xFF, 0xE1]);
        tagged.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        tagged.extend_from_slice(payload);
        tagged.extend_from_slice(&jpeg[2..]);
        let output = render("Photo", "![Photo](photo.jpg)", |_| Ok(tagged.clone())).unwrap();
        assert!(!output.contains("data:image/jpeg"));
        let embedded = embedded_png(&output);
        assert!(
            !embedded
                .windows(b"GPS-SECRET-MARKER".len())
                .any(|window| window == b"GPS-SECRET-MARKER")
        );
        let decoded = image::load_from_memory(&embedded).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 3));
    }

    #[test]
    fn rejects_missing_corrupt_and_unsupported_images() {
        assert!(
            render("Title", "![missing](missing.png)", |_| Err(
                "Missing attachment".into()
            ))
            .unwrap_err()
            .contains("Missing attachment")
        );
        for bytes in [
            b"not an image".as_slice(),
            b"\x89PNG\r\n\x1a\n".as_slice(),
            b"<svg></svg>".as_slice(),
        ] {
            assert!(render("Title", "![bad](bad.png)", |_| Ok(bytes.to_vec())).is_err());
        }
    }

    #[test]
    fn rejects_raw_html_but_keeps_line_breaks() {
        for markdown in [
            "<script>alert(1)</script>",
            "Inline <span onclick=\"x\">raw</span> html",
            "<div>\nblock\n</div>",
        ] {
            assert!(
                render("Title", markdown, |_| Err("No image".into()))
                    .unwrap_err()
                    .contains("HTML export does not support raw HTML"),
                "{markdown}"
            );
        }
        let output =
            html("First<br/>second<br />third<br>fourth\n\n<!--\nmulti-line private comment\n-->");
        assert_eq!(output.matches("<br>").count(), 3);
        assert!(!output.contains("private comment"));
    }

    #[test]
    fn keeps_heading_anchors_but_drops_custom_attributes() {
        let output = html("## Section {#anchor .note onclick=alert(1) style=x}");
        assert!(output.contains("<h2 id=\"anchor\" class=\"note\">Section</h2>"));
        assert!(!output.contains("onclick") && !output.contains("style="));
    }

    #[test]
    fn renders_math_as_literal_tex() {
        let output = html("Inline $a < b$ math.\n\n$$\n\\frac{1}{2} & x\n$$\n");
        assert!(output.contains("<code class=\"math\">a &lt; b</code>"));
        assert!(output.contains("<code class=\"math math-display\">"));
        assert!(!output.contains("<pre"));
        assert!(output.contains("\\frac{1}{2} &amp; x"));
    }

    #[test]
    fn renders_callouts_with_their_kind() {
        let output = html("> [!WARNING]\n> Mind the *gap*.\n\n> Plain quote.");
        assert!(output.contains("<blockquote class=\"callout callout-warning\">"));
        assert!(output.contains("<em>gap</em>"));
        assert!(output.contains("<blockquote>\n<p>Plain quote.</p>"));
        assert!(!output.contains("markdown-alert"));
    }

    #[test]
    fn escapes_the_title_and_embeds_a_self_contained_document() {
        let output = render("Tom & <Jerry>", "Body", |_| Err("No image".into())).unwrap();
        assert!(output.starts_with("<!doctype html>"));
        assert!(output.contains("<title>Tom &amp; &lt;Jerry&gt;</title>"));
        assert!(output.contains("<h1 class=\"title\">Tom &amp; &lt;Jerry&gt;</h1>"));
        assert!(output.contains("<meta charset=\"utf-8\">"));
        assert_eq!(output.matches("@font-face").count(), 5);
        assert!(output.contains("src: url(data:font/woff2;base64,"));
        assert!(output.contains("@media print"));
        assert!(!output.contains("<link"));
        assert!(!output.contains("<script"));
        assert!(!output.contains("http://") && !output.contains("https://"));
    }
}
