use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use clepsydra::vault::Vault;
use clepsydra::vault::derivation::{Deriver, IndexedPage};
use clepsydra::vault::index::{IndexError, VaultIndex};
use clepsydra::vault::init::init_vault;
use clepsydra::vault::path::VaultPath;
use rusqlite::Transaction;
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

    // Verify tags
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 2, "expected 2 tags total (greeting + place)");

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
    assert!(cn_count >= 3, "expected at least 3 canonical_names, got {cn_count}");

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

    // Tags: 2 tags total
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 2);

    // Link resolution: [[World]] from page A should resolve to page B
    let target_id: Option<String> = index
        .connection()
        .query_row(
            "SELECT target_id FROM links WHERE source_id = '00000000-0000-0000-0000-000000000001' AND span_start >= 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(target_id.as_deref(), Some("00000000-0000-0000-0000-000000000002"));
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
        _tx: &Transaction,
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

    assert_eq!(call_count.load(Ordering::Relaxed), 1, "custom deriver should be called once per page");
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

    // Verify tags derived
    let tag_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tag_count, 1, "expected 1 tag (solo)");

    // Verify canonical_names derived
    let cn_count: i64 = index
        .connection()
        .query_row("SELECT COUNT(*) FROM canonical_names", [], |row| row.get(0))
        .unwrap();
    assert!(cn_count >= 1, "expected at least 1 canonical_name, got {cn_count}");
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
        .query_row(
            "SELECT tag FROM tags WHERE tag = 'gone'",
            [],
            |row| row.get(0),
        )
        .ok();
    assert!(tag.is_none(), "tags for removed page should be cascaded away");

    // Removing again should return false
    let removed_again = index.remove_page(&vp).unwrap();
    assert!(!removed_again, "remove_page should return false for absent page");
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
    assert!(!second, "second index_page on unchanged content should return false");
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
    assert_eq!(unresolved, 2, "both wiki links should be unresolved before resolution");

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
