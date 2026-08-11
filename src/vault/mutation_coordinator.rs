use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use thiserror::Error;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use super::Vault;
use super::atomic_file::{
    AtomicPublicationError, ConditionalPublicationError, atomic_create, atomic_replace,
    atomic_replace_if_unchanged,
};
use super::batch_mutation::{self, BatchMutationCommand, BatchMutationError};
use super::hooks::PostMoveHook;
use super::index::IndexError;
use super::index_handle::IndexHandle;
use super::index_policy::{IndexMutation, IndexPolicyError};
use super::page::{Page, PageMeta, write_page_content};
use super::path::VaultPath;
use super::projection::{project_path, project_path_cleared};
use super::sync::{ChangeEvent, SyncEngine};
use super::task_history::{heal_task_replacement, heal_task_update, initialize_task_history};

type BeforeUpdatePublishHook = dyn Fn(&VaultPath) + Send + Sync;
type AfterPageIdLookupHook = dyn Fn(&VaultPath) + Send + Sync;
type CreatePublicationHook =
    dyn Fn(&Path, &[u8]) -> Result<(), AtomicPublicationError> + Send + Sync;
type CreateRollbackSyncHook = dyn Fn(&Path) -> io::Result<()> + Send + Sync;
#[cfg(test)]
type BeforeLockAcquireHook = dyn Fn(&VaultPath) + Send + Sync;
#[cfg(test)]
type BeforeBatchLockHook = dyn Fn(&[VaultPath]) + Send + Sync;

/// Serializes mutations that touch the same normalized vault paths.
pub struct MutationCoordinator {
    locks: parking_lot::Mutex<HashMap<VaultPath, Weak<RwLock<()>>>>,
    before_update_publish_hook: parking_lot::Mutex<Option<Arc<BeforeUpdatePublishHook>>>,
    after_page_id_lookup_hook: parking_lot::Mutex<Option<Arc<AfterPageIdLookupHook>>>,
    create_publication_hook: parking_lot::Mutex<Option<Arc<CreatePublicationHook>>>,
    create_rollback_sync_hook: parking_lot::Mutex<Option<Arc<CreateRollbackSyncHook>>>,
    #[cfg(test)]
    before_lock_acquire_hook: parking_lot::Mutex<Option<Arc<BeforeLockAcquireHook>>>,
    #[cfg(test)]
    before_batch_lock_hook: parking_lot::Mutex<Option<Arc<BeforeBatchLockHook>>>,
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

/// Exact bytes for a reserved, non-indexed vault file.
///
/// `None` means create only when absent. `Some(bytes)` means replace only when
/// the complete current byte vector is identical.
#[derive(Debug)]
pub struct ReservedManifestCommand {
    pub path: VaultPath,
    pub expected_content: Option<Vec<u8>>,
    pub content: Vec<u8>,
}

#[derive(Debug)]
pub struct ReplacePageContentResult {
    pub path: VaultPath,
    pub content: String,
}

#[derive(Debug)]
pub struct DeleteFolderResult {
    pub removed: Vec<String>,
    pub hook_targets: Vec<(VaultPath, PageMeta)>,
}


#[derive(Debug, Error)]
pub enum BatchRecoveryError {
    #[error("index reconciliation failed: {0}")]
    Index(#[source] IndexError),
    #[error("transaction workspace cleanup failed: {0}")]
    Workspace(#[source] BatchMutationError),
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
    #[error("batch preparation failed: {source}")]
    BatchPrepare {
        directory: Option<PathBuf>,
        #[source]
        source: BatchMutationError,
    },
    #[error("batch publication failed and was rolled back: {source}")]
    BatchPublish {
        #[source]
        source: BatchMutationError,
    },
    #[error(
        "batch publication failed and rollback failed for transaction {directory}: publication error: {publish}; rollback error: {rollback}"
    )]
    BatchRollback {
        directory: PathBuf,
        publish: BatchMutationError,
        #[source]
        rollback: BatchMutationError,
    },
    #[error("batch recovery required for retained transaction {directory}: {source}")]
    BatchRecovery {
        directory: PathBuf,
        #[source]
        source: BatchRecoveryError,
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
            Self::FilesystemRollback { .. }
            | Self::IndexRollback { .. }
            | Self::BatchRollback { .. }
            | Self::BatchRecovery { .. } => true,
            Self::IndexCompensation { .. }
            | Self::BatchPrepare { .. }
            | Self::BatchPublish { .. }
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

fn batch_prepare_error(source: BatchMutationError) -> MutationError {
    match source.stale_vault_path() {
        Some(path) => MutationError::Stale(path),
        None => {
            let directory = source.retained_directory().map(Path::to_path_buf);
            MutationError::BatchPrepare { directory, source }
        }
    }
}

fn batch_blocking_error(
    operation: &'static str,
    path: &Path,
    source: tokio::task::JoinError,
) -> BatchMutationError {
    BatchMutationError::Filesystem {
        operation,
        path: path.to_path_buf(),
        source: io::Error::other(source.to_string()),
    }
}

fn batch_notification(events: &[ChangeEvent]) -> MutationNotification {
    let mut notification = MutationNotification {
        upserted: Vec::new(),
        removed: Vec::new(),
    };
    for event in events {
        match event {
            ChangeEvent::Upsert(path) => {
                notification.upserted.push(path.as_str().to_owned());
            }
            ChangeEvent::Remove(path) => {
                notification.removed.push(path.as_str().to_owned());
            }
            ChangeEvent::BaseChanged => {}
        }
    }
    notification
}

fn publish_batch(
    root: &Path,
    command: &BatchMutationCommand,
) -> Result<batch_mutation::PreparedBatch, MutationError> {
    let mut prepared = batch_mutation::prepare(root, command).map_err(batch_prepare_error)?;
    let directory = prepared.directory().to_path_buf();
    if let Err(publish) = prepared
        .publish()
        .and_then(|()| prepared.mark_filesystem_committed())
    {
        return match prepared.rollback() {
            Ok(()) => Err(MutationError::BatchPublish { source: publish }),
            Err(rollback) => Err(MutationError::BatchRollback {
                directory,
                publish,
                rollback,
            }),
        };
    }
    Ok(prepared)
}

fn reconcile_batch_index(
    vault: &Vault,
    index: &mut super::index::VaultIndex,
    hooks: &[Box<dyn PostMoveHook>],
    index_events: &[ChangeEvent],
    moved_pages: &[(VaultPath, VaultPath)],
) -> Result<(), IndexError> {
    for (old_path, new_path) in moved_pages {
        let page_id = match index.connection().query_row(
            "SELECT id FROM pages WHERE path = ?1",
            rusqlite::params![old_path.as_str()],
            |row| row.get::<_, String>(0),
        ) {
            Ok(value) => value.parse::<uuid::Uuid>().map_err(|source| {
                IndexError::Other(format!(
                    "invalid indexed page UUID for {}: {source}",
                    old_path.as_str()
                ))
            })?,
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(source) => return Err(IndexError::Sqlite(source)),
        };
        for hook in hooks {
            hook.on_page_moved(old_path, new_path, &page_id, vault, index)
                .map_err(|error| IndexError::Other(error.to_string()))?;
        }
    }
    SyncEngine::process_events(index_events, vault, index).map(|_| ())
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
            #[cfg(test)]
            before_lock_acquire_hook: parking_lot::Mutex::new(None),
            #[cfg(test)]
            before_batch_lock_hook: parking_lot::Mutex::new(None),
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

    #[cfg(test)]
    fn set_before_lock_acquire_hook(&self, hook: Option<Arc<BeforeLockAcquireHook>>) {
        *self.before_lock_acquire_hook.lock() = hook;
    }

    #[cfg(test)]
    fn set_before_batch_lock_hook(&self, hook: Option<Arc<BeforeBatchLockHook>>) {
        *self.before_batch_lock_hook.lock() = hook;
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
                    #[cfg(test)]
                    let observed_path = key.clone();
                    let lock = if let Some(lock) = table.get(&key).and_then(Weak::upgrade) {
                        lock
                    } else {
                        let lock = Arc::new(RwLock::new(()));
                        table.insert(key, Arc::downgrade(&lock));
                        lock
                    };
                    MutationLockRequest {
                        #[cfg(test)]
                        observed_path,
                        lock,
                        write,
                    }
                })
                .collect::<Vec<_>>()
        };

