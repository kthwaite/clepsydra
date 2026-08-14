use std::fs;
use std::sync::Arc;

use clepsydra::vault::Vault;
use clepsydra::vault::batch_mutation::recover_pending;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{MutationOp, MutationPlanner};
use clepsydra::vault::mutation_coordinator::{
    MutationCoordinator, MutationError, MutationNotification,
};
use clepsydra::vault::path::VaultPath;
use clepsydra::vault::rubbish::{RubbishManifest, RubbishStore};
use tempfile::TempDir;
use uuid::Uuid;

fn setup_vault(path: &str, content: &[u8]) -> (TempDir, Vault) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    init_vault(&root).unwrap();
    fs::write(root.join(path), content).unwrap();
    let vault = Vault::open(&root).unwrap();
    (temp, vault)
}

fn transaction_workspace_count(vault: &Vault) -> usize {
    fs::read_dir(vault.root().join(".clepsydra/transactions"))
        .unwrap()
        .count()
}

fn indexed_page_count(db_path: &std::path::Path, path: &str) -> i64 {
    rusqlite::Connection::open(db_path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM pages WHERE path = ?1",
            [path],
            |row| row.get(0),
        )
        .unwrap()
}

fn indexed_catalog_count(db_path: &std::path::Path, item_id: Uuid) -> i64 {
    rusqlite::Connection::open(db_path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM rubbish_items WHERE item_id = ?1",
            [item_id.to_string()],
            |row| row.get(0),
        )
        .unwrap()
}

fn indexed_link_target(db_path: &std::path::Path, source_id: Uuid) -> Option<String> {
    rusqlite::Connection::open(db_path)
        .unwrap()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = ?1",
            [source_id.to_string()],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn rubbish_archive_index_failure_recovers_the_authoritative_active_state() {
    let target =
        b"+++\nid = \"019fd000-0000-7000-8000-000000000101\"\ntitle = \"Target\"\n+++\nBody.\n";
    let (_temp, vault) = setup_vault("target.md", target);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    let path = VaultPath::new("target.md").unwrap();
    let expected_bytes = fs::read(vault.resolve(&path)).unwrap();
    let item_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000102").unwrap();
    let manifest = RubbishManifest::new(
        item_id,
        Uuid::parse_str("019fd000-0000-7000-8000-000000000101").unwrap(),
        path.as_str(),
        "Target",
        "note",
        "2026-08-14T12:00:00Z".parse().unwrap(),
        None,
    )
    .unwrap();
    let command = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::ArchivePage {
            path: path.as_str().to_owned(),
            expected_bytes: expected_bytes.clone(),
            manifest,
        })
        .unwrap()
        .into_batch_command(&vault)
        .unwrap();
    index
        .connection()
        .execute_batch("DROP TABLE pages")
        .unwrap();

    let error =
        MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap_err();
    assert!(matches!(error, MutationError::BatchRecovery { .. }));

    let recovered = recover_pending(vault.root()).unwrap();
    assert!(recovered.is_empty());
    assert_eq!(fs::read(vault.resolve(&path)).unwrap(), expected_bytes);
    assert!(
        RubbishStore::for_vault(vault.root())
            .read_item(&item_id.to_string())
            .is_err()
    );
    assert!(index.rubbish_entry(&item_id.to_string()).unwrap().is_none());
}

#[test]
fn rubbish_restore_index_failure_recovers_the_authoritative_item_state() {
    let target =
        b"+++\nid = \"019fd000-0000-7000-8000-000000000111\"\ntitle = \"Target\"\n+++\nBody.\n";
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    init_vault(&root).unwrap();
    let vault = Vault::open(&root).unwrap();
    let path = VaultPath::new("target.md").unwrap();
    let item_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000112").unwrap();
    let manifest = RubbishManifest::new(
        item_id,
        Uuid::parse_str("019fd000-0000-7000-8000-000000000111").unwrap(),
        path.as_str(),
        "Target",
        "note",
        "2026-08-14T12:00:00Z".parse().unwrap(),
        None,
    )
    .unwrap();
    let store = RubbishStore::for_vault(vault.root());
    let mut prepared = store
        .prepare_item(&item_id.to_string(), &manifest, target)
        .unwrap();
    prepared.publish().unwrap();
    let item = store.read_item(&item_id.to_string()).unwrap();
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    let command = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::RestorePage { item: item.clone() })
        .unwrap()
        .into_batch_command(&vault)
        .unwrap();
    index
        .connection()
        .execute_batch("DROP TABLE pages")
        .unwrap();

    let error =
        MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap_err();
    assert!(matches!(error, MutationError::BatchRecovery { .. }));

    let recovered = recover_pending(vault.root()).unwrap();
    assert!(recovered.is_empty());
    assert!(!vault.resolve(&path).exists());
    assert_eq!(store.read_item(&item_id.to_string()).unwrap(), item);
    assert!(index.rubbish_entry(&item_id.to_string()).unwrap().is_some());
}

