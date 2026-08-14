use std::cmp::Ordering;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::atomic_file::install_noreplace;
use super::path::VaultPath;

pub const RUBBISH_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RubbishManifest {
    pub version: u32,
    pub item_id: Uuid,
    pub page_id: Uuid,
    pub original_path: String,
    pub title: String,
    pub kind: String,
    pub deleted_at: DateTime<Utc>,
    pub archive_url: Option<String>,
}

impl RubbishManifest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        item_id: Uuid,
        page_id: Uuid,
        original_path: &str,
        title: impl Into<String>,
        kind: impl Into<String>,
        deleted_at: DateTime<Utc>,
        archive_url: Option<String>,
    ) -> Result<Self, RubbishItemValidationError> {
        let original_path = validate_original_path(original_path)?;
        Ok(Self {
            version: RUBBISH_MANIFEST_VERSION,
            item_id,
            page_id,
            original_path: original_path.as_str().to_owned(),
            title: title.into(),
            kind: kind.into(),
            deleted_at,
            archive_url,
        })
    }

    pub(crate) fn validate(&self) -> Result<(), RubbishItemValidationError> {
        if self.version != RUBBISH_MANIFEST_VERSION {
            return Err(RubbishItemValidationError::UnsupportedManifestVersion {
                version: u64::from(self.version),
            });
        }
        validate_original_path(&self.original_path)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RubbishItem {
    pub manifest: RubbishManifest,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RubbishListEntry {
    Valid(RubbishManifest),
    Invalid { item_id: String, error: String },
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum RubbishItemValidationError {
    #[error("invalid rubbish item ID {item_id:?}: {message}")]
    MalformedItemId { item_id: String, message: String },
    #[error("malformed rubbish manifest JSON: {message}")]
    MalformedManifestJson { message: String },
    #[error("invalid rubbish manifest schema: {message}")]
    InvalidManifestSchema { message: String },
    #[error("unsupported rubbish manifest version {version}")]
    UnsupportedManifestVersion { version: u64 },
    #[error(
        "manifest item ID {manifest_item_id} does not match directory item ID {directory_item_id}"
    )]
    ManifestItemIdMismatch {
        directory_item_id: Uuid,
        manifest_item_id: Uuid,
    },
    #[error("invalid original vault path {path:?}: {message}")]
    InvalidOriginalPath { path: String, message: String },
    #[error("original vault path is not Markdown: {path}")]
    OriginalPathNotMarkdown { path: String },
    #[error("invalid rubbish item layout: {message}")]
    InvalidItemLayout { message: String },
}

#[derive(Debug, Error)]
pub enum RubbishStoreError {
    #[error("invalid rubbish item {item_id:?}: {source}")]
    InvalidItem {
        item_id: String,
        #[source]
        source: RubbishItemValidationError,
    },
    #[error("rubbish item already exists: {item_id}")]
    ItemAlreadyExists { item_id: Uuid },
    #[error("prepared rubbish item has already been published: {item_id}")]
    PreparedItemAlreadyPublished { item_id: Uuid },
    #[error("failed to serialize rubbish manifest for {item_id}: {source}")]
    SerializeManifest {
        item_id: Uuid,
        #[source]
        source: serde_json::Error,
    },
    #[error("rubbish item state conflicts with the expected transaction state: {item_id}")]
    ItemStateConflict { item_id: Uuid },
    #[error("failed to {operation} {path}: {source}")]
    Filesystem {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl RubbishStoreError {
    fn invalid(item_id: &str, source: RubbishItemValidationError) -> Self {
        Self::InvalidItem {
            item_id: item_id.to_owned(),
            source,
        }
    }

    fn filesystem(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::Filesystem {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RubbishStore {
    root: PathBuf,
}

impl RubbishStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    /// Open the authoritative rubbish store beneath a vault root.
    pub fn for_vault(vault_root: impl AsRef<Path>) -> Self {
        Self::new(vault_root.as_ref().join(".clepsydra/rubbish"))
    }

    pub fn prepare_item(
        &self,
        item_id: &str,
        manifest: &RubbishManifest,
        bytes: &[u8],
    ) -> Result<PreparedRubbishItem, RubbishStoreError> {
        let parsed_item_id =
            parse_item_id(item_id).map_err(|error| RubbishStoreError::invalid(item_id, error))?;
        if parsed_item_id != manifest.item_id {
            return Err(RubbishStoreError::invalid(
                item_id,
                RubbishItemValidationError::ManifestItemIdMismatch {
                    directory_item_id: parsed_item_id,
                    manifest_item_id: manifest.item_id,
                },
            ));
        }
        manifest
            .validate()
            .map_err(|error| RubbishStoreError::invalid(item_id, error))?;
        let manifest_bytes = serde_json::to_vec(manifest).map_err(|source| {
            RubbishStoreError::SerializeManifest {
                item_id: parsed_item_id,
                source,
            }
        })?;

        self.ensure_root()?;
        let staging_dir = self.root.join(format!(
            ".stage-{parsed_item_id}-{}",
            Uuid::now_v7()
        ));
        fs::create_dir(&staging_dir).map_err(|source| {
            RubbishStoreError::filesystem("create rubbish staging directory", &staging_dir, source)
        })?;

        let preparation = (|| {
            sync_directory(&self.root)?;
            write_synced_file(&staging_dir.join("page.md"), bytes)?;
            write_synced_file(&staging_dir.join("manifest.json"), &manifest_bytes)?;
            sync_directory(&staging_dir)
        })();
        if let Err(error) = preparation {
            let _ = fs::remove_dir_all(&staging_dir);
            let _ = sync_directory(&self.root);
            return Err(error);
        }

        Ok(PreparedRubbishItem {
            item_id: parsed_item_id,
            staging_dir,
            item_dir: self.item_dir(parsed_item_id),
            root: self.root.clone(),
            published: false,
        })
    }

    /// Read and validate one item's manifest and physical layout without
    /// loading its page payload.
    pub fn read_manifest(&self, item_id: &str) -> Result<RubbishManifest, RubbishStoreError> {
        let parsed_item_id =
            parse_item_id(item_id).map_err(|error| RubbishStoreError::invalid(item_id, error))?;
        self.validate_root_if_present()?;

        let item_dir = self.item_dir(parsed_item_id);
        let metadata = fs::symlink_metadata(&item_dir).map_err(|source| {
            RubbishStoreError::filesystem("inspect rubbish item directory", &item_dir, source)
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(RubbishStoreError::invalid(
                item_id,
                RubbishItemValidationError::InvalidItemLayout {
                    message: "item path is not a physical directory".to_owned(),
                },
            ));
        }

        let manifest_bytes = read_physical_item_file(
            &self.manifest_path(parsed_item_id),
            item_id,
            "rubbish manifest",
        )?;
        let manifest = parse_manifest(&manifest_bytes)
            .map_err(|error| RubbishStoreError::invalid(item_id, error))?;
        if manifest.item_id != parsed_item_id {
            return Err(RubbishStoreError::invalid(
                item_id,
                RubbishItemValidationError::ManifestItemIdMismatch {
                    directory_item_id: parsed_item_id,
                    manifest_item_id: manifest.item_id,
                },
            ));
        }
        validate_physical_item_file(&self.page_path(parsed_item_id), item_id, "rubbish page")?;
        Ok(manifest)
    }

    pub fn read_item(&self, item_id: &str) -> Result<RubbishItem, RubbishStoreError> {
        let manifest = self.read_manifest(item_id)?;
        let bytes =
            read_physical_item_file(&self.page_path(manifest.item_id), item_id, "rubbish page")?;
        Ok(RubbishItem { manifest, bytes })
    }

    pub fn list_entries(&self) -> Result<Vec<RubbishListEntry>, RubbishStoreError> {
        match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(RubbishStoreError::filesystem(
                    "inspect rubbish root",
                    &self.root,
                    source,
                ));
            }
            Ok(_) => self.validate_root_if_present()?,
        }

        let directory = fs::read_dir(&self.root).map_err(|source| {
            RubbishStoreError::filesystem("enumerate rubbish root", &self.root, source)
        })?;
        let mut entries = Vec::new();
        for entry in directory {
            let entry = entry.map_err(|source| {
                RubbishStoreError::filesystem("read rubbish directory entry", &self.root, source)
            })?;
            let item_id = entry.file_name().to_string_lossy().into_owned();
            if item_id.starts_with(".stage-") {
                continue;
            }
            let file_type = entry.file_type().map_err(|source| {
                RubbishStoreError::filesystem(
                    "inspect rubbish directory entry",
                    &entry.path(),
                    source,
                )
            })?;
            if file_type.is_symlink() || !file_type.is_dir() {
                entries.push(RubbishListEntry::Invalid {
                    item_id,
                    error: RubbishItemValidationError::InvalidItemLayout {
                        message: "item path is not a physical directory".to_owned(),
                    }
                    .to_string(),
                });
                continue;
            }
            match self.read_manifest(&item_id) {
                Ok(manifest) => entries.push(RubbishListEntry::Valid(manifest)),
                Err(error) => entries.push(RubbishListEntry::Invalid {
                    item_id,
                    error: error.to_string(),
                }),
            }
        }
        entries.sort_by(compare_list_entries);
        Ok(entries)
    }

    pub(crate) fn read_item_if_exists(
        &self,
        item_id: Uuid,
    ) -> Result<Option<RubbishItem>, RubbishStoreError> {
        let item_dir = self.item_dir(item_id);
        match fs::symlink_metadata(&item_dir) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(source) => Err(RubbishStoreError::filesystem(
                "inspect rubbish item directory",
                &item_dir,
                source,
            )),
            Ok(_) => self.read_item(&item_id.to_string()).map(Some),
        }
    }

    pub(crate) fn publish_transaction_item(
        &self,
        expected: &RubbishItem,
        prepared_dir: &Path,
    ) -> Result<(), RubbishStoreError> {
        self.ensure_root()?;
        let item_id = expected.manifest.item_id;
        let item_dir = self.item_dir(item_id);
        match fs::symlink_metadata(&item_dir) {
            Ok(_) => {
                if prepared_dir.exists()
                    || self.read_item(&item_id.to_string())? != *expected
                {
                    return Err(RubbishStoreError::ItemStateConflict { item_id });
                }
                return Ok(());
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(source) => {
                return Err(RubbishStoreError::filesystem(
                    "inspect rubbish item directory",
                    &item_dir,
                    source,
                ));
            }
        }

        let prepared = read_item_directory(prepared_dir, item_id)?;
        if prepared != *expected {
            return Err(RubbishStoreError::ItemStateConflict { item_id });
        }
        install_noreplace(prepared_dir, &item_dir).map_err(|source| {
            if source.kind() == ErrorKind::AlreadyExists {
                RubbishStoreError::ItemAlreadyExists { item_id }
            } else {
                RubbishStoreError::filesystem(
                    "publish transaction rubbish item",
                    &item_dir,
                    source,
                )
            }
        })?;
        sync_directory(&self.root)?;
        sync_directory_parent(prepared_dir)
    }

    pub(crate) fn withdraw_transaction_item(
        &self,
        expected: &RubbishItem,
        transaction_dir: &Path,
    ) -> Result<(), RubbishStoreError> {
        let item_id = expected.manifest.item_id;
        let item_dir = self.item_dir(item_id);
        let final_item = self.read_item_if_exists(item_id)?;
        let transaction_item = match fs::symlink_metadata(transaction_dir) {
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(source) => {
                return Err(RubbishStoreError::filesystem(
                    "inspect transaction rubbish item",
                    transaction_dir,
                    source,
                ));
            }
            Ok(_) => Some(read_item_directory(transaction_dir, item_id)?),
        };

        match (final_item, transaction_item) {
            (Some(final_item), None) if final_item == *expected => {
                fs::rename(&item_dir, transaction_dir).map_err(|source| {
                    RubbishStoreError::filesystem(
                        "withdraw transaction rubbish item",
                        &item_dir,
                        source,
                    )
                })?;
                sync_directory(&self.root)?;
                sync_directory_parent(transaction_dir)
            }
            (None, Some(transaction_item)) if transaction_item == *expected => Ok(()),
            _ => Err(RubbishStoreError::ItemStateConflict { item_id }),
        }
    }

    fn ensure_root(&self) -> Result<(), RubbishStoreError> {
        match fs::symlink_metadata(&self.root) {
            Ok(_) => self.validate_root_if_present(),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(&self.root).map_err(|source| {
                    RubbishStoreError::filesystem("create rubbish root", &self.root, source)
                })?;
                sync_directory_parent(&self.root)
            }
            Err(source) => Err(RubbishStoreError::filesystem(
                "inspect rubbish root",
                &self.root,
                source,
            )),
        }
    }

    fn validate_root_if_present(&self) -> Result<(), RubbishStoreError> {
        let metadata = fs::symlink_metadata(&self.root).map_err(|source| {
            RubbishStoreError::filesystem("inspect rubbish root", &self.root, source)
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(RubbishStoreError::filesystem(
                "validate rubbish root",
                &self.root,
                io::Error::new(
                    ErrorKind::InvalidData,
                    "rubbish root is not a physical directory",
                ),
            ));
        }
        Ok(())
    }

    fn item_dir(&self, item_id: Uuid) -> PathBuf {
        self.root.join(item_id.to_string())
    }

    fn page_path(&self, item_id: Uuid) -> PathBuf {
        self.item_dir(item_id).join("page.md")
    }

    fn manifest_path(&self, item_id: Uuid) -> PathBuf {
        self.item_dir(item_id).join("manifest.json")
    }
}

#[derive(Debug)]
pub struct PreparedRubbishItem {
    item_id: Uuid,
    staging_dir: PathBuf,
    item_dir: PathBuf,
    root: PathBuf,
    published: bool,
}

impl PreparedRubbishItem {
    pub fn publish(&mut self) -> Result<(), RubbishStoreError> {
        if self.published {
            return Err(RubbishStoreError::PreparedItemAlreadyPublished {
                item_id: self.item_id,
            });
        }
        match install_noreplace(&self.staging_dir, &self.item_dir) {
            Ok(()) => {
                self.published = true;
                sync_directory(&self.root)
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                Err(RubbishStoreError::ItemAlreadyExists {
                    item_id: self.item_id,
                })
            }
            Err(source) => Err(RubbishStoreError::filesystem(
                "publish rubbish item directory",
                &self.item_dir,
                source,
            )),
        }
    }

    pub fn cleanup(&mut self) -> Result<(), RubbishStoreError> {
        if self.published {
            return Ok(());
        }
        match fs::remove_dir_all(&self.staging_dir) {
            Ok(()) => {
                self.published = true;
                sync_directory(&self.root)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.published = true;
                Ok(())
            }
            Err(source) => Err(RubbishStoreError::filesystem(
                "remove rubbish staging directory",
                &self.staging_dir,
                source,
            )),
        }
    }
}

impl Drop for PreparedRubbishItem {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.staging_dir);
            let _ = sync_directory(&self.root);
        }
    }
}

fn parse_item_id(item_id: &str) -> Result<Uuid, RubbishItemValidationError> {
    Uuid::parse_str(item_id).map_err(|error| RubbishItemValidationError::MalformedItemId {
        item_id: item_id.to_owned(),
        message: error.to_string(),
    })
}

fn validate_original_path(path: &str) -> Result<VaultPath, RubbishItemValidationError> {
    let validated =
        VaultPath::new(path).map_err(|error| RubbishItemValidationError::InvalidOriginalPath {
            path: path.to_owned(),
            message: error.to_string(),
        })?;
    if validated.as_str() != path {
        return Err(RubbishItemValidationError::InvalidOriginalPath {
            path: path.to_owned(),
            message: format!("path is not normalized; expected {}", validated.as_str()),
        });
    }
    if validated.extension() != Some("md") {
        return Err(RubbishItemValidationError::OriginalPathNotMarkdown {
            path: path.to_owned(),
        });
    }
    Ok(validated)
}

fn parse_manifest(bytes: &[u8]) -> Result<RubbishManifest, RubbishItemValidationError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| {
        RubbishItemValidationError::MalformedManifestJson {
            message: error.to_string(),
        }
    })?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| RubbishItemValidationError::InvalidManifestSchema {
            message: "version must be an unsigned integer".to_owned(),
        })?;
    if version != u64::from(RUBBISH_MANIFEST_VERSION) {
        return Err(RubbishItemValidationError::UnsupportedManifestVersion { version });
    }
    let manifest: RubbishManifest = serde_json::from_value(value).map_err(|error| {
        RubbishItemValidationError::InvalidManifestSchema {
            message: error.to_string(),
        }
    })?;
    manifest.validate()?;
    Ok(manifest)
}

