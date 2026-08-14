use std::fs;
use std::path::PathBuf;

use rusqlite::params;
use serde::Serialize;
use utoipa::ToSchema;

use super::Vault;
use super::batch_mutation::{
    BatchMutationCommand, BatchPathIntent, ExpectedPathState,
};
use super::canonical::CanonicalName;
use super::index::{IndexError, VaultIndex};
use super::page::parse_or_repair_frontmatter;
use super::path::VaultPath;
use super::rubbish::{RubbishItem, RubbishManifest};
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

fn collect_missing_parent_directories(
    vault: &Vault,
    path: &VaultPath,
    directories: &mut Vec<VaultPath>,
) -> Result<(), IndexError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let mut current = String::new();
    for component in parent.split('/') {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(component);
        let directory = VaultPath::new(&current).map_err(vp_err)?;
        if !vault.resolve(&directory).exists() && !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    Ok(())
}

fn collect_source_directories(
    vault: &Vault,
    source: &VaultPath,
    directories: &mut Vec<VaultPath>,
) -> Result<(), IndexError> {
    let source_absolute = vault.resolve(source);
    if !directories.contains(source) {
        directories.push(source.clone());
    }
    for entry in walkdir::WalkDir::new(&source_absolute)
        .min_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
    {
        let relative = entry
            .path()
            .strip_prefix(vault.root())
            .map_err(|error| IndexError::Other(error.to_string()))?;
        let directory = VaultPath::new(&relative.to_string_lossy()).map_err(vp_err)?;
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    Ok(())
}

fn is_protected_content(content: &str) -> bool {
    let (meta, _, _, _) = parse_or_repair_frontmatter(content);
    meta.encryption.is_some()
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
    MovePage { source: String, destination: String },
    DeletePage { path: String, rewrite: RewriteMode },
    MoveFolder { source: String, destination: String },
    ArchivePage {
        path: String,
        expected_bytes: Vec<u8>,
        manifest: RubbishManifest,
    },
    RestorePage {
        item: RubbishItem,
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

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlannedFileOp {
    pub kind: FileOpKind,
    pub path: String,
    pub destination: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileOpKind {
    Rename,
    Delete,
    CreateDir,
    CreateFile,
    Archive,
    Restore,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlannedTextEdit {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone)]
pub struct StagedWrite {
    pub path: PathBuf,
    pub expected_bytes: Vec<u8>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MutationPlan {
    pub file_ops: Vec<PlannedFileOp>,
    pub text_edits: Vec<PlannedTextEdit>,
    #[serde(skip)]
    #[schema(ignore)]
    pub index_events: Vec<ChangeEvent>,
    #[serde(skip)]
    #[schema(ignore)]
    pub staged_writes: Vec<StagedWrite>,
    #[serde(skip)]
    #[schema(ignore)]
    pub moved_pages: Vec<(VaultPath, VaultPath)>,
    #[serde(skip)]
    #[schema(ignore)]
    primary_intents: Vec<BatchPathIntent>,
    #[serde(skip)]
    #[schema(ignore)]
    create_directories: Vec<VaultPath>,
    #[serde(skip)]
    #[schema(ignore)]
    remove_directories: Vec<VaultPath>,
}

impl MutationPlan {
    pub fn empty() -> Self {
        Self {
            file_ops: Vec::new(),
            text_edits: Vec::new(),
            index_events: Vec::new(),
            staged_writes: Vec::new(),
            moved_pages: Vec::new(),
            primary_intents: Vec::new(),
            create_directories: Vec::new(),
            remove_directories: Vec::new(),
        }
    }

    pub fn stage_create_file(
        &mut self,
        vault: &Vault,
        path: VaultPath,
        content: Vec<u8>,
    ) -> Result<(), IndexError> {
        collect_missing_parent_directories(vault, &path, &mut self.create_directories)?;
        self.expose_create_directories();
        self.file_ops.push(PlannedFileOp {
            kind: FileOpKind::CreateFile,
            path: path.as_str().to_string(),
            destination: None,
            content_hash: Some(blake3::hash(&content).to_hex().to_string()),
        });
        self.primary_intents.push(BatchPathIntent::Write {
            path,
            expected: ExpectedPathState::Missing,
            content,
        });
        Ok(())
    }

    fn expose_create_directories(&mut self) {
        for directory in &self.create_directories {
            if !self.file_ops.iter().any(|operation| {
                matches!(operation.kind, FileOpKind::CreateDir)
                    && operation.path == directory.as_str()
            }) {
                self.file_ops.push(PlannedFileOp {
                    kind: FileOpKind::CreateDir,
                    path: directory.as_str().to_string(),
                    destination: None,
                    content_hash: None,
                });
            }
        }
    }

    /// Planner-produced expected bytes are captured in the same reads used to
    /// compute rewrites, so conversion never resamples a coherent plan.
    /// Manually assembled public file operations are snapshotted here because
    /// they have no planner-owned primary intent.
    pub fn into_batch_command(self, vault: &Vault) -> Result<BatchMutationCommand, IndexError> {
        let MutationPlan {
            file_ops,
            index_events,
            staged_writes,
            moved_pages,
            primary_intents,
            mut create_directories,
            mut remove_directories,
            ..
        } = self;
        let mut intents =
            Vec::with_capacity(staged_writes.len() + primary_intents.len() + file_ops.len());

        for write in staged_writes {
            let relative = write.path.strip_prefix(vault.root()).map_err(vp_err)?;
            let relative = relative.to_str().ok_or_else(|| {
                IndexError::Other(format!(
                    "staged write path is not valid UTF-8: {}",
                    write.path.display()
                ))
            })?;
            intents.push(BatchPathIntent::Write {
                path: VaultPath::new(relative).map_err(vp_err)?,
                expected: ExpectedPathState::Bytes(write.expected_bytes),
                content: write.content.into_bytes(),
            });
        }

        for op in file_ops {
            match op.kind {
                FileOpKind::CreateFile => {
                    let path = VaultPath::new(&op.path).map_err(vp_err)?;
                    let represented = primary_intents.iter().any(|intent| {
                        matches!(
                            intent,
                            BatchPathIntent::Write {
                                path: planned,
                                expected: ExpectedPathState::Missing,
                                content,
                            } if planned == &path
                                && op.content_hash.as_deref()
                                    == Some(blake3::hash(content).to_hex().as_str())
                        )
                    });
                    if !represented {
                        return Err(IndexError::Other(format!(
                            "create-file plan is missing immutable content for {}",
                            path.as_str()
                        )));
                    }
                }
                FileOpKind::CreateDir => {
                    let directory = VaultPath::new(&op.path).map_err(vp_err)?;
                    collect_missing_parent_directories(vault, &directory, &mut create_directories)?;
                    if !vault.resolve(&directory).exists()
                        && !create_directories.contains(&directory)
                    {
                        create_directories.push(directory);
                    }
                }
                FileOpKind::Rename => {
                    let source = VaultPath::new(&op.path).map_err(vp_err)?;
                    let destination = VaultPath::new(
                        op.destination
                            .as_deref()
                            .ok_or_else(|| IndexError::Other("rename missing destination".into()))?,
                    )
                    .map_err(vp_err)?;
                    let represented = remove_directories.contains(&source)
                        || primary_intents.iter().any(|intent| {
                            matches!(
                                intent,
                                BatchPathIntent::Move {
                                    source: planned_source,
                                    ..
                                } if planned_source == &source
                                    || planned_source
                                        .as_str()
                                        .strip_prefix(source.as_str())
                                        .is_some_and(|suffix| suffix.starts_with('/'))
                            )
                        });
                    if !represented {
                        let source_absolute = vault.resolve(&source);
                        if source_absolute.is_dir() {
                            for entry in walkdir::WalkDir::new(&source_absolute)
                                .into_iter()
                                .filter_map(Result::ok)
                                .filter(|entry| entry.file_type().is_file())
                            {
                                let relative = entry.path().strip_prefix(&source_absolute).map_err(
                                    |error| IndexError::Other(error.to_string()),
                                )?;
                                let destination_absolute = vault.resolve(&destination).join(relative);
                                let destination_file = VaultPath::new(
                                    &destination_absolute
                                        .strip_prefix(vault.root())
                                        .map_err(|error| IndexError::Other(error.to_string()))?
                                        .to_string_lossy(),
                                )
                                .map_err(vp_err)?;
                                collect_missing_parent_directories(
                                    vault,
                                    &destination_file,
                                    &mut create_directories,
                                )?;
                                intents.push(BatchPathIntent::Move {
                                    source: VaultPath::new(
                                        &entry
                                            .path()
                                            .strip_prefix(vault.root())
                                            .map_err(|error| {
                                                IndexError::Other(error.to_string())
                                            })?
                                            .to_string_lossy(),
                                    )
                                    .map_err(vp_err)?,
                                    destination: destination_file,
                                    expected_source: fs::read(entry.path())?,
                                });
                            }
                            collect_source_directories(
                                vault,
                                &source,
                                &mut remove_directories,
                            )?;
                        } else {
                            collect_missing_parent_directories(
                                vault,
                                &destination,
                                &mut create_directories,
                            )?;
                            intents.push(BatchPathIntent::Move {
                                source,
                                destination,
                                expected_source: fs::read(source_absolute)?,
                            });
                        }
                    }
                }
                FileOpKind::Delete => {
                    let path = VaultPath::new(&op.path).map_err(vp_err)?;
                    let represented = primary_intents.iter().any(
                        |intent| matches!(intent, BatchPathIntent::Delete { path: planned, .. } if planned == &path),
                    );
                    if !represented {
                        intents.push(BatchPathIntent::Delete {
                            expected: fs::read(vault.resolve(&path))?,
                            path,
                        });
                    }
                }
                FileOpKind::Archive => {
                    let path = VaultPath::new(&op.path).map_err(vp_err)?;
                    let represented = primary_intents.iter().any(|intent| {
                        matches!(
                            intent,
                            BatchPathIntent::ArchivePage {
                                path: planned,
                                expected_source,
                                ..
                            } if planned == &path
                                && op.content_hash.as_deref()
                                    == Some(blake3::hash(expected_source).to_hex().as_str())
                        )
                    });
                    if !represented {
                        return Err(IndexError::Other(format!(
                            "archive plan is missing immutable content for {}",
                            path.as_str()
                        )));
                    }
                }
                FileOpKind::Restore => {
                    let path = VaultPath::new(&op.path).map_err(vp_err)?;
                    let represented = primary_intents.iter().any(|intent| {
                        matches!(
                            intent,
                            BatchPathIntent::RestorePage {
                                destination,
                                item,
                            } if destination == &path
                                && op.content_hash.as_deref()
                                    == Some(blake3::hash(&item.bytes).to_hex().as_str())
                        )
                    });
                    if !represented {
                        return Err(IndexError::Other(format!(
                            "restore plan is missing immutable content for {}",
                            path.as_str()
                        )));
                    }
                }
            }
        }
        intents.extend(primary_intents);

        Ok(BatchMutationCommand {
            create_directories,
            remove_directories,
            intents,
            index_events,
            moved_pages,
        })
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
            MutationOp::ArchivePage {
                path,
                expected_bytes,
                manifest,
            } => self.plan_page_archive(path, expected_bytes, manifest),
            MutationOp::RestorePage { item } => self.plan_page_restore(item),
        }
    }

    fn plan_page_archive(
        &self,
        path: &str,
        expected_bytes: &[u8],
        manifest: &RubbishManifest,
    ) -> Result<MutationPlan, IndexError> {
        let path = VaultPath::new(path).map_err(vp_err)?;
        if manifest.original_path != path.as_str() {
            return Err(IndexError::Other(format!(
                "rubbish manifest original path {} does not match archive path {}",
                manifest.original_path,
                path.as_str()
            )));
        }

        let indexed_page_id = self
            .index
            .connection()
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![path.as_str()],
                |row| row.get::<_, String>(0),
            )
            .map_err(IndexError::Sqlite)?;
        if indexed_page_id != manifest.page_id.to_string() {
            return Err(IndexError::Other(format!(
                "rubbish manifest page ID {} does not match indexed page ID {}",
                manifest.page_id, indexed_page_id
            )));
        }

        let mut plan = MutationPlan::empty();
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Archive,
            path: path.as_str().to_owned(),
            destination: None,
            content_hash: Some(blake3::hash(expected_bytes).to_hex().to_string()),
        });
        plan.primary_intents.push(BatchPathIntent::ArchivePage {
            path: path.clone(),
            expected_source: expected_bytes.to_vec(),
            manifest: manifest.clone(),
        });
        plan.index_events.push(ChangeEvent::Remove(path));
        Ok(plan)
    }

    fn plan_page_restore(&self, item: &RubbishItem) -> Result<MutationPlan, IndexError> {
        let destination = VaultPath::new(&item.manifest.original_path).map_err(vp_err)?;
        let mut plan = MutationPlan::empty();
        collect_missing_parent_directories(
            self.vault,
            &destination,
            &mut plan.create_directories,
        )?;
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Restore,
            path: destination.as_str().to_owned(),
            destination: None,
            content_hash: Some(blake3::hash(&item.bytes).to_hex().to_string()),
        });
        plan.primary_intents.push(BatchPathIntent::RestorePage {
            destination: destination.clone(),
            item: item.clone(),
        });
        plan.index_events.push(ChangeEvent::Upsert(destination));
        plan.expose_create_directories();
        Ok(plan)
    }

    fn plan_page_move(&self, source: &str, destination: &str) -> Result<MutationPlan, IndexError> {
        let source_vp = VaultPath::new(source).map_err(vp_err)?;
        let dest_vp = VaultPath::new(destination).map_err(vp_err)?;

        let source_abs = self.vault.resolve(&source_vp);
        let source_bytes = fs::read(&source_abs)?;
        let source_title = std::str::from_utf8(&source_bytes).ok().and_then(|content| {
            let (meta, _, _, _) = parse_or_repair_frontmatter(content);
            meta.title
        });

        let old_stem = source_vp.stem().to_string();
        let new_stem = dest_vp.stem().to_string();

        let mut plan = MutationPlan::empty();

        // 1. File operation: rename source -> destination
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Rename,
            path: source.to_string(),
            destination: Some(destination.to_string()),
            content_hash: None,
        });
        plan.moved_pages.push((source_vp.clone(), dest_vp.clone()));
        collect_missing_parent_directories(
            self.vault,
            &dest_vp,
            &mut plan.create_directories,
        )?;
        plan.primary_intents.push(BatchPathIntent::Move {
            source: source_vp.clone(),
            destination: dest_vp.clone(),
            expected_source: source_bytes,
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
            if is_protected_content(&content) {
                continue;
            }

            let mut replacements: Vec<(String, String)> = Vec::new();

            // Stem-based wikilink rewrite
            if old_stem != new_stem {
                replacements.push((old_stem.clone(), new_stem.clone()));
            }

            // Title-based wikilink rewrite
            if let Some(title) = &source_title
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
                plan.staged_writes.push(StagedWrite {
                    path: ref_abs,
                    expected_bytes: content.as_bytes().to_vec(),
                    content: new_content,
                });

                // Index event for the modified page
                plan.index_events.push(ChangeEvent::Upsert(ref_vp));
            }
        }

        // 4. Index events for source/destination
        plan.index_events
            .push(ChangeEvent::Remove(source_vp.clone()));
        plan.index_events.push(ChangeEvent::Upsert(dest_vp));

        plan.expose_create_directories();
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
        let target_bytes = fs::read(&target_abs)?;

        let mut plan = MutationPlan::empty();

        // 1. File operation: delete the target page
        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Delete,
            path: path.to_string(),
            destination: None,
            content_hash: None,
        });
        plan.primary_intents.push(BatchPathIntent::Delete {
            path: target_vp.clone(),
            expected: target_bytes.clone(),
        });

        // 2. Index event: remove the deleted page
        plan.index_events
            .push(ChangeEvent::Remove(target_vp.clone()));

        // 3. If no rewriting requested, return early
        if rewrite == RewriteMode::None {
            return Ok(plan);
        }

        // 4. Read the target snapshot to get its title for display text.
        let display_text = std::str::from_utf8(&target_bytes)
            .ok()
            .and_then(|content| {
                let (meta, _, _, _) = parse_or_repair_frontmatter(content);
                meta.title
            })
            .unwrap_or_else(|| old_stem.clone());

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
            if is_protected_content(&content) {
                continue;
            }

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
                plan.staged_writes.push(StagedWrite {
                    path: ref_abs,
                    expected_bytes: content.as_bytes().to_vec(),
                    content: new_content,
                });

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

        plan.file_ops.push(PlannedFileOp {
            kind: FileOpKind::Rename,
            path: source.to_string(),
            destination: Some(destination.to_string()),
            content_hash: None,
        });

        // Snapshot the folder exactly once. File intents, directory metadata,
        // index events, and move-hook metadata all derive from this inventory.
        let mut md_files = Vec::<(VaultPath, VaultPath, Vec<u8>)>::new();
        for entry in walkdir::WalkDir::new(&source_abs)
            .into_iter()
            .filter_map(Result::ok)
        {
            let absolute = entry.path();
            let suffix = absolute.strip_prefix(&source_abs).map_err(vp_err)?;
            let source_relative = absolute.strip_prefix(self.vault.root()).map_err(vp_err)?;
            let destination_absolute = self.vault.resolve(&dest_vp).join(suffix);
            let destination_relative = destination_absolute
                .strip_prefix(self.vault.root())
                .map_err(vp_err)?;
            let source_path =
                VaultPath::new(&source_relative.to_string_lossy()).map_err(vp_err)?;
            let destination_path =
                VaultPath::new(&destination_relative.to_string_lossy()).map_err(vp_err)?;

            if entry.file_type().is_dir() {
                collect_missing_parent_directories(
                    self.vault,
                    &destination_path,
                    &mut plan.create_directories,
                )?;
                if !self.vault.resolve(&destination_path).exists()
                    && !plan.create_directories.contains(&destination_path)
                {
                    plan.create_directories.push(destination_path);
                }
                plan.remove_directories.push(source_path);
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }

            let expected_source = fs::read(absolute)?;
            collect_missing_parent_directories(
                self.vault,
                &destination_path,
                &mut plan.create_directories,
            )?;
            plan.primary_intents.push(BatchPathIntent::Move {
                source: source_path.clone(),
                destination: destination_path.clone(),
                expected_source: expected_source.clone(),
            });
            if absolute.extension().is_some_and(|extension| extension == "md") {
                md_files.push((source_path, destination_path, expected_source));
            }
        }

        let mut upserted_refs = Vec::<String>::new();
        let source_prefix = format!("{}/", source_vp.as_str());
        for (old_vp, new_vp, expected_source) in &md_files {
            let old_stem = old_vp.stem().to_string();
            let new_stem = new_vp.stem().to_string();
            let source_title = std::str::from_utf8(expected_source).ok().and_then(|content| {
                let (meta, _, _, _) = parse_or_repair_frontmatter(content);
                meta.title
            });
            plan.moved_pages.push((old_vp.clone(), new_vp.clone()));
            plan.index_events.push(ChangeEvent::Remove(old_vp.clone()));
            plan.index_events.push(ChangeEvent::Upsert(new_vp.clone()));

            let backlink_pages = self
                .find_backlink_pages(old_vp, &old_stem)?
                .into_iter()
                .filter(|(_, path)| !path.starts_with(&source_prefix))
                .collect::<Vec<_>>();

            for (_, ref_path_str) in backlink_pages {
                let ref_vp = VaultPath::new(&ref_path_str).map_err(vp_err)?;
                let ref_abs = self.vault.resolve(&ref_vp);
                let existing_index = plan
                    .staged_writes
                    .iter()
                    .position(|write| write.path == ref_abs);
                let (content, expected_bytes) = if let Some(index) = existing_index {
                    (plan.staged_writes[index].content.clone(), None)
                } else {
                    let content = fs::read_to_string(&ref_abs)?;
                    if is_protected_content(&content) {
                        continue;
                    }
                    let expected = content.as_bytes().to_vec();
                    (content, Some(expected))
                };

                let mut replacements = Vec::<(String, String)>::new();
                if old_stem != new_stem {
                    replacements.push((old_stem.clone(), new_stem.clone()));
                }
                if let Some(title) = &source_title
                    && title != &old_stem
                    && title != &new_stem
                {
                    replacements.push((title.clone(), new_stem.clone()));
                }
                let old_rel = compute_relative_path(ref_vp.as_str(), old_vp.as_str());
                let new_rel = compute_relative_path(ref_vp.as_str(), new_vp.as_str());
                if old_rel != new_rel {
                    replacements.push((old_rel, new_rel));
                }
                if replacements.is_empty() {
                    continue;
                }

                let replacement_refs = replacements
                    .iter()
                    .map(|(old, new)| (old.as_str(), new.as_str()))
                    .collect::<Vec<_>>();
                let new_content =
                    rewriter::rewrite_links_in_content(&content, &replacement_refs);
                if new_content == content {
                    continue;
                }
                for (old, new) in &replacements {
                    plan.text_edits.push(PlannedTextEdit {
                        path: ref_path_str.clone(),
                        old_text: old.clone(),
                        new_text: new.clone(),
                    });
                }
                if let Some(index) = existing_index {
                    plan.staged_writes[index].content = new_content;
                } else {
                    plan.staged_writes.push(StagedWrite {
                        path: ref_abs,
                        expected_bytes: expected_bytes.expect("new staged write has snapshot"),
                        content: new_content,
                    });
                }
                if !upserted_refs.contains(&ref_path_str) {
                    plan.index_events.push(ChangeEvent::Upsert(ref_vp));
                    upserted_refs.push(ref_path_str);
                }
            }
        }

        plan.expose_create_directories();
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
