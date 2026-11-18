use clep_bases::generated_region::{parse_regions, replace_region};

#[test]
fn regeneration_replaces_only_the_owned_markdown_span() {
    let payload = "\n\n# Beer\n\nA  *full* tasting.&#x20;\n\n";
    let region = format!(
        "<!-- clep:generated\nversion = 1\nid = \"019f4d96-7ba5-7b93-b4e3-a93d134b964c\"\nbase = \"beer\"\ntemplate = \"notes\"\noutput_hash = \"blake3:{}\"\n-->{payload}<!-- /clep:generated -->",
        blake3::hash(payload.as_bytes()).to_hex()
    );
    let source = format!("Handwritten  introduction.\n\n{region}\n\nAfter.  \n");
    let regions = parse_regions(&source).unwrap();
    assert_eq!(regions.len(), 1);
    assert!(!regions[0].modified);
    assert_eq!(&source[regions[0].payload.clone()], payload);
    let updated = replace_region(
        &source,
        &regions[0],
        &regions[0].descriptor.selection,
        "# Fresh\n\nNew tasting.",
    )
    .unwrap();
    assert!(updated.starts_with("Handwritten  introduction.\n\n<!-- clep:generated\n"));
    assert!(updated.ends_with("<!-- /clep:generated -->\n\nAfter.  \n"));
    let fresh = parse_regions(&updated).unwrap();
    assert_eq!(
        &updated[fresh[0].payload.clone()],
        "\n\n# Fresh\n\nNew tasting.\n\n"
    );
    assert!(!fresh[0].modified);
}

#[test]
fn marker_examples_stay_literal_and_external_edits_are_detected() {
    let payload = "\n\nOriginal.\n\n";
    let region = format!(
        "<!-- clep:generated\nversion = 1\nid = \"019f4d96-7ba5-7b93-b4e3-a93d134b964c\"\nbase = \"beer\"\ntemplate = \"notes\"\noutput_hash = \"blake3:{}\"\n-->{payload}<!-- /clep:generated -->",
        blake3::hash(payload.as_bytes()).to_hex()
    );
    let literal = format!("````markdown\n{region}\n````\n\n");
    assert!(parse_regions(&literal).unwrap().is_empty());
    let edited = format!("{literal}{}", region.replace("Original.", "External edit."));
    let regions = parse_regions(&edited).unwrap();
    assert_eq!(regions.len(), 1);
    assert!(regions[0].modified);
    assert_eq!(
        &edited[regions[0].payload.clone()],
        "\n\nExternal edit.\n\n"
    );
    assert!(parse_regions(&format!("{region}\n\n{region}")).is_err());
    assert!(parse_regions(&region.replace("<!-- /clep:generated -->", "")).is_err());
}

#[test]
fn insertion_cannot_split_markdown_or_create_nested_execution() {
    use clep_bases::generated_region::{ensure_inert_output, insert_region};
    let selection = clep_bases::base_render::RenderSelection {
        base: "beer".into(),
        view: None,
        filter: None,
        sort: None,
        limit: None,
        template: "notes".into(),
    };
    let id = "019f4d96-7ba5-7b93-b4e3-a93d134b964c";
    assert!(insert_region("```\ncode\n```\n", 5, id, &selection, "New").is_err());
    assert!(insert_region("α", 1, id, &selection, "New").is_err());
    assert!(ensure_inert_output("<!-- clep:generated\nbad\n-->").is_err());
    assert!(ensure_inert_output("```base\nbase = \"beer\"\n```").is_ok());
    let source = "Before.\n\nAfter.\n";
    let inserted = insert_region(source, 9, id, &selection, "# Beer").unwrap();
    assert!(inserted.starts_with("Before.\n\n<!-- clep:generated"));
    assert!(inserted.ends_with("<!-- /clep:generated -->\n\nAfter.\n"));
}

#[test]
fn directives_followed_by_same_line_prose_are_not_region_boundaries() {
    let source = "<!-- clep:generated --> ordinary prose\n";
    assert!(parse_regions(source).unwrap().is_empty());
    assert!(clep_bases::generated_region::ensure_inert_output(source).is_ok());
}