fn compare_list_entries(left: &RubbishListEntry, right: &RubbishListEntry) -> Ordering {
    match (left, right) {
        (RubbishListEntry::Valid(left), RubbishListEntry::Valid(right)) => right
            .deleted_at
            .cmp(&left.deleted_at)
            .then_with(|| left.item_id.cmp(&right.item_id)),
        (RubbishListEntry::Valid(_), RubbishListEntry::Invalid { .. }) => Ordering::Less,
        (RubbishListEntry::Invalid { .. }, RubbishListEntry::Valid(_)) => Ordering::Greater,
        (
            RubbishListEntry::Invalid {
                item_id: left, ..
            },
            RubbishListEntry::Invalid {
                item_id: right, ..
            },
        ) => left.cmp(right),
    }
}
fn validate_physical_item_file(
    path: &Path,
    item_id: &str,
    description: &'static str,
) -> Result<(), RubbishStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| {
        RubbishStoreError::filesystem("inspect rubbish item file", path, source)
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(RubbishStoreError::invalid(
            item_id,
            RubbishItemValidationError::InvalidItemLayout {
                message: format!("{description} is not a physical file"),
            },
        ));
    }
    Ok(())
}

fn read_physical_item_file(
    path: &Path,
    item_id: &str,
    description: &'static str,
) -> Result<Vec<u8>, RubbishStoreError> {
    validate_physical_item_file(path, item_id, description)?;
    fs::read(path)
        .map_err(|source| RubbishStoreError::filesystem("read rubbish item file", path, source))
}

