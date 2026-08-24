use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use owo_colors::OwoColorize;
use thiserror::Error;

use crate::VESSEL_ACCENT as ACCENT;

const LITERATE_CONFIG_TEMPLATE: &str = r##"# Clepsydra application configuration
#
# Every setting below is commented out. Uncomment the sections and values you
# want to override; leaving them commented preserves Clepsydra's defaults.
#
# Precedence: defaults → config file → environment → serve flags.
# Environment keys use CLEPSYDRA__SECTION__KEY, for example:
# CLEPSYDRA__SERVER__HOST or CLEPSYDRA__VAULT__ROOT.

# [server]
# Bind host. Default: localhost.
# host = "localhost"
# Bind port. Default: 3000.
# port = 3000
# Disable the embedded frontend when true. Default: false.
# dev_mode = false

# [server.tls]
# Serve HTTPS when true. Default: false.
# enabled = false
# Optional certificate paths. cert_path and key_path must be set together.
# If both are omitted, TLS uses an automatically provisioned localhost cert.
# cert_path = "certs/localhost.pem"
# key_path = "certs/localhost-key.pem"

# [vault]
# Vault root. Relative paths resolve relative to this config file.
# Default: ./vault.
# root = "./vault"

# [feeds]
# Periodic RSS/Atom fetch interval in minutes. Default: 30.
# fetch_interval_minutes = 30
# Retain read, unbookmarked entries for this many days. Default: 30.
# retention_days = 30
# Retain unread, unbookmarked entries for this many days. Default: 90.
# unread_retention_days = 90
# Maximum bytes accepted from one HTTP response. Default: 10485760.
# max_response_bytes = 10485760
# Maximum stored HTML bytes per entry; larger content is omitted. Default: 1048576.
# max_entry_content_bytes = 1048576
# Maximum simultaneous feed fetches. Default: 4.
# fetch_concurrency = 4
"##;

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigResolution {
    pub path: PathBuf,
    pub considered: Vec<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExistingConfig {
    pub resolution: ConfigResolution,
    pub contents: Vec<u8>,
}

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

pub fn resolve_existing(start_dir: &Path) -> Result<ConfigResolution, ConfigCommandError> {
    resolve_existing_with_env(
        start_dir,
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

fn resolve_existing_with_env(
    start_dir: &Path,
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<ConfigResolution, ConfigCommandError> {
    let mut considered =
        crate::app_config::config_candidates_with_env(start_dir, xdg_config_home, home);
    let Some(selected_index) = considered.iter().position(|path| path.is_file()) else {
        let searched = considered
            .iter()
            .map(|path| format!("  {}", path.display()))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(ConfigCommandError::NotFound { searched });
    };

    considered.truncate(selected_index + 1);
    Ok(ConfigResolution {
        path: considered[selected_index].clone(),
        considered,
    })
}

pub fn read_existing(start_dir: &Path) -> Result<ExistingConfig, ConfigCommandError> {
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
) -> Result<ExistingConfig, ConfigCommandError> {
    let resolution = resolve_existing_with_env(start_dir, xdg_config_home, home)?;
    let contents = fs::read(&resolution.path).map_err(|source| ConfigCommandError::Io {
        operation: "read",
        path: resolution.path.clone(),
        source,
    })?;
    Ok(ExistingConfig {
        resolution,
        contents,
    })
}

pub fn render_origin(path: &Path, writer: &mut impl Write) -> io::Result<()> {
    writeln!(
        writer,
        "Origin: {}",
        path.display().truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
    )
}

pub fn render_trace(resolution: &ConfigResolution, writer: &mut impl Write) -> io::Result<()> {
    for candidate in &resolution.considered {
        if candidate == &resolution.path {
            writeln!(
                writer,
                "{}",
                format_args!("→ {}", candidate.display()).truecolor(ACCENT.0, ACCENT.1, ACCENT.2)
            )?;
        } else {
            writeln!(writer, "  {}", candidate.display().dimmed())?;
        }
    }
    Ok(())
}

pub fn create() -> Result<PathBuf, ConfigCommandError> {
    create_with_env(env::var_os("XDG_CONFIG_HOME"), env::var_os("HOME"))
}

fn create_with_env(
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
) -> Result<PathBuf, ConfigCommandError> {
    create_with_env_and_write(xdg_config_home, home, |file| {
        file.write_all(LITERATE_CONFIG_TEMPLATE.as_bytes())
    })
}

fn create_with_env_and_write(
    xdg_config_home: Option<OsString>,
    home: Option<OsString>,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
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
        Ok(mut file) => {
            if let Err(source) = write(&mut file) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(ConfigCommandError::Io {
                    operation: "write",
                    path,
                    source,
                });
            }
            Ok(path)
        }
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

    fn path(value: &Path) -> PathBuf {
        value.to_path_buf()
    }

    #[test]
    fn origin_renderer_colors_selected_path_and_strips_cleanly() {
        let selected = Path::new("/tmp/clepsydra/config.toml");
        let mut styled = Vec::new();
        render_origin(selected, &mut styled).unwrap();
        let styled = String::from_utf8(styled).unwrap();
        assert!(styled.contains("\u{1b}[38;2;238;119;51m"));

        let mut plain = Vec::new();
        {
            let mut stream = anstream::AutoStream::new(&mut plain, anstream::ColorChoice::Never);
            render_origin(selected, &mut stream).unwrap();
        }
        assert_eq!(plain, b"Origin: /tmp/clepsydra/config.toml\n");
    }

    #[test]
    fn trace_renderer_lists_considered_paths_in_order_and_highlights_selected() {
        let resolution = ConfigResolution {
            path: PathBuf::from("/xdg/clepsydra/config.toml"),
            considered: vec![
                PathBuf::from("/cwd/config.toml"),
                PathBuf::from("/xdg/clepsydra/config.toml"),
            ],
        };
        let mut styled = Vec::new();
        render_trace(&resolution, &mut styled).unwrap();
        let styled = String::from_utf8(styled).unwrap();
        assert!(styled.contains("\u{1b}[2m/cwd/config.toml\u{1b}[0m"));
        assert!(styled.contains("\u{1b}[38;2;238;119;51m→"));
        assert!(styled.contains("\u{1b}[38;2;238;119;51m→ /xdg/clepsydra/config.toml\u{1b}[39m"));

        let mut plain = Vec::new();
        {
            let mut stream = anstream::AutoStream::new(&mut plain, anstream::ColorChoice::Never);
            render_trace(&resolution, &mut stream).unwrap();
        }

        assert_eq!(
            plain,
            b"  /cwd/config.toml\n\xe2\x86\x92 /xdg/clepsydra/config.toml\n"
        );
    }

    #[test]
    fn resolution_stops_at_local_config() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("config.toml");
        fs::write(&local, b"local").unwrap();

        let resolution = resolve_existing_with_env(
            dir.path(),
            Some(OsString::from("/unused/xdg")),
            Some(OsString::from("/unused/home")),
        )
        .unwrap();

        assert_eq!(resolution.path, local);
        assert_eq!(resolution.considered, vec![path(&local)]);
    }

    #[test]
    fn resolution_stops_at_xdg_after_local() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let local = dir.path().join("config.toml");
        let selected = xdg.path().join("clepsydra/config.toml");
        fs::create_dir_all(selected.parent().unwrap()).unwrap();
        fs::write(&selected, b"xdg").unwrap();

        let resolution = resolve_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            Some(OsString::from("/unused/home")),
        )
        .unwrap();

        assert_eq!(resolution.path, selected);
        assert_eq!(resolution.considered, vec![local, selected]);
    }

    #[test]
    fn resolution_reaches_home_after_missing_local_and_xdg() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let local = dir.path().join("config.toml");
        let xdg_path = xdg.path().join("clepsydra/config.toml");
        let selected = home.path().join(".config/clepsydra/config.toml");
        fs::create_dir_all(selected.parent().unwrap()).unwrap();
        fs::write(&selected, b"home").unwrap();

        let resolution = resolve_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            Some(home.path().as_os_str().to_owned()),
        )
        .unwrap();

        assert_eq!(resolution.path, selected);
        assert_eq!(resolution.considered, vec![local, xdg_path, selected]);
    }

    #[test]
    fn read_returns_same_resolution_and_exact_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("config.toml");
        fs::write(&local, b"\xff\xfe\x00local").unwrap();

        let config = read_existing_with_env(dir.path(), None, None).unwrap();

        assert_eq!(config.resolution.path, local);
        assert_eq!(config.resolution.considered, vec![path(&local)]);
        assert_eq!(config.contents, b"\xff\xfe\x00local");
    }

    #[test]
    fn read_prefers_local_config_and_preserves_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let xdg_file = xdg.path().join("clepsydra/config.toml");
        fs::create_dir_all(xdg_file.parent().unwrap()).unwrap();
        fs::write(&xdg_file, b"xdg = true\n").unwrap();
        fs::write(dir.path().join("config.toml"), b"\xff\xfe\x00local").unwrap();

        let bytes =
            read_existing_with_env(dir.path(), Some(xdg.path().as_os_str().to_owned()), None)
                .unwrap();

        assert_eq!(bytes.contents, b"\xff\xfe\x00local");
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

        assert_eq!(bytes.contents, b"source = 'xdg'");
    }

    #[test]
    fn read_falls_back_to_home_when_xdg_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let home_file = home.path().join(".config/clepsydra/config.toml");
        fs::create_dir_all(home_file.parent().unwrap()).unwrap();
        fs::write(&home_file, b"source = 'home'").unwrap();

        let bytes = read_existing_with_env(
            dir.path(),
            Some(xdg.path().as_os_str().to_owned()),
            Some(home.path().as_os_str().to_owned()),
        )
        .unwrap();

        assert_eq!(bytes.contents, b"source = 'home'");
    }

    #[test]
    fn read_uses_home_when_xdg_is_unset() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let home_file = home.path().join(".config/clepsydra/config.toml");
        fs::create_dir_all(home_file.parent().unwrap()).unwrap();
        fs::write(&home_file, b"source = 'home-only'").unwrap();

        let bytes =
            read_existing_with_env(dir.path(), None, Some(home.path().as_os_str().to_owned()))
                .unwrap();

        assert_eq!(bytes.contents, b"source = 'home-only'");
    }

    #[test]
    fn read_error_lists_all_candidates() {
        let dir = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();

        let error =
            read_existing_with_env(dir.path(), Some(xdg.path().as_os_str().to_owned()), None)
                .unwrap_err();
        let message = error.to_string();

        assert!(message.contains(&dir.path().join("config.toml").display().to_string()));
        assert!(
            message.contains(
                &xdg.path()
                    .join("clepsydra/config.toml")
                    .display()
                    .to_string()
            )
        );
    }

    #[test]
    fn create_targets_xdg_and_makes_missing_parents() {
        let xdg = tempfile::tempdir().unwrap();
        let root = xdg.path().join("nested");

        let path = create_with_env(Some(root.as_os_str().to_owned()), None).unwrap();

        assert_eq!(path, root.join("clepsydra/config.toml"));
        assert!(path.is_file());
        assert_eq!(fs::read(path).unwrap(), LITERATE_CONFIG_TEMPLATE.as_bytes());
    }

    #[test]
    fn create_falls_back_to_home_dot_config() {
        let home = tempfile::tempdir().unwrap();

        let path = create_with_env(None, Some(home.path().as_os_str().to_owned())).unwrap();

        assert_eq!(path, home.path().join(".config/clepsydra/config.toml"));
        assert_eq!(fs::read(path).unwrap(), LITERATE_CONFIG_TEMPLATE.as_bytes());
    }

    #[test]
    fn create_writes_literate_comment_only_template() {
        let xdg = tempfile::tempdir().unwrap();
        let path = create_with_env(Some(xdg.path().as_os_str().to_owned()), None).unwrap();
        let contents = fs::read_to_string(path).unwrap();

        assert!(!contents.is_empty());
        for expected in [
            "# [server]",
            "# host = \"localhost\"",
            "# port = 3000",
            "# dev_mode = false",
            "# [server.tls]",
            "# enabled = false",
            "# cert_path = \"certs/localhost.pem\"",
            "# key_path = \"certs/localhost-key.pem\"",
            "# [vault]",
            "# root = \"./vault\"",
            "# [feeds]",
            "# fetch_interval_minutes = 30",
            "# retention_days = 30",
            "# unread_retention_days = 90",
            "# max_response_bytes = 10485760",
            "# max_entry_content_bytes = 1048576",
            "# fetch_concurrency = 4",
        ] {
            assert!(
                contents.contains(expected),
                "missing template line: {expected}"
            );
        }

        let parsed = contents.parse::<toml::Table>().unwrap();
        assert!(parsed.is_empty());
    }

    #[test]
    fn template_documents_precedence_and_tls_pairing() {
        let xdg = tempfile::tempdir().unwrap();
        let path = create_with_env(Some(xdg.path().as_os_str().to_owned()), None).unwrap();
        let contents = fs::read_to_string(path).unwrap();

        assert!(contents.contains("CLEPSYDRA__SERVER__HOST"));
        assert!(contents.contains("defaults → config file → environment → serve flags"));
        assert!(contents.contains("cert_path and key_path must be set together"));
        assert!(contents.contains("relative to this config file"));
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

    #[test]
    fn incomplete_config_write_removes_created_file() {
        let xdg = tempfile::tempdir().unwrap();
        let path = xdg.path().join("clepsydra/config.toml");

        let error =
            create_with_env_and_write(Some(xdg.path().as_os_str().to_owned()), None, |_| {
                Err(io::Error::other("injected config write failure"))
            })
            .unwrap_err();

        assert!(matches!(
            error,
            ConfigCommandError::Io {
                operation: "write",
                ..
            }
        ));
        assert!(!path.exists());
    }
}
