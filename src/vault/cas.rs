//! Content-addressed storage for blobs, with reference counting and garbage collection.
use std::cell::Cell;
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, backup::Backup, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::cas_scan::ArchiveRefScan;

/// Result of storing a blob in the CAS.
pub struct StoreResult {
    pub hash: String,
    pub already_existed: bool,
}

/// Result of releasing captured-archive references for one rubbish item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseOutcome {
    Released,
    AlreadyCompleted,
}

#[derive(Debug, thiserror::Error)]
pub enum CasError {
    #[error("invalid CAS hash '{hash}': {message}")]
    InvalidHash { hash: String, message: String },
    #[error("CAS blob row is missing for {0}")]
    MissingBlob(String),
    #[error("CAS blob {hash} has invalid stored size {size}")]
    InvalidSize { hash: String, size: i64 },
    #[error("CAS blob {hash} has no reference to release (ref_count {ref_count})")]
    NoReference { hash: String, ref_count: i64 },
    #[error("invalid CAS backing blob for {hash}: {message}")]
    BackingBlob { hash: String, message: String },
    #[error("CAS reference changed after prevalidation for {0}")]
    ReferenceChanged(String),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Metadata for a CAS blob whose database row and backing file agree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobMetadata {
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug)]
pub enum RetrieveLimitedError {
    TooLarge { size: u64, limit: usize },
    Store(String),
}

impl std::fmt::Display for RetrieveLimitedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { size, limit } => {
                write!(formatter, "CAS blob size {size} exceeds read limit {limit}")
            }
            Self::Store(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RetrieveLimitedError {}

#[derive(Debug)]
pub struct OpenBlob {
    file: File,
    content_type: String,
    expected_size: u64,
}

impl OpenBlob {
    pub fn content_type(&self) -> &str {
        &self.content_type
    }
    pub fn read_limited(mut self, limit: usize) -> Result<(Vec<u8>, String), RetrieveLimitedError> {
        let mut data = Vec::new();
        data.try_reserve_exact(self.expected_size as usize)
            .map_err(|_| RetrieveLimitedError::Store("CAS read allocation failed".to_string()))?;
        self.file
            .by_ref()
            .take((limit as u64).saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        if data.len() > limit {
            return Err(RetrieveLimitedError::TooLarge {
                size: data.len() as u64,
                limit,
            });
        }
        if data.len() as u64 != self.expected_size {
            return Err(RetrieveLimitedError::Store(format!(
                "CAS backing file size changed while reading: expected {}, got {}",
                self.expected_size,
                data.len()
            )));
        }
        Ok((data, self.content_type))
    }
}
const LOCK_FILE_NAME: &str = "cas.lock";

#[cfg(test)]
type TestBarrierMap =
    std::collections::BTreeMap<(&'static str, PathBuf), std::sync::Arc<std::sync::Barrier>>;

#[cfg(test)]
static TEST_PATH_BARRIERS: std::sync::LazyLock<parking_lot::Mutex<TestBarrierMap>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(std::collections::BTreeMap::new()));

#[cfg(test)]
static BACKUP_BLOB_VERIFICATION_PASSES: std::sync::LazyLock<
    parking_lot::Mutex<std::collections::BTreeMap<String, usize>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(std::collections::BTreeMap::new()));

#[cfg(all(test, unix))]
type TestLockIdentity = (u64, u64);

#[cfg(all(test, unix))]
static TEST_BLOCKED_LOCK_BARRIERS: std::sync::LazyLock<
    parking_lot::Mutex<
        std::collections::BTreeMap<TestLockIdentity, std::sync::Arc<std::sync::Barrier>>,
    >,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(std::collections::BTreeMap::new()));

#[cfg(test)]
fn normalized_test_path(path: &Path) -> PathBuf {
    if let Ok(path) = fs::canonicalize(path) {
        return path;
    }
    let Some(filename) = path.file_name() else {
        return path.to_path_buf();
    };
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::canonicalize(parent)
        .map(|parent| parent.join(filename))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
fn install_test_path_barrier(
    event: &'static str,
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    let key = (event, normalized_test_path(&path));
    let prior = TEST_PATH_BARRIERS.lock().insert(key, barrier);
    assert!(
        prior.is_none(),
        "CAS test path barrier was already installed"
    );
}

#[cfg(test)]
fn pause_at_test_path_barrier(event: &'static str, path: &Path) {
    let key = (event, normalized_test_path(path));
    let barrier = TEST_PATH_BARRIERS.lock().remove(&key);
    if let Some(barrier) = barrier {
        barrier.wait();
        barrier.wait();
    }
}

#[cfg(test)]
fn install_after_root_path_resolved_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier("root-resolved", path, barrier);
}

#[cfg(test)]
fn install_after_database_path_resolved_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier("database-resolved", path, barrier);
}

#[cfg(all(test, target_vendor = "apple"))]
pub(crate) fn install_before_backup_database_open_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier("before-backup-database-open", path, barrier);
}

#[cfg(test)]
fn install_after_blob_ancestor_path_resolved_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier("blob-ancestor-resolved", path, barrier);
}

#[cfg(test)]
pub(crate) fn install_before_backup_blob_use_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    install_test_path_barrier("before-blob-use", path, barrier);
}

#[cfg(test)]
pub(crate) fn reset_backup_blob_verification_passes(hash: &str) {
    BACKUP_BLOB_VERIFICATION_PASSES.lock().remove(hash);
}

#[cfg(test)]
pub(crate) fn backup_blob_verification_passes(hash: &str) -> usize {
    BACKUP_BLOB_VERIFICATION_PASSES
        .lock()
        .get(hash)
        .copied()
        .unwrap_or(0)
}

#[cfg(all(test, unix))]
fn retained_lock_identity(file: &File) -> io::Result<TestLockIdentity> {
    use std::os::unix::fs::MetadataExt as _;

    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(all(test, unix))]
fn install_blocked_lock_barrier(file: &File, barrier: std::sync::Arc<std::sync::Barrier>) {
    let identity = retained_lock_identity(file).expect("inspect retained CAS test lock");
    let prior = TEST_BLOCKED_LOCK_BARRIERS.lock().insert(identity, barrier);
    assert!(
        prior.is_none(),
        "CAS blocked-lock test barrier was already installed"
    );
}

#[cfg(all(test, unix))]
fn pause_after_confirming_lock_contention(file: &File) -> io::Result<()> {
    let identity = retained_lock_identity(file)?;
    let barrier = TEST_BLOCKED_LOCK_BARRIERS.lock().remove(&identity);
    let Some(barrier) = barrier else {
        return Ok(());
    };
    match fs4::FileExt::try_lock(file) {
        Err(fs4::TryLockError::WouldBlock) => {
            barrier.wait();
            barrier.wait();
            Ok(())
        }
        Err(fs4::TryLockError::Error(error)) => Err(error),
        Ok(()) => {
            fs4::FileExt::unlock(file)?;
            Err(io::Error::other(
                "CAS blocked-lock test barrier reached an uncontended lock",
            ))
        }
    }
}

struct ExclusiveLockGuard<'a> {
    file: &'a File,
    held: &'a Cell<bool>,
}

impl<'a> ExclusiveLockGuard<'a> {
    fn acquire(file: &'a File, held: &'a Cell<bool>) -> io::Result<Self> {
        if held.replace(true) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "CAS mutation lock is already held by this content store",
            ));
        }
        #[cfg(all(test, unix))]
        if let Err(error) = pause_after_confirming_lock_contention(file) {
            held.set(false);
            return Err(error);
        }
        if let Err(error) = fs4::FileExt::lock(file) {
            held.set(false);
            return Err(error);
        }
        Ok(Self { file, held })
    }
}

impl Drop for ExclusiveLockGuard<'_> {
    fn drop(&mut self) {
        let _ = fs4::FileExt::unlock(self.file);
        self.held.set(false);
    }
}

/// Metadata for a verified CAS blob in a backup snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupBlob {
    hash: String,
    relative_path: PathBuf,
    size: u64,
}

impl BackupBlob {
    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn relative_path(&self) -> &Path {
        &self.relative_path
    }

    pub fn size(&self) -> u64 {
        self.size
    }
}

/// A consistent SQLite snapshot and its authoritative, verified blob set.
///
/// The CAS mutation lock remains held until this guard is dropped.
pub struct BackupSnapshot<'a> {
    database: tempfile::NamedTempFile,
    blobs: Vec<BackupBlob>,
    canonical_root: PathBuf,
    #[cfg(unix)]
    root_directory: &'a OwnedFd,
    #[cfg(windows)]
    root_directory: &'a File,
    #[cfg(test)]
    membership_comparisons: Cell<usize>,
    _lock: ExclusiveLockGuard<'a>,
}

