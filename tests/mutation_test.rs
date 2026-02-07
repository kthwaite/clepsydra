use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{MutationOp, MutationPlan, MutationPlanner, RewriteMode};

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

    // Should have text edits for alpha.md
    assert!(!plan.text_edits.is_empty());
    let edit = &plan.text_edits[0];
    assert_eq!(edit.path, "alpha.md");
    // The new content should contain the updated relative path
    assert!(
        edit.new_text.contains("archive/beta.md"),
        "expected 'archive/beta.md' in new_text, got: {}",
        edit.new_text
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
    assert!(!plan.text_edits.is_empty());
    let edit = &plan.text_edits[0];
    // Wikilink [[beta]] should remain because stem is the same
    assert!(
        edit.new_text.contains("[[beta]]"),
        "wikilink should be unchanged, got: {}",
        edit.new_text
    );
    // Markdown link should update to sub/beta.md
    assert!(
        edit.new_text.contains("sub/beta.md"),
        "markdown link should update, got: {}",
        edit.new_text
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
