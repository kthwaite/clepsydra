use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::{IndexError, UnresolvedReason, VaultIndex};
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::index_policy::{IndexMutation, IndexPolicyError, IndexPolicyOperation};
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

    let result = handle.with_index(|_index, _vault| 42).await.unwrap();

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

    let task1 = tokio::spawn(async move { h1.search("shared".into(), 10).await.unwrap() });

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

// ---------------------------------------------------------------------------
// Intent-level mutation policies
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mutation_policy_created_resolves_outgoing_and_existing_inbound_links() {
    let source = r#"---
id: 00000000-0000-0000-0000-000000000201
title: Source
---
See [[Created]].
"#;
    let destination = r#"---
id: 00000000-0000-0000-0000-000000000202
title: Destination
---
Existing destination.
"#;
    let (_tmp, vault) = setup_vault(&[("source.md", source), ("destination.md", destination)]);
    let handle = build_handle(&vault);
    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    let created = r#"---
id: 00000000-0000-0000-0000-000000000203
title: Created
---
New page links to [[Destination]].
"#;
    fs::write(vault.root().join("created.md"), created).unwrap();

    handle
        .apply_mutation(
            VaultPath::new("created.md").unwrap(),
            IndexMutation::Created,
        )
        .await
        .unwrap();

    let inbound = handle
        .reverse_deps(VaultPath::new("created.md").unwrap())
        .await
        .unwrap();
    assert_eq!(
        inbound.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["source.md"]
    );

    let destination_inbound = handle
        .reverse_deps(VaultPath::new("destination.md").unwrap())
        .await
        .unwrap();
    assert_eq!(
        destination_inbound
            .iter()
            .map(VaultPath::as_str)
            .collect::<Vec<_>>(),
        vec!["created.md"]
    );

    let unresolved = handle
        .with_index(|index, _vault| index.unresolved_with_candidates())
        .await
        .unwrap()
        .unwrap();
    assert!(unresolved.iter().all(|link| link.target_raw != "Created"));
}

#[tokio::test]
async fn mutation_policy_content_changed_rebuilds_outgoing_and_reverse_dependencies() {
    let target = r#"---
id: 00000000-0000-0000-0000-000000000204
title: Old Name
---
Old content links to [[Old Destination]].
"#;
    let old_source = r#"---
id: 00000000-0000-0000-0000-000000000205
title: Old Source
---
See [[Old Name]].
"#;
    let new_source = r#"---
id: 00000000-0000-0000-0000-000000000206
title: New Source
---
See [[New Name]].
"#;
    let destination = r#"---
id: 00000000-0000-0000-0000-000000000207
title: Destination
---
Destination content.
"#;
    let old_destination = r#"---
id: 00000000-0000-0000-0000-000000000215
title: Old Destination
---
Old destination content.
"#;
    let (_tmp, vault) = setup_vault(&[
        ("target.md", target),
        ("old-source.md", old_source),
        ("new-source.md", new_source),
        ("destination.md", destination),
        ("old-destination.md", old_destination),
    ]);
    let handle = build_handle(&vault);
    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    let changed_target = r#"---
id: 00000000-0000-0000-0000-000000000217
title: New Name
---
Changed page now links to [[Destination]].
"#;
    fs::write(vault.root().join("target.md"), changed_target).unwrap();

    handle
        .apply_mutation(
            VaultPath::new("target.md").unwrap(),
            IndexMutation::ContentChanged,
        )
        .await
        .unwrap();

    let stale_identity_rows: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT
                        (SELECT COUNT(*) FROM pages WHERE id = ?1) +
                        (SELECT COUNT(*) FROM pages_fts WHERE page_id = ?1) +
                        (SELECT COUNT(*) FROM canonical_names WHERE page_id = ?1) +
                        (SELECT COUNT(*) FROM links WHERE source_id = ?1) +
                        (SELECT COUNT(*) FROM tags WHERE page_id = ?1) +
                        (SELECT COUNT(*) FROM blocks WHERE page_id = ?1)",
                    ["00000000-0000-0000-0000-000000000204"],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .await
        .unwrap();
    assert_eq!(
        stale_identity_rows, 0,
        "same-path identity replacement must remove the old page, FTS, and derived rows"
    );

    let inbound = handle
        .reverse_deps(VaultPath::new("target.md").unwrap())
        .await
        .unwrap();
    assert_eq!(
        inbound.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["new-source.md"]
    );

    let destination_inbound = handle
        .reverse_deps(VaultPath::new("destination.md").unwrap())
        .await
        .unwrap();
    assert_eq!(
        destination_inbound
            .iter()
            .map(VaultPath::as_str)
            .collect::<Vec<_>>(),
        vec!["target.md"]
    );
    assert!(
        handle
            .reverse_deps(VaultPath::new("old-destination.md").unwrap())
            .await
            .unwrap()
            .is_empty(),
        "outgoing links removed by the content change must not remain indexed"
    );

    let unresolved = handle
        .with_index(|index, _vault| index.unresolved_with_candidates())
        .await
        .unwrap()
        .unwrap();
    let stale_link = unresolved
        .iter()
        .find(|link| link.source_path == "old-source.md" && link.target_raw == "Old Name")
        .expect("the removed canonical name should leave the old link unresolved");
    assert_eq!(stale_link.reason, UnresolvedReason::NoMatch);
}

