use std::fs;
use std::sync::Arc;

use clepsydra::vault::Vault;
use clepsydra::vault::atomic_file::{
    AtomicPublicationError, atomic_create, atomic_replace, atomic_replace_with,
};
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{MutationOp, MutationPlan, MutationPlanner, RewriteMode};
use clepsydra::vault::mutation_coordinator::MutationCoordinator;
use clepsydra::vault::path::VaultPath;

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

// ---------------------------------------------------------------------------
// Task 1: Type existence tests
// ---------------------------------------------------------------------------

#[test]
fn mutation_plan_types_exist() {
    let _op = MutationOp::MovePage {
        source: "alpha.md".to_string(),
        destination: "beta.md".to_string(),
    };
    let _del = MutationOp::DeletePage {
        path: "alpha.md".to_string(),
        rewrite: RewriteMode::PlainText,
    };
    let _folder = MutationOp::MoveFolder {
        source: "notes".to_string(),
        destination: "archive".to_string(),
    };
    let plan = MutationPlan::empty();
    assert!(plan.file_ops.is_empty());
    assert!(plan.text_edits.is_empty());
    assert!(plan.index_events.is_empty());
    assert!(plan.staged_writes.is_empty());
}

#[test]
fn compute_relative_path_same_dir() {
    use clepsydra::vault::mutation::compute_relative_path;
    assert_eq!(compute_relative_path("notes/a.md", "notes/b.md"), "b.md");
}

#[test]
fn compute_relative_path_different_dir() {
    use clepsydra::vault::mutation::compute_relative_path;
    assert_eq!(
        compute_relative_path("notes/a.md", "archive/b.md"),
        "../archive/b.md"
    );
}

#[test]
fn compute_relative_path_root_to_subdir() {
    use clepsydra::vault::mutation::compute_relative_path;
    assert_eq!(compute_relative_path("a.md", "sub/b.md"), "sub/b.md");
}

#[test]
fn compute_relative_path_subdir_to_root() {
    use clepsydra::vault::mutation::compute_relative_path;
    assert_eq!(compute_relative_path("sub/a.md", "b.md"), "../b.md");
}

// ---------------------------------------------------------------------------
// Task 2: MutationPlanner page-move tests
// ---------------------------------------------------------------------------

#[test]
fn plan_page_move_computes_text_edits() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000100
title: Alpha
---
Link to [[Beta]].
";
    let page_b = "\
---
id: 00000000-0000-0000-0000-000000000101
title: Beta
---
Content.
";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/beta.md".to_string(),
        })
        .unwrap();

    // Should have 1 file op (rename beta.md -> archive/beta.md)
    assert_eq!(plan.file_ops.len(), 1);
    assert_eq!(plan.file_ops[0].path, "beta.md");
    assert_eq!(
        plan.file_ops[0].destination.as_deref(),
        Some("archive/beta.md")
    );

    // Should have index events
    assert!(!plan.index_events.is_empty());
}

#[test]
fn plan_page_move_no_edits_when_no_backlinks() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000102
title: Alpha
---
No links here.
";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "alpha.md".to_string(),
            destination: "archive/alpha.md".to_string(),
        })
        .unwrap();

    assert_eq!(plan.file_ops.len(), 1);
    assert!(plan.text_edits.is_empty());
    assert!(plan.staged_writes.is_empty());
}

#[test]
fn plan_page_move_rewrites_relative_markdown_links() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000200
title: Alpha
---
See [Beta](beta.md) for more.
";
    let page_b = "\
---
id: 00000000-0000-0000-0000-000000000201
title: Beta
---
Content.
";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/beta.md".to_string(),
        })
        .unwrap();

    // Should have text edits for alpha.md (per-replacement pairs)
    assert!(!plan.text_edits.is_empty());
    let alpha_edits: Vec<_> = plan
        .text_edits
        .iter()
        .filter(|e| e.path == "alpha.md")
        .collect();
    assert!(!alpha_edits.is_empty());
    // Should include the relative path replacement: "beta.md" -> "archive/beta.md"
    assert!(
        alpha_edits.iter().any(|e| e.new_text == "archive/beta.md"),
        "expected replacement to 'archive/beta.md', got: {:?}",
        alpha_edits
    );
}

