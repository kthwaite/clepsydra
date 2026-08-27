//! Merge-conflict detection for vault files.
//!
//! A file containing all three git conflict-marker lines is *conflicted*:
//! the indexer must never repair or rewrite it (docs/adr/0004).

use super::{Vault, page::parse_or_repair_frontmatter, path::VaultPath};
use walkdir::WalkDir;

/// True when `content` holds all three git merge-conflict marker lines:
/// a line starting `<<<<<<< `, a bare `=======` line, and a line starting
/// `>>>>>>> `.
pub fn has_conflict_markers(content: &str) -> bool {
    let (mut ours, mut sep, mut theirs) = (false, false, false);
    for line in content.lines() {
        ours |= line.starts_with("<<<<<<< ");
        sep |= line == "=======";
        theirs |= line.starts_with(">>>>>>> ");
        if ours && sep && theirs {
            return true;
        }
    }
    false
}

/// Sweep the vault for markdown files containing conflict markers.
/// Mirrors `migrate::legacy_pages` (src/vault/migrate.rs:27): skips
/// `.clepsydra/` and excluded paths, sorts by path. Read-only.
pub fn conflicted_pages(vault: &Vault) -> Vec<VaultPath> {
    let mut out = Vec::new();
    for entry in WalkDir::new(vault.root())
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(vault.root()) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".clepsydra/") {
            continue;
        }
        let Ok(vault_path) = VaultPath::new(&rel_str) else {
            continue;
        };
        if vault.is_excluded(&vault_path) {
            continue;
        }
        if std::fs::read_to_string(path).is_ok_and(|c| has_conflict_markers(&c)) {
            out.push(vault_path);
        }
    }
    out.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    out
}

/// Sweep the vault for markdown files with unparseable frontmatter.
/// Mirrors `migrate::legacy_pages`: skips `.clepsydra/` and excluded paths.
/// Returns (path, warning) for files with unparseable frontmatter that are
/// not already in the conflicted set.
pub fn unparseable_pages(vault: &Vault) -> Vec<(VaultPath, String)> {
    let conflicted = conflicted_pages(vault);
    let conflicted_set: std::collections::HashSet<_> = conflicted.into_iter().collect();

    let mut out = Vec::new();
    for entry in WalkDir::new(vault.root())
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "md") {
            continue;
        }
        let Ok(rel) = path.strip_prefix(vault.root()) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.starts_with(".clepsydra/") {
            continue;
        }
        let Ok(vault_path) = VaultPath::new(&rel_str) else {
            continue;
        };
        if vault.is_excluded(&vault_path) {
            continue;
        }
        if conflicted_set.contains(&vault_path) {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(path) {
            let (_, _, _, warning) = parse_or_repair_frontmatter(&content);
            if let Some(w) = warning {
                out.push((vault_path, w));
            }
        }
    }
    out.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_three_markers_detected() {
        let content = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> theirs\n";
        assert!(has_conflict_markers(content));
    }

    #[test]
    fn two_markers_not_enough() {
        assert!(!has_conflict_markers("<<<<<<< HEAD\na\n=======\nb\n"));
        assert!(!has_conflict_markers("=======\n>>>>>>> theirs\n"));
    }

    #[test]
    fn plain_page_clean() {
        assert!(!has_conflict_markers(
            "+++\ntitle = \"x\"\n+++\nSeven = signs ==== here\n"
        ));
    }

    #[test]
    fn markers_inside_code_block_still_flag() {
        // Documented benign false positive (ADR 0004): flagging costs only
        // "no auto-repair + diagnostic".
        let content =
            "+++\ntitle = \"git notes\"\n+++\n```\n<<<<<<< HEAD\n=======\n>>>>>>> x\n```\n";
        assert!(has_conflict_markers(content));
    }

    #[test]
    fn conflicted_pages_sweeps_and_sorts() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(
            root.join("notes/b.md"),
            "<<<<<<< HEAD\n=======\n>>>>>>> x\n",
        )
        .unwrap();
        std::fs::write(
            root.join("notes/a.md"),
            "<<<<<<< HEAD\n=======\n>>>>>>> x\n",
        )
        .unwrap();
        std::fs::write(
            root.join("notes/clean.md"),
            "+++\ntitle = \"ok\"\n+++\nfine\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".clepsydra/skip.md"),
            "<<<<<<< HEAD\n=======\n>>>>>>> x\n",
        )
        .unwrap();
        let vault = Vault::open(&root).unwrap();
        let paths: Vec<String> = conflicted_pages(&vault)
            .iter()
            .map(|p| p.as_str().to_string())
            .collect();
        assert_eq!(paths, vec!["notes/a.md", "notes/b.md"]);
    }
}