        let mut guards = Vec::with_capacity(locks.len());
        for request in &locks {
            #[cfg(test)]
            if let Some(hook) = self.before_lock_acquire_hook.lock().clone() {
                hook(&request.observed_path);
            }
            guards.push(if request.write {
                MutationLockGuard::Write {
                    _guard: Arc::clone(&request.lock).write_owned().await,
                }
            } else {
                MutationLockGuard::Read {
                    _guard: Arc::clone(&request.lock).read_owned().await,
                }
            });
        }

        MutationGuard {
            _guards: guards,
            _locks: locks.into_iter().map(|request| request.lock).collect(),
        }
    }

    /// Exclude every mutation below `folder` until the returned guard drops.
    pub async fn lock_subtree(&self, folder: &VaultPath) -> MutationGuard {
        self.lock_paths(std::slice::from_ref(folder)).await
    }

    /// Execute a durable batch against an already-open offline index.
    ///
    /// This uses the same publication, hook, index-reconciliation, retained
    /// workspace, and cleanup path as [`Self::execute_batch`] without creating
    /// a second coordinator or Tokio index worker.
    pub fn execute_batch_direct(
        vault: &Vault,
        index: &mut super::index::VaultIndex,
        hooks: &[Box<dyn PostMoveHook>],
        command: BatchMutationCommand,
    ) -> Result<MutationNotification, MutationError> {
        let notification = batch_notification(&command.index_events);
        let prepared = publish_batch(vault.root(), &command)?;
        let directory = prepared.directory().to_path_buf();
        if let Err(source) = reconcile_batch_index(
            vault,
            index,
            hooks,
            &command.index_events,
            &command.moved_pages,
        ) {
            return Err(MutationError::BatchRecovery {
                directory,
                source: BatchRecoveryError::Index(source),
            });
        }
        prepared.finish().map_err(|source| MutationError::BatchRecovery {
            directory,
            source: BatchRecoveryError::Workspace(source),
        })?;
        Ok(notification)
    }

