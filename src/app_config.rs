use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Ordered config candidates for the current invocation.
///
/// Lookup order:
/// 1. `config.toml` in the provided directory
/// 2. `$XDG_CONFIG_HOME/clepsydra/config.toml`
/// 3. `$HOME/.config/clepsydra/config.toml`
pub fn config_candidates(start_dir: &Path) -> Vec<PathBuf> {
    config_candidates_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

/// Return the first existing config file from [`config_candidates`].
pub fn find_config_path(start_dir: &Path) -> Option<PathBuf> {
    find_config_path_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

/// Internal helper that accepts env vars as parameters for easier testing.
pub(crate) fn config_candidates_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Vec<PathBuf> {
    let base_dir = if start_dir.is_file() {
        start_dir.parent().unwrap_or(start_dir)
    } else {
        start_dir
    };

    let mut candidates = vec![base_dir.join("config.toml")];

    if let Some(xdg_file) = xdg_config_file(xdg_config_home, home)
        && !candidates.contains(&xdg_file)
    {
        candidates.push(xdg_file);
    }

    candidates
}

/// Internal helper that accepts env vars as parameters for easier testing.
pub(crate) fn find_config_path_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Option<PathBuf> {
    config_candidates_with_env(start_dir, xdg_config_home, home)
        .into_iter()
        .find(|p| p.is_file())
}

/// Helper to construct the XDG config path from env vars, if set.
fn xdg_config_file(xdg_config_home: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    if let Some(xdg) = xdg_config_home {
        return Some(PathBuf::from(xdg).join("clepsydra/config.toml"));
    }

    home.map(|h| PathBuf::from(h).join(".config/clepsydra/config.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_include_local_then_xdg() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let xdg = dir.path().join("xdg");
        std::fs::create_dir_all(&cwd).unwrap();

        let candidates =
            config_candidates_with_env(&cwd, Some(xdg.as_os_str().to_os_string()), None);

        assert_eq!(candidates[0], cwd.join("config.toml"));
        assert_eq!(candidates[1], xdg.join("clepsydra/config.toml"));
    }

    #[test]
    fn find_config_prefers_local_when_both_exist() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let xdg = dir.path().join("xdg");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(xdg.join("clepsydra")).unwrap();

        let local_cfg = cwd.join("config.toml");
        let xdg_cfg = xdg.join("clepsydra/config.toml");
        std::fs::write(&local_cfg, "[vault]\nroot = \"./vault\"\n").unwrap();
        std::fs::write(&xdg_cfg, "[vault]\nroot = \"/tmp/vault\"\n").unwrap();

        let found =
            find_config_path_with_env(&cwd, Some(xdg.as_os_str().to_os_string()), None).unwrap();

        assert_eq!(found, local_cfg);
    }

    #[test]
    fn find_config_uses_xdg_when_local_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let xdg = dir.path().join("xdg");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(xdg.join("clepsydra")).unwrap();

        let xdg_cfg = xdg.join("clepsydra/config.toml");
        std::fs::write(&xdg_cfg, "[vault]\nroot = \"/tmp/vault\"\n").unwrap();

        let found =
            find_config_path_with_env(&cwd, Some(xdg.as_os_str().to_os_string()), None).unwrap();

        assert_eq!(found, xdg_cfg);
    }
}
