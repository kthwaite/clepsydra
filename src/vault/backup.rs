use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use walkdir::WalkDir;

#[cfg(not(unix))]
use crate::feeds::store::snapshot_database;
use crate::feeds::store::{
    FEED_GENERATION_LOCK_FILENAME, FEED_WRITER_LOCK_FILENAME, FeedStoreError,
};
#[cfg(unix)]
use crate::feeds::store::{
    lock_feed_generation_shared, open_feed_lock_file, snapshot_database_file,
};

use crate::expand_tilde;
use crate::vault::cas::ContentStore;
use crate::vault::config::VaultConfig;

const CAS_ARCHIVE_ROOT: &str = ".clepsydra/cas";
const CAS_DATABASE_ARCHIVE_PATH: &str = ".clepsydra/cas/cas.db";
const BACKUP_MANIFEST_PATH: &str = ".clepsydra/backup-manifest.json";
const BACKUP_FORMAT_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("{operation} `{path}`: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("walk vault `{root}`: {source}")]
    Walk {
        root: PathBuf,
        #[source]
        source: walkdir::Error,
    },
    #[error("snapshot feed database `{path}`: {source}")]
    FeedSnapshot {
        path: PathBuf,
        #[source]
        source: FeedStoreError,
    },
    #[error("unsafe feed storage path `{path}`: expected {expected}")]
    UnsafeFeedStorage {
        path: PathBuf,
        expected: &'static str,
    },
    #[error("no temporary directory outside vault `{root}` is available")]
    SnapshotLocation { root: PathBuf },
    #[error("load vault configuration `{path}`: {message}")]
    Config { path: PathBuf, message: String },
    #[error("{operation} CAS `{path}`: {message}")]
    Cas {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
    #[error("unsafe CAS storage path `{path}`: expected {expected}")]
    UnsafeCasStorage {
        path: PathBuf,
        expected: &'static str,
    },
    #[error("unsafe CAS/archive overlap between CAS `{cas_root}` and `{archive_path}`")]
    UnsafeCasOverlap {
        cas_root: PathBuf,
        archive_path: PathBuf,
    },
    #[error("serialize backup manifest: {0}")]
    Manifest(#[from] serde_json::Error),
}

pub fn create_backup(
    vault_root: &Path,
    destination: &Path,
    timestamp: DateTime<Utc>,
) -> Result<PathBuf, BackupError> {
    fs::create_dir_all(destination)
        .map_err(|source| io_error("create backup destination", destination, source))?;
    let destination = destination
        .canonicalize()
        .map_err(|source| io_error("resolve backup destination", destination, source))?;
    let vault_root = vault_root
        .canonicalize()
        .map_err(|source| io_error("resolve vault root", vault_root, source))?;
    let vault_metadata = fs::metadata(&vault_root)
        .map_err(|source| io_error("inspect vault root", &vault_root, source))?;
    if !vault_metadata.is_dir() {
        return Err(io_error(
            "validate vault root directory",
            &vault_root,
            std::io::Error::new(
                std::io::ErrorKind::NotADirectory,
                "vault root is not a directory",
            ),
        ));
    }

    let filename = format!(
        "clepsydra-backup-{}.tar",
        timestamp.format("%Y%m%dT%H%M%SZ")
    );
    let final_path = destination.join(filename);
    let mut partial_filename = final_path
        .file_name()
        .expect("backup filename is always present")
        .to_os_string();
    partial_filename.push(".partial");
    let partial_path = destination.join(partial_filename);

    let config_path = vault_root.join(".clepsydra/config.toml");
    let vault_config = VaultConfig::load(&vault_root).map_err(|source| BackupError::Config {
        path: config_path,
        message: source.to_string(),
    })?;
    let configured_cas_path = vault_config.archive.cas_path;
    let unresolved_cas_path =
        expand_tilde(&configured_cas_path).unwrap_or_else(|| PathBuf::from(&configured_cas_path));
    let cas_root = unresolved_cas_path
        .canonicalize()
        .map_err(|source| io_error("resolve configured CAS path", &unresolved_cas_path, source))?;
    let cas_metadata = fs::metadata(&cas_root)
        .map_err(|source| io_error("inspect configured CAS path", &cas_root, source))?;
    if !cas_metadata.is_dir() {
        return Err(BackupError::UnsafeCasStorage {
            path: cas_root,
            expected: "directory",
        });
    }
    let cas_database = cas_root.join("cas.db");
    let cas_database_metadata = fs::symlink_metadata(&cas_database)
        .map_err(|source| io_error("inspect CAS database", &cas_database, source))?;
    if cas_database_metadata.file_type().is_symlink() || !cas_database_metadata.is_file() {
        return Err(BackupError::UnsafeCasStorage {
            path: cas_database,
            expected: "non-symlink regular file",
        });
    }
    if cas_root == vault_root {
        return Err(BackupError::UnsafeCasOverlap {
            cas_root,
            archive_path: vault_root,
        });
    }
    if final_path.starts_with(&cas_root) {
        return Err(BackupError::UnsafeCasOverlap {
            cas_root,
            archive_path: final_path,
        });
    }
    if partial_path.starts_with(&cas_root) {
        return Err(BackupError::UnsafeCasOverlap {
            cas_root,
            archive_path: partial_path,
        });
    }

    let feed_snapshot = if let Some(live_feed_database) = verified_feed_database(&vault_root)? {
        let temporary = snapshot_tempdir(&vault_root, &destination)?;
        let snapshot = temporary.path().join("feeds.db");
        #[cfg(unix)]
        let snapshot_result = snapshot_database_file(
            &live_feed_database.metadata_directory,
            Path::new("feeds.db").as_os_str(),
            &live_feed_database.database,
            &live_feed_database.generation_lock,
            &live_feed_database.path,
            &snapshot,
        );
        #[cfg(not(unix))]
        let snapshot_result = snapshot_database(&live_feed_database.path, &snapshot);
        snapshot_result.map_err(|source| BackupError::FeedSnapshot {
            path: live_feed_database.path.clone(),
            source,
        })?;
        Some((temporary, snapshot))
    } else {
        None
    };

    let cas_store = ContentStore::open(&cas_root)
        .map_err(|source| cas_error("open", &cas_root, source))?;
    let cas_snapshot = cas_store
        .backup_snapshot()
        .map_err(|source| cas_error("snapshot", &cas_root, source))?;
    let resolved_source_path =
        cas_root
            .to_str()
            .ok_or_else(|| BackupError::UnsafeCasStorage {
                path: cas_root.clone(),
                expected: "UTF-8 path representable in the backup manifest",
            })?;
    let manifest = BackupManifest {
        format_version: BACKUP_FORMAT_VERSION,
        created_at: timestamp.to_rfc3339_opts(SecondsFormat::Secs, true),
        cas: BackupManifestCas {
            configured_path: &configured_cas_path,
            resolved_source_path,
            archived_path: CAS_ARCHIVE_ROOT,
        },
    };
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    manifest_bytes.push(b'\n');

    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial_path)
        .map_err(|source| io_error("create partial backup", &partial_path, source))?;
    let mut partial = PartialArchive {
        path: partial_path.clone(),
        builder: Some(tar::Builder::new(file)),
        committed: false,
    };
    partial
        .builder
        .as_mut()
        .expect("uncommitted archive has a builder")
        .follow_symlinks(false);

    let cas_inside_vault = cas_root.starts_with(&vault_root);
    let live_stable_cas = vault_root.join(CAS_ARCHIVE_ROOT);
    let live_manifest = vault_root.join(BACKUP_MANIFEST_PATH);
    let mut entries = WalkDir::new(&vault_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            path == vault_root
                || !((cas_inside_vault && path.starts_with(&cas_root))
                    || path.starts_with(&live_stable_cas)
                    || path.starts_with(&live_manifest))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| BackupError::Walk {
            root: vault_root.clone(),
            source,
        })?;
    entries.sort_by(|left, right| left.path().cmp(right.path()));

    for entry in entries {
        let path = entry.path();
        if path == vault_root {
            continue;
        }
        let relative = path
            .strip_prefix(&vault_root)
            .expect("WalkDir entries remain beneath their root");
        if relative == Path::new(".clepsydra/cache.db")
            || relative == Path::new(".clepsydra/feeds.db")
            || relative == Path::new(".clepsydra/feeds.db-wal")
            || relative == Path::new(".clepsydra/feeds.db-shm")
            || relative == Path::new(".clepsydra").join(FEED_WRITER_LOCK_FILENAME)
            || relative == Path::new(".clepsydra").join(FEED_GENERATION_LOCK_FILENAME)
            || path == final_path
            || path == partial_path
        {
            continue;
        }

        let builder = partial
            .builder
            .as_mut()
            .expect("uncommitted archive has a builder");
        let result = if entry.file_type().is_dir() {
            builder.append_dir(relative, path)
        } else {
            builder.append_path_with_name(path, relative)
        };
        result.map_err(|source| io_error("append backup entry", path, source))?;
    }

    if let Some((_temporary, snapshot)) = &feed_snapshot {
        partial
            .builder
            .as_mut()
            .expect("uncommitted archive has a builder")
            .append_path_with_name(snapshot, Path::new(".clepsydra/feeds.db"))
            .map_err(|source| io_error("append feed database snapshot", snapshot, source))?;
    }

    let builder = partial
        .builder
        .as_mut()
        .expect("uncommitted archive has a builder");
    append_generated_directory(builder, Path::new(CAS_ARCHIVE_ROOT))?;
    let mut snapshot_database = File::open(cas_snapshot.database_path()).map_err(|source| {
        io_error(
            "open CAS database snapshot",
            cas_snapshot.database_path(),
            source,
        )
    })?;
    builder
        .append_file(
            Path::new(CAS_DATABASE_ARCHIVE_PATH),
            &mut snapshot_database,
        )
        .map_err(|source| {
            io_error(
                "append CAS database snapshot",
                Path::new(CAS_DATABASE_ARCHIVE_PATH),
                source,
            )
        })?;
    let mut last_blob_directory = None;
    for blob in cas_snapshot.blobs() {
        let blob_directory = blob
            .relative_path()
            .parent()
            .expect("CAS backup blob paths always have a fan-out directory");
        if last_blob_directory.as_deref() != Some(blob_directory) {
            let archive_directory = Path::new(CAS_ARCHIVE_ROOT).join(blob_directory);
            append_generated_directory(builder, &archive_directory)?;
            last_blob_directory = Some(blob_directory.to_path_buf());
        }
        let archive_path = Path::new(CAS_ARCHIVE_ROOT).join(blob.relative_path());
        cas_snapshot
            .with_blob_file(blob, |file| builder.append_file(&archive_path, file))
            .map_err(|source| cas_error("append blob snapshot", &cas_root, source))?;
    }
    append_generated_file(
        builder,
        Path::new(BACKUP_MANIFEST_PATH),
        &manifest_bytes,
        timestamp,
    )?;

    partial.commit(&final_path)
}

#[derive(Serialize)]
struct BackupManifest<'a> {
    format_version: u32,
    created_at: String,
    cas: BackupManifestCas<'a>,
}

