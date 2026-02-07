use std::fs;
use std::path::PathBuf;

use rusqlite::params;
use serde::Serialize;

use super::Vault;
use super::canonical::CanonicalName;
use super::index::{IndexError, VaultIndex};
use super::page::Page;
use super::path::VaultPath;
use super::rewriter;
use super::sync::ChangeEvent;

// ---------------------------------------------------------------------------
// Utility: VaultPath error → IndexError mapping
// ---------------------------------------------------------------------------

fn vp_err(e: impl std::fmt::Display) -> IndexError {
    IndexError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        e.to_string(),
    ))
}

// ---------------------------------------------------------------------------
// compute_relative_path (shared utility, previously duplicated in api)
// ---------------------------------------------------------------------------

/// Compute a relative path from `from_path` to `to_path`, where both are
/// vault-relative paths (e.g. `notes/a.md`, `notes/b.md`).
pub fn compute_relative_path(from_path: &str, to_path: &str) -> String {
    let from_dir = if let Some(pos) = from_path.rfind('/') {
        &from_path[..pos]
    } else {
        ""
    };

    let to_dir = if let Some(pos) = to_path.rfind('/') {
        &to_path[..pos]
    } else {
        ""
    };

    let to_filename = if let Some(pos) = to_path.rfind('/') {
        &to_path[pos + 1..]
    } else {
        to_path
    };

    if from_dir == to_dir {
        return to_filename.to_string();
    }

    let from_parts: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };

    let to_parts: Vec<&str> = if to_dir.is_empty() {
        Vec::new()
    } else {
        to_dir.split('/').collect()
    };

    let common_len = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = from_parts.len() - common_len;
    let mut result = String::new();
    for _ in 0..ups {
        result.push_str("../");
    }
    for part in &to_parts[common_len..] {
        result.push_str(part);
        result.push('/');
    }
    result.push_str(to_filename);

    result
}

// ---------------------------------------------------------------------------
// MutationOp
// ---------------------------------------------------------------------------