impl BackupSnapshot<'_> {
    pub fn database_path(&self) -> &Path {
        self.database.path()
    }

    pub fn blobs(&self) -> &[BackupBlob] {
        &self.blobs
    }

    fn authoritative_blob(&self, blob: &BackupBlob) -> Option<&BackupBlob> {
        #[cfg(test)]
        self.membership_comparisons.set(0);
        let index = self
            .blobs
            .binary_search_by(|candidate| {
                #[cfg(test)]
                self.membership_comparisons
                    .set(self.membership_comparisons.get() + 1);
                candidate.hash.cmp(&blob.hash)
            })
            .ok()?;
        let candidate = &self.blobs[index];
        (candidate == blob).then_some(candidate)
    }

    #[cfg(test)]
    fn membership_comparisons(&self) -> usize {
        self.membership_comparisons.get()
    }

    /// Open and revalidate one authoritative blob for the duration of a callback.
    ///
    /// The descriptor owned by this method is closed before it returns, so
    /// normal archive traversal uses one blob descriptor at a time.
    pub fn with_blob_file(
        &self,
        blob: &BackupBlob,
        use_file: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if self.authoritative_blob(blob).is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "blob does not belong to this CAS backup snapshot",
            )
            .into());
        }
        let stored_size = i64::try_from(blob.size)?;
        let (_, mut file) = ContentStore::verified_backup_blob(
            &self.canonical_root,
            #[cfg(unix)]
            self.root_directory,
            #[cfg(windows)]
            self.root_directory,
            blob.hash.clone(),
            stored_size,
            false,
        )?;
        #[cfg(test)]
        pause_at_test_path_barrier(
            "before-blob-use",
            &self.canonical_root.join(blob.relative_path()),
        );
        use_file(&mut file).map_err(Into::into)
    }
}

/// Content-addressed blob store.
///
/// Blobs are stored on disk in a two-level fan-out directory (like git objects)
/// keyed by their SHA-256 hash. Metadata (size, content_type, ref_count) is
/// tracked in a SQLite table.
pub struct ContentStore {
    root: PathBuf,
    db: Option<Connection>,
    _database_file: File,
    lock_file: File,
    #[cfg(unix)]
    root_directory: OwnedFd,
    #[cfg(windows)]
    root_directory: File,
    lock_held: Cell<bool>,
}

#[cfg(unix)]
fn open_cas_root_directory(path: &Path) -> io::Result<OwnedFd> {
    use rustix::fs::{FileType, Mode, OFlags, fstat, open};

    let directory = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map_err(io::Error::from)?;
    let metadata = fstat(&directory).map_err(io::Error::from)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::Directory {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a CAS directory", path.display()),
        ));
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_or_create_regular_cas_file(
    directory: &OwnedFd,
    filename: &str,
    display_path: &Path,
    create: bool,
) -> io::Result<File> {
    use rustix::fs::{FileType, Mode, OFlags, fchmod, fstat, openat};
    use rustix::io::Errno;

    let create_flags = OFlags::RDWR
        | OFlags::CREATE
        | OFlags::EXCL
        | OFlags::CLOEXEC
        | OFlags::NOFOLLOW
        | OFlags::NONBLOCK;
    let existing_flags = OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK;
    let (file, created) = if create {
        match openat(directory, filename, create_flags, Mode::RUSR | Mode::WUSR) {
            Ok(file) => (file, true),
            Err(Errno::EXIST) => (
                openat(directory, filename, existing_flags, Mode::empty())
                    .map_err(io::Error::from)?,
                false,
            ),
            Err(error) => return Err(error.into()),
        }
    } else {
        (
            openat(directory, filename, existing_flags, Mode::empty()).map_err(io::Error::from)?,
            false,
        )
    };
    if created {
        fchmod(&file, Mode::RUSR | Mode::WUSR).map_err(io::Error::from)?;
    }
    let metadata = fstat(&file).map_err(io::Error::from)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a regular CAS file", display_path.display()),
        ));
    }
    Ok(file.into())
}

/// Verify that `display_path`, resolved from the filesystem root the way an
/// external consumer resolves it, still names the same file as `file`.
///
/// [`verify_retained_cas_file_identity`] resolves through the retained
/// directory descriptor, so it cannot see an ancestor of the CAS root being
/// swapped: the descriptor keeps pointing at the directory we validated no
/// matter what happens to the names above it. That is exactly what we want for
/// our own descriptors, but SQLite opens the database by path and creates its
/// journal and WAL sidecars by path, so path resolution is inside the trust
/// boundary whether we like it or not. `SQLITE_OPEN_NOFOLLOW` rejects a path
/// with a symlink component, which leaves the case it cannot see: a real
/// directory renamed into place above the root between canonicalization and
/// the open. Comparing the path-resolved file against the descriptor we hold
/// catches that — the two only agree when nothing was swapped underneath us.
#[cfg(unix)]
fn verify_path_resolved_cas_file_identity(file: &File, display_path: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt as _;

    let file_metadata = file.metadata()?;
    // `symlink_metadata` is an lstat, so a symlinked final component fails the
    // regular-file test rather than being followed.
    let path_metadata = fs::symlink_metadata(display_path)?;
    if !file_metadata.is_file()
        || !path_metadata.is_file()
        || file_metadata.dev() != path_metadata.dev()
        || file_metadata.ino() != path_metadata.ino()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} does not resolve to the file it was opened from",
                display_path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn verify_retained_cas_file_identity(
    directory: &OwnedFd,
    filename: &str,
    file: &File,
    display_path: &Path,
) -> io::Result<()> {
    use rustix::fs::{AtFlags, FileType, fstat, statat};

    let file_metadata = fstat(file).map_err(io::Error::from)?;
    let path_metadata =
        statat(directory, filename, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
    if FileType::from_raw_mode(file_metadata.st_mode) != FileType::RegularFile
        || FileType::from_raw_mode(path_metadata.st_mode) != FileType::RegularFile
        || file_metadata.st_dev != path_metadata.st_dev
        || file_metadata.st_ino != path_metadata.st_ino
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} changed identity after it was opened",
                display_path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_cas_database_copy(
    directory: &OwnedFd,
    database_file: &File,
    source_path: &Path,
) -> io::Result<(tempfile::TempDir, PathBuf)> {
    use rustix::fs::{FileType, Mode, OFlags, fstat, openat};
    use rustix::io::Errno;
    use std::os::unix::fs::OpenOptionsExt as _;

    fn copy_file(source: &File, destination: &mut File) -> io::Result<()> {
        let mut source = source.try_clone()?;
        source.seek(SeekFrom::Start(0))?;
        io::copy(&mut source, destination)?;
        destination.sync_all()
    }

    let private_directory = tempfile::tempdir()?;
    let private_path = fs::canonicalize(private_directory.path())?;
    let database_path = private_path.join("cas.db");
    let mut database_destination = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&database_path)?;
    copy_file(database_file, &mut database_destination)?;

    match openat(
        directory,
        "cas.db-wal",
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(wal) => {
            let metadata = fstat(&wal).map_err(io::Error::from)?;
            if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{}-wal is not a regular CAS file", source_path.display()),
                ));
            }
            let mut wal_destination = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(private_path.join("cas.db-wal"))?;
            copy_file(&File::from(wal), &mut wal_destination)?;
        }
        Err(Errno::NOENT) => {}
        Err(error) => return Err(error.into()),
    }
    Ok((private_directory, database_path))
}

#[cfg(windows)]
fn open_cas_root_directory(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let directory = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a non-reparse CAS directory", path.display()),
        ));
    }
    Ok(directory)
}

#[cfg(windows)]
fn open_or_create_regular_cas_file(
    _directory: &File,
    _filename: &str,
    display_path: &Path,
    create: bool,
) -> io::Result<File> {
    use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(display_path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is not a non-reparse regular CAS file",
                display_path.display()
            ),
        ));
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_or_create_regular_cas_file(display_path: &Path, create: bool) -> io::Result<File> {
    match fs::symlink_metadata(display_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "{} is not a non-symlink regular CAS file",
                    display_path.display()
                ),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .open(display_path)
}

/// `"sha256:<64 hex>"` → `<hex[..2]>/<hex>`, the store's two-level fan-out,
/// relative to a CAS root. `None` for a malformed hash.
pub(crate) fn blob_relative_path(hash: &str) -> Option<PathBuf> {
    let hex = ContentStore::validate_hash(hash).ok()?;
    Some(Path::new(&hex[..2]).join(hex))
}

/// Every blob file under `root`'s two-level fan-out, as `"sha256:<hex>"`
/// hashes (sorted). `root` need not exist; a missing or unreadable directory
/// yields an empty list.
pub(crate) fn list_blob_hashes(root: &Path) -> Vec<String> {
    fn is_lowercase_hex(name: &str, len: usize) -> bool {
        name.len() == len
            && name
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut prefixes: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|name| is_lowercase_hex(name, 2))
        .collect();
    prefixes.sort();

    let mut hashes = Vec::new();
    for prefix in prefixes.drain(..) {
        let Ok(files) = fs::read_dir(root.join(&prefix)) else {
            continue;
        };
        let mut names: Vec<String> = files
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|name| is_lowercase_hex(name, 64) && name.starts_with(&prefix))
            .collect();
        names.sort();
        hashes.extend(names.into_iter().map(|name| format!("sha256:{name}")));
    }
    hashes
}

impl ContentStore {
    /// Open or create a content store at the given root directory.
    pub fn open(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Self::open_with_root_policy(root, true)
    }

    pub(crate) fn open_existing(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Self::open_with_root_policy(root, false)
    }

