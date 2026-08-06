use std::fs;

use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::init::init_vault;
use clepsydra::vault::page::Page;
use clepsydra::vault::path::VaultPath;
use clepsydra::vault::sync::{ChangeEvent, SyncEngine};
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

/// Helper: snapshot the index state as comparable tuples.
fn snapshot_pages(index: &VaultIndex) -> Vec<(String, String, String)> {
    let mut stmt = index
        .connection()
        .prepare("SELECT id, path, content_hash FROM pages ORDER BY path")
        .unwrap();
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

fn snapshot_links(index: &VaultIndex) -> Vec<(String, String, Option<String>, Option<String>)> {
    let mut stmt = index
        .connection()
        .prepare(
            "SELECT source_id, target_raw, target_id, target_path
             FROM links ORDER BY source_id, span_start",
        )
        .unwrap();
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[test]
fn incremental_add_matches_full_rebuild() {
    // Start with page A only
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000050
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000051
title: Beta
---
Back to [[Alpha]].
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // Initial full build with just alpha.md
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Now add beta.md to disk
    fs::write(vault.root().join("beta.md"), page_b).unwrap();

    // Incremental sync
    let events = vec![ChangeEvent::Upsert(VaultPath::new("beta.md").unwrap())];
    let stats = SyncEngine::process_events(&events, &vault, &mut index).unwrap();
    assert_eq!(stats.pages_indexed, 1);

    // Snapshot incremental state
    let inc_pages = snapshot_pages(&index);
    let inc_links = snapshot_links(&index);

    // Now do a full rebuild in a separate index for comparison
    let db_path2 = vault.root().join(".clepsydra/cache_ref.db");
    let mut ref_index = VaultIndex::open(&db_path2).unwrap();
    ref_index.build(&vault).unwrap();
    ref_index.resolve_links().unwrap();

    let ref_pages = snapshot_pages(&ref_index);
    let ref_links = snapshot_links(&ref_index);

    assert_eq!(inc_pages, ref_pages, "pages mismatch after incremental add");
    assert_eq!(inc_links, ref_links, "links mismatch after incremental add");
}

#[test]
fn incremental_modify_matches_full_rebuild() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000052
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000053
title: Beta
---
No links here.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Modify beta.md — change title (affects canonical names and link resolution)
    let page_b_v2 = r#"---
id: 00000000-0000-0000-0000-000000000053
title: Gamma
---
Now I link to [[Alpha]].
"#;
    fs::write(vault.root().join("beta.md"), page_b_v2).unwrap();

    // Incremental sync
    let events = vec![ChangeEvent::Upsert(VaultPath::new("beta.md").unwrap())];
    SyncEngine::process_events(&events, &vault, &mut index).unwrap();

    let inc_pages = snapshot_pages(&index);
    let inc_links = snapshot_links(&index);

    // Full rebuild reference
    let db_path2 = vault.root().join(".clepsydra/cache_ref.db");
    let mut ref_index = VaultIndex::open(&db_path2).unwrap();
    ref_index.build(&vault).unwrap();
    ref_index.resolve_links().unwrap();

    let ref_pages = snapshot_pages(&ref_index);
    let ref_links = snapshot_links(&ref_index);

    assert_eq!(inc_pages, ref_pages, "pages mismatch after modify");
    assert_eq!(inc_links, ref_links, "links mismatch after modify");
}

#[test]
fn incremental_delete_matches_full_rebuild() {
    let page_a = r#"---
id: 00000000-0000-0000-0000-000000000054
title: Alpha
---
See [[Beta]].
"#;
    let page_b = r#"---
id: 00000000-0000-0000-0000-000000000055
title: Beta
---
Content.
"#;

    let (_tmp, vault) = setup_vault(&[("alpha.md", page_a), ("beta.md", page_b)]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // Delete beta.md from disk
    fs::remove_file(vault.root().join("beta.md")).unwrap();

    // Incremental sync
    let events = vec![ChangeEvent::Remove(VaultPath::new("beta.md").unwrap())];
    let stats = SyncEngine::process_events(&events, &vault, &mut index).unwrap();
    assert_eq!(stats.pages_removed, 1);

    let inc_pages = snapshot_pages(&index);
    let inc_links = snapshot_links(&index);

    // Full rebuild reference
    let db_path2 = vault.root().join(".clepsydra/cache_ref.db");
    let mut ref_index = VaultIndex::open(&db_path2).unwrap();
    ref_index.build(&vault).unwrap();
    ref_index.resolve_links().unwrap();

    let ref_pages = snapshot_pages(&ref_index);
    let ref_links = snapshot_links(&ref_index);

    assert_eq!(inc_pages, ref_pages, "pages mismatch after delete");
    assert_eq!(inc_links, ref_links, "links mismatch after delete");
}

#[test]
fn upsert_repairs_missing_or_incomplete_frontmatter() {
    let (_tmp, vault) = setup_vault(&[]);
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path).unwrap();

    // Start from a clean index.
    index.build(&vault).unwrap();
    index.resolve_links().unwrap();

    // New file created externally with incomplete frontmatter (missing id/timestamps).
    let raw = "---\ntitle: Draft\n---\nBody without metadata.\n";
    let abs = vault.root().join("draft.md");
    fs::write(&abs, raw).unwrap();

    let events = vec![ChangeEvent::Upsert(VaultPath::new("draft.md").unwrap())];
    let stats = SyncEngine::process_events(&events, &vault, &mut index).unwrap();
    assert_eq!(stats.pages_indexed, 1);

    // File should now contain valid/populated frontmatter, healed to TOML.
    let rewritten = fs::read_to_string(&abs).unwrap();
    assert!(rewritten.starts_with("+++\n"));

    let vp = VaultPath::new("draft.md").unwrap();
    let page = Page::from_file(&abs, vp).unwrap();
    assert_eq!(page.meta.title.as_deref(), Some("Draft"));
    assert!(!page.meta.id.is_nil());
    assert!(page.meta.created_at.is_some());
    assert!(page.meta.updated_at.is_some());
    assert_eq!(page.body, "Body without metadata.\n");
}
