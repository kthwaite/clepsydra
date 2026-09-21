use clep_bases::template_document::{
    TemplateError, create_template, list_templates, read_template, update_template,
};

#[test]
fn stale_revision_preserves_external_template_edits() {
    let root = tempfile::tempdir().unwrap();
    let original = create_template(root.path(), "beer-notes", "# {{ page.title }}\n").unwrap();
    let external = "# External edit\r\n{{ rows | length }} records\r\n";
    std::fs::write(
        root.path().join(".clepsydra/templates/beer-notes.md.jinja"),
        external,
    )
    .unwrap();

    let result = update_template(
        root.path(),
        "beer-notes",
        "Overwrite from an old editor\n",
        &original.revision,
    );

    assert!(matches!(result, Err(TemplateError::Conflict { .. })));
    let current = read_template(root.path(), "beer-notes").unwrap();
    assert_eq!(current.source, external);
    assert_ne!(current.revision, original.revision);
}

#[test]
fn listing_excludes_non_templates_and_create_preserves_existing_source() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(list_templates(root.path()).unwrap(), Vec::<String>::new());
    create_template(root.path(), "z-last", "Last\n").unwrap();
    let first = create_template(root.path(), "a-first", "First\r\n").unwrap();
    let directory = root.path().join(".clepsydra/templates");
    std::fs::write(directory.join("scratch.md"), "Not a template").unwrap();
    std::fs::create_dir(directory.join("directory.md.jinja")).unwrap();

    assert!(matches!(
        create_template(root.path(), "a-first", "Replacement"),
        Err(TemplateError::AlreadyExists(_))
    ));
    assert_eq!(
        read_template(root.path(), "a-first").unwrap().source,
        "First\r\n"
    );
    assert_eq!(list_templates(root.path()).unwrap(), ["a-first", "z-last"]);

    let updated = update_template(root.path(), "a-first", "First\n", &first.revision).unwrap();
    assert_ne!(updated.revision, first.revision);
    assert_eq!(
        read_template(root.path(), "a-first").unwrap().source,
        "First\n"
    );
}

#[test]
fn oversized_utf8_sources_are_rejected_without_replacing_saved_content() {
    let root = tempfile::tempdir().unwrap();
    let saved = create_template(root.path(), "notes", "Keep this\n").unwrap();
    let oversized = format!("{}€", "a".repeat(1024 * 1024));
    assert!(matches!(
        update_template(root.path(), "notes", &oversized, &saved.revision),
        Err(TemplateError::TooLarge)
    ));
    assert_eq!(
        read_template(root.path(), "notes").unwrap().source,
        "Keep this\n"
    );
    assert!(matches!(
        create_template(root.path(), "new", &oversized),
        Err(TemplateError::TooLarge)
    ));
    assert!(matches!(
        read_template(root.path(), "new"),
        Err(TemplateError::NotFound(_))
    ));

    std::fs::write(
        root.path().join(".clepsydra/templates/notes.md.jinja"),
        &oversized,
    )
    .unwrap();
    assert!(matches!(
        read_template(root.path(), "notes"),
        Err(TemplateError::TooLarge)
    ));
}

#[test]
fn traversal_slugs_cannot_read_or_replace_neighboring_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("outside.md.jinja"), "Keep outside").unwrap();
    for slug in ["../outside", "..", "/outside", "a/b", "a\\b", "a/"] {
        assert!(matches!(
            read_template(root.path(), slug),
            Err(TemplateError::InvalidSlug(_))
        ));
        assert!(matches!(
            create_template(root.path(), slug, "Replace"),
            Err(TemplateError::InvalidSlug(_))
        ));
        assert!(matches!(
            update_template(root.path(), slug, "Replace", "stale"),
            Err(TemplateError::InvalidSlug(_))
        ));
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("outside.md.jinja")).unwrap(),
        "Keep outside"
    );
}

#[cfg(unix)]
#[test]
fn symlinked_template_files_and_ancestors_cannot_escape_the_store() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let outside_template = outside.path().join("notes.md.jinja");
    std::fs::write(&outside_template, "Keep outside").unwrap();
    create_template(root.path(), "real", "Inside").unwrap();
    let directory = root.path().join(".clepsydra/templates");
    symlink(&outside_template, directory.join("notes.md.jinja")).unwrap();
    symlink(
        outside.path().join("missing"),
        directory.join("dangling.md.jinja"),
    )
    .unwrap();

    for slug in ["notes", "dangling"] {
        assert!(matches!(
            read_template(root.path(), slug),
            Err(TemplateError::UnsafePath)
        ));
        assert!(matches!(
            create_template(root.path(), slug, "Replace"),
            Err(TemplateError::UnsafePath)
        ));
        assert!(matches!(
            update_template(root.path(), slug, "Replace", "stale"),
            Err(TemplateError::UnsafePath)
        ));
    }
    assert_eq!(list_templates(root.path()).unwrap(), ["real"]);

    for ancestor in [".clepsydra", ".clepsydra/templates"] {
        let other_root = tempfile::tempdir().unwrap();
        if ancestor.ends_with("/templates") {
            std::fs::create_dir(other_root.path().join(".clepsydra")).unwrap();
        }
        symlink(outside.path(), other_root.path().join(ancestor)).unwrap();
        assert!(matches!(
            list_templates(other_root.path()),
            Err(TemplateError::UnsafePath)
        ));
        assert!(matches!(
            read_template(other_root.path(), "notes"),
            Err(TemplateError::UnsafePath)
        ));
        assert!(matches!(
            create_template(other_root.path(), "notes", "Replace"),
            Err(TemplateError::UnsafePath)
        ));
        assert!(matches!(
            update_template(other_root.path(), "notes", "Replace", "stale"),
            Err(TemplateError::UnsafePath)
        ));
    }
    assert_eq!(
        std::fs::read_to_string(outside_template).unwrap(),
        "Keep outside"
    );
    assert!(!outside.path().join("missing").exists());
    assert!(!outside.path().join("templates").exists());
}
