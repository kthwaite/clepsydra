pub mod api;
pub mod app_config;
pub mod config_command;
pub mod deeplink;
pub mod doctor;
pub mod feeds;
pub mod lsp;
pub mod macos_url_handler;
pub mod mcp;
pub mod todo_capture;
pub mod vault;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use config::{Config, Environment, File};
use serde::Deserialize;
use tower::ServiceBuilder;
use tower_http::trace::TraceLayer;
use tracing::{Level, info};
use tracing_subscriber::{EnvFilter, fmt};

use api::AppState;
use app_config::{config_candidates, find_config_path};
use vault::Vault;
use vault::index::VaultIndex;
use vault::index_handle::IndexHandle;
use vault::path::VaultPath;
use vault::sync::ChangeEvent;
use vault::sync::watcher::VaultWatcher;

/// Vault-relative path to the on-disk index/cache database. Shared by every
/// callsite that opens a [`VaultIndex`] so they cannot drift.
const INDEX_DB_RELATIVE: &str = ".clepsydra/cache.db";

/// Barbican orange — the Vessel primary accent, as an RGB triple. Shared by
/// every terminal renderer (`grep`, `tree`, diagnostics) so the accent cannot
/// drift between commands. `anstream` down-samples this truecolor value to the
/// nearest palette entry on 16/256-colour terminals.
pub(crate) const VESSEL_ACCENT: (u8, u8, u8) = (0xee, 0x77, 0x33);

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
    pub(crate) fn server_host_for_origin(&self) -> Result<url::Host<String>, String> {
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

fn drain_change_batch(
    first: ChangeEvent,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<ChangeEvent>,
) -> Vec<ChangeEvent> {
    let mut batch = vec![first];
    while let Ok(event) = rx.try_recv() {
        batch.push(event);
    }
    batch
}

fn notifications_from_batch(batch: &[ChangeEvent]) -> Vec<api::events::SyncNotification> {
    let mut upserted: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    let mut base_registry_changed = false;

    for ev in batch {
        match ev {
            ChangeEvent::Upsert(vp) => upserted.push(vp.as_str().to_string()),
            ChangeEvent::Remove(vp) => removed.push(vp.as_str().to_string()),
            ChangeEvent::BaseChanged => base_registry_changed = true,
        }
    }

    let mut notifications = Vec::new();
    if !upserted.is_empty() || !removed.is_empty() {
        notifications.push(api::events::SyncNotification::IndexChanged { upserted, removed });
    }
    if base_registry_changed {
        notifications.push(api::events::SyncNotification::BaseRegistryChanged);
    }
    notifications
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

/// Invoke mkcert to install the local CA and generate localhost certs.
fn run_mkcert(cert_path: &Path, key_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    info!("Generating TLS certificates with mkcert...");
    let status = std::process::Command::new("mkcert")
        .arg("-install")
        .status();
    match status {
        Ok(s) if s.success() => {
            let status = std::process::Command::new("mkcert")
                .arg("-cert-file")
                .arg(cert_path)
                .arg("-key-file")
                .arg(key_path)
                .arg("localhost")
                .arg("127.0.0.1")
                .arg("::1")
                .status()?;
            if !status.success() {
                return Err("mkcert failed to generate certificates".into());
            }
            Ok(())
        }
        _ => Err("mkcert not found or failed to install CA. Please install mkcert (https://github.com/FiloSottile/mkcert)".into()),
    }
}

/// Create the data dir and generate certs via mkcert if either file is missing.
fn generate_certificates_if_missing(
    data_dir: &Path,
    cert_path: &Path,
    key_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(data_dir)?;
    if !cert_path.exists() || !key_path.exists() {
        run_mkcert(cert_path, key_path)?;
    }
    Ok(())
}

async fn ensure_certificates(
    tls: &TlsSettings,
) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    if let (Some(cert), Some(key)) = (&tls.cert_path, &tls.key_path) {
        return Ok((cert.clone(), key.clone()));
    }
    let data_dir = dirs::data_dir()
        .ok_or("could not find app data directory")?
        .join("clepsydra");
    let cert_path = data_dir.join("localhost.pem");
    let key_path = data_dir.join("localhost-key.pem");
    generate_certificates_if_missing(&data_dir, &cert_path, &key_path)?;
    Ok((cert_path, key_path))
}

/// Initialize tracing/logging. Uses try_init so repeated calls (e.g. in tests) don't panic.
pub(crate) fn init_logging() {
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(Level::INFO.to_string())),
        )
        .try_init();
}

/// Initialize tracing/logging to stderr only.
///
/// `clep lsp` speaks the LSP protocol on stdout, so tracing output must never
/// land there. `init_logging` defaults to stdout, which is exactly right for
/// `clep serve` and exactly wrong here — hence a separate initializer rather
/// than a flag on the shared one. Uses try_init so repeated calls (e.g. in
/// tests) don't panic.
pub(crate) fn init_logging_stderr() {
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(Level::INFO.to_string())),
        )
        .with_writer(std::io::stderr)
        .try_init();
}

/// Entry point for `clep lsp`: LSP on stdio, logging strictly to stderr
/// (stdout carries the LSP protocol).
pub async fn run_lsp_standalone() {
    init_logging_stderr();
    lsp::run_lsp().await;
}

/// Parse a host + port into a SocketAddr for IP-literal hosts (127.0.0.1, 0.0.0.0, ::1).
/// Returns None for names that need DNS resolution.
pub(crate) fn parse_bind_addr(host: &str, port: u16) -> Option<std::net::SocketAddr> {
    format!("{host}:{port}").parse().ok()
}

/// Resolve the bind address: fast path for IP literals, DNS fallback for names
/// (preserves the original lookup_host behavior for the default "localhost" host).
async fn resolve_bind_addr(
    host: &str,
    port: u16,
) -> Result<std::net::SocketAddr, Box<dyn std::error::Error>> {
    if let Some(addr) = parse_bind_addr(host, port) {
        return Ok(addr);
    }
    let host_port = format!("{host}:{port}");
    let addr = tokio::net::lookup_host(&host_port)
        .await
        .map_err(|e| format!("cannot resolve server address \"{host_port}\": {e}"))?
        .next()
        .ok_or_else(|| format!("server address \"{host_port}\" resolved to no addresses"))?;
    Ok(addr)
}