#[test]
fn plan_page_move_same_stem_different_dir() {
    // Moving a page to a different directory without changing the filename stem.
    // The stem is "beta" in both cases, so stem-based wikilink rewrites are
    // skipped. However, the title "Beta" differs from the stem "beta", so
    // title-based wikilinks get rewritten to the new stem.
    // Markdown relative paths should also be updated.
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000300
title: Alpha
---
See [[beta]] and [Beta link](beta.md).
";
    let page_b = "\
---
id: 00000000-0000-0000-0000-000000000301
title: Beta
---
Content.
";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "sub/beta.md".to_string(),
        })
        .unwrap();

    // The markdown link should be rewritten; wikilink [[beta]] matches the
    // stem exactly so it stays unchanged (stem == "beta" in both source and dest).
    // Text edits are per-replacement pairs, so we check the specific replacement.
    assert!(!plan.text_edits.is_empty());
    let alpha_edits: Vec<_> = plan
        .text_edits
        .iter()
        .filter(|e| e.path == "alpha.md")
        .collect();
    // Should have a relative path replacement: "beta.md" -> "sub/beta.md"
    assert!(
        alpha_edits
            .iter()
            .any(|e| e.old_text == "beta.md" && e.new_text == "sub/beta.md"),
        "expected relative path replacement to 'sub/beta.md', got: {:?}",
        alpha_edits
    );
    // No stem replacement should exist (stem is the same: "beta" -> "beta")
    assert!(
        !alpha_edits
            .iter()
            .any(|e| e.old_text == "beta" && e.new_text != "beta"),
        "stem should not be rewritten when unchanged"
    );
}

#[test]
fn plan_page_move_index_events_include_source_and_dest() {
    let page_a = "\
---
id: 00000000-0000-0000-0000-000000000400
title: Alpha
---
Content.
";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "alpha.md".to_string(),
            destination: "archive/alpha.md".to_string(),
        })
        .unwrap();

    // Should have exactly 2 index events: Remove(source), Upsert(dest)
    assert_eq!(plan.index_events.len(), 2);
}

// ---------------------------------------------------------------------------
// Task 3: MutationPlanner page-delete tests
// ---------------------------------------------------------------------------

#[test]
fn plan_page_delete_with_rewrite() {
    let page_a =
        "---\nid: 00000000-0000-0000-0000-000000000103\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000104\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    // Should have 1 file op (delete beta.md)
    assert_eq!(plan.file_ops.len(), 1);
    assert_eq!(plan.file_ops[0].path, "beta.md");

    // Should have text edits for alpha.md
    assert!(!plan.text_edits.is_empty());
    let alpha_edits: Vec<_> = plan
        .text_edits
        .iter()
        .filter(|e| e.path == "alpha.md")
        .collect();
    assert!(!alpha_edits.is_empty());

    // Should have staged writes for alpha.md
    assert!(!plan.staged_writes.is_empty());

    // Should have index events (remove for beta.md, upsert for alpha.md)
    assert!(plan.index_events.len() >= 2);
}

#[test]
fn plan_page_delete_rewrite_none_no_text_edits() {
    let page_a =
        "---\nid: 00000000-0000-0000-0000-000000000105\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000106\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::None,
        })
        .unwrap();

    assert_eq!(plan.file_ops.len(), 1);
    assert!(plan.text_edits.is_empty());
    assert!(plan.staged_writes.is_empty());
}

// ---------------------------------------------------------------------------
// Task 5: MutationPlan::execute() tests
// ---------------------------------------------------------------------------

#[test]
fn execute_plan_moves_file_and_rewrites() {
    let page_a =
        "---\nid: 00000000-0000-0000-0000-000000000110\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000111\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/beta.md".to_string(),
        })
        .unwrap();

    plan.execute(&vault, &mut index, &[]).unwrap();

    // Verify file moved
    use clepsydra::vault::path::VaultPath;
    assert!(!vault.resolve(&VaultPath::new("beta.md").unwrap()).exists());
    assert!(
        vault
            .resolve(&VaultPath::new("archive/beta.md").unwrap())
            .exists()
    );

    // Verify index updated — archive/beta.md should be in the index
    let page_path: Option<String> = index
        .connection()
        .query_row(
            "SELECT path FROM pages WHERE id = '00000000-0000-0000-0000-000000000111'",
            [],
            |row| row.get(0),
        )
        .ok();
    assert_eq!(page_path.as_deref(), Some("archive/beta.md"));
}