#[tokio::test]
async fn mutation_policy_moved_preserves_links_and_removes_the_stale_path() {
    let target = r#"---
id: 00000000-0000-0000-0000-000000000208
title: Movable
---
Moved page links to [[Destination]].
"#;
    let title_source = r#"---
id: 00000000-0000-0000-0000-000000000209
title: Title Source
---
See [[Movable]].
"#;
    let old_path_source = r#"---
id: 00000000-0000-0000-0000-000000000210
title: Old Path Source
---
See [[notes/old]].
"#;
    let destination = r#"---
id: 00000000-0000-0000-0000-000000000211
title: Destination
---
Destination content.
"#;
    let (_tmp, vault) = setup_vault(&[
        ("notes/old.md", target),
        ("title-source.md", title_source),
        ("old-path-source.md", old_path_source),
        ("destination.md", destination),
    ]);
    let handle = build_handle(&vault);
    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    fs::rename(
        vault.root().join("notes/old.md"),
        vault.root().join("notes/new.md"),
    )
    .unwrap();
    let moved_with_repaired_id = target.replace(
        "00000000-0000-0000-0000-000000000208",
        "00000000-0000-0000-0000-000000000216",
    );
    fs::write(vault.root().join("notes/new.md"), moved_with_repaired_id).unwrap();
    handle
        .apply_mutation(
            VaultPath::new("notes/new.md").unwrap(),
            IndexMutation::Moved {
                old_path: VaultPath::new("notes/old.md").unwrap(),
            },
        )
        .await
        .unwrap();

    let search = handle.search("Movable".into(), 10).await.unwrap();
    assert!(search.iter().any(|result| result.path == "notes/new.md"));
    assert!(search.iter().all(|result| result.path != "notes/old.md"));

    let inbound = handle
        .reverse_deps(VaultPath::new("notes/new.md").unwrap())
        .await
        .unwrap();
    assert_eq!(
        inbound.iter().map(VaultPath::as_str).collect::<Vec<_>>(),
        vec!["title-source.md"]
    );

    let destination_inbound = handle
        .reverse_deps(VaultPath::new("destination.md").unwrap())
        .await
        .unwrap();
    assert_eq!(
        destination_inbound
            .iter()
            .map(VaultPath::as_str)
            .collect::<Vec<_>>(),
        vec!["notes/new.md"]
    );

    let unresolved = handle
        .with_index(|index, _vault| index.unresolved_with_candidates())
        .await
        .unwrap()
        .unwrap();
    let stale_link = unresolved
        .iter()
        .find(|link| link.source_path == "old-path-source.md" && link.target_raw == "notes/old")
        .expect("the old path link should be unresolved after the move");
    assert_eq!(stale_link.reason, UnresolvedReason::NoMatch);
}

