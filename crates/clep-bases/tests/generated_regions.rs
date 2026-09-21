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
