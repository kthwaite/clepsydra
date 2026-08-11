use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::path::VaultPath;
use super::sync::ChangeEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpectedPathState {
    Missing,
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatchPathIntent {
    Write {
        path: VaultPath,
        expected: ExpectedPathState,
        content: Vec<u8>,
    },
    Move {
        source: VaultPath,
        destination: VaultPath,
        expected_source: Vec<u8>,
    },
    Delete {
        path: VaultPath,
        expected: Vec<u8>,
    },
}

#[derive(Debug, Clone)]
pub struct BatchMutationCommand {
    pub intents: Vec<BatchPathIntent>,
    pub index_events: Vec<ChangeEvent>,
    pub moved_pages: Vec<(VaultPath, VaultPath)>,
}

impl BatchMutationCommand {
    pub fn affected_paths(&self) -> Vec<VaultPath> {
        let mut paths = BTreeSet::new();

        for intent in &self.intents {
            match intent {
                BatchPathIntent::Write { path, .. } | BatchPathIntent::Delete { path, .. } => {
                    paths.insert(SortedVaultPath(path));
                }
                BatchPathIntent::Move {
                    source,
                    destination,
                    ..
                } => {
                    paths.insert(SortedVaultPath(source));
                    paths.insert(SortedVaultPath(destination));
                }
            }
        }

        paths.into_iter().map(|path| path.0.clone()).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SortedVaultPath<'a>(&'a VaultPath);

impl Ord for SortedVaultPath<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.as_str().cmp(other.0.as_str())
    }
}

