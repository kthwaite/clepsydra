use tower_lsp::lsp_types::{Position, PositionEncodingKind, Range};

use clep_vault::link::{Link, extract_links};
use clep_vault::page::{PageMeta, parse_or_repair_frontmatter};

/// The unit of `Position::character` agreed with the client in `initialize`.
///
/// Every column that crosses the wire goes through [`column_of_byte`] or
/// [`byte_of_column`]; the server works in UTF-8 byte offsets internally.
///
/// [`column_of_byte`]: PositionEncoding::column_of_byte
/// [`byte_of_column`]: PositionEncoding::byte_of_column
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PositionEncoding {
    /// Columns are UTF-8 bytes: the server's native unit, no conversion.
    #[default]
    Utf8,
    /// Columns are UTF-16 code units: the encoding every client supports.
    Utf16,
}

impl PositionEncoding {
    /// Choose the encoding from the client's `general.positionEncodings`.
    ///
    /// LSP 3.17: the server may only pick an encoding the client offers, and
    /// UTF-16 is the default when the client offers none. UTF-8 is chosen
    /// whenever it is offered, wherever it sits in the client's list.
    pub fn negotiate(offered: Option<&[PositionEncodingKind]>) -> Self {
        match offered {
            Some(kinds) if kinds.contains(&PositionEncodingKind::UTF8) => Self::Utf8,
            _ => Self::Utf16,
        }
    }

    /// The value to answer in `ServerCapabilities::position_encoding`.
    pub fn kind(self) -> PositionEncodingKind {
        match self {
            Self::Utf8 => PositionEncodingKind::UTF8,
            Self::Utf16 => PositionEncodingKind::UTF16,
        }
    }

    /// Convert a byte column within `line` to a wire column.
    ///
    /// For UTF-16, a byte inside a multi-byte character counts as the start
    /// of that character.
    pub fn column_of_byte(self, line: &str, byte: usize) -> u32 {
        match self {
            Self::Utf8 => byte as u32,
            Self::Utf16 => {
                let mut end = byte.min(line.len());
                while !line.is_char_boundary(end) {
                    end -= 1;
                }
                line[..end].encode_utf16().count() as u32
            }
        }
    }

    /// Convert a wire column to a byte column within `line`.
    ///
    /// For UTF-16, a column inside a surrogate pair counts as the start of
    /// that character, and a column past the end of the line is the end of
    /// the line's content (before its terminator), as LSP specifies.
    pub fn byte_of_column(self, line: &str, column: u32) -> usize {
        match self {
            Self::Utf8 => column as usize,
            Self::Utf16 => {
                let content = line.trim_end_matches(['\n', '\r']);
                let mut units = 0;
                for (byte, ch) in content.char_indices() {
                    if units + ch.len_utf16() > column as usize {
                        return byte;
                    }
                    units += ch.len_utf16();
                }
                content.len()
            }
        }
    }
}

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
    /// The unit of the columns in every [`Position`] this document produces
    /// or accepts.
    pub encoding: PositionEncoding,
}

