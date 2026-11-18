use clep_vault::rewriter::{DELETE_PLAIN, DELETE_UNLINK, rewrite_links_in_content};

// ---------------------------------------------------------------------------
// rewrite_links_in_content tests
// ---------------------------------------------------------------------------

#[test]
fn rewrite_wikilink() {
    let content = "See [[Old Page]] for details.";
    let result = rewrite_links_in_content(content, &[("Old Page", "New Page")], &[]);
    assert_eq!(result, "See [[New Page]] for details.");
}

#[test]
fn rewrite_wikilink_with_display_text() {
    let content = "See [[Old Page|my notes]] for details.";
    let result = rewrite_links_in_content(content, &[("Old Page", "New Page")], &[]);
    assert_eq!(result, "See [[New Page|my notes]] for details.");
}

#[test]
fn rewrite_markdown_link() {
    let content = "See [notes](old.md) for details.";
    let result = rewrite_links_in_content(content, &[], &[("old.md", "new.md")]);
    assert_eq!(result, "See [notes](new.md) for details.");
}

#[test]
fn rewrite_multiple_links() {
    let content = "[[Alpha]] and [[Beta]] and [gamma](gamma.md)";
    let result = rewrite_links_in_content(
        content,
        &[("Alpha", "A"), ("Beta", "B")],
        &[("gamma.md", "g.md")],
    );
    assert_eq!(result, "[[A]] and [[B]] and [gamma](g.md)");
}

#[test]
fn skip_links_in_code_blocks() {
    let content = "```\n[[Old Page]]\n```\n\nOutside `[[Old Page]]` too.\n\n[[Old Page]]";
    let result = rewrite_links_in_content(content, &[("Old Page", "New Page")], &[]);
    // The fenced code block and inline code should be untouched;
    // only the bare wikilink outside should be rewritten.
    assert!(
        result.contains("```\n[[Old Page]]\n```"),
        "fenced code block must be preserved, got: {result}"
    );
    assert!(
        result.contains("`[[Old Page]]`"),
        "inline code must be preserved, got: {result}"
    );
    assert!(
        result.contains("[[New Page]]"),
        "bare wikilink should be rewritten, got: {result}"
    );
}

#[test]
fn delete_rewrite_plain_text() {
    let content = "See [[Doomed Page]] for info.";
    let new_target = format!("{DELETE_PLAIN}Doomed Page");
    let result = rewrite_links_in_content(content, &[("Doomed Page", &new_target)], &[]);
    assert_eq!(result, "See Doomed Page for info.");
}

#[test]
fn delete_rewrite_unlink() {
    let content = "See [[Doomed Page]] for info.";
    let new_target = format!("{DELETE_UNLINK}Doomed Page");
    let result = rewrite_links_in_content(content, &[("Doomed Page", &new_target)], &[]);
    assert_eq!(result, "See ~~Doomed Page~~ for info.");
}

#[test]
fn rewrite_targets_are_specific_to_link_syntax() {
    let content = "[[people/ada.md|Ada]] [Other](people/ada.md) \
                   [[../people/ada.md|Other]] [Ada](../people/ada.md)";
    let result = rewrite_links_in_content(
        content,
        &[("people/ada.md", "people/renamed.md")],
        &[("../people/ada.md", "../people/renamed.md")],
    );
    assert_eq!(
        result,
        "[[people/renamed.md|Ada]] [Other](people/ada.md) \
         [[../people/ada.md|Other]] [Ada](../people/renamed.md)"
    );
}

// ---------------------------------------------------------------------------
// Markdown link destinations: only the destination bytes change
// ---------------------------------------------------------------------------

/// Destination of the single Markdown link in `content`, as the parser reads it.
fn markdown_target(content: &str) -> Option<String> {
    let links = clep_vault::link::extract_links(content);
    match links.as_slice() {
        [link] if link.kind == clep_vault::link::LinkKind::Markdown => {
            Some(link.target_raw.clone())
        }
        _ => None,
    }
}

#[test]
fn rewrite_keeps_angle_brackets_around_destination() {
    let result = rewrite_links_in_content(
        "[x](<My Note.md>)",
        &[],
        &[("My Note.md", "sub/My Note.md")],
    );
    assert_eq!(result, "[x](<sub/My Note.md>)");
    assert_eq!(markdown_target(&result).as_deref(), Some("sub/My Note.md"));
}

#[test]
fn rewrite_adds_angle_brackets_when_new_destination_has_spaces() {
    let result = rewrite_links_in_content("[x](old.md)", &[], &[("old.md", "New Name.md")]);
    assert_eq!(result, "[x](<New Name.md>)");
    assert_eq!(markdown_target(&result).as_deref(), Some("New Name.md"));
}