impl PartialOrd for SortedVaultPath<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TransactionManifest {
    phase: TransactionPhase,
    intents: Vec<ManifestIntent>,
    index_events: Vec<ManifestChangeEvent>,
    moved_pages: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ManifestIntent {
    Write {
        path: String,
        before_hash: Option<String>,
        after_hash: String,
    },
    Move {
        source: String,
        destination: String,
        source_hash: String,
        destination_was_missing: bool,
    },
    Delete {
        path: String,
        before_hash: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "path", rename_all = "snake_case")]
enum ManifestChangeEvent {
    Upsert(String),
    Remove(String),
    BaseChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionPhase {
    Prepared,
    Committing,
    FilesystemCommitted,
}

#[derive(Debug, Error, PartialEq, Eq)]
enum IntentValidationError {
    #[error("batch mutation command is empty")]
    EmptyCommand,
    #[error("duplicate final destination: {0}")]
    DuplicateFinalDestination(String),
    #[error("move source and destination are the same: {0}")]
    UnchangedMove(String),
    #[error("conflicting intents for source: {0}")]
    ConflictingSource(String),
}

fn validate_intents(intents: &[BatchPathIntent]) -> Result<(), IntentValidationError> {
    if intents.is_empty() {
        return Err(IntentValidationError::EmptyCommand);
    }

    let mut final_destinations = BTreeSet::new();
    let mut sources = BTreeSet::new();

    for intent in intents {
        let (source, final_destination) = match intent {
            BatchPathIntent::Write { path, .. } => (path.as_str(), Some(path.as_str())),
            BatchPathIntent::Move {
                source,
                destination,
                ..
            } => {
                if source == destination {
                    return Err(IntentValidationError::UnchangedMove(
                        source.as_str().to_owned(),
                    ));
                }
                (source.as_str(), Some(destination.as_str()))
            }
            BatchPathIntent::Delete { path, .. } => (path.as_str(), None),
        };

        if let Some(destination) = final_destination
            && !final_destinations.insert(destination)
        {
            return Err(IntentValidationError::DuplicateFinalDestination(
                destination.to_owned(),
            ));
        }

        if !sources.insert(source) {
            return Err(IntentValidationError::ConflictingSource(
                source.to_owned(),
            ));
        }
    }

    Ok(())
}

#[derive(Debug, Error)]
pub enum BatchMutationError {
    #[error("invalid batch mutation command: {0}")]
    Validation(String),
    #[error("stale batch path: {0}")]
    Stale(String),
    #[error("transaction state at {0} conflicts with both the before and after states")]
    RecoveryConflict(String),
    #[error("invalid transaction phase: expected {expected}, found {actual:?}")]
    InvalidPhase {
        expected: &'static str,
        actual: TransactionPhase,
    },
    #[error("transaction phase publication is uncertain at {0}; recover before continuing")]
    UncertainPhase(PathBuf),
    #[error("invalid transaction manifest at {path}: {message}")]
    InvalidManifest { path: PathBuf, message: String },
    #[error("transaction workspace file {path} does not match its manifest hash")]
    CorruptWorkspace { path: PathBuf },
    #[error("failed to {operation} {path}: {source}")]
    Filesystem {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to publish {path}: {source}")]
    Publication {
        path: PathBuf,
        #[source]
        source: super::atomic_file::AtomicPublicationError,
    },
}

impl BatchMutationError {
    fn filesystem(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Filesystem {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }

    pub(crate) fn stale_vault_path(&self) -> Option<VaultPath> {
        match self {
            Self::Stale(path) => VaultPath::new(path).ok(),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(crate) struct PreparedBatch {
    root: PathBuf,
    directory: PathBuf,
    manifest: TransactionManifest,
    phase_uncertain: bool,
}

impl PreparedBatch {
    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn publish(&mut self) -> Result<(), BatchMutationError> {
        self.ensure_phase_certain()?;
        match self.manifest.phase {
            TransactionPhase::Prepared => self.change_phase(TransactionPhase::Committing)?,
            TransactionPhase::Committing => {}
            phase => {
                return Err(BatchMutationError::InvalidPhase {
                    expected: "prepared or committing",
                    actual: phase,
                });
            }
        }

        for index in 0..self.manifest.intents.len() {
            hit_test_failpoint(TestFailpoint::Publication(index), &self.directory)?;
            publish_intent(
                &self.root,
                &self.directory,
                index,
                &self.manifest.intents[index],
            )?;
        }
        Ok(())
    }

    pub(crate) fn rollback(&mut self) -> Result<(), BatchMutationError> {
        self.ensure_phase_certain()?;
        match self.manifest.phase {
            TransactionPhase::Prepared => {}
            TransactionPhase::Committing => {
                rollback_manifest(&self.root, &self.directory, &self.manifest)?;
            }
            phase => {
                return Err(BatchMutationError::InvalidPhase {
                    expected: "prepared or committing",
                    actual: phase,
                });
            }
        }
        remove_workspace(&self.directory)
    }

    pub(crate) fn mark_filesystem_committed(&mut self) -> Result<(), BatchMutationError> {
        self.ensure_phase_certain()?;
        if self.manifest.phase != TransactionPhase::Committing {
            return Err(BatchMutationError::InvalidPhase {
                expected: "committing",
                actual: self.manifest.phase,
            });
        }
        self.change_phase(TransactionPhase::FilesystemCommitted)
    }

    pub(crate) fn finish(self) -> Result<(), BatchMutationError> {
        self.ensure_phase_certain()?;
        if self.manifest.phase != TransactionPhase::FilesystemCommitted {
            return Err(BatchMutationError::InvalidPhase {
                expected: "filesystem committed",
                actual: self.manifest.phase,
            });
        }
        remove_workspace(&self.directory)
    }

    fn change_phase(&mut self, phase: TransactionPhase) -> Result<(), BatchMutationError> {
        let mut next_manifest = self.manifest.clone();
        next_manifest.phase = phase;
        hit_test_failpoint(TestFailpoint::PhasePublication(phase), &self.directory)?;
        if let Err(error) = write_manifest(&self.directory, &next_manifest, false) {
            if matches!(
                &error,
                BatchMutationError::Publication { source, .. } if source.filesystem_applied()
            ) {
                self.manifest = next_manifest;
                self.phase_uncertain = true;
            }
            return Err(error);
        }
        if let Err(error) = hit_test_failpoint(TestFailpoint::PhaseFlush(phase), &self.directory)
            .and_then(|()| sync_manifest_and_directory(&self.directory))
        {
            self.manifest = next_manifest;
            self.phase_uncertain = true;
            return Err(error);
        }
        self.manifest = next_manifest;
        Ok(())
    }

    fn ensure_phase_certain(&self) -> Result<(), BatchMutationError> {
        if self.phase_uncertain {
            return Err(BatchMutationError::UncertainPhase(self.directory.clone()));
        }
        Ok(())
    }

    #[cfg(test)]
    fn test_publish_first_intent_only(&mut self) -> Result<(), BatchMutationError> {
        self.ensure_phase_certain()?;
        if self.manifest.phase == TransactionPhase::Prepared {
            self.change_phase(TransactionPhase::Committing)?;
        }
        publish_intent(
            &self.root,
            &self.directory,
            0,
            &self.manifest.intents[0],
        )
    }
}

#[derive(Debug)]
pub struct RecoveredBatch {
    pub phase: TransactionPhase,
    pub index_events: Vec<ChangeEvent>,
    pub moved_pages: Vec<(VaultPath, VaultPath)>,
    directory: PathBuf,
}

impl RecoveredBatch {
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn finish(self) -> Result<(), BatchMutationError> {
        remove_workspace(&self.directory)
    }
}

pub(crate) fn prepare(
    root: &Path,
    command: &BatchMutationCommand,
) -> Result<PreparedBatch, BatchMutationError> {
    validate_intents(&command.intents)
        .map_err(|error| BatchMutationError::Validation(error.to_string()))?;
    validate_observed_state(root, &command.intents)?;

    let transactions = root.join(".clepsydra").join("transactions");
    create_synced_directory_tree(root, &transactions)?;
    let directory = transactions.join(Uuid::now_v7().to_string());
    create_synced_directory(&directory)?;
    let staged = directory.join("staged");
    let rollback = directory.join("rollback");
    create_synced_directory(&staged)?;
    create_synced_directory(&rollback)?;

    let result = (|| {
        let mut manifest_intents = Vec::with_capacity(command.intents.len());
        for (index, intent) in command.intents.iter().enumerate() {
            let staged_path = staged.join(index.to_string());
            let rollback_path = rollback.join(index.to_string());
            let manifest_intent = match intent {
                BatchPathIntent::Write {
                    path,
                    expected,
                    content,
                } => {
                    write_synced_file(&staged_path, content)?;
                    let before_hash = match expected {
                        ExpectedPathState::Missing => {
                            write_synced_file(&rollback_path, &[])?;
                            None
                        }
                        ExpectedPathState::Bytes(bytes) => {
                            write_synced_file(&rollback_path, bytes)?;
                            Some(content_hash(bytes))
                        }
                    };
                    ManifestIntent::Write {
                        path: path.as_str().to_owned(),
                        before_hash,
                        after_hash: content_hash(content),
                    }
                }
                BatchPathIntent::Move {
                    source,
                    destination,
                    expected_source,
                } => {
                    write_synced_file(&staged_path, expected_source)?;
                    write_synced_file(&rollback_path, expected_source)?;
                    ManifestIntent::Move {
                        source: source.as_str().to_owned(),
                        destination: destination.as_str().to_owned(),
                        source_hash: content_hash(expected_source),
                        destination_was_missing: true,
                    }
                }
                BatchPathIntent::Delete { path, expected } => {
                    write_synced_file(&staged_path, &[])?;
                    write_synced_file(&rollback_path, expected)?;
                    ManifestIntent::Delete {
                        path: path.as_str().to_owned(),
                        before_hash: content_hash(expected),
                    }
                }
            };
            manifest_intents.push(manifest_intent);
        }
        sync_directory(&staged)?;
        sync_directory(&rollback)?;

        let manifest = TransactionManifest {
            phase: TransactionPhase::Prepared,
            intents: manifest_intents,
            index_events: command
                .index_events
                .iter()
                .map(ManifestChangeEvent::from)
                .collect(),
            moved_pages: command
                .moved_pages
                .iter()
                .map(|(source, destination)| {
                    (
                        source.as_str().to_owned(),
                        destination.as_str().to_owned(),
                    )
                })
                .collect(),
        };
        write_manifest(&directory, &manifest, true)?;
        hit_test_failpoint(TestFailpoint::ManifestFlush, &directory)?;
        sync_manifest_and_directory(&directory)?;
        Ok(PreparedBatch {
            root: root.to_path_buf(),
            directory: directory.clone(),
            manifest,
            phase_uncertain: false,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
        let _ = sync_directory(&transactions);
    }
    result
}

pub fn recover_pending(root: &Path) -> Result<Vec<RecoveredBatch>, BatchMutationError> {
    let transactions = root.join(".clepsydra").join("transactions");
    let entries = match fs::read_dir(&transactions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(BatchMutationError::filesystem(
                "read transaction directory",
                &transactions,
                source,
            ));
        }
    };
    sync_transaction_directory(&transactions)?;
    let mut directories = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| {
            BatchMutationError::filesystem("read transaction entry", &transactions, source)
        })?;
        let file_type = entry.file_type().map_err(|source| {
            BatchMutationError::filesystem("inspect transaction entry", &entry.path(), source)
        })?;
        if file_type.is_dir() {
            directories.push(entry.path());
        }
    }
    directories.sort();

    let mut recovered = Vec::new();
    for directory in directories {
        validate_transaction_directory_name(&directory)?;
        let Some(manifest) = read_manifest_if_present(&directory)? else {
            remove_workspace(&directory)?;
            continue;
        };
        validate_manifest_paths(&directory, &manifest)?;
        match manifest.phase {
            TransactionPhase::Prepared => remove_workspace(&directory)?,
            TransactionPhase::Committing => {
                rollback_manifest(root, &directory, &manifest)?;
                remove_workspace(&directory)?;
            }
            TransactionPhase::FilesystemCommitted => {
                let manifest_path = directory.join("manifest.json");
                recovered.push(RecoveredBatch {
                    phase: manifest.phase,
                    index_events: manifest
                        .index_events
                        .iter()
                        .map(|event| change_event_from_manifest(&manifest_path, event))
                        .collect::<Result<_, _>>()?,
                    moved_pages: manifest
                        .moved_pages
                        .iter()
                        .map(|(source, destination)| {
                            Ok((
                                manifest_path_value(&manifest_path, source)?,
                                manifest_path_value(&manifest_path, destination)?,
                            ))
                        })
                        .collect::<Result<_, BatchMutationError>>()?,
                    directory,
                });
            }
        }
    }
    Ok(recovered)
}

impl From<&ChangeEvent> for ManifestChangeEvent {
    fn from(event: &ChangeEvent) -> Self {
        match event {
            ChangeEvent::Upsert(path) => Self::Upsert(path.as_str().to_owned()),
            ChangeEvent::Remove(path) => Self::Remove(path.as_str().to_owned()),
            ChangeEvent::BaseChanged => Self::BaseChanged,
        }
    }
}

fn change_event_from_manifest(
    manifest_path: &Path,
    event: &ManifestChangeEvent,
) -> Result<ChangeEvent, BatchMutationError> {
    match event {
        ManifestChangeEvent::Upsert(path) => Ok(ChangeEvent::Upsert(manifest_path_value(
            manifest_path,
            path,
        )?)),
        ManifestChangeEvent::Remove(path) => Ok(ChangeEvent::Remove(manifest_path_value(
            manifest_path,
            path,
        )?)),
        ManifestChangeEvent::BaseChanged => Ok(ChangeEvent::BaseChanged),
    }
}

fn manifest_path_value(manifest: &Path, path: &str) -> Result<VaultPath, BatchMutationError> {
    let validated =
        VaultPath::new(path).map_err(|error| BatchMutationError::InvalidManifest {
            path: manifest.to_path_buf(),
            message: error.to_string(),
        })?;
    if validated.as_str() != path {
        return Err(BatchMutationError::InvalidManifest {
            path: manifest.to_path_buf(),
            message: format!("noncanonical vault path: {path}"),
        });
    }
    Ok(validated)
}

fn validate_observed_state(
    root: &Path,
    intents: &[BatchPathIntent],
) -> Result<(), BatchMutationError> {
    for intent in intents {
        match intent {
            BatchPathIntent::Write { path, expected, .. } => {
                let absolute = root.join(path.as_str());
                match (read_optional(&absolute)?, expected) {
                    (None, ExpectedPathState::Missing) => {}
                    (Some(observed), ExpectedPathState::Bytes(expected))
                        if observed == *expected => {}
                    _ => return Err(BatchMutationError::Stale(path.as_str().to_owned())),
                }
            }
            BatchPathIntent::Move {
                source,
                destination,
                expected_source,
            } => {
                let source_absolute = root.join(source.as_str());
                if read_optional(&source_absolute)?.as_deref() != Some(expected_source.as_slice()) {
                    return Err(BatchMutationError::Stale(source.as_str().to_owned()));
                }
                let destination_absolute = root.join(destination.as_str());
                if read_optional(&destination_absolute)?.is_some() {
                    return Err(BatchMutationError::Stale(
                        destination.as_str().to_owned(),
                    ));
                }
            }
            BatchPathIntent::Delete { path, expected } => {
                let absolute = root.join(path.as_str());
                if read_optional(&absolute)?.as_deref() != Some(expected.as_slice()) {
                    return Err(BatchMutationError::Stale(path.as_str().to_owned()));
                }
            }
        }
    }
    Ok(())
}

fn publish_intent(
    root: &Path,
    directory: &Path,
    index: usize,
    intent: &ManifestIntent,
) -> Result<(), BatchMutationError> {
    let staged_path = directory.join("staged").join(index.to_string());
    match intent {
        ManifestIntent::Write {
            path,
            before_hash,
            after_hash,
        } => {
            let content = read_verified(&staged_path, after_hash)?;
            let destination = root.join(path);
            publish_file_state(&destination, before_hash.as_deref(), after_hash, &content)
        }
        ManifestIntent::Move {
            source,
            destination,
            source_hash,
            destination_was_missing,
        } => {
            if !destination_was_missing {
                return Err(BatchMutationError::InvalidManifest {
                    path: directory.join("manifest.json"),
                    message: "move destination was not recorded as missing".to_owned(),
                });
            }
            let content = read_verified(&staged_path, source_hash)?;
            let destination = root.join(destination);
            publish_file_state(&destination, None, source_hash, &content)?;
            let source = root.join(source);
            remove_if_hash(&source, source_hash)
        }
        ManifestIntent::Delete { path, before_hash } => {
            remove_if_hash(&root.join(path), before_hash)
        }
    }
}

fn rollback_manifest(
    root: &Path,
    directory: &Path,
    manifest: &TransactionManifest,
) -> Result<(), BatchMutationError> {
    for index in (0..manifest.intents.len()).rev() {
        hit_test_failpoint(TestFailpoint::RollbackPublication(index), directory)?;
        let rollback_path = directory.join("rollback").join(index.to_string());
        match &manifest.intents[index] {
            ManifestIntent::Write {
                path,
                before_hash,
                after_hash,
            } => {
                let destination = root.join(path);
                match before_hash {
                    Some(before_hash) => {
                        let content = read_verified(&rollback_path, before_hash)?;
                        restore_file_state(&destination, before_hash, after_hash, &content)?;
                    }
                    None => remove_after_state(&destination, after_hash)?,
                }
            }
            ManifestIntent::Move {
                source,
                destination,
                source_hash,
                destination_was_missing,
            } => {
                if !destination_was_missing {
                    return Err(BatchMutationError::InvalidManifest {
                        path: directory.join("manifest.json"),
                        message: "move destination was not recorded as missing".to_owned(),
                    });
                }
                let content = read_verified(&rollback_path, source_hash)?;
                remove_after_state(&root.join(destination), source_hash)?;
                restore_missing_file(&root.join(source), source_hash, &content)?;
            }
            ManifestIntent::Delete { path, before_hash } => {
                let content = read_verified(&rollback_path, before_hash)?;
                restore_missing_file(&root.join(path), before_hash, &content)?;
            }
        }
    }
    Ok(())
}

fn publish_file_state(
    path: &Path,
    before_hash: Option<&str>,
    after_hash: &str,
    content: &[u8],
) -> Result<(), BatchMutationError> {
    let observed = observed_hash(path)?;
    if observed.as_deref() == Some(after_hash) {
        return Ok(());
    }
    if observed.as_deref() != before_hash {
        return Err(BatchMutationError::RecoveryConflict(
            path.display().to_string(),
        ));
    }
    let result = match before_hash {
        Some(_) => super::atomic_file::atomic_replace(path, content),
        None => super::atomic_file::atomic_create(path, content),
    };
    result.map_err(|source| BatchMutationError::Publication {
        path: path.to_path_buf(),
        source,
    })
}

fn restore_file_state(
    path: &Path,
    before_hash: &str,
    after_hash: &str,
    content: &[u8],
) -> Result<(), BatchMutationError> {
    match observed_hash(path)?.as_deref() {
        Some(observed) if observed == before_hash => Ok(()),
        Some(observed) if observed == after_hash => super::atomic_file::atomic_replace(path, content)
            .map_err(|source| BatchMutationError::Publication {
                path: path.to_path_buf(),
                source,
            }),
        _ => Err(BatchMutationError::RecoveryConflict(
            path.display().to_string(),
        )),
    }
}

fn restore_missing_file(
    path: &Path,
    before_hash: &str,
    content: &[u8],
) -> Result<(), BatchMutationError> {
    match observed_hash(path)?.as_deref() {
        Some(observed) if observed == before_hash => Ok(()),
        None => super::atomic_file::atomic_create(path, content).map_err(|source| {
            BatchMutationError::Publication {
                path: path.to_path_buf(),
                source,
            }
        }),
        _ => Err(BatchMutationError::RecoveryConflict(
            path.display().to_string(),
        )),
    }
}

fn remove_after_state(path: &Path, after_hash: &str) -> Result<(), BatchMutationError> {
    match observed_hash(path)?.as_deref() {
        None => Ok(()),
        Some(observed) if observed == after_hash => remove_file_durable(path),
        _ => Err(BatchMutationError::RecoveryConflict(
            path.display().to_string(),
        )),
    }
}

fn remove_if_hash(path: &Path, expected_hash: &str) -> Result<(), BatchMutationError> {
    match observed_hash(path)?.as_deref() {
        None => Ok(()),
        Some(observed) if observed == expected_hash => remove_file_durable(path),
        _ => Err(BatchMutationError::RecoveryConflict(
            path.display().to_string(),
        )),
    }
}

fn remove_file_durable(path: &Path) -> Result<(), BatchMutationError> {
    fs::remove_file(path)
        .map_err(|source| BatchMutationError::filesystem("remove file", path, source))?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn content_hash(content: &[u8]) -> String {
    blake3::hash(content).to_hex().to_string()
}

fn observed_hash(path: &Path) -> Result<Option<String>, BatchMutationError> {
    Ok(read_optional(path)?.map(|content| content_hash(&content)))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, BatchMutationError> {
    match fs::read(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(source) => Err(BatchMutationError::filesystem("read file", path, source)),
    }
}

fn read_verified(path: &Path, expected_hash: &str) -> Result<Vec<u8>, BatchMutationError> {
    let content = fs::read(path)
        .map_err(|source| BatchMutationError::filesystem("read workspace file", path, source))?;
    if content_hash(&content) != expected_hash {
        return Err(BatchMutationError::CorruptWorkspace {
            path: path.to_path_buf(),
        });
    }
    Ok(content)
}

fn write_synced_file(path: &Path, content: &[u8]) -> Result<(), BatchMutationError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| BatchMutationError::filesystem("create workspace file", path, source))?;
    file.write_all(content)
        .map_err(|source| BatchMutationError::filesystem("write workspace file", path, source))?;
    file.sync_all()
        .map_err(|source| BatchMutationError::filesystem("sync workspace file", path, source))
}

fn write_manifest(
    directory: &Path,
    manifest: &TransactionManifest,
    create: bool,
) -> Result<(), BatchMutationError> {
    let path = directory.join("manifest.json");
    let content =
        serde_json::to_vec(manifest).map_err(|error| BatchMutationError::InvalidManifest {
            path: path.clone(),
            message: error.to_string(),
        })?;
    let result = if create {
        super::atomic_file::atomic_create(&path, &content)
    } else {
        super::atomic_file::atomic_replace(&path, &content)
    };
    result.map_err(|source| BatchMutationError::Publication { path, source })
}

fn read_manifest_if_present(
    directory: &Path,
) -> Result<Option<TransactionManifest>, BatchMutationError> {
    let path = directory.join("manifest.json");
    let content = match fs::read(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(BatchMutationError::filesystem(
                "read manifest",
                &path,
                source,
            ));
        }
    };
    serde_json::from_slice(&content)
        .map(Some)
        .map_err(|error| BatchMutationError::InvalidManifest {
            path,
            message: error.to_string(),
        })
}

fn validate_transaction_directory_name(directory: &Path) -> Result<(), BatchMutationError> {
    let name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| BatchMutationError::InvalidManifest {
            path: directory.to_path_buf(),
            message: "transaction directory name is not valid UTF-8".to_owned(),
        })?;
    let uuid = Uuid::parse_str(name).map_err(|error| BatchMutationError::InvalidManifest {
        path: directory.to_path_buf(),
        message: format!("invalid transaction UUID: {error}"),
    })?;
    if uuid.to_string() != name {
        return Err(BatchMutationError::InvalidManifest {
            path: directory.to_path_buf(),
            message: "transaction UUID is not canonical".to_owned(),
        });
    }
    Ok(())
}

fn validate_manifest_paths(
    directory: &Path,
    manifest: &TransactionManifest,
) -> Result<(), BatchMutationError> {
    let path = directory.join("manifest.json");
    for intent in &manifest.intents {
        match intent {
            ManifestIntent::Write {
                path: intent_path, ..
            }
            | ManifestIntent::Delete {
                path: intent_path, ..
            } => {
                manifest_path_value(&path, intent_path)?;
            }
            ManifestIntent::Move {
                source,
                destination,
                ..
            } => {
                manifest_path_value(&path, source)?;
                manifest_path_value(&path, destination)?;
            }
        }
    }
    for event in &manifest.index_events {
        match event {
            ManifestChangeEvent::Upsert(event_path)
            | ManifestChangeEvent::Remove(event_path) => {
                manifest_path_value(&path, event_path)?;
            }
            ManifestChangeEvent::BaseChanged => {}
        }
    }
    for (source, destination) in &manifest.moved_pages {
        manifest_path_value(&path, source)?;
        manifest_path_value(&path, destination)?;
    }
    Ok(())
}

fn sync_manifest_and_directory(directory: &Path) -> Result<(), BatchMutationError> {
    let manifest = directory.join("manifest.json");
    fs::File::open(&manifest)
        .and_then(|file| file.sync_all())
        .map_err(|source| BatchMutationError::filesystem("sync manifest", &manifest, source))?;
    sync_directory(directory)
}

fn create_synced_directory_tree(root: &Path, transactions: &Path) -> Result<(), BatchMutationError> {
    let metadata = root.join(".clepsydra");
    if !metadata.exists() {
        fs::create_dir(&metadata).map_err(|source| {
            BatchMutationError::filesystem("create metadata directory", &metadata, source)
        })?;
        sync_directory(root)?;
    }
    if !transactions.exists() {
        fs::create_dir(transactions).map_err(|source| {
            BatchMutationError::filesystem(
                "create transaction directory",
                transactions,
                source,
            )
        })?;
        sync_directory(&metadata)?;
    }
    Ok(())
}

fn create_synced_directory(path: &Path) -> Result<(), BatchMutationError> {
    fs::create_dir(path)
        .map_err(|source| BatchMutationError::filesystem("create directory", path, source))?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), BatchMutationError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| BatchMutationError::filesystem("sync directory", path, source))
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), BatchMutationError> {
    Ok(())
}

fn sync_transaction_directory(path: &Path) -> Result<(), BatchMutationError> {
    let result = sync_directory(path);
    if result.is_ok() {
        clear_workspace_parent_sync_pending();
    }
    result
}

fn remove_workspace(directory: &Path) -> Result<(), BatchMutationError> {
    hit_test_failpoint(TestFailpoint::WorkspaceRemoval, directory)?;
    match fs::remove_dir_all(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(BatchMutationError::filesystem(
                "remove transaction workspace",
                directory,
                source,
            ));
        }
    }
    mark_workspace_parent_sync_pending();
    hit_test_failpoint(TestFailpoint::WorkspaceParentSync, directory)?;
    if let Some(parent) = directory.parent() {
        sync_transaction_directory(parent)?;
    }
    Ok(())
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TestFailpoint {
    ManifestFlush,
    Publication(usize),
    PhasePublication(TransactionPhase),
    PhaseFlush(TransactionPhase),
    RollbackPublication(usize),
    WorkspaceRemoval,
    WorkspaceParentSync,
}

#[cfg(not(test))]
#[derive(Debug, Clone, Copy)]
enum TestFailpoint {
    ManifestFlush,
    Publication(usize),
    PhaseFlush(TransactionPhase),
    RollbackPublication(usize),
    WorkspaceParentSync,
    PhasePublication(TransactionPhase),
    WorkspaceRemoval,
}

#[cfg(test)]
thread_local! {
    static TEST_FAILPOINT: std::cell::RefCell<Option<TestFailpoint>> =
        const { std::cell::RefCell::new(None) };
    static WORKSPACE_PARENT_SYNC_PENDING: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn mark_workspace_parent_sync_pending() {
    WORKSPACE_PARENT_SYNC_PENDING.set(true);
}

#[cfg(not(test))]
fn mark_workspace_parent_sync_pending() {}

#[cfg(test)]
fn clear_workspace_parent_sync_pending() {
    WORKSPACE_PARENT_SYNC_PENDING.set(false);
}

#[cfg(not(test))]
fn clear_workspace_parent_sync_pending() {}

#[cfg(test)]
fn workspace_parent_sync_pending() -> bool {
    WORKSPACE_PARENT_SYNC_PENDING.get()
}

#[cfg(test)]
pub(crate) struct TestFailpointGuard;

#[cfg(test)]
impl Drop for TestFailpointGuard {
    fn drop(&mut self) {
        TEST_FAILPOINT.with(|failpoint| *failpoint.borrow_mut() = None);
    }
}

#[cfg(test)]
pub(crate) fn fail_once_at(failpoint: TestFailpoint) -> TestFailpointGuard {
    TEST_FAILPOINT.with(|current| *current.borrow_mut() = Some(failpoint));
    TestFailpointGuard
}

#[cfg(test)]
fn hit_test_failpoint(
    failpoint: TestFailpoint,
    path: &Path,
) -> Result<(), BatchMutationError> {
    let should_fail = TEST_FAILPOINT.with(|current| {
        if current.borrow().as_ref() == Some(&failpoint) {
            current.borrow_mut().take();
            true
        } else {
            false
        }
    });
    if should_fail {
        return Err(BatchMutationError::filesystem(
            "execute deterministic test failpoint",
            path,
            io::Error::other(format!("{failpoint:?}")),
        ));
    }
    Ok(())
}

#[cfg(not(test))]
fn hit_test_failpoint(
    _failpoint: TestFailpoint,
    _path: &Path,
) -> Result<(), BatchMutationError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    use tempfile::TempDir;

    struct Fixture {
        directory: TempDir,
    }

    impl Fixture {
        fn root(&self) -> &Path {
            self.directory.path()
        }
    }

    fn fixture_with_files(files: &[(&str, &[u8])]) -> Fixture {
        let fixture = Fixture {
            directory: tempfile::tempdir().unwrap(),
        };
        for (path, content) in files {
            let path = fixture.root().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        fixture
    }

    fn fixture_with_file(path: &str, content: &[u8]) -> Fixture {
        fixture_with_files(&[(path, content)])
    }

    fn replace(path: &str, before: &[u8], after: &[u8]) -> BatchMutationCommand {
        BatchMutationCommand {
            intents: vec![BatchPathIntent::Write {
                path: VaultPath::new(path).unwrap(),
                expected: ExpectedPathState::Bytes(before.to_vec()),
                content: after.to_vec(),
            }],
            index_events: vec![ChangeEvent::Upsert(VaultPath::new(path).unwrap())],
            moved_pages: vec![],
        }
    }

    fn replace_two_files() -> BatchMutationCommand {
        BatchMutationCommand {
            intents: vec![
                BatchPathIntent::Write {
                    path: VaultPath::new("a.md").unwrap(),
                    expected: ExpectedPathState::Bytes(b"before-a".to_vec()),
                    content: b"after-a".to_vec(),
                },
                BatchPathIntent::Write {
                    path: VaultPath::new("b.md").unwrap(),
                    expected: ExpectedPathState::Bytes(b"before-b".to_vec()),
                    content: b"after-b".to_vec(),
                },
            ],
            index_events: vec![
                ChangeEvent::Upsert(VaultPath::new("a.md").unwrap()),
                ChangeEvent::Upsert(VaultPath::new("b.md").unwrap()),
            ],
            moved_pages: vec![],
        }
    }

    fn write_missing(path: &str, content: &[u8]) -> BatchPathIntent {
        BatchPathIntent::Write {
            path: VaultPath::new(path).unwrap(),
            expected: ExpectedPathState::Missing,
            content: content.to_vec(),
        }
    }

    #[test]
    fn affected_paths_are_sorted_and_deduplicated() {
        let command = BatchMutationCommand {
            intents: vec![
                BatchPathIntent::Move {
                    source: VaultPath::new("z.md").unwrap(),
                    destination: VaultPath::new("a.md").unwrap(),
                    expected_source: b"z".to_vec(),
                },
                BatchPathIntent::Write {
                    path: VaultPath::new("z.md").unwrap(),
                    expected: ExpectedPathState::Missing,
                    content: b"new".to_vec(),
                },
            ],
            index_events: vec![],
            moved_pages: vec![],
        };
        assert_eq!(
            command
                .affected_paths()
                .iter()
                .map(VaultPath::as_str)
                .collect::<Vec<_>>(),
            vec!["a.md", "z.md"]
        );
    }

    #[test]
    fn duplicate_final_destinations_are_rejected() {
        let error = validate_intents(&[
            write_missing("same.md", b"one"),
            write_missing("same.md", b"two"),
        ])
        .unwrap_err();
        assert!(error.to_string().contains("same.md"));
    }

    #[test]
    fn empty_commands_are_rejected() {
        let error = validate_intents(&[]).unwrap_err();
        assert!(error.to_string().contains("empty"));
    }

    #[test]
    fn moves_must_change_the_path() {
        let path = VaultPath::new("same.md").unwrap();
        let error = validate_intents(&[BatchPathIntent::Move {
            source: path.clone(),
            destination: path,
            expected_source: b"before".to_vec(),
        }])
        .unwrap_err();
        assert!(error.to_string().contains("same.md"));
    }

    #[test]
    fn conflicting_move_sources_are_rejected() {
        let error = validate_intents(&[
            BatchPathIntent::Move {
                source: VaultPath::new("source.md").unwrap(),
                destination: VaultPath::new("first.md").unwrap(),
                expected_source: b"before".to_vec(),
            },
            BatchPathIntent::Move {
                source: VaultPath::new("source.md").unwrap(),
                destination: VaultPath::new("second.md").unwrap(),
                expected_source: b"before".to_vec(),
            },
        ])
        .unwrap_err();
        assert!(error.to_string().contains("source.md"));
    }

    #[test]
    fn transaction_phases_have_stable_serialized_values() {
        for (phase, serialized) in [
            (TransactionPhase::Prepared, r#""prepared""#),
            (TransactionPhase::Committing, r#""committing""#),
            (
                TransactionPhase::FilesystemCommitted,
                r#""filesystem_committed""#,
            ),
        ] {
            assert_eq!(serde_json::to_string(&phase).unwrap(), serialized);
            assert_eq!(
                serde_json::from_str::<TransactionPhase>(serialized).unwrap(),
                phase
            );
        }
    }
    #[test]
    fn prepared_transaction_does_not_change_destinations() {
        let fixture = fixture_with_file("a.md", b"before");
        let prepared =
            prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();

        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
        assert!(prepared.directory().join("manifest.json").is_file());
        assert!(prepared.directory().join("staged/0").is_file());
        assert!(prepared.directory().join("rollback/0").is_file());
    }

    #[test]
    fn committing_transaction_recovers_exact_pre_state() {
        let fixture =
            fixture_with_files(&[("a.md", b"before-a"), ("b.md", b"before-b")]);
        let mut prepared = prepare(fixture.root(), &replace_two_files()).unwrap();
        prepared.test_publish_first_intent_only().unwrap();
        drop(prepared);

        assert!(recover_pending(fixture.root()).unwrap().is_empty());
        assert_eq!(
            fs::read(fixture.root().join("a.md")).unwrap(),
            b"before-a"
        );
        assert_eq!(
            fs::read(fixture.root().join("b.md")).unwrap(),
            b"before-b"
        );
        assert!(recover_pending(fixture.root()).unwrap().is_empty());
    }

    #[test]
    fn filesystem_committed_transaction_is_reported_for_index_reconciliation() {
        let fixture = fixture_with_file("a.md", b"before");
        let mut prepared =
            prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();
        prepared.publish().unwrap();
        prepared.mark_filesystem_committed().unwrap();
        let directory = prepared.directory().to_path_buf();
        drop(prepared);

        let recovered = recover_pending(fixture.root()).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].phase, TransactionPhase::FilesystemCommitted);
        assert_eq!(recovered[0].index_events.len(), 1);
        assert!(matches!(
            &recovered[0].index_events[0],
            ChangeEvent::Upsert(path) if path.as_str() == "a.md"
        ));
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"after");

        let mut recovered_again = recover_pending(fixture.root()).unwrap();
        assert_eq!(recovered_again.len(), 1);
        assert_eq!(recovered_again[0].directory(), directory);
        recovered_again.pop().unwrap().finish().unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn interrupted_move_recovery_restores_source_and_missing_destination() {
        let fixture = fixture_with_file("source.md", b"source");
        let command = BatchMutationCommand {
            intents: vec![BatchPathIntent::Move {
                source: VaultPath::new("source.md").unwrap(),
                destination: VaultPath::new("destination.md").unwrap(),
                expected_source: b"source".to_vec(),
            }],
            index_events: vec![],
            moved_pages: vec![(
                VaultPath::new("source.md").unwrap(),
                VaultPath::new("destination.md").unwrap(),
            )],
        };
        let mut prepared = prepare(fixture.root(), &command).unwrap();
        prepared.test_publish_first_intent_only().unwrap();
        drop(prepared);

        recover_pending(fixture.root()).unwrap();
        assert_eq!(
            fs::read(fixture.root().join("source.md")).unwrap(),
            b"source"
        );
        assert!(!fixture.root().join("destination.md").exists());
        recover_pending(fixture.root()).unwrap();
        assert_eq!(
            fs::read(fixture.root().join("source.md")).unwrap(),
            b"source"
        );
        assert!(!fixture.root().join("destination.md").exists());
    }

    #[test]
    fn rollback_recovery_resumes_after_a_rollback_publication_failure() {
        let fixture =
            fixture_with_files(&[("a.md", b"before-a"), ("b.md", b"before-b")]);
        let mut prepared = prepare(fixture.root(), &replace_two_files()).unwrap();
        prepared.publish().unwrap();
        let _failure = fail_once_at(TestFailpoint::RollbackPublication(0));

        assert!(prepared.rollback().is_err());
        drop(prepared);
        assert_eq!(
            fs::read(fixture.root().join("a.md")).unwrap(),
            b"after-a"
        );
        assert_eq!(
            fs::read(fixture.root().join("b.md")).unwrap(),
            b"before-b"
        );
        recover_pending(fixture.root()).unwrap();
        assert_eq!(
            fs::read(fixture.root().join("a.md")).unwrap(),
            b"before-a"
        );
        assert_eq!(
            fs::read(fixture.root().join("b.md")).unwrap(),
            b"before-b"
        );
    }

    #[test]
    fn indexed_publication_failure_is_recovered() {
        let fixture =
            fixture_with_files(&[("a.md", b"before-a"), ("b.md", b"before-b")]);
        let mut prepared = prepare(fixture.root(), &replace_two_files()).unwrap();
        let _failure = fail_once_at(TestFailpoint::Publication(1));

        assert!(prepared.publish().is_err());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"after-a");
        assert_eq!(
            fs::read(fixture.root().join("b.md")).unwrap(),
            b"before-b"
        );
        drop(prepared);
        recover_pending(fixture.root()).unwrap();
        assert_eq!(
            fs::read(fixture.root().join("a.md")).unwrap(),
            b"before-a"
        );
        assert_eq!(
            fs::read(fixture.root().join("b.md")).unwrap(),
            b"before-b"
        );
    }

    #[test]
    fn phase_flush_failure_is_recovered_before_publication() {
        let fixture = fixture_with_file("a.md", b"before");
        let mut prepared =
            prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();
        let _failure =
            fail_once_at(TestFailpoint::PhaseFlush(TransactionPhase::Committing));

        assert!(prepared.publish().is_err());
        assert!(prepared.publish().is_err());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
        drop(prepared);
        recover_pending(fixture.root()).unwrap();
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
    }

    #[test]
    fn manifest_flush_failure_never_changes_destinations() {
        let fixture = fixture_with_file("a.md", b"before");
        let _failure = fail_once_at(TestFailpoint::ManifestFlush);

        assert!(prepare(fixture.root(), &replace("a.md", b"before", b"after")).is_err());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
        assert!(recover_pending(fixture.root()).unwrap().is_empty());
    }

    #[test]
    fn rollback_restores_deleted_and_previously_missing_paths() {
        let fixture = fixture_with_file("deleted.md", b"before");
        let command = BatchMutationCommand {
            intents: vec![
                write_missing("created.md", b"created"),
                BatchPathIntent::Delete {
                    path: VaultPath::new("deleted.md").unwrap(),
                    expected: b"before".to_vec(),
                },
            ],
            index_events: vec![],
            moved_pages: vec![],
        };
        let mut prepared = prepare(fixture.root(), &command).unwrap();
        prepared.publish().unwrap();

        prepared.rollback().unwrap();
        assert!(!fixture.root().join("created.md").exists());
        assert_eq!(
            fs::read(fixture.root().join("deleted.md")).unwrap(),
            b"before"
        );
    }

    #[test]
    fn finished_transaction_removes_its_workspace() {
        let fixture = fixture_with_file("a.md", b"before");
        let mut prepared =
            prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();
        prepared.publish().unwrap();
        prepared.mark_filesystem_committed().unwrap();
        let directory = prepared.directory().to_path_buf();

        prepared.finish().unwrap();
        assert!(!directory.exists());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"after");
    }

