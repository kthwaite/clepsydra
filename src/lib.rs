pub mod api;
pub mod app_config;
pub mod doctor;
pub mod lsp;
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
}

#[derive(Debug, Deserialize)]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub dev_mode: bool,
    #[serde(default)]
    pub tls: TlsSettings,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            host: "localhost".to_string(),
            port: 16667,
            dev_mode: false,
            tls: TlsSettings::default(),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct TlsSettings {
    #[serde(default)]
    pub enabled: bool,
    pub cert_path: Option<PathBuf>,
    pub key_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
pub struct VaultSettings {
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
    fn load(base_dir: &Path) -> Result<(Self, PathBuf), Box<dyn std::error::Error>> {
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
    pub fn load_from(config_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        // Precedence (later wins): defaults < config file < env vars
        let settings = Config::builder()
            .set_default("server.host", "localhost")?
            .set_default("server.port", 3000)?
            .set_default("server.dev_mode", false)?
            .set_default("server.tls.enabled", false)?
            .set_default("vault.root", "./vault")?
            .add_source(File::from(config_path.to_path_buf()))
            .add_source(Environment::with_prefix("CLEPSYDRA").separator("__"))
            .build()?
            .try_deserialize()?;
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

/// Resolve the vault root string from config into an absolute filesystem path.
///
/// Order: tilde expansion, absolute passthrough, env-supplied roots resolved
/// against `cwd`, and finally relative roots resolved against the config file's
/// parent directory.
pub fn resolve_vault_root(root: &str, config_path: &Path, cwd: &Path) -> PathBuf {
    if let Some(expanded) = expand_tilde(root) {
        return expanded;
    }

    let root_path = PathBuf::from(root);

    if root_path.is_absolute() {
        return root_path;
    }

    // If vault root is supplied via env, keep it relative to the process CWD.
    if std::env::var_os("CLEPSYDRA__VAULT__ROOT").is_some() {
        return cwd.join(root_path);
    }

    // Otherwise, resolve relative roots against the config file directory
    // (important for XDG config usage).
    if let Some(parent) = config_path.parent() {
        return parent.join(root_path);
    }

    cwd.join(root_path)
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

fn notification_from_batch(batch: &[ChangeEvent]) -> Option<api::events::SyncNotification> {
    let mut upserted: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    for ev in batch {
        match ev {
            ChangeEvent::Upsert(vp) => upserted.push(vp.as_str().to_string()),
            ChangeEvent::Remove(vp) => removed.push(vp.as_str().to_string()),
        }
    }

    if upserted.is_empty() && removed.is_empty() {
        None
    } else {
        Some(api::events::SyncNotification::IndexChanged { upserted, removed })
    }
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
    dev_mode: bool,
) -> Router {
    let mut app = Router::new()
        .nest(
            "/api/vault",
            api::api_router_with_archive_limit(archive_body_limit),
        )
        .merge(api::openapi::router());
    if !dev_mode {
        app = app.merge(api::frontend::frontend_router());
    }
    app.with_state(state)
        .layer(ServiceBuilder::new().layer(TraceLayer::new_for_http()))
}

/// Build the shared application state over a vault root: open vault + CAS, open
/// and build the index, spawn the index handle, wire hooks/bcl/location, assemble
/// AppState. (Exact extraction of run_server lines ~289–349.)
pub(crate) async fn build_app_state(
    vault_root: &Path,
) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    let vault = Vault::open(vault_root)?;

    let cas_path_raw = &vault.config().archive.cas_path;
    let cas_path = expand_tilde(cas_path_raw).unwrap_or_else(|| PathBuf::from(cas_path_raw));
    let cas = vault::cas::ContentStore::open(&cas_path)?;

    let db_path = vault.root().join(INDEX_DB_RELATIVE);
    let mut index = VaultIndex::open(&db_path)?;

    let stats = index.build(&vault)?;
    info!(
        pages_indexed = stats.pages_indexed,
        pages_skipped = stats.pages_skipped,
        pages_removed = stats.pages_removed,
        warnings = stats.warnings.len(),
        "index built"
    );
    index.resolve_links()?;

    let index_handle = IndexHandle::spawn(index, vault.clone());
    let (change_broadcast_tx, _) =
        tokio::sync::broadcast::channel::<api::events::SyncNotification>(64);

    let hooks: Arc<Vec<Box<dyn vault::hooks::PostMoveHook>>> =
        Arc::new(vec![Box::new(vault::academic_hook::AcademicMoveHook)]);

    let cas_arc = Arc::new(parking_lot::Mutex::new(cas));

    let delete_hooks: Arc<Vec<Box<dyn vault::hooks::PostDeleteHook>>> =
        Arc::new(vec![Box::new(vault::archive_hook::ArchiveDeleteHook {
            cas: Arc::clone(&cas_arc),
        })]);

    let bcl = vault::bcl::load_or_seed(vault.root());
    let location = vault::location::load_or_seed(vault.root());

    Ok(Arc::new(AppState {
        vault,
        index: index_handle,
        cas: cas_arc,
        warnings: parking_lot::Mutex::new(stats.warnings),
        change_tx: change_broadcast_tx,
        hooks,
        delete_hooks,
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl,
        location,
    }))
}

/// Process one drained batch of change events: reindex, log, broadcast a sync
/// notification. (Exact extraction of the per-batch body of the former sync loop.)
async fn process_sync_batch(
    index: &IndexHandle,
    batch: Vec<ChangeEvent>,
    change_tx: &tokio::sync::broadcast::Sender<api::events::SyncNotification>,
) {
    let notification = notification_from_batch(&batch);
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
            if let Some(notification) = notification {
                let _ = change_tx.send(notification);
            }
        }
        Err(e) => {
            tracing::error!("sync error: {e}");
        }
    }
}

/// Start the file watcher and spawn the sync loop. Returns the watcher, which the
/// caller MUST keep alive for the server's lifetime.
fn spawn_sync_watcher(state: &Arc<AppState>) -> Result<VaultWatcher, Box<dyn std::error::Error>> {
    let vault_root_buf = state.vault.root().to_path_buf();
    let sync_index = state.index.clone();
    let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
    let sync_change_tx = state.change_tx.clone();

    let watcher = VaultWatcher::start(vault_root_buf, Duration::from_millis(500), change_tx)?;

    tokio::spawn(async move {
        loop {
            let batch = match change_rx.recv().await {
                Some(event) => drain_change_batch(event, &mut change_rx),
                None => break,
            };
            process_sync_batch(&sync_index, batch, &sync_change_tx).await;
        }
    });

    Ok(watcher)
}

/// Optionally start the LSP server on stdio.
fn maybe_spawn_lsp(enable_lsp: bool, state: &Arc<AppState>) {
    if enable_lsp {
        info!("starting LSP server on stdio");
        let lsp_state = Arc::clone(state);
        tokio::spawn(async move {
            lsp::run_lsp(lsp_state).await;
            tracing::info!("LSP disconnected, shutting down");
            std::process::exit(0);
        });
    }
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
async fn build_server_state() -> Result<(Arc<AppState>, Settings), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let (settings, config_path) = Settings::load(&cwd)?;
    let vault_root = resolve_vault_root(&settings.vault.root, &config_path, &cwd);
    info!(
        config = %config_path.display(),
        vault_root = %vault_root.display(),
        vault_root_config = %settings.vault.root,
        "resolved configuration; opening vault"
    );
    let state = build_app_state(&vault_root)
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
/// (`diagnostics::run`) never reach it, preserving the read-only boundary
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

pub async fn run_server(enable_lsp: bool) -> Result<(), Box<dyn std::error::Error>> {
    init_logging();
    let (state, settings) = build_server_state().await?;
    run_startup_reconcile(&state).await;
    maybe_spawn_lsp(enable_lsp, &state);
    let _watcher = spawn_sync_watcher(&state)?;
    let archive_body_limit =
        (state.vault.config().archive.max_request_size_mb as usize) * 1024 * 1024;
    let app = build_router(state.clone(), archive_body_limit, settings.server.dev_mode);
    serve(app, &settings).await
}

#[cfg(test)]
pub(crate) mod state_test_support {
    use super::*;
    use tempfile::TempDir;
    pub(crate) async fn make_state() -> (Arc<AppState>, TempDir) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let state = build_app_state(&root).await.unwrap();
        (state, tmp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_from_batch_collects_upserts_and_removes() {
        let batch = vec![
            ChangeEvent::Upsert(vault::path::VaultPath::new("notes/a.md").unwrap()),
            ChangeEvent::Remove(vault::path::VaultPath::new("notes/b.md").unwrap()),
            ChangeEvent::Upsert(vault::path::VaultPath::new("notes/c.md").unwrap()),
        ];

        let notification = notification_from_batch(&batch).expect("expected notification");
        let api::events::SyncNotification::IndexChanged { upserted, removed } = notification;

        assert_eq!(upserted, vec!["notes/a.md", "notes/c.md"]);
        assert_eq!(removed, vec!["notes/b.md"]);
    }

    #[test]
    fn notification_from_empty_batch_is_none() {
        let batch = Vec::<ChangeEvent>::new();
        assert!(notification_from_batch(&batch).is_none());
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
    use super::state_test_support::make_state;
    use super::*;

    #[tokio::test]
    async fn build_router_dev_mode_does_not_panic() {
        let (state, _tmp) = make_state().await;
        let _router = build_router(state, 1024, true);
    }

    #[tokio::test]
    async fn build_router_prod_mode_does_not_panic() {
        let (state, _tmp) = make_state().await;
        let _router = build_router(state, 1024, false);
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
mod settings_tests {
    use super::*;

    #[serial_test::serial]
    #[test]
    fn load_from_reads_port_from_config_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cfg = tmp.path().join("config.toml");
        std::fs::write(&cfg, "[server]\nport = 9999\n").unwrap();
        let settings = Settings::load_from(&cfg).unwrap();
        assert_eq!(settings.server.port, 9999);
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
