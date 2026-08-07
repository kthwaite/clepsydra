use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::link::{LinkKind, extract_links};
use tempfile::TempDir;

fn setup_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel_path, content) in files {
        fs::write(root.join(rel_path), content).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}

#[test]
fn extract_wikilink() {
    let body = "See [[Design Notes]] for details.";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Design Notes");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn extract_wikilink_with_display() {
    let body = "See [[Design Notes|my notes]]";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "Design Notes");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn extract_markdown_link() {
    let body = "See [notes](design.md)";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "design.md");
    assert_eq!(links[0].kind, LinkKind::Markdown);
}

#[test]
fn skip_links_in_fenced_code() {
    let body = "```\n[[not a link]]\n```";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "wikilinks inside fenced code blocks must be ignored"
    );
}

#[test]
fn skip_links_in_inline_code() {
    let body = "`[[not a link]]`";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "wikilinks inside inline code must be ignored"
    );
}

#[test]
fn multiple_links_in_paragraph() {
    let body = "[[A]] and [[B]] also [C](c.md)";
    let links = extract_links(body);
    assert_eq!(links.len(), 3);

    let wiki_links: Vec<_> = links.iter().filter(|l| l.kind == LinkKind::Wiki).collect();
    let md_links: Vec<_> = links
        .iter()
        .filter(|l| l.kind == LinkKind::Markdown)
        .collect();
    assert_eq!(wiki_links.len(), 2);
    assert_eq!(md_links.len(), 1);

    let targets: Vec<&str> = links.iter().map(|l| l.target_raw.as_str()).collect();
    assert!(targets.contains(&"A"));
    assert!(targets.contains(&"B"));
    assert!(targets.contains(&"c.md"));
}

#[test]
fn wikilink_with_path() {
    let body = "[[projects/design notes]]";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "projects/design notes");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn skip_links_in_indented_code() {
    // Four-space indent creates an indented code block (needs a preceding blank line).
    let body = "paragraph\n\n    [[link]]\n";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "wikilinks inside indented code blocks must be ignored"
    );
}

#[test]
fn external_url_ignored() {
    let body = "[Google](https://google.com)";
    let links = extract_links(body);
    assert_eq!(links.len(), 0, "external URLs must be skipped");
}

#[test]
fn links_in_blockquote() {
    let body = "> [[quoted link]]";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "quoted link");
    assert_eq!(links[0].kind, LinkKind::Wiki);
}

#[test]
fn extract_block_ref() {
    let body = "See ((abc123DEF0a)) for details.";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "abc123DEF0a");
    assert_eq!(links[0].kind, LinkKind::BlockRef);
    assert_eq!(links[0].span.start, 4);
    assert_eq!(links[0].span.end, 19);
}

#[test]
fn extract_block_ref_10_char() {
    let body = "((abcDEF1234))";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "abcDEF1234");
    assert_eq!(links[0].kind, LinkKind::BlockRef);
}

#[test]
fn extract_block_ref_12_char() {
    let body = "((abcDEF12345X))";
    let links = extract_links(body);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target_raw, "abcDEF12345X");
    assert_eq!(links[0].kind, LinkKind::BlockRef);
}

#[test]
fn skip_block_ref_in_code_block() {
    let body = "```\n((abc123DEF0a))\n```";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "block refs inside fenced code blocks must be ignored"
    );
}

#[test]
fn skip_block_ref_in_inline_code() {
    let body = "`((abc123DEF0a))`";
    let links = extract_links(body);
    assert_eq!(
        links.len(),
        0,
        "block refs inside inline code must be ignored"
    );
}

#[test]
fn block_ref_and_wikilink_in_same_paragraph() {
    let body = "[[Page A]] mentions ((abc123DEF0a))";
    let links = extract_links(body);
    assert_eq!(links.len(), 2);
    let wiki = links.iter().find(|l| l.kind == LinkKind::Wiki).unwrap();
    let bref = links.iter().find(|l| l.kind == LinkKind::BlockRef).unwrap();
    assert_eq!(wiki.target_raw, "Page A");
    assert_eq!(bref.target_raw, "abc123DEF0a");
}

#[test]
fn encrypted_page_emits_no_body_links_while_plain_inbound_link_resolves() {
    let protected = "+++\nid = \"019fd000-0000-7000-8000-000000000031\"\ntitle = \"Private note\"\nencryption = { format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }\n+++\n[[Leaked target]] must not become an outgoing link\n";
    let source = "+++\nid = \"019fd000-0000-7000-8000-000000000032\"\ntitle = \"Public source\"\n+++\nSee [[Private note]].\n";
    let (_tmp, vault) = setup_vault(&[("private.md", protected), ("source.md", source)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let protected_outgoing: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE source_id = '019fd000-0000-7000-8000-000000000031'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(protected_outgoing, 0);

    let inbound_target: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '019fd000-0000-7000-8000-000000000032'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        inbound_target.as_deref(),
        Some("019fd000-0000-7000-8000-000000000031")
    );
}