    #[test]
    fn prepared_workspace_removal_can_be_retried() {
        let fixture = fixture_with_file("a.md", b"before");
        let prepared =
            prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();
        let directory = prepared.directory().to_path_buf();
        drop(prepared);
        let _failure = fail_once_at(TestFailpoint::WorkspaceRemoval);

        assert!(recover_pending(fixture.root()).is_err());
        assert!(directory.is_dir());
        recover_pending(fixture.root()).unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn recovery_removes_valid_prepared_debris_without_a_manifest() {
        let fixture = fixture_with_file("a.md", b"before");
        let directory = fixture
            .root()
            .join(".clepsydra/transactions")
            .join(Uuid::now_v7().to_string());
        fs::create_dir_all(directory.join("staged")).unwrap();
        fs::create_dir(directory.join("rollback")).unwrap();
        fs::write(directory.join("staged/0"), b"after").unwrap();
        fs::write(directory.join("rollback/0"), b"before").unwrap();

        assert!(recover_pending(fixture.root()).unwrap().is_empty());
        assert!(!directory.exists());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
        assert!(recover_pending(fixture.root()).unwrap().is_empty());
    }

    #[test]
    fn failed_phase_publication_retry_remains_recoverable() {
        let fixture =
            fixture_with_files(&[("a.md", b"before-a"), ("b.md", b"before-b")]);
        let mut prepared = prepare(fixture.root(), &replace_two_files()).unwrap();
        let _phase_failure =
            fail_once_at(TestFailpoint::PhasePublication(TransactionPhase::Committing));

        assert!(prepared.publish().is_err());
        let _publication_failure = fail_once_at(TestFailpoint::Publication(1));
        assert!(prepared.publish().is_err());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"after-a");
        drop(prepared);

        recover_pending(fixture.root()).unwrap();
        assert_eq!(
            fs::read(fixture.root().join("a.md")).unwrap(),
            b"before-a"
        );
        assert_eq!(
            fs::read(fixture.root().join("b.md")).unwrap(),
            b"before-b"
        );
    }