fn read_item_directory(
    directory: &Path,
    expected_item_id: Uuid,
) -> Result<RubbishItem, RubbishStoreError> {
    let item_id = expected_item_id.to_string();
    let metadata = fs::symlink_metadata(directory).map_err(|source| {
        RubbishStoreError::filesystem("inspect transaction rubbish directory", directory, source)
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RubbishStoreError::invalid(
            &item_id,
            RubbishItemValidationError::InvalidItemLayout {
                message: "transaction item path is not a physical directory".to_owned(),
            },
        ));
    }
    let manifest_bytes =
        read_physical_item_file(&directory.join("manifest.json"), &item_id, "rubbish manifest")?;
    let manifest = parse_manifest(&manifest_bytes)
        .map_err(|error| RubbishStoreError::invalid(&item_id, error))?;
    if manifest.item_id != expected_item_id {
        return Err(RubbishStoreError::invalid(
            &item_id,
            RubbishItemValidationError::ManifestItemIdMismatch {
                directory_item_id: expected_item_id,
                manifest_item_id: manifest.item_id,
            },
        ));
    }
    let bytes = read_physical_item_file(&directory.join("page.md"), &item_id, "rubbish page")?;
    Ok(RubbishItem { manifest, bytes })
}

fn write_synced_file(path: &Path, content: &[u8]) -> Result<(), RubbishStoreError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| RubbishStoreError::filesystem("create staged rubbish file", path, source))?;
    file.write_all(content)
        .map_err(|source| RubbishStoreError::filesystem("write staged rubbish file", path, source))?;
    file.sync_all()
        .map_err(|source| RubbishStoreError::filesystem("sync staged rubbish file", path, source))
}

