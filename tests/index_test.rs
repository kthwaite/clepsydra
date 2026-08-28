use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use clepsydra::vault::Vault;
use clepsydra::vault::config::DisambiguationStrategy;
use clepsydra::vault::derivation::{Deriver, IndexedPage};
use clepsydra::vault::index::{IndexError, UnresolvedReason, VaultIndex, reserve_code_number};
use clepsydra::vault::init::init_vault;
use clepsydra::vault::path::VaultPath;
use clepsydra::vault::query::{QueryContext, QueryOutput, QuerySpec, evaluate};
use clepsydra::vault::rubbish::{RubbishListEntry, RubbishManifest, RubbishStore};
use clepsydra::vault::tree::load_note_meta;
use rusqlite::Connection;
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

const ENCRYPTED_PAGE_ID: &str = "019fd000-0000-7000-8000-000000000011";
const ENCRYPTION_KEY_ID: &str = "019fd000-0000-7000-8000-000000000002";

fn protected_page(id: &str, title: &str) -> String {
    format!(
        "+++\nid = \"{id}\"\ntitle = \"{title}\"\nstatus = \"private\"\nencryption = {{ format = \"age\", version = 1, key_id = \"{ENCRYPTION_KEY_ID}\" }}\n+++\n{}",
        include_str!("support/fixtures/private-note.age")
    )
}

// -----------------------------------------------------------------------
// Task 12: schema creation
// -----------------------------------------------------------------------

#[test]
fn creates_schema_on_open() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("cache.db");
    let index = VaultIndex::open(&db_path).unwrap();

    // All 4 tables should exist and be queryable
    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);

    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn creates_parent_directories() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("deep/nested/cache.db");
    let _index = VaultIndex::open(&db_path).unwrap();
    assert!(db_path.exists());
}

#[test]
fn encrypted_column_forward_migration_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("old-cache.db");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE pages (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                title TEXT,
                canonical_name TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                meta_json TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                journal_date TEXT
            );
            INSERT INTO pages (id, path, title, canonical_name, meta_json, content_hash)
            VALUES ('old', 'old.md', 'Old', 'old', '{}', 'hash');",
        )
        .unwrap();
    }

    for _ in 0..2 {
        let index = VaultIndex::open(&db_path).unwrap();
        let column: (String, i64, Option<String>) = index
            .connection()
            .prepare("PRAGMA table_info(pages)")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .find_map(|(name, ty, not_null, default)| {
                (name == "encrypted").then_some((ty, not_null, default))
            })
            .expect("encrypted column should exist");
        assert_eq!(column, ("INTEGER".into(), 1, Some("0".into())));
        let encrypted: i64 = index
            .connection()
            .query_row("SELECT encrypted FROM pages WHERE id = 'old'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(encrypted, 0);
    }
}