/// Compose the full Axum router from application state. (Exact extraction of the
/// inline router build formerly in run_server.)
pub(crate) fn build_router(
    state: Arc<AppState>,
    archive_body_limit: usize,
    archive_view_config: api::archive::ArchiveViewConfig,
    dev_mode: bool,
) -> Router {
    let features = state.features;
    let mut app = Router::new()
        .route(
            "/api/features",
            axum::routing::get(api::features::get_features),
        )
        .nest(
            "/api/vault",
            api::api_router_with_archive_limit(archive_body_limit, archive_view_config, features),
        )
        .merge(api::openapi::router(features))
        .merge(api::deeplink::root_router())
        .nest(
            "/api",
            Router::new().fallback(|| async { axum::http::StatusCode::NOT_FOUND }),
        );
    if !dev_mode {
        app = app.merge(api::frontend::frontend_router());
    }
    app.with_state(state)
        .layer(ServiceBuilder::new().layer(TraceLayer::new_for_http()))
}

/// Build the shared application state with default feed settings and features.
pub async fn build_app_state(
    vault_root: &Path,
) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    build_app_state_with_settings(
        vault_root,
        &FeedsSettings::default(),
        FeatureFlags::default(),
    )
    .await
}

fn startup_index_error(
    operation: &'static str,
    source: impl std::fmt::Display,
    recovered_batches: &[vault::batch_mutation::RecoveredBatch],
) -> String {
    if recovered_batches.is_empty() {
        return source.to_string();
    }
    let retained = recovered_batches
        .iter()
        .map(|recovered| recovered.directory().display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!("startup index {operation} failed; retained transaction paths: {retained}: {source}")
}

fn startup_transaction_error(
    operation: &'static str,
    source: impl std::fmt::Display,
    vault_root: &Path,
) -> String {
    let transactions = vault_root.join(".clepsydra/transactions");
    match vault::batch_mutation::retained_transaction_directories(vault_root) {
        Ok(retained) if retained.is_empty() => format!(
            "{operation} failed after transaction workspace removal; no retained transaction \
             workspace was observed and transaction-directory durability may be incomplete: {source}"
        ),
        Ok(retained) => {
            let retained = retained
                .iter()
                .map(|directory| directory.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!("{operation} failed; observed retained transaction paths: {retained}: {source}")
        }
        Err(inspection) => format!(
            "{operation} failed; unable to inspect retained transaction paths under {}: \
             {inspection}: {source}",
            transactions.display()
        ),
    }
}

/// Build the shared application state with configured feed settings and features.
pub async fn build_app_state_with_settings(
    vault_root: &Path,
    feed_settings: &FeedsSettings,
    features: FeatureFlags,
) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    let vault = Vault::open(vault_root)?;
    let rubbish = vault::rubbish::RubbishStore::for_vault(vault.root());
    rubbish.reconcile_purge_tombstones()?;
    let recovered_batches =
        vault::batch_mutation::recover_pending(vault.root()).map_err(|source| {
            startup_transaction_error("startup filesystem recovery", source, vault.root())
        })?;

    let db_path = vault.root().join(INDEX_DB_RELATIVE);
    let mut index = VaultIndex::open(&db_path)
        .map_err(|source| startup_index_error("open", source, &recovered_batches))?;

    let stats = index
        .build(&vault)
        .map_err(|source| startup_index_error("build", source, &recovered_batches))?;
    info!(
        pages_indexed = stats.pages_indexed,
        pages_skipped = stats.pages_skipped,
        pages_removed = stats.pages_removed,
        warnings = stats.warnings.len(),
        "index built"
    );
    let hooks: Arc<Vec<Box<dyn vault::hooks::PostMoveHook>>> =
        Arc::new(vec![Box::new(vault::academic_hook::AcademicMoveHook)]);
    for recovered in &recovered_batches {
        vault::mutation_coordinator::reconcile_recovered_batch_index(
            &vault,
            &mut index,
            hooks.as_ref(),
            recovered,
        )
        .map_err(|source| {
            startup_index_error(
                "recovered transaction reconciliation",
                source,
                &recovered_batches,
            )
        })?;
    }
    index
        .resolve_links()
        .map_err(|source| startup_index_error("link resolution", source, &recovered_batches))?;

    for recovered in recovered_batches {
        recovered.finish().map_err(|source| {
            startup_transaction_error("startup transaction finalization", source, vault.root())
        })?;
    }
    let cas = vault::cas::ContentStore::open(&vault.cas_root())?;
    if cas.stats().map(|s| s.blob_count == 0).unwrap_or(false)
        && let Some(legacy) = vault::cas_migrate::legacy_store_with_blobs()
    {
        tracing::warn!(
            "CAS at {} is empty but a legacy store exists at {}; archived pages will 404 until `clep cas migrate --write` runs",
            vault.cas_root().display(),
            legacy.display()
        );
    }
    let feed_runtime = if features.feeds {
        Some(crate::feeds::runtime::FeedRuntime::open(
            vault.root(),
            feed_settings,
        )?)
    } else {
        None
    };

    let index_handle = IndexHandle::spawn(index, vault.clone());
    let (change_broadcast_tx, _) =
        tokio::sync::broadcast::channel::<api::events::SyncNotification>(64);

    let cas_arc = Arc::new(parking_lot::Mutex::new(cas));

    let delete_hooks: Arc<Vec<Box<dyn vault::hooks::PostDeleteHook>>> =
        Arc::new(vec![Box::new(vault::archive_hook::ArchiveDeleteHook {
            cas: Arc::clone(&cas_arc),
        })]);

    let bcl = vault::bcl::load_or_seed(vault.root());
    let location = vault::location::load_or_seed(vault.root());

    let archive_resource_concurrency =
        api::archive::archive_resource_concurrency(vault.config().archive.max_blob_size_mb);
    Ok(Arc::new(AppState {
        started_at: std::time::Instant::now(),
        features,
        clock: Arc::new(crate::api::SystemClock),
        vault,
        index: index_handle,
        cas: cas_arc,
        rubbish,
        warnings: parking_lot::Mutex::new(stats.warnings),
        change_tx: change_broadcast_tx,
        hooks,
        delete_hooks,
        mutation_coordinator: crate::vault::mutation_coordinator::MutationCoordinator::new(),
        feed_runtime,
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        archive_view_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
        archive_resource_semaphore: Arc::new(tokio::sync::Semaphore::new(
            archive_resource_concurrency,
        )),
        bcl,
        location: parking_lot::RwLock::new(location),
    }))
}

/// Process one drained batch of change events: reindex, log, broadcast a sync
/// notification. (Exact extraction of the per-batch body of the former sync loop.)
async fn process_sync_batch(
    index: &IndexHandle,
    batch: Vec<ChangeEvent>,
    change_tx: &tokio::sync::broadcast::Sender<api::events::SyncNotification>,
) {
    let notifications = notifications_from_batch(&batch);
    match index.process_sync_events(batch).await {
        Ok(stats) => {
            if stats.pages_indexed > 0 || stats.pages_removed > 0 {
                tracing::info!(
                    indexed = stats.pages_indexed,
                    skipped = stats.pages_skipped,
                    removed = stats.pages_removed,
                    resolved = stats.links_resolved,
                    deps = stats.deps_reresolved,
                    "sync cycle complete"
                );
            }
            for notification in notifications {
                let _ = change_tx.send(notification);
            }
        }
        Err(e) => {
            tracing::error!("sync error: {e}");
        }
    }
}

/// Reconcile pages the watcher just saw change: folder-follows-metadata
/// (ADR 0001 layer 2). Runs after the batch is indexed so projection sees
/// fresh frontmatter. A move produces new watch events; reconciling an
/// already-correct page is a no-op, so the loop terminates.
///
/// Excluded paths are skipped, matching `process_sync_batch`: a subtree the
/// vault does not index must not be relocated (or warned about) either.
///
/// Each reconcile runs under the [`MutationCoordinator`] path guard, the same
/// lock the API write path holds across read → write → index. Without it, an
/// in-flight `atomic_replace` can recreate the source file the watcher just
/// renamed, leaving two files carrying one page id. The guard covers the
/// source path only — `reconcile_page` derives its destination internally —
/// which is exactly the path the racing writer holds.
///
/// [`MutationCoordinator`]: crate::vault::mutation_coordinator::MutationCoordinator
async fn reconcile_upserts(state: &AppState, upserts: Vec<VaultPath>) {
    for vp in upserts {
        if state.vault.is_excluded(&vp) {
            continue;
        }
        let hooks = Arc::clone(&state.hooks);
        let target = vp.as_str().to_string();
        let _guard = state
            .mutation_coordinator
            .lock_paths(std::slice::from_ref(&vp))
            .await;
        let result = state
            .index
            .with_index(move |index, vault| {
                crate::vault::reconcile::reconcile_page(vault, index, &target, &hooks)
            })
            .await;
        match result {
            Err(e) | Ok(Err(e)) => tracing::warn!("watcher reconcile failed for {vp}: {e}"),
            Ok(Ok(Some(new_path))) => {
                tracing::info!(
                    "watcher reconcile moved {vp} → {new_path} (folder follows kind/project)"
                );
            }
            Ok(Ok(None)) => {}
        }
    }
}

fn batch_touches_manifest(batch: &[ChangeEvent]) -> bool {
    batch.iter().any(|event| match event {
        ChangeEvent::Upsert(path) | ChangeEvent::Remove(path) => path.as_str() == "feeds.md",
        ChangeEvent::BaseChanged => false,
    })
}

/// Wake the feed scheduler when a raw watcher batch touches the reserved root
/// manifest. This runs before the ordinary exclusion pipeline discards it.
fn notify_feed_scheduler_from_batch(state: &AppState, batch: &[ChangeEvent]) {
    let Some(runtime) = state.feed_runtime.as_ref() else {
        return;
    };
    if batch_touches_manifest(batch) {
        runtime.feed_refresh.notify_one();
    }
}

/// Start the file watcher and spawn the sync loop. Returns the watcher, which the
/// caller MUST keep alive for the server's lifetime.
fn spawn_sync_watcher(state: &Arc<AppState>) -> Result<VaultWatcher, Box<dyn std::error::Error>> {
    let vault_root_buf = state.vault.root().to_path_buf();
    let sync_index = state.index.clone();
    let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
    let sync_change_tx = state.change_tx.clone();
    // The reconcile pass needs the vault (exclusions) and the mutation
    // coordinator (path locks), so the loop holds the whole state.
    let reconcile_state = Arc::clone(state);

    let watcher = VaultWatcher::start(vault_root_buf, Duration::from_millis(500), change_tx)?;

    tokio::spawn(async move {
        loop {
            let batch = match change_rx.recv().await {
                Some(event) => drain_change_batch(event, &mut change_rx),
                None => break,
            };
            notify_feed_scheduler_from_batch(&reconcile_state, &batch);
            let upserts: Vec<VaultPath> = batch
                .iter()
                .filter_map(|e| match e {
                    ChangeEvent::Upsert(vp) => Some(vp.clone()),
                    _ => None,
                })
                .collect();
            process_sync_batch(&sync_index, batch, &sync_change_tx).await;
            reconcile_upserts(&reconcile_state, upserts).await;
        }
    });

    Ok(watcher)
}

/// Resolve config + vault root the same way the server does, then open the vault
/// and build a fully-derived [`VaultIndex`] (full deriver chain, links resolved).
///
/// Returns the owned `Vault` + `VaultIndex` for one-shot CLI commands (e.g.
/// `relabel`) that need a `&mut VaultIndex` with a populated `links` table —
/// mirroring the vault/index portion of [`build_app_state`] without spawning the
/// index handle, watcher, or HTTP server.
pub fn open_vault_and_index() -> Result<(Vault, VaultIndex), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let (settings, config_path) = Settings::load(&cwd)?;
    let vault_root = resolve_vault_root(&settings.vault.root, &config_path, &cwd);

    let vault = Vault::open(&vault_root).map_err(|e| explain_startup_error(e, &vault_root))?;

    let db_path = vault.root().join(INDEX_DB_RELATIVE);
    let mut index = VaultIndex::open(&db_path)?;
    index.build(&vault)?;
    index.resolve_links()?;

    Ok((vault, index))
}

