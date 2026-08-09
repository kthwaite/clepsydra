use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use thiserror::Error;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use super::Vault;
use super::atomic_file::{AtomicPublicationError, atomic_create, atomic_replace};
use super::hooks::PostMoveHook;
use super::index::IndexError;
use super::index_handle::IndexHandle;
use super::index_policy::{IndexMutation, IndexPolicyError};
use super::page::{Page, PageMeta, write_page_content};
use super::path::VaultPath;
use super::projection::{project_path, project_path_cleared};

type BeforeUpdatePublishHook = dyn Fn(&VaultPath) + Send + Sync;
type AfterPageIdLookupHook = dyn Fn(&VaultPath) + Send + Sync;
type CreatePublicationHook =
    dyn Fn(&Path, &[u8]) -> Result<(), AtomicPublicationError> + Send + Sync;
type CreateRollbackSyncHook = dyn Fn(&Path) -> io::Result<()> + Send + Sync;

/// Serializes mutations that touch the same normalized vault paths.
pub struct MutationCoordinator {
    locks: parking_lot::Mutex<HashMap<VaultPath, Weak<RwLock<()>>>>,
    before_update_publish_hook: parking_lot::Mutex<Option<Arc<BeforeUpdatePublishHook>>>,
    after_page_id_lookup_hook: parking_lot::Mutex<Option<Arc<AfterPageIdLookupHook>>>,
    create_publication_hook: parking_lot::Mutex<Option<Arc<CreatePublicationHook>>>,
    create_rollback_sync_hook: parking_lot::Mutex<Option<Arc<CreateRollbackSyncHook>>>,
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

/// An exact-content replacement for adapters that mutate source spans without
/// reserializing page metadata (for example block ID assignment).
#[derive(Debug)]
pub struct ReplacePageContentCommand {
    pub path: VaultPath,
    pub expected_content: String,
    pub content: String,
}

#[derive(Debug)]
pub struct DeleteFolderResult {
    pub removed: Vec<String>,
    pub hook_targets: Vec<(VaultPath, PageMeta)>,
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
    #[error(
        "filesystem mutation failed after filesystem_applied={filesystem_applied} for {path}: {source}"
    )]
    Filesystem {
        filesystem_applied: bool,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(
        "filesystem mutation failed and filesystem rollback failed for {path}: primary error: {source}; rollback error: {rollback}"
    )]
    FilesystemRollback {
        path: PathBuf,
        #[source]
        source: io::Error,
        rollback: io::Error,
    },
    #[error("index mutation failed after filesystem_applied={filesystem_applied}: {source}")]
    Index {
        filesystem_applied: bool,
        #[source]
        source: Box<IndexPolicyError>,
    },
    #[error(
        "index mutation failed and filesystem rollback failed for {path}: index error: {source}; rollback error: {rollback}"
    )]
    IndexRollback {
        path: PathBuf,
        #[source]
        source: Box<IndexPolicyError>,
        rollback: io::Error,
    },
    #[error(
        "index mutation failed and index rollback failed for {path}: index error: {source}; rollback error: {rollback}"
    )]
    IndexCompensation {
        path: VaultPath,
        #[source]
        source: Box<IndexPolicyError>,
        rollback: Box<IndexPolicyError>,
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

impl MutationError {
    pub fn filesystem_applied(&self) -> bool {
        match self {
            Self::Filesystem {
                filesystem_applied, ..
            }
            | Self::Index {
                filesystem_applied, ..
            }
            | Self::Reconcile {
                filesystem_applied, ..
            }
            | Self::Hook {
                filesystem_applied, ..
            } => *filesystem_applied,
            Self::FilesystemRollback { .. } | Self::IndexRollback { .. } => true,
            Self::IndexCompensation { .. }
            | Self::InvalidInput(_)
            | Self::NotFound(_)
            | Self::Conflict(_)
            | Self::Stale(_) => false,
        }
    }
}

async fn run_blocking_fs<T>(
    path: PathBuf,
    guard: MutationGuard,
    operation: impl FnOnce() -> Result<T, MutationError> + Send + 'static,
) -> Result<(MutationGuard, T), MutationError>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(move || operation().map(|result| (guard, result)))
        .await
        .map_err(|error| MutationError::Filesystem {
            filesystem_applied: false,
            path,
            source: io::Error::other(format!("blocking filesystem task failed: {error}")),
        })?
}

