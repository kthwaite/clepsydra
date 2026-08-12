use std::collections::BTreeSet;
use std::fs;
use std::sync::Arc;

use clepsydra::vault::Vault;
use clepsydra::vault::batch_mutation::{
    BatchMutationCommand, BatchPathIntent, ExpectedPathState,
};
use clepsydra::vault::atomic_file::{
    AtomicPublicationError, atomic_create, atomic_create_owner_only, atomic_replace,
    atomic_replace_with,
};
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{
    FileOpKind, MutationOp, MutationPlan, MutationPlanner, PlannedFileOp, RewriteMode,
};
use clepsydra::vault::mutation_coordinator::{
    CreatePageCommand, MutationCoordinator, MutationError,
};
use clepsydra::vault::page::{PageMeta, parse_or_repair_frontmatter};
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

fn preview_paths(plan: &MutationPlan) -> BTreeSet<String> {
    plan.file_ops
        .iter()
        .flat_map(|operation| {
            std::iter::once(operation.path.clone()).chain(operation.destination.clone())
        })
        .chain(plan.text_edits.iter().map(|edit| edit.path.clone()))
        .collect()
}

#[tokio::test]
async fn batch_publication_failure_rolls_back_without_notification() {
    let source_content = "+++\nid = \"019fd000-0000-7000-8000-000000000041\"\ntitle = \"Source\"\n+++\nbody\n";
    let (_tmp, vault) = setup_vault(&[("source.md", source_content)]);
    let mut raw_index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    raw_index.build(&vault).unwrap();
    let source_content = fs::read_to_string(vault.root().join("source.md")).unwrap();
    let index = IndexHandle::spawn(raw_index, vault.clone());
    let coordinator = MutationCoordinator::new();
    let notifications = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let observed = Arc::clone(&notifications);
    let source = VaultPath::new("source.md").unwrap();
    let destination = VaultPath::new("missing/destination.md").unwrap();

    let error = coordinator
        .execute_batch(
            &vault,
            &index,
            Arc::new(Vec::new()),
            BatchMutationCommand {
                intents: vec![BatchPathIntent::Move {
                    source: source.clone(),
                    destination: destination.clone(),
                    expected_source: source_content.as_bytes().to_vec(),
                }],
                create_directories: Vec::new(),
                remove_directories: Vec::new(),
                index_events: vec![
                    ChangeEvent::Remove(source.clone()),
                    ChangeEvent::Upsert(destination.clone()),
                ],
                moved_pages: vec![(source.clone(), destination.clone())],
            },
            Arc::new(move |notification| observed.lock().push(notification)),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, MutationError::BatchPublish { .. }));
    assert_eq!(
        fs::read_to_string(vault.resolve(&source)).unwrap(),
        source_content
    );
    assert!(!vault.resolve(&destination).exists());
    assert!(notifications.lock().is_empty());
}

fn encrypted_referrer(id: &str, title: &str, link: &str) -> String {
    format!(
        "+++\nid = \"{id}\"\ntitle = \"{title}\"\nencryption = {{ format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }}\n+++\n-----BEGIN AGE ENCRYPTED FILE-----\n{link}\n-----END AGE ENCRYPTED FILE-----\n"
    )
}

fn assert_protected_referrer(vault: &Vault) {
    let path = VaultPath::new("protected-ref.md").unwrap();
    let content = fs::read_to_string(vault.resolve(&path)).unwrap();
    let (meta, _, _, _) = parse_or_repair_frontmatter(&content);
    assert!(meta.encryption.is_some());
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

    // The preview includes the rename and its missing destination directory.
    assert_eq!(plan.file_ops.len(), 2);
    assert_eq!(plan.file_ops[0].path, "beta.md");
    assert_eq!(
        plan.file_ops[0].destination.as_deref(),
        Some("archive/beta.md")
    );
    assert!(matches!(plan.file_ops[1].kind, FileOpKind::CreateDir));
    assert_eq!(plan.file_ops[1].path, "archive");

    // Should have index events
    assert!(!plan.index_events.is_empty());
}