/// Build the application state + settings for the server (cwd, config load,
/// vault-root resolution, app-state build).
async fn build_server_state(
    overrides: ServeOverrides,
) -> Result<(Arc<AppState>, Settings), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let (mut settings, config_path) = Settings::load(&cwd)?;
    overrides.apply(&mut settings);
    let vault_root = resolve_vault_root(&settings.vault.root, &config_path, &cwd);
    info!(
        config = %config_path.display(),
        vault_root = %vault_root.display(),
        vault_root_config = %settings.vault.root,
        "resolved configuration; opening vault"
    );
    let state = build_app_state_with_settings(&vault_root, &settings.feeds, settings.features)
        .await
        .map_err(|e| explain_startup_error(e, &vault_root))?;
    Ok((state, settings))
}

/// Add actionable context to an opaque startup error.
///
/// The early vault-open path propagates bare `io::Error`s (e.g. from
/// `Path::canonicalize`) via `?`, which Debug-print with no path or hint. When
/// the underlying error is `PermissionDenied`, surface the offending vault root
/// and call out the most common cause on macOS: TCC privacy protection of
/// `~/Documents`, `~/Desktop`, and `~/Downloads`.
fn explain_startup_error(
    err: Box<dyn std::error::Error>,
    vault_root: &Path,
) -> Box<dyn std::error::Error> {
    if let Some(io) = err.downcast_ref::<std::io::Error>()
        && io.kind() == std::io::ErrorKind::PermissionDenied
    {
        return format!(
            "permission denied accessing vault root {root}: {io}\n\
             hint: on macOS, ~/Documents, ~/Desktop and ~/Downloads are protected by \
             privacy controls (TCC). Grant your terminal access under System Settings → \
             Privacy & Security → Files and Folders (or Full Disk Access) and restart it, \
             or move the vault outside those folders and update [vault].root in config.toml.",
            root = vault_root.display(),
        )
        .into();
    }
    err
}