    pub async fn execute_batch(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
        command: BatchMutationCommand,
        notify: Arc<dyn Fn(MutationNotification) + Send + Sync>,
    ) -> Result<MutationNotification, MutationError> {
        let affected_paths = command.affected_paths();
        #[cfg(test)]
        if let Some(hook) = self.before_batch_lock_hook.lock().clone() {
            hook(&affected_paths);
        }
        let guard = self.lock_paths(&affected_paths).await;
        let root = vault.root().to_path_buf();
        let shield_path = root.clone();
        let index = index.clone();
        let notification = batch_notification(&command.index_events);
        let index_events = command.index_events.clone();
        let moved_pages = command.moved_pages.clone();

        run_shielded_mutation(shield_path, move |filesystem_applied| async move {
            let blocking_root = root.clone();
            let blocking_error_path = root.clone();
            let blocking_applied = Arc::clone(&filesystem_applied);
            let prepared = tokio::task::spawn_blocking(move || {
                let prepared = publish_batch(&blocking_root, &command)?;
                blocking_applied.store(true, Ordering::Release);
                Ok::<_, MutationError>((guard, prepared))
            })
            .await
            .map_err(|source| MutationError::Filesystem {
                filesystem_applied: filesystem_applied.load(Ordering::Acquire),
                path: blocking_error_path.clone(),
                source: io::Error::other(format!(
                    "blocking batch publication task failed: {source}"
                )),
            })??;

            let (guard, prepared) = prepared;
            let directory = prepared.directory().to_path_buf();
            let reconciliation = index
                .with_index(move |vault_index, index_vault| {
                    reconcile_batch_index(
                        index_vault,
                        vault_index,
                        hooks.as_ref(),
                        &index_events,
                        &moved_pages,
                    )
                })
                .await
                .and_then(|result| result);
            if let Err(source) = reconciliation {
                return Err(MutationError::BatchRecovery {
                    directory,
                    source: BatchRecoveryError::Index(source),
                });
            }

            let cleanup_directory = directory.clone();
            tokio::task::spawn_blocking(move || {
                let _guard = guard;
                prepared.finish()
            })
            .await
            .map_err(|source| MutationError::BatchRecovery {
                directory: directory.clone(),
                source: BatchRecoveryError::Workspace(batch_blocking_error(
                    "finish batch transaction",
                    &directory,
                    source,
                )),
            })?
            .map_err(|source| MutationError::BatchRecovery {
                directory: cleanup_directory,
                source: BatchRecoveryError::Workspace(source),
            })?;

            notify(notification.clone());
            Ok(notification)
        })
        .await
    }

    pub async fn create_page(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        mut command: CreatePageCommand,
        notify: Arc<dyn Fn(MutationNotification) + Send + Sync>,
    ) -> Result<Page, MutationError> {
        if command.meta.kind == Some(super::kind::Kind::Task) {
            initialize_task_history(&mut command.meta);
        }
        let guard = self.lock_paths(std::slice::from_ref(&command.path)).await;
        let absolute = vault.resolve(&command.path);
        let index = index.clone();
        let create_publication_hook = self.create_publication_hook.lock().clone();
        let create_rollback_sync_hook = self.create_rollback_sync_hook.lock().clone();
        let index_rollback_sync_hook = create_rollback_sync_hook.clone();
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
                    let index_may_be_partial =
                        matches!(source, IndexPolicyError::TransactionRollback { .. });
                    let rollback_path = absolute.clone();
                    let rollback = tokio::task::spawn_blocking(move || {
                        let result = rollback_created_publication(
                            &rollback_path,
                            index_rollback_sync_hook.as_deref(),
                        );
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
                let page = Page {
                    path: command.path,
                    meta: command.meta,
                    body: command.body,
                    raw_content: content,
                };
                notify(MutationNotification {
                    upserted: vec![page.path.as_str().to_string()],
                    removed: Vec::new(),
                });
                Ok(page)
            })
            .await?;

        Ok(result)
    }

    pub async fn replace_page_content(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        mut command: ReplacePageContentCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<ReplacePageContentResult, MutationError> {
        command.content =
            heal_task_replacement(&command.path, &command.expected_content, &command.content)
                .map_err(MutationError::InvalidInput)?;
        let guard = self.lock_paths(std::slice::from_ref(&command.path)).await;
        let absolute = vault.resolve(&command.path);
        let index = index.clone();
        let result =
            run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
                let blocking_path = absolute.clone();
                let page_path = command.path.clone();
                let expected_content = command.expected_content.clone();
                let published_content = command.content.clone();
                let (guard, durability_error) =
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
                        match atomic_replace(&blocking_path, published_content.as_bytes()) {
                            Ok(()) => Ok(None),
                            Err(AtomicPublicationError::NotPublished(source)) => {
                                Err(MutationError::Filesystem {
                                    filesystem_applied: false,
                                    path: blocking_path,
                                    source,
                                })
                            }
                            Err(AtomicPublicationError::PublishedButNotDurable(source)) => {
                                Ok(Some(source))
                            }
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
                Ok(ReplacePageContentResult {
                    path: command.path,
                    content: command.content,
                })
            })
            .await?;
        notify(MutationNotification {
            upserted: vec![result.path.as_str().to_string()],
            removed: Vec::new(),
        });
        Ok(result)
    }

