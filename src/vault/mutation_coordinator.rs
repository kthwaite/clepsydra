use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use thiserror::Error;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::Vault;
use super::hooks::PostMoveHook;
use super::index::IndexError;
use super::index_handle::IndexHandle;
use super::index_policy::{IndexMutation, IndexPolicyError};
use super::page::{PageMeta, write_page_content};
use super::path::VaultPath;
use super::projection::{project_path, project_path_cleared};

/// Serializes mutations that touch the same normalized vault paths.
pub struct MutationCoordinator {
    locks: parking_lot::Mutex<HashMap<VaultPath, Weak<Mutex<()>>>>,
}

/// A transport-independent description of the index change emitted after a
/// successful filesystem and index mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationNotification {
    pub upserted: Vec<String>,
    pub removed: Vec<String>,
}

/// Project mutation intent. Absence and explicit clearing are deliberately
/// distinct because only an explicit clear strips the projected subfolder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectAssignment {
    Unchanged,
    Set(String),
    Clear,
}

#[derive(Debug)]
pub struct CreatePageCommand {
    pub path: VaultPath,
    pub meta: PageMeta,
    pub body: String,
}

/// A complete replacement prepared by an API adapter from its existing DTO.
///
/// `expected_content` prevents a read/modify/write handler from overwriting a
/// newer coordinator mutation while it waits for the path lock.
#[derive(Debug)]
pub struct UpdatePageCommand {
    pub path: VaultPath,
    pub expected_content: String,
    pub meta: PageMeta,
    pub body: String,
    pub project: ProjectAssignment,
    /// Whether metadata projection should run after the content update.
    pub reconcile: bool,
}

#[derive(Debug)]
pub struct PageMutationResult {
    pub path: VaultPath,
    pub meta: PageMeta,
    pub body: String,
}

#[derive(Debug, Error)]
pub enum MutationError {
    #[error("invalid mutation input: {0}")]
    InvalidInput(String),
    #[error("page not found: {0}")]
    NotFound(VaultPath),
    #[error("mutation conflict: {0}")]
    Conflict(String),
    #[error("stale page content: {0}")]
    Stale(VaultPath),
    #[error("filesystem mutation failed for {path}: {source}")]
    Filesystem {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("index mutation failed after filesystem_applied={filesystem_applied}: {source}")]
    Index {
        filesystem_applied: bool,
        #[source]
        source: IndexPolicyError,
    },
    #[error("move reconciliation failed after filesystem_applied={filesystem_applied}: {source}")]
    Reconcile {
        filesystem_applied: bool,
        #[source]
        source: IndexError,
    },
    #[error("post-move hook failed after filesystem_applied={filesystem_applied}: {message}")]
    Hook {
        filesystem_applied: bool,
        message: String,
    },
}