#[derive(Serialize)]
struct BackupManifestCas<'a> {
    configured_path: &'a str,
    resolved_source_path: &'a str,
    archived_path: &'static str,
}

fn append_generated_directory(
    builder: &mut tar::Builder<File>,
    archive_path: &Path,
) -> Result<(), BackupError> {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Directory);
    header.set_mode(0o755);
    header.set_size(0);
    header.set_mtime(0);
    header.set_cksum();
    builder
        .append_data(&mut header, archive_path, std::io::empty())
        .map_err(|source| io_error("append generated backup directory", archive_path, source))
}

fn append_generated_file(
    builder: &mut tar::Builder<File>,
    archive_path: &Path,
    bytes: &[u8],
    timestamp: DateTime<Utc>,
) -> Result<(), BackupError> {
    let mtime = u64::try_from(timestamp.timestamp()).map_err(|source| {
        io_error(
            "encode generated backup entry timestamp",
            archive_path,
            std::io::Error::new(std::io::ErrorKind::InvalidInput, source),
        )
    })?;
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_mode(0o644);
    header.set_size(bytes.len() as u64);
    header.set_mtime(mtime);
    header.set_cksum();
    builder
        .append_data(&mut header, archive_path, bytes)
        .map_err(|source| io_error("append generated backup file", archive_path, source))
}
struct PartialArchive {
    path: PathBuf,
    builder: Option<tar::Builder<File>>,
    committed: bool,
}

