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

/// What a tree node represents.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NodeEntry {
    /// A directory.
    Dir,
    /// A file matching an indexed page, with its metadata.
    Note(NoteMeta),
    /// Any other regular file, with its size in bytes.
    File { size: u64 },
}

/// A single node in the rendered vault tree.
#[derive(Debug, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// Vault-relative path (`/`-separated). Empty for the root node.
    pub path: String,
    #[serde(flatten)]
    pub entry: NodeEntry,
    pub children: Vec<TreeNode>,
}

/// Build the vault tree rooted at `vault.root()`. Skips dotfiles/dot-dirs and
/// `.clepsydra`. Files whose vault path is a key in `meta` become `Note`
/// nodes; other regular files become `File` nodes carrying their size.
pub fn build(vault: &Vault, meta: &HashMap<String, NoteMeta>) -> TreeNode {
    let root_path = vault.root().to_path_buf();
    let children = read_dir_sorted(&root_path, "", meta);
    TreeNode {
        name: vault
            .root()
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string()),
        path: String::new(),
        entry: NodeEntry::Dir,
        children,
    }
}

/// Recursively read `abs_dir`, returning its child nodes. `rel_prefix` is the
/// vault-relative path of `abs_dir` (`""` at the root, else trailing-slash-free).
fn read_dir_sorted(
    abs_dir: &std::path::Path,
    rel_prefix: &str,
    meta: &HashMap<String, NoteMeta>,
) -> Vec<TreeNode> {
    let Ok(entries) = std::fs::read_dir(abs_dir) else {
        return Vec::new();
    };

    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Skip dotfiles/dot-dirs (covers .git, .clepsydra, .DS_Store, ...).
        if name.starts_with('.') {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            let children = read_dir_sorted(&entry.path(), &rel, meta);
            dirs.push(TreeNode {
                name,
                path: rel,
                entry: NodeEntry::Dir,
                children,
            });
        } else if file_type.is_file() {
            let entry_kind = if let Some(m) = meta.get(&rel) {
                NodeEntry::Note(m.clone())
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                NodeEntry::File { size }
            };
            files.push(TreeNode {
                name,
                path: rel,
                entry: entry_kind,
                children: Vec::new(),
            });
        }
    }

    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.extend(files);
    dirs
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

    /// Collect every node name in the tree (depth-first) for assertions.
    fn names(node: &TreeNode, acc: &mut Vec<String>) {
        acc.push(node.name.clone());
        for c in &node.children {
            names(c, acc);
        }
    }

    #[test]
    fn build_excludes_dotfiles_and_clepsydra() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let root = build(&vault, &meta);
        let mut all = Vec::new();
        names(&root, &mut all);
        // The root name (all[0]) is the vault directory's own basename, which
        // may be a dot-prefixed temp dir; only assert on the walked children.
        let children = &all[1..];
        assert!(!children.iter().any(|n| n == ".clepsydra"));
        assert!(!children.iter().any(|n| n.starts_with('.')));
        assert!(children.iter().any(|n| n == "Alpha.md"));
        assert!(children.iter().any(|n| n == "_attachments"));
        assert!(children.iter().any(|n| n == "diagram.png"));
    }

    #[test]
    fn build_classifies_note_and_file() {
        let (_dir, vault, index) = fixture();
        let meta = load_note_meta(&vault, &index).unwrap();
        let root = build(&vault, &meta);

        fn find<'a>(node: &'a TreeNode, name: &str) -> Option<&'a TreeNode> {
            if node.name == name {
                return Some(node);
            }
            node.children.iter().find_map(|c| find(c, name))
        }

        let alpha = find(&root, "Alpha.md").unwrap();
        assert!(matches!(alpha.entry, NodeEntry::Note(_)));
        let png = find(&root, "diagram.png").unwrap();
        assert!(matches!(png.entry, NodeEntry::File { .. }));
    }
}