    #[test]
    fn recovery_rejects_out_of_vault_manifest_paths_before_mutation() {
        let container = tempfile::tempdir().unwrap();
        let root = container.path().join("vault");
        fs::create_dir(&root).unwrap();
        let outside = container.path().join("outside.md");
        fs::write(&outside, b"outside").unwrap();
        let directory = root
            .join(".clepsydra/transactions")
            .join(Uuid::now_v7().to_string());
        fs::create_dir_all(directory.join("rollback")).unwrap();
        fs::create_dir(directory.join("staged")).unwrap();
        fs::write(directory.join("rollback/0"), b"outside").unwrap();
        fs::write(directory.join("staged/0"), b"outside").unwrap();
        let manifest = TransactionManifest {
            phase: TransactionPhase::Committing,
            intents: vec![ManifestIntent::Move {
                source: "source.md".to_owned(),
                destination: "../outside.md".to_owned(),
                source_hash: content_hash(b"outside"),
                destination_was_missing: true,
            }],
            index_events: vec![],
            moved_pages: vec![],
        };
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert!(matches!(
            recover_pending(&root),
            Err(BatchMutationError::InvalidManifest { .. })
        ));
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert!(!root.join("source.md").exists());
    }

    #[test]
    fn corrupt_move_rollback_keeps_the_published_destination() {
        let fixture = fixture_with_file("source.md", b"source");
        let command = BatchMutationCommand {
            intents: vec![BatchPathIntent::Move {
                source: VaultPath::new("source.md").unwrap(),
                destination: VaultPath::new("destination.md").unwrap(),
                expected_source: b"source".to_vec(),
            }],
            index_events: vec![],
            moved_pages: vec![],
        };
        let mut prepared = prepare(fixture.root(), &command).unwrap();
        prepared.publish().unwrap();
        let directory = prepared.directory().to_path_buf();
        drop(prepared);
        fs::write(directory.join("rollback/0"), b"corrupt").unwrap();

        assert!(matches!(
            recover_pending(fixture.root()),
            Err(BatchMutationError::CorruptWorkspace { .. })
        ));
        assert_eq!(
            fs::read(fixture.root().join("destination.md")).unwrap(),
            b"source"
        );
        assert!(!fixture.root().join("source.md").exists());
    }

    #[test]
    fn workspace_parent_sync_failure_is_retryable_after_unlink() {
        let fixture = fixture_with_file("a.md", b"before");
        let prepared =
            prepare(fixture.root(), &replace("a.md", b"before", b"after")).unwrap();
        let directory = prepared.directory().to_path_buf();
        drop(prepared);
        let _failure = fail_once_at(TestFailpoint::WorkspaceParentSync);

        assert!(recover_pending(fixture.root()).is_err());
        assert!(workspace_parent_sync_pending());
        assert!(!directory.exists());
        assert!(recover_pending(fixture.root()).unwrap().is_empty());
        assert!(!workspace_parent_sync_pending());
        assert_eq!(fs::read(fixture.root().join("a.md")).unwrap(), b"before");
    }

}