#[test]
fn move_plan_batch_intents_cover_every_previewed_path_with_exact_expected_bytes() {
    let alpha = "\
---
id: 00000000-0000-0000-0000-000000000110
title: Alpha
---
Link to [[Beta]].
";
    let beta = "\
---
id: 00000000-0000-0000-0000-000000000111
title: Beta
---
Content.
";
    let gamma = "\
---
id: 00000000-0000-0000-0000-000000000112
title: Gamma
---
Another link to [Beta](beta.md).
";
    let (_tmp, vault) =
        setup_vault(&[("alpha.md", alpha), ("beta.md", beta), ("gamma.md", gamma)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/renamed.md".to_string(),
        })
        .unwrap();
    assert_eq!(plan.staged_writes.len(), 2);
    let preview_paths = preview_paths(&plan);

    let command = plan.into_batch_command(&vault).unwrap();
    let command_paths = command
        .affected_paths()
        .iter()
        .map(|path| path.as_str().to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(preview_paths, command_paths);

    for intent in command.intents {
        match intent {
            BatchPathIntent::Write { path, expected, .. } => {
                assert_eq!(
                    expected,
                    ExpectedPathState::Bytes(fs::read(vault.resolve(&path)).unwrap())
                );
            }
            BatchPathIntent::Move {
                source,
                expected_source,
                ..
            } => {
                assert_eq!(expected_source, fs::read(vault.resolve(&source)).unwrap());
            }
            BatchPathIntent::Delete { path, expected } => {
                assert_eq!(expected, fs::read(vault.resolve(&path)).unwrap());
            }
        }
    }
}

#[test]
fn public_rename_and_delete_file_ops_are_converted_to_batch_intents() {
    let (_tmp, vault) = setup_vault(&[
        ("source.md", "source snapshot"),
        ("obsolete.md", "obsolete snapshot"),
    ]);
    let mut plan = MutationPlan::empty();
    plan.file_ops.push(PlannedFileOp {
        kind: FileOpKind::Rename,
        path: "source.md".to_string(),
        destination: Some("archive/source.md".to_string()),
        content_hash: None,
    });
    plan.file_ops.push(PlannedFileOp {
        kind: FileOpKind::Delete,
        path: "obsolete.md".to_string(),
        destination: None,
        content_hash: None,
    });

    let command = plan.into_batch_command(&vault).unwrap();
    assert!(command.intents.iter().any(|intent| {
        matches!(
            intent,
            BatchPathIntent::Move {
                source,
                destination,
                expected_source,
            } if source.as_str() == "source.md"
                && destination.as_str() == "archive/source.md"
                && expected_source == b"source snapshot"
        )
    }));
    assert!(command.intents.iter().any(|intent| {
        matches!(
            intent,
            BatchPathIntent::Delete { path, expected }
                if path.as_str() == "obsolete.md" && expected == b"obsolete snapshot"
        )
    }));
}

#[test]
fn move_plan_batch_expected_bytes_are_from_the_rewrite_snapshot() {
    let alpha = "---\nid: 00000000-0000-0000-0000-000000000113\ntitle: Alpha\n---\nLink to [[Beta]].\n";
    let beta = "---\nid: 00000000-0000-0000-0000-000000000114\ntitle: Beta\n---\nContent.\n";
    let (_tmp, vault) = setup_vault(&[("alpha.md", alpha), ("beta.md", beta)]);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let snapshot = fs::read(vault.root().join("alpha.md")).unwrap();
    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "renamed.md".to_string(),
        })
        .unwrap();
    fs::write(vault.root().join("alpha.md"), "concurrent replacement").unwrap();

    let command = plan.into_batch_command(&vault).unwrap();
    let expected = command
        .intents
        .iter()
        .find_map(|intent| match intent {
            BatchPathIntent::Write {
                path,
                expected: ExpectedPathState::Bytes(expected),
                ..
            } if path.as_str() == "alpha.md" => Some(expected.as_slice()),
            _ => None,
        })
        .expect("backlink write intent");
    assert_eq!(expected, snapshot);
    let error =
        MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap_err();
    assert!(matches!(error, MutationError::Stale(path) if path.as_str() == "alpha.md"));
    assert_eq!(
        fs::read_to_string(vault.root().join("alpha.md")).unwrap(),
        "concurrent replacement"
    );
    assert!(vault.root().join("beta.md").is_file());
    assert!(!vault.root().join("renamed.md").exists());
}