#[test]
fn rubbish_batch_preflights_every_item_before_staging_or_publication() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    init_vault(&root).unwrap();
    let first =
        b"+++\nid = \"019fd000-0000-7000-8000-000000000171\"\ntitle = \"First\"\n+++\nFirst.\n";
    let second =
        b"+++\nid = \"019fd000-0000-7000-8000-000000000172\"\ntitle = \"Second\"\n+++\nSecond.\n";
    fs::write(root.join("first.md"), first).unwrap();
    fs::write(root.join("second.md"), second).unwrap();
    let vault = Vault::open(&root).unwrap();
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    let first_path = VaultPath::new("first.md").unwrap();
    let second_path = VaultPath::new("second.md").unwrap();
    let first_bytes = fs::read(vault.resolve(&first_path)).unwrap();
    let second_bytes = fs::read(vault.resolve(&second_path)).unwrap();
    let first_item_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000173").unwrap();
    let second_item_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000174").unwrap();
    let first_manifest = RubbishManifest::new(
        first_item_id,
        Uuid::parse_str("019fd000-0000-7000-8000-000000000171").unwrap(),
        first_path.as_str(),
        "First",
        "note",
        "2026-08-14T12:00:00Z".parse().unwrap(),
        None,
    )
    .unwrap();
    let second_manifest = RubbishManifest::new(
        second_item_id,
        Uuid::parse_str("019fd000-0000-7000-8000-000000000172").unwrap(),
        second_path.as_str(),
        "Second",
        "note",
        "2026-08-14T12:00:01Z".parse().unwrap(),
        None,
    )
    .unwrap();
    let mut command = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::ArchivePage {
            path: first_path.as_str().to_owned(),
            expected_bytes: first_bytes.clone(),
            manifest: first_manifest,
        })
        .unwrap()
        .into_batch_command(&vault)
        .unwrap();
    let second_command = MutationPlanner::new(&vault, &index)
        .plan(&MutationOp::ArchivePage {
            path: second_path.as_str().to_owned(),
            expected_bytes: second_bytes,
            manifest: second_manifest,
        })
        .unwrap()
        .into_batch_command(&vault)
        .unwrap();
    command.intents.extend(second_command.intents);
    command.index_events.extend(second_command.index_events);
    fs::write(vault.resolve(&second_path), b"drifted").unwrap();

    let error =
        MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap_err();

    assert!(matches!(
        error,
        MutationError::Conflict(message) if message.contains("second.md")
    ));
    assert_eq!(fs::read(vault.resolve(&first_path)).unwrap(), first_bytes);
    assert_eq!(fs::read(vault.resolve(&second_path)).unwrap(), b"drifted");
    assert!(
        RubbishStore::for_vault(vault.root())
            .list_entries()
            .unwrap()
            .is_empty()
    );
}

struct ArchiveIndexFailureFixture {
    _temp: TempDir,
    vault: Vault,
    db_path: std::path::PathBuf,
    path: VaultPath,
    item_id: Uuid,
    page_id: Uuid,
    backlink_id: Uuid,
    expected_bytes: Vec<u8>,
    notifications: Arc<parking_lot::Mutex<Vec<MutationNotification>>>,
    error: MutationError,
}

async fn execute_archive_index_failure(trigger_sql: &str) -> ArchiveIndexFailureFixture {
    let target =
        b"+++\nid = \"019fd000-0000-7000-8000-000000000241\"\ntitle = \"Target\"\n+++\nBody.\n";
    let backlink = b"+++\nid = \"019fd000-0000-7000-8000-000000000242\"\ntitle = \"Backlink\"\n+++\nSee [[Target]].\n";
    let (temp, vault) = setup_vault("target.md", target);
    fs::write(vault.root().join("backlink.md"), backlink).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut raw_index = VaultIndex::open(&db_path).unwrap();
    raw_index.build(&vault).unwrap();
    raw_index.resolve_links().unwrap();
    let path = VaultPath::new("target.md").unwrap();
    let expected_bytes = fs::read(vault.resolve(&path)).unwrap();
    let page_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000241").unwrap();
    let backlink_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000242").unwrap();
    let item_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000243").unwrap();
    let manifest = RubbishManifest::new(
        item_id,
        page_id,
        path.as_str(),
        "Target",
        "note",
        "2026-08-14T12:00:00Z".parse().unwrap(),
        None,
    )
    .unwrap();
    let command = MutationPlanner::new(&vault, &raw_index)
        .plan(&MutationOp::ArchivePage {
            path: path.as_str().to_owned(),
            expected_bytes: expected_bytes.clone(),
            manifest,
        })
        .unwrap()
        .into_batch_command(&vault)
        .unwrap();
    raw_index.connection().execute_batch(trigger_sql).unwrap();
    let index = IndexHandle::spawn(raw_index, vault.clone());
    let notifications = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let observed = Arc::clone(&notifications);
    let error = MutationCoordinator::new()
        .execute_batch(
            &vault,
            &index,
            Arc::new(Vec::new()),
            command,
            Arc::new(move |notification| observed.lock().push(notification)),
        )
        .await
        .unwrap_err();

    ArchiveIndexFailureFixture {
        _temp: temp,
        vault,
        db_path,
        path,
        item_id,
        page_id,
        backlink_id,
        expected_bytes,
        notifications,
        error,
    }
}