/// Load the rustls config from resolved cert/key paths.
async fn load_tls_config(tls: &TlsSettings) -> Result<RustlsConfig, Box<dyn std::error::Error>> {
    let (cert_path, key_path) = ensure_certificates(tls).await?;
    let config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
    Ok(config)
}

/// Serve over HTTPS.
async fn serve_tls(
    app: Router,
    addr: std::net::SocketAddr,
    settings: &Settings,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = load_tls_config(&settings.server.tls).await?;
    info!(%addr, ?settings.server, "listening (HTTPS)");
    axum_server::bind_rustls(addr, config)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

/// Serve over plain HTTP.
async fn serve_plain(
    app: Router,
    addr: std::net::SocketAddr,
    settings: &Settings,
) -> Result<(), Box<dyn std::error::Error>> {
    info!(%addr, ?settings.server, "listening (HTTP)");
    axum_server::bind(addr)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

/// Resolve the bind address and serve, choosing TLS or plain per settings.
async fn serve(app: Router, settings: &Settings) -> Result<(), Box<dyn std::error::Error>> {
    let addr = resolve_bind_addr(&settings.server.host, settings.server.port).await?;
    if settings.server.tls.enabled {
        serve_tls(app, addr, settings).await
    } else {
        serve_plain(app, addr, settings).await
    }
}

/// One-shot reconcile sweep run at `serve` startup, after the index is built and
/// `state` exists but before the server accepts connections, to heal folder
/// drift (a page whose declared kind/project no longer matches its folder is
/// moved, inbound links rewritten). Conservative: undeclared pages are untouched.
///
/// Serve-only by construction — this is called solely from [`run_server`]. The
/// read-only index build (`open_vault_and_index`) and `doctor`
/// (`doctor::run`) never reach it, preserving the read-only boundary
/// (ADR 0001). Best-effort: failures are logged via tracing and never abort
/// startup. Real `state.hooks` are forwarded so startup moves of academic work
/// pages fire `AcademicMoveHook`, mirroring `move_page` and LSP `did_save`.
pub(crate) async fn run_startup_reconcile(state: &Arc<AppState>) {
    let hooks = Arc::clone(&state.hooks);
    match state
        .index
        .with_index(move |index, vault| {
            crate::vault::reconcile::reconcile_all(vault, index, &hooks)
        })
        .await
    {
        Ok(Ok(n)) if n > 0 => tracing::info!("reconcile sweep moved {n} drifted page(s)"),
        Ok(Ok(_)) => {}
        Ok(Err(e)) => tracing::warn!("reconcile sweep failed: {e}"),
        Err(e) => tracing::warn!("reconcile sweep failed: {e}"),
    }
}

/// Retain the optional owned feed scheduler for exactly the lifetime of the
/// serving future, then cancel and join it before returning.
async fn serve_with_optional_feed_scheduler(
    state: Arc<AppState>,
    serving: impl Future<Output = Result<(), Box<dyn std::error::Error>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    if state.feed_runtime.is_none() {
        return serving.await;
    }
    crate::feeds::scheduler::reconcile_feed_manifest(&state).await?;
    let scheduler = crate::feeds::scheduler::spawn_scheduler(state);
    let serving_result = serving.await;
    let shutdown_result = scheduler.shutdown().await;
    match (serving_result, shutdown_result) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(Box::new(error)),
        (Ok(()), Ok(())) => Ok(()),
    }
}

pub async fn run_server(overrides: ServeOverrides) -> Result<(), Box<dyn std::error::Error>> {
    init_logging();
    let (state, settings) = build_server_state(overrides).await?;
    let archive_view_config =
        api::archive::ArchiveViewConfig::from_server_settings(&settings.server)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    run_startup_reconcile(&state).await;
    let _watcher = spawn_sync_watcher(&state)?;
    // `max_request_size_mb` budgets DECODED resource bytes, but the request
    // carries base64, which inflates by 4/3. Without the multiplier the
    // transport limit fires first and the reader gets a bare 413 naming
    // nothing, instead of the 400 that names the limit it exceeded.
    let archive_body_limit =
        api::archive::archive_body_limit_bytes(state.vault.config().archive.max_request_size_mb);
    let app = build_router(
        state.clone(),
        archive_body_limit,
        archive_view_config,
        settings.server.dev_mode,
    );
    serve_with_optional_feed_scheduler(Arc::clone(&state), serve(app, &settings)).await
}

#[cfg(test)]
pub(crate) mod state_test_support {
    use super::*;
    use tempfile::TempDir;
    pub(crate) async fn make_state() -> (Arc<AppState>, TempDir) {
        make_state_with_features(FeatureFlags::default()).await
    }

    pub(crate) async fn make_state_with_features(
        features: FeatureFlags,
    ) -> (Arc<AppState>, TempDir) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let state = build_app_state_with_settings(&root, &FeedsSettings::default(), features)
            .await
            .unwrap();
        (state, tmp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_from_batch_collect_upserts_and_removes() {
        let batch = vec![
            ChangeEvent::Upsert(vault::path::VaultPath::new("notes/a.md").unwrap()),
            ChangeEvent::Remove(vault::path::VaultPath::new("notes/b.md").unwrap()),
            ChangeEvent::Upsert(vault::path::VaultPath::new("notes/c.md").unwrap()),
        ];

        let notifications = notifications_from_batch(&batch);
        assert_eq!(notifications.len(), 1);
        let api::events::SyncNotification::IndexChanged { upserted, removed } = &notifications[0]
        else {
            panic!("expected IndexChanged");
        };

        assert_eq!(upserted, &["notes/a.md", "notes/c.md"]);
        assert_eq!(removed, &["notes/b.md"]);
    }

    #[test]
    fn notifications_from_empty_batch_are_empty() {
        let batch = Vec::<ChangeEvent>::new();
        assert!(notifications_from_batch(&batch).is_empty());
    }

    #[tokio::test]
    async fn disabled_feeds_create_no_runtime_or_database() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();

        let state = build_app_state_with_settings(
            &root,
            &FeedsSettings::default(),
            FeatureFlags {
                academic: true,
                feeds: false,
            },
        )
        .await
        .unwrap();

        assert!(state.feed_runtime.is_none());
        assert!(!root.join(".clepsydra/feeds.db").exists());
    }

    #[test]
    fn base_change_in_batch_emits_registry_notification() {
        let batch = vec![
            ChangeEvent::Upsert(vault::path::VaultPath::new("notes/a.md").unwrap()),
            ChangeEvent::BaseChanged,
        ];
        let notifications = notifications_from_batch(&batch);
        assert_eq!(notifications.len(), 2);
        assert!(matches!(
            notifications[1],
            api::events::SyncNotification::BaseRegistryChanged
        ));
    }

    #[tokio::test]
    async fn drain_change_batch_collects_buffered_events() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
        tx.send(ChangeEvent::Upsert(
            vault::path::VaultPath::new("notes/a.md").unwrap(),
        ))
        .unwrap();
        tx.send(ChangeEvent::Remove(
            vault::path::VaultPath::new("notes/b.md").unwrap(),
        ))
        .unwrap();
        tx.send(ChangeEvent::Upsert(
            vault::path::VaultPath::new("notes/c.md").unwrap(),
        ))
        .unwrap();

        let first = rx.recv().await.expect("first event missing");
        let batch = drain_change_batch(first, &mut rx);

        assert_eq!(batch.len(), 3);
    }

    #[test]
    fn resolve_vault_root_uses_config_parent_for_relative_roots() {
        let cwd = PathBuf::from("/tmp/cwd");
        let config = PathBuf::from("/tmp/config-dir/config.toml");
        let resolved = resolve_vault_root("vault", &config, &cwd);
        assert_eq!(resolved, PathBuf::from("/tmp/config-dir/vault"));
    }

    #[test]
    fn resolve_vault_root_preserves_absolute_roots() {
        let cwd = PathBuf::from("/tmp/cwd");
        let config = PathBuf::from("/tmp/config-dir/config.toml");
        let resolved = resolve_vault_root("/var/data/vault", &config, &cwd);
        assert_eq!(resolved, PathBuf::from("/var/data/vault"));
    }

    #[test]
    fn resolve_vault_root_expands_tilde() {
        let cwd = PathBuf::from("/tmp/cwd");
        let config = PathBuf::from("/tmp/config-dir/config.toml");
        let resolved = resolve_vault_root("~/Documents/vault", &config, &cwd);
        let home = dirs::home_dir().expect("home dir must exist for test");
        assert_eq!(resolved, home.join("Documents/vault"));
    }

    #[test]
    fn expand_tilde_bare() {
        let expanded = expand_tilde("~").expect("should expand bare ~");
        assert_eq!(expanded, dirs::home_dir().unwrap());
    }

    #[test]
    fn expand_tilde_returns_none_for_non_tilde() {
        assert!(expand_tilde("./vault").is_none());
        assert!(expand_tilde("/absolute/path").is_none());
    }

    #[test]
    fn explain_startup_error_adds_tcc_hint_for_permission_denied() {
        let io = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Operation not permitted",
        );
        let explained =
            explain_startup_error(Box::new(io), Path::new("/Users/kit/Documents/vault"));
        let msg = explained.to_string();
        assert!(
            msg.contains("/Users/kit/Documents/vault"),
            "missing path: {msg}"
        );
        assert!(msg.contains("TCC"), "missing macOS TCC hint: {msg}");
    }

    #[test]
    fn explain_startup_error_passes_through_other_errors() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let explained = explain_startup_error(Box::new(io), Path::new("/some/vault"));
        // Non-permission errors are returned unchanged (no synthetic hint text).
        assert_eq!(explained.to_string(), "no such file");
    }
}

