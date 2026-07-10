use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use tokio::sync::{Mutex, OwnedMutexGuard};

use super::path::VaultPath;

/// Serializes mutations that touch the same normalized vault paths.
pub struct MutationCoordinator {
    locks: parking_lot::Mutex<HashMap<VaultPath, Weak<Mutex<()>>>>,
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
