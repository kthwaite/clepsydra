use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::atomic_file::{AtomicPublicationError, atomic_create_owner_only, atomic_replace};
use super::encryption::{MAX_AGE_ARMOR_BYTES, validate_age_armor};

const KEYRING_VERSION: u8 = 1;
const CRYPTO_DIR: &str = ".clepsydra/crypto";
const KEYRING_FILE: &str = "keyring.toml";
const AGE_RECIPIENT_LEN: usize = 62;
const AGE_RECIPIENT_DATA_CHARS: &str = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

static KEYRING_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub const MAX_RECIPIENT_BYTES: usize = 256;
pub const MAX_WRAPPED_IDENTITY_BYTES: usize = MAX_AGE_ARMOR_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultKeyring {
    pub version: u8,
    pub active_key_id: String,
    pub keys: Vec<VaultKeyRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultKeyRecord {
    pub id: String,
    pub recipient: String,
    pub wrapped_identity_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyringSnapshot {
    pub keyring: VaultKeyring,
    pub wrapped_identity: Option<String>,
    pub revision: String,
}

#[derive(Debug, Error)]
pub enum KeyringError {
    #[error("vault encryption is already initialized")]
    AlreadyInitialized,
    #[error("vault encryption is not initialized")]
    NotInitialized,
    #[error("keyring revision conflict")]
    RevisionConflict { current_revision: String },
    #[error("invalid key ID")]
    InvalidKeyId,
    #[error("invalid age recipient")]
    InvalidRecipient,
    #[error("invalid wrapped identity armor")]
    InvalidWrappedIdentity,
    #[error("invalid keyring metadata")]
    InvalidMetadata,
    #[error("keyring I/O failed")]
    Io(#[source] io::Error),
    #[error("keyring publication failed")]
    Publication(#[source] AtomicPublicationError),
}

impl From<io::Error> for KeyringError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Load the vault keyring, returning `None` when encryption has not been set up.
pub fn load_keyring(vault_root: &Path) -> Result<Option<KeyringSnapshot>, KeyringError> {
    let _guard = KEYRING_LOCK.lock();
    load_keyring_unlocked(vault_root)
}

/// Create the one-time v1 keyring and optional wrapped identity.
pub fn setup_keyring(
    vault_root: &Path,
    key_id: &str,
    recipient: &str,
    wrapped_identity: Option<&str>,
) -> Result<KeyringSnapshot, KeyringError> {
    validate_key_id(key_id)?;
    validate_recipient(recipient)?;
    validate_optional_wrapped_identity(wrapped_identity)?;

    let _guard = KEYRING_LOCK.lock();
    let keyring_path = keyring_path(vault_root);
    if keyring_path.exists() {
        return Err(KeyringError::AlreadyInitialized);
    }

    let crypto_dir = crypto_dir(vault_root);
    fs::create_dir_all(&crypto_dir)?;
    set_owner_only_directory(&crypto_dir)?;

    let wrapped_identity_file = wrapped_identity.map(|_| identity_file_name(key_id));
    let keyring = VaultKeyring {
        version: KEYRING_VERSION,
        active_key_id: key_id.to_string(),
        keys: vec![VaultKeyRecord {
            id: key_id.to_string(),
            recipient: recipient.to_string(),
            wrapped_identity_file,
        }],
    };
    let metadata = serialize_keyring(&keyring)?;

    let identity_path = identity_path(vault_root, key_id);
    let mut identity_created = false;
    if let Some(armor) = wrapped_identity {
        atomic_create_owner_only(&identity_path, armor.as_bytes())
            .map_err(KeyringError::Publication)?;
        identity_created = true;
        set_owner_only_file(&identity_path)?;
    }

    match atomic_create_owner_only(&keyring_path, metadata.as_bytes()) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if identity_created {
                let _ = fs::remove_file(&identity_path);
            }
            return Err(KeyringError::AlreadyInitialized);
        }
        Err(error) => {
            if identity_created && !error.filesystem_applied() {
                let _ = fs::remove_file(&identity_path);
            }
            return Err(KeyringError::Publication(error));
        }
    }
    set_owner_only_file(&keyring_path)?;

    Ok(KeyringSnapshot {
        revision: keyring_revision(metadata.as_bytes(), wrapped_identity),
        keyring,
        wrapped_identity: wrapped_identity.map(str::to_string),
    })
}

/// Replace or remove the active key's wrapped identity using optimistic locking.
pub fn rewrap_identity(
    vault_root: &Path,
    expected_revision: &str,
    wrapped_identity: Option<&str>,
) -> Result<KeyringSnapshot, KeyringError> {
    validate_optional_wrapped_identity(wrapped_identity)?;

    let _guard = KEYRING_LOCK.lock();
    let current = load_keyring_unlocked(vault_root)?.ok_or(KeyringError::NotInitialized)?;
    if current.revision != expected_revision {
        return Err(KeyringError::RevisionConflict {
            current_revision: current.revision,
        });
    }

    let mut keyring = current.keyring;
    let active_index = keyring
        .keys
        .iter()
        .position(|record| record.id == keyring.active_key_id)
        .ok_or(KeyringError::InvalidMetadata)?;
    let key_id = keyring.keys[active_index].id.clone();
    let identity_path = identity_path(vault_root, &key_id);
    let keyring_path = keyring_path(vault_root);
    let had_wrapped_identity = keyring.keys[active_index].wrapped_identity_file.is_some();

    match (had_wrapped_identity, wrapped_identity) {
        (true, Some(armor)) => {
            atomic_replace(&identity_path, armor.as_bytes()).map_err(KeyringError::Publication)?;
            set_owner_only_file(&identity_path)?;
        }
        (false, Some(armor)) => {
            atomic_create_owner_only(&identity_path, armor.as_bytes())
                .map_err(KeyringError::Publication)?;
            set_owner_only_file(&identity_path)?;
            keyring.keys[active_index].wrapped_identity_file = Some(identity_file_name(&key_id));
            let metadata = serialize_keyring(&keyring)?;
            if let Err(error) = atomic_replace(&keyring_path, metadata.as_bytes()) {
                if !error.filesystem_applied() {
                    let _ = fs::remove_file(&identity_path);
                }
                return Err(KeyringError::Publication(error));
            }
            set_owner_only_file(&keyring_path)?;
        }
        (true, None) => {
            keyring.keys[active_index].wrapped_identity_file = None;
            let metadata = serialize_keyring(&keyring)?;
            atomic_replace(&keyring_path, metadata.as_bytes())
                .map_err(KeyringError::Publication)?;
            set_owner_only_file(&keyring_path)?;
            match fs::remove_file(&identity_path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(KeyringError::Io(error)),
            }
        }
        (false, None) => {}
    }

    load_keyring_unlocked(vault_root)?.ok_or(KeyringError::NotInitialized)
}

fn load_keyring_unlocked(vault_root: &Path) -> Result<Option<KeyringSnapshot>, KeyringError> {
    let path = keyring_path(vault_root);
    let metadata = match fs::read_to_string(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(KeyringError::Io(error)),
    };
    let keyring: VaultKeyring =
        toml::from_str(&metadata).map_err(|_| KeyringError::InvalidMetadata)?;
    validate_keyring(&keyring)?;
    let active = keyring
        .keys
        .iter()
        .find(|record| record.id == keyring.active_key_id)
        .ok_or(KeyringError::InvalidMetadata)?;
    let wrapped_identity = if active.wrapped_identity_file.is_some() {
        let armor = fs::read_to_string(identity_path(vault_root, &active.id))
            .map_err(|_| KeyringError::InvalidMetadata)?;
        validate_age_armor(&armor).map_err(|_| KeyringError::InvalidWrappedIdentity)?;
        Some(armor)
    } else {
        None
    };
    let revision = keyring_revision(metadata.as_bytes(), wrapped_identity.as_deref());

    Ok(Some(KeyringSnapshot {
        keyring,
        wrapped_identity,
        revision,
    }))
}

fn validate_keyring(keyring: &VaultKeyring) -> Result<(), KeyringError> {
    if keyring.version != KEYRING_VERSION || keyring.keys.is_empty() {
        return Err(KeyringError::InvalidMetadata);
    }
    validate_key_id(&keyring.active_key_id)?;
    let mut ids = HashSet::with_capacity(keyring.keys.len());
    for record in &keyring.keys {
        validate_key_id(&record.id)?;
        validate_recipient(&record.recipient)?;
        if !ids.insert(record.id.as_str()) {
            return Err(KeyringError::InvalidMetadata);
        }
        if let Some(file_name) = &record.wrapped_identity_file
            && file_name != &identity_file_name(&record.id)
        {
            return Err(KeyringError::InvalidMetadata);
        }
    }
    if !ids.contains(keyring.active_key_id.as_str()) {
        return Err(KeyringError::InvalidMetadata);
    }
    Ok(())
}

fn validate_key_id(key_id: &str) -> Result<(), KeyringError> {
    let parsed = uuid::Uuid::parse_str(key_id).map_err(|_| KeyringError::InvalidKeyId)?;
    if parsed.to_string() != key_id {
        return Err(KeyringError::InvalidKeyId);
    }
    Ok(())
}

fn validate_recipient(recipient: &str) -> Result<(), KeyringError> {
    if recipient.len() > MAX_RECIPIENT_BYTES
        || recipient.len() != AGE_RECIPIENT_LEN
        || !recipient.is_ascii()
        || !recipient.starts_with("age1")
        || !recipient[4..]
            .chars()
            .all(|character| AGE_RECIPIENT_DATA_CHARS.contains(character))
    {
        return Err(KeyringError::InvalidRecipient);
    }
    Ok(())
}

fn validate_optional_wrapped_identity(wrapped_identity: Option<&str>) -> Result<(), KeyringError> {
    if let Some(armor) = wrapped_identity {
        if armor.len() > MAX_WRAPPED_IDENTITY_BYTES {
            return Err(KeyringError::InvalidWrappedIdentity);
        }
        validate_age_armor(armor).map_err(|_| KeyringError::InvalidWrappedIdentity)?;
    }
    Ok(())
}

fn serialize_keyring(keyring: &VaultKeyring) -> Result<String, KeyringError> {
    toml::to_string(keyring).map_err(|_| KeyringError::InvalidMetadata)
}

fn keyring_revision(metadata: &[u8], wrapped_identity: Option<&str>) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"clepsydra-keyring-v1\0");
    hasher.update(&(metadata.len() as u64).to_le_bytes());
    hasher.update(metadata);
    match wrapped_identity {
        Some(armor) => {
            hasher.update(&[1]);
            hasher.update(&(armor.len() as u64).to_le_bytes());
            hasher.update(armor.as_bytes());
        }
        None => {
            hasher.update(&[0]);
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn crypto_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(CRYPTO_DIR)
}

fn keyring_path(vault_root: &Path) -> PathBuf {
    crypto_dir(vault_root).join(KEYRING_FILE)
}

fn identity_file_name(key_id: &str) -> String {
    format!("{key_id}.identity.age")
}

fn identity_path(vault_root: &Path, key_id: &str) -> PathBuf {
    crypto_dir(vault_root).join(identity_file_name(key_id))
}

#[cfg(unix)]
fn set_owner_only_directory(path: &Path) -> Result<(), KeyringError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(KeyringError::Io)
}

#[cfg(not(unix))]
fn set_owner_only_directory(_path: &Path) -> Result<(), KeyringError> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> Result<(), KeyringError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(KeyringError::Io)
}