#[cfg(test)]
mod bind_tests {
    use super::*;

    #[test]
    fn parse_bind_addr_ip_literal_returns_some() {
        let addr = parse_bind_addr("127.0.0.1", 8080);
        assert!(addr.is_some());
        let addr = addr.unwrap();
        assert_eq!(addr.port(), 8080);
        assert!(addr.is_ipv4());
    }

    #[test]
    fn parse_bind_addr_hostname_returns_none() {
        let addr = parse_bind_addr("example.com", 80);
        assert!(addr.is_none());
    }
}

#[cfg(test)]
mod resolve_addr_tests {
    use super::*;

    #[tokio::test]
    async fn resolve_ip_literal_returns_correct_addr() {
        let addr = resolve_bind_addr("127.0.0.1", 8080).await.unwrap();
        assert_eq!(addr.port(), 8080);
        assert!(addr.is_ipv4());
    }
}

#[cfg(test)]
mod router_tests {
    use super::state_test_support::{make_state, make_state_with_features};
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn build_router_dev_mode_does_not_panic() {
        let (state, _tmp) = make_state().await;
        let _router = build_router(
            state,
            1024,
            api::archive::ArchiveViewConfig::default(),
            true,
        );
    }

    #[tokio::test]
    async fn build_router_prod_mode_does_not_panic() {
        let (state, _tmp) = make_state().await;
        let _router = build_router(
            state,
            1024,
            api::archive::ArchiveViewConfig::default(),
            false,
        );
    }

