use std::fs;
use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum InitError {
    #[error("vault already initialized: {0}")]
    AlreadyInitialized(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

const DEFAULT_CONFIG: &str = r#"[vault]
attachment_folder = "_attachments"

excluded_patterns = [
    ".clepsydra/**",
    "_attachments/**",
    ".git/**",
    "node_modules/**",
]

default_page_folder = ""

linkable_properties = ["tags", "aliases", "link", "attendees"]
"#;

/// Initialize a new vault at the given root directory.
///
/// Creates the `.clepsydra/` metadata directory, a default `config.toml`,
/// a `templates/` subdirectory, and the `_attachments/` folder.
///
/// Fails with [`InitError::AlreadyInitialized`] if `.clepsydra/` already
/// exists under the root.
pub fn init_vault(root: &Path) -> Result<(), InitError> {
    let dot_dir = root.join(".clepsydra");

    if dot_dir.exists() {
        return Err(InitError::AlreadyInitialized(dot_dir.display().to_string()));
    }

    // Ensure root exists
    fs::create_dir_all(root)?;

    // Create .clepsydra/ and .clepsydra/templates/
    fs::create_dir_all(dot_dir.join("templates"))?;

    // Write default config
    fs::write(dot_dir.join("config.toml"), DEFAULT_CONFIG)?;

    // Create _attachments/
    fs::create_dir_all(root.join("_attachments"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_creates_structure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("my-vault");

        init_vault(&root).unwrap();

        assert!(root.join(".clepsydra").is_dir());
        assert!(root.join(".clepsydra/config.toml").is_file());
        assert!(root.join(".clepsydra/templates").is_dir());
        assert!(root.join("_attachments").is_dir());

        // Config should be valid TOML parseable as VaultConfig
        let contents = fs::read_to_string(root.join(".clepsydra/config.toml")).unwrap();
        let config: crate::vault::config::VaultConfig = toml::from_str(&contents).unwrap();
        // Written template must match the serde defaults for linkable_properties.
        assert_eq!(
            config.vault.linkable_properties,
            vec!["tags", "aliases", "link", "attendees"]
        );
    }

    #[test]
    fn init_rejects_already_initialized() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        init_vault(root).unwrap();

        let err = init_vault(root).unwrap_err();
        assert!(
            err.to_string().contains("already initialized"),
            "expected 'already initialized', got: {err}"
        );
    }

    #[test]
    fn late_scaffold_failure_retains_documented_partial_state() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("_attachments"), b"blocks directory creation").unwrap();

        let error = init_vault(&root).unwrap_err();

        assert!(matches!(error, InitError::Io(_)));
        assert!(root.join(".clepsydra/templates").is_dir());
        assert!(root.join(".clepsydra/config.toml").is_file());
        assert_eq!(
            fs::read(root.join("_attachments")).unwrap(),
            b"blocks directory creation"
        );
    }
}
