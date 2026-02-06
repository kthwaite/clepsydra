use std::path::PathBuf;

use clepsydra::vault::rewriter::{
    DELETE_PLAIN, DELETE_UNLINK, apply_staged_writes, rewrite_links_in_content,
};

// ---------------------------------------------------------------------------
// rewrite_links_in_content tests
// ---------------------------------------------------------------------------

#[test]
fn rewrite_wikilink() {
    let content = "See [[Old Page]] for details.";
    let result = rewrite_links_in_content(content, &[("Old Page", "New Page")]);
    assert_eq!(result, "See [[New Page]] for details.");
}

#[test]
fn rewrite_wikilink_with_display_text() {
    let content = "See [[Old Page|my notes]] for details.";
    let result = rewrite_links_in_content(content, &[("Old Page", "New Page")]);
    assert_eq!(result, "See [[New Page|my notes]] for details.");
}

#[test]
fn rewrite_markdown_link() {
    let content = "See [notes](old.md) for details.";
    let result = rewrite_links_in_content(content, &[("old.md", "new.md")]);
    assert_eq!(result, "See [notes](new.md) for details.");
}

#[test]
fn rewrite_multiple_links() {
    let content = "[[Alpha]] and [[Beta]] and [gamma](gamma.md)";
    let result = rewrite_links_in_content(
        content,
        &[("Alpha", "A"), ("Beta", "B"), ("gamma.md", "g.md")],
    );
    assert_eq!(result, "[[A]] and [[B]] and [gamma](g.md)");
}

#[test]
fn skip_links_in_code_blocks() {
    let content = "```\n[[Old Page]]\n```\n\nOutside `[[Old Page]]` too.\n\n[[Old Page]]";
    let result = rewrite_links_in_content(content, &[("Old Page", "New Page")]);
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
    let result = rewrite_links_in_content(content, &[("Doomed Page", &new_target)]);
    assert_eq!(result, "See Doomed Page for info.");
}

#[test]
fn delete_rewrite_unlink() {
    let content = "See [[Doomed Page]] for info.";
    let new_target = format!("{DELETE_UNLINK}Doomed Page");
    let result = rewrite_links_in_content(content, &[("Doomed Page", &new_target)]);
    assert_eq!(result, "See ~~Doomed Page~~ for info.");
}

// ---------------------------------------------------------------------------
// apply_staged_writes test
// ---------------------------------------------------------------------------

#[test]
fn staged_writes_atomic_success() {
    let dir = tempfile::tempdir().unwrap();

    let file_a = dir.path().join("a.md");
    let file_b = dir.path().join("b.md");

    // Create initial content
    std::fs::write(&file_a, "original A").unwrap();
    std::fs::write(&file_b, "original B").unwrap();

    let writes: Vec<(PathBuf, String)> = vec![
        (file_a.clone(), "updated A".to_string()),
        (file_b.clone(), "updated B".to_string()),
    ];

    apply_staged_writes(&writes).unwrap();

    // Verify both updated
    assert_eq!(std::fs::read_to_string(&file_a).unwrap(), "updated A");
    assert_eq!(std::fs::read_to_string(&file_b).unwrap(), "updated B");

    // Verify no tmp files remain
    let tmp_a = PathBuf::from(format!("{}.clepsydra-tmp", file_a.display()));
    let tmp_b = PathBuf::from(format!("{}.clepsydra-tmp", file_b.display()));
    assert!(!tmp_a.exists(), "tmp file for a.md should not remain");
    assert!(!tmp_b.exists(), "tmp file for b.md should not remain");
}
