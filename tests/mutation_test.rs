use clepsydra::vault::mutation::{MutationOp, MutationPlan, RewriteMode};

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
