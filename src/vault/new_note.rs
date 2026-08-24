use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

use crate::app_config::{config_candidates_with_env, find_config_path_with_env};

use super::Vault;
use super::kind::Kind;
use super::page::{PageMeta, write_page_content};
use super::path::VaultPath;

/// Information about a note created by [`create_new_note`].
#[derive(Debug, Clone)]
pub struct CreatedNote {
    pub vault_root: PathBuf,
    pub vault_path: VaultPath,
}

#[derive(Debug, Error)]
pub enum NewNoteError {
    #[error("no config.toml found (checked: {0})")]
    ConfigNotFound(String),
    #[error("failed to parse config at {path}: {message}")]
    ConfigParse { path: String, message: String },
    #[error("config at {0} does not define [vault].root")]
    VaultRootMissing(String),
    #[error("note title cannot be empty")]
    EmptyTitle,
    #[error("failed to open vault: {0}")]
    VaultOpen(String),
    #[error("invalid new-note path: {0}")]
    InvalidPath(String),
    #[error("note already exists: {0}")]
    AlreadyExists(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Default, Deserialize)]
struct CliConfig {
    #[serde(default)]
    vault: CliVaultSection,
}

#[derive(Debug, Default, Deserialize)]
struct CliVaultSection {
    root: Option<String>,
}

/// Load the vault root from application config.
///
/// Config lookup order:
/// 1. `<start_dir>/config.toml`
/// 2. `$XDG_CONFIG_HOME/clepsydra/config.toml`
/// 3. `$HOME/.config/clepsydra/config.toml`
///
/// The first existing config file is used.
pub fn load_vault_root_from_config(start_dir: &Path) -> Result<PathBuf, NewNoteError> {
    load_vault_root_from_config_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

fn load_vault_root_from_config_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, NewNoteError> {
    let candidates = config_candidates_with_env(start_dir, xdg_config_home.clone(), home.clone());
    let checked = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let config_path = find_config_path_with_env(start_dir, xdg_config_home, home)
        .ok_or(NewNoteError::ConfigNotFound(checked))?;

    let contents = fs::read_to_string(&config_path)?;
    let cfg: CliConfig = toml::from_str(&contents).map_err(|e| NewNoteError::ConfigParse {
        path: config_path.display().to_string(),
        message: e.to_string(),
    })?;

    let raw_root = cfg
        .vault
        .root
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| NewNoteError::VaultRootMissing(config_path.display().to_string()))?;

    let root_path = PathBuf::from(raw_root);
    if root_path.is_absolute() {
        Ok(root_path)
    } else {
        let parent = config_path.parent().unwrap_or(Path::new("."));
        Ok(parent.join(root_path))
    }
}

/// Create a new note from app config and vault defaults.
///
/// - Loads vault root from app config (`config.toml` in CWD, then XDG config)
/// - Opens the configured vault (fails if invalid/missing)
/// - Uses `vault.default_page_folder` from `.clepsydra/config.toml`
/// - Generates a canonical `<yyyymmdd>.<slug>.<shortid>.md` filename
/// - Writes a markdown file with fresh [`PageMeta`] (UUID + timestamps),
///   where the frontmatter `created_at` agrees with the filename date prefix
pub fn create_new_note(
    start_dir: &Path,
    title: &str,
    body: Option<&str>,
) -> Result<CreatedNote, NewNoteError> {
    let vault_root = load_vault_root_from_config(start_dir)?;
    create_new_note_in_vault(&vault_root, title, body)
}

fn create_new_note_in_vault(
    vault_root: &Path,
    title: &str,
    body: Option<&str>,
) -> Result<CreatedNote, NewNoteError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(NewNoteError::EmptyTitle);
    }

    let vault = Vault::open(vault_root).map_err(|e| NewNoteError::VaultOpen(e.to_string()))?;

    // Single timestamp shared between the filename's date prefix and the
    // frontmatter `created_at`/`updated_at`, so they always agree.
    let created = chrono::Utc::now();

    let vault_path = build_note_path(&vault, title, created)?;
    let abs_path = vault.resolve(&vault_path);

    // Defensive last-resort guard: with the random short-id in the filename a
    // collision is ~1-in-62^8, so this is effectively unreachable via
    // create_new_note — kept as a cheap stat() backstop rather than removing the
    // public NewNoteError::AlreadyExists variant (which the API error-mapping
    // layer depends on).
    if abs_path.exists() {
        return Err(NewNoteError::AlreadyExists(vault_path.as_str().to_string()));
    }

    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut meta = PageMeta::new();
    meta.title = Some(title.to_string());
    meta.created_at = Some(created);
    meta.updated_at = Some(created);

    let content = write_page_content(&meta, body.unwrap_or_default());
    fs::write(&abs_path, content)?;

    Ok(CreatedNote {
        vault_root: vault.root().to_path_buf(),
        vault_path,
    })
}