impl PartialArchive {
    fn commit(mut self, final_path: &Path) -> Result<PathBuf, BackupError> {
        let mut builder = self
            .builder
            .take()
            .expect("uncommitted archive has a builder");
        builder
            .finish()
            .map_err(|source| io_error("finish backup archive", &self.path, source))?;
        builder
            .get_mut()
            .sync_all()
            .map_err(|source| io_error("sync backup archive", &self.path, source))?;
        drop(builder);
        super::atomic_file::install_noreplace(&self.path, final_path)
            .map_err(|source| io_error("install backup archive", final_path, source))?;
        self.committed = true;
        Ok(final_path.to_path_buf())
    }
}

impl Drop for PartialArchive {
    fn drop(&mut self) {
        if !self.committed {
            self.builder.take();
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct VerifiedFeedDatabase {
    path: PathBuf,
    #[cfg(unix)]
    metadata_directory: OwnedFd,
    #[cfg(unix)]
    database: File,
    #[cfg(unix)]
    generation_lock: File,
}

#[cfg(unix)]
fn verified_feed_database(vault_root: &Path) -> Result<Option<VerifiedFeedDatabase>, BackupError> {
    use rustix::fs::{FileType, Mode, OFlags, fstat, open, openat};
    use rustix::io::Errno;

    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
    let vault = open(vault_root, directory_flags, Mode::empty()).map_err(|source| {
        io_error(
            "open vault root without following links",
            vault_root,
            source.into(),
        )
    })?;
    let metadata_path = vault_root.join(".clepsydra");
    let metadata_directory = match openat(&vault, ".clepsydra", directory_flags, Mode::empty()) {
        Ok(directory) => directory,
        Err(Errno::NOENT) => return Ok(None),
        Err(source) => {
            return Err(io_error(
                "open feed metadata directory without following links",
                &metadata_path,
                source.into(),
            ));
        }
    };
    let _writer_lock = open_feed_lock_file(
        &metadata_directory,
        Path::new(FEED_WRITER_LOCK_FILENAME).as_os_str(),
        &metadata_path,
    )
    .map_err(|source| BackupError::FeedSnapshot {
        path: metadata_path.clone(),
        source,
    })?;
    let generation_lock = lock_feed_generation_shared(
        &metadata_directory,
        &metadata_path,
        Path::new("feeds.db").as_os_str(),
    )
    .map_err(|source| BackupError::FeedSnapshot {
        path: metadata_path.clone(),
        source,
    })?;

    let database_path = metadata_path.join("feeds.db");
    let database = match openat(
        &metadata_directory,
        "feeds.db",
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(database) => database,
        Err(Errno::NOENT) => return Ok(None),
        Err(source) => {
            return Err(io_error(
                "open feed database without following links",
                &database_path,
                source.into(),
            ));
        }
    };
    let metadata = fstat(&database).map_err(|source| {
        io_error(
            "inspect opened feed database",
            &database_path,
            source.into(),
        )
    })?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile {
        return Err(BackupError::UnsafeFeedStorage {
            path: database_path,
            expected: "regular file",
        });
    }

    Ok(Some(VerifiedFeedDatabase {
        path: database_path,
        metadata_directory,
        database: database.into(),
        generation_lock,
    }))
}

#[cfg(not(unix))]
fn verified_feed_database(vault_root: &Path) -> Result<Option<VerifiedFeedDatabase>, BackupError> {
    let metadata_path = vault_root.join(".clepsydra");
    let metadata = match fs::symlink_metadata(&metadata_path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(io_error(
                "inspect feed metadata directory",
                &metadata_path,
                source,
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BackupError::UnsafeFeedStorage {
            path: metadata_path,
            expected: "non-symlink directory",
        });
    }

    let database_path = metadata_path.join("feeds.db");
    let metadata = match fs::symlink_metadata(&database_path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("inspect feed database", &database_path, source)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BackupError::UnsafeFeedStorage {
            path: database_path,
            expected: "non-symlink regular file",
        });
    }
    Ok(Some(VerifiedFeedDatabase {
        path: database_path,
    }))
}

fn io_error(operation: &'static str, path: &Path, source: std::io::Error) -> BackupError {
    BackupError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn cas_error(
    operation: &'static str,
    path: &Path,
    source: Box<dyn std::error::Error>,
) -> BackupError {
    BackupError::Cas {
        operation,
        path: path.to_path_buf(),
        message: source.to_string(),
    }
}

fn snapshot_tempdir(
    vault_root: &Path,
    destination: &Path,
) -> Result<tempfile::TempDir, BackupError> {
    let temporary = if destination.starts_with(vault_root) {
        tempfile::tempdir()
    } else {
        tempfile::tempdir_in(destination)
    }
    .map_err(|source| io_error("create feed snapshot directory", destination, source))?;
    if temporary.path().starts_with(vault_root) {
        return Err(BackupError::SnapshotLocation {
            root: vault_root.to_path_buf(),
        });
    }
    Ok(temporary)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs::{self, OpenOptions};
    use std::io::Read;

    use chrono::TimeZone;
    use rusqlite::Connection;
    use serde_json::json;
    use tempfile::TempDir;

    use crate::vault::cas::ContentStore;

    use super::*;

    fn timestamp() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 8, 12, 34, 56)
            .single()
            .unwrap()
    }

    fn archive_paths(path: &Path) -> BTreeSet<PathBuf> {
        let file = File::open(path).unwrap();
        tar::Archive::new(file)
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect()
    }

    fn archive_path_list(path: &Path) -> Vec<PathBuf> {
        let file = File::open(path).unwrap();
        tar::Archive::new(file)
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect()
    }

    fn archive_entry_bytes(path: &Path, target: &Path) -> Vec<u8> {
        let file = File::open(path).unwrap();
        let mut archive = tar::Archive::new(file);
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap() == target {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                return bytes;
            }
        }
        panic!("archive entry `{}` was absent", target.display());
    }

    fn configure_cas(vault: &Path, configured_path: &str) {
        fs::create_dir_all(vault.join(".clepsydra")).unwrap();
        fs::write(
            vault.join(".clepsydra/config.toml"),
            format!(
                "[vault]\n\n[archive]\ncas_path = {:?}\n",
                configured_path
            ),
        )
        .unwrap();
    }

    fn stable_blob_path(hash: &str) -> PathBuf {
        let hex = hash.strip_prefix("sha256:").unwrap();
        Path::new(".clepsydra/cas")
            .join(&hex[..2])
            .join(hex)
    }

    fn backup_output_paths(destination: &Path) -> (PathBuf, PathBuf) {
        let final_path = destination.join("clepsydra-backup-20260808T123456Z.tar");
        let partial_path =
            destination.join("clepsydra-backup-20260808T123456Z.tar.partial");
        (final_path, partial_path)
    }

    fn populated_vault() -> (TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir_all(vault.join("notes")).unwrap();
        fs::create_dir_all(vault.join("_attachments")).unwrap();
        fs::create_dir_all(vault.join(".clepsydra")).unwrap();
        fs::write(vault.join("notes/a.md"), "# A\n").unwrap();
        fs::write(vault.join("_attachments/image.bin"), [0_u8, 1, 2]).unwrap();
        let cas = temp.path().join("default-cas");
        configure_cas(&vault, &cas.display().to_string());
        ContentStore::open(&cas).unwrap();
        fs::write(vault.join(".clepsydra/cache.db"), b"cache").unwrap();
        (temp, vault)
    }

    #[test]
    fn archives_vault_content_and_config_but_not_cache() {
        let (_temp, vault) = populated_vault();
        let destination = vault.parent().unwrap().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let paths = archive_paths(&archive);

        assert!(paths.contains(Path::new("notes/a.md")));
        assert!(paths.contains(Path::new("_attachments/image.bin")));
        assert!(paths.contains(Path::new(".clepsydra/config.toml")));
        assert!(!paths.contains(Path::new(".clepsydra/cache.db")));
    }

    #[test]
    fn archives_external_cas_snapshot_at_stable_paths() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("external-cas");
        configure_cas(&vault, &cas.display().to_string());
        let store = ContentStore::open(&cas).unwrap();
        let stored = store.store(b"external blob", "text/plain").unwrap();
        fs::write(cas.join("unreferenced"), b"not authoritative").unwrap();
        let destination = temp.path().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let paths = archive_paths(&archive);
        let archived_database = Path::new(".clepsydra/cas/cas.db");
        let archived_blob = stable_blob_path(&stored.hash);

        assert!(paths.contains(archived_database));
        assert!(paths.contains(&archived_blob));
        assert_eq!(
            archive_entry_bytes(&archive, &archived_blob),
            b"external blob"
        );
        assert!(!paths.contains(Path::new(".clepsydra/cas/unreferenced")));
    }

