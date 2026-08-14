//! Durable atomic file publication helpers.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Read as _, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Failure phase for an atomic publication attempt.
///
/// Callers must compensate or reconcile `PublishedButNotDurable`: the
/// destination already contains the requested bytes even though the parent
/// directory flush failed.
#[derive(Debug, thiserror::Error)]
pub enum AtomicPublicationError {
    #[error("atomic publication did not publish: {0}")]
    NotPublished(#[source] io::Error),
    #[error("atomic publication completed but was not durable: {0}")]
    PublishedButNotDurable(#[source] io::Error),
}

impl AtomicPublicationError {
    pub fn kind(&self) -> io::ErrorKind {
        match self {
            Self::NotPublished(error) | Self::PublishedButNotDurable(error) => error.kind(),
        }
    }

    pub fn filesystem_applied(&self) -> bool {
        matches!(self, Self::PublishedButNotDurable(_))
    }

    pub fn into_inner(self) -> io::Error {
        match self {
            Self::NotPublished(error) | Self::PublishedButNotDurable(error) => error,
        }
    }
}

/// Result of an exact-content replacement whose destination identity changed.
#[derive(Debug, thiserror::Error)]
pub enum ConditionalPublicationError {
    #[error("destination changed before conditional publication")]
    Stale,
    #[error(transparent)]
    Publication(#[from] AtomicPublicationError),
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity;

#[cfg(not(unix))]
fn file_identity(_metadata: &fs::Metadata) -> io::Result<FileIdentity> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "conditional exact-content replacement requires stable filesystem file identities",
    ))
}

/// Replace `path` only while the exact directory entry that supplied
/// `expected` remains current.
///
/// The destination is atomically moved to a private claim path with
/// no-replace semantics before the candidate is created. This closes the
/// compare/rename ABA window for cooperating writers: an intervening rename is
/// detected by file identity even when it supplies byte-identical content, and
/// the claimed external entry is restored without being overwritten.
pub fn atomic_replace_if_unchanged(
    path: &Path,
    expected: &[u8],
    content: &[u8],
    before_publish: impl FnOnce(),
) -> Result<(), ConditionalPublicationError> {
    let mut observed = fs::File::open(path).map_err(|source| {
        if source.kind() == ErrorKind::NotFound {
            ConditionalPublicationError::Stale
        } else {
            ConditionalPublicationError::Publication(AtomicPublicationError::NotPublished(source))
        }
    })?;
    let observed_metadata = observed.metadata().map_err(|source| {
        ConditionalPublicationError::Publication(AtomicPublicationError::NotPublished(source))
    })?;
    let observed_identity = file_identity(&observed_metadata).map_err(|source| {
        ConditionalPublicationError::Publication(AtomicPublicationError::NotPublished(source))
    })?;
    let observed_permissions = observed_metadata.permissions();
    let mut observed_bytes = Vec::new();
    observed
        .read_to_end(&mut observed_bytes)
        .map_err(|source| {
            ConditionalPublicationError::Publication(AtomicPublicationError::NotPublished(source))
        })?;
    if observed_bytes != expected {
        return Err(ConditionalPublicationError::Stale);
    }

    before_publish();
    let claim = claim_destination(path).map_err(|source| {
        if source.kind() == ErrorKind::NotFound {
            ConditionalPublicationError::Stale
        } else {
            ConditionalPublicationError::Publication(AtomicPublicationError::NotPublished(source))
        }
    })?;
    let claimed_metadata = match fs::metadata(&claim) {
        Ok(metadata) => metadata,
        Err(source) => {
            let _ = restore_claim(path, &claim);
            return Err(ConditionalPublicationError::Publication(
                AtomicPublicationError::NotPublished(source),
            ));
        }
    };
    let claimed_identity = match file_identity(&claimed_metadata) {
        Ok(identity) => identity,
        Err(source) => {
            let _ = restore_claim(path, &claim);
            return Err(ConditionalPublicationError::Publication(
                AtomicPublicationError::NotPublished(source),
            ));
        }
    };
    if claimed_identity != observed_identity {
        restore_claim(path, &claim)?;
        return Err(ConditionalPublicationError::Stale);
    }
    let claimed_bytes = match fs::read(&claim) {
        Ok(bytes) => bytes,
        Err(source) => {
            let _ = restore_claim(path, &claim);
            return Err(ConditionalPublicationError::Publication(
                AtomicPublicationError::NotPublished(source),
            ));
        }
    };
    if claimed_bytes != expected {
        restore_claim(path, &claim)?;
        return Err(ConditionalPublicationError::Stale);
    }

    match atomic_write_with(
        path,
        content,
        Some(observed_permissions),
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        install_noreplace,
        sync_parent,
        remove_temporary,
    ) {
        Ok(()) => {
            fs::remove_file(&claim).map_err(|source| {
                ConditionalPublicationError::Publication(
                    AtomicPublicationError::PublishedButNotDurable(source),
                )
            })?;
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            sync_parent(parent).map_err(|source| {
                ConditionalPublicationError::Publication(
                    AtomicPublicationError::PublishedButNotDurable(source),
                )
            })
        }
        Err(AtomicPublicationError::NotPublished(source))
            if source.kind() == ErrorKind::AlreadyExists =>
        {
            let _ = fs::remove_file(&claim);
            Err(ConditionalPublicationError::Stale)
        }
        Err(error) => {
            let _ = restore_claim(path, &claim);
            Err(ConditionalPublicationError::Publication(error))
        }
    }
}

fn claim_destination(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "destination has no file name"))?;
    loop {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut claim_name = std::ffi::OsString::from(".");
        claim_name.push(file_name);
        claim_name.push(format!(
            ".clepsydra-claim-{}-{sequence}",
            std::process::id()
        ));
        let claim = parent.join(claim_name);
        match install_noreplace(path, &claim) {
            Ok(()) => return Ok(claim),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

fn restore_claim(path: &Path, claim: &Path) -> Result<(), ConditionalPublicationError> {
    install_noreplace(claim, path).map_err(|source| {
        ConditionalPublicationError::Publication(AtomicPublicationError::NotPublished(source))
    })?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    sync_parent(parent).map_err(|source| {
        ConditionalPublicationError::Publication(AtomicPublicationError::PublishedButNotDurable(
            source,
        ))
    })
}

/// Publish a fully written file without replacing an existing destination.
///
/// The temporary file is created and synced beside the destination before the
/// atomic no-replace operation makes it visible. On Unix, the parent directory
/// is then synced so the new directory entry is durable. Windows cannot provide
/// the same guarantee through the filesystem APIs used by this crate.
pub fn atomic_create(path: &Path, content: &[u8]) -> Result<(), AtomicPublicationError> {
    tracing::debug!(
        "atomic_create: publishing {} bytes to {}",
        content.len(),
        path.display()
    );
    atomic_write_with(
        path,
        content,
        None,
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        install_noreplace,
        sync_parent,
        remove_temporary,
    )
}

/// Publish a newly created sensitive file with owner-only permissions.
///
/// On Unix the temporary file is set to `0600` before any bytes are written or
/// the destination becomes visible, avoiding an umask-dependent exposure
/// window. Other platforms retain [`atomic_create`] semantics; callers may
/// apply their platform-specific access controls after publication.
#[cfg(unix)]
pub fn atomic_create_owner_only(path: &Path, content: &[u8]) -> Result<(), AtomicPublicationError> {
    use std::os::unix::fs::PermissionsExt;
    tracing::debug!(
        "atomic_create_owner_only: publishing {} bytes to {}",
        content.len(),
        path.display()
    );
    atomic_write_with(
        path,
        content,
        Some(fs::Permissions::from_mode(0o600)),
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        install_noreplace,
        sync_parent,
        remove_temporary,
    )
}

#[cfg(not(unix))]
pub fn atomic_create_owner_only(path: &Path, content: &[u8]) -> Result<(), AtomicPublicationError> {
    atomic_create(path, content)
}

/// Replace a file without exposing a partial write while retaining the
/// destination's permissions.
///
/// The temporary file is created alongside the destination so the final
/// rename remains within one filesystem. Metadata not represented by the
/// standard filesystem permissions API is platform-specific and is not part
/// of the vault filesystem abstraction.
pub fn atomic_replace(path: &Path, content: &[u8]) -> Result<(), AtomicPublicationError> {
    tracing::debug!(
        "atomic_replace: publishing {} bytes to {}",
        content.len(),
        path.display()
    );
    let permissions = fs::metadata(path)
        .map_err(AtomicPublicationError::NotPublished)?
        .permissions();
    atomic_write_with(
        path,
        content,
        Some(permissions),
        |file, content| {
            file.write_all(content)?;
            file.sync_all()
        },
        replace,
        sync_parent,
        remove_temporary,
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
) -> Result<(), AtomicPublicationError>
where
    WriteAndSync: FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
    Rename: FnOnce(&Path, &Path) -> io::Result<()>,
    SyncParent: FnOnce(&Path) -> io::Result<()>,
    RemoveTemporary: FnOnce(&Path) -> io::Result<()>,
{
    let permissions = fs::metadata(path)
        .map_err(AtomicPublicationError::NotPublished)?
        .permissions();
    atomic_write_with(
        path,
        content,
        Some(permissions),
        write_and_sync,
        rename,
        sync_parent,
        remove_temporary,
    )
}

fn atomic_write_with<WriteAndSync, Publish, SyncParent, RemoveTemporary>(
    path: &Path,
    content: &[u8],
    permissions: Option<fs::Permissions>,
    write_and_sync: WriteAndSync,
    publish: Publish,
    sync_parent: SyncParent,
    remove_temporary: RemoveTemporary,
) -> Result<(), AtomicPublicationError>
where
    WriteAndSync: FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
    Publish: FnOnce(&Path, &Path) -> io::Result<()>,
    SyncParent: FnOnce(&Path) -> io::Result<()>,
    RemoveTemporary: FnOnce(&Path) -> io::Result<()>,
{
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name"))
        .map_err(AtomicPublicationError::NotPublished)?;

    let (temporary_path, mut temporary_file) =
        create_temporary_file(parent, file_name).map_err(AtomicPublicationError::NotPublished)?;
    if let Some(permissions) = permissions
        && let Err(primary_error) = temporary_file.set_permissions(permissions)
    {
        drop(temporary_file);
        return Err(AtomicPublicationError::NotPublished(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        )));
    }
    if let Err(primary_error) = write_and_sync(&mut temporary_file, content) {
        drop(temporary_file);
        return Err(AtomicPublicationError::NotPublished(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        )));
    }

    drop(temporary_file);
    if let Err(primary_error) = publish(&temporary_path, path) {
        return Err(AtomicPublicationError::NotPublished(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        )));
    }

    sync_parent(parent).map_err(|error| {
        AtomicPublicationError::PublishedButNotDurable(io::Error::new(
            error.kind(),
            format!(
                "rename completed for {}; failed to sync parent directory {}: {error}; \
                 destination may contain the new content",
                path.display(),
                parent.display()
            ),
        ))
    })
}

