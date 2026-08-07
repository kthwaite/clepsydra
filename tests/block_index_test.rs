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
fn indexes_blocks_from_task_list() {
    let page = "---\nid: 00000000-0000-0000-0000-000000000001\ntitle: Tasks\n---\n- [ ] Buy milk [due:: 2026-03-01] [priority:: A] ^abc123DEF0\n- [x] Done task\n- Regular item\n";
    let (_tmp, vault) = setup_vault(&[("tasks.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let conn = index.connection();

    // Should have 3 blocks
    let block_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(block_count, 3);

    // First block should have block_id
    let (block_id, content): (Option<String>, String) = conn
        .query_row(
            "SELECT block_id, content FROM blocks WHERE page_id = ?1 ORDER BY order_index LIMIT 1",
            ["00000000-0000-0000-0000-000000000001"],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(block_id.as_deref(), Some("abc123DEF0"));
    assert_eq!(content, "Buy milk");

    // Check block_properties exist
    let prop_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM block_properties", [], |r| r.get(0))
        .unwrap();
    assert!(
        prop_count >= 3,
        "expected at least 3 properties (status+due+priority for first block), got {prop_count}"
    );

    // Check due property
    let due: String = conn
        .query_row(
            "SELECT bp.value FROM block_properties bp
             JOIN blocks b ON bp.page_id = b.page_id AND bp.span_start = b.span_start
             WHERE bp.key = 'due'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(due, "2026-03-01");
}

#[test]
fn indexes_nested_blocks_with_depth() {
    let page = "---\nid: 00000000-0000-0000-0000-000000000002\ntitle: Nested\n---\n- Parent\n  - Child one\n  - Child two\n";
    let (_tmp, vault) = setup_vault(&[("nested.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let conn = index.connection();

    let rows: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT content, depth FROM blocks ORDER BY order_index")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0], ("Parent".to_string(), 0));
    assert_eq!(rows[1], ("Child one".to_string(), 1));
    assert_eq!(rows[2], ("Child two".to_string(), 1));
}

#[test]
fn existing_index_tests_still_pass() {
    // Minimal sanity check that schema additions don't break existing pages table
    let page = "---\nid: 00000000-0000-0000-0000-000000000003\ntitle: Hello\ntags:\n  - test\n---\nSee [[World]].\n";
    let (_tmp, vault) = setup_vault(&[("hello.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    let stats = index.build(&vault).unwrap();
    assert_eq!(stats.pages_indexed, 1);
}

#[test]
fn encrypted_page_suppresses_blocks_and_word_count_even_when_armor_is_invalid() {
    let page = "+++\nid = \"019fd000-0000-7000-8000-000000000021\"\ntitle = \"Corrupt protected note\"\nencryption = { format = \"age\", version = 1, key_id = \"019fd000-0000-7000-8000-000000000002\" }\n+++\n- [ ] plaintext must not be indexed ^abc123DEF0\n";
    let (_tmp, vault) = setup_vault(&[("corrupt.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let (encrypted, word_count): (i64, Option<i64>) = index
        .connection()
        .query_row(
            "SELECT encrypted, word_count FROM pages WHERE path = 'corrupt.md'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((encrypted, word_count), (1, None));
    let block_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM blocks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(block_count, 0);
}