    #[test]
    fn excludes_in_vault_cas_from_walk_and_archives_it_once_at_stable_path() {
        let (temp, vault) = populated_vault();
        let cas = vault.join(".clepsydra/live-cas");
        configure_cas(&vault, &cas.display().to_string());
        let store = ContentStore::open(&cas).unwrap();
        let stored = store.store(b"in-vault blob", "text/plain").unwrap();
        fs::write(cas.join("unreferenced"), b"not authoritative").unwrap();
        let destination = temp.path().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let paths = archive_path_list(&archive);
        let source_relative = cas.strip_prefix(&vault).unwrap();
        let archived_blob = stable_blob_path(&stored.hash);

        assert!(
            paths
                .iter()
                .all(|path| !path.starts_with(source_relative)),
            "live CAS subtree leaked into ordinary vault traversal"
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_path() == archived_blob)
                .count(),
            1
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_path() == Path::new(".clepsydra/cas/cas.db"))
                .count(),
            1
        );
        assert!(
            !paths
                .iter()
                .any(|path| path == Path::new(".clepsydra/cas/unreferenced"))
        );
    }

    #[test]
    fn archives_committed_cas_wal_state_in_a_reopenable_database() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("wal-cas");
        configure_cas(&vault, &cas.display().to_string());
        drop(ContentStore::open(&cas).unwrap());
        let wal_bytes = b"committed only through WAL";
        let wal_hash = ContentStore::hash_bytes(wal_bytes);
        let wal_hex = wal_hash.strip_prefix("sha256:").unwrap();
        fs::create_dir_all(cas.join(&wal_hex[..2])).unwrap();
        fs::write(cas.join(&wal_hex[..2]).join(wal_hex), wal_bytes).unwrap();
        let live_database = Connection::open(cas.join("cas.db")).unwrap();
        live_database
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
            .unwrap();
        live_database
            .execute(
                "INSERT INTO blobs (hash, size, content_type, created_at, ref_count)
                 VALUES (?1, ?2, 'text/plain', '2026-08-08T12:00:00Z', 1)",
                rusqlite::params![wal_hash, wal_bytes.len() as i64],
            )
            .unwrap();
        assert!(
            cas.join("cas.db-wal").is_file(),
            "fixture must retain committed WAL state"
        );
        let destination = temp.path().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let extracted = temp.path().join("archived-cas.db");
        fs::write(
            &extracted,
            archive_entry_bytes(&archive, Path::new(".clepsydra/cas/cas.db")),
        )
        .unwrap();
        let archived_database = Connection::open(extracted).unwrap();
        let archived_size: i64 = archived_database
            .query_row(
                "SELECT size FROM blobs WHERE hash = ?1",
                [&wal_hash],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(archived_size, wal_bytes.len() as i64);
        assert_eq!(
            archive_entry_bytes(&archive, &stable_blob_path(&wal_hash)),
            wal_bytes
        );
    }

    #[test]
    fn writes_one_exact_versioned_backup_manifest() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("manifest-cas");
        fs::create_dir_all(&cas).unwrap();
        let configured_path = format!("{}/.", cas.display());
        configure_cas(&vault, &configured_path);
        drop(ContentStore::open(&cas).unwrap());
        fs::write(
            vault.join(".clepsydra/backup-manifest.json"),
            b"{\"stale\":true}",
        )
        .unwrap();
        let destination = temp.path().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let paths = archive_path_list(&archive);
        let manifest_path = Path::new(".clepsydra/backup-manifest.json");
        let manifest: serde_json::Value =
            serde_json::from_slice(&archive_entry_bytes(&archive, manifest_path)).unwrap();

        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_path() == manifest_path)
                .count(),
            1
        );
        assert_eq!(
            manifest,
            json!({
                "format_version": 1,
                "created_at": "2026-08-08T12:34:56Z",
                "cas": {
                    "configured_path": configured_path,
                    "resolved_source_path": cas.canonicalize().unwrap(),
                    "archived_path": ".clepsydra/cas"
                }
            })
        );
    }

    #[test]
    fn omits_cas_sidecars_lock_and_unreferenced_files() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("sidecar-cas");
        configure_cas(&vault, &cas.display().to_string());
        let store = ContentStore::open(&cas).unwrap();
        let stored = store.store(b"authoritative", "text/plain").unwrap();
        drop(store);
        let live_database = Connection::open(cas.join("cas.db")).unwrap();
        live_database
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA wal_autocheckpoint = 0;
                 CREATE TABLE sidecar_probe (value TEXT NOT NULL);
                 INSERT INTO sidecar_probe VALUES ('live');",
            )
            .unwrap();
        assert!(cas.join("cas.db-wal").is_file());
        assert!(cas.join("cas.db-shm").is_file());
        assert!(cas.join("cas.lock").is_file());
        fs::write(cas.join("orphan.bin"), b"orphan").unwrap();
        let destination = temp.path().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let paths = archive_paths(&archive);
        assert!(paths.contains(Path::new(".clepsydra/cas/cas.db")));
        assert!(paths.contains(&stable_blob_path(&stored.hash)));

        for excluded in [
            ".clepsydra/cas/cas.db-wal",
            ".clepsydra/cas/cas.db-shm",
            ".clepsydra/cas/cas.lock",
            ".clepsydra/cas/orphan.bin",
        ] {
            assert!(
                !paths.contains(Path::new(excluded)),
                "unexpected CAS entry {excluded}"
            );
        }
    }

    #[test]
    fn inconsistent_cas_fails_without_final_or_partial_archive() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("inconsistent-cas");
        configure_cas(&vault, &cas.display().to_string());
        let store = ContentStore::open(&cas).unwrap();
        let stored = store.store(b"missing backing file", "text/plain").unwrap();
        let hex = stored.hash.strip_prefix("sha256:").unwrap();
        fs::remove_file(cas.join(&hex[..2]).join(hex)).unwrap();
        let destination = temp.path().join("backups");
        let (final_path, partial_path) = backup_output_paths(&destination);

        assert!(create_backup(&vault, &destination, timestamp()).is_err());
        assert!(!final_path.exists());
        assert!(!partial_path.exists());
    }

    #[test]
    fn missing_configured_cas_fails_without_archive_artifacts() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("missing-cas");
        configure_cas(&vault, &cas.display().to_string());
        let destination = temp.path().join("backups");
        let (final_path, partial_path) = backup_output_paths(&destination);

        assert!(create_backup(&vault, &destination, timestamp()).is_err());
        assert!(!cas.exists(), "backup must not create a missing CAS");
        assert!(!final_path.exists());
        assert!(!partial_path.exists());
    }

    #[test]
    fn rejects_cas_at_vault_root_without_archive_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir_all(vault.join(".clepsydra")).unwrap();
        configure_cas(&vault, &vault.display().to_string());
        drop(ContentStore::open(&vault).unwrap());
        let destination = temp.path().join("backups");
        let (final_path, partial_path) = backup_output_paths(&destination);

        assert!(create_backup(&vault, &destination, timestamp()).is_err());
        assert!(!final_path.exists());
        assert!(!partial_path.exists());
    }

    #[test]
    fn rejects_backup_outputs_inside_cas_without_archive_artifacts() {
        let (temp, vault) = populated_vault();
        let cas = temp.path().join("output-cas");
        configure_cas(&vault, &cas.display().to_string());
        drop(ContentStore::open(&cas).unwrap());
        let destination = cas.join("backups");
        let (final_path, partial_path) = backup_output_paths(&destination);

        assert!(create_backup(&vault, &destination, timestamp()).is_err());
        assert!(!final_path.exists());
        assert!(!partial_path.exists());
    }

    #[test]
    fn archives_one_reopenable_feed_snapshot_without_live_database_sidecars() {
        let (_temp, vault) = populated_vault();
        let live_database = vault.join(".clepsydra/feeds.db");
        let connection = Connection::open(&live_database).unwrap();
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA wal_autocheckpoint = 0;
                CREATE TABLE snapshot_probe (
                    id INTEGER PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT INTO snapshot_probe (value) VALUES ('committed-in-wal');
                ",
            )
            .unwrap();
        let live_wal = vault.join(".clepsydra/feeds.db-wal");
        let live_shm = vault.join(".clepsydra/feeds.db-shm");
        assert!(live_wal.is_file(), "fixture must have a live WAL");
        assert!(live_shm.is_file(), "fixture must have a live SHM file");
        let destination = vault.parent().unwrap().join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let file = File::open(&archive).unwrap();
        let archived_paths: Vec<PathBuf> = tar::Archive::new(file)
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect();

        assert_eq!(
            archived_paths
                .iter()
                .filter(|path| path.as_path() == Path::new(".clepsydra/feeds.db"))
                .count(),
            1
        );
        assert!(
            !archived_paths
                .iter()
                .any(|path| path.as_path() == Path::new(".clepsydra/feeds.db-wal"))
        );
        assert!(
            !archived_paths
                .iter()
                .any(|path| path.as_path() == Path::new(".clepsydra/feeds.db-shm"))
        );
        assert!(
            !archived_paths
                .iter()
                .any(|path| path.as_path() == Path::new(".clepsydra/cache.db"))
        );

        let extracted = vault.parent().unwrap().join("archived-feeds.db");
        fs::write(
            &extracted,
            archive_entry_bytes(&archive, Path::new(".clepsydra/feeds.db")),
        )
        .unwrap();
        let reopened = Connection::open(extracted).unwrap();
        let value: String = reopened
            .query_row("SELECT value FROM snapshot_probe WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "committed-in-wal");
    }

    #[cfg(unix)]
    #[test]
    fn backup_snapshots_the_verified_regular_database_identity_after_path_replacement() {
        let (temp, vault) = populated_vault();
        let metadata = vault.join(".clepsydra");
        let database = metadata.join("feeds.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE snapshot_probe (
                    value TEXT NOT NULL
                );
                INSERT INTO snapshot_probe (value) VALUES ('trusted');
                ",
            )
            .unwrap();
        drop(connection);

        let replacement_metadata = temp.path().join("replacement-metadata");
        fs::create_dir(&replacement_metadata).unwrap();
        let replacement = Connection::open(replacement_metadata.join("feeds.db")).unwrap();
        replacement
            .execute_batch(
                "
                CREATE TABLE snapshot_probe (
                    value TEXT NOT NULL
                );
                INSERT INTO snapshot_probe (value) VALUES ('attacker');
                ",
            )
            .unwrap();
        drop(replacement);

        let destination = temp.path().join("backups");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let verified_database_path = database.canonicalize().unwrap();
        crate::feeds::store::install_after_snapshot_source_open_path_resolved_barrier(
            verified_database_path,
            barrier.clone(),
        );
        let vault_for_backup = vault.clone();
        let destination_for_backup = destination.clone();
        let backup = std::thread::spawn(move || {
            create_backup(&vault_for_backup, &destination_for_backup, timestamp())
        });

        barrier.wait();
        let verified_metadata = temp.path().join("verified-metadata");
        fs::rename(&metadata, &verified_metadata).unwrap();
        fs::rename(&replacement_metadata, &metadata).unwrap();
        barrier.wait();

        let archive = backup.join().unwrap().unwrap();
        let extracted = temp.path().join("identity-checked-feeds.db");
        fs::write(
            &extracted,
            archive_entry_bytes(&archive, Path::new(".clepsydra/feeds.db")),
        )
        .unwrap();
        let snapshot = Connection::open(extracted).unwrap();
        let value: String = snapshot
            .query_row("SELECT value FROM snapshot_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "trusted");
        let read_probe = |path: &Path| {
            Connection::open(path)
                .unwrap()
                .query_row("SELECT value FROM snapshot_probe", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap()
        };
        assert_eq!(
            read_probe(&verified_metadata.join("feeds.db")),
            "trusted",
            "backup mutated the originally verified source"
        );
        assert_eq!(
            read_probe(&metadata.join("feeds.db")),
            "attacker",
            "backup mutated the replacement database"
        );
    }

    #[test]
    fn rejects_non_directory_feed_metadata_path() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let destination = temp.path().join("backups");
        fs::create_dir(&vault).unwrap();
        fs::write(vault.join(".clepsydra"), "not a directory").unwrap();

        assert!(
            create_backup(&vault, &destination, timestamp()).is_err(),
            "backup accepted a file in place of `.clepsydra`"
        );
    }

    #[test]
    fn rejects_non_regular_feed_database_path() {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let destination = temp.path().join("backups");
        fs::create_dir_all(vault.join(".clepsydra/feeds.db")).unwrap();

        assert!(
            create_backup(&vault, &destination, timestamp()).is_err(),
            "backup accepted a directory in place of `feeds.db`"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_feed_metadata_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let outside = temp.path().join("outside");
        let destination = temp.path().join("backups");
        fs::create_dir(&vault).unwrap();
        fs::create_dir(&outside).unwrap();
        let external_database = outside.join("feeds.db");
        let connection = Connection::open(&external_database).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE external_sentinel (
                    value TEXT NOT NULL
                );
                INSERT INTO external_sentinel (value) VALUES ('outside');
                ",
            )
            .unwrap();
        drop(connection);
        symlink(&outside, vault.join(".clepsydra")).unwrap();

        assert!(
            create_backup(&vault, &destination, timestamp()).is_err(),
            "backup followed a symlinked `.clepsydra` directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_readable_feed_database() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let metadata = vault.join(".clepsydra");
        let destination = temp.path().join("backups");
        fs::create_dir_all(&metadata).unwrap();
        let external_database = temp.path().join("readable.db");
        let connection = Connection::open(&external_database).unwrap();
        connection
            .execute_batch(
                "
                CREATE TABLE external_sentinel (
                    value TEXT NOT NULL
                );
                INSERT INTO external_sentinel (value) VALUES ('outside');
                ",
            )
            .unwrap();
        drop(connection);
        symlink(&external_database, metadata.join("feeds.db")).unwrap();

        assert!(
            create_backup(&vault, &destination, timestamp()).is_err(),
            "backup copied a readable SQLite database through a symlink"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_dangling_feed_database_symlink_without_creating_its_writable_target() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let metadata = vault.join(".clepsydra");
        let destination = temp.path().join("backups");
        fs::create_dir_all(&metadata).unwrap();
        let writable_target = temp.path().join("outside-created.db");
        symlink(&writable_target, metadata.join("feeds.db")).unwrap();

        assert!(
            create_backup(&vault, &destination, timestamp()).is_err(),
            "backup accepted a dangling `feeds.db` symlink"
        );
        assert!(
            !writable_target.exists(),
            "backup followed a dangling link and created its target"
        );
    }

    #[test]
    fn creates_a_missing_destination_directory() {
        let (_temp, vault) = populated_vault();
        let destination = vault.parent().unwrap().join("missing/backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();

        assert!(destination.is_dir());
        assert!(archive.is_file());
        assert_eq!(
            archive.parent(),
            Some(destination.canonicalize().unwrap().as_path())
        );
    }

    #[test]
    fn excludes_the_current_archive_outputs_inside_the_vault() {
        let (_temp, vault) = populated_vault();
        let destination = vault.join("backups");

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let partial = PathBuf::from(format!("{}.partial", archive.display()));
        let resolved_vault = vault.canonicalize().unwrap();
        let archive_relative = archive.strip_prefix(&resolved_vault).unwrap();
        let partial_relative = partial.strip_prefix(&resolved_vault).unwrap();
        let paths = archive_paths(&archive);

        assert!(!paths.contains(archive_relative));
        assert!(!paths.contains(partial_relative));
    }

    #[cfg(unix)]
    #[test]
    fn stores_a_symlink_without_archiving_its_target_contents() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        let destination = temp.path().join("backups");
        fs::create_dir_all(&vault).unwrap();
        let cas = temp.path().join("cas");
        configure_cas(&vault, &cas.display().to_string());
        drop(ContentStore::open(&cas).unwrap());
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "not in archive").unwrap();
        symlink(&outside, vault.join("linked-outside")).unwrap();

        let archive = create_backup(&vault, &destination, timestamp()).unwrap();
        let file = File::open(archive).unwrap();
        let mut archive_reader = tar::Archive::new(file);
        let mut entries = archive_reader.entries().unwrap();
        let entry = entries
            .find_map(|entry| {
                let entry = entry.unwrap();
                (entry.path().unwrap() == Path::new("linked-outside")).then_some(entry)
            })
            .expect("symlink entry");

        assert!(entry.header().entry_type().is_symlink());
        assert_eq!(entry.link_name().unwrap().unwrap(), outside.as_path());
        assert!(
            entries
                .all(|entry| entry.unwrap().path().unwrap()
                    != Path::new("linked-outside/secret.txt"))
        );
    }

    #[test]
    fn rejects_an_existing_non_directory_destination() {
        let (_temp, vault) = populated_vault();
        let destination = vault.parent().unwrap().join("not-a-directory");
        fs::write(&destination, "file").unwrap();

        let error = create_backup(&vault, &destination, timestamp()).unwrap_err();

        assert!(matches!(error, BackupError::Io { path, .. } if path == destination));
    }

    #[test]
    fn rejects_a_file_valued_vault_root_without_archive_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let vault_root = temp.path().join("not-a-vault");
        let destination = temp.path().join("backups");
        fs::write(&vault_root, "not a directory").unwrap();

        let error = create_backup(&vault_root, &destination, timestamp()).unwrap_err();

        assert!(matches!(
            error,
            BackupError::Io {
                path,
                source,
                ..
            } if path == vault_root.canonicalize().unwrap()
                && matches!(
                    source.kind(),
                    std::io::ErrorKind::NotADirectory | std::io::ErrorKind::InvalidInput
                )
        ));
        assert!(
            !destination
                .join("clepsydra-backup-20260808T123456Z.tar")
                .exists()
        );
        assert!(
            !destination
                .join("clepsydra-backup-20260808T123456Z.tar.partial")
                .exists()
        );
    }

    #[test]
    fn preserves_an_existing_archive_for_the_same_timestamp() {
        let (_temp, vault) = populated_vault();
        let destination = vault.parent().unwrap().join("backups");
        fs::create_dir_all(&destination).unwrap();
        let existing = destination.join("clepsydra-backup-20260808T123456Z.tar");
        fs::write(&existing, b"existing archive").unwrap();

        let error = create_backup(&vault, &destination, timestamp()).unwrap_err();

        assert!(matches!(
            error,
            BackupError::Io { path, source, .. }
                if path == existing.canonicalize().unwrap()
                    && source.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert_eq!(fs::read(&existing).unwrap(), b"existing archive");
        assert!(
            !destination
                .join("clepsydra-backup-20260808T123456Z.tar.partial")
                .exists()
        );
    }

    #[test]
    fn partial_archive_removes_its_file_when_dropped_without_commit() {
        let temp = tempfile::tempdir().unwrap();
        let partial_path = temp.path().join("backup.tar.partial");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)
            .unwrap();
        let guard = PartialArchive {
            path: partial_path.clone(),
            builder: Some(tar::Builder::new(file)),
            committed: false,
        };

        drop(guard);

        assert!(!partial_path.exists());
    }
}