    fn open_with_root_policy(
        root: &Path,
        create_root: bool,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if create_root {
            fs::create_dir_all(root)?;
        }
        let root = fs::canonicalize(root)?;
        #[cfg(test)]
        pause_at_test_path_barrier("root-resolved", &root);
        #[cfg(unix)]
        let root_directory = open_cas_root_directory(&root)?;
        #[cfg(windows)]
        let root_directory = open_cas_root_directory(&root)?;

        let lock_path = root.join(LOCK_FILE_NAME);
        #[cfg(any(unix, windows))]
        let lock_file = open_or_create_regular_cas_file(
            &root_directory,
            LOCK_FILE_NAME,
            &lock_path,
            create_root,
        )?;
        #[cfg(not(any(unix, windows)))]
        let lock_file = open_or_create_regular_cas_file(&lock_path, create_root)?;
        #[cfg(unix)]
        verify_retained_cas_file_identity(&root_directory, LOCK_FILE_NAME, &lock_file, &lock_path)?;
        let lock_held = Cell::new(false);
        let lock = ExclusiveLockGuard::acquire(&lock_file, &lock_held)?;

        #[cfg(unix)]
        verify_retained_cas_file_identity(&root_directory, LOCK_FILE_NAME, &lock_file, &lock_path)?;
        let database_path = root.join("cas.db");
        #[cfg(test)]
        pause_at_test_path_barrier("database-resolved", &database_path);
        #[cfg(any(unix, windows))]
        let database_file = open_or_create_regular_cas_file(
            &root_directory,
            "cas.db",
            &database_path,
            create_root,
        )?;
        #[cfg(not(any(unix, windows)))]
        let database_file = open_or_create_regular_cas_file(&database_path, create_root)?;
        #[cfg(unix)]
        let db = if create_root {
            // The connection must use the canonicalized path, not a
            // /proc/self/fd/<dirfd> alias: SQLite's xFullPathname resolves the
            // path itself and, under SQLITE_OPEN_NOFOLLOW, refuses any path
            // containing a symlink component (SQLITE_CANTOPEN_SYMLINK) — which
            // /proc/self/fd always is. A canonical path keeps NOFOLLOW
            // meaningful for the final component.
            let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
            let connection = Connection::open_with_flags(&database_path, flags)?;
            verify_path_resolved_cas_file_identity(&database_file, &database_path)?;
            Some(connection)
        } else {
            None
        };
        #[cfg(not(unix))]
        let db = {
            let access = if create_root {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            } else {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            };
            let flags = access
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
            Some(Connection::open_with_flags(&database_path, flags)?)
        };
        #[cfg(unix)]
        verify_retained_cas_file_identity(
            &root_directory,
            "cas.db",
            &database_file,
            &database_path,
        )?;
        if create_root {
            db.as_ref()
                .expect("a writable CAS open has a database connection")
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS blobs (
                        hash         TEXT PRIMARY KEY,
                        size         INTEGER NOT NULL,
                        content_type TEXT NOT NULL,
                        created_at   TEXT NOT NULL,
                        ref_count    INTEGER NOT NULL DEFAULT 1
                    );
                    CREATE TABLE IF NOT EXISTS rubbish_archive_releases (
                        item_id      TEXT PRIMARY KEY,
                        completed_at TEXT NOT NULL
                    );",
                )?;
        }
        drop(lock);
        Ok(Self {
            root,
            db,
            _database_file: database_file,
            lock_file,
            #[cfg(unix)]
            root_directory,
            #[cfg(windows)]
            root_directory,
            lock_held,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn database(&self) -> &Connection {
        self.db
            .as_ref()
            .expect("normal CAS operations require a live database connection")
    }

    fn verify_storage_identities(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            verify_retained_cas_file_identity(
                &self.root_directory,
                LOCK_FILE_NAME,
                &self.lock_file,
                &self.root.join(LOCK_FILE_NAME),
            )?;
            verify_retained_cas_file_identity(
                &self.root_directory,
                "cas.db",
                &self._database_file,
                &self.root.join("cas.db"),
            )?;
        }
        Ok(())
    }

    fn acquire_exclusive_lock(&self) -> io::Result<ExclusiveLockGuard<'_>> {
        let lock = ExclusiveLockGuard::acquire(&self.lock_file, &self.lock_held)?;
        if let Err(error) = self.verify_storage_identities() {
            drop(lock);
            return Err(error);
        }
        Ok(lock)
    }

    /// Compute the SHA-256 hash of data, returning "sha256:<hex>".
    pub fn hash_bytes(data: &[u8]) -> String {
        let digest = Sha256::digest(data);
        format!("sha256:{:x}", digest)
    }

