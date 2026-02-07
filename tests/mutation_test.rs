use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{MutationOp, MutationPlan, MutationPlanner, RewriteMode};
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
    let alpha_edits: Vec<_> = plan.text_edits.iter().filter(|e| e.path == "alpha.md").collect();
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
    let alpha_edits: Vec<_> = plan.text_edits.iter().filter(|e| e.path == "alpha.md").collect();
    // Should have a relative path replacement: "beta.md" -> "sub/beta.md"
    assert!(
        alpha_edits.iter().any(|e| e.old_text == "beta.md" && e.new_text == "sub/beta.md"),
        "expected relative path replacement to 'sub/beta.md', got: {:?}",
        alpha_edits
    );
    // No stem replacement should exist (stem is the same: "beta" -> "beta")
    assert!(
        !alpha_edits.iter().any(|e| e.old_text == "beta" && e.new_text != "beta"),
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
    let page_a = "---\nid: 00000000-0000-0000-0000-000000000103\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000104\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner.plan(&MutationOp::DeletePage {
        path: "beta.md".to_string(),
        rewrite: RewriteMode::PlainText,
    }).unwrap();

    // Should have 1 file op (delete beta.md)
    assert_eq!(plan.file_ops.len(), 1);
    assert_eq!(plan.file_ops[0].path, "beta.md");

    // Should have text edits for alpha.md
    assert!(!plan.text_edits.is_empty());
    let alpha_edits: Vec<_> = plan.text_edits.iter().filter(|e| e.path == "alpha.md").collect();
    assert!(!alpha_edits.is_empty());

    // Should have staged writes for alpha.md
    assert!(!plan.staged_writes.is_empty());

    // Should have index events (remove for beta.md, upsert for alpha.md)
    assert!(plan.index_events.len() >= 2);
}

#[test]
fn plan_page_delete_rewrite_none_no_text_edits() {
    let page_a = "---\nid: 00000000-0000-0000-0000-000000000105\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000106\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner.plan(&MutationOp::DeletePage {
        path: "beta.md".to_string(),
        rewrite: RewriteMode::None,
    }).unwrap();

    assert_eq!(plan.file_ops.len(), 1);
    assert!(plan.text_edits.is_empty());
    assert!(plan.staged_writes.is_empty());
}

// ---------------------------------------------------------------------------
// Task 5: MutationPlan::execute() tests
// ---------------------------------------------------------------------------

#[test]
fn execute_plan_moves_file_and_rewrites() {
    let page_a = "---\nid: 00000000-0000-0000-0000-000000000110\ntitle: Alpha\n---\nLink to [[Beta]].\n";
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
    assert!(!vault
        .resolve(&VaultPath::new("beta.md").unwrap())
        .exists());
    assert!(vault
        .resolve(&VaultPath::new("archive/beta.md").unwrap())
        .exists());

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
    let page_a = "---\nid: 00000000-0000-0000-0000-000000000112\ntitle: Alpha\n---\nLink to [[Beta]].\n";
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
    assert!(!vault
        .resolve(&VaultPath::new("beta.md").unwrap())
        .exists());

    // Verify alpha.md was rewritten — [[Beta]] should be plain text now
    let alpha_content =
        fs::read_to_string(vault.resolve(&VaultPath::new("alpha.md").unwrap())).unwrap();
    assert!(
        !alpha_content.contains("[[Beta]]"),
        "link should have been rewritten"
    );
    assert!(
        alpha_content.contains("Beta"),
        "plain text should remain"
    );
}

// ---------------------------------------------------------------------------
// Task 4: MutationPlanner folder-move tests
// ---------------------------------------------------------------------------

#[test]
fn plan_folder_move_rewrites_all_contained_pages() {
    let page_a = "---\nid: 00000000-0000-0000-0000-000000000107\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let page_b = "---\nid: 00000000-0000-0000-0000-000000000108\ntitle: Beta\n---\nContent.\n";

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("notes/beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner.plan(&MutationOp::MoveFolder {
        source: "notes".to_string(),
        destination: "archive".to_string(),
    }).unwrap();

    // Should have a rename file op for the folder
    assert!(
        plan.file_ops.iter().any(|op| op.path == "notes" && op.destination.as_deref() == Some("archive")),
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
    let (_tmp, vault) = setup_vault(&[
        ("selfie.md", "---\nid: 00000000-0000-0000-0000-000000000500\ntitle: Selfie\n---\nSee [[Selfie]] for more."),
    ]);
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
    assert!(!abs_path.exists(), "deleted file should not be recreated by staged writes");
}

#[test]
fn move_page_with_self_link_no_orphan_at_old_path() {
    let (_tmp, vault) = setup_vault(&[
        ("original.md", "---\nid: 00000000-0000-0000-0000-000000000501\ntitle: Original\n---\nSee [[Original]]."),
    ]);
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
        ("notes/a.md", "---\nid: 00000000-0000-0000-0000-000000000502\ntitle: A\n---\nContent of A."),
        ("notes/b.md", "---\nid: 00000000-0000-0000-0000-000000000503\ntitle: B\n---\nSee [[A]]."),
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
    assert!(!old_b.exists(), "notes/b.md should not have orphan after folder move");

    // New paths should exist
    let new_a = vault.resolve(&VaultPath::new("archive/a.md").unwrap());
    let new_b = vault.resolve(&VaultPath::new("archive/b.md").unwrap());
    assert!(new_a.exists(), "archive/a.md should exist");
    assert!(new_b.exists(), "archive/b.md should exist");
}
