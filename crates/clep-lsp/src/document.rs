use tower_lsp::lsp_types::{Position, Range};

use clep_vault::link::{Link, extract_links};
use clep_vault::page::{PageMeta, parse_or_repair_frontmatter};

/// An open document tracked by the LSP server.
///
/// Holds the parsed rope, extracted metadata, body content, link spans,
/// and sync bookkeeping (version, dirty flag).
pub struct Document {
    /// Full document text as a rope for efficient positional access.
    pub rope: ropey::Rope,
    /// Parsed frontmatter metadata.
    pub meta: PageMeta,
    /// Whether encryption metadata makes the Markdown body unavailable.
    pub encrypted: bool,
    /// The markdown body (everything after the frontmatter).
    pub body: String,
    /// Byte offset where the body begins in the original document text.
    pub body_byte_offset: usize,
    /// Links extracted from the document body.
    pub links: Vec<Link>,
    /// LSP document version, as reported by the client.
    pub version: i32,
    /// Whether the document has unsaved changes relative to the index.
    pub dirty: bool,
}

impl Document {
    /// Parse a document from its full text content.
    ///
    /// Extracts frontmatter metadata, computes the body byte offset,
    /// builds a rope, and extracts links from the body.
    pub fn from_text(text: &str, version: i32) -> Self {
        let (meta, parsed_body, _rewrote, _warning) = parse_or_repair_frontmatter(text);
        let body_byte_offset = text.len() - parsed_body.len();
        let encrypted = meta.encryption.is_some();
        let body = if encrypted {
            String::new()
        } else {
            parsed_body
        };

        let rope = ropey::Rope::from_str(text);
        let links = extract_links(&body);

        Self {
            rope,
            meta,
            encrypted,
            body,
            body_byte_offset,
            links,
            version,
            dirty: false,
        }
    }

    /// Convert a byte offset within the *body* to an LSP [`Position`].
    ///
    /// The offset is first translated to an absolute byte offset in the
    /// full document, then mapped through the rope to (line, character).
    /// Since we advertise `PositionEncodingKind::UTF8`, the character
    /// offset is measured in UTF-8 bytes from the start of the line.
    pub fn byte_offset_to_position(&self, body_offset: usize) -> Position {
        let abs = self.body_byte_offset + body_offset;
        let total_bytes = self.rope.len_bytes();
        let clamped = abs.min(total_bytes);

        let line = self.rope.byte_to_line(clamped);
        let line_start_byte = self.rope.line_to_byte(line);
        let character = clamped - line_start_byte;

        Position {
            line: line as u32,
            character: character as u32,
        }
    }

    /// Convert an LSP [`Position`] to a byte offset within the *body*.
    ///
    /// Returns `None` if the position falls within the frontmatter
    /// (i.e. before `body_byte_offset`). A character past the end of its
    /// line is clamped to the end of that line.
    pub fn position_to_body_byte_offset(&self, pos: Position) -> Option<usize> {
        if self.encrypted {
            return None;
        }
        let line = pos.line as usize;
        if line >= self.rope.len_lines() {
            return None;
        }

        let line_start_byte = self.rope.line_to_byte(line);
        // A character past the end of the line means the end of the line
        // (LSP `Position`), not a place in the lines that follow.
        let character = (pos.character as usize).min(self.line_content_len(line));
        let abs = line_start_byte + character;

        if abs < self.body_byte_offset {
            return None;
        }

        Some(abs - self.body_byte_offset)
    }

    /// Byte length of `line` without its line terminator.
    fn line_content_len(&self, line: usize) -> usize {
        let slice = self.rope.line(line);
        let mut end = slice.len_chars();
        while end > 0 && matches!(slice.char(end - 1), '\n' | '\r') {
            end -= 1;
        }
        slice.char_to_byte(end)
    }