#[tokio::test]
async fn mutation_policy_deleted_invalidates_inbound_and_removes_outgoing_links() {
    let target = r#"---
id: 00000000-0000-0000-0000-000000000212
title: Disposable
---
Deleted page links to [[Destination]].
"#;
    let source = r#"---
id: 00000000-0000-0000-0000-000000000213
title: Source
---
See [[Disposable]].
"#;
    let destination = r#"---
id: 00000000-0000-0000-0000-000000000214
title: Destination
---
Destination content.
"#;
    let (_tmp, vault) = setup_vault(&[
        ("disposable.md", target),
        ("source.md", source),
        ("destination.md", destination),
    ]);
    let handle = build_handle(&vault);
    handle.build().await.unwrap();
    handle.resolve_links().await.unwrap();

    fs::remove_file(vault.root().join("disposable.md")).unwrap();
    handle
        .apply_mutation(
            VaultPath::new("disposable.md").unwrap(),
            IndexMutation::Deleted,
        )
        .await
        .unwrap();

    let search = handle.search("Disposable".into(), 10).await.unwrap();
    assert!(
        search.iter().all(|result| result.path != "disposable.md"),
        "the deleted page must be removed from full-text search"
    );
    assert!(
        handle
            .reverse_deps(VaultPath::new("destination.md").unwrap())
            .await
            .unwrap()
            .is_empty(),
        "outgoing links from the deleted page must be removed"
    );

    let unresolved = handle
        .with_index(|index, _vault| index.unresolved_with_candidates())
        .await
        .unwrap()
        .unwrap();
    let invalidated = unresolved
        .iter()
        .find(|link| link.source_path == "source.md" && link.target_raw == "Disposable")
        .expect("the inbound link should remain as an unresolved link");
    assert_eq!(invalidated.reason, UnresolvedReason::NoMatch);

    let stale_target_path_count: i64 = handle
        .with_index(|index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE target_path = 'disposable.md'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        })
        .await
        .unwrap();
    assert_eq!(stale_target_path_count, 0);
}

#[tokio::test]
async fn mutation_policy_preserves_typed_operation_errors() {
    let (_tmp, vault) = setup_vault(&[]);
    let handle = build_handle(&vault);
    let missing_path = VaultPath::new("missing.md").unwrap();

    let error = handle
        .apply_mutation(missing_path.clone(), IndexMutation::Created)
        .await
        .unwrap_err();

    match error {
        IndexPolicyError::Operation {
            operation,
            path,
            source: IndexError::Io(source),
        } => {
            assert_eq!(operation, IndexPolicyOperation::IndexPage);
            assert_eq!(path, missing_path);
            assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
        }
        other => panic!("expected a typed index-page I/O error, got {other:?}"),
    }
}

#[tokio::test]
async fn mutation_policy_propagates_index_query_decode_failures() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000218
title: Corrupted Hash
---
Content.
"#;
    let (_tmp, vault) = setup_vault(&[("corrupted.md", page)]);
    let handle = build_handle(&vault);
    handle.build().await.unwrap();
    handle
        .with_index(|index, _vault| {
            index
                .connection()
                .execute(
                    "UPDATE pages SET content_hash = x'00' WHERE path = 'corrupted.md'",
                    [],
                )
                .unwrap();
        })
        .await
        .unwrap();

    let path = VaultPath::new("corrupted.md").unwrap();
    let error = handle
        .apply_mutation(path.clone(), IndexMutation::Created)
        .await
        .unwrap_err();

    match error {
        IndexPolicyError::Operation {
            operation,
            path: error_path,
            source: IndexError::Sqlite(rusqlite::Error::InvalidColumnType(..)),
        } => {
            assert_eq!(operation, IndexPolicyOperation::IndexPage);
            assert_eq!(error_path, path);
        }
        other => panic!("expected a typed SQLite decoding error, got {other:?}"),
    }
}

#[tokio::test]
async fn scrub_runs_on_index_thread_after_protection_reindex() {
    const MARKER: &str = "HANDLE_SCRUB_SECRET_019FDD0F15DB72A2";
    let plaintext = format!(
        r#"---
id: 00000000-0000-0000-0000-000000000302
title: Serialized Scrub
---
{MARKER}
"#,
    );
    let (_tmp, vault) = setup_vault(&[("private.md", &plaintext)]);
    let handle = build_handle(&vault);
    handle.build().await.unwrap();

    fs::write(
        vault.root().join("private.md"),
        format!(
            r#"+++
id = "00000000-0000-0000-0000-000000000302"
title = "Serialized Scrub"
encryption = {{ format = "age", version = 1, key_id = "019fd000-0000-7000-8000-000000000002" }}
+++
{}"#,
            include_str!("support/fixtures/private-note.age")
        ),
    )
    .unwrap();

    handle
        .index_page(VaultPath::new("private.md").unwrap())
        .await
        .unwrap();
    handle.scrub_deleted_content().await.unwrap();

    let (encrypted, search_hits): (i64, i64) = handle
        .with_index(|index, _vault| {
            let encrypted = index
                .connection()
                .query_row(
                    "SELECT encrypted FROM pages WHERE path = 'private.md'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let search_hits = index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH ?1",
                    [MARKER],
                    |row| row.get(0),
                )
                .unwrap();
            (encrypted, search_hits)
        })
        .await
        .unwrap();
    assert_eq!(encrypted, 1);
    assert_eq!(search_hits, 0);
}
