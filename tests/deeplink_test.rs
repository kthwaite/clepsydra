use std::path::Path;

use clepsydra::deeplink::{ParseError, deeplink_http_url, parse, vault_matches};

#[test]
fn parses_clepsydra_page_link() {
    let p = parse("clepsydra://page/projects/20260531.foo.aB3dE9xZ.md").unwrap();
    assert_eq!(p.target_raw, "projects/20260531.foo.aB3dE9xZ.md");
    assert_eq!(p.target_decoded, "projects/20260531.foo.aB3dE9xZ.md");
    assert_eq!(p.vault, None);
}

#[test]
fn decodes_percent_encoding_but_keeps_raw() {
    let p = parse("clepsydra://page/Clepsydra%20Redesign").unwrap();
    assert_eq!(p.target_raw, "Clepsydra%20Redesign");
    assert_eq!(p.target_decoded, "Clepsydra Redesign");
}

#[test]
fn clepsydra_scheme_is_case_insensitive() {
    assert!(parse("CLEPSYDRA://page/x").is_ok());
}

#[test]
fn clepsydra_unknown_verb_is_error() {
    assert_eq!(
        parse("clepsydra://journal/2026-07-11").unwrap_err(),
        ParseError::UnsupportedAction("journal".to_string())
    );
}

#[test]
fn clepsydra_empty_target_is_error() {
    assert_eq!(
        parse("clepsydra://page/").unwrap_err(),
        ParseError::MissingTarget
    );
    assert_eq!(
        parse("clepsydra://page").unwrap_err(),
        ParseError::MissingTarget
    );
}

#[test]
fn parses_obsidian_open_action() {
    let p = parse("obsidian://open?vault=brain&file=Sub%2FNote").unwrap();
    assert_eq!(p.vault, Some("brain".to_string()));
    // Query param values arrive fully decoded; raw == decoded for query form.
    assert_eq!(p.target_raw, "Sub/Note");
    assert_eq!(p.target_decoded, "Sub/Note");
}

#[test]
fn obsidian_open_without_vault_is_ok() {
    let p = parse("obsidian://open?file=Note").unwrap();
    assert_eq!(p.vault, None);
    assert_eq!(p.target_decoded, "Note");
}

#[test]
fn obsidian_open_without_file_is_error() {
    assert_eq!(
        parse("obsidian://open?vault=brain").unwrap_err(),
        ParseError::MissingFileParam
    );
}

#[test]
fn parses_obsidian_vault_shorthand() {
    let p = parse("obsidian://vault/my%20vault/my%20note").unwrap();
    assert_eq!(p.vault, Some("my vault".to_string()));
    assert_eq!(p.target_raw, "my%20note");
    assert_eq!(p.target_decoded, "my note");
}

#[test]
fn obsidian_absolute_path_form_is_unsupported() {
    assert!(matches!(
        parse("obsidian:///Users/kit/vault/note.md").unwrap_err(),
        ParseError::UnsupportedAction(_)
    ));
}

#[test]
fn other_schemes_are_rejected() {
    assert_eq!(
        parse("https://example.com").unwrap_err(),
        ParseError::UnsupportedScheme
    );
    assert_eq!(
        parse("not a url").unwrap_err(),
        ParseError::Malformed("missing ://".to_string())
    );
}

#[test]
fn fragment_is_stripped() {
    let p = parse("clepsydra://page/Note#heading").unwrap();
    assert_eq!(p.target_decoded, "Note");
}

#[test]
fn vault_matches_none_always_passes() {
    assert!(vault_matches(None, Path::new("/x/notes"), &[]));
}

#[test]
fn vault_matches_basename_and_aliases() {
    let root = Path::new("/Users/kit/notes");
    assert!(vault_matches(Some("notes"), root, &[]));
    assert!(vault_matches(Some("brain"), root, &["brain".to_string()]));
    assert!(!vault_matches(Some("other"), root, &[]));
}