#[test]
fn rewrite_escapes_destination_that_would_not_parse_back() {
    // Unbalanced parenthesis in a bare destination.
    let result = rewrite_links_in_content("[x](old.md)", &[], &[("old.md", "a)b.md")]);
    assert_eq!(result, "[x](a\\)b.md)");
    assert_eq!(markdown_target(&result).as_deref(), Some("a)b.md"));

    // Balanced parentheses need no escape.
    let result = rewrite_links_in_content("[x](old.md)", &[], &[("old.md", "a(b).md")]);
    assert_eq!(result, "[x](a(b).md)");

    // Angle bracket inside an angle-bracket destination.
    let result = rewrite_links_in_content("[x](<old name.md>)", &[], &[("old name.md", "a >b.md")]);
    assert_eq!(result, "[x](<a \\>b.md>)");
    assert_eq!(markdown_target(&result).as_deref(), Some("a >b.md"));
}

#[test]
fn rewrite_keeps_link_title_and_padding() {
    assert_eq!(
        rewrite_links_in_content("[x](alpha.md \"A title\")", &[], &[("alpha.md", "f.md")]),
        "[x](f.md \"A title\")"
    );
    assert_eq!(
        rewrite_links_in_content("[x](alpha.md 'A title')", &[], &[("alpha.md", "f.md")]),
        "[x](f.md 'A title')"
    );
    assert_eq!(
        rewrite_links_in_content("[x](alpha.md (A title))", &[], &[("alpha.md", "f.md")]),
        "[x](f.md (A title))"
    );
    assert_eq!(
        rewrite_links_in_content("[x]( alpha.md )", &[], &[("alpha.md", "f.md")]),
        "[x]( f.md )"
    );
}

#[test]
fn rewrite_replaces_destination_with_parentheses_whole() {
    assert_eq!(
        rewrite_links_in_content("[x](a(b).md) tail", &[], &[("a(b).md", "f.md")]),
        "[x](f.md) tail"
    );
    assert_eq!(
        rewrite_links_in_content("[x](a\\)b.md) tail", &[], &[("a)b.md", "f.md")]),
        "[x](f.md) tail"
    );
}

#[test]
fn rewrite_ignores_bracket_paren_inside_title_and_label() {
    assert_eq!(
        rewrite_links_in_content("[x](alpha.md 'see [y](z)')", &[], &[("alpha.md", "f.md")]),
        "[x](f.md 'see [y](z)')"
    );
    assert_eq!(
        rewrite_links_in_content("[`a](alpha.md)`](alpha.md)", &[], &[("alpha.md", "f.md")]),
        "[`a](alpha.md)`](f.md)"
    );
    assert_eq!(
        rewrite_links_in_content("[a [b] \\] c](alpha.md)", &[], &[("alpha.md", "f.md")]),
        "[a [b] \\] c](f.md)"
    );
    // A reference link has no inline destination: its label is never edited.
    let reference = "[`a](b)`][r]\n\n[r]: alpha.md";
    let result = rewrite_links_in_content(reference, &[], &[("alpha.md", "f.md")]);
    assert!(
        result.starts_with("[`a](b)`][r]"),
        "label edited: {result:?}"
    );
}

#[test]
fn delete_sentinel_is_never_written_into_a_markdown_destination() {
    let content = "See [doomed](doomed.md) for info.";
    let new_target = format!("{DELETE_PLAIN}Doomed Page");
    let result = rewrite_links_in_content(content, &[], &[("doomed.md", &new_target)]);
    assert_eq!(result, content);
}

#[test]
fn destination_that_cannot_be_located_is_left_untouched() {
    // The destination sits behind a blockquote marker on a continuation line.
    let content = "> [x](\n> alpha.md)";
    assert_eq!(markdown_target(content).as_deref(), Some("alpha.md"));
    let result = rewrite_links_in_content(content, &[], &[("alpha.md", "f.md")]);
    assert_eq!(result, content);
}

// ---------------------------------------------------------------------------
// Reference-style Markdown links: the definition's destination is rewritten
// ---------------------------------------------------------------------------

#[test]
fn rewrite_reference_style_link_definition() {
    let content = "[x][r] and [r][] and [R]\n\n[r]: alpha.md";
    let result = rewrite_links_in_content(content, &[], &[("alpha.md", "f.md")]);
    assert_eq!(result, "[x][r] and [r][] and [R]\n\n[r]: f.md");
}

#[test]
fn rewrite_reference_definition_keeps_title_and_form() {
    assert_eq!(
        rewrite_links_in_content(
            "[x][r]\n\n  [r]:   <My Note.md>  'T'\n",
            &[],
            &[("My Note.md", "sub/My Note.md")]
        ),
        "[x][r]\n\n  [r]:   <sub/My Note.md>  'T'\n"
    );
    assert_eq!(
        rewrite_links_in_content(
            "[x][r]\n\n[r]: alpha.md \"T\"\n",
            &[],
            &[("alpha.md", "New Name.md")]
        ),
        "[x][r]\n\n[r]: <New Name.md> \"T\"\n"
    );
    // Label with an escaped bracket; destination on the next line.
    assert_eq!(
        rewrite_links_in_content(
            "[x][a\\]b]\n\n[a\\]b]:\n    alpha.md\n",
            &[],
            &[("alpha.md", "f.md")]
        ),
        "[x][a\\]b]\n\n[a\\]b]:\n    f.md\n"
    );
}

