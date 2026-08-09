use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use thiserror::Error;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use super::Vault;
use super::atomic_file::{
    AtomicPublicationError, ConditionalPublicationError, atomic_create, atomic_replace,
    atomic_replace_if_unchanged,
};
use super::hooks::PostMoveHook;
use super::index::IndexError;
use super::index_handle::IndexHandle;
use super::index_policy::{IndexMutation, IndexPolicyError};
use super::page::{Page, PageMeta, write_page_content};
use super::path::VaultPath;
use super::projection::{project_path, project_path_cleared};

type BeforeUpdatePublishHook = dyn Fn(&VaultPath) + Send + Sync;
type AfterPageIdLookupHook = dyn Fn(&VaultPath) + Send + Sync;

/// Serializes mutations that touch the same normalized vault paths.
pub struct MutationCoordinator {
    locks: parking_lot::Mutex<HashMap<VaultPath, Weak<RwLock<()>>>>,
    before_update_publish_hook: parking_lot::Mutex<Option<Arc<BeforeUpdatePublishHook>>>,
    after_page_id_lookup_hook: parking_lot::Mutex<Option<Arc<AfterPageIdLookupHook>>>,
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
            Self::InvalidInput(_) | Self::NotFound(_) | Self::Conflict(_) | Self::Stale(_) => false,
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

impl MutationCoordinator {
    pub fn new() -> Self {
        Self {
            locks: parking_lot::Mutex::new(HashMap::new()),
            before_update_publish_hook: parking_lot::Mutex::new(None),
            after_page_id_lookup_hook: parking_lot::Mutex::new(None),
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
        let result =
            run_shielded_mutation(absolute.clone(), move |filesystem_applied| async move {
                let blocking_path = absolute.clone();
                let page_path = command.path.clone();
                let content = write_page_content(&command.meta, &command.body);
                let (guard, (durability_error, content)) =
                    run_blocking_fs(absolute.clone(), guard, move || {
                        if let Some(parent) = blocking_path.parent() {
                            fs::create_dir_all(parent).map_err(|source| {
                                MutationError::Filesystem {
                                    filesystem_applied: false,
                                    path: parent.to_path_buf(),
                                    source,
                                }
                            })?;
                        }
                        match atomic_create(&blocking_path, content.as_bytes()) {
                            Ok(()) => Ok((None, content)),
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
                                Ok((Some(source), content))
                            }
                        }
                    })
                    .await?;
                filesystem_applied.store(true, Ordering::Release);
                let _guard = guard;
                index
                    .apply_mutation(command.path.clone(), IndexMutation::Created)
                    .await
                    .map_err(|source| MutationError::Index {
                        filesystem_applied: true,
                        source,
                    })?;
                if let Some(source) = durability_error {
                    return Err(MutationError::Filesystem {
                        filesystem_applied: true,
                        path: absolute,
                        source,
                    });
                }
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
                    source,
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
                        source,
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
                        source,
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