#[test]
fn deeplink_http_url_encodes_the_scheme_url() {
    assert_eq!(
        deeplink_http_url("http://localhost:16667", "obsidian://open?vault=b&file=A B"),
        "http://localhost:16667/deeplink?url=obsidian%3A%2F%2Fopen%3Fvault%3Db%26file%3DA%20B"
    );
}

use clepsydra::deeplink::resolve_target;
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;

/// Seed a vault with three pages and return an open, built index.
/// - `projects/20260531.alpha.aB3dE9xZ.md` (title "Alpha Project")
/// - `20260601.beta.Zz9Yy8Xx.md`           (title "Beta")
/// - `dupe/20260601.beta2.Qq7Ww6Ee.md`     (title "Beta") — makes "beta" ambiguous
fn seeded_index() -> (tempfile::TempDir, VaultIndex) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    std::fs::create_dir_all(root.join("projects")).unwrap();
    std::fs::create_dir_all(root.join("dupe")).unwrap();
    std::fs::write(
        root.join("projects/20260531.alpha.aB3dE9xZ.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntitle: Alpha Project\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
    std::fs::write(
        root.join("20260601.beta.Zz9Yy8Xx.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a2\ntitle: Beta\ncreated_at: 2026-06-01T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
    std::fs::write(
        root.join("dupe/20260601.beta2.Qq7Ww6Ee.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000a3\ntitle: Beta\ncreated_at: 2026-06-01T13:00:00Z\n---\nbody\n",
    )
    .unwrap();
    let vault = Vault::open(&root).unwrap();
    let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    (tmp, index)
}

#[test]
fn resolves_exact_path() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(
        index.connection(),
        "projects/20260531.alpha.aB3dE9xZ.md",
        "projects/20260531.alpha.aB3dE9xZ.md",
    )
    .unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn resolves_path_without_md_extension() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(
        index.connection(),
        "projects/20260531.alpha.aB3dE9xZ",
        "projects/20260531.alpha.aB3dE9xZ",
    )
    .unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn resolves_unique_canonical_name_case_insensitively() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "alpha%20project", "Alpha Project").unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn ambiguous_canonical_name_is_a_miss() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "Beta", "Beta").unwrap();
    assert_eq!(hit, None);
}

#[test]
fn resolves_shortid() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "aB3dE9xZ", "aB3dE9xZ").unwrap();
    assert_eq!(hit.as_deref(), Some("projects/20260531.alpha.aB3dE9xZ.md"));
}

#[test]
fn unknown_target_is_a_miss() {
    let (_tmp, index) = seeded_index();
    let hit = resolve_target(index.connection(), "no-such-page", "no-such-page").unwrap();
    assert_eq!(hit, None);
}

#[test]
fn shortid_match_is_case_sensitive() {
    // Two pages whose shortids differ only by case. SQLite's default LIKE is
    // ASCII case-insensitive, so without an exact-case filter the query for
    // either shortid would see both pages.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    std::fs::write(
        root.join("20260531.alpha.aB3dE9xZ.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000b1\ntitle: Alpha\ncreated_at: 2026-05-31T12:00:00Z\n---\nbody\n",
    )
    .unwrap();
    std::fs::write(
        root.join("20260531.alpha-twin.Ab3De9xZ.md"),
        "---\nid: 0190f8a0-0000-7000-8000-0000000000b2\ntitle: Alpha Twin\ncreated_at: 2026-05-31T13:00:00Z\n---\nbody\n",
    )
    .unwrap();
    let vault = Vault::open(&root).unwrap();
    let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // (a) The exact-case shortid resolves its own page only.
    let hit = resolve_target(index.connection(), "aB3dE9xZ", "aB3dE9xZ").unwrap();
    assert_eq!(hit.as_deref(), Some("20260531.alpha.aB3dE9xZ.md"));

    // (b) A case variant that matches no page exactly is a miss.
    let hit = resolve_target(index.connection(), "AB3DE9XZ", "AB3DE9XZ").unwrap();
    assert_eq!(hit, None);
}
