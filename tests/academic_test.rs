use std::collections::HashMap;
use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::academic::{
    AnnotationMeta, AnnotationType, ReadingStatus, WorkMeta, WorkType, annotation_meta_to_extra,
    extra_to_annotation_meta, extra_to_work_meta, work_meta_to_extra,
};
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

#[test]
fn work_meta_roundtrip_through_extra() {
    let work = WorkMeta {
        work_type: WorkType::Paper,
        authors: vec!["Ashish Vaswani".to_string()],
        year: Some(2017),
        venue: Some("NeurIPS".to_string()),
        publisher: None,
        status: Some(ReadingStatus::Unread),
        rating: Some(5),
        external_ids: None,
        urls: None,
        assets: vec![],
        cite_key: Some("vaswani2017attention".to_string()),
        extra: HashMap::new(),
    };

    let extra = work_meta_to_extra(&work);
    assert_eq!(extra.get("kind").and_then(|v| v.as_str()), Some("work"));
    assert_eq!(
        extra.get("work_type").and_then(|v| v.as_str()),
        Some("paper")
    );

    let roundtripped = extra_to_work_meta(&extra).expect("should parse back");
    assert_eq!(
        roundtripped.cite_key,
        Some("vaswani2017attention".to_string())
    );
    assert!(matches!(roundtripped.work_type, WorkType::Paper));
    assert_eq!(roundtripped.year, Some(2017));
}

#[test]
fn annotation_meta_roundtrip() {
    let work_id = uuid::Uuid::now_v7();
    let ann = AnnotationMeta {
        work_id,
        work_path: Some("library/papers/attention.md".to_string()),
        source_asset: None,
        source_location: None,
        annotation_type: Some(AnnotationType::Highlight),
        extra: HashMap::new(),
    };

    let extra = annotation_meta_to_extra(&ann);
    assert_eq!(
        extra.get("kind").and_then(|v| v.as_str()),
        Some("annotation")
    );

    let roundtripped = extra_to_annotation_meta(&extra).expect("should parse back");
    assert_eq!(roundtripped.work_id, work_id);
}

#[test]
fn academic_config_defaults() {
    use clepsydra::vault::config::VaultConfig;

    let config = VaultConfig::default();
    assert_eq!(config.academic.library_folder, "library");
    assert_eq!(config.academic.papers_folder, "library/papers");
    assert_eq!(config.academic.books_folder, "library/books");
    assert_eq!(config.academic.annotations_folder, "library/annotations");
}

#[test]
fn cite_key_resolves_via_wikilink() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000200
kind: work
work_type: paper
title: Attention Is All You Need
cite_key: vaswani2017attention
tags: []
---
Content.
";
    fs::write(root.join("attention.md"), work_content).unwrap();

    let linker_content = "\
---
id: 00000000-0000-0000-0000-000000000201
title: My Notes
tags: []
---
See [[vaswani2017attention]] for details.
";
    fs::write(root.join("notes.md"), linker_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();
    let cite_key_unresolved: Vec<_> = unresolved
        .iter()
        .filter(|u| u.target_raw == "vaswani2017attention")
        .collect();
    assert!(
        cite_key_unresolved.is_empty(),
        "cite_key link should be resolved, but found unresolved: {:?}",
        cite_key_unresolved
    );
}

#[test]
fn move_work_updates_annotation_work_path() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("vault");
    init_vault(&root).unwrap();

    fs::create_dir_all(root.join("library/papers")).unwrap();
    fs::create_dir_all(root.join("library/annotations")).unwrap();
    fs::create_dir_all(root.join("archive")).unwrap();

    let work_content = "\
---
id: 00000000-0000-0000-0000-000000000300
kind: work
work_type: paper
title: My Paper
cite_key: mypaper2024
tags: []
---
Paper content.
";
    fs::write(root.join("library/papers/my-paper.md"), work_content).unwrap();

    let ann_content = "\
---
id: 00000000-0000-0000-0000-000000000301
kind: annotation
work_id: 00000000-0000-0000-0000-000000000300
work_path: library/papers/my-paper.md
annotation_type: highlight
tags: []
---
A highlight.
";
    fs::write(root.join("library/annotations/highlight-1.md"), ann_content).unwrap();

    let vault = Vault::open(&root).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    use clepsydra::vault::academic_hook::AcademicMoveHook;
    use clepsydra::vault::hooks::PostMoveHook;
    use clepsydra::vault::mutation::{MutationOp, MutationPlanner};

    let hooks: Vec<Box<dyn PostMoveHook>> = vec![Box::new(AcademicMoveHook)];
    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "library/papers/my-paper.md".to_string(),
            destination: "archive/my-paper.md".to_string(),
        })
        .unwrap();
    plan.execute(&vault, &mut index, &hooks).unwrap();

    // Verify annotation's work_path was updated
    let ann_content = fs::read_to_string(root.join("library/annotations/highlight-1.md")).unwrap();
    assert!(
        ann_content.contains("work_path: archive/my-paper.md")
            || ann_content.contains("work_path: \"archive/my-paper.md\""),
        "expected work_path updated to archive/my-paper.md, got:\n{ann_content}"
    );
}