fn sync_directory_parent(path: &Path) -> Result<(), RubbishStoreError> {
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_DIRECTORY_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
struct TestDirectorySyncFailureGuard;

#[cfg(test)]
impl Drop for TestDirectorySyncFailureGuard {
    fn drop(&mut self) {
        FAIL_NEXT_DIRECTORY_SYNC.set(false);
    }
}

#[cfg(test)]
fn fail_next_directory_sync() -> TestDirectorySyncFailureGuard {
    FAIL_NEXT_DIRECTORY_SYNC.set(true);
    TestDirectorySyncFailureGuard
}

#[cfg(test)]
fn hit_test_directory_sync_failure(path: &Path) -> Result<(), RubbishStoreError> {
    if FAIL_NEXT_DIRECTORY_SYNC.replace(false) {
        return Err(RubbishStoreError::filesystem(
            "execute deterministic directory sync failpoint",
            path,
            io::Error::other("DirectorySync"),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), RubbishStoreError> {
    #[cfg(test)]
    hit_test_directory_sync_failure(path)?;
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| RubbishStoreError::filesystem("sync directory", path, source))
}

#[cfg(windows)]
#[allow(clippy::unnecessary_wraps)]
fn sync_directory(_path: &Path) -> Result<(), RubbishStoreError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use chrono::{DateTime, Utc};
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::*;

    fn uuid(value: &str) -> Uuid {
        Uuid::parse_str(value).unwrap()
    }

    fn timestamp(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn manifest(item_id: Uuid, deleted_at: DateTime<Utc>) -> RubbishManifest {
        RubbishManifest::new(
            item_id,
            uuid("10000000-0000-4000-8000-000000000001"),
            "notes/example.md",
            "Example",
            "NOTE",
            deleted_at,
            Some("https://example.com/archive".to_owned()),
        )
        .unwrap()
    }

    fn write_raw_item(root: &Path, item_id: &str, page: &[u8], manifest: &[u8]) {
        let directory = root.join(item_id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("page.md"), page).unwrap();
        fs::write(directory.join("manifest.json"), manifest).unwrap();
    }

    #[test]
    fn manifest_new_records_validated_lifecycle_metadata() {
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let page_id = uuid("10000000-0000-4000-8000-000000000001");
        let deleted_at = timestamp("2026-08-13T00:00:00Z");

        let manifest = RubbishManifest::new(
            item_id,
            page_id,
            "notes/example.md",
            "Example",
            "NOTE",
            deleted_at,
            Some("https://example.com/archive".to_owned()),
        )
        .unwrap();

        assert_eq!(manifest.version, RUBBISH_MANIFEST_VERSION);
        assert_eq!(manifest.item_id, item_id);
        assert_eq!(manifest.page_id, page_id);
        assert_ne!(manifest.item_id, manifest.page_id);
        assert_eq!(manifest.original_path, "notes/example.md");
        assert_eq!(manifest.title, "Example");
        assert_eq!(manifest.kind, "NOTE");
        assert_eq!(manifest.deleted_at, deleted_at);
        assert_eq!(
            manifest.archive_url.as_deref(),
            Some("https://example.com/archive")
        );
    }

    #[test]
    fn manifest_new_rejects_non_markdown_paths() {
        let error = RubbishManifest::new(
            uuid("00000000-0000-4000-8000-000000000001"),
            uuid("10000000-0000-4000-8000-000000000001"),
            "notes/example.txt",
            "Example",
            "NOTE",
            timestamp("2026-08-13T00:00:00Z"),
            None,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            RubbishItemValidationError::OriginalPathNotMarkdown { .. }
        ));
    }

    #[test]
    fn prepare_item_rejects_malformed_ids_and_traversing_manifest_paths() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let store = RubbishStore::new(&root);
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let valid = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));

        let malformed = store
            .prepare_item("../../outside", &valid, b"secret")
            .unwrap_err();
        assert!(matches!(
            malformed,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::MalformedItemId { .. },
                ..
            }
        ));

        let mut traversing = valid;
        traversing.original_path = "../../outside.md".to_owned();
        let item_id_string = item_id.to_string();
        let traversal = store
            .prepare_item(&item_id_string, &traversing, b"secret")
            .unwrap_err();
        assert!(matches!(
            traversal,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::InvalidOriginalPath { .. },
                ..
            }
        ));

        assert!(!temp.path().join("outside").exists());
        assert!(!root.exists());
    }

    #[cfg(not(windows))]
    #[test]
    fn prepare_item_cleans_staging_when_the_initial_root_sync_fails() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        fs::create_dir(&root).unwrap();
        let store = RubbishStore::new(&root);
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let manifest = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));
        let _guard = fail_next_directory_sync();

        let error = store
            .prepare_item(&item_id.to_string(), &manifest, b"secret")
            .unwrap_err();

        assert!(matches!(error, RubbishStoreError::Filesystem { .. }));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn publication_is_separable_durable_and_preserves_exact_page_bytes() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let store = RubbishStore::new(&root);
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let item_id_string = item_id.to_string();
        let manifest = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));
        let bytes = b"\0\x9f encrypted\xff\r\n---\nnot parsed";

        let mut prepared = store
            .prepare_item(&item_id_string, &manifest, bytes)
            .unwrap();
        assert!(!root.join(&item_id_string).exists());

        prepared.publish().unwrap();
        prepared.cleanup().unwrap();

        let mut root_entries = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        root_entries.sort();
        assert_eq!(root_entries, vec![item_id_string.clone()]);

        let mut item_entries = fs::read_dir(root.join(&item_id_string))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        item_entries.sort();
        assert_eq!(item_entries, vec!["manifest.json", "page.md"]);
        assert_eq!(fs::read(root.join(&item_id_string).join("page.md")).unwrap(), bytes);

        let item = store.read_item(&item_id_string).unwrap();
        assert_eq!(item.manifest, manifest);
        assert_eq!(item.bytes, bytes);
    }

    #[test]
    fn read_item_rejects_a_manifest_id_that_differs_from_its_directory() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let directory_id = uuid("00000000-0000-4000-8000-000000000001");
        let manifest_id = uuid("00000000-0000-4000-8000-000000000002");
        let manifest = manifest(manifest_id, timestamp("2026-08-13T00:00:00Z"));
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        write_raw_item(&root, &directory_id.to_string(), b"page", &manifest_bytes);
        let store = RubbishStore::new(&root);

        let error = store.read_item(&directory_id.to_string()).unwrap_err();

        assert!(matches!(
            error,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::ManifestItemIdMismatch {
                    directory_item_id,
                    manifest_item_id: actual_manifest_id,
                },
                ..
            } if directory_item_id == directory_id && actual_manifest_id == manifest_id
        ));
    }

    #[test]
    fn read_item_revalidates_the_original_vault_path() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let mut manifest = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));
        manifest.original_path = "notes/../../outside.md".to_owned();
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        write_raw_item(&root, &item_id.to_string(), b"page", &manifest_bytes);
        let store = RubbishStore::new(&root);

        let error = store.read_item(&item_id.to_string()).unwrap_err();

        assert!(matches!(
            error,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::InvalidOriginalPath { .. },
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn read_item_rejects_symlinked_item_files() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let item_id_string = item_id.to_string();
        let manifest = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        write_raw_item(&root, &item_id_string, b"placeholder", &manifest_bytes);
        let outside = temp.path().join("outside");
        fs::write(&outside, b"outside bytes").unwrap();
        let page_path = root.join(&item_id_string).join("page.md");
        fs::remove_file(&page_path).unwrap();
        std::os::unix::fs::symlink(&outside, &page_path).unwrap();
        let store = RubbishStore::new(&root);

        let error = store.read_item(&item_id_string).unwrap_err();

        assert!(matches!(
            error,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::InvalidItemLayout { .. },
                ..
            }
        ));
    }

    #[test]
    fn read_item_fails_closed_on_future_versions_without_modifying_bytes() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let item_id_string = item_id.to_string();
        let page_bytes = b"\0\xff untouched page bytes";
        let manifest_bytes = br#"{"version":2,"not":"the current schema"}"#;
        write_raw_item(&root, &item_id_string, page_bytes, manifest_bytes);
        let store = RubbishStore::new(&root);

        let error = store.read_item(&item_id_string).unwrap_err();

        assert!(matches!(
            error,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::UnsupportedManifestVersion { version: 2 },
                ..
            }
        ));
        assert_eq!(fs::read(root.join(&item_id_string).join("page.md")).unwrap(), page_bytes);
        assert_eq!(
            fs::read(root.join(&item_id_string).join("manifest.json")).unwrap(),
            manifest_bytes
        );
    }

    #[test]
    fn read_item_returns_a_typed_error_for_malformed_json_without_modifying_bytes() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let item_id_string = item_id.to_string();
        let page_bytes = b"encrypted page";
        let manifest_bytes = br#"{"version":1,"item_id":"#;
        write_raw_item(&root, &item_id_string, page_bytes, manifest_bytes);
        let store = RubbishStore::new(&root);

        let error = store.read_item(&item_id_string).unwrap_err();

        assert!(matches!(
            error,
            RubbishStoreError::InvalidItem {
                source: RubbishItemValidationError::MalformedManifestJson { .. },
                ..
            }
        ));
        assert_eq!(fs::read(root.join(&item_id_string).join("page.md")).unwrap(), page_bytes);
        assert_eq!(
            fs::read(root.join(&item_id_string).join("manifest.json")).unwrap(),
            manifest_bytes
        );
    }

    #[test]
    fn list_entries_returns_valid_and_invalid_items_in_deterministic_order() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let store = RubbishStore::new(&root);
        let first_id = uuid("00000000-0000-4000-8000-000000000001");
        let second_id = uuid("00000000-0000-4000-8000-000000000002");
        let older_id = uuid("00000000-0000-4000-8000-000000000003");

        for manifest in [
            manifest(first_id, timestamp("2026-08-13T12:00:00Z")),
            manifest(second_id, timestamp("2026-08-13T12:00:00Z")),
            manifest(older_id, timestamp("2026-08-12T12:00:00Z")),
        ] {
            let item_id = manifest.item_id.to_string();
            let mut prepared = store.prepare_item(&item_id, &manifest, b"page").unwrap();
            prepared.publish().unwrap();
        }
        write_raw_item(&root, "broken-entry", b"page", b"not json");

        let entries = store.list_entries().unwrap();

        assert_eq!(entries.len(), 4);
        assert!(matches!(&entries[0], RubbishListEntry::Valid(value) if value.item_id == first_id));
        assert!(matches!(&entries[1], RubbishListEntry::Valid(value) if value.item_id == second_id));
        assert!(matches!(&entries[2], RubbishListEntry::Valid(value) if value.item_id == older_id));
        assert!(matches!(
            &entries[3],
            RubbishListEntry::Invalid { item_id, error }
                if item_id == "broken-entry" && error.contains("invalid rubbish item ID")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rubbish_catalog_enumeration_does_not_read_page_payloads() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let store = RubbishStore::new(&root);
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let item_id_string = item_id.to_string();
        let expected = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));
        let mut prepared = store
            .prepare_item(&item_id_string, &expected, b"catalog must not read this")
            .unwrap();
        prepared.publish().unwrap();
        let page_path = root.join(&item_id_string).join("page.md");
        fs::set_permissions(&page_path, fs::Permissions::from_mode(0o000)).unwrap();

        assert_eq!(
            store.list_entries().unwrap(),
            vec![RubbishListEntry::Valid(expected)]
        );
    }

    #[test]
    fn duplicate_publication_refuses_an_occupied_item_directory() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("rubbish");
        let store = RubbishStore::new(&root);
        let item_id = uuid("00000000-0000-4000-8000-000000000001");
        let item_id_string = item_id.to_string();
        let manifest = manifest(item_id, timestamp("2026-08-13T00:00:00Z"));
        let mut first = store
            .prepare_item(&item_id_string, &manifest, b"first")
            .unwrap();
        let mut duplicate = store
            .prepare_item(&item_id_string, &manifest, b"second")
            .unwrap();
        first.publish().unwrap();

        let error = duplicate.publish().unwrap_err();
        duplicate.cleanup().unwrap();

        assert!(matches!(
            error,
            RubbishStoreError::ItemAlreadyExists { item_id: occupied } if occupied == item_id
        ));
        assert_eq!(
            fs::read(root.join(item_id_string).join("page.md")).unwrap(),
            b"first"
        );
    }
}