    #[tokio::test]
    async fn prod_router_disabled_feature_gets_remain_api_404_before_spa_fallback() {
        let features = FeatureFlags {
            academic: false,
            feeds: false,
        };
        let (state, _tmp) = make_state_with_features(features).await;
        let app = build_router(
            state,
            1024,
            api::archive::ArchiveViewConfig::default(),
            false,
        );

        for uri in ["/api/vault/academic/works", "/api/vault/feeds"] {
            let response = app
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            assert_ne!(
                response
                    .headers()
                    .get(axum::http::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok()),
                Some("text/html; charset=utf-8"),
                "{uri} must not receive the SPA fallback"
            );
        }

        let spa = app
            .oneshot(
                Request::get("/non-api-spa-route")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(spa.status(), StatusCode::OK);
        assert_eq!(
            spa.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;

    #[tokio::test]
    async fn build_app_state_opens_vault_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let state = build_app_state(&root).await.unwrap();
        assert!(state.vault.root().exists());
    }

    #[tokio::test]
    async fn build_app_state_finishes_interrupted_rubbish_purge_tombstones() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let item_id = "00000000-0000-4000-8000-000000000006";
        let tombstone = root
            .join(".clepsydra/rubbish")
            .join(format!(".purge-{item_id}"));
        std::fs::create_dir_all(&tombstone).unwrap();
        std::fs::write(tombstone.join("page.md"), b"partial").unwrap();

        let state = build_app_state(&root).await.unwrap();

        assert!(!tombstone.exists());
        assert_eq!(state.rubbish.list_entries().unwrap(), Vec::new());
        let catalog = state
            .index
            .with_index(|index, _| index.rubbish_entries())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(catalog, Vec::new());
    }

    #[tokio::test]
    async fn build_app_state_replays_committed_academic_move_hooks_before_finalization() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(
            root.join(".clepsydra/config.toml"),
            "[vault]\nlinkable_properties = [\"work_path\"]\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("library/papers")).unwrap();
        std::fs::create_dir_all(root.join("library/annotations")).unwrap();
        std::fs::create_dir_all(root.join("archive")).unwrap();

        let work_id = "00000000-0000-0000-0000-000000000300";
        let annotation_id = "00000000-0000-0000-0000-000000000301";
        let work_content = format!(
            "---\nid: {work_id}\nkind: work\nwork_type: paper\ntitle: My Paper\ncite_key: \
             mypaper2024\ntags: []\n---\nPaper content.\n"
        );
        let annotation_content = format!(
            "---\nid: {annotation_id}\nkind: annotation\nwork_id: {work_id}\nwork_path: \
             library/papers/my-paper.md\nannotation_type: highlight\ntags: []\n---\nA highlight.\n"
        );
        std::fs::write(
            root.join("library/papers/my-paper.md"),
            work_content.as_bytes(),
        )
        .unwrap();
        std::fs::write(
            root.join("library/annotations/highlight-1.md"),
            annotation_content,
        )
        .unwrap();

        let source = vault::path::VaultPath::new("library/papers/my-paper.md").unwrap();
        let destination = vault::path::VaultPath::new("archive/my-paper.md").unwrap();
        let command = vault::batch_mutation::BatchMutationCommand {
            intents: vec![vault::batch_mutation::BatchPathIntent::Move {
                source: source.clone(),
                destination: destination.clone(),
                expected_source: work_content.into_bytes(),
            }],
            create_directories: Vec::new(),
            remove_directories: Vec::new(),
            index_events: vec![
                ChangeEvent::Remove(source.clone()),
                ChangeEvent::Upsert(destination.clone()),
            ],
            moved_pages: vec![(source, destination)],
        };
        let mut pending = vault::batch_mutation::prepare(&root, &command).unwrap();
        pending.publish().unwrap();
        pending.mark_filesystem_committed().unwrap();
        let transaction_directory = pending.directory().to_path_buf();
        drop(pending);

        let state = build_app_state(&root).await.unwrap();

        let annotation =
            std::fs::read_to_string(root.join("library/annotations/highlight-1.md")).unwrap();
        assert!(
            annotation.contains("work_path = \"archive/my-paper.md\""),
            "persisted move hook did not update annotation: {annotation}"
        );
        let (indexed_work_path, resolved_work_id) = state
            .index
            .with_index(move |index, _vault| {
                let indexed_work_path = index
                    .connection()
                    .query_row(
                        "SELECT json_extract(meta_json, '$.work_path') FROM pages WHERE id = ?1",
                        rusqlite::params![annotation_id],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap();
                let resolved_work_id = index
                    .connection()
                    .query_row(
                        "SELECT target_id FROM links \
                         WHERE source_id = ?1 AND source_field = 'work_path'",
                        rusqlite::params![annotation_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .unwrap();
                (indexed_work_path, resolved_work_id)
            })
            .await
            .unwrap();
        assert_eq!(indexed_work_path, "archive/my-paper.md");
        assert_eq!(resolved_work_id.as_deref(), Some(work_id));
        assert!(!transaction_directory.exists());
    }
}

#[cfg(test)]
mod startup_reconcile_tests {
    use super::*;

    /// The one-shot startup sweep must heal folder drift: a page declaring
    /// `type: quote` that still lives under `notes/` is moved to `quotes/`.
    /// Built over the same `build_app_state` constructor the serve path uses.
    #[tokio::test]
    async fn serve_startup_reconciles_drifted_pages() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();

        // A drifted page: declares `type: quote` but lives under notes/.
        let drifted = root.join("notes").join("q.md");
        std::fs::create_dir_all(drifted.parent().unwrap()).unwrap();
        std::fs::write(
            &drifted,
            "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntype: quote\n---\nbody",
        )
        .unwrap();

        let state = build_app_state(&root).await.unwrap();

        run_startup_reconcile(&state).await;

        assert!(
            root.join("quotes").join("q.md").exists(),
            "drifted page should have moved to quotes/q.md"
        );
        assert!(
            !root.join("notes").join("q.md").exists(),
            "source notes/q.md should be gone after the sweep"
        );
    }
}

#[cfg(test)]
mod feed_serving_lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn serving_completion_cancels_and_joins_the_feed_scheduler() {
        let (state, _tmp) = state_test_support::make_state().await;
        let serving_ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = Arc::clone(&serving_ran);

        serve_with_optional_feed_scheduler(Arc::clone(&state), async move {
            observed.store(true, std::sync::atomic::Ordering::Release);
            Ok::<(), Box<dyn std::error::Error>>(())
        })
        .await
        .unwrap();
        assert!(serving_ran.load(std::sync::atomic::Ordering::Acquire));

        let runtime = state.feed_runtime();

        // Once the serving future has ended, the joined scheduler cannot
        // consume a later wake-up and reconcile this new manifest.
        std::fs::write(
            state.vault.root().join("feeds.md"),
            "## After serving\n- http://127.0.0.1:9/rss\n",
        )
        .unwrap();
        runtime.feed_refresh.notify_one();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(runtime.feeds.list_feeds().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn serving_without_feed_runtime_completes_without_scheduler() {
        let (state, _tmp) = state_test_support::make_state_with_features(FeatureFlags {
            academic: true,
            feeds: false,
        })
        .await;
        std::fs::write(state.vault.root().join("feeds.md"), [0xff]).unwrap();
        let serving_ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = Arc::clone(&serving_ran);

        serve_with_optional_feed_scheduler(state, async move {
            observed.store(true, std::sync::atomic::Ordering::Release);
            Ok::<(), Box<dyn std::error::Error>>(())
        })
        .await
        .unwrap();

        assert!(serving_ran.load(std::sync::atomic::Ordering::Acquire));
    }
}

#[cfg(test)]
mod watcher_reconcile_tests {
    use super::*;

    /// The watcher's per-batch reconcile must heal folder drift after indexing:
    /// a page declaring `type: quote` that still lives under `notes/` is moved
    /// to `quotes/`. Mirrors `serve_startup_reconciles_drifted_pages`'s fixture,
    /// but drives the batch path (`process_sync_events` + `reconcile_upserts`)
    /// instead of the startup sweep.
    #[tokio::test]
    async fn watcher_batch_reconciles_drifted_upsert() {
        let (state, tmp) = state_test_support::make_state().await;
        let root = tmp.path().join("vault");

        // A drifted page: declares `type: quote` but lives under notes/.
        let drifted = root.join("notes").join("q.md");
        std::fs::create_dir_all(drifted.parent().unwrap()).unwrap();
        std::fs::write(
            &drifted,
            "---\nid: 0190f8a0-0000-7000-8000-0000000000a1\ntype: quote\n---\nbody",
        )
        .unwrap();

        let vp = VaultPath::new("notes/q.md").unwrap();
        state
            .index
            .process_sync_events(vec![ChangeEvent::Upsert(vp.clone())])
            .await
            .unwrap();

        reconcile_upserts(&state, vec![vp.clone()]).await;

        assert!(
            root.join("quotes").join("q.md").exists(),
            "drifted page should have moved to quotes/q.md"
        );
        assert!(
            !root.join("notes").join("q.md").exists(),
            "source notes/q.md should be gone after reconcile"
        );
    }

    /// A page whose folder already matches its declared kind must be left
    /// alone: reconcile is a no-op, not a rewrite.
    #[tokio::test]
    async fn reconcile_upserts_leaves_clean_pages_alone() {
        let (state, tmp) = state_test_support::make_state().await;
        let root = tmp.path().join("vault");

        // A clean page: declares `type: quote` and already lives under quotes/.
        let clean = root.join("quotes").join("q.md");
        std::fs::create_dir_all(clean.parent().unwrap()).unwrap();
        std::fs::write(
            &clean,
            "---\nid: 0190f8a0-0000-7000-8000-0000000000a2\ntype: quote\n---\nbody",
        )
        .unwrap();

        let vp = VaultPath::new("quotes/q.md").unwrap();
        state
            .index
            .process_sync_events(vec![ChangeEvent::Upsert(vp.clone())])
            .await
            .unwrap();

        reconcile_upserts(&state, vec![vp.clone()]).await;

        assert!(
            root.join("quotes").join("q.md").exists(),
            "clean page should not have moved"
        );
    }

    /// Exclusions bound the reconcile the same way they bound indexing
    /// (`process_sync_batch` skips excluded paths): a drifted page inside an
    /// excluded subtree is neither indexed nor physically relocated.
    #[tokio::test]
    async fn reconcile_upserts_skips_excluded_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        std::fs::write(
            root.join(".clepsydra/config.toml"),
            "[vault]\nexcluded_patterns = [\".clepsydra\", \".clepsydra/**\", \
             \"_attachments\", \"_attachments/**\", \"private\", \"private/**\"]\n",
        )
        .unwrap();
        let state = build_app_state(&root).await.unwrap();

        // Same drift as `watcher_batch_reconciles_drifted_upsert`, but inside
        // an excluded folder.
        let drifted = root.join("private").join("q.md");
        std::fs::create_dir_all(drifted.parent().unwrap()).unwrap();
        std::fs::write(
            &drifted,
            "---\nid: 0190f8a0-0000-7000-8000-0000000000a3\ntype: quote\n---\nbody",
        )
        .unwrap();

        let vp = VaultPath::new("private/q.md").unwrap();
        reconcile_upserts(&state, vec![vp]).await;

        assert!(
            drifted.exists(),
            "excluded page must stay where the user put it"
        );
        assert!(
            !root.join("quotes").join("q.md").exists(),
            "excluded page must not be projected into a canonical folder"
        );
    }

    /// The reconcile takes the same `MutationCoordinator` path guard the API
    /// write path holds across read → write → index, so a watcher move cannot
    /// interleave with an in-flight page write on that path.
    #[tokio::test]
    async fn reconcile_upserts_waits_for_the_mutation_coordinator_lock() {
        let (state, tmp) = state_test_support::make_state().await;
        let root = tmp.path().join("vault");

        let drifted = root.join("notes").join("q.md");
        std::fs::create_dir_all(drifted.parent().unwrap()).unwrap();
        std::fs::write(
            &drifted,
            "---\nid: 0190f8a0-0000-7000-8000-0000000000a4\ntype: quote\n---\nbody",
        )
        .unwrap();

        let vp = VaultPath::new("notes/q.md").unwrap();
        state
            .index
            .process_sync_events(vec![ChangeEvent::Upsert(vp.clone())])
            .await
            .unwrap();

        // Hold the path guard, as a concurrent API write would.
        let guard = state
            .mutation_coordinator
            .lock_paths(std::slice::from_ref(&vp))
            .await;

        let reconcile = tokio::spawn({
            let state = Arc::clone(&state);
            let vp = vp.clone();
            async move { reconcile_upserts(&state, vec![vp]).await }
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            drifted.exists() && !root.join("quotes").join("q.md").exists(),
            "reconcile must not move the page while the path guard is held"
        );

        drop(guard);
        reconcile.await.unwrap();

        assert!(
            root.join("quotes").join("q.md").exists(),
            "reconcile must proceed once the guard is released"
        );
    }

    async fn assert_manifest_edit_notifies_scheduler(content: Option<&str>) {
        let (state, tmp) = state_test_support::make_state().await;
        let manifest = tmp.path().join("vault/feeds.md");
        let path = VaultPath::new("feeds.md").unwrap();
        let event = match content {
            Some(content) => {
                std::fs::write(&manifest, content).unwrap();
                ChangeEvent::Upsert(path)
            }
            None => {
                std::fs::write(&manifest, "## Before removal\n").unwrap();
                std::fs::remove_file(&manifest).unwrap();
                ChangeEvent::Remove(path)
            }
        };
        let notified = state.feed_runtime().feed_refresh.notified();
        tokio::pin!(notified);

        notify_feed_scheduler_from_batch(&state, &[event]);

        tokio::time::timeout(Duration::from_millis(100), &mut notified)
            .await
            .expect("raw feeds.md watcher batch did not notify the scheduler");
    }

    #[tokio::test]
    async fn watcher_notifies_scheduler_for_valid_manifest_upsert() {
        assert_manifest_edit_notifies_scheduler(Some("## Valid\n- https://valid.example/rss\n"))
            .await;
    }

    #[tokio::test]
    async fn watcher_notifies_scheduler_for_warning_manifest_upsert() {
        assert_manifest_edit_notifies_scheduler(Some("## Warning\n- [Broken]()\n")).await;
    }

    #[tokio::test]
    async fn watcher_notifies_scheduler_for_manifest_removal() {
        assert_manifest_edit_notifies_scheduler(None).await;
    }

    #[tokio::test]
    async fn disabled_feeds_ignore_manifest_watcher_batches() {
        let (state, _tmp) = state_test_support::make_state_with_features(FeatureFlags {
            academic: true,
            feeds: false,
        })
        .await;
        let event = ChangeEvent::Upsert(VaultPath::new("feeds.md").unwrap());

        notify_feed_scheduler_from_batch(&state, &[event]);

        assert!(state.feed_runtime.is_none());
    }
}

#[cfg(test)]
mod settings_tests {
    use super::*;

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

    /// RAII guard that records the prior value of an env var on construction
    /// and restores it on drop, so `#[serial]` tests can't leak state.
    struct EnvGuard {
        key: &'static str,
        prior: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let prior = std::env::var_os(key);
            // SAFETY: tests touching env are gated behind `#[serial_test::serial]`
            // so no other thread is racing on the same variable.
            unsafe { std::env::set_var(key, value) }
            Self { key, prior }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see `set`.
            unsafe {
                match self.prior.take() {
                    Some(v) => std::env::set_var(self.key, v),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }

    #[test]
    fn certificate_directory_failure_generates_no_partial_pair() {
        let tmp = tempfile::tempdir().unwrap();
        let blocked = tmp.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let cert = blocked.join("localhost.pem");
        let key = blocked.join("localhost-key.pem");

        let error = generate_certificates_if_missing(&blocked, &cert, &key).unwrap_err();

        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert!(!cert.exists());
        assert!(!key.exists());
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

#[cfg(test)]
mod sync_tests {
    use super::state_test_support::make_state;
    use super::*;

    #[tokio::test]
    async fn process_sync_batch_broadcasts_notification_for_upsert() {
        let (state, _tmp) = make_state().await;
        let mut rx = state.change_tx.subscribe();

        // Create a markdown file in the vault root so indexing can succeed
        let page_path = state.vault.root().join("notes").join("x.md");
        std::fs::create_dir_all(page_path.parent().unwrap()).unwrap();
        std::fs::write(&page_path, "---\ntitle: Test Page\n---\n\nHello from x.\n").unwrap();

        let batch = vec![ChangeEvent::Upsert(
            vault::path::VaultPath::new("notes/x.md").unwrap(),
        )];

        process_sync_batch(&state.index, batch, &state.change_tx).await;

        // The Ok path + Some(notification) branch should have sent on the channel
        let result = rx.try_recv();
        assert!(
            result.is_ok(),
            "expected a notification on the broadcast channel, got: {result:?}"
        );
    }
}
