//! Durable atomic file publication helpers.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Publish a fully written file without replacing an existing destination.
///
/// The temporary file is created and synced beside the destination before the
/// atomic no-replace operation makes it visible. The parent directory is then
/// synced so the new directory entry is durable.
pub fn atomic_create(path: &Path, content: &[u8]) -> io::Result<()> {
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

/// Replace a file without exposing a partial write while retaining the
/// destination's permissions.
///
/// The temporary file is created alongside the destination so the final
/// rename remains within one filesystem. Metadata not represented by the
/// standard filesystem permissions API is platform-specific and is not part
/// of the vault filesystem abstraction.
pub fn atomic_replace(path: &Path, content: &[u8]) -> io::Result<()> {
    let permissions = fs::metadata(path)?.permissions();
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
) -> io::Result<()>
where
    WriteAndSync: FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
    Rename: FnOnce(&Path, &Path) -> io::Result<()>,
    SyncParent: FnOnce(&Path) -> io::Result<()>,
    RemoveTemporary: FnOnce(&Path) -> io::Result<()>,
{
    let permissions = fs::metadata(path)?.permissions();
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
) -> io::Result<()>
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
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?;

    let (temporary_path, mut temporary_file) = create_temporary_file(parent, file_name)?;
    if let Some(permissions) = permissions
        && let Err(primary_error) = temporary_file.set_permissions(permissions)
    {
        drop(temporary_file);
        return Err(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        ));
    }
    if let Err(primary_error) = write_and_sync(&mut temporary_file, content) {
        drop(temporary_file);
        return Err(cleanup_error(
            primary_error,
            &temporary_path,
            remove_temporary,
        ));
    }

    drop(temporary_file);
    if let Err(primary_error) = publish(&temporary_path, path) {
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

fn sync_parent(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
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
    // std::fs::rename maps to a no-replace move on Windows.
    std::fs::rename(source, destination)
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