impl MutationCoordinator {
    pub fn new() -> Self {
        Self {
            locks: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    /// Lock all requested paths in lexical order, preventing lock-order cycles.
    pub async fn lock_paths(&self, paths: &[VaultPath]) -> MutationGuard {
        let mut keys = paths.to_vec();
        keys.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
        keys.dedup();

        let locks = {
            let mut table = self.locks.lock();
            table.retain(|_, lock| lock.strong_count() != 0);
            keys.into_iter()
                .map(|key| {
                    if let Some(lock) = table.get(&key).and_then(Weak::upgrade) {
                        lock
                    } else {
                        let lock = Arc::new(Mutex::new(()));
                        table.insert(key, Arc::downgrade(&lock));
                        lock
                    }
                })
                .collect::<Vec<_>>()
        };

        let mut guards = Vec::with_capacity(locks.len());
        for lock in &locks {
            guards.push(Arc::clone(lock).lock_owned().await);
        }

        MutationGuard {
            _guards: guards,
            _locks: locks,
        }
    }

    pub async fn create_page(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        command: CreatePageCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<PageMutationResult, MutationError> {
        let _guard = self.lock_paths(std::slice::from_ref(&command.path)).await;
        let absolute = vault.resolve(&command.path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|source| MutationError::Filesystem {
                path: parent.to_path_buf(),
                source,
            })?;
        }

        let content = write_page_content(&command.meta, &command.body);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&absolute)
        {
            Ok(file) => file,
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                return Err(MutationError::Conflict(format!(
                    "page already exists: {}",
                    command.path.as_str()
                )));
            }
            Err(source) => {
                return Err(MutationError::Filesystem {
                    path: absolute,
                    source,
                });
            }
        };
        if let Err(source) = file
            .write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&absolute);
            return Err(MutationError::Filesystem {
                path: absolute,
                source,
            });
        }
        drop(file);

        index
            .apply_mutation(command.path.clone(), IndexMutation::Created)
            .await
            .map_err(|source| MutationError::Index {
                filesystem_applied: true,
                source,
            })?;

        notify(MutationNotification {
            upserted: vec![command.path.as_str().to_string()],
            removed: Vec::new(),
        });
        Ok(PageMutationResult {
            path: command.path,
            meta: command.meta,
            body: command.body,
        })
    }

    pub async fn update_page(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
        command: UpdatePageCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<PageMutationResult, MutationError> {
        match &command.project {
            ProjectAssignment::Set(project)
                if command.meta.project.as_deref() != Some(project.as_str()) =>
            {
                return Err(MutationError::InvalidInput(
                    "project assignment does not match page metadata".to_string(),
                ));
            }
            ProjectAssignment::Clear if command.meta.project.is_some() => {
                return Err(MutationError::InvalidInput(
                    "cleared project remains in page metadata".to_string(),
                ));
            }
            ProjectAssignment::Unchanged | ProjectAssignment::Set(_) | ProjectAssignment::Clear => {
            }
        }
        let projected = if command.reconcile {
            match &command.project {
                ProjectAssignment::Clear => {
                    project_path_cleared(command.path.as_str(), command.meta.kind)
                }
                ProjectAssignment::Unchanged | ProjectAssignment::Set(_) => project_path(
                    command.path.as_str(),
                    command.meta.kind,
                    command.meta.project.as_deref(),
                ),
            }
        } else {
            None
        };
        let projected_path = projected
            .as_deref()
            .map(VaultPath::new)
            .transpose()
            .map_err(|error| MutationError::InvalidInput(error.to_string()))?;
        let mut locked_paths = vec![command.path.clone()];
        if let Some(destination) = &projected_path {
            locked_paths.push(destination.clone());
        }
        let _guard = self.lock_paths(&locked_paths).await;

        let absolute = vault.resolve(&command.path);
        let current = match fs::read_to_string(&absolute) {
            Ok(current) => current,
            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                return Err(MutationError::NotFound(command.path));
            }
            Err(source) => {
                return Err(MutationError::Filesystem {
                    path: absolute,
                    source,
                });
            }
        };
        if current != command.expected_content {
            return Err(MutationError::Stale(command.path));
        }
        if let Some(destination) = &projected_path {
            let destination_absolute = vault.resolve(destination);
            if destination_absolute.exists() {
                return Err(MutationError::Conflict(format!(
                    "destination already exists: {}",
                    destination.as_str()
                )));
            }
        }

        let content = write_page_content(&command.meta, &command.body);
        atomic_replace(&absolute, content.as_bytes()).map_err(|source| {
            MutationError::Filesystem {
                path: absolute.clone(),
                source,
            }
        })?;

        index
            .apply_mutation(command.path.clone(), IndexMutation::ContentChanged)
            .await
            .map_err(|source| MutationError::Index {
                filesystem_applied: true,
                source,
            })?;

        let final_path = if let Some(destination) = projected_path {
            let source = command.path.as_str().to_string();
            let destination_string = destination.as_str().to_string();
            let hooks = Arc::clone(&hooks);
            let moved = index
                .with_index(move |vault_index, index_vault| {
                    super::reconcile::move_page_to(
                        index_vault,
                        vault_index,
                        &source,
                        &destination_string,
                        &hooks,
                    )
                })
                .await
                .map_err(|source| MutationError::Reconcile {
                    filesystem_applied: true,
                    source,
                })?
                .map_err(|source| match source {
                    IndexError::Other(message) => MutationError::Hook {
                        filesystem_applied: true,
                        message,
                    },
                    source => MutationError::Reconcile {
                        filesystem_applied: true,
                        source,
                    },
                })?;
            let moved = moved.ok_or_else(|| {
                MutationError::Conflict(format!(
                    "destination became unavailable: {}",
                    destination.as_str()
                ))
            })?;
            VaultPath::new(&moved)
                .map_err(|error| MutationError::InvalidInput(error.to_string()))?
        } else {
            command.path.clone()
        };

        notify(MutationNotification {
            upserted: vec![final_path.as_str().to_string()],
            removed: if final_path != command.path {
                vec![command.path.as_str().to_string()]
            } else {
                Vec::new()
            },
        });
        Ok(PageMutationResult {
            path: final_path,
            meta: command.meta,
            body: command.body,
        })
    }

    /// Return the number of retained lock identities.
    ///
    /// This is exposed for deterministic verification that expired weak
    /// entries do not accumulate.
    #[doc(hidden)]
    pub fn lock_table_len(&self) -> usize {
        self.locks.lock().len()
    }
}

