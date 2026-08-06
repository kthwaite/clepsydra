use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigCommandError {
    #[error("no config.toml found; searched:\n{searched}")]
    NotFound { searched: String },
    #[error("cannot determine user config directory: XDG_CONFIG_HOME and HOME are unset")]
    NoConfigHome,
    #[error("config already exists: {path}")]
    AlreadyExists { path: PathBuf },
    #[error("failed to {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub fn read_existing(start_dir: &Path) -> Result<Vec<u8>, ConfigCommandError> {
    read_existing_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

fn read_existing_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<Vec<u8>, ConfigCommandError> {
    let candidates =
        crate::app_config::config_candidates_with_env(start_dir, xdg_config_home, home);
    let Some(path) = candidates.iter().find(|path| path.is_file()) else {
        let searched = candidates
            .iter()
            .map(|path| format!("  {}", path.display()))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ConfigCommandError::NotFound { searched });
    };

    fs::read(path).map_err(|source| ConfigCommandError::Io {
        operation: "read",
        path: path.clone(),
        source,
    })
}

pub fn create() -> Result<PathBuf, ConfigCommandError> {
    create_with_env(env::var_os("XDG_CONFIG_HOME"), env::var_os("HOME"))
}

fn create_with_env(
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, ConfigCommandError> {
    let path = match xdg_config_home {
        Some(root) => PathBuf::from(root).join("clepsydra/config.toml"),
        None => PathBuf::from(home.ok_or(ConfigCommandError::NoConfigHome)?)
            .join(".config/clepsydra/config.toml"),
    };
    let parent = path.parent().expect("config path always has a parent");
    fs::create_dir_all(parent).map_err(|source| ConfigCommandError::Io {
        operation: "create directory for",
        path: parent.to_path_buf(),
        source,
    })?;

    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(path),
        Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
            Err(ConfigCommandError::AlreadyExists { path })
        }
        Err(source) => Err(ConfigCommandError::Io {
            operation: "create",
            path,
            source,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_prefers_local_config_and_preserves_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let xdg_file = xdg.path().join("clepsydra/config.toml");
        fs::create_dir_all(xdg_file.parent().unwrap()).unwrap();
        fs::write(&xdg_file, b"xdg = true\n").unwrap();
        fs::write(dir.path().join("config.toml"), b"local = true").unwrap();

        let bytes = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            None,
        )
        .unwrap();

        assert_eq!(bytes, b"local = true");
    }

    #[test]
    fn read_uses_xdg_before_home_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let xdg_file = xdg.path().join("clepsydra/config.toml");
        let home_file = home.path().join(".config/clepsydra/config.toml");
        fs::create_dir_all(xdg_file.parent().unwrap()).unwrap();
        fs::create_dir_all(home_file.parent().unwrap()).unwrap();
        fs::write(&xdg_file, b"source = 'xdg'").unwrap();
        fs::write(&home_file, b"source = 'home'").unwrap();

        let bytes = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            Some(home.path().as_os_str().to_owned()),
        )
        .unwrap();

        assert_eq!(bytes, b"source = 'xdg'");
    }

    #[test]
    fn read_error_lists_all_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();

        let error = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            None,
        )
        .unwrap_err();
        let message = error.to_string();

        assert!(message.contains(&dir.path().join("config.toml").display().to_string()));
        assert!(message.contains(
            &xdg.path()
                .join("clepsydra/config.toml")
                .display()
                .to_string()
        ));
    }

    #[test]
    fn create_targets_xdg_and_makes_missing_parents() {
        let xdg = tempfile::tempdir().unwrap();
        let root = xdg.path().join("nested");

        let path = create_with_env(Some(root.as_os_str().to_owned()), None).unwrap();

        assert_eq!(path, root.join("clepsydra/config.toml"));
        assert!(path.is_file());
        assert_eq!(fs::metadata(path).unwrap().len(), 0);
    }

    #[test]
    fn create_falls_back_to_home_dot_config() {
        let home = tempfile::tempdir().unwrap();

        let path = create_with_env(None, Some(home.path().as_os_str().to_owned())).unwrap();

        assert_eq!(path, home.path().join(".config/clepsydra/config.toml"));
        assert_eq!(fs::metadata(path).unwrap().len(), 0);
    }

    #[test]
    fn create_refuses_to_overwrite_existing_config() {
        let xdg = tempfile::tempdir().unwrap();
        let path = xdg.path().join("clepsydra/config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"keep = true\n").unwrap();

        let error = create_with_env(Some(xdg.path().as_os_str().to_owned()), None).unwrap_err();

        assert!(matches!(error, ConfigCommandError::AlreadyExists { path: p } if p == path));
        assert_eq!(fs::read(path).unwrap(), b"keep = true\n");
    }

    #[test]
    fn create_requires_xdg_or_home() {
        let error = create_with_env(None, None).unwrap_err();
        assert!(matches!(error, ConfigCommandError::NoConfigHome));
    }
}