/// A mutation operation to be planned.
#[derive(Debug, Clone)]
pub enum MutationOp {
    MovePage {
        source: String,
        destination: String,
    },
    DeletePage {
        path: String,
        rewrite: RewriteMode,
    },
    MoveFolder {
        source: String,
        destination: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewriteMode {
    PlainText,
    Unlink,
    None,
}

// ---------------------------------------------------------------------------
// MutationPlan
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PlannedFileOp {
    pub kind: FileOpKind,
    pub path: String,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpKind {
    Rename,
    Delete,
    CreateDir,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlannedTextEdit {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationPlan {
    pub file_ops: Vec<PlannedFileOp>,
    pub text_edits: Vec<PlannedTextEdit>,
    #[serde(skip)]
    pub index_events: Vec<ChangeEvent>,
    #[serde(skip)]
    pub staged_writes: Vec<(PathBuf, String)>,
}

impl MutationPlan {
    pub fn empty() -> Self {
        Self {
            file_ops: Vec::new(),
            text_edits: Vec::new(),
            index_events: Vec::new(),
            staged_writes: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// MutationPlanner
// ---------------------------------------------------------------------------

pub struct MutationPlanner<'a> {
    vault: &'a Vault,
    index: &'a VaultIndex,
}

impl<'a> MutationPlanner<'a> {
    pub fn new(vault: &'a Vault, index: &'a VaultIndex) -> Self {
        Self { vault, index }
    }

    pub fn plan(&self, op: &MutationOp) -> Result<MutationPlan, IndexError> {
        match op {
            MutationOp::MovePage {
                source,
                destination,
            } => self.plan_page_move(source, destination),
            MutationOp::DeletePage { path, rewrite } => self.plan_page_delete(path, *rewrite),
            MutationOp::MoveFolder {
                source,
                destination,
            } => self.plan_folder_move(source, destination),
        }
    }

    fn plan_page_move(
        &self,
        source: &str,
        destination: &str,
    ) -> Result<MutationPlan, IndexError> {
        let source_vp = VaultPath::new(source).map_err(vp_err)?;
        let dest_vp = VaultPath::new(destination).map_err(vp_err)?;

        let source_abs = self.vault.resolve(&source_vp);

        let old_stem = source_vp.stem().to_string();
        let new_stem = dest_vp.stem().to_string();

        let mut plan = MutationPlan::empty();

        // 1. File operation: rename source -> destination
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Rename,
            path: source.to_string(),
            destination: Some(destination.to_string()),
        });

        // 2. Find backlink pages
        let backlink_pages = self.find_backlink_pages(&source_vp, &old_stem)?;

        // 3. For each backlink page, compute replacement pairs and rewrite
        for (_, ref_path_str) in &backlink_pages {
            let ref_vp = VaultPath::new(ref_path_str).map_err(vp_err)?;
            let ref_abs = self.vault.resolve(&ref_vp);

            let content = fs::read_to_string(&ref_abs)?;

            let mut replacements: Vec<(String, String)> = Vec::new();

            // Stem-based wikilink rewrite
            if old_stem != new_stem {
                replacements.push((old_stem.clone(), new_stem.clone()));
            }

            // Title-based wikilink rewrite
            if let Ok(page) = Page::from_file(&source_abs, source_vp.clone())
                && let Some(ref title) = page.meta.title
                && title != &old_stem
                && title != &new_stem
            {
                replacements.push((title.clone(), new_stem.clone()));
            }

            // Markdown link: old relative path -> new relative path
            let old_rel = compute_relative_path(ref_vp.as_str(), source_vp.as_str());
            let new_rel = compute_relative_path(ref_vp.as_str(), dest_vp.as_str());
            if old_rel != new_rel {
                replacements.push((old_rel, new_rel));
            }

            if replacements.is_empty() {
                continue;
            }

            let replacement_refs: Vec<(&str, &str)> = replacements
                .iter()
                .map(|(old, new)| (old.as_str(), new.as_str()))
                .collect();

            let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
            if new_content != content {
                // Record text edits (for dry-run preview)
                plan.text_edits.push(PlannedTextEdit {
                    path: ref_path_str.clone(),
                    old_text: content.clone(),
                    new_text: new_content.clone(),
                });

                // Stage the write (for execution)
                plan.staged_writes.push((ref_abs, new_content));
            }
        }

        // 4. Index events
        plan.index_events
            .push(ChangeEvent::Remove(source_vp.clone()));
        plan.index_events.push(ChangeEvent::Upsert(dest_vp));

        // Upsert events for each modified referencing page
        for (_, ref_path_str) in &backlink_pages {
            if plan
                .staged_writes
                .iter()
                .any(|(p, _)| p == &self.vault.resolve(&VaultPath::new(ref_path_str).unwrap()))
            {
                let ref_vp = VaultPath::new(ref_path_str).map_err(vp_err)?;
                plan.index_events.push(ChangeEvent::Upsert(ref_vp));
            }
        }

        Ok(plan)
    }

    fn plan_page_delete(
        &self,
        _path: &str,
        _rewrite: RewriteMode,
    ) -> Result<MutationPlan, IndexError> {
        Ok(MutationPlan::empty()) // Placeholder for Task 3
    }

    fn plan_folder_move(
        &self,
        _source: &str,
        _destination: &str,
    ) -> Result<MutationPlan, IndexError> {
        Ok(MutationPlan::empty()) // Placeholder for Task 4
    }

    fn find_backlink_pages(
        &self,
        target_vp: &VaultPath,
        target_stem: &str,
    ) -> Result<Vec<(String, String)>, IndexError> {
        let target_canonical = CanonicalName::new(target_stem);
        let mut stmt = self.index.connection().prepare(
            "SELECT DISTINCT l.source_id, p.path
             FROM links l
             JOIN pages p ON p.id = l.source_id
             WHERE l.target_path = ?1 OR l.target_canonical = ?2",
        )?;
        let pages: Vec<(String, String)> = stmt
            .query_map(
                params![target_vp.as_str(), target_canonical.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .filter_map(|r| r.ok())
            .collect();
        Ok(pages)
    }
}