#[test]
fn folder_plan_batch_uses_the_planner_inventory_without_rewalking() {
    let alpha = "---\nid: 00000000-0000-0000-0000-000000000115\ntitle: Alpha\n---\n";
    let (_tmp, vault) = setup_vault(&[("notes/alpha.md", alpha)]);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::MoveFolder {
            source: "notes".to_string(),
            destination: "archive/notes".to_string(),
        })
        .unwrap();
    fs::write(vault.root().join("notes/late.md"), "late arrival").unwrap();
    let command = plan.into_batch_command(&vault).unwrap();

    let paths = command
        .affected_paths()
        .into_iter()
        .map(|path| path.as_str().to_string())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        paths,
        BTreeSet::from([
            "archive".to_string(),
            "archive/notes".to_string(),
            "archive/notes/alpha.md".to_string(),
            "notes".to_string(),
            "notes/alpha.md".to_string(),
        ])
    );
    assert!(!paths.contains("notes/late.md"));
    assert!(!paths.contains("archive/notes/late.md"));
}

#[test]
fn empty_folder_plan_does_not_adopt_a_late_file_during_conversion() {
    let (_tmp, vault) = setup_vault(&[]);
    fs::create_dir(vault.root().join("notes")).unwrap();
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::MoveFolder {
            source: "notes".to_string(),
            destination: "archive/notes".to_string(),
        })
        .unwrap();
    fs::write(vault.root().join("notes/late.md"), "late arrival").unwrap();

    let command = plan.into_batch_command(&vault).unwrap();
    assert!(command.intents.is_empty());
    assert!(command.index_events.is_empty());
    assert!(command.moved_pages.is_empty());
    assert_eq!(
        command
            .affected_paths()
            .into_iter()
            .map(|path| path.as_str().to_string())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "archive".to_string(),
            "archive/notes".to_string(),
            "notes".to_string(),
        ])
    );
}

#[test]
fn explicit_create_dir_plan_becomes_preparation_metadata() {
    let (_tmp, vault) = setup_vault(&[]);
    let mut plan = MutationPlan::empty();
    plan.file_ops.push(PlannedFileOp {
        kind: FileOpKind::CreateDir,
        path: "archive/nested".to_string(),
        destination: None,
        content_hash: None,
    });

    let command = plan.into_batch_command(&vault).unwrap();
    assert_eq!(
        command
            .create_directories
            .iter()
            .map(VaultPath::as_str)
            .collect::<Vec<_>>(),
        vec!["archive", "archive/nested"]
    );
}

#[test]
fn staged_create_file_carries_previewed_content_identity_into_batch() {
    let (_tmp, vault) = setup_vault(&[]);
    let path = VaultPath::new("archive/new.md").unwrap();
    let content = b"immutable created bytes".to_vec();
    let expected_hash = blake3::hash(&content).to_hex().to_string();
    let mut plan = MutationPlan::empty();
    plan.stage_create_file(&vault, path.clone(), content.clone())
        .unwrap();

    assert_eq!(plan.file_ops.len(), 2);
    assert!(plan.file_ops.iter().any(|operation| {
        matches!(operation.kind, FileOpKind::CreateDir)
            && operation.path == "archive"
    }));
    assert!(plan.file_ops.iter().any(|operation| {
        matches!(operation.kind, FileOpKind::CreateFile)
            && operation.path == path.as_str()
            && operation.content_hash.as_deref() == Some(expected_hash.as_str())
    }));

    let command = plan.into_batch_command(&vault).unwrap();
    assert!(command.intents.iter().any(|intent| {
        matches!(
            intent,
            BatchPathIntent::Write {
                path: created_path,
                expected: ExpectedPathState::Missing,
                content: created_content,
            } if created_path == &path && created_content == &content
        )
    }));
}

#[tokio::test]
async fn global_mutation_exclusion_blocks_new_path_mutations() {
    let coordinator = Arc::new(MutationCoordinator::new());
    let exclusion = coordinator.exclude_mutations().await;
    let waiting_coordinator = Arc::clone(&coordinator);
    let mut waiter = tokio::spawn(async move {
        waiting_coordinator
            .lock_paths(&[VaultPath::new("notes/source.md").unwrap()])
            .await
    });

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut waiter)
            .await
            .is_err(),
        "ordinary path mutations must wait behind global revalidation exclusion"
    );
    drop(exclusion);
    let _guard = waiter.await.unwrap();
}

