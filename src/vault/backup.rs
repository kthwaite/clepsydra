use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use walkdir::WalkDir;

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

fn io_error(operation: &'static str, path: &Path, source: std::io::Error) -> BackupError {
    BackupError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs::{self, OpenOptions};

    use chrono::TimeZone;
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
        assert!(entries.all(|entry| entry.unwrap().path().unwrap() != Path::new("linked-outside/secret.txt")));
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
        assert!(!destination
            .join("clepsydra-backup-20260808T123456Z.tar")
            .exists());
        assert!(!destination
            .join("clepsydra-backup-20260808T123456Z.tar.partial")
            .exists());
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
        assert!(!destination
            .join("clepsydra-backup-20260808T123456Z.tar.partial")
            .exists());
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
