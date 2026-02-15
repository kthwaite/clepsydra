use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use tower_lsp::lsp_types::*;

/// A parsed heading with its level and byte span in the body.
#[derive(Debug)]
struct Heading {
    level: u8,         // 1-6
    text: String,      // heading text content
    start_byte: usize, // byte offset of heading start in body
    end_byte: usize,   // byte offset of heading end in body
}

/// Extract headings from a markdown body.
fn extract_headings(body: &str) -> Vec<Heading> {
    let parser = Parser::new_ext(body, Options::all());
    let mut headings = Vec::new();
    let mut in_heading = false;
    let mut current_level: u8 = 0;
    let mut current_text = String::new();
    let mut heading_start: usize = 0;

    for (event, range) in parser.into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = true;
                current_level = heading_level_to_u8(level);
                current_text.clear();
                heading_start = range.start;
            }
            Event::End(TagEnd::Heading(_)) => {
                if in_heading {
                    headings.push(Heading {
                        level: current_level,
                        text: current_text.clone(),
                        start_byte: heading_start,
                        end_byte: range.end,
                    });
                    in_heading = false;
                }
            }
            Event::Text(text) if in_heading => {
                current_text.push_str(&text);
            }
            Event::Code(code) if in_heading => {
                current_text.push('`');
                current_text.push_str(&code);
                current_text.push('`');
            }
            _ => {}
        }
    }

    headings
}