    /// Find the link whose span contains the given position.
    ///
    /// Converts the position to a body byte offset and searches
    /// for a link with a span that includes that offset.
    pub fn link_at_position(&self, pos: Position) -> Option<&Link> {
        let body_offset = self.position_to_body_byte_offset(pos)?;
        self.links
            .iter()
            .find(|link| link.span.contains(&body_offset))
    }

    /// Convert a [`Link`]'s byte span to an LSP [`Range`].
    pub fn link_to_range(&self, link: &Link) -> Range {
        let start = self.byte_offset_to_position(link.span.start);
        let end = self.byte_offset_to_position(link.span.end);
        Range { start, end }
    }

    /// Convert a pair of body byte offsets to an LSP [`Range`].
    pub fn body_span_to_range(&self, start: usize, end: usize) -> Range {
        Range {
            start: self.byte_offset_to_position(start),
            end: self.byte_offset_to_position(end),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_span_to_range_maps_offsets() {
        let doc = Document::from_text("line one\nline two\n", 1);
        let r = doc.body_span_to_range(0, 4);
        assert_eq!(
            r.start,
            Position {
                line: 0,
                character: 0
            }
        );
        assert_eq!(
            r.end,
            Position {
                line: 0,
                character: 4
            }
        );
    }

    #[test]
    fn body_span_to_range_accounts_for_frontmatter_offset() {
        // Body offsets are relative to the body; the returned Range must be in
        // absolute document coordinates (frontmatter pushes the body down).
        let doc = Document::from_text("---\ntitle: T\n---\nfoo\n", 1);
        let r = doc.body_span_to_range(0, 3);
        assert_eq!(
            r.start,
            Position {
                line: 3,
                character: 0
            }
        );
        assert_eq!(
            r.end,
            Position {
                line: 3,
                character: 3
            }
        );
    }

    #[test]
    fn character_past_the_line_end_clamps_to_the_line_end() {
        // LSP 3.17 `Position`: "If the character value is greater than the
        // line length it defaults back to the line length."
        let doc = Document::from_text("x\nalpha [[Beta]] tail\n", 1);
        let past_end = Position {
            line: 0,
            character: 9,
        };
        // Unclamped, byte 9 is inside the link on line 1.
        assert!(doc.link_at_position(past_end).is_none());
        assert_eq!(doc.position_to_body_byte_offset(past_end), Some(1));
    }

    #[test]
    fn clamped_position_stops_before_the_line_terminator() {
        for (text, line_end) in [("ab\r\ncd", 2), ("ab\rcd", 2), ("ab\ncd", 2)] {
            let doc = Document::from_text(text, 1);
            let past_end = Position {
                line: 0,
                character: 40,
            };
            assert_eq!(
                doc.position_to_body_byte_offset(past_end),
                Some(line_end),
                "text {text:?}"
            );
        }
    }

    #[test]
    fn character_past_the_end_of_the_last_line_is_the_document_end() {
        let doc = Document::from_text("ab\ncd", 1);
        let past_end = Position {
            line: 1,
            character: 40,
        };
        assert_eq!(doc.position_to_body_byte_offset(past_end), Some(5));
        // A link that ends the document is not under a cursor past its end.
        let doc = Document::from_text("[[Alpha]]", 1);
        assert!(doc.link_at_position(past_end).is_none());
        assert!(
            doc.link_at_position(Position {
                line: 0,
                character: 40
            })
            .is_none()
        );
    }

    #[test]
    fn character_within_the_line_is_unchanged() {
        let doc = Document::from_text("---\ntitle: T\n---\nab [[Alpha]]\n", 1);
        let at = |character| Position { line: 3, character };
        assert_eq!(doc.position_to_body_byte_offset(at(0)), Some(0));
        assert_eq!(doc.position_to_body_byte_offset(at(12)), Some(12));
        assert!(doc.link_at_position(at(11)).is_some());
        // Frontmatter positions stay outside the body, clamped or not.
        let in_frontmatter = Position {
            line: 1,
            character: 40,
        };
        assert_eq!(doc.position_to_body_byte_offset(in_frontmatter), None);
    }
}
