use clepsydra::vault::checkpoint::ImportCheckpoint;
use tempfile::TempDir;

#[test]
fn checkpoint_round_trip() {
    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path();
    let loaded = ImportCheckpoint::load(vault_root, "zotero");
    assert!(loaded.is_none());

    let cp = ImportCheckpoint {
        last_synced: "2024-06-15 12:30:00".to_string(),
        items_imported: 42,
    };
    cp.save(vault_root, "zotero").unwrap();

    let loaded = ImportCheckpoint::load(vault_root, "zotero").unwrap();
    assert_eq!(loaded.last_synced, "2024-06-15 12:30:00");
    assert_eq!(loaded.items_imported, 42);
}

#[test]
fn checkpoint_overwrites_previous() {
    let tmp = TempDir::new().unwrap();
    let vault_root = tmp.path();

    let cp1 = ImportCheckpoint {
        last_synced: "2024-01-01 00:00:00".to_string(),
        items_imported: 10,
    };
    cp1.save(vault_root, "zotero").unwrap();

    let cp2 = ImportCheckpoint {
        last_synced: "2024-06-15 12:30:00".to_string(),
        items_imported: 25,
    };
    cp2.save(vault_root, "zotero").unwrap();

    let loaded = ImportCheckpoint::load(vault_root, "zotero").unwrap();
    assert_eq!(loaded.last_synced, "2024-06-15 12:30:00");
    assert_eq!(loaded.items_imported, 25);
}