#[test]
fn execute_plan_deletes_file_and_rewrites() {
    let page_a =
        "---\nid: 00000000-0000-0000-0000-000000000112\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000113\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    plan.execute(&vault, &mut index, &[]).unwrap();

    // Verify file deleted
    use clepsydra::vault::path::VaultPath;
    assert!(!vault.resolve(&VaultPath::new("beta.md").unwrap()).exists());

    // Verify alpha.md was rewritten — [[Beta]] should be plain text now
    let alpha_content =
        fs::read_to_string(vault.resolve(&VaultPath::new("alpha.md").unwrap())).unwrap();
    assert!(
        !alpha_content.contains("[[Beta]]"),
        "link should have been rewritten"
    );
    assert!(alpha_content.contains("Beta"), "plain text should remain");
}

// ---------------------------------------------------------------------------
// Task 4: MutationPlanner folder-move tests
// ---------------------------------------------------------------------------

#[test]
fn plan_folder_move_rewrites_all_contained_pages() {
    let page_a =
        "---\nid: 00000000-0000-0000-0000-000000000107\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000108\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("notes/beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MoveFolder {
            source: "notes".to_string(),
            destination: "archive".to_string(),
        })
        .unwrap();

    // Should have a rename file op for the folder
    assert!(
        plan.file_ops
            .iter()
            .any(|op| op.path == "notes" && op.destination.as_deref() == Some("archive")),
        "should plan folder rename"
    );

    // Should have index events for the moved file
    assert!(!plan.index_events.is_empty());
}

// ---------------------------------------------------------------------------
// Self-link and folder-internal backlink collision tests
// ---------------------------------------------------------------------------