struct RestoreIndexFailureFixture {
    _temp: TempDir,
    vault: Vault,
    db_path: std::path::PathBuf,
    path: VaultPath,
    item_id: Uuid,
    backlink_id: Uuid,
    item: clepsydra::vault::rubbish::RubbishItem,
    notifications: Arc<parking_lot::Mutex<Vec<MutationNotification>>>,
    error: MutationError,
}

async fn execute_restore_index_failure(trigger_sql: &str) -> RestoreIndexFailureFixture {
    let target =
        b"+++\nid = \"019fd000-0000-7000-8000-000000000261\"\ntitle = \"Target\"\n+++\nBody.\n";
    let backlink = b"+++\nid = \"019fd000-0000-7000-8000-000000000262\"\ntitle = \"Backlink\"\n+++\nSee [[Target]].\n";
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    init_vault(&root).unwrap();
    fs::write(root.join("backlink.md"), backlink).unwrap();
    let vault = Vault::open(&root).unwrap();
    let path = VaultPath::new("target.md").unwrap();
    let page_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000261").unwrap();
    let backlink_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000262").unwrap();
    let item_id = Uuid::parse_str("019fd000-0000-7000-8000-000000000263").unwrap();
    let manifest = RubbishManifest::new(
        item_id,
        page_id,
        path.as_str(),
        "Target",
        "note",
        "2026-08-14T12:00:00Z".parse().unwrap(),
        None,
    )
    .unwrap();
    let store = RubbishStore::for_vault(vault.root());
    let mut prepared = store
        .prepare_item(&item_id.to_string(), &manifest, target)
        .unwrap();
    prepared.publish().unwrap();
    let item = store.read_item(&item_id.to_string()).unwrap();
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut raw_index = VaultIndex::open(&db_path).unwrap();
    raw_index.build(&vault).unwrap();
    raw_index.resolve_links().unwrap();
    let command = MutationPlanner::new(&vault, &raw_index)
        .plan(&MutationOp::RestorePage { item: item.clone() })
        .unwrap()
        .into_batch_command(&vault)
        .unwrap();
    raw_index.connection().execute_batch(trigger_sql).unwrap();
    let index = IndexHandle::spawn(raw_index, vault.clone());
    let notifications = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let observed = Arc::clone(&notifications);
    let error = MutationCoordinator::new()
        .execute_batch(
            &vault,
            &index,
            Arc::new(Vec::new()),
            command,
            Arc::new(move |notification| observed.lock().push(notification)),
        )
        .await
        .unwrap_err();

    RestoreIndexFailureFixture {
        _temp: temp,
        vault,
        db_path,
        path,
        item_id,
        backlink_id,
        item,
        notifications,
        error,
    }
}

#[tokio::test]
async fn rubbish_archive_catalog_failure_rolls_back_the_entire_index_unit() {
    let fixture = execute_archive_index_failure(
        "CREATE TRIGGER fail_rubbish_catalog
         BEFORE INSERT ON rubbish_items
         BEGIN SELECT RAISE(ABORT, 'catalog failure'); END;",
    )
    .await;

    assert!(matches!(fixture.error, MutationError::BatchRecovery { .. }));
    assert!(!fixture.vault.resolve(&fixture.path).exists());
    assert!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .is_ok()
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 1);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 1);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 0);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        Some(fixture.page_id.to_string())
    );
    assert!(fixture.notifications.lock().is_empty());

    assert!(recover_pending(fixture.vault.root()).unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.vault.resolve(&fixture.path)).unwrap(),
        fixture.expected_bytes
    );
    assert!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .is_err()
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 0);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 1);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 0);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        Some(fixture.page_id.to_string())
    );
    assert!(fixture.notifications.lock().is_empty());
}