#[test]
fn encrypted_page_suppresses_body_derived_index_data() {
    let page = protected_page(ENCRYPTED_PAGE_ID, "Private note");
    let (_tmp, vault) = setup_vault(&[("private.md", &page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();

    let (encrypted, word_count): (i64, Option<i64>) = index
        .connection()
        .query_row(
            "SELECT encrypted, word_count FROM pages WHERE id = ?1",
            [ENCRYPTED_PAGE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(encrypted, 1);
    assert_eq!(word_count, None);
    for (table, id_column) in [("links", "source_id"), ("blocks", "page_id")] {
        let count: i64 = index
            .connection()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {id_column} = ?1"),
                [ENCRYPTED_PAGE_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table} must have no body-derived rows");
    }
    let fts_body: String = index
        .connection()
        .query_row(
            "SELECT body FROM pages_fts WHERE page_id = ?1",
            [ENCRYPTED_PAGE_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert!(fts_body.is_empty());
    assert!(index.search("unique-secret-term", 20).unwrap().is_empty());
    assert!(
        index
            .search("YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0", 20)
            .unwrap()
            .is_empty()
    );
    assert_eq!(index.search("Private note", 20).unwrap().len(), 1);

    let property_count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM page_properties WHERE page_id = ?1 AND key = 'status'",
            [ENCRYPTED_PAGE_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(property_count, 1, "clear properties remain indexable");

    let tree_meta = load_note_meta(&index).unwrap();
    let private = tree_meta.get("private.md").unwrap();
    assert!(private.encrypted);
    assert_eq!(private.word_count, None);
}

#[test]
fn encrypted_transition_deletes_prior_body_derived_rows() {
    let plain = format!(
        "+++\nid = \"{ENCRYPTED_PAGE_ID}\"\ntitle = \"Private note\"\n+++\n# Hidden heading\nuniquesecretterm [[Target]]\n- secret task ^abc123DEF0\n"
    );
    let (_tmp, vault) = setup_vault(&[("private.md", &plain)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let body_links: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE source_id = ?1",
            [ENCRYPTED_PAGE_ID],
            |row| row.get(0),
        )
        .unwrap();
    let blocks: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM blocks WHERE page_id = ?1",
            [ENCRYPTED_PAGE_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert!(body_links > 0);
    assert!(blocks > 0);
    assert_eq!(index.search("uniquesecretterm", 20).unwrap().len(), 1);

    fs::write(
        vault.root().join("private.md"),
        protected_page(ENCRYPTED_PAGE_ID, "Private note"),
    )
    .unwrap();
    assert!(
        index
            .index_page(&vault, &VaultPath::new("private.md").unwrap())
            .unwrap()
    );

    let (encrypted, word_count): (i64, Option<i64>) = index
        .connection()
        .query_row(
            "SELECT encrypted, word_count FROM pages WHERE id = ?1",
            [ENCRYPTED_PAGE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((encrypted, word_count), (1, None));
    for (table, id_column) in [("links", "source_id"), ("blocks", "page_id")] {
        let count: i64 = index
            .connection()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {id_column} = ?1"),
                [ENCRYPTED_PAGE_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "stale {table} rows must be deleted");
    }
    assert!(index.search("uniquesecretterm", 20).unwrap().is_empty());
    assert_eq!(index.search("Private note", 20).unwrap().len(), 1);
}

// -----------------------------------------------------------------------
// Task 13: index builder
// -----------------------------------------------------------------------

#[test]
fn build_index_from_test_vault() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000001
title: Hello
tags:
  - greeting
aliases:
  - hi
---
See [[World]] for details.
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000002
title: World
tags:
  - place
---
Back to [[Hello]].
"#;

    let (_tmp, vault) = setup_vault(&[("hello.md", page_a), ("world.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let stats = index.build(&vault).unwrap();

    assert_eq!(stats.pages_indexed, 2);
    assert_eq!(stats.pages_skipped, 0);
    assert_eq!(stats.pages_removed, 0);

    // Verify pages
    let page_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(page_count, 2);

    // Verify links (body links only: one wiki link per page)
    let link_count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE kind = 'wiki' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_count, 2, "expected 2 wiki links from body text");

    // Verify stored and computed Kind tags
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        tag_count, 4,
        "expected two stored tags plus one computed Kind tag per page"
    );

    // Verify canonical_names entries exist for titles and filenames
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    // Page A: title("hello") + filename("hello") (same, deduped by PK) + alias("hi") = 2
    // Page B: title("world") + filename("world") (same, deduped by PK) = 1
    // Total = 3
    assert!(
        cn_count >= 3,
        "expected at least 3 canonical_names, got {cn_count}"
    );
}

#[test]
fn incremental_index_skips_unchanged() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000003
title: Stable
---
No changes here.
"#;

    let (_tmp, vault) = setup_vault(&[("stable.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // First build
    let stats1 = index.build(&vault).unwrap();
    assert_eq!(stats1.pages_indexed, 1);
    assert_eq!(stats1.pages_skipped, 0);

    // Second build without changes
    let stats2 = index.build(&vault).unwrap();
    assert_eq!(stats2.pages_indexed, 0, "unchanged pages should be skipped");
    assert_eq!(stats2.pages_skipped, 1);
}

#[test]
fn removed_pages_are_pruned() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000004
title: Ephemeral
---
Will be deleted.
"#;

    let (_tmp, vault) = setup_vault(&[("ephemeral.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // Build with file present
    let stats1 = index.build(&vault).unwrap();
    assert_eq!(stats1.pages_indexed, 1);

    // Remove the file
    fs::remove_file(vault.root().join("ephemeral.md")).unwrap();

    // Rebuild
    let stats2 = index.build(&vault).unwrap();
    assert_eq!(stats2.pages_removed, 1);

    let page_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(page_count, 0);
}

// -----------------------------------------------------------------------
// Task 14: link resolution
// -----------------------------------------------------------------------

#[test]
fn resolves_links_via_canonical_names() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-00000000000a
title: Greeting
---
See [[World]] for more.
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-00000000000b
title: World
---
Content here.
"#;

    let (_tmp, vault) = setup_vault(&[("greeting.md", page_a), ("world.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // The link from page A targeting "World" should now be resolved to page B's UUID
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-00000000000a' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        target_id.as_deref(),
        Some("00000000-0000-0000-0000-00000000000b"),
        "link should resolve to page B"
    );
}

#[test]
fn noncanonical_uuid_targets_resolve_exactly_before_canonical_aliases() {
    const TARGET_ID: &str = "019fd000-0000-7000-8000-000000000721";
    const TARGET_REFERENCE: &str = "019fd000000070008000000000000721";
    let source = format!(
        "---\nid: 019fd000-0000-7000-8000-000000000720\ntitle: Source\n---\nSee [[{TARGET_REFERENCE}|selected]].\n"
    );
    let target = format!("---\nid: {TARGET_ID}\ntitle: Selected Target\n---\nSelected.\n");
    let decoy = format!(
        "---\nid: 019fd000-0000-7000-8000-000000000722\ntitle: Alias Decoy\naliases:\n  - {TARGET_REFERENCE}\n---\nDecoy.\n"
    );
    let (_tmp, vault) = setup_vault(&[
        ("source.md", &source),
        ("target.md", &target),
        ("decoy.md", &decoy),
    ]);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let (target_id, target_path): (Option<String>, Option<String>) = index
        .connection()
        .query_row(
            "SELECT target_id, target_path
             FROM links
             WHERE source_id = '019fd000-0000-7000-8000-000000000720'
               AND span_start >= 0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(target_id.as_deref(), Some(TARGET_ID));
    assert_eq!(target_path.as_deref(), Some("target.md"));
}

#[test]
fn uuid_shaped_targets_fall_back_to_unique_canonical_names_without_an_exact_id() {
    const UUID_TITLE: &str = "019fd000-0000-7000-8000-000000000723";
    let source = format!(
        "---\nid: 019fd000-0000-7000-8000-000000000724\ntitle: Source\n---\nSee [[{UUID_TITLE}]].\n"
    );
    let canonical_target = format!(
        "---\nid: 019fd000-0000-7000-8000-000000000725\ntitle: {UUID_TITLE}\n---\nCanonical target.\n"
    );
    let (_tmp, vault) = setup_vault(&[("source.md", &source), ("canonical.md", &canonical_target)]);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let (target_id, target_path): (Option<String>, Option<String>) = index
        .connection()
        .query_row(
            "SELECT target_id, target_path
             FROM links
             WHERE source_id = '019fd000-0000-7000-8000-000000000724'
               AND span_start >= 0",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        target_id.as_deref(),
        Some("019fd000-0000-7000-8000-000000000725")
    );
    assert_eq!(target_path.as_deref(), Some("canonical.md"));
}

#[test]
fn ambiguous_links_stay_unresolved() {
    // Two pages with title "Design"
    let page_a = r#"---
id: 00000000-0000-0000-0000-0000000000a1
title: Design
---
First design page.
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-0000000000b1
title: Design
---
Second design page.
"#;

    // A third page links to [[Design]]
    let page_c = r#"---
id: 00000000-0000-0000-0000-0000000000c1
title: Notes
---
See [[Design]] for details.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("design-a.md", page_a),
        ("design-b.md", page_b),
        ("notes.md", page_c),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // The link from page C should remain unresolved because "design" is ambiguous
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-0000000000c1' AND target_canonical = 'design' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        target_id, None,
        "ambiguous link should stay unresolved (NULL target_id)"
    );
}

// -----------------------------------------------------------------------
// Task 15: duplicate UUID detection and resolution
// -----------------------------------------------------------------------

#[test]
fn build_with_derivers_produces_same_results() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000001
title: Hello
tags:
  - greeting
aliases:
  - hi
---
See [[World]] for details.
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000002
title: World
tags:
  - place
---
Back to [[Hello]].
"#;

    let (_tmp, vault) = setup_vault(&[("hello.md", page_a), ("world.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let stats = index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    assert_eq!(stats.pages_indexed, 2);

    // Canonical names: title("hello") + filename("hello") dedup + alias("hi") = 2 for page A
    //                  title("world") + filename("world") dedup = 1 for page B
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert!(
        cn_count >= 3,
        "expected at least 3 canonical_names, got {cn_count}"
    );

    // Body links: 2 wiki links
    let link_count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE kind = 'wiki' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_count, 2);

    // Property ref links: tags + aliases produce property_ref links
    let prop_count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE kind = 'property_ref'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Page A: tags=["greeting"], aliases=["hi"] -> 2 prop refs
    // Page B: tags=["place"] -> 1 prop ref
    assert_eq!(prop_count, 3, "expected 3 property ref links");

    // Tags: two stored tags plus one computed Kind tag per page.
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 4);

    // Link resolution: [[World]] from page A should resolve to page B
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000001' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        target_id.as_deref(),
        Some("00000000-0000-0000-0000-000000000002")
    );
}

// -----------------------------------------------------------------------
// Task 15: duplicate UUID detection and resolution
// -----------------------------------------------------------------------

#[test]
fn duplicate_uuid_resolved_by_created_at() {
    let shared_uuid = "01936e1a-5c4a-7000-8000-000000000099";

    // older.md has earlier created_at
    let older_content = format!(
        "---\nid: \"{shared_uuid}\"\ntitle: \"Older\"\ncreated_at: \"2026-01-01T00:00:00Z\"\n---\nOlder content.\n"
    );

    // newer.md has later created_at
    let newer_content = format!(
        "---\nid: \"{shared_uuid}\"\ntitle: \"Newer\"\ncreated_at: \"2026-02-01T00:00:00Z\"\n---\nNewer content.\n"
    );

    let (_tmp, vault) = setup_vault(&[("older.md", &older_content), ("newer.md", &newer_content)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    let stats = index.build(&vault).unwrap();

    // Should have a duplicate UUID warning
    assert!(
        stats.warnings.iter().any(|w| {
            let lower = w.to_lowercase();
            lower.contains("duplicate") || lower.contains("uuid")
        }),
        "expected a duplicate/uuid warning, got: {:?}",
        stats.warnings
    );

    // Two distinct pages in DB
    let count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);

    // newer.md on disk should have a DIFFERENT UUID now
    let newer_on_disk = fs::read_to_string(vault.root().join("newer.md")).unwrap();
    assert!(
        !newer_on_disk.contains(shared_uuid),
        "newer.md should have gotten a new UUID, but still contains {shared_uuid}"
    );

    // older.md should still have the original UUID
    let older_on_disk = fs::read_to_string(vault.root().join("older.md")).unwrap();
    assert!(
        older_on_disk.contains(shared_uuid),
        "older.md should keep the original UUID"
    );

    // Idempotent: re-indexing should produce the same outcome with no further warnings
    let stats2 = index.build(&vault).unwrap();
    let dup_warnings: Vec<_> = stats2
        .warnings
        .iter()
        .filter(|w| w.to_lowercase().contains("duplicate"))
        .collect();
    assert!(
        dup_warnings.is_empty(),
        "re-index should produce no duplicate warnings, got: {dup_warnings:?}"
    );
}

// -----------------------------------------------------------------------
// Task 7: custom deriver registration
// -----------------------------------------------------------------------

/// A no-op deriver that counts how many times it's called.
struct CountingDeriver {
    count: Arc<AtomicUsize>,
}

impl Deriver for CountingDeriver {
    fn name(&self) -> &str {
        "counting"
    }

    fn derive(
        &self,
        _page: &IndexedPage,
        _page_id: &str,
        _tx: &Connection,
    ) -> Result<(), IndexError> {
        self.count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[test]
fn custom_deriver_is_called_during_build() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000099
title: Test
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("test.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let call_count = Arc::new(AtomicUsize::new(0));
    index.register_deriver(Box::new(CountingDeriver {
        count: Arc::clone(&call_count),
    }));

    index.build(&vault).unwrap();

    assert_eq!(
        call_count.load(Ordering::Relaxed),
        1,
        "custom deriver should be called once per page"
    );
}

// -----------------------------------------------------------------------
// Task 8: open_bare() constructor
// -----------------------------------------------------------------------

#[test]
fn open_bare_has_no_derivers() {
    let page = r#"---
id: 00000000-0000-0000-0000-0000000000aa
title: Bare
tags:
  - test
---
See [[Other]].
"#;

    let (_tmp, vault) = setup_vault(&[("bare.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open_bare(&db_path).unwrap();

    let stats = index.build(&vault).unwrap();
    assert_eq!(stats.pages_indexed, 1);

    // Pages table should have the row (upsert is in build(), not in derivers)
    let page_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(page_count, 1);

    // But derived tables should be empty (no derivers registered)
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert_eq!(cn_count, 0, "bare index should have no canonical_names");

    let link_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0))
        .unwrap();
    assert_eq!(link_count, 0, "bare index should have no links");

    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 0, "bare index should have no tags");
}

// -----------------------------------------------------------------------
// Incremental sync primitives: index_page, remove_page
// -----------------------------------------------------------------------

#[test]
fn index_page_indexes_single_file() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000010
title: Single
tags:
  - solo
---
Content here.
"#;

    let (_tmp, vault) = setup_vault(&[("single.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let vp = VaultPath::new("single.md").unwrap();
    let indexed = index.index_page(&vault, &vp).unwrap();
    assert!(indexed, "index_page should return true for new page");

    // Verify page in DB
    let page_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(page_count, 1);

    // Verify the stored tag and computed Kind tag are derived.
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 2, "expected stored solo and computed note tags");

    // Verify canonical_names derived
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert!(
        cn_count >= 1,
        "expected at least 1 canonical_name, got {cn_count}"
    );
}

#[test]
fn remove_page_deletes_from_index() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000011
title: Keeper
tags:
  - keep
---
Stay.
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000012
title: Goner
tags:
  - gone
---
Bye.
"#;

    let (_tmp, vault) = setup_vault(&[("keeper.md", page_a), ("goner.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let vp = VaultPath::new("goner.md").unwrap();
    let removed = index.remove_page(&vp).unwrap();
    assert!(removed, "remove_page should return true for existing page");

    // Page should be gone
    let page_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(page_count, 1);

    // Tags for goner should be gone (CASCADE)
    let tag: Option<String> = index
        .connection()
        .query_row("SELECT tag FROM tags WHERE tag = 'gone'", [], |row| {
            row.get(0)
        })
        .ok();
    assert!(
        tag.is_none(),
        "tags for removed page should be cascaded away"
    );

    // Removing again should return false
    let removed_again = index.remove_page(&vp).unwrap();
    assert!(
        !removed_again,
        "remove_page should return false for absent page"
    );
}

#[test]
fn index_page_skips_unchanged() {
    let page = r#"---
id: 00000000-0000-0000-0000-000000000013
title: Idempotent
---
Same content.
"#;

    let (_tmp, vault) = setup_vault(&[("idem.md", page)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    let vp = VaultPath::new("idem.md").unwrap();

    let first = index.index_page(&vault, &vp).unwrap();
    assert!(first, "first index_page should return true");

    let second = index.index_page(&vault, &vp).unwrap();
    assert!(
        !second,
        "second index_page on unchanged content should return false"
    );
}

// -----------------------------------------------------------------------
// Incremental sync primitives: resolve_links_for_page
// -----------------------------------------------------------------------

#[test]
fn resolve_links_for_page_resolves_only_affected() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000014
title: Hub
---
See [[Spoke]].
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000015
title: Spoke
---
Back to [[Hub]].
"#;

    let (_tmp, vault) = setup_vault(&[("hub.md", page_a), ("spoke.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    // Before resolution, links should be unresolved
    let unresolved: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_id IS NULL AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        unresolved, 2,
        "both wiki links should be unresolved before resolution"
    );

    // Resolve for hub.md — should resolve both the outgoing [[Spoke]] link
    // AND the incoming [[Hub]] link from spoke.md
    let vp_hub = VaultPath::new("hub.md").unwrap();
    let count = index.resolve_links_for_page(&vp_hub).unwrap();
    assert!(count >= 1, "expected at least 1 link resolved, got {count}");

    // The outgoing link from hub -> spoke should be resolved
    let hub_target: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000014' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        hub_target.as_deref(),
        Some("00000000-0000-0000-0000-000000000015"),
        "hub's [[Spoke]] link should be resolved"
    );
}

// -----------------------------------------------------------------------
// Incremental sync primitives: reverse_deps
// -----------------------------------------------------------------------

#[test]
fn reverse_deps_returns_pages_linking_to_target() {
    let hub = r#"---
id: 00000000-0000-0000-0000-000000000016
title: Hub
---
Central page.
"#;

    let spoke_one = r#"---
id: 00000000-0000-0000-0000-000000000017
title: SpokeOne
---
Links to [[Hub]].
"#;

    let spoke_two = r#"---
id: 00000000-0000-0000-0000-000000000018
title: SpokeTwo
---
Standalone page.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("hub.md", hub),
        ("spoke-one.md", spoke_one),
        ("spoke-two.md", spoke_two),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let vp_hub = VaultPath::new("hub.md").unwrap();
    let deps = index.reverse_deps(&vp_hub).unwrap();

    assert_eq!(deps.len(), 1, "only spoke-one links to hub");
    assert_eq!(deps[0].as_str(), "spoke-one.md");

    // spoke-two has no incoming links
    let vp_spoke_two = VaultPath::new("spoke-two.md").unwrap();
    let deps2 = index.reverse_deps(&vp_spoke_two).unwrap();
    assert!(deps2.is_empty(), "spoke-two has no reverse deps");
}

// -----------------------------------------------------------------------
// Incremental sync primitives: invalidate_links_to
// -----------------------------------------------------------------------

#[test]
fn invalidate_links_to_clears_resolved_links() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000019
title: Source
---
See [[Target]].
"#;

    let page_b = r#"---
id: 00000000-0000-0000-0000-00000000001a
title: Target
---
I am the target.
"#;

    let (_tmp, vault) = setup_vault(&[("source.md", page_a), ("target.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Verify link is resolved
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000019' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        target_id.as_deref(),
        Some("00000000-0000-0000-0000-00000000001a"),
        "link should be resolved before invalidation"
    );

    // Invalidate links to target.md
    let vp_target = VaultPath::new("target.md").unwrap();
    let count = index.invalidate_links_to(&vp_target).unwrap();
    assert_eq!(count, 1, "expected 1 link invalidated");

    // Verify link is now NULL
    let target_id_after: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000019' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        target_id_after, None,
        "target_id should be NULL after invalidation"
    );

    // Invalidating again should return 0
    let count2 = index.invalidate_links_to(&vp_target).unwrap();
    assert_eq!(count2, 0, "no links to invalidate the second time");
}

// -----------------------------------------------------------------------
// Enriched unresolved links
// -----------------------------------------------------------------------

#[test]
fn unresolved_with_candidates_distinguishes_no_match_from_ambiguous() {
    let alpha = r#"---
id: 00000000-0000-0000-0000-000000000060
title: Alpha
---
See [[Beta]], [[Ghost]], and [[Design]].
"#;
    let beta = r#"---
id: 00000000-0000-0000-0000-000000000061
title: Beta
---
Content.
"#;
    let delta = r#"---
id: 00000000-0000-0000-0000-000000000062
title: Design
---
First design page.
"#;
    let epsilon = r#"---
id: 00000000-0000-0000-0000-000000000063
title: Design
aliases: []
---
Second design page.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("alpha.md", alpha),
        ("beta.md", beta),
        ("delta.md", delta),
        ("subdir/epsilon.md", epsilon),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();

    // Should have 2 unresolved links: Ghost (no_match) and Design (ambiguous)
    assert_eq!(unresolved.len(), 2);

    let ghost_link = unresolved.iter().find(|u| u.target_raw == "Ghost").unwrap();
    assert_eq!(ghost_link.reason, UnresolvedReason::NoMatch);
    assert!(ghost_link.candidates.is_empty());

    let design_link = unresolved
        .iter()
        .find(|u| u.target_raw == "Design")
        .unwrap();
    assert_eq!(design_link.reason, UnresolvedReason::Ambiguous);
    assert_eq!(design_link.candidates.len(), 2);

    let candidate_paths: Vec<&str> = design_link
        .candidates
        .iter()
        .map(|c| c.path.as_str())
        .collect();
    assert!(candidate_paths.contains(&"delta.md"));
    assert!(candidate_paths.contains(&"subdir/epsilon.md"));
}

// -----------------------------------------------------------------------
// Backlinks with context
// -----------------------------------------------------------------------

#[test]
fn backlinks_with_context_returns_snippets() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000070
title: Alpha
---
First paragraph.

This paragraph links to [[Beta]] in context.

Last paragraph.
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000071
title: Beta
---
Content here.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let backlinks = index
        .backlinks_with_context(&vault, &VaultPath::new("beta.md").unwrap(), 200)
        .unwrap();

    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_path, "alpha.md");
    assert!(
        backlinks[0].context.contains("[[Beta]]"),
        "context should contain the link text, got: {}",
        backlinks[0].context
    );
    assert!(
        backlinks[0].context.contains("links to"),
        "context should contain surrounding words"
    );
}

// -----------------------------------------------------------------------
// Disambiguation strategy ranking
// -----------------------------------------------------------------------

#[test]
fn candidates_ranked_by_shortest_path() {
    let alpha = r#"---
id: 00000000-0000-0000-0000-000000000080
title: Alpha
---
Link to [[Design]].
"#;
    let design_root = r#"---
id: 00000000-0000-0000-0000-000000000081
title: Design
---
Root design.
"#;
    let design_nested = r#"---
id: 00000000-0000-0000-0000-000000000082
title: Design
---
Nested design.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("alpha.md", alpha),
        ("design.md", design_root),
        ("projects/deep/design.md", design_nested),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();
    let design_link = unresolved
        .iter()
        .find(|u| u.target_raw == "Design")
        .unwrap();

    let ranked = index.rank_candidates(
        &design_link.candidates,
        "alpha.md",
        DisambiguationStrategy::ShortestPath,
    );

    assert_eq!(
        ranked[0].path, "design.md",
        "shortest path should rank first"
    );
}

#[test]
fn delete_target_page_nulls_link_target_id() {
    let (_tmp, vault) = setup_vault(&[
        ("source.md", "---\ntitle: Source\n---\nSee [[target]]."),
        ("target.md", "---\ntitle: Target\n---\nContent."),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Verify link is resolved
    let target_id: String = index
        .connection()
        .query_row("SELECT id FROM pages WHERE path = 'target.md'", [], |row| {
            row.get(0)
        })
        .unwrap();

    let link_target: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = (SELECT id FROM pages WHERE path = 'source.md') AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_target, Some(target_id.clone()));

    // Delete target page from disk and rebuild
    fs::remove_file(vault.root().join("target.md")).unwrap();
    index.build(&vault).unwrap();

    // The link's target_id should now be NULL (via ON DELETE SET NULL)
    let link_target_after: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = (SELECT id FROM pages WHERE path = 'source.md') AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(link_target_after, None);
}

#[test]
fn candidates_ranked_by_closest_directory() {
    let alpha = r#"---
id: 00000000-0000-0000-0000-000000000083
title: Alpha
---
Link to [[Design]].
"#;
    let design_root = r#"---
id: 00000000-0000-0000-0000-000000000084
title: Design
---
Root design.
"#;
    let design_same_dir = r#"---
id: 00000000-0000-0000-0000-000000000085
title: Design
---
Same dir design.
"#;

    let (_tmp, vault) = setup_vault(&[
        ("notes/alpha.md", alpha),
        ("design.md", design_root),
        ("notes/design.md", design_same_dir),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    let unresolved = index.unresolved_with_candidates().unwrap();
    let design_link = unresolved
        .iter()
        .find(|u| u.target_raw == "Design")
        .unwrap();

    let ranked = index.rank_candidates(
        &design_link.candidates,
        "notes/alpha.md",
        DisambiguationStrategy::ClosestDirectory,
    );

    assert_eq!(
        ranked[0].path, "notes/design.md",
        "same directory should rank first"
    );
}

// -----------------------------------------------------------------------
// Computed Kind tags: index projection, query visibility, and migration
// -----------------------------------------------------------------------

fn computed_tags_fixture() -> (TempDir, Vault, VaultIndex) {
    let journal = r#"+++
id = "019fd000-0000-7000-8000-000000000101"
title = "Research journal"
type = "JOURNAL"
tags = ["research"]
+++
Journal body.
"#;
    let note = r#"+++
id = "019fd000-0000-7000-8000-000000000102"
title = "Cross-kind note"
type = "NOTE"
tags = ["journal"]
+++
Note body.
"#;
    let legacy_journal = r#"+++
id = "019fd000-0000-7000-8000-000000000103"
title = "Legacy journal"
type = "JOURNAL"
tags = ["JOURNAL"]
+++
Legacy body.
"#;

    let (tmp, vault) = setup_vault(&[
        ("journals/research.md", journal),
        ("notes/cross-kind.md", note),
        ("journals/legacy.md", legacy_journal),
    ]);
    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index.build(&vault).unwrap();
    (tmp, vault, index)
}

fn indexed_tag_rows(index: &VaultIndex) -> Vec<(String, String, i64)> {
    index
        .connection()
        .prepare(
            "SELECT p.path, t.tag, t.computed
             FROM tags t
             JOIN pages p ON p.id = t.page_id
             ORDER BY p.path, t.tag",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn computed_tags_index_with_provenance_and_count_once() {
    let (_tmp, _vault, index) = computed_tags_fixture();

    assert_eq!(
        indexed_tag_rows(&index),
        vec![
            ("journals/legacy.md".into(), "journal".into(), 1),
            ("journals/research.md".into(), "journal".into(), 1),
            ("journals/research.md".into(), "research".into(), 0),
            ("notes/cross-kind.md".into(), "journal".into(), 0),
            ("notes/cross-kind.md".into(), "note".into(), 1),
        ],
        "legacy case variants must collapse into the canonical computed row, while same-spelling tags on another Kind stay editable",
    );

    let counts: Vec<(String, i64)> = index
        .connection()
        .prepare("SELECT tag, COUNT(*) FROM tags GROUP BY tag ORDER BY tag")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        counts,
        vec![
            ("journal".into(), 3),
            ("note".into(), 1),
            ("research".into(), 1),
        ],
        "tag counts must count each effective page/tag pair exactly once",
    );
}

#[test]
fn computed_tags_are_searchable_and_project_as_effective_tags() {
    let (_tmp, _vault, index) = computed_tags_fixture();
    let spec = QuerySpec {
        filter: Some(
            serde_json::from_value(
                serde_json::json!({ "field": "tags", "op": "contains", "value": "journal" }),
            )
            .unwrap(),
        ),
        columns: vec!["tags".into()],
        ..Default::default()
    };

    let QueryOutput::Flat { rows, total } =
        evaluate(index.connection(), &spec, &QueryContext::default()).unwrap()
    else {
        panic!("tag search should return flat query rows");
    };
    assert_eq!(
        total, 3,
        "computed and ordinary tags must both be searchable"
    );

    let projected: Vec<(String, Vec<String>)> = rows
        .into_iter()
        .map(|row| {
            let mut tags: Vec<String> = row.columns["tags"]
                .as_array()
                .expect("tags projection must be an array")
                .iter()
                .map(|tag| tag.as_str().unwrap().to_owned())
                .collect();
            tags.sort();
            (row.path, tags)
        })
        .collect();
    assert_eq!(
        projected,
        vec![
            ("journals/legacy.md".into(), vec!["journal".into()]),
            (
                "journals/research.md".into(),
                vec!["journal".into(), "research".into()],
            ),
            (
                "notes/cross-kind.md".into(),
                vec!["journal".into(), "note".into()],
            ),
        ],
        "requested tags columns must expose effective index rows rather than stored frontmatter arrays",
    );
}

#[test]
fn computed_tags_migration_rederives_unchanged_pages_once() {
    let journal = r#"+++
id = "019fd000-0000-7000-8000-000000000104"
title = "Unchanged journal"
type = "JOURNAL"
tags = ["research"]
+++
Stable body.
"#;
    let (_tmp, vault) = setup_vault(&[("journals/research.md", journal)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();
    let page_before = fs::read_to_string(vault.root().join("journals/research.md")).unwrap();

    index
        .connection()
        .execute_batch(
            "DROP TABLE tags;
             CREATE TABLE tags (
                 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                 tag TEXT NOT NULL,
                 PRIMARY KEY (page_id, tag)
             );
             INSERT INTO tags (page_id, tag)
             SELECT id, 'research' FROM pages WHERE path = 'journals/research.md';
             DELETE FROM derivation_meta WHERE key = 'tag_derivation_version';",
        )
        .unwrap();
    drop(index);

    let mut reopened = VaultIndex::open(&db_path).unwrap();
    let migration = reopened.build(&vault).unwrap();
    assert_eq!(
        (migration.pages_indexed, migration.pages_skipped),
        (1, 0),
        "a missing derivation version must bypass the unchanged-page skip",
    );
    assert_eq!(
        indexed_tag_rows(&reopened),
        vec![
            ("journals/research.md".into(), "journal".into(), 1),
            ("journals/research.md".into(), "research".into(), 0),
        ],
    );
    assert_eq!(
        fs::read_to_string(vault.root().join("journals/research.md")).unwrap(),
        page_before,
        "index migration must not persist the computed tag into frontmatter",
    );

    let unchanged = reopened.build(&vault).unwrap();
    assert_eq!(
        (unchanged.pages_indexed, unchanged.pages_skipped),
        (0, 1),
        "the stored derivation version must restore unchanged-page skipping",
    );
    assert_eq!(
        indexed_tag_rows(&reopened),
        vec![
            ("journals/research.md".into(), "journal".into(), 1),
            ("journals/research.md".into(), "research".into(), 0),
        ],
        "a skipped rebuild must preserve the effective tag projection",
    );
}

// -----------------------------------------------------------------------
// FTS5 full-text search
// -----------------------------------------------------------------------

#[test]
fn fts_search_returns_matching_pages() {
    let (_tmp, vault) = setup_vault(&[
        (
            "quantum.md",
            "---\ntitle: Quantum Mechanics\n---\nThe study of subatomic particles and wave functions.",
        ),
        (
            "cooking.md",
            "---\ntitle: Cooking Basics\n---\nHow to make a perfect sourdough bread.",
        ),
        (
            "physics.md",
            "---\ntitle: Classical Physics\n---\nNewton's laws and wave mechanics.",
        ),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();

    let results = index.search("wave", 10).unwrap();
    assert_eq!(results.len(), 2);
    let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.contains(&"quantum.md"));
    assert!(paths.contains(&"physics.md"));
    assert!(!paths.contains(&"cooking.md"));
}

#[test]
fn fts_search_matches_title() {
    let (_tmp, vault) = setup_vault(&[(
        "note.md",
        "---\ntitle: Zettelkasten Method\n---\nA note-taking approach.",
    )]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();

    let results = index.search("zettelkasten", 10).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].path, "note.md");
}

#[test]
fn fts_search_returns_typed_query_errors() {
    let (_tmp, vault) = setup_vault(&[(
        "note.md",
        "---\ntitle: Searchable\n---\nStructured search content.",
    )]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    let error = index.search("unknown:value", 10).unwrap_err();
    let IndexError::SearchQuery(error) = error else {
        panic!("expected a typed search query error");
    };
    assert_eq!(error.kind(), "unknown_field");
    assert_eq!(error.span(), 0..7);
    assert!(error.message().contains("unknown search field"));
}

#[test]
fn fts_search_removed_page_not_returned() {
    let (_tmp, vault) = setup_vault(&[(
        "ephemeral.md",
        "---\ntitle: Ephemeral\n---\nTemporary content.",
    )]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    assert_eq!(index.search("ephemeral", 10).unwrap().len(), 1);

    fs::remove_file(vault.root().join("ephemeral.md")).unwrap();
    index.build(&vault).unwrap();
    assert_eq!(index.search("ephemeral", 10).unwrap().len(), 0);
}

// -----------------------------------------------------------------------
// Migration: pre-existing DB without target_block_id opens successfully
// -----------------------------------------------------------------------

#[test]
fn open_migrates_old_links_table_without_target_block_id() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("cache.db");

    // Create an old-style links table without target_block_id
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .unwrap();
        conn.execute_batch(
            "CREATE TABLE pages (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                title TEXT,
                canonical_name TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                meta_json TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                journal_date TEXT
            );
            CREATE TABLE links (
                source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
                target_raw TEXT NOT NULL,
                target_canonical TEXT,
                target_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
                target_path TEXT,
                kind TEXT NOT NULL,
                source_field TEXT,
                span_start INTEGER NOT NULL,
                span_end INTEGER NOT NULL,
                PRIMARY KEY (source_id, span_start)
            );",
        )
        .unwrap();
    }

    // Opening with VaultIndex::open should succeed (migration adds the column)
    let index = VaultIndex::open(&db_path).unwrap();
    // Verify the column exists by querying it
    let count: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_block_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

// -----------------------------------------------------------------------
// Block ref resolution: resolve_links_for_page resolves block refs
// -----------------------------------------------------------------------

#[test]
fn resolve_links_for_page_resolves_block_refs() {
    let (_tmp, vault) = setup_vault(&[
        (
            "source.md",
            "---\nid: 00000000-0000-0000-0000-111111111111\ntitle: Source\n---\n- Important note ^abc123DEF0a\n",
        ),
        (
            "referrer.md",
            "---\nid: 00000000-0000-0000-0000-222222222222\ntitle: Referrer\n---\nSee ((abc123DEF0a)) for details\n",
        ),
    ]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();
    index.build(&vault).unwrap();

    // Do NOT call resolve_links() (full rebuild) — only per-page resolution
    let source_vp = VaultPath::new("source.md").unwrap();
    let referrer_vp = VaultPath::new("referrer.md").unwrap();

    // Resolve the source page — this should resolve incoming block refs
    let resolved = index.resolve_links_for_page(&source_vp).unwrap();
    assert!(
        resolved > 0,
        "should have resolved at least one block ref link"
    );

    // Verify the block_ref link from referrer now targets source
    let backlinks = index
        .backlinks_with_context(&vault, &source_vp, 200)
        .unwrap();
    assert!(
        backlinks
            .iter()
            .any(|bl| bl.source_path == "referrer.md" && bl.kind == "block_ref"),
        "should have a block_ref backlink from referrer.md, got: {backlinks:?}"
    );

    // Also verify outgoing block ref resolution works
    // Re-index referrer (simulating incremental update) and resolve
    index.remove_page(&referrer_vp).unwrap();
    index.index_page(&vault, &referrer_vp).unwrap();
    let resolved2 = index.resolve_links_for_page(&referrer_vp).unwrap();
    assert!(
        resolved2 > 0,
        "outgoing block ref from referrer should resolve"
    );

    let backlinks2 = index
        .backlinks_with_context(&vault, &source_vp, 200)
        .unwrap();
    assert!(
        backlinks2
            .iter()
            .any(|bl| bl.source_path == "referrer.md" && bl.kind == "block_ref"),
        "block_ref backlink should still exist after re-index + per-page resolve"
    );
}

#[test]
fn code_reservation_initializes_from_observed_max_and_advances_monotonically() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("cache.db");
    let index = VaultIndex::open(&db_path).unwrap();
    drop(index);

    let mut conn = rusqlite::Connection::open(&db_path).unwrap();
    assert_eq!(reserve_code_number(&mut conn, "TASK", 481).unwrap(), 482);
    assert_eq!(reserve_code_number(&mut conn, "TASK", 481).unwrap(), 483);
    assert_eq!(reserve_code_number(&mut conn, "TASK", 900).unwrap(), 484);
}

#[test]
fn code_reservation_keeps_families_independent() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("cache.db");
    let index = VaultIndex::open(&db_path).unwrap();
    drop(index);

    let mut conn = rusqlite::Connection::open(&db_path).unwrap();
    assert_eq!(reserve_code_number(&mut conn, "TASK", 7).unwrap(), 8);
    assert_eq!(reserve_code_number(&mut conn, "CYCLE", 13).unwrap(), 14);
    assert_eq!(reserve_code_number(&mut conn, "TASK", 7).unwrap(), 9);
    assert_eq!(reserve_code_number(&mut conn, "CYCLE", 13).unwrap(), 15);
}

#[test]
fn rubbish_catalog_build_reconciliation_is_idempotent_and_excludes_item_bodies() {
    let (_tmp, vault) = setup_vault(&[]);
    let rubbish_root = vault.root().join(".clepsydra/rubbish");
    let store = RubbishStore::new(&rubbish_root);
    let item_id = uuid::Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
    let page_id = uuid::Uuid::parse_str("10000000-0000-4000-8000-000000000001").unwrap();
    let manifest = RubbishManifest::new(
        item_id,
        page_id,
        "archive/catalog-only.md",
        "Catalog Only",
        "ARCHIVE",
        "2026-08-13T12:00:00Z"
            .parse::<chrono::DateTime<chrono::Utc>>()
            .unwrap(),
        Some("https://example.com/catalog-only".to_owned()),
    )
    .unwrap();
    let page_bytes = br#"+++
id = "10000000-0000-4000-8000-000000000001"
title = "Must Stay Out"
tags = ["rubbish-body-tag"]
linked = "[[Rubbish Target]]"
+++
# Secret rubbish body

unsearchable-rubbish-token
"#;
    let mut prepared = store
        .prepare_item(&item_id.to_string(), &manifest, page_bytes)
        .unwrap();
    prepared.publish().unwrap();

    let invalid_dir = rubbish_root.join("broken-entry");
    fs::create_dir_all(&invalid_dir).unwrap();
    let invalid_page_bytes = b"invalid body must stay byte-identical";
    let invalid_manifest_bytes = b"not json";
    fs::write(invalid_dir.join("page.md"), invalid_page_bytes).unwrap();
    fs::write(invalid_dir.join("manifest.json"), invalid_manifest_bytes).unwrap();
    let valid_manifest_before =
        fs::read(rubbish_root.join(item_id.to_string()).join("manifest.json")).unwrap();

    let mut index = VaultIndex::open(&vault.root().join(".clepsydra/cache.db")).unwrap();
    index
        .upsert_rubbish_entry(&RubbishListEntry::Invalid {
            item_id: "stale-entry".to_owned(),
            error: "must be pruned".to_owned(),
        })
        .unwrap();

    index.build(&vault).unwrap();
    let first_catalog = index.rubbish_entries().unwrap();
    assert_eq!(first_catalog.len(), 2);
    assert!(matches!(
        &first_catalog[0],
        RubbishListEntry::Valid(found) if found == &manifest
    ));
    assert!(matches!(
        &first_catalog[1],
        RubbishListEntry::Invalid { item_id, error }
            if item_id == "broken-entry" && !error.is_empty()
    ));
    assert_eq!(index.rubbish_entry("stale-entry").unwrap(), None);

    let normal_index_rows: i64 = index
        .connection()
        .query_row(
            "SELECT
                (SELECT count(*) FROM pages)
              + (SELECT count(*) FROM canonical_names)
              + (SELECT count(*) FROM pages_fts)
              + (SELECT count(*) FROM tags)
              + (SELECT count(*) FROM links)
              + (SELECT count(*) FROM page_properties)
              + (SELECT count(*) FROM page_bodies)
              + (SELECT count(*) FROM blocks)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        normal_index_rows, 0,
        "rubbish bodies must never enter normal page lookup, FTS, names, tags, graph, properties, bodies, or blocks"
    );
    assert_eq!(
        fs::read(rubbish_root.join(item_id.to_string()).join("page.md")).unwrap(),
        page_bytes
    );
    assert_eq!(
        fs::read(rubbish_root.join(item_id.to_string()).join("manifest.json")).unwrap(),
        valid_manifest_before
    );
    assert_eq!(
        fs::read(invalid_dir.join("page.md")).unwrap(),
        invalid_page_bytes
    );
    assert_eq!(
        fs::read(invalid_dir.join("manifest.json")).unwrap(),
        invalid_manifest_bytes
    );

    index.build(&vault).unwrap();
    assert_eq!(index.rubbish_entries().unwrap(), first_catalog);
    assert_eq!(
        fs::read(rubbish_root.join(item_id.to_string()).join("page.md")).unwrap(),
        page_bytes
    );
}

// ---------------------------------------------------------------------------
// Task 2: Indexer conflict guard
// ---------------------------------------------------------------------------

#[test]
fn conflicted_file_survives_index_build_byte_identical() {
    let conflicted = "<<<<<<< HEAD\n+++\ntitle = \"Ours\"\n+++\nours\n=======\n+++\ntitle = \"Theirs\"\n+++\ntheirs\n>>>>>>> theirs\n";
    let (tmp, vault) = setup_vault(&[("notes/clash.md", conflicted)]);
    let mut index = VaultIndex::open(&tmp.path().join("cache.db")).unwrap();
    index.build(&vault).unwrap();
    let on_disk = std::fs::read_to_string(vault.root().join("notes/clash.md")).unwrap();
    assert_eq!(
        on_disk, conflicted,
        "index build must not rewrite a conflicted file"
    );
}
