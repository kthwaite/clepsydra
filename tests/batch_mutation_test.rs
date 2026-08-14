use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::batch_mutation::recover_pending;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::mutation::{MutationOp, MutationPlanner};
use clepsydra::vault::mutation_coordinator::{MutationCoordinator, MutationError};
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

#[test]
fn rubbish_archive_index_failure_recovers_the_authoritative_active_state() {
    let target = b"+++\nid = \"019fd000-0000-7000-8000-000000000101\"\ntitle = \"Target\"\n+++\nBody.\n";
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
    index.connection().execute_batch("DROP TABLE pages").unwrap();

    let error =
        MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap_err();
    assert!(matches!(error, MutationError::BatchRecovery { .. }));

    let recovered = recover_pending(vault.root()).unwrap();
    assert!(recovered.is_empty());
    assert_eq!(fs::read(vault.resolve(&path)).unwrap(), expected_bytes);
    assert!(RubbishStore::for_vault(vault.root())
        .read_item(&item_id.to_string())
        .is_err());
    assert!(index
        .rubbish_entry(&item_id.to_string())
        .unwrap()
        .is_none());
}

#[test]
fn rubbish_restore_index_failure_recovers_the_authoritative_item_state() {
    let target = b"+++\nid = \"019fd000-0000-7000-8000-000000000111\"\ntitle = \"Target\"\n+++\nBody.\n";
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
    index.connection().execute_batch("DROP TABLE pages").unwrap();

    let error =
        MutationCoordinator::execute_batch_direct(&vault, &mut index, &[], command).unwrap_err();
    assert!(matches!(error, MutationError::BatchRecovery { .. }));

    let recovered = recover_pending(vault.root()).unwrap();
    assert!(recovered.is_empty());
    assert!(!vault.resolve(&path).exists());
    assert_eq!(store.read_item(&item_id.to_string()).unwrap(), item);
    assert!(index
        .rubbish_entry(&item_id.to_string())
        .unwrap()
        .is_some());
}

#[test]
fn rubbish_batch_preflights_every_item_before_staging_or_publication() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("vault");
    init_vault(&root).unwrap();
    let first = b"+++\nid = \"019fd000-0000-7000-8000-000000000171\"\ntitle = \"First\"\n+++\nFirst.\n";
    let second = b"+++\nid = \"019fd000-0000-7000-8000-000000000172\"\ntitle = \"Second\"\n+++\nSecond.\n";
    fs::write(root.join("first.md"), first).unwrap();
    fs::write(root.join("second.md"), second).unwrap();
    let vault = Vault::open(&root).unwrap();
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    let first_path = VaultPath::new("first.md").unwrap();
    let second_path = VaultPath::new("second.md").unwrap();
    let first_bytes = fs::read(vault.resolve(&first_path)).unwrap();
    let second_bytes = fs::read(vault.resolve(&second_path)).unwrap();
    let first_item_id =
        Uuid::parse_str("019fd000-0000-7000-8000-000000000173").unwrap();
    let second_item_id =
        Uuid::parse_str("019fd000-0000-7000-8000-000000000174").unwrap();
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
    assert!(RubbishStore::for_vault(vault.root())
        .list_entries()
        .unwrap()
        .is_empty());
}