impl Document {
    /// Parse a document from its full text content.
    ///
    /// Extracts frontmatter metadata, computes the body byte offset,
    /// builds a rope, and extracts links from the body. Positions are in
    /// UTF-8 columns; see [`Document::with_position_encoding`].
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
            encoding: PositionEncoding::Utf8,
        }
    }

    /// Set the unit of the columns in this document's positions.
    pub fn with_position_encoding(mut self, encoding: PositionEncoding) -> Self {
        self.encoding = encoding;
        self
    }

    /// Convert a byte column on `line` to a wire column.
    fn column_of_byte(&self, line: usize, byte: usize) -> u32 {
        match self.encoding {
            PositionEncoding::Utf8 => byte as u32,
            encoding => encoding.column_of_byte(&self.rope.line(line).to_string(), byte),
        }
    }

    /// Convert a wire column on `line` to a byte column.
    fn byte_of_column(&self, line: usize, column: u32) -> usize {
        match self.encoding {
            PositionEncoding::Utf8 => column as usize,
            encoding => encoding.byte_of_column(&self.rope.line(line).to_string(), column),
        }
    }

    /// Convert a byte offset within the *body* to an LSP [`Position`].
    ///
    /// The offset is first translated to an absolute byte offset in the
    /// full document, then mapped through the rope to (line, character).
    /// The character is measured from the start of the line in the
    /// document's [`PositionEncoding`].
    pub fn byte_offset_to_position(&self, body_offset: usize) -> Position {
        let abs = self.body_byte_offset + body_offset;
        let total_bytes = self.rope.len_bytes();
        let clamped = abs.min(total_bytes);

        let line = self.rope.byte_to_line(clamped);
        let line_start_byte = self.rope.line_to_byte(line);
        let character = self.column_of_byte(line, clamped - line_start_byte);

        Position {
            line: line as u32,
            character,
        }
    }

    /// Convert an LSP [`Position`] to a byte offset within the *body*.
    ///
    /// Returns `None` if the position falls within the frontmatter
    /// (i.e. before `body_byte_offset`).
    pub fn position_to_body_byte_offset(&self, pos: Position) -> Option<usize> {
        if self.encrypted {
            return None;
        }
        let line = pos.line as usize;
        if line >= self.rope.len_lines() {
            return None;
        }

        let line_start_byte = self.rope.line_to_byte(line);
        let abs = line_start_byte + self.byte_of_column(line, pos.character);

        if abs < self.body_byte_offset {
            return None;
        }

        Some(abs - self.body_byte_offset)
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
    fn only_lf_crlf_and_cr_end_a_line() {
        // LSP 3.17: lines end at `\n`, `\r\n` or `\r`. Unicode line and
        // paragraph separators, form feed, vertical tab and NEL are ordinary
        // characters to the client, so they must not start a new line here.
        for separator in ["\u{2028}", "\u{2029}", "\u{0c}", "\u{0b}", "\u{85}"] {
            let doc = Document::from_text(&format!("a{separator}[[Alpha]]\nnext\n"), 1);
            let start = 1 + separator.len() as u32;
            let range = doc.link_to_range(&doc.links[0]);
            assert_eq!(
                (range.start, range.end),
                (
                    Position {
                        line: 0,
                        character: start
                    },
                    Position {
                        line: 0,
                        character: start + 9
                    }
                ),
                "separator {separator:?}"
            );
            assert!(doc.link_at_position(range.start).is_some());
            assert_eq!(doc.rope.len_lines(), 3, "separator {separator:?}");
        }
    }

    #[test]
    fn lf_crlf_and_lone_cr_each_end_a_line() {
        for terminator in ["\n", "\r\n", "\r"] {
            let doc = Document::from_text(&format!("a{terminator}[[Alpha]]"), 1);
            let range = doc.link_to_range(&doc.links[0]);
            assert_eq!(
                (range.start, range.end),
                (
                    Position {
                        line: 1,
                        character: 0
                    },
                    Position {
                        line: 1,
                        character: 9
                    }
                ),
                "terminator {terminator:?}"
            );
        }
    }

    fn pos(line: u32, character: u32) -> Position {
        Position { line, character }
    }

    fn utf16_doc(text: &str) -> Document {
        Document::from_text(text, 1).with_position_encoding(PositionEncoding::Utf16)
    }

    #[test]
    fn negotiate_defaults_to_utf16_when_the_client_offers_nothing() {
        assert_eq!(PositionEncoding::negotiate(None), PositionEncoding::Utf16);
        assert_eq!(
            PositionEncoding::negotiate(Some(&[])),
            PositionEncoding::Utf16
        );
    }

    #[test]
    fn negotiate_picks_utf8_only_when_the_client_offers_it() {
        let utf16_first = [PositionEncodingKind::UTF16, PositionEncodingKind::UTF8];
        assert_eq!(
            PositionEncoding::negotiate(Some(&utf16_first)),
            PositionEncoding::Utf8
        );
        let no_utf8 = [PositionEncodingKind::UTF32, PositionEncodingKind::UTF16];
        assert_eq!(
            PositionEncoding::negotiate(Some(&no_utf8)),
            PositionEncoding::Utf16
        );
        // UTF-32 alone is not implemented; UTF-16 is mandatory for clients.
        assert_eq!(
            PositionEncoding::negotiate(Some(&[PositionEncodingKind::UTF32])),
            PositionEncoding::Utf16
        );
    }

    #[test]
    fn utf16_columns_count_code_units_not_bytes() {
        let utf16 = PositionEncoding::Utf16;
        // `ë` is 2 bytes and 1 unit; `𝒜` is 4 bytes and 2 units.
        let line = "Zoë 𝒜 x\n";
        assert_eq!(utf16.column_of_byte(line, 0), 0);
        assert_eq!(utf16.column_of_byte(line, 4), 3); // after `Zoë`
        assert_eq!(utf16.column_of_byte(line, 9), 6); // after `Zoë 𝒜`
        assert_eq!(utf16.column_of_byte(line, 11), 8); // after `x`
        assert_eq!(utf16.byte_of_column(line, 3), 4);
        assert_eq!(utf16.byte_of_column(line, 6), 9);
        assert_eq!(utf16.byte_of_column(line, 8), 11);
    }

    #[test]
    fn utf16_columns_inside_a_character_round_down_to_its_start() {
        let utf16 = PositionEncoding::Utf16;
        let line = "a𝒜b";
        assert_eq!(utf16.byte_of_column(line, 2), 1); // inside the surrogate pair
        assert_eq!(utf16.column_of_byte(line, 3), 1); // inside the 4-byte sequence
    }

    #[test]
    fn utf16_column_past_the_line_end_is_the_end_of_its_content() {
        let utf16 = PositionEncoding::Utf16;
        assert_eq!(utf16.byte_of_column("ë\n", 9), 2);
        assert_eq!(utf16.byte_of_column("ë\r\n", 9), 2);
        assert_eq!(utf16.byte_of_column("", 9), 0);
    }

    #[test]
    fn utf8_columns_are_bytes() {
        let utf8 = PositionEncoding::Utf8;
        assert_eq!(utf8.column_of_byte("Zoë x", 4), 4);
        assert_eq!(utf8.byte_of_column("Zoë x", 4), 4);
    }

    #[test]
    fn link_range_is_in_utf16_units_for_a_utf16_document() {
        let doc = utf16_doc("Zoë [[Alpha]]\n");
        let range = doc.link_to_range(&doc.links[0]);
        assert_eq!((range.start, range.end), (pos(0, 4), pos(0, 13)));

        // The same document for a UTF-8 client: byte columns.
        let doc = Document::from_text("Zoë [[Alpha]]\n", 1);
        let range = doc.link_to_range(&doc.links[0]);
        assert_eq!((range.start, range.end), (pos(0, 5), pos(0, 14)));
    }

    #[test]
    fn utf16_positions_resolve_to_the_link_under_the_cursor() {
        // Line 3 (after the frontmatter): `𝒜é [[Alpha]] tail`.
        let doc = utf16_doc("---\ntitle: T\n---\n𝒜é [[Alpha]] tail\n");
        let range = doc.link_to_range(&doc.links[0]);
        assert_eq!((range.start, range.end), (pos(3, 4), pos(3, 13)));
        assert!(doc.link_at_position(pos(3, 3)).is_none());
        assert!(doc.link_at_position(pos(3, 4)).is_some());
        assert!(doc.link_at_position(pos(3, 12)).is_some());
        assert!(doc.link_at_position(pos(3, 13)).is_none());
        // Body offsets are bytes: `𝒜é ` is 7 bytes.
        assert_eq!(doc.position_to_body_byte_offset(pos(3, 4)), Some(7));
        assert_eq!(doc.position_to_body_byte_offset(pos(1, 2)), None);
    }

    #[test]
    fn utf16_link_range_after_a_crlf_line() {
        let doc = utf16_doc("ë\r\n𝒜[[Alpha]]\r\n");
        let range = doc.link_to_range(&doc.links[0]);
        assert_eq!((range.start, range.end), (pos(1, 2), pos(1, 11)));
        assert!(doc.link_at_position(pos(1, 2)).is_some());
        assert!(doc.link_at_position(pos(1, 1)).is_none());
    }

    #[test]
    fn utf16_positions_round_trip_through_body_offsets() {
        let doc = utf16_doc("日本 a\n𝒜𝒜 b\nZoë\n");
        for (offset, _) in doc.body.char_indices() {
            let position = doc.byte_offset_to_position(offset);
            assert_eq!(doc.position_to_body_byte_offset(position), Some(offset));
        }
    }
}