async fn run_shielded_mutation<T, Operation, OperationFuture>(
    path: PathBuf,
    operation: Operation,
) -> Result<T, MutationError>
where
    T: Send + 'static,
    Operation: FnOnce(Arc<AtomicBool>) -> OperationFuture,
    OperationFuture: Future<Output = Result<T, MutationError>> + Send + 'static,
{
    let filesystem_applied = Arc::new(AtomicBool::new(false));
    let operation_applied = Arc::clone(&filesystem_applied);
    tokio::spawn(operation(operation_applied))
        .await
        .map_err(|error| MutationError::Filesystem {
            filesystem_applied: filesystem_applied.load(Ordering::Acquire),
            path,
            source: io::Error::other(format!("shielded mutation task failed: {error}")),
        })?
}

fn rollback_created_publication(
    path: &Path,
    sync_hook: Option<&CreateRollbackSyncHook>,
) -> io::Result<()> {
    fs::remove_file(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to remove published file {}: {error}",
                path.display()
            ),
        )
    })?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::other(format!(
            "published path has no parent directory: {}",
            path.display()
        ))
    })?;
    let sync_result = match sync_hook {
        Some(hook) => hook(parent),
        None => sync_rollback_parent(parent),
    };
    sync_result.map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "removed published file {} but failed to sync parent directory {}: {error}",
                path.display(),
                parent.display()
            ),
        )
    })
}