#[tokio::test]
async fn rubbish_archive_link_failure_rolls_back_page_catalog_and_links_together() {
    let fixture = execute_archive_index_failure(
        "CREATE TABLE lifecycle_failure_probe (armed INTEGER NOT NULL);
         INSERT INTO lifecycle_failure_probe VALUES (0);
         CREATE TRIGGER arm_after_archive_page
         AFTER DELETE ON pages WHEN OLD.path = 'target.md'
         BEGIN UPDATE lifecycle_failure_probe SET armed = 1; END;
         CREATE TRIGGER fail_archive_link_work
         BEFORE UPDATE OF target_path ON links
         WHEN (SELECT armed FROM lifecycle_failure_probe) = 1
         BEGIN SELECT RAISE(ABORT, 'link failure'); END;",
    )
    .await;

    assert!(matches!(fixture.error, MutationError::BatchRecovery { .. }));
    assert!(!fixture.vault.resolve(&fixture.path).exists());
    assert!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .is_ok()
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 1);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 1);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 0);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        Some(fixture.page_id.to_string())
    );
    assert!(fixture.notifications.lock().is_empty());

    assert!(recover_pending(fixture.vault.root()).unwrap().is_empty());
    assert_eq!(
        fs::read(fixture.vault.resolve(&fixture.path)).unwrap(),
        fixture.expected_bytes
    );
    assert!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .is_err()
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 0);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 1);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 0);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        Some(fixture.page_id.to_string())
    );
    assert!(fixture.notifications.lock().is_empty());
}

#[tokio::test]
async fn rubbish_restore_catalog_failure_rolls_back_the_entire_index_unit() {
    let fixture = execute_restore_index_failure(
        "CREATE TRIGGER fail_rubbish_catalog
         BEFORE DELETE ON rubbish_items
         BEGIN SELECT RAISE(ABORT, 'catalog failure'); END;",
    )
    .await;

    assert!(matches!(fixture.error, MutationError::BatchRecovery { .. }));
    assert_eq!(
        fs::read(fixture.vault.resolve(&fixture.path)).unwrap(),
        fixture.item.bytes
    );
    assert!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .is_err()
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 1);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 0);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 1);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        None
    );
    assert!(fixture.notifications.lock().is_empty());

    assert!(recover_pending(fixture.vault.root()).unwrap().is_empty());
    assert!(!fixture.vault.resolve(&fixture.path).exists());
    assert_eq!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .unwrap(),
        fixture.item
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 0);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 0);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 1);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        None
    );
    assert!(fixture.notifications.lock().is_empty());
}

#[tokio::test]
async fn rubbish_restore_link_failure_rolls_back_page_catalog_and_links_together() {
    let fixture = execute_restore_index_failure(
        "CREATE TABLE lifecycle_failure_probe (armed INTEGER NOT NULL);
         INSERT INTO lifecycle_failure_probe VALUES (0);
         CREATE TRIGGER arm_after_restore_page
         AFTER INSERT ON pages WHEN NEW.path = 'target.md'
         BEGIN UPDATE lifecycle_failure_probe SET armed = 1; END;
         CREATE TRIGGER fail_restore_link_work
         BEFORE UPDATE OF target_path ON links
         WHEN (SELECT armed FROM lifecycle_failure_probe) = 1
         BEGIN SELECT RAISE(ABORT, 'link failure'); END;",
    )
    .await;

    assert!(matches!(fixture.error, MutationError::BatchRecovery { .. }));
    assert_eq!(
        fs::read(fixture.vault.resolve(&fixture.path)).unwrap(),
        fixture.item.bytes
    );
    assert!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .is_err()
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 1);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 0);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 1);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        None
    );
    assert!(fixture.notifications.lock().is_empty());

    assert!(recover_pending(fixture.vault.root()).unwrap().is_empty());
    assert!(!fixture.vault.resolve(&fixture.path).exists());
    assert_eq!(
        RubbishStore::for_vault(fixture.vault.root())
            .read_item(&fixture.item_id.to_string())
            .unwrap(),
        fixture.item
    );
    assert_eq!(transaction_workspace_count(&fixture.vault), 0);
    assert_eq!(indexed_page_count(&fixture.db_path, "target.md"), 0);
    assert_eq!(indexed_catalog_count(&fixture.db_path, fixture.item_id), 1);
    assert_eq!(
        indexed_link_target(&fixture.db_path, fixture.backlink_id),
        None
    );
    assert!(fixture.notifications.lock().is_empty());
}
