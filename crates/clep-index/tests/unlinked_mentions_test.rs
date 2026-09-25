use std::fs;

use clep_index::index::{UnlinkedMention, VaultIndex};
use clep_index::index_handle::IndexHandle;
use clep_vault::Vault;
use clep_vault::init::init_vault;
use clep_vault::path::VaultPath;
use tempfile::TempDir;

fn setup_vault(files: &[(&str, &str)]) -> (TempDir, Vault) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();
    for (rel_path, content) in files {
        let abs = root.join(rel_path);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&abs, content).unwrap();
    }
    let vault = Vault::open(&root).unwrap();
    (tmp, vault)
}

async fn built(files: &[(&str, &str)]) -> (TempDir, IndexHandle) {
    let (tmp, vault) = setup_vault(files);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let handle = IndexHandle::spawn(VaultIndex::open(&db_path).unwrap(), vault);
    handle.build().await.unwrap();
    (tmp, handle)
}

fn page(id: u32, title: &str, body: &str) -> String {
    format!("---\nid: 00000000-0000-0000-0000-{id:012}\ntitle: {title}\n---\n{body}\n")
}

const ALPHA: &str = "---
id: 00000000-0000-0000-0000-000000000001
title: Alpha
aliases: [First Letter, AB]
---
The alpha page.
";

async fn mentions(handle: &IndexHandle, path: &str) -> Vec<UnlinkedMention> {
    handle
        .unlinked_mentions(VaultPath::new(path).unwrap(), 50)
        .await
        .unwrap()
}

fn sources(found: &[UnlinkedMention]) -> Vec<&str> {
    found.iter().map(|m| m.source_path.as_str()).collect()
}

#[tokio::test]
async fn finds_a_title_mention_case_insensitively() {
    let beta = page(2, "Beta", "We talked about alpha at length.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;

    let found = mentions(&handle, "alpha.md").await;

    assert_eq!(sources(&found), vec!["beta.md"]);
    assert_eq!(found[0].matched, "alpha");
    assert_eq!(found[0].source_title.as_deref(), Some("Beta"));
    assert!(
        found[0].context.contains("about alpha at"),
        "{}",
        found[0].context
    );
}

#[tokio::test]
async fn finds_an_alias_mention() {
    let beta = page(2, "Beta", "The first letter of the alphabet matters.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;

    let found = mentions(&handle, "alpha.md").await;

    assert_eq!(sources(&found), vec!["beta.md"]);
    assert_eq!(found[0].matched, "first letter");
}

#[tokio::test]
async fn excludes_pages_that_already_link() {
    let plain = page(2, "Plain", "See [[Alpha]] and alpha.");
    let aliased = page(3, "Aliased", "See [[Alpha|the first]] and alpha.");
    let by_path = page(4, "ByPath", "See [link](alpha.md) and alpha.");
    let (_tmp, handle) = built(&[
        ("alpha.md", ALPHA),
        ("plain.md", &plain),
        ("aliased.md", &aliased),
        ("by-path.md", &by_path),
    ])
    .await;

    assert!(mentions(&handle, "alpha.md").await.is_empty());
}

#[tokio::test]
async fn excludes_the_page_itself() {
    let (_tmp, handle) = built(&[("alpha.md", ALPHA)]).await;
    assert!(mentions(&handle, "alpha.md").await.is_empty());
}

#[tokio::test]
async fn requires_whole_words() {
    let stem = page(2, "Stem", "Several alphas and the alphabet.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("stem.md", &stem)]).await;
    assert!(mentions(&handle, "alpha.md").await.is_empty());
}

#[tokio::test]
async fn matches_beside_punctuation() {
    let beta = page(2, "Beta", "Compare (Alpha), then move on.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;
    assert_eq!(
        sources(&mentions(&handle, "alpha.md").await),
        vec!["beta.md"]
    );
}

#[tokio::test]
async fn ignores_terms_shorter_than_three_characters() {
    // "AB" is an alias of Alpha but too short to search for.
    let beta = page(2, "Beta", "The AB test.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;
    assert!(mentions(&handle, "alpha.md").await.is_empty());
}

#[tokio::test]
async fn ignores_mentions_inside_other_wikilinks() {
    let beta = page(2, "Beta", "See [[Alpha Centauri]] tonight.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;
    assert!(mentions(&handle, "alpha.md").await.is_empty());
}

#[tokio::test]
async fn excludes_encrypted_sources() {
    let beta = page(2, "Beta", "About alpha.");
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;
    handle
        .with_index(|index, _vault| {
            index
                .connection()
                .execute("UPDATE pages SET encrypted = 1 WHERE path = 'beta.md'", [])
                .unwrap()
        })
        .await
        .unwrap();
    assert!(mentions(&handle, "alpha.md").await.is_empty());
}

#[tokio::test]
async fn returns_nothing_for_an_unknown_page() {
    let (_tmp, handle) = built(&[("alpha.md", ALPHA)]).await;
    assert!(mentions(&handle, "missing.md").await.is_empty());
}

#[tokio::test]
async fn falls_back_to_the_file_stem_without_a_title() {
    let untitled = "---\nid: 00000000-0000-0000-0000-000000000009\n---\nNo title here.\n";
    let beta = page(2, "Beta", "The orrery sits on the desk.");
    let (_tmp, handle) = built(&[("orrery.md", untitled), ("beta.md", &beta)]).await;
    assert_eq!(
        sources(&mentions(&handle, "orrery.md").await),
        vec!["beta.md"]
    );
}

#[tokio::test]
async fn orders_by_title_and_respects_the_limit() {
    let zeta = page(2, "Zeta", "alpha");
    let eta = page(3, "Eta", "alpha");
    let theta = page(4, "Theta", "alpha");
    let (_tmp, handle) = built(&[
        ("alpha.md", ALPHA),
        ("zeta.md", &zeta),
        ("eta.md", &eta),
        ("theta.md", &theta),
    ])
    .await;

    let all = mentions(&handle, "alpha.md").await;
    assert_eq!(sources(&all), vec!["eta.md", "theta.md", "zeta.md"]);

    let two = handle
        .unlinked_mentions(VaultPath::new("alpha.md").unwrap(), 2)
        .await
        .unwrap();
    assert_eq!(sources(&two), vec!["eta.md", "theta.md"]);
}

#[tokio::test]
async fn cuts_the_context_on_character_boundaries() {
    let long = format!("{} alpha {}", "é".repeat(200), "ü".repeat(200));
    let beta = page(2, "Beta", &long);
    let (_tmp, handle) = built(&[("alpha.md", ALPHA), ("beta.md", &beta)]).await;

    let found = mentions(&handle, "alpha.md").await;

    assert_eq!(found.len(), 1);
    let context = &found[0].context;
    assert!(context.contains("alpha"));
    assert!(
        context.starts_with('…') && context.ends_with('…'),
        "{context}"
    );
    assert!(
        context.chars().count() <= 170,
        "{}",
        context.chars().count()
    );
}
