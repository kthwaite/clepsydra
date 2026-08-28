//! `[sync]` config-section writer: sets keys in
//! `<vault>/.clepsydra/config.toml` while preserving every other line
//! (comments, formatting, unrelated sections) via `toml_edit`.

use std::fs;
use std::path::Path;
use std::str::FromStr;

use toml_edit::{DocumentMut, value};

use super::SyncError;
use crate::vault::atomic_file::{atomic_create, atomic_replace};

/// `[sync]` keys to set. A `None` value is left untouched.
#[derive(Debug, Clone, Default)]
pub struct SyncSectionPatch {
    pub branch: Option<String>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
}

/// Set the given `[sync]` keys in `<vault>/.clepsydra/config.toml`,
/// preserving all other content. Creates the file if it doesn't exist yet
/// (the `.clepsydra` directory must already exist).
pub fn write_sync_section(vault_root: &Path, patch: &SyncSectionPatch) -> Result<(), SyncError> {
    let path = vault_root.join(".clepsydra/config.toml");
    let existed = path.is_file();
    let text = if existed {
        fs::read_to_string(&path).map_err(|e| SyncError::io(&path, e))?
    } else {
        String::new()
    };

    let mut doc = DocumentMut::from_str(&text)
        .map_err(|e| SyncError::Config(format!("{}: {e}", path.display())))?;

    let sync = doc.entry("sync").or_insert(toml_edit::table());
    let sync = sync
        .as_table_mut()
        .ok_or_else(|| SyncError::Config(format!("{}: [sync] is not a table", path.display())))?;

    if let Some(branch) = &patch.branch {
        sync["branch"] = value(branch.as_str());
    }
    if let Some(author_name) = &patch.author_name {
        sync["author_name"] = value(author_name.as_str());
    }
    if let Some(author_email) = &patch.author_email {
        sync["author_email"] = value(author_email.as_str());
    }

    let out = doc.to_string();
    if existed {
        atomic_replace(&path, out.as_bytes()).map_err(|e| SyncError::io(&path, e.into_inner()))?;
    } else {
        atomic_create(&path, out.as_bytes()).map_err(|e| SyncError::io(&path, e.into_inner()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn writes_sync_section_preserving_other_content() {
        let tmp = TempDir::new().unwrap();
        crate::vault::init::init_vault(tmp.path()).unwrap();
        let path = tmp.path().join(".clepsydra/config.toml");
        let before = fs::read_to_string(&path).unwrap();
        write_sync_section(
            tmp.path(),
            &SyncSectionPatch {
                branch: None,
                author_name: Some("Kit".into()),
                author_email: Some("kit@example.com".into()),
            },
        )
        .unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.starts_with(&before),
            "existing content must be preserved verbatim"
        );
        let cfg = crate::vault::config::VaultConfig::load(tmp.path()).unwrap();
        assert_eq!(cfg.sync.author_name.as_deref(), Some("Kit"));
        assert_eq!(cfg.sync.branch, "main");
        // second write only touches the given key
        write_sync_section(
            tmp.path(),
            &SyncSectionPatch {
                branch: Some("trunk".into()),
                author_name: None,
                author_email: None,
            },
        )
        .unwrap();
        let cfg = crate::vault::config::VaultConfig::load(tmp.path()).unwrap();
        assert_eq!(cfg.sync.branch, "trunk");
        assert_eq!(cfg.sync.author_email.as_deref(), Some("kit@example.com"));
    }

    #[test]
    fn creates_config_when_missing() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".clepsydra")).unwrap();
        write_sync_section(
            tmp.path(),
            &SyncSectionPatch {
                branch: None,
                author_name: Some("A".into()),
                author_email: Some("a@b.c".into()),
            },
        )
        .unwrap();
        assert!(tmp.path().join(".clepsydra/config.toml").is_file());
    }
}
