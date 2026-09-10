//! Application settings: the `config.toml` lookup, the layered `Settings`
//! struct hierarchy, and the small path-expansion helpers every consumer of
//! those settings needs (`expand_tilde`, `resolve_vault_root`,
//! `default_tls_paths`).

pub mod app_config;

use std::path::{Path, PathBuf};

use config::{Config, Environment, File};
use serde::Deserialize;

use app_config::{config_candidates, find_config_path};

/// Expand a leading `~` or `~/` in `p` to the user's home directory.
///
/// Returns `None` for paths that do not start with `~`.
pub fn expand_tilde(p: &str) -> Option<PathBuf> {
    if p == "~" {
        dirs::home_dir()
    } else if let Some(rest) = p.strip_prefix("~/") {
        dirs::home_dir().map(|h| h.join(rest))
    } else {
        None
    }
}

/// Vault-relative path to the on-disk index/cache database. Shared by every
/// callsite that opens a `VaultIndex` so they cannot drift.
pub const INDEX_DB_RELATIVE: &str = ".clepsydra/cache.db";

/// Barbican orange — the Vessel primary accent, as an RGB triple. Shared by
/// every terminal renderer (`grep`, `tree`, diagnostics) so the accent cannot
/// drift between commands. `anstream` down-samples this truecolor value to the
/// nearest palette entry on 16/256-colour terminals.
pub const VESSEL_ACCENT: (u8, u8, u8) = (0xee, 0x77, 0x33);

