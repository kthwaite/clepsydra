mod support;

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
use support::ApiFixture;


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
    use clepsydra::vault::mutation_coordinator::MutationCoordinator;

    let hooks: Vec<Box<dyn PostMoveHook>> = vec![Box::new(AcademicMoveHook)];
    let planner = MutationPlanner::new(&vault, &index);
    let plan = planner
        .plan(&MutationOp::MovePage {
            source: "library/papers/my-paper.md".to_string(),
            destination: "archive/my-paper.md".to_string(),
        })
        .unwrap();
    let command = plan.into_batch_command(&vault).unwrap();
    MutationCoordinator::execute_batch_direct(&vault, &mut index, &hooks, command).unwrap();

    // Verify annotation's work_path was updated
    let ann_content = fs::read_to_string(root.join("library/annotations/highlight-1.md")).unwrap();
    assert!(
        ann_content.contains("work_path = \"archive/my-paper.md\""),
        "expected work_path updated to archive/my-paper.md, got:\n{ann_content}"
    );
}

fn create_two_item_zotero_database(path: &std::path::Path) {
    let connection = rusqlite::Connection::open(path).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
            INSERT INTO itemTypes VALUES (2, 'book');
            INSERT INTO itemTypes VALUES (4, 'journalArticle');
            CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
            INSERT INTO fields VALUES (14, 'date');
            INSERT INTO fields VALUES (26, 'DOI');
            INSERT INTO fields VALUES (110, 'title');
            INSERT INTO fields VALUES (11, 'ISBN');
            CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
            INSERT INTO libraries VALUES (1, 'user');
            CREATE TABLE items (
                itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT,
                dateModified TEXT, clientDateModified TEXT, libraryID INT,
                key TEXT, version INT DEFAULT 0, synced INT DEFAULT 0
            );
            CREATE TABLE itemData (
                itemID INT, fieldID INT, valueID INT, PRIMARY KEY(itemID, fieldID)
            );
            CREATE TABLE itemDataValues (
                valueID INTEGER PRIMARY KEY, value TEXT UNIQUE
            );
            CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
            CREATE TABLE creators (
                creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT
            );
            CREATE TABLE creatorTypes (
                creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT
            );
            INSERT INTO creatorTypes VALUES (1, 'author');
            CREATE TABLE itemCreators (
                itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT
            );
            CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT UNIQUE);
            CREATE TABLE itemTags (itemID INT, tagID INT, type INT);
            CREATE TABLE collections (
                collectionID INTEGER PRIMARY KEY, collectionName TEXT,
                parentCollectionID INT, libraryID INT, key TEXT,
                version INT DEFAULT 0, synced INT DEFAULT 0,
                clientDateModified TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE collectionItems (collectionID INT, itemID INT, orderIndex INT);
            CREATE TABLE itemAttachments (
                itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT,
                contentType TEXT, charsetID INT, path TEXT,
                syncState INT DEFAULT 0, storageModTime INT, storageHash TEXT
            );

            INSERT INTO items VALUES (
                1, 4, '2024-01-01', '2024-06-15', '2024-06-15',
                1, 'FIRST001', 1, 0
            );
            INSERT INTO itemDataValues VALUES (1, 'First Work');
            INSERT INTO itemDataValues VALUES (2, '2024');
            INSERT INTO itemDataValues VALUES (3, '10.1234/first');
            INSERT INTO itemData VALUES (1, 110, 1);
            INSERT INTO itemData VALUES (1, 14, 2);
            INSERT INTO itemData VALUES (1, 26, 3);
            INSERT INTO creators VALUES (1, 'Ada', 'Alpha', 0);
            INSERT INTO itemCreators VALUES (1, 1, 1, 0);

            INSERT INTO items VALUES (
                2, 2, '2024-01-01', '2024-06-15', '2024-06-15',
                1, 'SECOND02', 1, 0
            );
            INSERT INTO itemDataValues VALUES (4, 'Second Work');
            INSERT INTO itemDataValues VALUES (5, '2023');
            INSERT INTO itemDataValues VALUES (6, '978-1234567890');
            INSERT INTO itemData VALUES (2, 110, 4);
            INSERT INTO itemData VALUES (2, 14, 5);
            INSERT INTO itemData VALUES (2, 11, 6);
            INSERT INTO creators VALUES (2, 'Ben', 'Beta', 0);
            INSERT INTO itemCreators VALUES (2, 2, 1, 0);
            ",
        )
        .unwrap();
}