#[cfg(not(windows))]
fn sync_rollback_parent(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn sync_rollback_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

impl MutationCoordinator {
    pub fn new() -> Self {
        Self {
            locks: parking_lot::Mutex::new(HashMap::new()),
            before_update_publish_hook: parking_lot::Mutex::new(None),
            after_page_id_lookup_hook: parking_lot::Mutex::new(None),
            create_publication_hook: parking_lot::Mutex::new(None),
            create_rollback_sync_hook: parking_lot::Mutex::new(None),
        }
    }

    /// Install a synchronization observer immediately after an update's
    /// compare-and-swap read and before filesystem publication.
    #[doc(hidden)]
    pub fn set_before_update_publish_hook(&self, hook: Option<Arc<BeforeUpdatePublishHook>>) {
        *self.before_update_publish_hook.lock() = hook;
    }

    /// Install a synchronization observer after an indexed UUID lookup and
    /// before its candidate path is acquired or used.
    #[doc(hidden)]
    pub fn set_after_page_id_lookup_hook(&self, hook: Option<Arc<AfterPageIdLookupHook>>) {
        *self.after_page_id_lookup_hook.lock() = hook;
    }

    /// Replace create-page publication for deterministic failure testing.
    #[doc(hidden)]
    pub fn set_create_publication_hook(&self, hook: Option<Arc<CreatePublicationHook>>) {
        *self.create_publication_hook.lock() = hook;
    }

    /// Replace create rollback directory synchronization for deterministic failure testing.
    #[doc(hidden)]
    pub fn set_create_rollback_sync_hook(&self, hook: Option<Arc<CreateRollbackSyncHook>>) {
        *self.create_rollback_sync_hook.lock() = hook;
    }

    pub(crate) fn observe_page_id_lookup(&self, path: &VaultPath) {
        let hook = self.after_page_id_lookup_hook.lock().clone();
        if let Some(hook) = hook {
            hook(path);
        }
    }

    /// Lock the requested paths for mutation and every ancestor for subtree
    /// exclusion. Ancestors use shared locks, so mutations in sibling
    /// subtrees proceed concurrently while a folder deletion excludes all
    /// descendants.
    pub async fn lock_paths(&self, paths: &[VaultPath]) -> MutationGuard {
        let mut requests = BTreeMap::<String, bool>::new();
        for path in paths {
            let components = path.as_str().split('/').collect::<Vec<_>>();
            for end in 1..components.len() {
                requests.entry(components[..end].join("/")).or_insert(false);
            }
            requests.insert(path.as_str().to_string(), true);
        }

        let locks = {
            let mut table = self.locks.lock();
            table.retain(|_, lock| lock.strong_count() != 0);
            requests
                .into_iter()
                .map(|(key, write)| {
                    let key = VaultPath::new(&key).expect("normalized path prefix");
                    let lock = if let Some(lock) = table.get(&key).and_then(Weak::upgrade) {
                        lock
                    } else {
                        let lock = Arc::new(RwLock::new(()));
                        table.insert(key, Arc::downgrade(&lock));
                        lock
                    };
                    (lock, write)
                })
                .collect::<Vec<_>>()
        };

        let mut guards = Vec::with_capacity(locks.len());
        for (lock, write) in &locks {
            guards.push(if *write {
                MutationLockGuard::Write {
                    _guard: Arc::clone(lock).write_owned().await,
                }
            } else {
                MutationLockGuard::Read {
                    _guard: Arc::clone(lock).read_owned().await,
                }
            });
        }

        MutationGuard {
            _guards: guards,
            _locks: locks.into_iter().map(|(lock, _)| lock).collect(),
        }
    }

    /// Exclude every mutation below `folder` until the returned guard drops.
    pub async fn lock_subtree(&self, folder: &VaultPath) -> MutationGuard {
        self.lock_paths(std::slice::from_ref(folder)).await
    }

    pub async fn create_page(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        command: CreatePageCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<Page, MutationError> {
        let guard = self.lock_paths(std::slice::from_ref(&command.path)).await;
        let absolute = vault.resolve(&command.path);
        let index = index.clone();
        let create_publication_hook = self.create_publication_hook.lock().clone();
        let create_rollback_sync_hook = self.create_rollback_sync_hook.lock().clone();
        let result =
            run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
                let blocking_path = absolute.clone();
                let page_path = command.path.clone();
                let content = write_page_content(&command.meta, &command.body);
                let (guard, content) = run_blocking_fs(absolute.clone(), guard, move || {
                    if let Some(parent) = blocking_path.parent() {
                        fs::create_dir_all(parent).map_err(|source| MutationError::Filesystem {
                            filesystem_applied: false,
                            path: parent.to_path_buf(),
                            source,
                        })?;
                    }
                    let publication = match &create_publication_hook {
                        Some(hook) => hook(&blocking_path, content.as_bytes()),
                        None => atomic_create(&blocking_path, content.as_bytes()),
                    };
                    match publication {
                        Ok(()) => Ok(content),
                        Err(AtomicPublicationError::NotPublished(source))
                            if source.kind() == io::ErrorKind::AlreadyExists =>
                        {
                            Err(MutationError::Conflict(format!(
                                "page already exists: {}",
                                page_path.as_str()
                            )))
                        }
                        Err(AtomicPublicationError::NotPublished(source)) => {
                            Err(MutationError::Filesystem {
                                filesystem_applied: false,
                                path: blocking_path,
                                source,
                            })
                        }
                        Err(AtomicPublicationError::PublishedButNotDurable(source)) => {
                            match rollback_created_publication(
                                &blocking_path,
                                create_rollback_sync_hook.as_deref(),
                            ) {
                                Ok(()) => Err(MutationError::Filesystem {
                                    filesystem_applied: false,
                                    path: blocking_path,
                                    source,
                                }),
                                Err(rollback) => Err(MutationError::FilesystemRollback {
                                    path: blocking_path,
                                    source,
                                    rollback,
                                }),
                            }
                        }
                    }
                })
                .await?;
                filesystem_applied.store(true, Ordering::Release);
                let index_result = index
                    .apply_mutation(command.path.clone(), IndexMutation::Created)
                    .await;
                if let Err(source) = index_result {
                    let index_may_be_partial = matches!(source, IndexPolicyError::Operation { .. });
                    let rollback_path = absolute.clone();
                    let rollback = tokio::task::spawn_blocking(move || {
                        let result = fs::remove_file(&rollback_path);
                        (guard, result)
                    })
                    .await;
                    match rollback {
                        Ok((guard, Ok(()))) => {
                            filesystem_applied.store(false, Ordering::Release);
                            if index_may_be_partial
                                && let Err(rollback) = index
                                    .apply_mutation(command.path.clone(), IndexMutation::Deleted)
                                    .await
                            {
                                return Err(MutationError::IndexCompensation {
                                    path: command.path,
                                    source: Box::new(source),
                                    rollback: Box::new(rollback),
                                });
                            }
                            let _guard = guard;
                            return Err(MutationError::Index {
                                filesystem_applied: false,
                                source: Box::new(source),
                            });
                        }
                        Ok((_guard, Err(rollback))) => {
                            return Err(MutationError::IndexRollback {
                                path: absolute,
                                source: Box::new(source),
                                rollback,
                            });
                        }
                        Err(error) => {
                            return Err(MutationError::IndexRollback {
                                path: absolute,
                                source: Box::new(source),
                                rollback: io::Error::other(format!(
                                    "blocking filesystem rollback task failed: {error}"
                                )),
                            });
                        }
                    }
                }
                let _guard = guard;
                Ok(Page {
                    path: command.path,
                    meta: command.meta,
                    body: command.body,
                    raw_content: content,
                })
            })
            .await?;

        notify(MutationNotification {
            upserted: vec![result.path.as_str().to_string()],
            removed: Vec::new(),
        });
        Ok(result)
    }

    pub async fn replace_page_content(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        command: ReplacePageContentCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<VaultPath, MutationError> {
        let guard = self.lock_paths(std::slice::from_ref(&command.path)).await;
        let absolute = vault.resolve(&command.path);
        let index = index.clone();
        let path = run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
            let blocking_path = absolute.clone();
            let page_path = command.path.clone();
            let (guard, durability_error) = run_blocking_fs(absolute.clone(), guard, move || {
                let current = match fs::read_to_string(&blocking_path) {
                    Ok(current) => current,
                    Err(source) if source.kind() == io::ErrorKind::NotFound => {
                        return Err(MutationError::NotFound(page_path));
                    }
                    Err(source) => {
                        return Err(MutationError::Filesystem {
                            filesystem_applied: false,
                            path: blocking_path,
                            source,
                        });
                    }
                };
                if current != command.expected_content {
                    return Err(MutationError::Stale(page_path));
                }
                match atomic_replace(&blocking_path, command.content.as_bytes()) {
                    Ok(()) => Ok(None),
                    Err(AtomicPublicationError::NotPublished(source)) => {
                        Err(MutationError::Filesystem {
                            filesystem_applied: false,
                            path: blocking_path,
                            source,
                        })
                    }
                    Err(AtomicPublicationError::PublishedButNotDurable(source)) => Ok(Some(source)),
                }
            })
            .await?;
            filesystem_applied.store(true, Ordering::Release);
            let _guard = guard;
            index
                .apply_mutation(command.path.clone(), IndexMutation::ContentChanged)
                .await
                .map_err(|source| MutationError::Index {
                    filesystem_applied: true,
                    source: Box::new(source),
                })?;
            if let Some(source) = durability_error {
                return Err(MutationError::Filesystem {
                    filesystem_applied: true,
                    path: absolute,
                    source,
                });
            }
            Ok(command.path)
        })
        .await?;
        notify(MutationNotification {
            upserted: vec![path.as_str().to_string()],
            removed: Vec::new(),
        });
        Ok(path)
    }

    pub async fn update_page(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
        command: UpdatePageCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<Page, MutationError> {
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
        let guard = self.lock_paths(&locked_paths).await;
        let absolute = vault.resolve(&command.path);
        let destination_check = projected_path
            .as_ref()
            .map(|destination| (destination.clone(), vault.resolve(destination)));
        let original_path = command.path.clone();
        let notification_source = original_path.clone();
        let index = index.clone();
        let before_update_publish_hook = self.before_update_publish_hook.lock().clone();
        let result =
            run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
                let blocking_path = absolute.clone();
                let page_path = command.path.clone();
                let expected_content = command.expected_content.clone();
                let content = write_page_content(&command.meta, &command.body);
                let (guard, (durability_error, content)) =
                    run_blocking_fs(absolute.clone(), guard, move || {
                        let current = match fs::read_to_string(&blocking_path) {
                            Ok(current) => current,
                            Err(source) if source.kind() == io::ErrorKind::NotFound => {
                                return Err(MutationError::NotFound(page_path));
                            }
                            Err(source) => {
                                return Err(MutationError::Filesystem {
                                    filesystem_applied: false,
                                    path: blocking_path,
                                    source,
                                });
                            }
                        };
                        if current != expected_content {
                            return Err(MutationError::Stale(page_path));
                        }
                        if let Some(hook) = before_update_publish_hook {
                            hook(&page_path);
                        }
                        if let Some((destination, destination_absolute)) = destination_check
                            && destination_absolute.exists()
                        {
                            return Err(MutationError::Conflict(format!(
                                "destination already exists: {}",
                                destination.as_str()
                            )));
                        }
                        match atomic_replace(&blocking_path, content.as_bytes()) {
                            Ok(()) => Ok((None, content)),
                            Err(AtomicPublicationError::NotPublished(source)) => {
                                Err(MutationError::Filesystem {
                                    filesystem_applied: false,
                                    path: blocking_path,
                                    source,
                                })
                            }
                            Err(AtomicPublicationError::PublishedButNotDurable(source)) => {
                                Ok((Some(source), content))
                            }
                        }
                    })
                    .await?;
                filesystem_applied.store(true, Ordering::Release);
                let _guard = guard;
                index
                    .apply_mutation(original_path.clone(), IndexMutation::ContentChanged)
                    .await
                    .map_err(|source| MutationError::Index {
                        filesystem_applied: true,
                        source: Box::new(source),
                    })?;

                let final_path = if let Some(destination) = projected_path {
                    let source = original_path.as_str().to_string();
                    let destination_string = destination.as_str().to_string();
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
                    original_path
                };

                if let Some(source) = durability_error {
                    return Err(MutationError::Filesystem {
                        filesystem_applied: true,
                        path: absolute,
                        source,
                    });
                }
                Ok(Page {
                    path: final_path,
                    meta: command.meta,
                    body: command.body,
                    raw_content: content,
                })
            })
            .await?;

        notify(MutationNotification {
            upserted: vec![result.path.as_str().to_string()],
            removed: if result.path != notification_source {
                vec![notification_source.as_str().to_string()]
            } else {
                Vec::new()
            },
        });
        Ok(result)
    }

    pub async fn delete_folder(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        folder: VaultPath,
        recursive: bool,
    ) -> Result<DeleteFolderResult, MutationError> {
        let guard = self.lock_subtree(&folder).await;
        let prefix = format!("{}/", folder.as_str());
        let indexed_prefix = prefix.clone();
        let indexed_paths = index
            .with_index(move |vault_index, _vault| {
                let mut statement = vault_index
                    .connection()
                    .prepare("SELECT path FROM pages WHERE path LIKE ?1 ORDER BY path")?;
                let paths = statement
                    .query_map(rusqlite::params![format!("{indexed_prefix}%")], |row| {
                        row.get::<_, String>(0)
                    })?
                    .filter_map(Result::ok)
                    .filter_map(|path| VaultPath::new(&path).ok())
                    .collect::<Vec<_>>();
                Ok::<_, IndexError>(paths)
            })
            .await
            .map_err(|source| MutationError::Reconcile {
                filesystem_applied: false,
                source,
            })?
            .map_err(|source| MutationError::Reconcile {
                filesystem_applied: false,
                source,
            })?;

        let absolute = vault.resolve(&folder);
        let vault_root = vault.root().to_path_buf();
        let index = index.clone();
        run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
            let blocking_path = absolute.clone();
            let folder_for_error = folder.clone();
            let (guard, hook_targets) = run_blocking_fs(absolute.clone(), guard, move || {
                if !blocking_path.is_dir() {
                    return Err(MutationError::NotFound(folder_for_error));
                }
                let mut hook_targets = Vec::new();
                if recursive {
                    for entry in walkdir::WalkDir::new(&blocking_path)
                        .into_iter()
                        .filter_map(Result::ok)
                        .filter(|entry| entry.file_type().is_file())
                    {
                        if entry.path().extension().and_then(|value| value.to_str()) != Some("md") {
                            continue;
                        }
                        let Ok(relative) = entry.path().strip_prefix(&vault_root) else {
                            continue;
                        };
                        let relative = relative.to_string_lossy().replace('\\', "/");
                        let Ok(path) = VaultPath::new(&relative) else {
                            continue;
                        };
                        if let Ok(page) = Page::from_file(entry.path(), path.clone()) {
                            hook_targets.push((path, page.meta));
                        }
                    }
                    fs::remove_dir_all(&blocking_path).map_err(|source| {
                        MutationError::Filesystem {
                            filesystem_applied: false,
                            path: blocking_path,
                            source,
                        }
                    })?;
                } else {
                    fs::remove_dir(&blocking_path).map_err(|source| {
                        if source.kind() == io::ErrorKind::DirectoryNotEmpty
                            || matches!(source.raw_os_error(), Some(66) | Some(39))
                            || source.to_string().contains("not empty")
                            || source.to_string().contains("Directory not empty")
                        {
                            MutationError::Conflict(
                                "folder is not empty; use recursive=true to delete".to_string(),
                            )
                        } else {
                            MutationError::Filesystem {
                                filesystem_applied: false,
                                path: blocking_path,
                                source,
                            }
                        }
                    })?;
                }
                Ok(hook_targets)
            })
            .await?;
            filesystem_applied.store(true, Ordering::Release);
            let _guard = guard;
            let mut removed = Vec::with_capacity(indexed_paths.len());
            for path in indexed_paths {
                index
                    .apply_mutation(path.clone(), IndexMutation::Deleted)
                    .await
                    .map_err(|source| MutationError::Index {
                        filesystem_applied: true,
                        source: Box::new(source),
                    })?;
                removed.push(path.as_str().to_string());
            }
            Ok(DeleteFolderResult {
                removed,
                hook_targets,
            })
        })
        .await
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
enum MutationLockGuard {
    Read { _guard: OwnedRwLockReadGuard<()> },
    Write { _guard: OwnedRwLockWriteGuard<()> },
}