#[test]
fn rewrite_leaves_other_reference_definitions_alone() {
    // Not a match, inside a code block, a footnote, or a definition that no
    // link uses.
    let content = "[x][r] [c] note[^1]\n\n[r]: other.md\n\n```\n[c]: alpha.md\n```\n\n\
                   [^1]: alpha.md\n\n[unused]: alpha.md\n";
    let result = rewrite_links_in_content(content, &[], &[("alpha.md", "f.md")]);
    assert_eq!(result, content);
}

// ---------------------------------------------------------------------------
// Footnotes: a footnote definition is not a link reference definition
// ---------------------------------------------------------------------------

#[test]
fn rewrite_link_alone_in_footnote_definition() {
    assert_eq!(
        rewrite_links_in_content("Text[^1].\n\n[^1]: [[Alpha]]\n", &[("Alpha", "Beta")], &[]),
        "Text[^1].\n\n[^1]: [[Beta]]\n"
    );
    assert_eq!(
        rewrite_links_in_content(
            "Text[^1].\n\n[^1]: lead '[x](a.md)'\n",
            &[],
            &[("a.md", "f.md")]
        ),
        "Text[^1].\n\n[^1]: lead '[x](f.md)'\n"
    );
}

#[test]
fn rewrite_leaves_footnote_text_alone() {
    // The footnote's text happens to equal the moved page's relative path.
    let content = "Text[^1].\n\n[^1]: alpha.md\n";
    assert_eq!(
        rewrite_links_in_content(content, &[], &[("alpha.md", "f.md")]),
        content
    );
}

// ---------------------------------------------------------------------------
// Wikilinks are recognised from the source, not from single text runs
// ---------------------------------------------------------------------------

#[test]
fn rewrite_wikilink_whose_target_has_inline_markup() {
    assert_eq!(
        rewrite_links_in_content("[[__init__]]", &[("__init__", "setup")], &[]),
        "[[setup]]"
    );
    assert_eq!(
        rewrite_links_in_content("see [[a*b*c|the *label*]] now", &[("a*b*c", "abc")], &[]),
        "see [[abc|the *label*]] now"
    );
}

#[test]
fn rewrite_wikilink_that_a_reference_definition_would_hijack() {
    // The definition is for another page; the wikilink is what moves.
    assert_eq!(
        rewrite_links_in_content(
            "[Alpha]: other.md\n\n[[Alpha]]",
            &[("Alpha", "Beta")],
            &[("other.md", "moved.md")]
        ),
        "[Alpha]: other.md\n\n[[Beta]]"
    );
    // A real shortcut reference next to it still rewrites the definition.
    assert_eq!(
        rewrite_links_in_content(
            "[Alpha]: other.md\n\n[[Alpha]] [Alpha]",
            &[],
            &[("other.md", "moved.md")]
        ),
        "[Alpha]: moved.md\n\n[[Alpha]] [Alpha]"
    );
}

#[test]
fn rewrite_skips_wikilink_syntax_in_code_spans() {
    let content = "`a [[Alpha` c]] and [[Alpha `x]]` and `[[Alpha]]`";
    assert_eq!(
        rewrite_links_in_content(content, &[("Alpha", "Beta")], &[]),
        content
    );
}

#[test]
fn rewrite_links_with_asks_about_every_link_as_written() {
    use clep_vault::rewriter::{LinkSyntax, rewrite_links_with};
    use std::cell::RefCell;

    let content = "[[ Alpha |shown]] [x](<Alpha.md> \"tip\") [r][ref] `[[Alpha]]` [[other]]\n\n[ref]: dir/alpha.md\n";
    let asked = RefCell::new(Vec::new());
    let rewritten = rewrite_links_with(content, |syntax, target| {
        asked.borrow_mut().push((syntax, target.to_string()));
        // Decide by what the target means, not by its spelling.
        target
            .trim()
            .to_lowercase()
            .contains("alpha")
            .then(|| match syntax {
                LinkSyntax::Wiki => "beta".to_string(),
                LinkSyntax::Markdown => "beta gamma.md".to_string(),
            })
    });

    assert_eq!(
        rewritten,
        "[[beta|shown]] [x](<beta gamma.md> \"tip\") [r][ref] `[[Alpha]]` [[other]]\n\n[ref]: <beta gamma.md>\n"
    );
    let mut asked = asked.into_inner();
    asked.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(
        asked,
        vec![
            (LinkSyntax::Wiki, " Alpha ".to_string()),
            (LinkSyntax::Markdown, "Alpha.md".to_string()),
            (LinkSyntax::Markdown, "dir/alpha.md".to_string()),
            (LinkSyntax::Wiki, "other".to_string()),
        ]
    );
}
