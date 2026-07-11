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
