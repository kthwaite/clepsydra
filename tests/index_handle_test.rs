use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::path::VaultPath;
use clepsydra::vault::sync::ChangeEvent;
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

fn build_handle(vault: &Vault) -> IndexHandle {
    let db_path = vault.root().join(".clepsydra/cache.db");
    let index = VaultIndex::open(&db_path).unwrap();
    IndexHandle::spawn(index, vault.clone())
}

// ---------------------------------------------------------------------------
// with_index returns results correctly
// ---------------------------------------------------------------------------

#[tokio::test]
async fn with_index_returns_value() {
    let (_tmp, vault) = setup_vault(&[]);
    let handle = build_handle(&vault);

    let result = handle
        .with_index(|_index, _vault| 42)
        .await
        .unwrap();

    assert_eq!(result, 42);
}

#[tokio::test]
async fn with_index_can_query_index() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000100
title: Queried
---
Content here.
"#;
    let (_tmp, vault) = setup_vault(&[("queried.md", page)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();

    let count: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
                .unwrap()
        })
        .await
        .unwrap();

    assert_eq!(count, 1);
}

// ---------------------------------------------------------------------------
// build() works via convenience method
// ---------------------------------------------------------------------------

#[tokio::test]
async fn build_indexes_pages() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000101
title: Alpha
---
Hello from Alpha.
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000102
title: Beta
---
Hello from Beta.
"#;
    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let handle = build_handle(&vault);

    let stats = handle.build().await.unwrap();

    assert_eq!(stats.pages_indexed, 2);
    assert_eq!(stats.pages_skipped, 0);
}

#[tokio::test]
async fn build_then_resolve_links() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000103
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000104
title: Beta
---
Back to [[Alpha]].
"#;
    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    // Verify links are resolved
    let resolved_count: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE target_id IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .await
        .unwrap();

    assert_eq!(resolved_count, 2);
}

// ---------------------------------------------------------------------------
// search() returns FTS results
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_returns_results() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000105
title: Quantum Mechanics
---
The Schrodinger equation describes quantum mechanical systems.
"#;
    let (_tmp, vault) = setup_vault(&[("quantum.md", page)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();

    let results = handle.search("quantum".into(), 10).await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].path, "quantum.md");
    assert_eq!(results[0].title.as_deref(), Some("Quantum Mechanics"));
}

#[tokio::test]
async fn search_returns_empty_for_no_match() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000106
title: Simple
---
Nothing special here.
"#;
    let (_tmp, vault) = setup_vault(&[("simple.md", page)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();

    let results = handle.search("xyznonexistent".into(), 10).await.unwrap();

    assert!(results.is_empty());
}

// ---------------------------------------------------------------------------
// backlinks() finds linking pages
// ---------------------------------------------------------------------------

#[tokio::test]
async fn backlinks_finds_linking_pages() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000107
title: Target
---
I am the target page.
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000108
title: Source
---
See [[Target]] for details.
"#;
    let (_tmp, vault) = setup_vault(&[("target.md", page_a), ("source.md", page_b)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    let backlinks = handle
        .backlinks(VaultPath::new("target.md").unwrap(), 200)
        .await
        .unwrap();

    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_path, "source.md");
    assert_eq!(backlinks[0].target_raw, "Target");
}

// ---------------------------------------------------------------------------
// process_sync_events() works through the handle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn process_sync_events_indexes_new_file() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000109
title: Existing
---
Already here.
"#;
    let (_tmp, vault) = setup_vault(&[("existing.md", page_a)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();

    // Write a new file to disk
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000110
title: Newcomer
---
I just arrived.
"#;
    fs::write(vault.root().join("newcomer.md"), page_b).unwrap();

    let events = vec![ChangeEvent::Upsert(VaultPath::new("newcomer.md").unwrap())];
    let stats = handle.process_sync_events(events).await.unwrap();

    assert_eq!(stats.pages_indexed, 1);
}

// ---------------------------------------------------------------------------
// Handle is Clone + Send (can be sent to another tokio task)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn handle_is_clone_send() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000111
title: Shared
---
Accessible from multiple tasks.
"#;
    let (_tmp, vault) = setup_vault(&[("shared.md", page)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();

    let h1 = handle.clone();
    let h2 = handle.clone();

    let task1 = tokio::spawn(async move {
        h1.search("shared".into(), 10).await.unwrap()
    });

    let task2 = tokio::spawn(async move {
        h2.with_index(|index, _vault| {
            index
                .connection()
                .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get::<_, i64>(0))
                .unwrap()
        })
        .await
        .unwrap()
    });

    let results = task1.await.unwrap();
    let count = task2.await.unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(count, 1);
}

// ---------------------------------------------------------------------------
// Other convenience methods
// ---------------------------------------------------------------------------

#[tokio::test]
async fn index_page_and_remove_page() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000112
title: Ephemeral
---
Here today, gone tomorrow.
"#;
    let (_tmp, vault) = setup_vault(&[("ephemeral.md", page)]);
    let handle = build_handle(&vault);

    // index_page should succeed
    let indexed = handle
        .index_page(VaultPath::new("ephemeral.md").unwrap())
        .await
        .unwrap();
    assert!(indexed);

    // Second call skips (unchanged content)
    let skipped = handle
        .index_page(VaultPath::new("ephemeral.md").unwrap())
        .await
        .unwrap();
    assert!(!skipped);

    // remove_page should succeed
    let removed = handle
        .remove_page(VaultPath::new("ephemeral.md").unwrap())
        .await
        .unwrap();
    assert!(removed);

    // Second remove should return false
    let removed_again = handle
        .remove_page(VaultPath::new("ephemeral.md").unwrap())
        .await
        .unwrap();
    assert!(!removed_again);
}

#[tokio::test]
async fn reverse_deps_finds_dependents() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000113
title: Hub
---
Central page.
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000114
title: Spoke
---
Links to [[Hub]].
"#;
    let (_tmp, vault) = setup_vault(&[("hub.md", page_a), ("spoke.md", page_b)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    let deps = handle
        .reverse_deps(VaultPath::new("hub.md").unwrap())
        .await
        .unwrap();

    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0].as_str(), "spoke.md");
}

#[tokio::test]
async fn invalidate_links_to_clears_resolution() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000115
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000116
title: Beta
---
Content.
"#;
    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    // Verify link is resolved
    let resolved_before: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE target_id IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .await
        .unwrap();
    assert_eq!(resolved_before, 1);

    // Invalidate
    let invalidated = handle
        .invalidate_links_to(VaultPath::new("beta.md").unwrap())
        .await
        .unwrap();
    assert_eq!(invalidated, 1);

    // Verify link is now unresolved
    let resolved_after: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE target_id IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .await
        .unwrap();
    assert_eq!(resolved_after, 0);
}

#[tokio::test]
async fn resolve_links_for_page_resolves_outgoing() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000117
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000118
title: Beta
---
No links.
"#;
    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let handle = build_handle(&vault);

    handle.build().await.unwrap();
    // Don't call resolve_links() — use the per-page variant instead

    let resolved = handle
        .resolve_links_for_page(VaultPath::new("alpha.md").unwrap())
        .await
        .unwrap();

    assert_eq!(resolved, 1);
}
