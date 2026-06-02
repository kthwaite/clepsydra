//! Vault tree listing for the `clepsydra tree` CLI subcommand.

use std::collections::HashMap;

use serde::Serialize;

use crate::vault::Vault;
use crate::vault::index::VaultIndex;
use crate::vault::page::Page;
use crate::vault::path::VaultPath;

/// Metadata attached to an indexed note in the tree.
#[derive(Debug, Clone, Serialize, Default)]
pub struct NoteMeta {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_count: Option<i64>,
}

/// Bulk-load note metadata keyed by the vault-relative path (the `pages.path`
/// column, which equals each note's path under the vault root). Kind/title come
/// from `pages`, tags from `tags`; dates and word count require reading each
/// file (as the HTTP content index does).
pub fn load_note_meta(
    vault: &Vault,
    index: &VaultIndex,
) -> Result<HashMap<String, NoteMeta>, rusqlite::Error> {
    let conn = index.connection();

    // Tags grouped by page_id.
    let mut tags_by_page: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT page_id, tag FROM tags")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for (pid, tag) in rows.flatten() {
            tags_by_page.entry(pid).or_default().push(tag);
        }
    }

    let mut stmt = conn.prepare("SELECT id, path, title, kind FROM pages")?;
    type Row = (String, String, Option<String>, String);
    let rows: Vec<Row> = stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut out = HashMap::with_capacity(rows.len());
    for (page_id, path, title, kind) in rows {
        let tags = tags_by_page.remove(&page_id).unwrap_or_default();
        let (created_at, updated_at, word_count) = match VaultPath::new(&path) {
            Ok(vp) => {
                let abs = vault.resolve(&vp);
                match Page::from_file(&abs, vp) {
                    Ok(page) => (
                        page.meta.created_at.map(|d| d.to_rfc3339()),
                        page.meta.updated_at.map(|d| d.to_rfc3339()),
                        Some(page.body.split_whitespace().count() as i64),
                    ),
                    Err(_) => (None, None, None),
                }
            }
            Err(_) => (None, None, None),
        };
        out.insert(
            path,
            NoteMeta {
                kind,
                title,
                tags,
                created_at,
                updated_at,
                word_count,
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::vault::index::VaultIndex;

    /// Temp vault with a note and an attachment; returns (TempDir, Vault, VaultIndex).
    fn fixture() -> (tempfile::TempDir, Vault, VaultIndex) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(
            root.join("Alpha.md"),
            "---\ntitle: Alpha\ntags: [physics]\n---\nword one two three\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("_attachments")).unwrap();
        std::fs::write(root.join("_attachments/diagram.png"), b"\x89PNG fake").unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        (dir, vault, index)
    }

    #[test]
    fn load_note_meta_carries_kind_and_tags() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let alpha = meta.get("Alpha.md").expect("Alpha.md indexed");
        assert_eq!(alpha.kind, "NOTE");
        assert!(alpha.tags.contains(&"physics".to_string()));
        assert_eq!(alpha.word_count, Some(4));
    }
}