pub struct MutationGuard {
    _guards: Vec<MutationLockGuard>,
    _locks: Vec<Arc<RwLock<()>>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_blocking_phase_keeps_path_locked_until_io_finishes() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let path = VaultPath::new("notes/cancelled.md").unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = Arc::clone(&coordinator);
        let worker_path = path.clone();
        let mutation = tokio::spawn(async move {
            let guard = worker.lock_paths(std::slice::from_ref(&worker_path)).await;
            run_blocking_fs(PathBuf::from("cancelled.md"), guard, move || {
                let _ = started_tx.send(());
                release_rx.recv().unwrap();
                Ok(())
            })
            .await
        });

        started_rx.await.unwrap();
        mutation.abort();
        let contender = Arc::clone(&coordinator);
        let contender_path = path.clone();
        let blocked = tokio::spawn(async move {
            contender
                .lock_paths(std::slice::from_ref(&contender_path))
                .await
        });
        let mut blocked = Box::pin(blocked);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut blocked)
                .await
                .is_err(),
            "cancellation released the path lock while blocking I/O was still running"
        );

        release_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut blocked)
            .await
            .expect("path lock did not release after blocking I/O finished")
            .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn filesystem_phase_runs_off_the_tokio_worker() {
        let coordinator = MutationCoordinator::new();
        let path = VaultPath::new("notes/blocking.md").unwrap();
        let guard = coordinator.lock_paths(std::slice::from_ref(&path)).await;
        let runtime_thread = std::thread::current().id();

        let (_guard, filesystem_thread) =
            run_blocking_fs(PathBuf::from("blocking.md"), guard, || {
                Ok(std::thread::current().id())
            })
            .await
            .unwrap();

        assert_ne!(filesystem_thread, runtime_thread);
    }

    #[tokio::test]
    async fn cancelling_post_publish_wait_keeps_path_locked_until_index_phase_finishes() {
        let coordinator = Arc::new(MutationCoordinator::new());
        let path = VaultPath::new("notes/published.md").unwrap();
        let guard = coordinator.lock_paths(std::slice::from_ref(&path)).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let mutation = tokio::spawn(async move {
            run_shielded_mutation(PathBuf::from("published.md"), move |_| async move {
                let _guard = guard;
                let _ = started_tx.send(());
                let _ = release_rx.await;
                Ok(())
            })
            .await
        });

        started_rx.await.unwrap();
        mutation.abort();
        let contender = Arc::clone(&coordinator);
        let contender_path = path.clone();
        let blocked = tokio::spawn(async move {
            contender
                .lock_paths(std::slice::from_ref(&contender_path))
                .await
        });
        let mut blocked = Box::pin(blocked);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut blocked)
                .await
                .is_err(),
            "cancellation released the path lock while index work was still running"
        );

        let _ = release_tx.send(());
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut blocked)
            .await
            .expect("path lock did not release after index work finished")
            .unwrap();
    }
}
