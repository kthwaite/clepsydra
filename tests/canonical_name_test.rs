use clepsydra::vault::canonical::CanonicalName;

#[test]
fn from_title_lowercases() {
    let cn = CanonicalName::from_title("Design Notes");
    assert_eq!(cn.as_str(), "design notes");
}

#[test]
fn from_title_collapses_whitespace() {
    let cn = CanonicalName::from_title("A   B");
    assert_eq!(cn.as_str(), "a b");
}

#[test]
fn from_title_trims() {
    let cn = CanonicalName::from_title("  hello  ");
    assert_eq!(cn.as_str(), "hello");
}

#[test]
fn from_title_nfc_normalizes() {
    // NFD: e + combining acute accent (U+0065 U+0301)
    let nfd_input = "caf\u{0065}\u{0301}";
    let cn = CanonicalName::from_title(nfd_input);
    // NFC: precomposed e-acute (U+00E9)
    assert_eq!(cn.as_str(), "caf\u{00E9}");
}

#[test]
fn from_filename_strips_md() {
    let cn = CanonicalName::from_filename("design-notes.md");
    assert_eq!(cn.as_str(), "design-notes");
}

#[test]
fn from_filename_no_extension() {
    let cn = CanonicalName::from_filename("readme");
    assert_eq!(cn.as_str(), "readme");
}

#[test]
fn equality_case_insensitive() {
    let a = CanonicalName::from_title("Design Notes");
    let b = CanonicalName::from_title("design notes");
    assert_eq!(a, b);
}

// --- Edge collision tests from spec ---

#[test]
fn whitespace_collapse_collision() {
    let a = CanonicalName::from_title("A  B");
    let b = CanonicalName::from_title("A B");
    assert_eq!(a, b, "whitespace collapse should make these identical");
}

#[test]
fn case_and_hyphens_distinct() {
    let from_file = CanonicalName::from_filename("design-notes");
    let from_title = CanonicalName::from_title("Design Notes");
    assert_ne!(
        from_file, from_title,
        "hyphens are preserved, not converted to spaces"
    );
}

#[test]
fn trailing_dots_preserved() {
    let cn = CanonicalName::from_title("hello...");
    assert_eq!(cn.as_str(), "hello...");
}