    /// Atomically publish a reserved manifest without involving the page index.
    pub async fn write_reserved_manifest(
        &self,
        vault: &Vault,
        command: ReservedManifestCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<VaultPath, MutationError> {
        let guard = self.lock_paths(std::slice::from_ref(&command.path)).await;
        let absolute = vault.resolve(&command.path);
        let before_update_publish_hook = self.before_update_publish_hook.lock().clone();
        let path = run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
            let blocking_path = absolute.clone();
            let page_path = command.path;
            let compare_path = page_path.clone();
            let expected_content = command.expected_content;
            let content = command.content;
            let (guard, durability_error) = run_blocking_fs(absolute.clone(), guard, move || {
                if let Some(parent) = blocking_path.parent() {
                    fs::create_dir_all(parent).map_err(|source| MutationError::Filesystem {
                        filesystem_applied: false,
                        path: parent.to_path_buf(),
                        source,
                    })?;
                }

                let publication = match expected_content {
                    None => atomic_create(&blocking_path, &content).map_err(|error| match error {
                        AtomicPublicationError::NotPublished(source)
                            if source.kind() == io::ErrorKind::AlreadyExists =>
                        {
                            MutationError::Stale(compare_path.clone())
                        }
                        AtomicPublicationError::NotPublished(source) => MutationError::Filesystem {
                            filesystem_applied: false,
                            path: blocking_path.clone(),
                            source,
                        },
                        AtomicPublicationError::PublishedButNotDurable(source) => {
                            MutationError::Filesystem {
                                filesystem_applied: true,
                                path: blocking_path.clone(),
                                source,
                            }
                        }
                    }),
                    Some(expected) => {
                        atomic_replace_if_unchanged(&blocking_path, &expected, &content, || {
                            if let Some(hook) = before_update_publish_hook.as_ref() {
                                hook(&compare_path);
                            }
                        })
                        .map_err(|error| match error {
                            ConditionalPublicationError::Stale => {
                                MutationError::Stale(compare_path.clone())
                            }
                            ConditionalPublicationError::Publication(
                                AtomicPublicationError::NotPublished(source),
                            ) => MutationError::Filesystem {
                                filesystem_applied: false,
                                path: blocking_path.clone(),
                                source,
                            },
                            ConditionalPublicationError::Publication(
                                AtomicPublicationError::PublishedButNotDurable(source),
                            ) => MutationError::Filesystem {
                                filesystem_applied: true,
                                path: blocking_path.clone(),
                                source,
                            },
                        })
                    }
                };

                match publication {
                    Ok(()) => Ok(None),
                    Err(MutationError::Filesystem {
                        filesystem_applied: true,
                        source,
                        ..
                    }) => Ok(Some(source)),
                    Err(error) => Err(error),
                }
            })
            .await?;
            filesystem_applied.store(true, Ordering::Release);
            let _guard = guard;
            if let Some(source) = durability_error {
                return Err(MutationError::Filesystem {
                    filesystem_applied: true,
                    path: absolute,
                    source,
                });
            }
            Ok(page_path)
        })
        .await?;