#[cfg(not(unix))]
fn set_owner_only_file(_path: &Path) -> Result<(), KeyringError> {
    Ok(())
}

/// Re-tighten `.clepsydra/crypto` (0700) and its files (0600).
///
/// A git checkout recreates those paths with the process umask, so every
/// sync that touches the tree calls this afterwards. A no-op when the
/// directory is absent, and on platforms where the owner-only helpers are
/// themselves no-ops.
pub(crate) fn tighten_crypto_permissions(vault_root: &Path) -> Result<(), KeyringError> {
    let dir = crypto_dir(vault_root);
    if !dir.is_dir() {
        return Ok(());
    }
    set_owner_only_directory(&dir)?;
    for entry in fs::read_dir(&dir).map_err(KeyringError::Io)? {
        let entry = entry.map_err(KeyringError::Io)?;
        if entry.file_type().map_err(KeyringError::Io)?.is_file() {
            set_owner_only_file(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tighten_crypto_permissions_is_a_no_op_without_a_crypto_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        tighten_crypto_permissions(tmp.path()).unwrap();
        assert!(!crypto_dir(tmp.path()).exists());
    }

    #[cfg(unix)]
    #[test]
    fn tighten_crypto_permissions_makes_the_dir_and_files_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::TempDir::new().unwrap();
        let dir = crypto_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let file = dir.join(KEYRING_FILE);
        fs::write(&file, "keys = []\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        tighten_crypto_permissions(tmp.path()).unwrap();

        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&file), 0o600);
    }
}