fn heading_level_to_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Build a nested `DocumentSymbol` tree from the document.
///
/// The root symbol represents the page title (from frontmatter or filename).
/// Child symbols are headings, nested by level.
///
/// `to_position` converts a body byte offset to an LSP Position.
pub fn build_document_symbols<F>(title: &str, body: &str, to_position: F) -> Vec<DocumentSymbol>
where
    F: Fn(usize) -> Position,
{
    let headings = extract_headings(body);

    if headings.is_empty() {
        // No headings -- just return the root symbol spanning the whole body
        let start = to_position(0);
        let end = to_position(body.len());
        #[allow(deprecated)] // `deprecated` field is required but deprecated
        return vec![DocumentSymbol {
            name: title.to_string(),
            detail: None,
            kind: SymbolKind::FILE,
            tags: None,
            deprecated: None,
            range: Range { start, end },
            selection_range: Range { start, end: start },
            children: None,
        }];
    }

    // Compute the range of each heading: from its start to the start of the
    // next heading at the same-or-higher level, or EOF.
    let body_len = body.len();
    let mut symbols: Vec<(u8, DocumentSymbol)> = Vec::new();

    for (i, h) in headings.iter().enumerate() {
        // End byte: start of next heading at same-or-higher level, or EOF
        let range_end = headings[i + 1..]
            .iter()
            .find(|next| next.level <= h.level)
            .map(|next| next.start_byte)
            .unwrap_or(body_len);

        let start = to_position(h.start_byte);
        let end = to_position(range_end);
        let sel_start = to_position(h.start_byte);
        let sel_end = to_position(h.end_byte);

        #[allow(deprecated)]
        let sym = DocumentSymbol {
            name: h.text.clone(),
            detail: None,
            kind: SymbolKind::STRING,
            tags: None,
            deprecated: None,
            range: Range { start, end },
            selection_range: Range {
                start: sel_start,
                end: sel_end,
            },
            children: Some(Vec::new()),
        };

        symbols.push((h.level, sym));
    }

    // Build the nested tree using a stack-based approach (left-to-right).
    //
    // `result` collects top-level symbols. `stack` tracks the current
    // nesting path; its invariant is that levels strictly increase from
    // bottom to top. When we encounter a heading at level L, we flush
    // everything on the stack with level >= L back into its parent (or
    // into `result` if it has no parent).
    let mut result: Vec<DocumentSymbol> = Vec::new();
    let mut stack: Vec<(u8, DocumentSymbol)> = Vec::new();

    for (level, sym) in symbols {
        // Pop deeper-or-equal items off the stack, nesting each into its parent.
        while let Some(&(top_level, _)) = stack.last() {
            if top_level >= level {
                let (_, popped) = stack.pop().unwrap();
                if let Some(parent) = stack.last_mut() {
                    parent.1.children.as_mut().unwrap().push(popped);
                } else {
                    result.push(popped);
                }
            } else {
                break;
            }
        }
        stack.push((level, sym));
    }

    // Drain remaining stack items.
    while let Some((_, popped)) = stack.pop() {
        if let Some(parent) = stack.last_mut() {
            parent.1.children.as_mut().unwrap().push(popped);
        } else {
            result.push(popped);
        }
    }

    // Wrap everything in a root FILE symbol
    let children: Vec<DocumentSymbol> = result;
    let doc_start = to_position(0);
    let doc_end = to_position(body_len);

    #[allow(deprecated)]
    let root = DocumentSymbol {
        name: title.to_string(),
        detail: None,
        kind: SymbolKind::FILE,
        tags: None,
        deprecated: None,
        range: Range {
            start: doc_start,
            end: doc_end,
        },
        selection_range: Range {
            start: doc_start,
            end: doc_start,
        },
        children: Some(children),
    };
    vec![root]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trivial_position(offset: usize) -> Position {
        // Simple: treat offsets as line 0, character = offset
        // (Real code uses Document::byte_offset_to_position)
        Position {
            line: 0,
            character: offset as u32,
        }
    }

    #[test]
    fn extract_headings_basic() {
        let body = "## Section A\n\nSome text.\n\n## Section B\n\nMore text.\n";
        let headings = extract_headings(body);
        assert_eq!(headings.len(), 2);
        assert_eq!(headings[0].text, "Section A");
        assert_eq!(headings[0].level, 2);
        assert_eq!(headings[1].text, "Section B");
        assert_eq!(headings[1].level, 2);
    }

    #[test]
    fn extract_headings_nested() {
        let body = "# Top\n\n## Sub\n\n### Deep\n\n## Another\n";
        let headings = extract_headings(body);
        assert_eq!(headings.len(), 4);
        assert_eq!(headings[0].level, 1);
        assert_eq!(headings[1].level, 2);
        assert_eq!(headings[2].level, 3);
        assert_eq!(headings[3].level, 2);
    }

    #[test]
    fn extract_headings_with_code() {
        let body = "## The `Config` struct\n";
        let headings = extract_headings(body);
        assert_eq!(headings.len(), 1);
        assert_eq!(headings[0].text, "The `Config` struct");
    }

    #[test]
    fn extract_headings_empty() {
        let body = "Just text, no headings.\n";
        let headings = extract_headings(body);
        assert!(headings.is_empty());
    }

    #[test]
    fn build_symbols_no_headings() {
        let symbols = build_document_symbols("My Page", "No headings here.", trivial_position);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "My Page");
        assert_eq!(symbols[0].kind, SymbolKind::FILE);
        assert!(symbols[0].children.is_none());
    }

    #[test]
    fn build_symbols_flat() {
        let body = "## A\n\nText A.\n\n## B\n\nText B.\n";
        let symbols = build_document_symbols("Page", body, trivial_position);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Page");
        let children = symbols[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "A");
        assert_eq!(children[1].name, "B");
    }

    #[test]
    fn build_symbols_nested() {
        let body = "## Parent\n\n### Child\n\n## Sibling\n";
        let symbols = build_document_symbols("Page", body, trivial_position);
        let children = symbols[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 2, "should have 2 top-level sections");
        assert_eq!(children[0].name, "Parent");
        let grandchildren = children[0].children.as_ref().unwrap();
        assert_eq!(grandchildren.len(), 1);
        assert_eq!(grandchildren[0].name, "Child");
    }

    #[test]
    fn build_symbols_deeply_nested() {
        let body = "# H1\n\n## H2\n\n### H3\n\n#### H4\n";
        let symbols = build_document_symbols("Page", body, trivial_position);
        let root_children = symbols[0].children.as_ref().unwrap();
        assert_eq!(root_children.len(), 1);
        assert_eq!(root_children[0].name, "H1");
        let h2 = &root_children[0].children.as_ref().unwrap();
        assert_eq!(h2.len(), 1);
        assert_eq!(h2[0].name, "H2");
        let h3 = &h2[0].children.as_ref().unwrap();
        assert_eq!(h3.len(), 1);
        assert_eq!(h3[0].name, "H3");
        let h4 = &h3[0].children.as_ref().unwrap();
        assert_eq!(h4.len(), 1);
        assert_eq!(h4[0].name, "H4");
    }
}