#[test]
fn delete_plan_batch_paths_and_expected_bytes_match_the_planner_snapshot() {
    let target = "---\nid: 00000000-0000-0000-0000-000000000116\ntitle: Target\n---\nTarget.\n";
    let linker = "---\nid: 00000000-0000-0000-0000-000000000117\ntitle: Linker\n---\nSee [[Target]].\n";
    let (_tmp, vault) = setup_vault(&[("target.md", target), ("linker.md", linker)]);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();
    let target_snapshot = fs::read(vault.root().join("target.md")).unwrap();
    let linker_snapshot = fs::read(vault.root().join("linker.md")).unwrap();

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::DeletePage {
            path: "target.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();
    fs::write(vault.root().join("target.md"), "concurrent target").unwrap();
    fs::write(vault.root().join("linker.md"), "concurrent linker").unwrap();
    let preview_paths = preview_paths(&plan);
    let command = plan.into_batch_command(&vault).unwrap();

    assert_eq!(
        command
            .affected_paths()
            .into_iter()
            .map(|path| path.as_str().to_string())
            .collect::<BTreeSet<_>>(),
        preview_paths
    );
    for intent in command.intents {
        match intent {
            BatchPathIntent::Write { path, expected, .. } if path.as_str() == "linker.md" => {
                assert_eq!(expected, ExpectedPathState::Bytes(linker_snapshot.clone()));
            }
            BatchPathIntent::Delete { path, expected } if path.as_str() == "target.md" => {
                assert_eq!(expected, target_snapshot);
            }
            intent => panic!("unexpected delete-plan intent: {intent:?}"),
        }
    }
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

    assert_eq!(plan.file_ops.len(), 2);
    assert!(plan.file_ops.iter().any(|operation| {
        matches!(operation.kind, FileOpKind::CreateDir) && operation.path == "archive"
    }));
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

#[test]
fn encrypted_page_move_skips_protected_referrers_but_rewrites_plain_referrers() {
    let protected_plain =
        "---\nid: 00000000-0000-0000-0000-000000000410\ntitle: Protected ref\n---\nSee [[Beta]].\n";
    let plain_ref =
        "---\nid: 00000000-0000-0000-0000-000000000411\ntitle: Plain ref\n---\nSee [[Beta]].\n";
    let target = "---\nid: 00000000-0000-0000-0000-000000000412\ntitle: Beta\n---\nTarget.\n";
    let (_tmp, vault) = setup_vault(&[
        ("protected-ref.md", protected_plain),
        ("plain-ref.md", plain_ref),
        ("beta.md", target),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    fs::write(
        vault.root().join("protected-ref.md"),
        encrypted_referrer(
            "00000000-0000-0000-0000-000000000410",
            "Protected ref",
            "[[Beta]]",
        ),
    )
    .unwrap();
    assert_protected_referrer(&vault);

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::MovePage {
            source: "beta.md".to_string(),
            destination: "archive/gamma.md".to_string(),
        })
        .unwrap();

    assert!(
        plan.staged_writes
            .iter()
            .any(|write| write.path.ends_with("plain-ref.md")),
        "plaintext backlink should still be rewritten"
    );
    assert!(
        plan.staged_writes
            .iter()
            .all(|write| !write.path.ends_with("protected-ref.md")),
        "protected armor must never be staged for rewrite"
    );
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

#[test]
fn encrypted_page_delete_skips_protected_referrers_but_rewrites_plain_referrers() {
    let protected_plain =
        "---\nid: 00000000-0000-0000-0000-000000000420\ntitle: Protected ref\n---\nSee [[Beta]].\n";
    let plain_ref =
        "---\nid: 00000000-0000-0000-0000-000000000421\ntitle: Plain ref\n---\nSee [[Beta]].\n";
    let target = "---\nid: 00000000-0000-0000-0000-000000000422\ntitle: Beta\n---\nTarget.\n";
    let (_tmp, vault) = setup_vault(&[
        ("protected-ref.md", protected_plain),
        ("plain-ref.md", plain_ref),
        ("beta.md", target),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    fs::write(
        vault.root().join("protected-ref.md"),
        encrypted_referrer(
            "00000000-0000-0000-0000-000000000420",
            "Protected ref",
            "[[Beta]]",
        ),
    )
    .unwrap();
    assert_protected_referrer(&vault);

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::DeletePage {
            path: "beta.md".to_string(),
            rewrite: RewriteMode::PlainText,
        })
        .unwrap();

    assert!(
        plan.staged_writes
            .iter()
            .any(|write| write.path.ends_with("plain-ref.md")),
        "plaintext backlink should still be rewritten"
    );
    assert!(
        plan.staged_writes
            .iter()
            .all(|write| !write.path.ends_with("protected-ref.md")),
        "protected armor must never be staged for rewrite"
    );
}

// ---------------------------------------------------------------------------
// Batch command execution tests
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

    let command = plan.into_batch_command(&vault).unwrap();
    MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap();

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

    let command = plan.into_batch_command(&vault).unwrap();
    MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap();

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

#[test]
fn encrypted_folder_move_skips_protected_referrers_but_rewrites_plain_referrers() {
    let protected_plain =
        "---\nid: 00000000-0000-0000-0000-000000000430\ntitle: Protected ref\n---\nSee [[Beta]].\n";
    let plain_ref =
        "---\nid: 00000000-0000-0000-0000-000000000431\ntitle: Plain ref\n---\nSee [[Beta]].\n";
    let target = "---\nid: 00000000-0000-0000-0000-000000000432\ntitle: Beta\n---\nTarget.\n";
    let (_tmp, vault) = setup_vault(&[
        ("protected-ref.md", protected_plain),
        ("plain-ref.md", plain_ref),
        ("notes/beta.md", target),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    fs::write(
        vault.root().join("protected-ref.md"),
        encrypted_referrer(
            "00000000-0000-0000-0000-000000000430",
            "Protected ref",
            "[[Beta]]",
        ),
    )
    .unwrap();
    assert_protected_referrer(&vault);

    let plan = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::MoveFolder {
            source: "notes".to_string(),
            destination: "archive".to_string(),
        })
        .unwrap();

    assert!(
        plan.staged_writes
            .iter()
            .any(|write| write.path.ends_with("plain-ref.md")),
        "plaintext backlink should still be rewritten"
    );
    assert!(
        plan.staged_writes
            .iter()
            .all(|write| !write.path.ends_with("protected-ref.md")),
        "protected armor must never be staged for rewrite"
    );
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

    let command = plan.into_batch_command(&vault).unwrap();
    MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap();

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

    let command = plan.into_batch_command(&vault).unwrap();
    MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap();

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

    let command = plan.into_batch_command(&vault).unwrap();
    MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap();

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_create_finishes_indexing_after_filesystem_publication() {
    let (tmp, index_vault) = setup_vault(&[]);
    let db_path = index_vault.root().join(".clepsydra/cancel-shield.db");
    let mut vault_index = VaultIndex::open(&db_path).unwrap();
    vault_index.build(&index_vault).unwrap();
    let index = IndexHandle::spawn(vault_index, index_vault);
    let mutation_vault = Vault::open(&tmp.path().join("vault")).unwrap();
    let coordinator = Arc::new(MutationCoordinator::new());
    let path = VaultPath::new("notes/cancelled-create.md").unwrap();
    let absolute = mutation_vault.resolve(&path);

    let (index_entered_tx, index_entered_rx) = std::sync::mpsc::channel();
    let (index_release_tx, index_release_rx) = std::sync::mpsc::channel();
    let blocking_index = index.clone();
    let index_blocker = tokio::spawn(async move {
        blocking_index
            .with_index(move |_, _| {
                index_entered_tx.send(()).unwrap();
                index_release_rx.recv().unwrap();
            })
            .await
    });
    index_entered_rx.recv().unwrap();

    let mutation_coordinator = Arc::clone(&coordinator);
    let mutation_index = index.clone();
    let mutation_path = path.clone();
    let mutation = tokio::spawn(async move {
        mutation_coordinator
            .create_page(
                &mutation_vault,
                &mutation_index,
                CreatePageCommand {
                    path: mutation_path,
                    meta: PageMeta::new(),
                    body: "published".to_string(),
                },
                Arc::new(|_| {}),
            )
            .await
    });

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !absolute.is_file() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("filesystem publication did not complete");
    mutation.abort();
    assert!(mutation.await.unwrap_err().is_cancelled());
    index_release_tx.send(()).unwrap();
    index_blocker.await.unwrap().unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let query_path = path.as_str().to_string();
            let indexed = index
                .with_index(move |vault_index, _| {
                    vault_index
                        .connection()
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM pages WHERE path = ?1)",
                            rusqlite::params![query_path],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false)
                })
                .await
                .unwrap();
            if indexed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled request left the published file unindexed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_excluded_batch_retains_global_exclusion_through_reconciliation() {
    let original = "original";
    let replacement = "replacement";
    let (tmp, index_vault) = setup_vault(&[("source.md", original)]);
    let db_path = index_vault.root().join(".clepsydra/exclusion-cancel.db");
    let mut vault_index = VaultIndex::open(&db_path).unwrap();
    vault_index.build(&index_vault).unwrap();
    let index = IndexHandle::spawn(vault_index, index_vault);
    let mutation_vault = Vault::open(&tmp.path().join("vault")).unwrap();
    let coordinator = Arc::new(MutationCoordinator::new());
    let source_path = VaultPath::new("source.md").unwrap();
    let expected_source = fs::read(mutation_vault.resolve(&source_path)).unwrap();

    let (index_entered_tx, index_entered_rx) = std::sync::mpsc::channel();
    let (index_release_tx, index_release_rx) = std::sync::mpsc::channel();
    let blocking_index = index.clone();
    let index_blocker = tokio::spawn(async move {
        blocking_index
            .with_index(move |_, _| {
                index_entered_tx.send(()).unwrap();
                index_release_rx.recv().unwrap();
            })
            .await
    });
    index_entered_rx.recv().unwrap();

    let exclusion = coordinator.exclude_mutations().await;
    let mutation_coordinator = Arc::clone(&coordinator);
    let mutation_index = index.clone();
    let mutation_source = source_path.clone();
    let observed_vault = mutation_vault.clone();
    let mutation = tokio::spawn(async move {
        mutation_coordinator
            .execute_batch_excluded(
                exclusion,
                &mutation_vault,
                &mutation_index,
                Arc::new(Vec::new()),
                BatchMutationCommand {
                    intents: vec![BatchPathIntent::Write {
                        path: mutation_source.clone(),
                        expected: ExpectedPathState::Bytes(expected_source),
                        content: replacement.as_bytes().to_vec(),
                    }],
                    create_directories: Vec::new(),
                    remove_directories: Vec::new(),
                    index_events: vec![ChangeEvent::Upsert(mutation_source)],
                    moved_pages: Vec::new(),
                },
                Arc::new(|_| {}),
            )
            .await
    });

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while fs::read_to_string(observed_vault.resolve(&source_path)).unwrap() != replacement {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("excluded batch did not publish");
    mutation.abort();
    assert!(mutation.await.unwrap_err().is_cancelled());

    let waiting_coordinator = Arc::clone(&coordinator);
    let mut waiter = tokio::spawn(async move {
        waiting_coordinator
            .lock_paths(&[VaultPath::new("unrelated.md").unwrap()])
            .await
    });
    let exclusion_released_early =
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut waiter)
            .await
            .is_ok();

    index_release_tx.send(()).unwrap();
    index_blocker.await.unwrap().unwrap();
    if !exclusion_released_early {
        let _guard = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("global exclusion was not released after reconciliation")
            .unwrap();
    }
    assert!(
        !exclusion_released_early,
        "cancellation dropped global exclusion while shielded reconciliation continued"
    );
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

#[cfg(unix)]
#[test]
fn atomic_owner_only_create_publishes_with_private_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("wrapped-identity.age");

    atomic_create_owner_only(&path, b"sensitive ciphertext").unwrap();

    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
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
        |_| Err(io::Error::other("injected parent sync failure")),
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