#[tokio::test]
async fn zotero_item_two_update_failure_is_reported_without_rolling_back_item_one() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let fixture = ApiFixture::builder().build();
    let database = fixture.temp_dir.path().join("zotero.sqlite");
    create_two_item_zotero_database(&database);

    let first_response = fixture
        .server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": database.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;
    first_response.assert_status_ok();
    let first_body: serde_json::Value = first_response.json();
    let first_results = first_body["results"].as_array().unwrap();
    assert_eq!(first_results.len(), 2);
    assert!(first_results.iter().all(|result| result["status"] == "created"));
    let first_path = first_results[0]["page_path"].as_str().unwrap().to_string();
    let second_path = first_results[1]["page_path"].as_str().unwrap().to_string();

    let update_attempt = Arc::new(AtomicUsize::new(0));
    let vault_root_for_hook = fixture.temp_dir.path().join("vault");
    fixture
        .state
        .mutation_coordinator
        .set_before_update_publish_hook(Some(Arc::new({
            let update_attempt = Arc::clone(&update_attempt);
            move |path| {
                if update_attempt.fetch_add(1, Ordering::SeqCst) == 1 {
                    let absolute = vault_root_for_hook.join(path.as_str());
                    fs::remove_file(absolute).unwrap();
                }
            }
        })));

    let response = fixture
        .server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": database.to_string_lossy(),
            "auto_checkpoint": false,
            "conflict_policy": "source_wins"
        }))
        .await;

    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "every queried item needs one outcome");
    assert_eq!(results[0]["status"], "updated");
    assert_eq!(results[0]["page_path"], first_path);
    assert_eq!(results[1]["status"], "error");
    assert_eq!(results[1]["page_path"], second_path);
    assert!(
        results[1]["error"]
            .as_str()
            .unwrap()
            .contains("filesystem mutation failed"),
        "the item result must retain the actionable failure: {}",
        results[1]
    );

    let vault_root = fixture.temp_dir.path().join("vault");
    assert!(
        vault_root.join(&first_path).exists(),
        "item one stays committed"
    );
    assert!(
        !vault_root.join(&second_path).exists(),
        "the failed source-wins update must not recreate the externally removed item"
    );
}

#[tokio::test]
async fn zotero_item_two_provenance_failure_is_reported_after_item_one_commits() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let fixture = ApiFixture::builder().build();
    let database = fixture.temp_dir.path().join("zotero.sqlite");
    create_two_item_zotero_database(&database);
    let vault_root_for_hook = fixture.temp_dir.path().join("vault");
    let provenance_attempt = Arc::new(AtomicUsize::new(0));
    fixture
        .state
        .mutation_coordinator
        .set_before_update_publish_hook(Some(Arc::new({
            let provenance_attempt = Arc::clone(&provenance_attempt);
            move |path| {
                if provenance_attempt.fetch_add(1, Ordering::SeqCst) == 1 {
                    fs::remove_file(vault_root_for_hook.join(path.as_str())).unwrap();
                }
            }
        })));

    let response = fixture
        .server
        .post("/api/vault/academic/import/zotero")
        .json(&serde_json::json!({
            "database_path": database.to_string_lossy(),
            "auto_checkpoint": false
        }))
        .await;

    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "every queried item needs one outcome");
    assert_eq!(results[0]["status"], "created");
    assert_eq!(results[1]["status"], "error");
    assert_eq!(
        results[1]["page_path"], "library/books/second-work.md",
        "the failed item outcome must identify its independently committed path"
    );
    assert!(
        results[1]["error"]
            .as_str()
            .unwrap()
            .contains("filesystem mutation failed"),
        "the item result must retain the provenance failure: {}",
        results[1]
    );

    let vault_root = fixture.temp_dir.path().join("vault");
    let first_content =
        fs::read_to_string(vault_root.join("library/papers/first-work.md")).unwrap();
    assert!(
        first_content.contains("zotero_key = \"FIRST001\""),
        "item one must remain fully committed"
    );
    assert!(
        !vault_root.join("library/books/second-work.md").exists(),
        "the handler must not recreate item two after the injected external removal"
    );
}
