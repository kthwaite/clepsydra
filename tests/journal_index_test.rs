use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;

/// Helper: initialize a vault in a temp directory, write markdown files, and
/// return the TempDir (kept alive for the duration of the test) plus the Vault.
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

#[test]
fn indexes_journal_date_from_path() {
    let page =
        "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: \"2026-02-17\"\n---\n- Notes\n";
    let (_tmp, vault) = setup_vault(&[("journals/2026-02-17.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let date: Option<String> = index
        .connection()
        .query_row(
            "SELECT journal_date FROM pages WHERE id = ?1",
            ["00000000-0000-0000-0000-000000000001"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(date, Some("2026-02-17".to_string()));
}

#[test]
fn non_journal_page_has_null_journal_date() {
    let page = "---\nid: 00000000-0000-0000-0000-000000000002\ntitle: Regular\n---\nHello\n";
    let (_tmp, vault) = setup_vault(&[("notes/regular.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let date: Option<String> = index
        .connection()
        .query_row(
            "SELECT journal_date FROM pages WHERE id = ?1",
            ["00000000-0000-0000-0000-000000000002"],
            |r| r.get(0),
        )
        .unwrap();
    assert!(date.is_none());
}

#[test]
fn journal_in_subfolder_not_matched() {
    // A page at other/journals/2026-02-17.md should NOT be a journal
    let page = "---\nid: 00000000-0000-0000-0000-000000000003\ntitle: Fake\n---\n";
    let (_tmp, vault) = setup_vault(&[("other/journals/2026-02-17.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let date: Option<String> = index
        .connection()
        .query_row(
            "SELECT journal_date FROM pages WHERE id = ?1",
            ["00000000-0000-0000-0000-000000000003"],
            |r| r.get(0),
        )
        .unwrap();
    assert!(date.is_none());
}