pub(crate) fn build_note_path(
    vault: &Vault,
    title: &str,
    created: chrono::DateTime<chrono::Utc>,
) -> Result<VaultPath, NewNoteError> {
    let short_id = crate::vault::block_id::generate_short_id();
    let filename = crate::vault::page_filename::page_filename(created, title, &short_id);

    let folder = vault
        .config()
        .vault
        .default_page_folder
        .trim()
        .trim_matches('/');

    let combined = if folder.is_empty() {
        filename
    } else {
        format!("{folder}/{filename}")
    };
    VaultPath::new(&combined).map_err(|e| NewNoteError::InvalidPath(e.to_string()))
}

pub(crate) fn build_projected_note_path(
    title: &str,
    created: chrono::DateTime<chrono::Utc>,
    kind: Kind,
    project: Option<&str>,
    short_id: &str,
) -> Result<VaultPath, NewNoteError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(NewNoteError::EmptyTitle);
    }
    let filename = crate::vault::page_filename::page_filename(created, title, short_id);
    let folder = match project.map(str::trim).filter(|value| !value.is_empty()) {
        Some(project) => format!("{}/{project}", kind.canonical_folder()),
        None => kind.canonical_folder().to_string(),
    };
    VaultPath::new(&format!("{folder}/{filename}"))
        .map_err(|error| NewNoteError::InvalidPath(error.to_string()))
}

#[cfg(test)]
mod tests {
    use crate::vault::init::init_vault;
    use crate::vault::page::Page;

    use super::*;