#[test]
fn unsupported_descriptor_fields_remain_repair_only() {
    let payload = "\n\nSnapshot.\n\n";
    let source = format!(
        "<!-- clep:generated\nversion = 1\nid = \"019f4d96-7ba5-7b93-b4e3-a93d134b964c\"\nbase = \"beer\"\ntemplate = \"notes\"\nunknown = \"must not silently disappear\"\noutput_hash = \"blake3:{}\"\n-->{payload}<!-- /clep:generated -->",
        blake3::hash(payload.as_bytes()).to_hex()
    );
    assert!(parse_regions(&source).is_err());
}

#[test]
fn parse_regions_survives_setext_inputs_that_panic_the_markdown_parser() {
    // pulldown-cmark 0.13.6 panics on these with heading attributes enabled
    // (see clep_vault::markdown::panic_safe_options).
    assert_eq!(parse_regions("- [ ] \\\n  ---").unwrap().len(), 0);
    assert_eq!(parse_regions(">]\n>  {}\n>-").unwrap().len(), 0);
}

fn notes_selection() -> clep_bases::base_render::RenderSelection {
    clep_bases::base_render::RenderSelection {
        base: "beer".into(),
        view: None,
        filter: None,
        sort: None,
        limit: None,
        template: "notes".into(),
    }
}

#[test]
fn output_that_leaves_a_block_open_is_rejected_before_it_swallows_the_end_marker() {
    use clep_bases::generated_region::{ensure_inert_output, format_region};
    let id = "019f4d96-7ba5-7b93-b4e3-a93d134b964c";
    for output in [
        "```\ncode",
        "~~~",
        "<!-- note",
        "<pre>\ntext",
        "<script>",
        "<![CDATA[",
        "<?x",
        // A footnote definition directly followed by a list keeps the list
        // open across the blank line before the end marker.
        "Claim.[^1]\n\n[^1]: Source.\n- item",
    ] {
        let error = ensure_inert_output(output).unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid generated region: template output leaves a Markdown block open",
            "{output:?}"
        );
        assert!(
            format_region(id, &notes_selection(), output).is_err(),
            "{output:?}"
        );
    }
    for output in [
        "```\ncode\n```",
        "<!-- note -->",
        "<pre>\ntext\n</pre>",
        "Claim.[^1]\n\n[^1]: Source.\n\n- item",
        "- item\n\n  continued",
        "> quote",
        "",
    ] {
        ensure_inert_output(output).unwrap();
        let region = format_region(id, &notes_selection(), output).unwrap();
        let regions = parse_regions(&region).unwrap();
        assert_eq!(regions.len(), 1, "{output:?}");
        assert_eq!(regions[0].span, 0..region.len(), "{output:?}");
        assert!(!regions[0].modified, "{output:?}");
    }
}

#[test]
fn regeneration_with_an_open_block_leaves_the_page_untouched() {
    use clep_bases::generated_region::format_region;
    let first = format_region(
        "019f4d96-7ba5-7b93-b4e3-a93d134b964c",
        &notes_selection(),
        "One.",
    )
    .unwrap();
    let second = format_region(
        "019f4d96-7ba5-7b93-b4e3-a93d134b964d",
        &notes_selection(),
        "Two.",
    )
    .unwrap();
    let page = format!("Intro.\n\n{first}\n\nBetween.\n\n{second}\n\nAfter.\n");
    let regions = parse_regions(&page).unwrap();
    assert_eq!(regions.len(), 2);
    assert!(replace_region(&page, &regions[0], &notes_selection(), "```\nlisting").is_err());
}

#[test]
fn insertion_after_an_unterminated_block_is_rejected() {
    use clep_bases::generated_region::insert_region;
    let id = "019f4d96-7ba5-7b93-b4e3-a93d134b964c";
    // The open block runs to the end of the document, so an insertion there
    // would land inside it as literal text.
    for source in ["```\ncode\n", "Intro.\n\n~~~text\n", "<!-- draft\n"] {
        let error = insert_region(source, source.len(), id, &notes_selection(), "New").unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid generated region: insertion must be between Markdown blocks",
            "{source:?}"
        );
    }
    let closed = "```\ncode\n```\n";
    let inserted = insert_region(closed, closed.len(), id, &notes_selection(), "New").unwrap();
    assert_eq!(parse_regions(&inserted).unwrap().len(), 1);
}