#[derive(Debug, Deserialize)]
pub struct Settings {
    pub server: ServerSettings,
    #[serde(default)]
    pub vault: VaultSettings,
    #[serde(default)]
    pub features: FeatureFlags,
    #[serde(default)]
    pub feeds: FeedsSettings,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub struct FeatureFlags {
    #[serde(default = "enabled")]
    pub academic: bool,
    #[serde(default = "enabled")]
    pub feeds: bool,
}

const fn enabled() -> bool {
    true
}

impl Default for FeatureFlags {
    fn default() -> Self {
        Self {
            academic: true,
            feeds: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FeedsSettings {
    #[serde(default = "default_fetch_interval_minutes")]
    pub fetch_interval_minutes: u64,
    #[serde(default = "default_retention_days")]
    pub retention_days: u64,
    #[serde(default = "default_unread_retention_days")]
    pub unread_retention_days: u64,
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: usize,
    #[serde(default = "default_max_entry_content_bytes")]
    pub max_entry_content_bytes: usize,
    #[serde(default = "default_fetch_concurrency")]
    pub fetch_concurrency: usize,
}

const fn default_fetch_interval_minutes() -> u64 {
    30
}

const fn default_retention_days() -> u64 {
    30
}

const fn default_unread_retention_days() -> u64 {
    90
}

const fn default_max_response_bytes() -> usize {
    10_485_760
}

const fn default_max_entry_content_bytes() -> usize {
    1_048_576
}

const fn default_fetch_concurrency() -> usize {
    4
}

impl Default for FeedsSettings {
    fn default() -> Self {
        Self {
            fetch_interval_minutes: default_fetch_interval_minutes(),
            retention_days: default_retention_days(),
            unread_retention_days: default_unread_retention_days(),
            max_response_bytes: default_max_response_bytes(),
            max_entry_content_bytes: default_max_entry_content_bytes(),
            fetch_concurrency: default_fetch_concurrency(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ServerSettings {
    /// The host to listen on. (Default: "localhost".)
    pub host: String,
    /// The port to listen on. (Default: 3000.)
    pub port: u16,
    /// When true, the server will include extra debug information in API responses
    #[serde(default)]
    pub dev_mode: bool,
    /// TLS settings. When `tls.enabled` is true, the server will serve over HTTPS
    /// using the provided cert/key or auto-generated defaults.
    #[serde(default)]
    pub tls: TlsSettings,
    /// Extra browser origins that reach this server through a reverse proxy or
    /// tunnel, such as `https://clepsydra.localhost`. The archive snapshot viewer
    /// emits a Content-Security-Policy for exactly one origin — the bind origin or
    /// one of these — selected by the request's `Host` header. Entries must be bare
    /// `scheme://host[:port]` origins: no wildcards, paths, queries, or credentials.
    /// (Default: empty.)
    #[serde(default)]
    pub public_origins: Vec<String>,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            host: "localhost".to_string(),
            port: 16667,
            dev_mode: false,
            tls: TlsSettings::default(),
            public_origins: Vec::new(),
        }
    }
}

impl ServerSettings {
    /// Parse the configured host as a single CSP-safe URL host.
    pub fn server_host_for_origin(&self) -> Result<url::Host<String>, String> {
        let raw = self.host.as_str();
        if raw.is_empty() {
            return Err("server.host must not be empty".to_string());
        }
        if raw.contains('*') {
            return Err(format!("server.host must not contain a wildcard: {raw}"));
        }

        let parsed_host = if let Some(inner) = raw
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
        {
            let address = inner.parse::<std::net::Ipv6Addr>().map_err(|error| {
                format!("server.host must contain a valid host name or IP address: {raw}: {error}")
            })?;
            url::Host::Ipv6(address)
        } else if raw.contains(':') {
            let address = raw.parse::<std::net::Ipv6Addr>().map_err(|error| {
                format!("server.host must contain a valid host name or IP address: {raw}: {error}")
            })?;
            url::Host::Ipv6(address)
        } else {
            url::Host::parse(raw).map_err(|error| {
                format!("server.host must contain a valid host name or IP address: {raw}: {error}")
            })?
        };

        if matches!(
            &parsed_host,
            url::Host::Domain(domain) if domain.contains('*')
        ) {
            return Err(format!(
                "server.host must not decode to a wildcard domain: {raw}"
            ));
        }

        if matches!(
            &parsed_host,
            url::Host::Ipv4(address) if address.is_unspecified()
        ) || matches!(
            &parsed_host,
            url::Host::Ipv6(address) if address.is_unspecified()
        ) {
            return Err(format!(
                "server.host must name a concrete browser origin, not an unspecified bind address: {raw}"
            ));
        }

        Ok(parsed_host)
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct TlsSettings {
    /// When true, the server will serve over HTTPS using the provided cert/key or auto-generated
    /// defaults. (Default: false)
    #[serde(default)]
    pub enabled: bool,
    /// Path to the TLS certificate file. Can be absolute or relative to the config file location
    /// (`~` is expanded). Must be set together with `key_path`. When both are unset, the server
    /// will auto-generate certs for localhost using mkcert and store them in the app data
    /// directory.
    pub cert_path: Option<PathBuf>,
    /// Path to the TLS private key file. Can be absolute or relative to the config file location
    /// (`~` is expanded). Must be set together with `cert_path`. When both are unset, the server
    /// will auto-generate certs for localhost using mkcert and store them in the app data
    /// directory.
    pub key_path: Option<PathBuf>,
}

/// Command-line overrides for `serve`, applied on top of loaded [`Settings`].
///
/// These sit above both the config file and the `CLEPSYDRA__*` environment
/// variables in precedence, so a flag always wins over what is on disk. The
/// point is to make a throwaway server — an HTTPS one on a spare port, for
/// testing a client against — a single command rather than an edit to the
/// config the everyday server shares.
#[derive(Debug, Default, Clone, Copy)]
pub struct ServeOverrides {
    /// Force HTTPS on. Deliberately one-way: there is no flag to force it
    /// *off*, so `serve` can never silently downgrade a TLS config to cleartext.
    pub tls: bool,
    /// Listen on this port instead of the configured one.
    pub port: Option<u16>,
}

impl ServeOverrides {
    /// Apply the overrides in place; unset ones leave `settings` untouched.
    pub fn apply(self, settings: &mut Settings) {
        if self.tls {
            settings.server.tls.enabled = true;
        }
        if let Some(port) = self.port {
            settings.server.port = port;
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct VaultSettings {
    /// The vault root directory. Can be absolute or relative to the config file location. (Default: "./vault")
    #[serde(default = "default_vault_root")]
    pub root: String,
}

fn default_vault_root() -> String {
    "./vault".to_string()
}

impl Default for VaultSettings {
    fn default() -> Self {
        Self {
            root: default_vault_root(),
        }
    }
}

impl Settings {
    /// Load settings from the config file discovered at `base_dir` (or its parents), layering
    /// defaults and environment variables on top. Returns the loaded settings and the path to the
    /// config file.
    pub fn load(base_dir: &Path) -> Result<(Self, PathBuf), Box<dyn std::error::Error>> {
        let candidates = config_candidates(base_dir);
        let checked = candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");

        let config_path = find_config_path(base_dir).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no config.toml found (checked: {checked})"),
            )
        })?;

        let settings = Self::load_from(&config_path)?;
        Ok((settings, config_path))
    }

    /// Load settings from a known `config.toml` path, layering defaults and
    /// environment variables on top.
    ///
    /// TLS cert/key paths are resolved to absolute paths here (tilde expansion,
    /// then relative-to-config-dir, or relative-to-cwd when env-supplied) so
    /// every consumer sees the same on-disk locations regardless of where the
    /// process was launched from.
    pub fn load_from(config_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        // Precedence (later wins): defaults < config file < env vars.
        // `serve` flags layer on top of this — see [`ServeOverrides`].
        let mut settings: Settings = Config::builder()
            .set_default("server.host", "localhost")?
            .set_default("server.port", 3000)?
            .set_default("server.dev_mode", false)?
            .set_default("server.tls.enabled", false)?
            .set_default("vault.root", "./vault")?
            .add_source(File::from(config_path.to_path_buf()))
            .add_source(Environment::with_prefix("CLEPSYDRA").separator("__"))
            .build()?
            .try_deserialize()?;

        let cwd = std::env::current_dir()?;
        let tls = &mut settings.server.tls;
        tls.cert_path = tls.cert_path.take().map(|p| {
            resolve_config_path(&p, "CLEPSYDRA__SERVER__TLS__CERT_PATH", config_path, &cwd)
        });
        tls.key_path = tls.key_path.take().map(|p| {
            resolve_config_path(&p, "CLEPSYDRA__SERVER__TLS__KEY_PATH", config_path, &cwd)
        });
        Ok(settings)
    }
}

/// Resolve a possibly-relative path from config into an absolute filesystem
/// path, mirroring [`resolve_vault_root`]'s rules.
///
/// Order: tilde expansion, absolute passthrough, paths supplied via `env_var`
/// resolved against `cwd`, and finally relative paths resolved against the
/// config file's parent directory.
fn resolve_config_path(p: &Path, env_var: &str, config_path: &Path, cwd: &Path) -> PathBuf {
    if let Some(expanded) = p.to_str().and_then(expand_tilde) {
        return expanded;
    }

    if p.is_absolute() {
        return p.to_path_buf();
    }

    // If the path was supplied via env, keep it relative to the process CWD.
    if std::env::var_os(env_var).is_some() {
        return cwd.join(p);
    }

    // Otherwise, resolve relative paths against the config file directory
    // (important for XDG config usage).
    if let Some(parent) = config_path.parent() {
        return parent.join(p);
    }

    cwd.join(p)
}

/// Resolve the vault root string from config into an absolute filesystem path.
///
/// Order: tilde expansion, absolute passthrough, env-supplied roots resolved
/// against `cwd`, and finally relative roots resolved against the config file's
/// parent directory.
pub fn resolve_vault_root(root: &str, config_path: &Path, cwd: &Path) -> PathBuf {
    resolve_config_path(Path::new(root), "CLEPSYDRA__VAULT__ROOT", config_path, cwd)
}

/// Resolve the on-disk cert + key paths for the given TLS settings, without
/// generating any new certificates.
///
/// Returns `(cert_path, key_path, paths_were_explicit)`. When the paths are
/// the auto-discovered defaults under `dirs::data_dir()`, the third element
/// is `false`.
///
/// Returns `Err` when exactly one of `cert_path`/`key_path` is set (a
/// half-configured cert pair, which is almost certainly a typo); the caller
/// is expected to surface the message as a configuration error rather than
/// silently falling back to auto-discovered paths.
pub fn default_tls_paths(tls: &TlsSettings) -> Result<Option<(PathBuf, PathBuf, bool)>, String> {
    match (&tls.cert_path, &tls.key_path) {
        (Some(cert), Some(key)) => Ok(Some((cert.clone(), key.clone(), true))),
        (Some(_), None) => {
            Err("tls.cert_path is set but tls.key_path is not — set both or neither".to_string())
        }
        (None, Some(_)) => {
            Err("tls.key_path is set but tls.cert_path is not — set both or neither".to_string())
        }
        (None, None) => {
            let Some(data_dir) = dirs::data_dir().map(|d| d.join("clepsydra")) else {
                return Ok(None);
            };
            Ok(Some((
                data_dir.join("localhost.pem"),
                data_dir.join("localhost-key.pem"),
                false,
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clep_test_support::EnvGuard;

    fn assert_feature_defaults(features: FeatureFlags) {
        assert!(features.academic);
        assert!(features.feeds);
    }

    #[test]
    fn settings_without_features_use_enabled_defaults() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        std::fs::write(&config, "").unwrap();

        assert_feature_defaults(Settings::load_from(&config).unwrap().features);
    }

    #[test]
    fn settings_read_independent_feature_values() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        std::fs::write(&config, "[features]\nacademic = false\nfeeds = true\n").unwrap();

        let features = Settings::load_from(&config).unwrap().features;
        assert!(!features.academic);
        assert!(features.feeds);
    }

    #[serial_test::serial]
    #[test]
    fn feature_environment_override_wins_over_file() {
        let _guard = EnvGuard::set("CLEPSYDRA__FEATURES__FEEDS", "false");
        let tmp = tempfile::TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        std::fs::write(&config, "[features]\nfeeds = true\n").unwrap();

        assert!(!Settings::load_from(&config).unwrap().features.feeds);
    }

    fn assert_feed_defaults(feeds: &FeedsSettings) {
        assert_eq!(feeds.fetch_interval_minutes, 30);
        assert_eq!(feeds.retention_days, 30);
        assert_eq!(feeds.unread_retention_days, 90);
        assert_eq!(feeds.max_response_bytes, 10_485_760);
        assert_eq!(feeds.max_entry_content_bytes, 1_048_576);
        assert_eq!(feeds.fetch_concurrency, 4);
    }

    #[test]
    fn feed_settings_default_and_clone_are_stable() {
        let defaults = FeedsSettings::default();
        assert_feed_defaults(&defaults);
        assert_feed_defaults(&defaults.clone());
    }

    #[test]
    fn settings_without_a_feeds_section_use_feed_defaults() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(&cfg, "").unwrap();

        let settings = Settings::load_from(&cfg).unwrap();
        assert_feed_defaults(&settings.feeds);
    }

    #[serial_test::serial]
    #[test]
    fn load_from_reads_port_from_config_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(&cfg, "[server]\nport = 9999\n").unwrap();
        let settings = Settings::load_from(&cfg).unwrap();
        assert_eq!(settings.server.port, 9999);
    }

    #[serial_test::serial]
    #[test]
    fn load_from_resolves_tls_paths_against_config_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(
            &cfg,
            "[server.tls]\nenabled = true\ncert_path = \"certs/localhost.pem\"\nkey_path = \"certs/localhost-key.pem\"\n",
        )
        .unwrap();
        let settings = Settings::load_from(&cfg).unwrap();
        assert_eq!(
            settings.server.tls.cert_path,
            Some(tmp.path().join("certs/localhost.pem"))
        );
        assert_eq!(
            settings.server.tls.key_path,
            Some(tmp.path().join("certs/localhost-key.pem"))
        );
    }

    #[serial_test::serial]
    #[test]
    fn load_from_preserves_absolute_tls_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(
            &cfg,
            "[server.tls]\nenabled = true\ncert_path = \"/etc/certs/vault.pem\"\nkey_path = \"/etc/certs/vault-key.pem\"\n",
        )
        .unwrap();
        let settings = Settings::load_from(&cfg).unwrap();
        assert_eq!(
            settings.server.tls.cert_path,
            Some(PathBuf::from("/etc/certs/vault.pem"))
        );
        assert_eq!(
            settings.server.tls.key_path,
            Some(PathBuf::from("/etc/certs/vault-key.pem"))
        );
    }

    #[serial_test::serial]
    #[test]
    fn load_from_expands_tilde_in_tls_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(
            &cfg,
            "[server.tls]\nenabled = true\ncert_path = \"~/certs/vault.pem\"\nkey_path = \"~/certs/vault-key.pem\"\n",
        )
        .unwrap();
        let settings = Settings::load_from(&cfg).unwrap();
        let home = dirs::home_dir().expect("home dir must exist for test");
        assert_eq!(
            settings.server.tls.cert_path,
            Some(home.join("certs/vault.pem"))
        );
        assert_eq!(
            settings.server.tls.key_path,
            Some(home.join("certs/vault-key.pem"))
        );
    }

    #[serial_test::serial]
    #[test]
    fn load_from_resolves_env_tls_paths_against_cwd() {
        // Env-supplied paths are typed relative to the invoking shell's cwd,
        // not the config file location — mirroring CLEPSYDRA__VAULT__ROOT.
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(&cfg, "[server.tls]\nenabled = true\n").unwrap();
        let _cert = EnvGuard::set("CLEPSYDRA__SERVER__TLS__CERT_PATH", "certs/env.pem");
        let _key = EnvGuard::set("CLEPSYDRA__SERVER__TLS__KEY_PATH", "certs/env-key.pem");
        let settings = Settings::load_from(&cfg).unwrap();
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            settings.server.tls.cert_path,
            Some(cwd.join("certs/env.pem"))
        );
        assert_eq!(
            settings.server.tls.key_path,
            Some(cwd.join("certs/env-key.pem"))
        );
    }

    fn settings_with(tls_enabled: bool, port: u16) -> Settings {
        Settings {
            server: ServerSettings {
                tls: TlsSettings {
                    enabled: tls_enabled,
                    ..TlsSettings::default()
                },
                port,
                public_origins: Vec::new(),
                ..ServerSettings::default()
            },
            vault: VaultSettings::default(),
            features: FeatureFlags::default(),
            feeds: FeedsSettings::default(),
        }
    }

    #[test]
    fn no_overrides_leave_settings_untouched() {
        let mut settings = settings_with(false, 3000);

        ServeOverrides::default().apply(&mut settings);

        assert!(!settings.server.tls.enabled);
        assert_eq!(settings.server.port, 3000);
    }

    #[test]
    fn overrides_beat_the_config_file() {
        let mut settings = settings_with(false, 3000);

        ServeOverrides {
            tls: true,
            port: Some(3443),
        }
        .apply(&mut settings);

        assert!(settings.server.tls.enabled);
        assert_eq!(settings.server.port, 3443);
    }

    #[test]
    fn omitting_tls_never_disables_it() {
        // `--tls` is one-way by design: a config that opts into HTTPS keeps it
        // when the flag is absent, so plain `serve` cannot silently downgrade
        // a deployment to cleartext.
        let mut settings = settings_with(true, 3000);

        ServeOverrides {
            tls: false,
            port: None,
        }
        .apply(&mut settings);

        assert!(settings.server.tls.enabled);
    }

    #[test]
    fn explicit_cert_paths_survive_the_tls_flag() {
        // The flag only flips `enabled`; a configured cert pair must still be
        // the pair that gets loaded rather than being replaced by mkcert's.
        let mut settings = settings_with(false, 3000);
        settings.server.tls.cert_path = Some(PathBuf::from("/etc/certs/vault.pem"));
        settings.server.tls.key_path = Some(PathBuf::from("/etc/certs/vault-key.pem"));

        ServeOverrides {
            tls: true,
            port: None,
        }
        .apply(&mut settings);

        assert!(settings.server.tls.enabled);
        assert_eq!(
            settings.server.tls.cert_path,
            Some(PathBuf::from("/etc/certs/vault.pem"))
        );
    }
}
