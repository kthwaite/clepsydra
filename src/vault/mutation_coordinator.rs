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
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent")
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;

    let (temporary_path, mut temporary_file) = create_temporary_file(parent, file_name)?;
    if let Err(error) = temporary_file
        .write_all(content)
        .and_then(|()| temporary_file.sync_all())
    {
        drop(temporary_file);
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    drop(temporary_file);
    if let Err(error) = fs::rename(&temporary_path, path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(())
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