        notify(MutationNotification {
            upserted: vec![path.as_str().to_owned()],
            removed: Vec::new(),
        });
        Ok(path)
    }

    pub async fn update_page(
        &self,
        vault: &Vault,
        index: &IndexHandle,
        hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
        mut command: UpdatePageCommand,
        notify: &(dyn Fn(MutationNotification) + Send + Sync),
    ) -> Result<Page, MutationError> {
        heal_task_update(&command.path, &command.expected_content, &mut command.meta)
            .map_err(MutationError::InvalidInput)?;
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

struct MutationLockRequest {
    #[cfg(test)]
    observed_path: VaultPath,
    lock: Arc<RwLock<()>>,
    write: bool,
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

    use crate::vault::batch_mutation::{
        BatchMutationCommand, BatchPathIntent, ExpectedPathState,
    };
    use crate::vault::sync::ChangeEvent;

    struct BatchFixture {
        _temp: tempfile::TempDir,
        vault: Vault,
        index: IndexHandle,
        coordinator: Arc<MutationCoordinator>,
    }

    impl BatchFixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("vault");
            crate::vault::init::init_vault(&root).unwrap();
            for (path, content) in files {
                fs::write(root.join(path), content).unwrap();
            }
            let vault = Vault::open(&root).unwrap();
            let mut raw_index =
                crate::vault::index::VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
            raw_index.build(&vault).unwrap();
            let index = IndexHandle::spawn(raw_index, vault.clone());
            Self {
                _temp: temp,
                vault,
                index,
                coordinator: Arc::new(MutationCoordinator::new()),
            }
        }

        fn root(&self) -> &Path {
            self.vault.root()
        }
    }

    fn batch_page(id: &str, title: &str, body: &str) -> String {
        format!("+++\nid = \"{id}\"\ntitle = \"{title}\"\n+++\n{body}\n")
    }

    fn replace_batch(replacements: &[(&str, &str, &str)]) -> BatchMutationCommand {
        BatchMutationCommand {
            intents: replacements
                .iter()
                .map(|(path, expected, content)| BatchPathIntent::Write {
                    path: VaultPath::new(path).unwrap(),
                    expected: ExpectedPathState::Bytes(expected.as_bytes().to_vec()),
                    content: content.as_bytes().to_vec(),
                })
                .collect(),
            create_directories: Vec::new(),
            remove_directories: Vec::new(),
            index_events: replacements
                .iter()
                .map(|(path, _, _)| ChangeEvent::Upsert(VaultPath::new(path).unwrap()))
                .collect(),
            moved_pages: Vec::new(),
        }
    }

    #[test]
    fn batch_prepare_cleanup_error_exposes_retained_directory() {
        let directory = PathBuf::from("/vault/.clepsydra/transactions/test");
        let error = batch_prepare_error(BatchMutationError::PreparationCleanup {
            directory: directory.clone(),
            retained: true,
            source: Box::new(BatchMutationError::Validation("prepare failed".to_owned())),
            cleanup: Box::new(BatchMutationError::Validation("cleanup failed".to_owned())),
        });

        assert!(matches!(
            error,
            MutationError::BatchPrepare {
                directory: Some(retained),
                ..
            } if retained == directory
        ));
    }

    #[tokio::test]
    async fn batch_revalidates_every_path_after_lock_acquisition() {
        let original_a = batch_page(
            "019fd000-0000-7000-8000-000000000001",
            "A",
            "one",
        );
        let original_b = batch_page(
            "019fd000-0000-7000-8000-000000000002",
            "B",
            "two",
        );
        let fixture = BatchFixture::new(&[("a.md", &original_a), ("b.md", &original_b)]);
        let original_a = fs::read_to_string(fixture.root().join("a.md")).unwrap();
        let original_b = fs::read_to_string(fixture.root().join("b.md")).unwrap();
        let replacement_a = original_a.replace("one", "ONE");
        let replacement_b = original_b.replace("two", "TWO");
        let external_b = original_b.replace("two", "external");
        let held = fixture
            .coordinator
            .lock_paths(&[VaultPath::new("a.md").unwrap()])
            .await;
        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel();
        let waiting_tx = Arc::new(parking_lot::Mutex::new(Some(waiting_tx)));
        let observed_wait = Arc::clone(&waiting_tx);
        fixture
            .coordinator
            .set_before_lock_acquire_hook(Some(Arc::new(move |path| {
                if path.as_str() == "a.md"
                    && let Some(waiting_tx) = observed_wait.lock().take()
                {
                    let _ = waiting_tx.send(());
                }
            })));
        let coordinator = Arc::clone(&fixture.coordinator);
        let vault = fixture.vault.clone();
        let index = fixture.index.clone();
        let command = replace_batch(&[
            ("a.md", &original_a, &replacement_a),
            ("b.md", &original_b, &replacement_b),
        ]);
        let pending = tokio::spawn(async move {
            coordinator
                .execute_batch(
                    &vault,
                    &index,
                    Arc::new(Vec::new()),
                    command,
                    Arc::new(|_| panic!("stale batch must not notify")),
                )
                .await
        });

        waiting_rx
            .await
            .expect("batch did not reach the held path lock");
        fs::write(fixture.root().join("b.md"), &external_b).unwrap();
        drop(held);
        let error = pending.await.unwrap().unwrap_err();

        assert!(matches!(error, MutationError::Stale(path) if path.as_str() == "b.md"));
        assert_eq!(
            fs::read_to_string(fixture.root().join("a.md")).unwrap(),
            original_a
        );
        assert_eq!(
            fs::read_to_string(fixture.root().join("b.md")).unwrap(),
            external_b
        );
    }

    #[tokio::test]
    async fn batch_notifies_once_after_every_file_and_index_commit() {
        let original_a = batch_page(
            "019fd000-0000-7000-8000-000000000011",
            "A",
            "one",
        );
        let original_b = batch_page(
            "019fd000-0000-7000-8000-000000000012",
            "B",
            "two",
        );
        let fixture = BatchFixture::new(&[("a.md", &original_a), ("b.md", &original_b)]);
        let original_a = fs::read_to_string(fixture.root().join("a.md")).unwrap();
        let original_b = fs::read_to_string(fixture.root().join("b.md")).unwrap();
        let replacement_a = original_a.replace("one", "ONE");
        let replacement_b = original_b.replace("two", "TWO");
        let notifications = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let observed = Arc::clone(&notifications);
        let notification_root = fixture.root().to_path_buf();
        let expected_hashes = [
            (
                "a.md",
                blake3::hash(replacement_a.as_bytes()).to_hex().to_string(),
            ),
            (
                "b.md",
                blake3::hash(replacement_b.as_bytes()).to_hex().to_string(),
            ),
        ];

        let returned = fixture
            .coordinator
            .execute_batch(
                &fixture.vault,
                &fixture.index,
                Arc::new(Vec::new()),
                replace_batch(&[
                    ("a.md", &original_a, &replacement_a),
                    ("b.md", &original_b, &replacement_b),
                ]),
                Arc::new(move |notification| {
                    let database =
                        rusqlite::Connection::open(notification_root.join(".clepsydra/cache.db"))
                            .unwrap();
                    for (path, expected_hash) in &expected_hashes {
                        assert_eq!(
                            blake3::hash(&fs::read(notification_root.join(path)).unwrap())
                                .to_hex()
                                .as_str(),
                            expected_hash
                        );
                        let indexed_hash = database
                            .query_row(
                                "SELECT content_hash FROM pages WHERE path = ?1",
                                [path],
                                |row| row.get::<_, String>(0),
                            )
                            .unwrap();
                        assert_eq!(&indexed_hash, expected_hash);
                    }
                    observed.lock().push(notification);
                }),
            )
            .await
            .unwrap();

        let expected = MutationNotification {
            upserted: vec!["a.md".into(), "b.md".into()],
            removed: Vec::new(),
        };
        assert_eq!(returned, expected);
        assert_eq!(notifications.lock().as_slice(), &[expected]);
        assert_eq!(
            fs::read_to_string(fixture.root().join("a.md")).unwrap(),
            replacement_a
        );
        assert_eq!(
            fs::read_to_string(fixture.root().join("b.md")).unwrap(),
            replacement_b
        );
        let indexed_paths = fixture
            .index
            .with_index(|index, _| {
                let mut statement = index
                    .connection()
                    .prepare("SELECT path FROM pages WHERE path IN ('a.md', 'b.md') ORDER BY path")?;
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(indexed_paths, ["a.md".to_string(), "b.md".to_string()]);
    }

    #[tokio::test]
    async fn batch_index_failure_retains_committed_workspace_without_notification() {
        let original = batch_page(
            "019fd000-0000-7000-8000-000000000021",
            "A",
            "before",
        );
        let fixture = BatchFixture::new(&[("a.md", &original)]);
        let original = fs::read_to_string(fixture.root().join("a.md")).unwrap();
        let replacement = original.replace("before", "after");
        fs::create_dir(fixture.root().join("broken-index-target")).unwrap();
        let mut command = replace_batch(&[("a.md", &original, &replacement)]);
        command.index_events = vec![ChangeEvent::Upsert(
            VaultPath::new("broken-index-target").unwrap(),
        )];
        let notifications = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let observed = Arc::clone(&notifications);

        let error = fixture
            .coordinator
            .execute_batch(
                &fixture.vault,
                &fixture.index,
                Arc::new(Vec::new()),
                command,
                Arc::new(move |notification| observed.lock().push(notification)),
            )
            .await
            .unwrap_err();

        let directory = match error {
            MutationError::BatchRecovery { directory, .. } => directory,
            error => panic!("expected retained batch recovery error, got {error:?}"),
        };
        assert!(directory.is_dir());
        assert_eq!(
            fs::read_to_string(fixture.root().join("a.md")).unwrap(),
            replacement
        );
        assert!(notifications.lock().is_empty());
    }

    #[tokio::test]
    async fn batch_invalid_indexed_move_uuid_retains_workspace_without_notification() {
        let seeded_source = batch_page(
            "019fd000-0000-7000-8000-000000000029",
            "Source",
            "body",
        );
        let fixture = BatchFixture::new(&[("source.md", &seeded_source)]);
        let source_content =
            fs::read_to_string(fixture.root().join("source.md")).unwrap();
        fixture
            .index
            .with_index(|index, _| {
                index.connection().execute_batch(
                    "PRAGMA foreign_keys = OFF;
                     UPDATE pages SET id = 'not-a-uuid' WHERE path = 'source.md';
                     PRAGMA foreign_keys = ON;",
                )
            })
            .await
            .unwrap()
            .unwrap();
        let source = VaultPath::new("source.md").unwrap();
        let destination = VaultPath::new("destination.md").unwrap();
        let notifications = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let observed = Arc::clone(&notifications);

        let error = fixture
            .coordinator
            .execute_batch(
                &fixture.vault,
                &fixture.index,
                Arc::new(Vec::new()),
                BatchMutationCommand {
                    intents: vec![BatchPathIntent::Move {
                        source: source.clone(),
                        destination: destination.clone(),
                        expected_source: source_content.as_bytes().to_vec(),
                    }],
                    create_directories: Vec::new(),
                    remove_directories: Vec::new(),
                    index_events: vec![
                        ChangeEvent::Remove(source.clone()),
                        ChangeEvent::Upsert(destination.clone()),
                    ],
                    moved_pages: vec![(source.clone(), destination.clone())],
                },
                Arc::new(move |notification| observed.lock().push(notification)),
            )
            .await
            .unwrap_err();

        let directory = match error {
            MutationError::BatchRecovery { directory, .. } => directory,
            error => panic!("expected retained batch recovery error, got {error:?}"),
        };
        assert!(directory.is_dir());
        assert!(!fixture.root().join(source.as_str()).exists());
        assert_eq!(
            fs::read_to_string(fixture.root().join(destination.as_str())).unwrap(),
            source_content
        );
        assert!(notifications.lock().is_empty());
    }

    #[tokio::test]
    async fn batch_overlaps_with_reversed_input_order_without_deadlock() {
        let original_a = batch_page(
            "019fd000-0000-7000-8000-000000000031",
            "A",
            "zero",
        );
        let original_b = batch_page(
            "019fd000-0000-7000-8000-000000000032",
            "B",
            "zero",
        );
        let fixture = BatchFixture::new(&[("a.md", &original_a), ("b.md", &original_b)]);
        let original_a = fs::read_to_string(fixture.root().join("a.md")).unwrap();
        let original_b = fs::read_to_string(fixture.root().join("b.md")).unwrap();
        let first_a = original_a.replace("zero", "first");
        let first_b = original_b.replace("zero", "first");
        let second_a = original_a.replace("zero", "second");
        let second_b = original_b.replace("zero", "second");
        let lock_requests = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let observed_requests = Arc::clone(&lock_requests);
        fixture
            .coordinator
            .set_before_batch_lock_hook(Some(Arc::new(move |paths| {
                observed_requests.lock().push(
                    paths
                        .iter()
                        .map(|path| path.as_str().to_owned())
                        .collect::<Vec<_>>(),
                );
            })));
        let notify_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_notify_count = Arc::clone(&notify_count);
        let second_notify_count = Arc::clone(&notify_count);
        let first_coordinator = Arc::clone(&fixture.coordinator);
        let second_coordinator = Arc::clone(&fixture.coordinator);
        let first_vault = fixture.vault.clone();
        let second_vault = fixture.vault.clone();
        let first_index = fixture.index.clone();
        let second_index = fixture.index.clone();
        let first_command = replace_batch(&[
            ("a.md", &original_a, &first_a),
            ("b.md", &original_b, &first_b),
        ]);
        let second_command = replace_batch(&[
            ("b.md", &original_b, &second_b),
            ("a.md", &original_a, &second_a),
        ]);
        let first = tokio::spawn(async move {
            first_coordinator
                .execute_batch(
                    &first_vault,
                    &first_index,
                    Arc::new(Vec::new()),
                    first_command,
                    Arc::new(move |_| {
                        first_notify_count.fetch_add(1, Ordering::SeqCst);
                    }),
                )
                .await
        });
        let second = tokio::spawn(async move {
            second_coordinator
                .execute_batch(
                    &second_vault,
                    &second_index,
                    Arc::new(Vec::new()),
                    second_command,
                    Arc::new(move |_| {
                        second_notify_count.fetch_add(1, Ordering::SeqCst);
                    }),
                )
                .await
        });

        let (first_result, second_result) =
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                (first.await.unwrap(), second.await.unwrap())
            })
            .await
            .expect("overlapping reversed-order batches deadlocked");

        assert_ne!(first_result.is_ok(), second_result.is_ok());
        let stale = if first_result.is_err() {
            first_result.unwrap_err()
        } else {
            second_result.unwrap_err()
        };
        assert!(matches!(stale, MutationError::Stale(_)));
        assert_eq!(notify_count.load(Ordering::SeqCst), 1);
        let requests = lock_requests.lock();
        assert_eq!(requests.len(), 2);
        assert!(
            requests
                .iter()
                .all(|paths| paths == &["a.md".to_string(), "b.md".to_string()])
        );
    }

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

    async fn indexed_page_count(index: &IndexHandle) -> i64 {
        index
            .with_index(|index, _| {
                index
                    .connection()
                    .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
            })
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn reserved_manifest_create_and_replace_publish_exact_bytes_without_indexing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut raw_index =
            crate::vault::index::VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        raw_index.build(&vault).unwrap();
        let index = IndexHandle::spawn(raw_index, vault.clone());
        assert_eq!(indexed_page_count(&index).await, 0);

        let coordinator = MutationCoordinator::new();
        let path = VaultPath::new("feeds.md").unwrap();
        let first = b"\xef\xbb\xbf## Tech\r\n- https://one.example/rss\r\n".to_vec();
        let second =
            b"+++\r\nid = '01900000-0000-7000-8000-000000000001'\r\n+++\r\n## News\r\n- https://two.example/rss"
                .to_vec();
        let notifications = parking_lot::Mutex::new(Vec::new());
        let notify = |notification: MutationNotification| notifications.lock().push(notification);

        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: None,
                    content: first.clone(),
                },
                &notify,
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read(root.join("feeds.md")).unwrap(), first);
        assert_eq!(indexed_page_count(&index).await, 0);

        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path,
                    expected_content: Some(first),
                    content: second.clone(),
                },
                &notify,
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read(root.join("feeds.md")).unwrap(), second);
        assert_eq!(
            indexed_page_count(&index).await,
            0,
            "reserved manifest publication must not call IndexHandle::apply_mutation"
        );
        assert_eq!(notifications.lock().len(), 2);
    }

    #[tokio::test]
    async fn reserved_manifest_compare_and_swap_preserves_external_bytes_when_stale() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let coordinator = MutationCoordinator::new();
        let path = VaultPath::new("feeds.md").unwrap();
        let original = b"## Original\n- https://one.example/rss\n".to_vec();
        let external = b"## External\r\n- https://external.example/rss\r\n".to_vec();

        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: None,
                    content: original.clone(),
                },
                &|_: MutationNotification| {},
            )
            .await
            .unwrap();
        std::fs::write(root.join("feeds.md"), &external).unwrap();

        let error = coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: Some(original),
                    content: b"## Candidate\n- https://candidate.example/rss\n".to_vec(),
                },
                &|_: MutationNotification| panic!("stale publication must not notify"),
            )
            .await
            .unwrap_err();

        assert!(matches!(error, MutationError::Stale(stale) if stale == path));
        assert_eq!(std::fs::read(root.join("feeds.md")).unwrap(), external);
    }

    #[tokio::test]
    async fn reserved_manifest_rejects_path_replacement_at_the_publication_seam() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut raw_index =
            crate::vault::index::VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        raw_index.build(&vault).unwrap();
        let index = IndexHandle::spawn(raw_index, vault.clone());
        let coordinator = MutationCoordinator::new();
        let path = VaultPath::new("feeds.md").unwrap();
        let original = b"## Original\n- https://one.example/rss\n".to_vec();
        // Same bytes, different directory entry: a second pre-publication read
        // cannot detect this ABA replacement, but conditional publication must.
        let external = original.clone();
        let candidate = b"## Candidate\n- https://candidate.example/rss\n".to_vec();
        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: None,
                    content: original.clone(),
                },
                &|_: MutationNotification| {},
            )
            .await
            .unwrap();
        let external_path = root.join("external-feeds.md");
        std::fs::write(&external_path, &external).unwrap();
        let destination = root.join("feeds.md");
        coordinator.set_before_update_publish_hook(Some(Arc::new(move |observed| {
            assert_eq!(observed.as_str(), "feeds.md");
            std::fs::rename(&external_path, &destination).unwrap();
        })));
        let notifications = parking_lot::Mutex::new(Vec::new());

        let error = coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: Some(original),
                    content: candidate,
                },
                &|notification: MutationNotification| notifications.lock().push(notification),
            )
            .await
            .unwrap_err();

        assert!(matches!(error, MutationError::Stale(stale) if stale == path));
        assert_eq!(std::fs::read(root.join("feeds.md")).unwrap(), external);
        assert!(notifications.lock().is_empty());
        assert_eq!(
            indexed_page_count(&index).await,
            0,
            "failed reserved publication must leave the page index untouched"
        );
    }
    #[tokio::test]
    async fn reserved_manifest_rejects_completed_same_inode_write_before_claim_verification() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut raw_index =
            crate::vault::index::VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        raw_index.build(&vault).unwrap();
        let index = IndexHandle::spawn(raw_index, vault.clone());
        let coordinator = MutationCoordinator::new();
        let path = VaultPath::new("feeds.md").unwrap();
        let original = b"## Original\n- https://one.example/rss\n".to_vec();
        let external = b"## External\n- https://external.example/rss\n".to_vec();
        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: None,
                    content: original.clone(),
                },
                &|_: MutationNotification| {},
            )
            .await
            .unwrap();
        let destination = root.join("feeds.md");
        #[cfg(unix)]
        let original_identity = std::fs::metadata(&destination).unwrap();
        coordinator.set_before_update_publish_hook(Some(Arc::new({
            let destination = destination.clone();
            let external = external.clone();
            move |observed| {
                assert_eq!(observed.as_str(), "feeds.md");
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&destination)
                    .unwrap();
                std::io::Write::write_all(&mut file, &external).unwrap();
                file.sync_all().unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    assert_eq!(
                        std::fs::metadata(&destination).unwrap().ino(),
                        original_identity.ino(),
                        "fixture must mutate the already-observed inode"
                    );
                }
            }
        })));
        let notifications = parking_lot::Mutex::new(Vec::new());

        let error = coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: Some(original),
                    content: b"## Candidate\n- https://candidate.example/rss\n".to_vec(),
                },
                &|notification: MutationNotification| notifications.lock().push(notification),
            )
            .await
            .unwrap_err();

        assert!(matches!(error, MutationError::Stale(stale) if stale == path));
        assert_eq!(std::fs::read(destination).unwrap(), external);
        assert!(notifications.lock().is_empty());
        assert_eq!(
            indexed_page_count(&index).await,
            0,
            "failed reserved publication must leave the page index untouched"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reserved_manifest_replacement_preserves_destination_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let vault = Vault::open(&root).unwrap();
        let coordinator = MutationCoordinator::new();
        let path = VaultPath::new("feeds.md").unwrap();
        let original = b"## Original\n- https://one.example/rss\n".to_vec();
        let replacement = b"## Replacement\n- https://two.example/rss\n".to_vec();
        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path: path.clone(),
                    expected_content: None,
                    content: original.clone(),
                },
                &|_: MutationNotification| {},
            )
            .await
            .unwrap();
        let destination = root.join("feeds.md");
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o600)).unwrap();

        coordinator
            .write_reserved_manifest(
                &vault,
                ReservedManifestCommand {
                    path,
                    expected_content: Some(original),
                    content: replacement.clone(),
                },
                &|_: MutationNotification| {},
            )
            .await
            .unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), replacement);
        assert_eq!(
            std::fs::metadata(destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