impl Default for MutationCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

/// An owned set of path locks. The locks are released when this guard drops.
pub struct MutationGuard {
    _guards: Vec<OwnedMutexGuard<()>>,
    _locks: Vec<Arc<Mutex<()>>>,
}

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Replace a file without exposing a partial write.
///
/// The temporary file is created alongside the destination so the final
/// rename remains within one filesystem.
pub fn atomic_replace(path: &Path, content: &[u8]) -> io::Result<()> {
    atomic_replace_with(
        path,
        content,
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        |temporary_path, destination| fs::rename(temporary_path, destination),
        |parent| fs::File::open(parent)?.sync_all(),
        |temporary_path| fs::remove_file(temporary_path),
    )
}

/// Atomic replacement implementation with injectable filesystem operations.
///
/// The operation seams make failure ordering and error semantics deterministic
/// to test without relying on platform permissions or a failing filesystem.
#[doc(hidden)]
pub fn atomic_replace_with<WriteAndSync, Rename, SyncParent, RemoveTemporary>(
    path: &Path,
    content: &[u8],
    write_and_sync: WriteAndSync,
    rename: Rename,
    sync_parent: SyncParent,
    remove_temporary: RemoveTemporary,
) -> io::Result<()>
where
    WriteAndSync: FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
    Rename: FnOnce(&Path, &Path) -> io::Result<()>,
    SyncParent: FnOnce(&Path) -> io::Result<()>,
    RemoveTemporary: FnOnce(&Path) -> io::Result<()>,
{
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;

    let (temporary_path, mut temporary_file) = create_temporary_file(parent, file_name)?;
    if let Err(primary_error) = write_and_sync(&mut temporary_file, content) {
        drop(temporary_file);
        return Err(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        ));
    }

    drop(temporary_file);
    if let Err(primary_error) = rename(&temporary_path, path) {
        return Err(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        ));
    }

    sync_parent(parent).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "rename completed for {}; failed to sync parent directory {}: {error}; \
                 destination may contain the new content",
                path.display(),
                parent.display()
            ),
        )
    })
}

fn cleanup_error<RemoveTemporary>(
    primary_error: io::Error,
    temporary_path: &Path,
    remove_temporary: RemoveTemporary,
) -> io::Error
where
    RemoveTemporary: FnOnce(&Path) -> io::Result<()>,
{
    match remove_temporary(temporary_path) {
        Ok(()) => primary_error,
        Err(cleanup_error) => io::Error::new(
            primary_error.kind(),
            format!(
                "{primary_error}; additionally failed to remove temporary file {}: \
                 {cleanup_error}",
                temporary_path.display()
            ),
        ),
    }
}

fn create_temporary_file(
    parent: &Path,
    file_name: &std::ffi::OsStr,
) -> io::Result<(PathBuf, fs::File)> {
    loop {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = std::ffi::OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(".clepsydra-tmp-{}-{sequence}", std::process::id()));
        let path = parent.join(temporary_name);

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}
