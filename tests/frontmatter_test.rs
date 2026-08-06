use chrono::{DateTime, Utc};
use uuid::Uuid;

use clepsydra::vault::page::{
    ExtraMap, FrontmatterError, Page, PageMeta, parse_frontmatter, parse_or_repair_frontmatter,
    write_page_content,
};
use clepsydra::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// PageMeta parsing (legacy YAML dual-read)
// ---------------------------------------------------------------------------

#[test]
fn deserialize_full_legacy_frontmatter() {
    let content = r#"---
id: "019578a1-c234-7000-8000-000000000001"
title: "My Page"
tags:
  - rust
  - pkm
aliases:
  - my-page
created_at: "2025-06-01T12:00:00Z"
updated_at: "2025-06-02T08:30:00Z"
custom_field: 42
---
Body
"#;
    let (meta, _) = parse_frontmatter(content).unwrap();
    assert_eq!(
        meta.id,
        Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap()
    );
    assert_eq!(meta.title.as_deref(), Some("My Page"));
    assert_eq!(meta.tags, vec!["rust", "pkm"]);
    assert_eq!(meta.aliases, vec!["my-page"]);
    assert!(meta.created_at.is_some());
    assert!(meta.updated_at.is_some());
    assert_eq!(
        meta.extra.get("custom_field"),
        Some(&toml::Value::Integer(42))
    );
}

#[test]
fn deserialize_minimal_frontmatter() {
    let content = "+++\nid = \"019578a1-c234-7000-8000-000000000001\"\n+++\n";
    let (meta, _) = parse_frontmatter(content).unwrap();
    assert_eq!(
        meta.id,
        Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap()
    );
    assert_eq!(meta.title, None);
    assert!(meta.tags.is_empty());
    assert!(meta.aliases.is_empty());
    assert_eq!(meta.created_at, None);
    assert_eq!(meta.updated_at, None);
    assert!(meta.extra.is_empty());
}

#[test]
fn round_trip_preserves_fields() {
    let now: DateTime<Utc> = "2025-06-01T12:00:00Z".parse().unwrap();
    let id = Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap();
    let meta = PageMeta {
        id,
        title: Some("Round Trip".into()),
        tags: vec!["alpha".into(), "beta".into()],
        aliases: vec!["rt".into()],
        created_at: Some(now),
        updated_at: Some(now),
        extra: ExtraMap::new(),
        kind: None,
        project: None,
    };

    let rendered = write_page_content(&meta, "");
    let (deserialized, _) = parse_frontmatter(&rendered).unwrap();

    assert_eq!(deserialized.id, meta.id);
    assert_eq!(deserialized.title, meta.title);
    assert_eq!(deserialized.tags, meta.tags);
    assert_eq!(deserialized.aliases, meta.aliases);
    assert_eq!(deserialized.created_at, meta.created_at);
    assert_eq!(deserialized.updated_at, meta.updated_at);
}

