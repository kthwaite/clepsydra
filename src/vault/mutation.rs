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

    /// Execute the mutation plan: perform file operations, apply staged writes,
    /// and incrementally update the index.
    ///
    /// File operations run first so that if they fail, backlink pages remain
    /// untouched. If staged writes fail after file ops, a full rebuild recovers
    /// correct state.
    ///
    /// Consumes `self` since each plan should be executed exactly once.
    pub fn execute(
        self,
        vault: &Vault,
        index: &mut VaultIndex,
    ) -> Result<(), IndexError> {
        // 1. Perform file operations FIRST (primary mutation)
        for op in &self.file_ops {
            match op.kind {
                FileOpKind::Rename => {
                    if let Some(ref dest) = op.destination {
                        let source_vp = VaultPath::new(&op.path).map_err(vp_err)?;
                        let dest_vp = VaultPath::new(dest).map_err(vp_err)?;
                        let source_abs = vault.resolve(&source_vp);
                        let dest_abs = vault.resolve(&dest_vp);
                        if let Some(parent) = dest_abs.parent() {
                            fs::create_dir_all(parent)?;
                        }
                        fs::rename(&source_abs, &dest_abs)?;
                    }
                }
                FileOpKind::Delete => {
                    let vp = VaultPath::new(&op.path).map_err(vp_err)?;
                    let abs = vault.resolve(&vp);
                    if abs.exists() {
                        fs::remove_file(&abs)?;
                    }
                }
                FileOpKind::CreateDir => {
                    let vp = VaultPath::new(&op.path).map_err(vp_err)?;
                    let abs = vault.resolve(&vp);
                    fs::create_dir_all(&abs)?;
                }
            }
        }

        // 2. Apply staged writes and sync index.
        // On failure, attempt a full rebuild to restore consistency.
        let post_result = (|| -> Result<(), IndexError> {
            if !self.staged_writes.is_empty() {
                rewriter::apply_staged_writes(&self.staged_writes)?;
            }
            use super::sync::SyncEngine;
            SyncEngine::process_events(&self.index_events, vault, index)?;
            Ok(())
        })();

        if post_result.is_err() {
            // Best-effort recovery: rebuild index from filesystem truth
            let _ = index.build(vault);
            let _ = index.resolve_links();
        }

        post_result
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

        // Filter: don't rewrite the page being moved (it's handled by the rename)
        let backlink_pages: Vec<_> = backlink_pages
            .into_iter()
            .filter(|(_, p)| p != source)
            .collect();

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
                // Record per-replacement text edits (for dry-run preview)
                for (old, new) in &replacements {
                    plan.text_edits.push(PlannedTextEdit {
                        path: ref_path_str.clone(),
                        old_text: old.clone(),
                        new_text: new.clone(),
                    });
                }

                // Stage the write (for execution)
                plan.staged_writes.push((ref_abs, new_content));

                // Index event for the modified page
                plan.index_events.push(ChangeEvent::Upsert(ref_vp));
            }
        }

        // 4. Index events for source/destination
        plan.index_events
            .push(ChangeEvent::Remove(source_vp.clone()));
        plan.index_events.push(ChangeEvent::Upsert(dest_vp));

        Ok(plan)
    }

    fn plan_page_delete(
        &self,
        path: &str,
        rewrite: RewriteMode,
    ) -> Result<MutationPlan, IndexError> {
        let target_vp = VaultPath::new(path).map_err(vp_err)?;
        let target_abs = self.vault.resolve(&target_vp);
        let old_stem = target_vp.stem().to_string();

        let mut plan = MutationPlan::empty();

        // 1. File operation: delete the target page
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Delete,
            path: path.to_string(),
            destination: None,
        });

        // 2. Index event: remove the deleted page
        plan.index_events
            .push(ChangeEvent::Remove(target_vp.clone()));

        // 3. If no rewriting requested, return early
        if rewrite == RewriteMode::None {
            return Ok(plan);
        }

        // 4. Read the target page to get its title for display text
        let display_text = if let Ok(page) = Page::from_file(&target_abs, target_vp.clone()) {
            page.meta
                .title
                .clone()
                .unwrap_or_else(|| old_stem.clone())
        } else {
            old_stem.clone()
        };

        // 5. Choose sentinel prefix based on rewrite mode
        let sentinel_prefix = match rewrite {
            RewriteMode::PlainText => rewriter::DELETE_PLAIN,
            RewriteMode::Unlink => rewriter::DELETE_UNLINK,
            RewriteMode::None => unreachable!(),
        };
        let sentinel = format!("{sentinel_prefix}{display_text}");

        // 6. Find backlink pages and rewrite them
        let backlink_pages = self.find_backlink_pages(&target_vp, &old_stem)?;

        // Filter: don't rewrite the page being deleted (self-links)
        let backlink_pages: Vec<_> = backlink_pages
            .into_iter()
            .filter(|(_, p)| p != path)
            .collect();

        for (_, ref_path_str) in &backlink_pages {
            let ref_vp = VaultPath::new(ref_path_str).map_err(vp_err)?;
            let ref_abs = self.vault.resolve(&ref_vp);

            let content = fs::read_to_string(&ref_abs)?;

            let mut replacements: Vec<(String, String)> = Vec::new();

            // Stem-based replacement
            replacements.push((old_stem.clone(), sentinel.clone()));

            // Title-based replacement (if title differs from stem)
            if display_text != old_stem {
                replacements.push((display_text.clone(), sentinel.clone()));
            }

            // Markdown link: relative path replacement
            let old_rel = compute_relative_path(ref_vp.as_str(), target_vp.as_str());
            if old_rel != old_stem {
                replacements.push((old_rel, sentinel.clone()));
            }

            let replacement_refs: Vec<(&str, &str)> = replacements
                .iter()
                .map(|(old, new)| (old.as_str(), new.as_str()))
                .collect();

            let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
            if new_content != content {
                // Record per-replacement text edits (for dry-run preview)
                for (old, _new) in &replacements {
                    plan.text_edits.push(PlannedTextEdit {
                        path: ref_path_str.clone(),
                        old_text: old.clone(),
                        new_text: display_text.clone(),
                    });
                }

                // Stage the write (for execution)
                plan.staged_writes.push((ref_abs, new_content));

                // Index event for the modified page
                plan.index_events.push(ChangeEvent::Upsert(ref_vp));
            }
        }

        Ok(plan)
    }

    fn plan_folder_move(
        &self,
        source: &str,
        destination: &str,
    ) -> Result<MutationPlan, IndexError> {
        let source_vp = VaultPath::new(source).map_err(vp_err)?;
        let dest_vp = VaultPath::new(destination).map_err(vp_err)?;
        let source_abs = self.vault.resolve(&source_vp);

        let mut plan = MutationPlan::empty();

        // 1. File operation: rename the folder
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Rename,
            path: source.to_string(),
            destination: Some(destination.to_string()),
        });

        // 2. Walk the source directory to find all .md files
        let mut md_files: Vec<(VaultPath, VaultPath)> = Vec::new();
        for entry in walkdir::WalkDir::new(&source_abs)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        {
            let abs = entry.path();
            let rel = abs
                .strip_prefix(self.vault.root())
                .map_err(vp_err)?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");

            // Compute new path: replace source prefix with destination prefix
            let suffix = rel_str
                .strip_prefix(source_vp.as_str())
                .unwrap_or(&rel_str);
            let new_rel = format!("{}{suffix}", dest_vp.as_str());

            let old_vp = VaultPath::new(&rel_str).map_err(vp_err)?;
            let new_vp = VaultPath::new(&new_rel).map_err(vp_err)?;

            md_files.push((old_vp, new_vp));
        }

        // 3. For each file, compute backlinks and build rewrites
        let mut upserted_refs: Vec<String> = Vec::new();

        for (old_vp, new_vp) in &md_files {
            let old_stem = old_vp.stem().to_string();
            let new_stem = new_vp.stem().to_string();
            let old_abs = self.vault.resolve(old_vp);

            // Index events for the moved file
            plan.index_events
                .push(ChangeEvent::Remove(old_vp.clone()));
            plan.index_events
                .push(ChangeEvent::Upsert(new_vp.clone()));

            // Find backlink pages
            let backlink_pages = self.find_backlink_pages(old_vp, &old_stem)?;

            // Filter: skip pages inside the moved folder — their internal
            // cross-references don't need rewriting since the whole folder moves.
            let source_prefix = format!("{}/", source_vp.as_str());
            let backlink_pages: Vec<_> = backlink_pages
                .into_iter()
                .filter(|(_, p)| !p.starts_with(&source_prefix))
                .collect();

            if backlink_pages.is_empty() {
                continue;
            }

            for (_, ref_path_str) in &backlink_pages {
                let ref_vp = VaultPath::new(ref_path_str).map_err(vp_err)?;
                let ref_abs = self.vault.resolve(&ref_vp);

                // Read from staged write if we already have one, otherwise from disk
                let content = if let Some(existing) =
                    plan.staged_writes.iter().find(|(p, _)| *p == ref_abs)
                {
                    existing.1.clone()
                } else {
                    fs::read_to_string(&ref_abs)?
                };

                let mut replacements: Vec<(String, String)> = Vec::new();

                // Stem-based wikilink rewrite
                if old_stem != new_stem {
                    replacements.push((old_stem.clone(), new_stem.clone()));
                }

                // Title-based wikilink rewrite
                if let Ok(page) = Page::from_file(&old_abs, old_vp.clone())
                    && let Some(ref title) = page.meta.title
                    && title != &old_stem
                    && title != &new_stem
                {
                    replacements.push((title.clone(), new_stem.clone()));
                }

                // Markdown link: old relative path -> new relative path
                let old_rel = compute_relative_path(ref_vp.as_str(), old_vp.as_str());
                let new_rel = compute_relative_path(ref_vp.as_str(), new_vp.as_str());
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
                    // Record per-replacement text edits (for dry-run preview)
                    for (old, new) in &replacements {
                        plan.text_edits.push(PlannedTextEdit {
                            path: ref_path_str.clone(),
                            old_text: old.clone(),
                            new_text: new.clone(),
                        });
                    }

                    // Stage the write (dedup: update existing or push new)
                    if let Some(existing) =
                        plan.staged_writes.iter_mut().find(|(p, _)| *p == ref_abs)
                    {
                        let re_rewritten =
                            rewriter::rewrite_links_in_content(&existing.1, &replacement_refs);
                        existing.1 = re_rewritten;
                    } else {
                        plan.staged_writes.push((ref_abs, new_content));
                    }

                    // Dedup index events for modified referencing pages
                    if !upserted_refs.contains(ref_path_str) {
                        plan.index_events.push(ChangeEvent::Upsert(ref_vp));
                        upserted_refs.push(ref_path_str.clone());
                    }
                }
            }
        }

        Ok(plan)
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