    /// Validate that a hash has the expected format: "sha256:" followed by exactly
    /// 64 lowercase hex characters. Returns the hex portion on success.
    fn validate_hash(hash: &str) -> Result<&str, Box<dyn std::error::Error>> {
        let hex = hash
            .strip_prefix("sha256:")
            .ok_or("hash must start with 'sha256:'")?;
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(
                format!("invalid hash format: expected 64 hex chars, got '{}'", hex).into(),
            );
        }
        Ok(hex)
    }

    /// Resolve a validated hash to its filesystem path (two-level fan-out).
    fn blob_path(&self, hash: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        // Validate first so a malformed hash still gets `validate_hash`'s
        // error text, not `blob_relative_path`'s generic `None`.
        Self::validate_hash(hash)?;
        Ok(self
            .root
            .join(blob_relative_path(hash).expect("just validated")))
    }

    fn verified_backup_blob(
        canonical_root: &Path,
        #[cfg(unix)] root_directory: &OwnedFd,
        #[cfg(windows)] root_directory: &File,
        hash: String,
        stored_size: i64,
        verify_content: bool,
    ) -> Result<(BackupBlob, File), CasError> {
        let hex = Self::validate_hash(&hash).map_err(|error| CasError::InvalidHash {
            hash: hash.clone(),
            message: error.to_string(),
        })?;
        let expected_size = u64::try_from(stored_size).map_err(|_| CasError::InvalidSize {
            hash: hash.clone(),
            size: stored_size,
        })?;
        let relative_path = PathBuf::from(&hex[..2]).join(hex);
        let path = canonical_root.join(&relative_path);
        let prefix_path = path
            .parent()
            .expect("CAS blob path always has a fan-out directory");
        #[cfg(test)]
        pause_at_test_path_barrier("blob-ancestor-resolved", prefix_path);

        #[cfg(unix)]
        let mut file = {
            use rustix::fs::{FileType, Mode, OFlags, fstat, openat};

            let directory = openat(
                root_directory,
                &hex[..2],
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|error| CasError::BackingBlob {
                hash: hash.clone(),
                message: error.to_string(),
            })?;
            let metadata = fstat(&directory).map_err(|error| CasError::BackingBlob {
                hash: hash.clone(),
                message: error.to_string(),
            })?;
            if FileType::from_raw_mode(metadata.st_mode) != FileType::Directory {
                return Err(CasError::BackingBlob {
                    hash,
                    message: format!("{} is not a regular directory", prefix_path.display()),
                });
            }
            let file = openat(
                &directory,
                hex,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|error| CasError::BackingBlob {
                hash: hash.clone(),
                message: error.to_string(),
            })?;
            File::from(file)
        };

        #[cfg(windows)]
        let mut file = {
            use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
            };

            let _retained_root_identity = root_directory;
            let directory = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(prefix_path)
                .map_err(|error| CasError::BackingBlob {
                    hash: hash.clone(),
                    message: error.to_string(),
                })?;
            let directory_metadata =
                directory
                    .metadata()
                    .map_err(|error| CasError::BackingBlob {
                        hash: hash.clone(),
                        message: error.to_string(),
                    })?;
            if !directory_metadata.is_dir()
                || directory_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(CasError::BackingBlob {
                    hash,
                    message: format!("{} is not a non-reparse directory", prefix_path.display()),
                });
            }
            let file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
                .map_err(|error| CasError::BackingBlob {
                    hash: hash.clone(),
                    message: error.to_string(),
                })?;
            let metadata = file.metadata().map_err(|error| CasError::BackingBlob {
                hash: hash.clone(),
                message: error.to_string(),
            })?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(CasError::BackingBlob {
                    hash,
                    message: format!("{} is a reparse point", path.display()),
                });
            }
            file
        };

        #[cfg(not(any(unix, windows)))]
        let mut file = {
            let path_metadata =
                fs::symlink_metadata(&path).map_err(|error| CasError::BackingBlob {
                    hash: hash.clone(),
                    message: error.to_string(),
                })?;
            if !path_metadata.file_type().is_file() {
                return Err(CasError::BackingBlob {
                    hash,
                    message: format!("{} is not a regular file", path.display()),
                });
            }
            let canonical_path =
                fs::canonicalize(&path).map_err(|error| CasError::BackingBlob {
                    hash: hash.clone(),
                    message: error.to_string(),
                })?;
            if !canonical_path.starts_with(canonical_root) {
                return Err(CasError::BackingBlob {
                    hash,
                    message: format!("{} escapes the CAS root", path.display()),
                });
            }
            File::open(&canonical_path).map_err(|error| CasError::BackingBlob {
                hash: hash.clone(),
                message: error.to_string(),
            })?
        };

        let file_metadata = file.metadata().map_err(|error| CasError::BackingBlob {
            hash: hash.clone(),
            message: error.to_string(),
        })?;
        if !file_metadata.is_file() {
            return Err(CasError::BackingBlob {
                hash,
                message: format!("{} is not a regular file", path.display()),
            });
        }
        if file_metadata.len() != expected_size {
            return Err(CasError::BackingBlob {
                hash,
                message: format!(
                    "size mismatch: expected {expected_size}, got {}",
                    file_metadata.len()
                ),
            });
        }

        if verify_content {
            let mut digest = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|error| CasError::BackingBlob {
                        hash: hash.clone(),
                        message: error.to_string(),
                    })?;
                if read == 0 {
                    break;
                }
                digest.update(&buffer[..read]);
            }
            let actual_hash = format!("sha256:{:x}", digest.finalize());
            if actual_hash != hash {
                return Err(CasError::BackingBlob {
                    hash,
                    message: format!("content hash mismatch: got {actual_hash}"),
                });
            }
            #[cfg(test)]
            {
                *BACKUP_BLOB_VERIFICATION_PASSES
                    .lock()
                    .entry(hash.clone())
                    .or_default() += 1;
            }
            file.seek(SeekFrom::Start(0))
                .map_err(|error| CasError::BackingBlob {
                    hash: hash.clone(),
                    message: error.to_string(),
                })?;
        }

        Ok((
            BackupBlob {
                hash,
                relative_path,
                size: expected_size,
            },
            file,
        ))
    }

    /// Create a consistent backup snapshot and hold the CAS mutation lock until
    /// the returned guard is dropped.
    pub fn backup_snapshot(&self) -> Result<BackupSnapshot<'_>, Box<dyn std::error::Error>> {
        let lock = self.acquire_exclusive_lock()?;
        #[cfg(unix)]
        let (_working_directory, working_database_path) = create_private_cas_database_copy(
            &self.root_directory,
            &self._database_file,
            &self.root.join("cas.db"),
        )?;
        #[cfg(all(test, target_vendor = "apple"))]
        pause_at_test_path_barrier("before-backup-database-open", &self.root.join("cas.db"));
        #[cfg(unix)]
        let source_database = Connection::open_with_flags(
            &working_database_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        #[cfg(unix)]
        let source_database = &source_database;
        #[cfg(not(unix))]
        let source_database = self.database();

        let database = tempfile::NamedTempFile::new()?;
        let mut snapshot_db = Connection::open(database.path())?;
        {
            let backup = Backup::new(source_database, &mut snapshot_db)?;
            backup.run_to_completion(128, std::time::Duration::from_millis(1), None)?;
        }

        let rows = {
            let mut statement =
                snapshot_db.prepare("SELECT hash, size FROM blobs ORDER BY hash")?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        drop(snapshot_db);

        let mut blobs = Vec::with_capacity(rows.len());
        for (hash, size) in rows {
            let (blob, file) = Self::verified_backup_blob(
                &self.root,
                #[cfg(unix)]
                &self.root_directory,
                #[cfg(windows)]
                &self.root_directory,
                hash,
                size,
                true,
            )?;
            drop(file);
            blobs.push(blob);
        }

        Ok(BackupSnapshot {
            database,
            blobs,
            canonical_root: self.root.clone(),
            #[cfg(unix)]
            root_directory: &self.root_directory,
            #[cfg(windows)]
            root_directory: &self.root_directory,
            #[cfg(test)]
            membership_comparisons: Cell::new(0),
            _lock: lock,
        })
    }

    fn rubbish_release_completed(db: &Connection, item_id: &str) -> Result<bool, rusqlite::Error> {
        db.query_row(
            "SELECT 1 FROM rubbish_archive_releases WHERE item_id = ?1",
            params![item_id],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
    }

    /// Return whether this rubbish item's captured-archive references have
    /// already been durably released for permanent deletion.
    pub fn rubbish_archive_refs_released(&self, item_id: Uuid) -> Result<bool, CasError> {
        Self::rubbish_release_completed(self.database(), &item_id.to_string()).map_err(Into::into)
    }

    fn prevalidate_rubbish_archive_ref(&self, hash: &str) -> Result<(), CasError> {
        let hex = Self::validate_hash(hash).map_err(|error| CasError::InvalidHash {
            hash: hash.to_string(),
            message: error.to_string(),
        })?;
        let row: Option<(i64, i64)> = self
            .database()
            .query_row(
                "SELECT size, ref_count FROM blobs WHERE hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (stored_size, ref_count) =
            row.ok_or_else(|| CasError::MissingBlob(hash.to_string()))?;
        let expected_size = u64::try_from(stored_size).map_err(|_| CasError::InvalidSize {
            hash: hash.to_string(),
            size: stored_size,
        })?;
        if ref_count <= 0 {
            return Err(CasError::NoReference {
                hash: hash.to_string(),
                ref_count,
            });
        }

        let path = self.root.join(&hex[..2]).join(hex);
        let metadata = fs::metadata(&path).map_err(|error| CasError::BackingBlob {
            hash: hash.to_string(),
            message: error.to_string(),
        })?;
        if !metadata.is_file() {
            return Err(CasError::BackingBlob {
                hash: hash.to_string(),
                message: format!("{} is not a file", path.display()),
            });
        }
        if metadata.len() != expected_size {
            return Err(CasError::BackingBlob {
                hash: hash.to_string(),
                message: format!(
                    "size mismatch: expected {expected_size}, got {}",
                    metadata.len()
                ),
            });
        }
        Ok(())
    }

    /// Atomically release the captured-archive references owned by one rubbish
    /// item. A completed item ID is durable and makes every later retry a no-op.
    pub fn release_rubbish_archive_refs(
        &mut self,
        item_id: Uuid,
        hashes: &BTreeSet<String>,
    ) -> Result<ReleaseOutcome, CasError> {
        let _lock = ExclusiveLockGuard::acquire(&self.lock_file, &self.lock_held)?;
        if let Err(error) = self.verify_storage_identities() {
            drop(_lock);
            return Err(error.into());
        }
        let item_id = item_id.to_string();
        if Self::rubbish_release_completed(self.database(), &item_id)? {
            return Ok(ReleaseOutcome::AlreadyCompleted);
        }

        for hash in hashes {
            self.prevalidate_rubbish_archive_ref(hash)?;
        }

        let transaction = self
            .db
            .as_mut()
            .expect("normal CAS operations require a live database connection")
            .transaction()?;
        if Self::rubbish_release_completed(&transaction, &item_id)? {
            return Ok(ReleaseOutcome::AlreadyCompleted);
        }
        for hash in hashes {
            let changed = transaction.execute(
                "UPDATE blobs
                 SET ref_count = ref_count - 1
                 WHERE hash = ?1 AND ref_count > 0",
                params![hash],
            )?;
            if changed != 1 {
                return Err(CasError::ReferenceChanged(hash.clone()));
            }
        }
        transaction.execute(
            "INSERT INTO rubbish_archive_releases (item_id, completed_at)
             VALUES (?1, ?2)",
            params![item_id, chrono::Utc::now().to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(ReleaseOutcome::Released)
    }

    /// Store a blob. Returns the hash and whether it already existed.
    /// If it already exists, increments ref_count instead of writing again.
    pub fn store(
        &self,
        data: &[u8],
        content_type: &str,
    ) -> Result<StoreResult, Box<dyn std::error::Error>> {
        let _lock = self.acquire_exclusive_lock()?;
        let hash = Self::hash_bytes(data);
        let now = chrono::Utc::now().to_rfc3339();

        // Use a transaction to ensure database consistency
        // Note: we don't use a full transaction here because we also interact with the filesystem.
        // Instead, we use the primary key constraint to detect existence.

        let res = self.database().execute(
            "INSERT OR IGNORE INTO blobs (hash, size, content_type, created_at, ref_count) VALUES (?1, ?2, ?3, ?4, 1)",
            params![hash, data.len() as i64, content_type, now],
        )?;

        if res == 0 {
            // Already existed in DB, just increment ref count
            self.database().execute(
                "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1",
                params![hash],
            )?;
            Ok(StoreResult {
                hash,
                already_existed: true,
            })
        } else {
            // New blob, write to filesystem
            let path = self.blob_path(&hash)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            if let Err(e) = fs::write(&path, data) {
                // Roll back DB insert if filesystem write fails
                self.database()
                    .execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
                return Err(e.into());
            }

            Ok(StoreResult {
                hash,
                already_existed: false,
            })
        }
    }

    /// Retrieve a blob's data and content type.
    pub fn retrieve(&self, hash: &str) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let content_type: String = self.database().query_row(
            "SELECT content_type FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        let path = self.blob_path(hash)?;
        let data = fs::read(&path)?;
        Ok((data, content_type))
    }

    /// Validate metadata and acquire an open backing-file handle without reading
    /// bytes. Callers may release the CAS lock before `OpenBlob::read_limited`;
    /// unlinking cannot invalidate an already-open handle.
    pub fn open_limited(&self, hash: &str, limit: usize) -> Result<OpenBlob, RetrieveLimitedError> {
        self.open_limited_with(hash, limit, |path| File::open(path))
    }

    fn open_limited_with(
        &self,
        hash: &str,
        limit: usize,
        open: impl FnOnce(&Path) -> std::io::Result<File>,
    ) -> Result<OpenBlob, RetrieveLimitedError> {
        Self::validate_hash(hash)
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let (stored_size, content_type): (i64, String) = self
            .database()
            .query_row(
                "SELECT size, content_type FROM blobs WHERE hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let expected_size = u64::try_from(stored_size).map_err(|_| {
            RetrieveLimitedError::Store(format!(
                "invalid negative CAS size for {hash}: {stored_size}"
            ))
        })?;
        if expected_size > limit as u64 {
            return Err(RetrieveLimitedError::TooLarge {
                size: expected_size,
                limit,
            });
        }
        let path = self
            .blob_path(hash)
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let file = open(&path).map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        let file_metadata = file
            .metadata()
            .map_err(|error| RetrieveLimitedError::Store(error.to_string()))?;
        if !file_metadata.is_file() {
            return Err(RetrieveLimitedError::Store(format!(
                "CAS backing path is not a file: {}",
                path.display()
            )));
        }
        if file_metadata.len() != expected_size {
            return Err(RetrieveLimitedError::Store(format!(
                "CAS backing file size mismatch for {hash}: expected {expected_size}, got {}",
                file_metadata.len()
            )));
        }
        Ok(OpenBlob {
            file,
            content_type,
            expected_size,
        })
    }

    pub fn retrieve_limited(
        &self,
        hash: &str,
        limit: usize,
    ) -> Result<(Vec<u8>, String), RetrieveLimitedError> {
        self.open_limited(hash, limit)?.read_limited(limit)
    }

    /// Inspect a blob without reading its contents.
    ///
    /// A row alone is not enough: callers use this for metadata-only HTTP
    /// responses, so a missing, non-file, or length-mismatched backing object is
    /// reported as corruption rather than as an available blob.
    pub fn inspect(&self, hash: &str) -> Result<BlobMetadata, Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let (stored_size, content_type): (i64, String) = self.database().query_row(
            "SELECT size, content_type FROM blobs WHERE hash = ?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let expected_size = u64::try_from(stored_size)
            .map_err(|_| format!("invalid negative CAS size for {hash}: {stored_size}"))?;
        let path = self.blob_path(hash)?;
        let file = fs::metadata(&path)?;
        if !file.is_file() {
            return Err(format!("CAS backing path is not a file: {}", path.display()).into());
        }
        if file.len() != expected_size {
            return Err(format!(
                "CAS backing file size mismatch for {hash}: expected {expected_size}, got {}",
                file.len()
            )
            .into());
        }
        Ok(BlobMetadata {
            content_type,
            size: expected_size,
        })
    }

    /// Check whether a blob exists in the store.
    pub fn exists(&self, hash: &str) -> Result<bool, Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let count: i64 = self.database().query_row(
            "SELECT COUNT(*) FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Increment the reference count for a blob.
    pub fn increment_ref(&self, hash: &str) -> Result<(), Box<dyn std::error::Error>> {
        let _lock = self.acquire_exclusive_lock()?;
        Self::validate_hash(hash)?;
        self.database().execute(
            "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1",
            params![hash],
        )?;
        Ok(())
    }

    /// Decrement the reference count for a blob.
    pub fn decrement_ref(&self, hash: &str) -> Result<(), Box<dyn std::error::Error>> {
        let _lock = self.acquire_exclusive_lock()?;
        Self::validate_hash(hash)?;
        self.database().execute(
            "UPDATE blobs SET ref_count = ref_count - 1 WHERE hash = ?1",
            params![hash],
        )?;
        Ok(())
    }

    /// Remove blobs with ref_count <= 0 that are older than `min_age`.
    /// Returns the number of blobs pruned.
    pub fn gc(&self, min_age: std::time::Duration) -> Result<u32, Box<dyn std::error::Error>> {
        let _lock = self.acquire_exclusive_lock()?;
        let cutoff = (chrono::Utc::now() - chrono::Duration::from_std(min_age)?).to_rfc3339();
        let mut stmt = self
            .database()
            .prepare("SELECT hash FROM blobs WHERE ref_count <= 0 AND created_at < ?1")?;
        let hashes: Vec<String> = stmt
            .query_map(params![cutoff], |row| row.get(0))?
            .collect::<Result<_, _>>()?;

        let mut pruned = 0u32;
        for hash in &hashes {
            let path = self.blob_path(hash)?;
            if path.exists() {
                fs::remove_file(&path)?;
            }
            self.database()
                .execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
            pruned += 1;
        }
        Ok(pruned)
    }

    /// Return the current ref_count for a blob (for testing).
    #[cfg(test)]
    pub(crate) fn ref_count(&self, hash: &str) -> Result<i64, Box<dyn std::error::Error>> {
        Self::validate_hash(hash)?;
        let count: i64 = self.database().query_row(
            "SELECT ref_count FROM blobs WHERE hash = ?1",
            params![hash],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// List every blob file on disk (two-level hex fan-out directories under
    /// `self.root`), sorted by hash, as `(hash, size)`. Ignores anything at
    /// `self.root` that isn't a fan-out directory (`cas.db`, its
    /// journal/WAL/SHM siblings, `cas.lock`) and anything inside a fan-out
    /// directory that isn't a blob file (stray dotfiles, wrong-prefix names).
    fn scan_blob_files(&self) -> io::Result<Vec<(String, u64)>> {
        fn is_lowercase_hex(name: &str, len: usize) -> bool {
            name.len() == len
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }

        let mut prefixes: Vec<String> = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if is_lowercase_hex(&name, 2) {
                prefixes.push(name);
            }
        }
        prefixes.sort();

        let mut found = Vec::new();
        for prefix in prefixes {
            let mut names: Vec<(String, u64)> = Vec::new();
            for entry in fs::read_dir(self.root.join(&prefix))? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if is_lowercase_hex(&name, 64) && name.starts_with(&prefix) {
                    names.push((name, entry.metadata()?.len()));
                }
            }
            names.sort();
            found.extend(
                names
                    .into_iter()
                    .map(|(name, size)| (format!("sha256:{name}"), size)),
            );
        }
        Ok(found)
    }

    /// Recreate every `blobs` row from files on disk plus a vault-wide
    /// reference/type scan, discarding whatever the database currently
    /// claims. Used to repair `cas.db` after it's lost, corrupted, or absent
    /// on a freshly synced device (ADR 0005: `cas.db` is derived, not source
    /// of truth).
    ///
    /// `write` applies the rebuild; a dry run only computes the report.
    pub fn rebuild_metadata(
        &self,
        scan: &ArchiveRefScan,
        write: bool,
    ) -> Result<RebuildReport, Box<dyn std::error::Error>> {
        let _lock = self.acquire_exclusive_lock()?;
        let blob_files = self.scan_blob_files()?;

        let mut seen_hashes = BTreeSet::new();
        let mut untyped_blobs = Vec::new();
        let mut unreferenced_blobs = 0u64;
        let mut rows: Vec<(String, u64, String, u32)> = Vec::with_capacity(blob_files.len());

        for (hash, size) in blob_files {
            let content_type = match scan.types.get(&hash) {
                Some(content_type) => content_type.clone(),
                None => {
                    untyped_blobs.push(hash.clone());
                    "application/octet-stream".to_string()
                }
            };
            let ref_count = scan.refs.get(&hash).copied().unwrap_or(0);
            if ref_count == 0 {
                unreferenced_blobs += 1;
            }
            seen_hashes.insert(hash.clone());
            rows.push((hash, size, content_type, ref_count));
        }

        let missing_files: Vec<String> = scan
            .refs
            .keys()
            .filter(|hash| !seen_hashes.contains(hash.as_str()))
            .cloned()
            .collect();
        let rows_written = rows.len() as u64;

        if write {
            // `created_at` resets to now for every rebuilt row. `gc()` only
            // deletes rows with ref_count 0 that are older than its min_age,
            // so stamping "now" just delays GC eligibility for these rows —
            // the safe direction, since a later GC is never wrong, but an
            // early one could delete a blob a page still points at (spec §7).
            let now = chrono::Utc::now().to_rfc3339();
            let transaction = self.database().unchecked_transaction()?;
            transaction.execute("DELETE FROM blobs", [])?;
            // The recount above already treats every rubbish item still
            // present on disk as holding a reference — including one whose
            // release was already recorded in `rubbish_archive_releases`
            // before this rebuild ran. If that ledger row survived the
            // rebuild, the item's eventual purge would see itself as already
            // completed and skip decrementing, permanently leaking the ref
            // the recount just added back. Clearing the ledger here forces
            // every present rubbish item to decrement exactly once on its
            // next purge, matching the recount (spec §7; over-count-safe:
            // the failure mode this guards against is under-counting, and
            // `ref_count > 0` in that UPDATE already blocks a double
            // decrement in the other direction).
            transaction.execute("DELETE FROM rubbish_archive_releases", [])?;
            for (hash, size, content_type, ref_count) in &rows {
                transaction.execute(
                    "INSERT INTO blobs (hash, size, content_type, created_at, ref_count) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![hash, *size as i64, content_type, now, *ref_count as i64],
                )?;
            }
            transaction.commit()?;
        }

        Ok(RebuildReport {
            rows_written,
            unreferenced_blobs,
            untyped_blobs,
            missing_files,
            dry_run: !write,
        })
    }

    /// Return summary stats for the store.
    pub fn stats(&self) -> Result<CasStats, Box<dyn std::error::Error>> {
        let blob_count: i64 =
            self.database()
                .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))?;
        let total_size: i64 =
            self.database()
                .query_row("SELECT COALESCE(SUM(size), 0) FROM blobs", [], |row| {
                    row.get(0)
                })?;
        Ok(CasStats {
            blob_count: blob_count as u64,
            total_size_bytes: total_size as u64,
        })
    }
}

pub struct CasStats {
    pub blob_count: u64,
    pub total_size_bytes: u64,
}

/// Outcome of a `rebuild_metadata` sweep (or dry run).
#[derive(Debug, Default)]
pub struct RebuildReport {
    pub rows_written: u64,
    /// Blob files written with ref_count 0 — not referenced by any live page
    /// or rubbish item, so GC-eligible once old enough.
    pub unreferenced_blobs: u64,
    /// Blob hashes with no type in the scan; fell back to
    /// `application/octet-stream`.
    pub untyped_blobs: Vec<String>,
    /// Hashes the scan referenced with no corresponding blob file on disk.
    pub missing_files: Vec<String>,
    pub dry_run: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use tempfile::TempDir;
    use uuid::Uuid;

    fn test_store() -> (ContentStore, TempDir) {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        (store, tmp)
    }

    fn rubbish_cleanup_hashes(hashes: impl IntoIterator<Item = String>) -> BTreeSet<String> {
        hashes.into_iter().collect()
    }

    fn simulate_rubbish_purge(
        store: &mut ContentStore,
        item_id: Uuid,
        hashes: &BTreeSet<String>,
        remove_item: impl FnOnce() -> std::io::Result<()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        store.release_rubbish_archive_refs(item_id, hashes)?;
        remove_item()?;
        Ok(())
    }

    #[test]
    fn blob_relative_path_fans_out_by_two_hex_chars() {
        let hash = ContentStore::hash_bytes(b"abc");
        let hex = hash.strip_prefix("sha256:").unwrap();
        assert_eq!(
            blob_relative_path(&hash).unwrap(),
            Path::new(&hex[..2]).join(hex)
        );
        assert!(blob_relative_path("md5:00").is_none());
        assert!(blob_relative_path("sha256:zz").is_none());
    }

    #[test]
    fn store_and_retrieve_blob() {
        let (store, _tmp) = test_store();
        let data = b"hello world";
        let result = store.store(data, "text/plain").unwrap();
        assert!(result.hash.starts_with("sha256:"));
        assert!(!result.already_existed);

        let (retrieved, content_type) = store.retrieve(&result.hash).unwrap();
        assert_eq!(retrieved, data);
        assert_eq!(content_type, "text/plain");
    }

    #[test]
    fn inspect_reports_metadata_without_returning_blob_bytes() {
        let (store, _tmp) = test_store();
        let result = store.store(b"metadata only", "text/html").unwrap();

        let metadata = store.inspect(&result.hash).unwrap();

        assert_eq!(metadata.content_type, "text/html");
        assert_eq!(metadata.size, 13);
    }

    #[test]
    fn inspect_rejects_a_missing_or_invalid_backing_file() {
        let (store, _tmp) = test_store();
        let missing = store.store(b"delete me", "text/html").unwrap();
        fs::remove_file(store.blob_path(&missing.hash).unwrap()).unwrap();
        assert!(
            store.inspect(&missing.hash).is_err(),
            "database metadata must not hide a missing backing file"
        );

        let truncated = store.store(b"truncate me", "text/html").unwrap();
        fs::write(store.blob_path(&truncated.hash).unwrap(), b"short").unwrap();
        assert!(
            store.inspect(&truncated.hash).is_err(),
            "backing-file length must agree with CAS metadata"
        );
    }

    #[test]
    fn retrieve_limited_rejects_known_oversize_before_opening_backing_file() {
        use std::cell::Cell;

        let (store, _tmp) = test_store();
        let result = store.store(b"larger than limit", "text/html").unwrap();
        let opens = Cell::new(0);
        let error = store
            .open_limited_with(&result.hash, 4, |path| {
                opens.set(opens.get() + 1);
                std::fs::File::open(path)
            })
            .unwrap_err();

        assert_eq!(opens.get(), 0, "oversize blob backing file was opened");
        assert!(matches!(
            error,
            RetrieveLimitedError::TooLarge { size: 17, limit: 4 }
        ));
    }

    #[test]
    fn retrieve_limited_accepts_a_blob_exactly_at_the_limit() {
        let (store, _tmp) = test_store();
        let result = store.store(b"exact", "text/html").unwrap();

        let (data, content_type) = store.retrieve_limited(&result.hash, 5).unwrap();

        assert_eq!(data, b"exact");
        assert_eq!(content_type, "text/html");
    }

    #[test]
    fn invalid_hash_returns_error() {
        let (store, _tmp) = test_store();
        // Path traversal attempt
        assert!(store.retrieve("sha256:../../etc/passwd").is_err());
        // Too short
        assert!(store.retrieve("sha256:ab").is_err());
        // Non-hex characters
        assert!(
            store
                .retrieve("sha256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
                .is_err()
        );
        // Missing prefix
        assert!(store.retrieve("abcdef").is_err());
        // Valid format but doesn't exist — different error (not found, not validation)
        assert!(
            store
                .retrieve("sha256:0000000000000000000000000000000000000000000000000000000000000000")
                .is_err()
        );
    }

    #[test]
    fn storing_same_blob_twice_deduplicates() {
        let (store, _tmp) = test_store();
        let data = b"duplicate content";
        let r1 = store.store(data, "text/plain").unwrap();
        let r2 = store.store(data, "text/plain").unwrap();

        assert_eq!(r1.hash, r2.hash);
        assert!(!r1.already_existed);
        assert!(r2.already_existed);
    }

    #[test]
    fn ref_count_increments_on_duplicate_store() {
        let (store, _tmp) = test_store();
        let data = b"ref counted";
        let r = store.store(data, "text/plain").unwrap();
        store.store(data, "text/plain").unwrap();

        let count = store.ref_count(&r.hash).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn decrement_ref_and_gc() {
        let (store, _tmp) = test_store();
        let data = b"ephemeral";
        let result = store.store(data, "text/plain").unwrap();

        store.decrement_ref(&result.hash).unwrap();
        let pruned = store.gc(std::time::Duration::ZERO).unwrap();
        assert_eq!(pruned, 1);
        assert!(!store.exists(&result.hash).unwrap());
    }

    #[test]
    fn gc_respects_min_age() {
        let (store, _tmp) = test_store();
        let data = b"young blob";
        let result = store.store(data, "text/plain").unwrap();

        store.decrement_ref(&result.hash).unwrap();
        // min_age of 1 hour — blob was just created, should not be pruned
        let pruned = store.gc(std::time::Duration::from_secs(3600)).unwrap();
        assert_eq!(pruned, 0);
        assert!(store.exists(&result.hash).unwrap());
    }

    #[test]
    fn retrieve_nonexistent_returns_error() {
        let (store, _tmp) = test_store();
        let result = store
            .retrieve("sha256:0000000000000000000000000000000000000000000000000000000000000000");
        assert!(result.is_err());
    }

    #[test]
    fn stats_reflect_stored_blobs() {
        let (store, _tmp) = test_store();
        store.store(b"blob1", "text/plain").unwrap();
        store.store(b"blob2", "image/png").unwrap();
        store.store(b"blob1", "text/plain").unwrap(); // dedup

        let stats = store.stats().unwrap();
        assert_eq!(stats.blob_count, 2);
        assert_eq!(stats.total_size_bytes, 10); // 5 + 5
    }

    #[test]
    fn rubbish_cleanup_open_creates_an_item_keyed_completion_ledger() {
        let (store, _tmp) = test_store();
        let columns = store
            .database()
            .prepare("PRAGMA table_info(rubbish_archive_releases)")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            columns
                .iter()
                .any(|(name, primary_key)| name == "item_id" && *primary_key == 1),
            "cleanup completion must be keyed by opaque rubbish item ID"
        );
    }

    #[test]
    fn rubbish_cleanup_releases_unique_valid_refs_and_records_completion() {
        let (mut store, _tmp) = test_store();
        let first = store.store(b"first captured blob", "image/png").unwrap();
        let second = store.store(b"second captured blob", "text/html").unwrap();
        store.store(b"first captured blob", "image/png").unwrap();
        store.store(b"second captured blob", "text/html").unwrap();
        let item_id = Uuid::now_v7();
        let hashes = rubbish_cleanup_hashes([first.hash.clone(), second.hash.clone()]);

        let outcome = store
            .release_rubbish_archive_refs(item_id, &hashes)
            .unwrap();

        assert_eq!(outcome, ReleaseOutcome::Released);
        assert_eq!(store.ref_count(&first.hash).unwrap(), 1);
        assert_eq!(store.ref_count(&second.hash).unwrap(), 1);
        let recorded: String = store
            .database()
            .query_row(
                "SELECT item_id FROM rubbish_archive_releases WHERE item_id = ?1",
                params![item_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recorded, item_id.to_string());
    }

    #[test]
    fn rubbish_cleanup_prevalidates_invalid_and_missing_refs_before_any_decrement() {
        let (mut store, _tmp) = test_store();
        let valid = store.store(b"still referenced", "image/png").unwrap();
        store.store(b"still referenced", "image/png").unwrap();
        let item_id = Uuid::now_v7();
        let invalid_hashes =
            rubbish_cleanup_hashes([valid.hash.clone(), "zz-not-a-cas-hash".to_string()]);

        assert!(
            store
                .release_rubbish_archive_refs(item_id, &invalid_hashes)
                .is_err()
        );
        assert_eq!(store.ref_count(&valid.hash).unwrap(), 2);

        let missing_hash = ContentStore::hash_bytes(b"missing database row");
        let missing_hashes = rubbish_cleanup_hashes([valid.hash.clone(), missing_hash]);
        assert!(
            store
                .release_rubbish_archive_refs(item_id, &missing_hashes)
                .is_err()
        );
        assert_eq!(store.ref_count(&valid.hash).unwrap(), 2);
        assert_eq!(
            store
                .database()
                .query_row(
                    "SELECT COUNT(*) FROM rubbish_archive_releases WHERE item_id = ?1",
                    params![item_id.to_string()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn rubbish_cleanup_prevalidates_all_backing_files_before_any_decrement() {
        let (mut store, _tmp) = test_store();
        let valid = store.store(b"valid backing file", "image/png").unwrap();
        store.store(b"valid backing file", "image/png").unwrap();
        let missing_backing = store.store(b"missing backing file", "image/png").unwrap();
        fs::remove_file(store.blob_path(&missing_backing.hash).unwrap()).unwrap();
        let hashes = rubbish_cleanup_hashes([valid.hash.clone(), missing_backing.hash.clone()]);

        assert!(
            store
                .release_rubbish_archive_refs(Uuid::now_v7(), &hashes)
                .is_err()
        );
        assert_eq!(store.ref_count(&valid.hash).unwrap(), 2);
        assert_eq!(store.ref_count(&missing_backing.hash).unwrap(), 1);
    }

    #[test]
    fn rubbish_cleanup_rolls_back_decrements_when_completion_insert_fails() {
        let (mut store, _tmp) = test_store();
        let blob = store.store(b"transactional blob", "image/png").unwrap();
        store.store(b"transactional blob", "image/png").unwrap();
        store
            .database()
            .execute_batch(
                "CREATE TRIGGER fail_rubbish_cleanup_completion
                 BEFORE INSERT ON rubbish_archive_releases
                 BEGIN
                     SELECT RAISE(ABORT, 'simulated completion failure');
                 END;",
            )
            .unwrap();

        let result = store.release_rubbish_archive_refs(
            Uuid::now_v7(),
            &rubbish_cleanup_hashes([blob.hash.clone()]),
        );

        assert!(result.is_err());
        assert_eq!(
            store.ref_count(&blob.hash).unwrap(),
            2,
            "decrement must roll back with the failed completion insert"
        );
    }

    #[test]
    fn rubbish_cleanup_completed_retry_is_a_no_op_even_if_backing_file_is_gone() {
        let (mut store, _tmp) = test_store();
        let blob = store.store(b"retry blob", "image/png").unwrap();
        store.store(b"retry blob", "image/png").unwrap();
        let item_id = Uuid::now_v7();
        let hashes = rubbish_cleanup_hashes([blob.hash.clone()]);
        assert_eq!(
            store
                .release_rubbish_archive_refs(item_id, &hashes)
                .unwrap(),
            ReleaseOutcome::Released
        );
        fs::remove_file(store.blob_path(&blob.hash).unwrap()).unwrap();

        let retry = store
            .release_rubbish_archive_refs(item_id, &hashes)
            .unwrap();

        assert_eq!(retry, ReleaseOutcome::AlreadyCompleted);
        assert_eq!(store.ref_count(&blob.hash).unwrap(), 1);
    }

    #[test]
    fn rubbish_cleanup_retry_after_item_removal_failure_decrements_exactly_once() {
        let (mut store, _tmp) = test_store();
        let blob = store.store(b"durable cleanup blob", "image/png").unwrap();
        store.store(b"durable cleanup blob", "image/png").unwrap();
        let item_id = Uuid::now_v7();
        let hashes = rubbish_cleanup_hashes([blob.hash.clone()]);

        let first_attempt = simulate_rubbish_purge(&mut store, item_id, &hashes, || {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "simulated rubbish item removal failure",
            ))
        });
        assert!(first_attempt.is_err());
        assert_eq!(store.ref_count(&blob.hash).unwrap(), 1);

        simulate_rubbish_purge(&mut store, item_id, &hashes, || Ok(())).unwrap();
        assert_eq!(
            store.ref_count(&blob.hash).unwrap(),
            1,
            "retry after item-removal failure must not release CAS refs twice"
        );
    }
    #[test]
    fn backup_snapshot_sees_committed_wal_state() {
        let (store, tmp) = test_store();
        store
            .database()
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        store
            .database()
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        let stored = store.store(b"committed in the wal", "text/plain").unwrap();
        assert!(tmp.path().join("cas.db-wal").exists());

        let snapshot = store.backup_snapshot().unwrap();
        let snapshot_db = Connection::open(snapshot.database_path()).unwrap();
        let rows = snapshot_db
            .query_row(
                "SELECT hash, size FROM blobs WHERE hash = ?1",
                params![stored.hash],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();

        assert_eq!(rows, (stored.hash.clone(), 20));
        assert_eq!(snapshot.blobs().len(), 1);
        assert_eq!(snapshot.blobs()[0].hash(), stored.hash);
        assert_eq!(snapshot.blobs()[0].size(), 20);
        let mut bytes = Vec::new();
        snapshot
            .with_blob_file(&snapshot.blobs()[0], |file| {
                file.read_to_end(&mut bytes).map(|_| ())
            })
            .unwrap();
        assert_eq!(bytes, b"committed in the wal");
    }

    #[test]
    fn backup_snapshot_blocks_mutation_until_guard_drop() {
        let (store, tmp) = test_store();
        let stored = store.store(b"locked blob", "text/plain").unwrap();
        let other_store = ContentStore::open(tmp.path()).unwrap();
        let snapshot = store.backup_snapshot().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let hash = stored.hash.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            other_store.increment_ref(&hash).unwrap();
            finished_tx.send(()).unwrap();
        });

        started_rx.recv().unwrap();
        assert!(
            finished_rx
                .recv_timeout(std::time::Duration::from_millis(150))
                .is_err(),
            "mutation completed while the snapshot guard held the lock"
        );
        drop(snapshot);
        finished_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        worker.join().unwrap();
        assert_eq!(store.ref_count(&stored.hash).unwrap(), 2);
    }

    #[test]
    fn retrieval_remains_usable_during_backup_snapshot() {
        let (store, _tmp) = test_store();
        let stored = store
            .store(b"read while snapshotted", "text/plain")
            .unwrap();
        let snapshot = store.backup_snapshot().unwrap();

        let retrieved = store.retrieve(&stored.hash).unwrap();

        assert_eq!(
            retrieved,
            (b"read while snapshotted".to_vec(), "text/plain".to_string())
        );
        drop(snapshot);
    }

    #[test]
    fn backup_snapshot_rejects_missing_size_mismatched_or_corrupt_backing_state() {
        let (missing_store, _missing_tmp) = test_store();
        let missing = missing_store.store(b"missing", "text/plain").unwrap();
        fs::remove_file(missing_store.blob_path(&missing.hash).unwrap()).unwrap();
        assert!(missing_store.backup_snapshot().is_err());

        let (mismatch_store, _mismatch_tmp) = test_store();
        let mismatch = mismatch_store
            .store(b"expected bytes", "text/plain")
            .unwrap();
        fs::write(mismatch_store.blob_path(&mismatch.hash).unwrap(), b"short").unwrap();
        assert!(mismatch_store.backup_snapshot().is_err());

        let (corrupt_store, _corrupt_tmp) = test_store();
        let corrupt = corrupt_store
            .store(b"expected bytes", "text/plain")
            .unwrap();
        fs::write(
            corrupt_store.blob_path(&corrupt.hash).unwrap(),
            b"xxxxxxxxxxxxxx",
        )
        .unwrap();
        assert!(corrupt_store.backup_snapshot().is_err());
    }

    #[test]
    fn backup_snapshot_rejects_malformed_hash_and_non_regular_backing_state() {
        let (malformed_store, _malformed_tmp) = test_store();
        malformed_store
            .database()
            .execute(
                "INSERT INTO blobs (hash, size, content_type, created_at, ref_count)
                 VALUES ('sha256:not-a-hash', 0, 'text/plain', ?1, 1)",
                params![chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
        assert!(malformed_store.backup_snapshot().is_err());

        let (directory_store, _directory_tmp) = test_store();
        let directory = directory_store
            .store(b"replace with directory", "text/plain")
            .unwrap();
        let path = directory_store.blob_path(&directory.hash).unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(directory_store.backup_snapshot().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn backup_snapshot_rejects_path_escaped_backing_state() {
        let (store, tmp) = test_store();
        let stored = store.store(b"escaped", "text/plain").unwrap();

        let path = store.blob_path(&stored.hash).unwrap();
        let prefix = path.parent().unwrap();
        fs::remove_file(&path).unwrap();
        fs::remove_dir(prefix).unwrap();

        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join(path.file_name().unwrap()), b"escaped").unwrap();
        std::os::unix::fs::symlink(outside.path(), prefix).unwrap();

        assert!(store.backup_snapshot().is_err());
        assert!(tmp.path().join("cas.db").exists());
    }
    #[cfg(unix)]
    #[test]
    fn opening_cas_rejects_root_replacement_after_path_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cas");
        drop(ContentStore::open(&root).unwrap());
        let attacker = temp.path().join("attacker-cas");
        drop(ContentStore::open(&attacker).unwrap());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        install_after_root_path_resolved_barrier(root.clone(), barrier.clone());
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || {
            ContentStore::open(&worker_root)
                .map(drop)
                .map_err(|error| error.to_string())
        });

        barrier.wait();
        let retained = temp.path().join("retained-cas");
        fs::rename(&root, &retained).unwrap();
        std::os::unix::fs::symlink(&attacker, &root).unwrap();
        barrier.wait();

        assert!(
            worker.join().unwrap().is_err(),
            "opening CAS followed a root replaced after path resolution"
        );
    }

    #[cfg(unix)]
    #[test]
    fn opening_cas_rejects_database_replacement_after_path_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cas");
        drop(ContentStore::open(&root).unwrap());
        let attacker = temp.path().join("attacker-cas");
        drop(ContentStore::open(&attacker).unwrap());
        let database = root.join("cas.db");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        install_after_database_path_resolved_barrier(database.clone(), barrier.clone());
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || {
            ContentStore::open(&worker_root)
                .map(drop)
                .map_err(|error| error.to_string())
        });

        barrier.wait();
        fs::rename(&database, root.join("retained-cas.db")).unwrap();
        std::os::unix::fs::symlink(attacker.join("cas.db"), &database).unwrap();
        barrier.wait();

        assert!(
            worker.join().unwrap().is_err(),
            "opening CAS followed a database replaced after path resolution"
        );
    }

    #[cfg(unix)]
    #[test]
    fn opening_cas_connects_to_the_database_it_opened() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cas");
        let store = ContentStore::open(&root).unwrap();
        let stored = store.store(b"canonical open", "text/plain").unwrap();

        assert_eq!(store.ref_count(&stored.hash).unwrap(), 1);
        // The connection has to be reachable by path for SQLite to resolve it,
        // and the file it landed on has to be the one in the CAS root.
        let database = fs::canonicalize(&root).unwrap().join("cas.db");
        assert!(database.is_file());
        assert!(fs::metadata(&database).unwrap().len() > 0);
    }

    #[cfg(unix)]
    #[test]
    fn opening_cas_rejects_root_ancestor_swap_before_the_database_open() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cas");
        drop(ContentStore::open(&root).unwrap());
        let attacker = temp.path().join("attacker-cas");
        drop(ContentStore::open(&attacker).unwrap());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        install_after_database_path_resolved_barrier(root.join("cas.db"), barrier.clone());
        let worker_root = root.clone();
        let worker = std::thread::spawn(move || {
            ContentStore::open(&worker_root)
                .map(drop)
                .map_err(|error| error.to_string())
        });

        barrier.wait();
        // A rename, not a symlink: the retained directory descriptor still
        // points at the real CAS, so every descriptor-relative check passes.
        // Only SQLite resolves the name again, and it now lands elsewhere.
        fs::rename(&root, temp.path().join("retained-cas")).unwrap();
        fs::rename(&attacker, &root).unwrap();
        barrier.wait();

        assert!(
            worker.join().unwrap().is_err(),
            "opening CAS connected to a database beneath a swapped ancestor"
        );
    }

    #[cfg(unix)]
    #[test]
    fn backup_snapshot_rejects_blob_ancestor_replacement_after_path_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("cas");
        let store = ContentStore::open(&root).unwrap();
        let bytes = b"descriptor-bound blob";
        let stored = store.store(bytes, "text/plain").unwrap();
        let blob = store.blob_path(&stored.hash).unwrap();
        let prefix = blob.parent().unwrap().to_path_buf();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join(blob.file_name().unwrap()), bytes).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        install_after_blob_ancestor_path_resolved_barrier(prefix.clone(), barrier.clone());
        let worker = std::thread::spawn(move || {
            store
                .backup_snapshot()
                .map(|snapshot| snapshot.blobs().len())
                .map_err(|error| error.to_string())
        });

        barrier.wait();
        fs::rename(&prefix, root.join("retained-prefix")).unwrap();
        std::os::unix::fs::symlink(&outside, &prefix).unwrap();
        barrier.wait();

        assert!(
            worker.join().unwrap().is_err(),
            "snapshot followed a blob ancestor replaced after path resolution"
        );
    }

    #[cfg(unix)]
    #[test]
    fn backup_snapshot_rejects_lock_replacement_while_acquisition_is_blocked() {
        let (holder, tmp) = test_store();
        let stored = holder.store(b"lock identity", "text/plain").unwrap();
        let waiter = ContentStore::open(tmp.path()).unwrap();
        let snapshot = holder.backup_snapshot().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        install_blocked_lock_barrier(&waiter.lock_file, barrier.clone());
        let worker = std::thread::spawn(move || {
            waiter
                .backup_snapshot()
                .map(|snapshot| snapshot.blobs().len())
                .map_err(|error| error.to_string())
        });

        barrier.wait();
        let lock_path = tmp.path().join(LOCK_FILE_NAME);
        fs::rename(&lock_path, tmp.path().join("retained-cas.lock")).unwrap();
        File::create(&lock_path).unwrap();
        let replacement_store = ContentStore::open(tmp.path()).unwrap();
        replacement_store.increment_ref(&stored.hash).unwrap();
        barrier.wait();
        drop(snapshot);

        assert!(
            worker.join().unwrap().is_err(),
            "snapshot proceeded on the retained lock after cas.lock was replaced"
        );
    }

    #[test]
    fn nested_same_store_mutation_cannot_release_snapshot_lock() {
        let (store, tmp) = test_store();
        let stored = store.store(b"nested lock", "text/plain").unwrap();
        let other_store = ContentStore::open(tmp.path()).unwrap();
        let snapshot = store.backup_snapshot().unwrap();

        assert!(
            store.increment_ref(&stored.hash).is_err(),
            "same-store mutation must not reacquire and release the snapshot lock"
        );

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let hash = stored.hash.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            other_store.increment_ref(&hash).unwrap();
            finished_tx.send(()).unwrap();
        });

        started_rx.recv().unwrap();
        assert!(
            finished_rx
                .recv_timeout(std::time::Duration::from_millis(150))
                .is_err(),
            "nested acquisition released the outer snapshot lock"
        );
        drop(snapshot);
        finished_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        worker.join().unwrap();
        assert_eq!(store.ref_count(&stored.hash).unwrap(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn backup_snapshot_uses_bounded_file_descriptors() {
        let (store, tmp) = test_store();
        for index in 0..128 {
            store
                .store(format!("descriptor-{index}").as_bytes(), "text/plain")
                .unwrap();
        }
        let descriptor_directory = if Path::new("/proc/self/fd").is_dir() {
            Path::new("/proc/self/fd")
        } else {
            Path::new("/dev/fd")
        };
        let canonical_root = fs::canonicalize(tmp.path()).unwrap();
        let count_store_descriptors = || {
            fs::read_dir(descriptor_directory)
                .unwrap()
                .filter_map(Result::ok)
                .filter_map(|entry| fs::read_link(entry.path()).ok())
                .filter_map(|target| fs::canonicalize(target).ok())
                .filter(|target| target.starts_with(&canonical_root))
                .count()
        };
        let before = count_store_descriptors();

        let snapshot = store.backup_snapshot().unwrap();
        let after = count_store_descriptors();

        assert_eq!(snapshot.blobs().len(), 128);
        assert_eq!(
            after, before,
            "snapshot retained blob descriptors beneath the CAS root"
        );
    }

    #[test]
    fn backup_blob_membership_lookup_is_sublinear() {
        let (store, _tmp) = test_store();
        for index in 0..256 {
            store
                .store(format!("membership-{index}").as_bytes(), "text/plain")
                .unwrap();
        }
        let snapshot = store.backup_snapshot().unwrap();
        let blob = snapshot.blobs().last().unwrap().clone();

        snapshot.with_blob_file(&blob, |_| Ok(())).unwrap();

        assert!(
            snapshot.membership_comparisons() <= 10,
            "membership lookup made {} comparisons for 256 blobs",
            snapshot.membership_comparisons()
        );
    }

    #[test]
    fn rebuild_recreates_rows_from_files_and_scan() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        let stored = store.store(b"png-bytes", "image/png").unwrap();
        let snap = store.store(b"<html>", "text/html").unwrap();
        // Corrupt the derived state: wrong types, wrong refs.
        store
            .database()
            .execute(
                "UPDATE blobs SET content_type = 'wrong/type', ref_count = 9",
                [],
            )
            .unwrap();
        let mut scan = ArchiveRefScan::default();
        scan.refs.insert(stored.hash.clone(), 2);
        scan.refs.insert(snap.hash.clone(), 1);
        scan.types.insert(stored.hash.clone(), "image/png".into());
        scan.types.insert(snap.hash.clone(), "text/html".into());
        let report = store.rebuild_metadata(&scan, true).unwrap();
        assert_eq!(report.rows_written, 2);
        let (_, ct) = store.retrieve(&stored.hash).unwrap();
        assert_eq!(ct, "image/png");
        assert_eq!(store.ref_count(&stored.hash).unwrap(), 2);
        assert_eq!(store.ref_count(&snap.hash).unwrap(), 1);
    }

    #[test]
    fn rebuild_flags_unreferenced_untyped_and_missing() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        let orphan = store.store(b"orphan", "application/pdf").unwrap();
        let mut scan = ArchiveRefScan::default();
        let ghost = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        scan.refs.insert(ghost.into(), 1);
        let report = store.rebuild_metadata(&scan, true).unwrap();
        assert_eq!(report.unreferenced_blobs, 1); // orphan file kept, ref_count 0
        assert_eq!(report.untyped_blobs, vec![orphan.hash.clone()]);
        assert_eq!(report.missing_files, vec![ghost.to_string()]);
        assert_eq!(store.ref_count(&orphan.hash).unwrap(), 0);
    }

    #[test]
    fn rebuild_dry_run_changes_nothing() {
        let tmp = TempDir::new().unwrap();
        let store = ContentStore::open(tmp.path()).unwrap();
        let stored = store.store(b"x", "image/png").unwrap();
        let report = store
            .rebuild_metadata(&ArchiveRefScan::default(), false)
            .unwrap();
        assert!(report.dry_run);
        assert_eq!(store.ref_count(&stored.hash).unwrap(), 1);
    }
}