#[test]
fn skip_serializing_empty_fields() {
    let id = Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap();
    let meta = PageMeta {
        id,
        title: None,
        tags: Vec::new(),
        aliases: Vec::new(),
        created_at: None,
        updated_at: None,
        extra: ExtraMap::new(),
        kind: None,
        project: None,
    };

    let rendered = write_page_content(&meta, "");
    assert!(!rendered.contains("title"));
    assert!(!rendered.contains("tags"));
    assert!(!rendered.contains("aliases"));
    assert!(!rendered.contains("created_at"));
    assert!(!rendered.contains("updated_at"));
    // id must still be present
    assert!(rendered.contains("id"));
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / writing
// ---------------------------------------------------------------------------

#[test]
fn parse_frontmatter_basic() {
    let content = "---\nid: \"019578a1-c234-7000-8000-000000000001\"\ntitle: \"Hello\"\n---\n# Hello\n\nBody text.\n";
    let (meta, body) = parse_frontmatter(content).unwrap();
    assert_eq!(
        meta.id,
        Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap()
    );
    assert_eq!(meta.title.as_deref(), Some("Hello"));
    assert_eq!(body, "# Hello\n\nBody text.\n");
}

#[test]
fn parse_frontmatter_no_fences() {
    let content = "# Just a heading\n\nNo frontmatter here.\n";
    let err = parse_frontmatter(content).unwrap_err();
    assert!(
        matches!(err, FrontmatterError::NotFound),
        "expected NotFound, got: {err}"
    );
}

#[test]
fn write_page_content_round_trip() {
    let id = Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap();
    let meta = PageMeta {
        id,
        title: Some("Test".into()),
        tags: vec!["tag1".into()],
        aliases: Vec::new(),
        created_at: None,
        updated_at: None,
        extra: ExtraMap::new(),
        kind: None,
        project: None,
    };
    let body = "# Test\n\nSome content.\n";

    let rendered = write_page_content(&meta, body);
    let (parsed_meta, parsed_body) = parse_frontmatter(&rendered).unwrap();

    assert_eq!(parsed_meta.id, meta.id);
    assert_eq!(parsed_meta.title, meta.title);
    assert_eq!(parsed_meta.tags, meta.tags);
    assert_eq!(parsed_body, body);
}

#[test]
fn parse_or_repair_frontmatter_adds_metadata_when_missing() {
    let content = "# Heading\n\nBody text.\n";
    let (meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);

    assert!(rewrote, "missing frontmatter should trigger rewrite");
    assert!(warning.is_none());
    assert!(!meta.id.is_nil());
    assert!(meta.created_at.is_some());
    assert!(meta.updated_at.is_some());
    assert_eq!(body, content);
}

#[test]
fn parse_or_repair_frontmatter_salvages_existing_fields() {
    let content = "---\ntitle: Draft\ntags:\n  - inbox\n---\nHello\n";

    let (meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);

    assert!(rewrote, "incomplete frontmatter should be repaired");
    assert!(warning.is_none());
    assert_eq!(meta.title.as_deref(), Some("Draft"));
    assert_eq!(meta.tags, vec!["inbox"]);
    assert!(!meta.id.is_nil(), "repair should add a UUID");
    assert!(meta.created_at.is_some());
    assert!(meta.updated_at.is_some());
    assert_eq!(body, "Hello\n");
}

#[test]
fn parse_or_repair_unparseable_yaml_preserves_file() {
    let content = "---\n: :\nbad yaml {{{\n---\nBody text";

    let (meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);

    assert!(!rewrote, "unparseable YAML should NOT trigger rewrite");
    assert!(warning.is_some(), "should emit a warning");
    assert!(
        warning.unwrap().contains("unparseable"),
        "warning should mention unparseable"
    );
    assert_eq!(body, "Body text");
    // Meta should be default (new)
    assert!(!meta.id.is_nil(), "default meta should have a v7 UUID");
}

#[test]
fn healed_legacy_page_serializes_as_toml() {
    // A YAML page that needs repair (missing id) must come back out as `+++`.
    let content = "---\ntitle: Draft\n---\nHello\n";
    let (meta, body, rewrote, _) = parse_or_repair_frontmatter(content);
    assert!(rewrote);
    let healed = write_page_content(&meta, &body);
    assert!(
        healed.starts_with("+++\n"),
        "healed page must be TOML: {healed}"
    );
    assert!(healed.contains("title = \"Draft\""));
}

// ---------------------------------------------------------------------------
// Page struct with file I/O
// ---------------------------------------------------------------------------

#[test]
fn page_from_file_reads_and_parses() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("note.md");
    let content = "---\nid: \"019578a1-c234-7000-8000-000000000001\"\ntitle: \"Note\"\n---\n# Note\n\nBody.\n";
    std::fs::write(&file_path, content).unwrap();

    let vp = VaultPath::new("note.md").unwrap();
    let page = Page::from_file(&file_path, vp).unwrap();

    assert_eq!(
        page.meta.id,
        Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap()
    );
    assert_eq!(page.meta.title.as_deref(), Some("Note"));
    assert_eq!(page.body, "# Note\n\nBody.\n");
    assert_eq!(page.path.as_str(), "note.md");
}

#[test]
fn page_to_file_writes_correctly() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("output.md");

    let id = Uuid::parse_str("019578a1-c234-7000-8000-000000000001").unwrap();
    let meta = PageMeta {
        id,
        title: Some("Output".into()),
        tags: Vec::new(),
        aliases: Vec::new(),
        created_at: None,
        updated_at: None,
        extra: ExtraMap::new(),
        kind: None,
        project: None,
    };
    let body = "Hello world.\n".to_string();
    let raw_content = write_page_content(&meta, &body);
    let vp = VaultPath::new("output.md").unwrap();

    let page = Page {
        path: vp,
        meta,
        body,
        raw_content,
    };
    page.to_file(&file_path).unwrap();

    let read_back = std::fs::read_to_string(&file_path).unwrap();
    assert!(read_back.starts_with("+++\n"));
    assert!(read_back.contains("019578a1-c234-7000-8000-000000000001"));
    assert!(read_back.contains("Hello world.\n"));
}

#[test]
fn page_from_file_no_frontmatter_creates_uuid() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("plain.md");
    std::fs::write(&file_path, "# Just a heading\n\nNo frontmatter.\n").unwrap();

    let vp = VaultPath::new("plain.md").unwrap();
    let page = Page::from_file_or_create_meta(&file_path, vp).unwrap();

    // Should have a valid v7 UUID (non-nil)
    assert!(!page.meta.id.is_nil());
    // The body should be the entire original content
    assert_eq!(page.body, "# Just a heading\n\nNo frontmatter.\n");
    // created_at should be set
    assert!(page.meta.created_at.is_some());
}
