use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use walkdir::WalkDir;

use crate::feeds::store::FeedStoreError;
#[cfg(not(unix))]
use crate::feeds::store::snapshot_database;
#[cfg(unix)]
use crate::feeds::store::snapshot_database_file;

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

    let feed_snapshot = if let Some(live_feed_database) = verified_feed_database(&vault_root)? {
        #[cfg(test)]
        pause_after_feed_database_verified(&live_feed_database.path);
        let temporary = snapshot_tempdir(&vault_root, &destination)?;
        let snapshot = temporary.path().join("feeds.db");
        #[cfg(unix)]
        let snapshot_result = snapshot_database_file(
            &live_feed_database.metadata_directory,
            Path::new("feeds.db").as_os_str(),
            &live_feed_database.database,
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

    let mut entries = WalkDir::new(&vault_root)
        .follow_links(false)
        .into_iter()
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

    partial.commit(&final_path)
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

#[cfg(test)]
type TestPathBarrier = (PathBuf, std::sync::Arc<std::sync::Barrier>);

#[cfg(test)]
static AFTER_FEED_DATABASE_VERIFIED: std::sync::LazyLock<
    parking_lot::Mutex<Option<TestPathBarrier>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));

#[cfg(test)]
fn normalize_test_barrier_path(path: &Path) -> PathBuf {
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
fn install_after_feed_database_verified_barrier(
    path: PathBuf,
    barrier: std::sync::Arc<std::sync::Barrier>,
) {
    let path = normalize_test_barrier_path(&path);
    let prior = AFTER_FEED_DATABASE_VERIFIED.lock().replace((path, barrier));
    assert!(prior.is_none(), "test path barrier was already installed");
}

#[cfg(test)]
fn pause_after_feed_database_verified(path: &Path) {
    let path = normalize_test_barrier_path(path);
    let barrier = {
        let mut slot = AFTER_FEED_DATABASE_VERIFIED.lock();
        match slot.as_ref() {
            Some((expected, _)) if expected == &path => slot.take().map(|(_, barrier)| barrier),
            _ => None,
        }
    };
    if let Some(barrier) = barrier {
        barrier.wait();
        barrier.wait();
    }
}
struct VerifiedFeedDatabase {
    path: PathBuf,
    #[cfg(unix)]
    metadata_directory: OwnedFd,
    #[cfg(unix)]
    database: File,
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
    use tempfile::TempDir;

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

    fn populated_vault() -> (TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let vault = temp.path().join("vault");
        fs::create_dir_all(vault.join("notes")).unwrap();
        fs::create_dir_all(vault.join("_attachments")).unwrap();
        fs::create_dir_all(vault.join(".clepsydra")).unwrap();
        fs::write(vault.join("notes/a.md"), "# A\n").unwrap();
        fs::write(vault.join("_attachments/image.bin"), [0_u8, 1, 2]).unwrap();
        fs::write(vault.join(".clepsydra/config.toml"), "[vault]\n").unwrap();
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
        install_after_feed_database_verified_barrier(verified_database_path, barrier.clone());
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