#[test]
fn delete_page_with_self_link_does_not_recreate_file() {
    let (_tmp, vault) = setup_vault(&[(
        "selfie.md",
        "---\nid: 00000000-0000-0000-0000-000000000500\ntitle: Selfie\n---\nSee [[Selfie]] for more.",
    )]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::DeletePage {
            path: "selfie.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    plan.execute(&vault, &mut index, &[]).unwrap();

    let abs_path = vault.resolve(&VaultPath::new("selfie.md").unwrap());
    assert!(
        !abs_path.exists(),
        "deleted file should not be recreated by staged writes"
    );
}

#[test]
fn move_page_with_self_link_no_orphan_at_old_path() {
    let (_tmp, vault) = setup_vault(&[(
        "original.md",
        "---\nid: 00000000-0000-0000-0000-000000000501\ntitle: Original\n---\nSee [[Original]].",
    )]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "original.md".to_string(),
            destination: "moved.md".to_string(),
        })
        .unwrap();

    plan.execute(&vault, &mut index, &[]).unwrap();

    let old_path = vault.resolve(&VaultPath::new("original.md").unwrap());
    let new_path = vault.resolve(&VaultPath::new("moved.md").unwrap());
    assert!(!old_path.exists(), "old path should not have orphan copy");
    assert!(new_path.exists(), "new path should exist");
}

#[test]
fn folder_move_internal_refs_no_orphan_outside() {
    let (_tmp, vault) = setup_vault(&[
        (
            "notes/a.md",
            "---\nid: 00000000-0000-0000-0000-000000000502\ntitle: A\n---\nContent of A.",
        ),
        (
            "notes/b.md",
            "---\nid: 00000000-0000-0000-0000-000000000503\ntitle: B\n---\nSee [[A]].",
        ),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MoveFolder {
            source: "notes".to_string(),
            destination: "archive".to_string(),
        })
        .unwrap();

    plan.execute(&vault, &mut index, &[]).unwrap();

    // Old paths should not exist
    let old_b = vault.resolve(&VaultPath::new("notes/b.md").unwrap());
    assert!(
        !old_b.exists(),
        "notes/b.md should not have orphan after folder move"
    );

    // New paths should exist
    let new_a = vault.resolve(&VaultPath::new("archive/a.md").unwrap());
    let new_b = vault.resolve(&VaultPath::new("archive/b.md").unwrap());
    assert!(new_a.exists(), "archive/a.md should exist");
    assert!(new_b.exists(), "archive/b.md should exist");
}

#[tokio::test]
async fn mutation_coordinator_serializes_the_same_path() {
    use std::sync::Arc;
    use std::time::Duration;

    let coordinator = Arc::new(MutationCoordinator::new());
    let path = VaultPath::new("notes/shared.md").unwrap();
    let first_guard = coordinator.lock_paths(std::slice::from_ref(&path)).await;
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel(1);

    let second_coordinator = Arc::clone(&coordinator);
    let second_path = path.clone();
    let second = tokio::spawn(async move {
        let _guard = second_coordinator.lock_paths(&[second_path]).await;
        entered_tx.send(()).await.unwrap();
    });

    assert!(
        tokio::time::timeout(Duration::from_millis(50), entered_rx.recv())
            .await
            .is_err(),
        "a second mutation entered while the first path guard was held"
    );

    drop(first_guard);
    tokio::time::timeout(Duration::from_secs(1), entered_rx.recv())
        .await
        .expect("second mutation remained blocked after the guard dropped")
        .expect("second mutation exited without entering");
    second.await.unwrap();
}

#[tokio::test]
async fn mutation_coordinator_allows_different_paths_concurrently() {
    use std::sync::Arc;
    use std::time::Duration;

    let coordinator = Arc::new(MutationCoordinator::new());
    let first_path = VaultPath::new("notes/first.md").unwrap();
    let first_guard = coordinator.lock_paths(&[first_path]).await;
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel(1);

    let second_coordinator = Arc::clone(&coordinator);
    let second = tokio::spawn(async move {
        let second_path = VaultPath::new("notes/second.md").unwrap();
        let _guard = second_coordinator.lock_paths(&[second_path]).await;
        entered_tx.send(()).await.unwrap();
    });

    tokio::time::timeout(Duration::from_secs(1), entered_rx.recv())
        .await
        .expect("an unrelated path was blocked")
        .expect("unrelated mutation exited without entering");
    drop(first_guard);
    second.await.unwrap();
}

#[tokio::test]
async fn mutation_coordinator_deduplicates_repeated_paths() {
    use std::time::Duration;

    let coordinator = MutationCoordinator::new();
    let path = VaultPath::new("notes/repeated.md").unwrap();

    tokio::time::timeout(
        Duration::from_secs(1),
        coordinator.lock_paths(&[path.clone(), path]),
    )
    .await
    .expect("duplicate normalized paths caused self-deadlock");
}

#[tokio::test]
async fn mutation_coordinator_orders_opposing_multi_path_requests() {
    use std::sync::Arc;
    use std::time::Duration;

    let coordinator = Arc::new(MutationCoordinator::new());
    let first_path = VaultPath::new("notes/first.md").unwrap();
    let second_path = VaultPath::new("notes/second.md").unwrap();
    let initial_guard = coordinator
        .lock_paths(std::slice::from_ref(&first_path))
        .await;
    let (started_tx, mut started_rx) = tokio::sync::mpsc::channel(2);

    let reverse_coordinator = Arc::clone(&coordinator);
    let reverse_first = first_path.clone();
    let reverse_second = second_path.clone();
    let reverse_started = started_tx.clone();
    let reverse = tokio::spawn(async move {
        reverse_started.send(()).await.unwrap();
        let _guard = reverse_coordinator
            .lock_paths(&[reverse_second, reverse_first])
            .await;
    });

    let forward_coordinator = Arc::clone(&coordinator);
    let forward = tokio::spawn(async move {
        started_tx.send(()).await.unwrap();
        let _guard = forward_coordinator
            .lock_paths(&[first_path, second_path])
            .await;
    });

    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(1), started_rx.recv())
            .await
            .expect("a lock request did not start")
            .expect("a lock request exited before starting");
    }
    tokio::task::yield_now().await;
    drop(initial_guard);

    tokio::time::timeout(Duration::from_secs(1), async {
        reverse.await.unwrap();
        forward.await.unwrap();
    })
    .await
    .expect("opposite-order multi-path requests deadlocked");
}

