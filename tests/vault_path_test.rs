use clepsydra::vault::Vault;
use clepsydra::vault::path::VaultPath;

// --- Construction tests ---

#[test]
fn valid_path_accepted() {
    let p = VaultPath::new("notes/hello.md").unwrap();
    assert_eq!(p.as_str(), "notes/hello.md");
}

#[test]
fn rejects_absolute_path() {
    let err = VaultPath::new("/etc/passwd").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("absolute"),
        "expected absolute error, got: {msg}"
    );
}

#[test]
fn rejects_traversal() {
    let err1 = VaultPath::new("../outside.md").unwrap_err();
    assert!(err1.to_string().contains("traversal"));

    let err2 = VaultPath::new("notes/../../etc/passwd").unwrap_err();
    assert!(err2.to_string().contains("traversal"));
}

#[test]
fn rejects_backslash() {
    let err = VaultPath::new("notes\\hello.md").unwrap_err();
    assert!(err.to_string().contains("backslash"));
}

#[test]
fn strips_leading_dot_slash() {
    let p = VaultPath::new("./notes/hello.md").unwrap();
    assert_eq!(p.as_str(), "notes/hello.md");
}

#[test]
fn normalizes_internal_dot_components() {
    let p = VaultPath::new("notes/./drafts/./hello.md").unwrap();
    assert_eq!(p.as_str(), "notes/drafts/hello.md");
}

#[test]
fn normalizes_duplicate_separators() {
    let p = VaultPath::new("notes//sub///hello.md").unwrap();
    assert_eq!(p.as_str(), "notes/sub/hello.md");
}

#[test]
fn rejects_dot_only_path_after_normalization() {
    let err = VaultPath::new("././").unwrap_err();
    assert!(err.to_string().contains("empty"));
}

#[test]
fn nfc_normalizes_path() {
    // NFD: e + combining acute accent (U+0065 U+0301)
    let nfd = "not\u{0065}\u{0301}s/hello.md";
    let p = VaultPath::new(nfd).unwrap();
    // NFC: precomposed e-acute (U+00E9)
    assert_eq!(p.as_str(), "not\u{00E9}s/hello.md");
}

#[test]
fn rejects_empty() {
    let err = VaultPath::new("").unwrap_err();
    assert!(err.to_string().contains("empty"));
}

// --- Method tests ---

#[test]
fn extension_method() {
    let p = VaultPath::new("notes/hello.md").unwrap();
    assert_eq!(p.extension(), Some("md"));
}

#[test]
fn stem_method() {
    let p = VaultPath::new("notes/hello.md").unwrap();
    assert_eq!(p.stem(), "hello");
}

#[test]
fn parent_method() {
    let p = VaultPath::new("notes/sub/hello.md").unwrap();
    assert_eq!(p.parent(), Some("notes/sub"));

    let root = VaultPath::new("hello.md").unwrap();
    assert_eq!(root.parent(), None);
}

// --- Slug generation tests ---

#[test]
fn from_title_basic() {
    let p = VaultPath::from_title("My Page");
    assert_eq!(p.as_str(), "My Page.md");
}

#[test]
fn from_title_encodes_slash() {
    let p = VaultPath::from_title("a/b");
    assert_eq!(p.as_str(), "a%2Fb.md");
}

#[test]
fn from_title_encodes_percent() {
    let p = VaultPath::from_title("100% done");
    assert_eq!(p.as_str(), "100%25 done.md");
}

#[test]
fn from_title_replaces_illegal() {
    let p = VaultPath::from_title("what: a <test>?");
    // `>?` are both illegal, become `--`, collapse to `-`, trailing `-` trimmed
    assert_eq!(p.as_str(), "what- a -test.md");
}

#[test]
fn from_title_collapses_dashes() {
    let p = VaultPath::from_title("a:::b");
    assert_eq!(p.as_str(), "a-b.md");
}

#[test]
fn decode_slug_roundtrip_slash() {
    let p = VaultPath::from_title("projects/clepsydra");
    assert_eq!(p.decode_slug(), "projects/clepsydra");
}

#[test]
fn decode_slug_roundtrip_percent() {
    let p = VaultPath::from_title("100% complete");
    assert_eq!(p.decode_slug(), "100% complete");
}

// --- Vault struct tests ---

#[test]
fn vault_resolve_produces_absolute_path() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    let vp = VaultPath::new("notes/hello.md").unwrap();
    let resolved = vault.resolve(&vp);
    assert!(resolved.is_absolute());
    assert!(resolved.ends_with("notes/hello.md"));
}

#[test]
fn vault_is_excluded_default() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();

    // .clepsydra/anything should be excluded with default config
    let vp = VaultPath::new(".clepsydra/config.toml").unwrap();
    assert!(vault.is_excluded(&vp));

    // _attachments/image.png should be excluded
    let vp2 = VaultPath::new("_attachments/image.png").unwrap();
    assert!(vault.is_excluded(&vp2));

    // .git/HEAD should be excluded
    let vp3 = VaultPath::new(".git/HEAD").unwrap();
    assert!(vault.is_excluded(&vp3));
}

#[test]
fn vault_is_excluded_custom_glob() {
    let dir = tempfile::tempdir().unwrap();

    // Write a custom config with an extra exclusion pattern
    let clepsydra_dir = dir.path().join(".clepsydra");
    std::fs::create_dir_all(&clepsydra_dir).unwrap();
    std::fs::write(
        clepsydra_dir.join("config.toml"),
        r#"
[vault]
excluded_patterns = ["drafts/**", ".git/**"]
"#,
    )
    .unwrap();

    let vault = Vault::open(dir.path()).unwrap();

    // "drafts/wip.md" should be excluded by custom pattern
    let vp = VaultPath::new("drafts/wip.md").unwrap();
    assert!(vault.is_excluded(&vp));

    // "notes/hello.md" should NOT be excluded (default .clepsydra/** is gone)
    let vp2 = VaultPath::new(".clepsydra/config.toml").unwrap();
    assert!(!vault.is_excluded(&vp2));
}

#[test]
fn vault_not_excluded_normal() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open(dir.path()).unwrap();

    let vp = VaultPath::new("notes/hello.md").unwrap();
    assert!(!vault.is_excluded(&vp));
}