    #[test]
    fn load_vault_root_prefers_local_config() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let vault = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&vault).unwrap();

        // local config: relative to cwd
        fs::write(cwd.join("config.toml"), "[vault]\nroot = \"../vault\"\n").unwrap();

        let resolved = load_vault_root_from_config_with_env(&cwd, None, None).unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            vault.canonicalize().unwrap()
        );
    }

    #[test]
    fn load_vault_root_falls_back_to_xdg_config() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let xdg_home = dir.path().join("xdg");
        let vault = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&vault).unwrap();

        let cfg_dir = xdg_home.join("clepsydra");
        fs::create_dir_all(&cfg_dir).unwrap();
        fs::write(
            cfg_dir.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", vault.display()),
        )
        .unwrap();

        let resolved = load_vault_root_from_config_with_env(
            &cwd,
            Some(xdg_home.as_os_str().to_os_string()),
            None,
        )
        .unwrap();

        assert_eq!(
            resolved.canonicalize().unwrap(),
            vault.canonicalize().unwrap()
        );
    }

    #[test]
    fn load_vault_root_requires_config() {
        let dir = tempfile::tempdir().unwrap();

        let err = load_vault_root_from_config_with_env(dir.path(), None, None).unwrap_err();
        assert!(matches!(err, NewNoteError::ConfigNotFound(_)));
    }

    #[test]
    fn create_new_note_uses_default_folder_and_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let root = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&root).unwrap();

        fs::write(
            cwd.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();

        fs::write(
            root.join(".clepsydra/config.toml"),
            "[vault]\ndefault_page_folder = \"notes\"\n",
        )
        .unwrap();

        let created = create_new_note(&cwd, "My Note", None).unwrap();
        assert!(created.vault_path.as_str().starts_with("notes/"));
        assert!(crate::vault::path::is_canonical_page_filename(
            created.vault_path.filename()
        ));

        let abs_path = created.vault_root.join(created.vault_path.as_str());
        assert!(abs_path.exists());

        let page = Page::from_file(&abs_path, created.vault_path.clone()).unwrap();
        assert_eq!(page.meta.title.as_deref(), Some("My Note"));
        assert!(!page.meta.id.is_nil());
        assert!(page.meta.created_at.is_some());
        assert!(page.meta.updated_at.is_some());
        assert_eq!(page.body, "");

        // The filename's date prefix must agree with the frontmatter created_at.
        let date_prefix = created
            .vault_path
            .filename()
            .split('.')
            .next()
            .unwrap()
            .to_string();
        let meta_date = page.meta.created_at.unwrap().format("%Y%m%d").to_string();
        assert_eq!(date_prefix, meta_date);
    }

    #[test]
    fn new_note_filename_is_canonical() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let root = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&root).unwrap();

        fs::write(
            cwd.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();

        fs::write(
            root.join(".clepsydra/config.toml"),
            "[vault]\ndefault_page_folder = \"notes\"\n",
        )
        .unwrap();

        let created = create_new_note(&cwd, "My Note", None).unwrap();
        let fname = created.vault_path.filename();
        assert!(
            crate::vault::path::is_canonical_page_filename(fname),
            "filename was: {fname}"
        );
        assert!(created.vault_path.as_str().starts_with("notes/"));
    }

    #[test]
    fn create_new_note_allows_duplicate_titles_with_unique_filenames() {
        // Canonical filenames carry a random short id, so two notes sharing a
        // title no longer collide — they land at distinct paths.
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let root = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&root).unwrap();

        fs::write(
            cwd.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();

        let first = create_new_note(&cwd, "Same Title", None).unwrap();
        let second = create_new_note(&cwd, "Same Title", None).unwrap();

        assert_ne!(first.vault_path.as_str(), second.vault_path.as_str());
        assert!(crate::vault::path::is_canonical_page_filename(
            first.vault_path.filename()
        ));
        assert!(crate::vault::path::is_canonical_page_filename(
            second.vault_path.filename()
        ));
    }

    #[test]
    fn projected_note_path_uses_kind_project_and_supplied_short_id() {
        let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z")
            .unwrap()
            .to_utc();

        let path = build_projected_note_path(
            "The Left Hand of Darkness",
            created,
            crate::vault::kind::Kind::Book,
            Some("ursula"),
            "Ab3xYz90",
        )
        .unwrap();

        assert_eq!(
            path.as_str(),
            "books/ursula/20260809.the-left-hand-of-darkness.Ab3xYz90.md"
        );
    }

    #[test]
    fn projected_note_path_uses_canonical_kind_folder_without_project() {
        let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z")
            .unwrap()
            .to_utc();

        let path = build_projected_note_path(
            "Inbox Thought",
            created,
            crate::vault::kind::Kind::Note,
            None,
            "Ab3xYz90",
        )
        .unwrap();

        assert_eq!(path.as_str(), "notes/20260809.inbox-thought.Ab3xYz90.md");
    }

    #[test]
    fn projected_note_path_rejects_project_traversal() {
        let created = chrono::DateTime::parse_from_rfc3339("2026-08-09T12:00:00Z")
            .unwrap()
            .to_utc();

        let error = build_projected_note_path(
            "Escaping Note",
            created,
            crate::vault::kind::Kind::Note,
            Some("../outside"),
            "Ab3xYz90",
        )
        .unwrap_err();

        assert!(matches!(error, NewNoteError::InvalidPath(_)));
    }

    #[test]
    fn create_new_note_rejects_empty_title() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let root = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&root).unwrap();

        fs::write(
            cwd.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();

        let err = create_new_note(&cwd, "   ", None).unwrap_err();
        assert!(matches!(err, NewNoteError::EmptyTitle));
    }

    #[test]
    fn parent_creation_failure_writes_no_note() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let root = dir.path().join("vault");
        fs::create_dir_all(&cwd).unwrap();
        init_vault(&root).unwrap();
        fs::write(
            cwd.join("config.toml"),
            format!("[vault]\nroot = \"{}\"\n", root.display()),
        )
        .unwrap();
        fs::write(
            root.join(".clepsydra/config.toml"),
            "[vault]\ndefault_page_folder = \"blocked\"\n",
        )
        .unwrap();
        fs::write(root.join("blocked"), b"existing file").unwrap();

        let error = create_new_note(&cwd, "Cannot Publish", None).unwrap_err();

        assert!(matches!(error, NewNoteError::Io(_)));
        assert_eq!(fs::read(root.join("blocked")).unwrap(), b"existing file");
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .all(
                    |entry| entry.path().extension().and_then(|value| value.to_str()) != Some("md")
                )
        );
    }
}