#[tokio::test]
async fn mutation_coordinator_prunes_expired_lock_entries() {
    let coordinator = MutationCoordinator::new();
    let expired_path = VaultPath::new("notes/expired.md").unwrap();
    drop(coordinator.lock_paths(&[expired_path]).await);
    assert_eq!(coordinator.lock_table_len(), 2);

    let live_path = VaultPath::new("notes/live.md").unwrap();
    let _guard = coordinator.lock_paths(&[live_path]).await;

    assert_eq!(
        coordinator.lock_table_len(),
        2,
        "requesting a new lock should prune expired weak entries"
    );
}

#[tokio::test]
async fn subtree_lock_blocks_descendant_mutation_but_not_sibling_subtree() {
    let coordinator = Arc::new(MutationCoordinator::new());
    let folder = VaultPath::new("projects/alpha").unwrap();
    let descendant = VaultPath::new("projects/alpha/task.md").unwrap();
    let sibling = VaultPath::new("projects/beta/task.md").unwrap();
    let folder_guard = coordinator.lock_subtree(&folder).await;

    let blocked_coordinator = Arc::clone(&coordinator);
    let blocked = tokio::spawn(async move {
        let _guard = blocked_coordinator.lock_paths(&[descendant]).await;
    });
    let sibling_coordinator = Arc::clone(&coordinator);
    let sibling = tokio::spawn(async move {
        let _guard = sibling_coordinator.lock_paths(&[sibling]).await;
    });

    tokio::time::timeout(std::time::Duration::from_millis(200), sibling)
        .await
        .expect("sibling subtree was unnecessarily blocked")
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut Box::pin(blocked))
            .await
            .is_err(),
        "descendant mutation entered while subtree deletion lock was held"
    );

    drop(folder_guard);
}

#[test]
fn mutation_coordinator_atomic_replace_cleans_partial_temp_after_write_failure() {
    use std::io::{self, Write};

    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"old content").unwrap();

    let result = atomic_replace_with(
        &path,
        b"complete new content",
        |file, _| {
            file.write_all(b"partial")?;
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "injected write failure",
            ))
        },
        |temporary_path, destination| fs::rename(temporary_path, destination),
        |_| Ok(()),
        |temporary_path| fs::remove_file(temporary_path),
    );

    let error = result.expect_err("the injected write failure succeeded");
    assert_eq!(error.kind(), io::ErrorKind::WriteZero);
    assert_eq!(fs::read(&path).unwrap(), b"old content");
    assert!(
        fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".clepsydra-tmp-")),
        "failed replacement leaked a temporary file"
    );
}

#[test]
fn mutation_coordinator_atomic_replace_writes_complete_new_content() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"old content").unwrap();

    atomic_replace(&path, b"complete new content").unwrap();

    assert_eq!(fs::read(path).unwrap(), b"complete new content");
}

#[cfg(unix)]
#[test]
fn mutation_coordinator_atomic_replace_preserves_unix_mode() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"old content").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

    atomic_replace(&path, b"complete new content").unwrap();

    assert_eq!(fs::metadata(path).unwrap().mode() & 0o7777, 0o640);
}

#[test]
fn mutation_coordinator_atomic_create_publishes_complete_content() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");

    atomic_create(&path, b"complete new content").unwrap();

    assert_eq!(fs::read(path).unwrap(), b"complete new content");
}

#[cfg(windows)]
#[test]
fn mutation_coordinator_atomic_publication_succeeds_on_windows() {
    let tmp = TempDir::new().unwrap();
    let create_path = tmp.path().join("created.md");
    let replace_path = tmp.path().join("replaced.md");
    fs::write(&replace_path, b"old content").unwrap();

    atomic_create(&create_path, b"created content").unwrap();
    atomic_replace(&replace_path, b"replacement content").unwrap();

    assert_eq!(fs::read(create_path).unwrap(), b"created content");
    assert_eq!(fs::read(replace_path).unwrap(), b"replacement content");
}

#[test]
fn mutation_coordinator_atomic_create_collision_preserves_destination_and_cleans_temp() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"existing content").unwrap();

    let error = atomic_create(&path, b"new content").expect_err("create replaced destination");

    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(path).unwrap(), b"existing content");
    assert!(
        fs::read_dir(tmp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".clepsydra-tmp-")),
        "rejected create leaked a temporary file"
    );
}