#[cfg(not(windows))]
fn sync_parent(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

/// Windows' standard filesystem API opens files without the directory-only
/// `FILE_FLAG_BACKUP_SEMANTICS` flag, so `File::open(parent)` always fails.
/// The crate has no dependency that exposes a verified directory handle and
/// flush operation. Publication is already complete at this point; until such
/// an implementation is available, parent synchronization is deliberately a
/// successful no-op rather than reporting that every successful publication
/// failed.
#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn remove_temporary(path: &Path) -> io::Result<()> {
    fs::remove_file(path)
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

#[cfg(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    target_os = "redox"
))]
pub fn install_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    use rustix::io::Errno;

    renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(|error| {
        if matches!(error, Errno::NOSYS | Errno::INVAL | Errno::NOTSUP) {
            io::Error::new(
                ErrorKind::Unsupported,
                format!("atomic no-replace rename is unsupported: {error}"),
            )
        } else {
            error.into()
        }
    })
}

#[cfg(windows)]
pub fn install_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;

    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), 0) } != 0 {
        return Ok(());
    }

    let error = io::Error::last_os_error();
    let destination_occupied = fs::symlink_metadata(destination).is_ok();
    if matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_ALREADY_EXISTS as i32 || code == ERROR_FILE_EXISTS as i32
    ) || destination_occupied
    {
        Err(io::Error::new(ErrorKind::AlreadyExists, error))
    } else {
        Err(error)
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    target_os = "redox",
    windows
)))]
pub fn install_noreplace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "atomic no-replace rename is unsupported on this operating system",
    ))
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn install_noreplace_preserves_source_and_occupied_empty_directory() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("sentinel"), b"source").unwrap();
        fs::create_dir(&destination).unwrap();

        let error = install_noreplace(&source, &destination).unwrap_err();

        assert_eq!(error.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(source.join("sentinel")).unwrap(), b"source");
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    }
}