#[test]
fn mutation_coordinator_atomic_replace_supports_bare_relative_destination() {
    const CHILD_MARKER: &str = "CLEPSYDRA_BARE_RELATIVE_ATOMIC_REPLACE_CHILD";

    if std::env::var_os(CHILD_MARKER).is_some() {
        let path = std::path::Path::new("page.md");
        fs::write(path, b"old content").unwrap();
        atomic_replace(path, b"complete new content").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"complete new content");
        return;
    }

    let isolated_directory = TempDir::new().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("mutation_coordinator_atomic_replace_supports_bare_relative_destination")
        .arg("--nocapture")
        .env(CHILD_MARKER, "1")
        .current_dir(isolated_directory.path())
        .status()
        .unwrap();

    assert!(status.success(), "isolated child test failed: {status}");
}

#[test]
fn mutation_coordinator_atomic_replace_reports_primary_and_cleanup_failures() {
    use std::io::{self, Write};

    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"old content").unwrap();

    let result = atomic_replace_with(
        &path,
        b"complete new content",
        |file, _| {
            file.write_all(b"partial")?;
            Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "injected primary failure",
            ))
        },
        |temporary_path, destination| fs::rename(temporary_path, destination),
        |_| Ok(()),
        |temporary_path| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("injected cleanup failure for {}", temporary_path.display()),
            ))
        },
    );

    let error = result.expect_err("the injected failures succeeded");
    assert_eq!(
        error.kind(),
        io::ErrorKind::WriteZero,
        "the primary error kind must be preserved"
    );
    let message = error.to_string();
    assert!(message.contains("injected primary failure"), "{message}");
    assert!(message.contains("injected cleanup failure"), "{message}");
    assert!(message.contains(".page.md.clepsydra-tmp-"), "{message}");
    assert_eq!(fs::read(&path).unwrap(), b"old content");

    let leaked_temp = fs::read_dir(tmp.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|entry| {
            entry
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".clepsydra-tmp-")
        })
        .expect("injected cleanup failure should leave the reported temp file");
    fs::remove_file(leaked_temp).unwrap();
}

#[test]
fn mutation_coordinator_atomic_replace_reports_post_rename_sync_failure() {
    use std::io::{self, Write};

    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"old content").unwrap();

    let result = atomic_replace_with(
        &path,
        b"complete new content",
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        |temporary_path, destination| fs::rename(temporary_path, destination),
        |_| {
            Err(io::Error::new(
                io::ErrorKind::Other,
                "injected parent sync failure",
            ))
        },
        |temporary_path| fs::remove_file(temporary_path),
    );

    let error = result.expect_err("the injected parent sync failure succeeded");
    assert_eq!(error.kind(), io::ErrorKind::Other);
    let message = error.to_string();
    assert!(
        message.contains("injected parent sync failure"),
        "{message}"
    );
    assert!(message.contains("rename completed"), "{message}");
    assert!(message.contains("may contain the new content"), "{message}");
    assert_eq!(fs::read(&path).unwrap(), b"complete new content");
}

#[test]
fn atomic_replace_distinguishes_not_published_from_published_but_not_durable() {
    use std::io::{self, Write};

    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("page.md");
    fs::write(&path, b"old content").unwrap();

    let before_publish = atomic_replace_with(
        &path,
        b"new content",
        |file, _| {
            file.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::WriteZero, "write failed"))
        },
        |temporary, destination| fs::rename(temporary, destination),
        |_| Ok(()),
        |temporary| fs::remove_file(temporary),
    )
    .expect_err("write failure unexpectedly published");
    assert!(matches!(
        before_publish,
        AtomicPublicationError::NotPublished(_)
    ));
    assert_eq!(fs::read(&path).unwrap(), b"old content");

    let after_publish = atomic_replace_with(
        &path,
        b"new content",
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        |temporary, destination| fs::rename(temporary, destination),
        |_| Err(io::Error::other("directory sync failed")),
        |temporary| fs::remove_file(temporary),
    )
    .expect_err("directory sync failure unexpectedly reported durable");
    assert!(matches!(
        after_publish,
        AtomicPublicationError::PublishedButNotDurable(_)
    ));
    assert_eq!(fs::read(&path).unwrap(), b"new content");
}
