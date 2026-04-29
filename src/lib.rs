pub mod api;
pub mod app_config;
pub mod diagnostics;
pub mod lsp;
pub mod vault;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
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

use axum_server::tls_rustls::RustlsConfig;

/// Resolve the on-disk cert + key paths for the given TLS settings, without
/// generating any new certificates.
///
/// Returns `(cert_path, key_path, paths_were_explicit)`. When the paths are
/// the auto-discovered defaults under `dirs::data_dir()`, the third element
/// is `false`.
pub fn default_tls_paths(tls: &TlsSettings) -> Option<(PathBuf, PathBuf, bool)> {
    if let (Some(cert), Some(key)) = (&tls.cert_path, &tls.key_path) {
        return Some((cert.clone(), key.clone(), true));
    }
    let data_dir = dirs::data_dir()?.join("clepsydra");
    Some((
        data_dir.join("localhost.pem"),
        data_dir.join("localhost-key.pem"),
        false,
    ))
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
    std::fs::create_dir_all(&data_dir)?;

    let cert_path = data_dir.join("localhost.pem");
    let key_path = data_dir.join("localhost-key.pem");

    if !cert_path.exists() || !key_path.exists() {
        info!("Generating TLS certificates with mkcert...");
        let status = std::process::Command::new("mkcert")
            .arg("-install")
            .status();

        match status {
            Ok(s) if s.success() => {
                let status = std::process::Command::new("mkcert")
                    .arg("-cert-file")
                    .arg(&cert_path)
                    .arg("-key-file")
                    .arg(&key_path)
                    .arg("localhost")
                    .arg("127.0.0.1")
                    .arg("::1")
                    .status()?;

                if !status.success() {
                    return Err("mkcert failed to generate certificates".into());
                }
            }
            _ => {
                return Err("mkcert not found or failed to install CA. Please install mkcert (https://github.com/FiloSottile/mkcert)".into());
            }
        }
    }

    Ok((cert_path, key_path))
}

pub async fn run_server(enable_lsp: bool) -> Result<(), Box<dyn std::error::Error>> {
    // Logging via `tracing`.
    // Configure with `RUST_LOG=debug` (or e.g. `RUST_LOG=clepsydra=debug,tower_http=debug`).
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(Level::INFO.to_string())),
        )
        .init();

    let cwd = std::env::current_dir()?;
    let (settings, config_path) = Settings::load(&cwd)?;

    // Resolve vault root path
    let vault_root = resolve_vault_root(&settings.vault.root, &config_path, &cwd);

    // Open vault
    let vault = Vault::open(&vault_root)?;

    // Open CAS
    let cas_path_raw = &vault.config().archive.cas_path;
    let cas_path = expand_tilde(cas_path_raw).unwrap_or_else(|| PathBuf::from(cas_path_raw));
    let cas = vault::cas::ContentStore::open(&cas_path)?;

    // Open index
    let db_path = vault.root().join(".clepsydra/cache.db");
    let mut index = VaultIndex::open(&db_path)?;

    // Build index and resolve links
    let stats = index.build(&vault)?;
    info!(
        pages_indexed = stats.pages_indexed,
        pages_skipped = stats.pages_skipped,
        pages_removed = stats.pages_removed,
        warnings = stats.warnings.len(),
        "index built"
    );
    index.resolve_links()?;

    // Spawn index on a dedicated thread
    let index_handle = IndexHandle::spawn(index, vault.clone());

    // Broadcast channel for SSE notifications
    let (change_broadcast_tx, _) =
        tokio::sync::broadcast::channel::<api::events::SyncNotification>(64);

    // Build post-move hooks
    let hooks: Arc<Vec<Box<dyn vault::hooks::PostMoveHook>>> =
        Arc::new(vec![Box::new(vault::academic_hook::AcademicMoveHook)]);

    // Wrap CAS for shared access
    let cas_arc = Arc::new(parking_lot::Mutex::new(cas));

    // Build post-delete hooks
    let delete_hooks: Arc<Vec<Box<dyn vault::hooks::PostDeleteHook>>> =
        Arc::new(vec![Box::new(vault::archive_hook::ArchiveDeleteHook {
            cas: Arc::clone(&cas_arc),
        })]);

    // Load BCL config (lookaside cache: vault file, then ~/.config/bcl).
    let bcl = vault::bcl::load_or_seed(vault.root());

    // Build shared state
    let state = Arc::new(AppState {
        vault,
        index: index_handle.clone(),
        cas: cas_arc,
        warnings: parking_lot::Mutex::new(stats.warnings),
        change_tx: change_broadcast_tx,
        hooks,
        delete_hooks,
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl,
    });

    // Optionally start LSP on stdio
    if enable_lsp {
        info!("starting LSP server on stdio");
        let lsp_state = Arc::clone(&state);
        tokio::spawn(async move {
            lsp::run_lsp(lsp_state).await;
            tracing::info!("LSP disconnected, shutting down");
            std::process::exit(0);
        });
    }

    // Spawn file watcher + sync loop
    let vault_root_buf = state.vault.root().to_path_buf();
    let sync_index = index_handle;
    let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
    let sync_change_tx = state.change_tx.clone();

    let _watcher = VaultWatcher::start(vault_root_buf, Duration::from_millis(500), change_tx)?;

    tokio::spawn(async move {
        loop {
            let batch = match change_rx.recv().await {
                Some(event) => drain_change_batch(event, &mut change_rx),
                None => break,
            };

            // Compute notification before passing batch to process_sync_events (which consumes it)
            let notification = notification_from_batch(&batch);

            match sync_index.process_sync_events(batch).await {
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
                        let _ = sync_change_tx.send(notification);
                    }
                }
                Err(e) => {
                    tracing::error!("sync error: {e}");
                }
            }
        }
    });

    let archive_body_limit =
        (state.vault.config().archive.max_request_size_mb as usize) * 1024 * 1024;

    let mut app = Router::new()
        .nest(
            "/api/vault",
            api::api_router_with_archive_limit(archive_body_limit),
        )
        .merge(api::openapi::router());

    if !settings.server.dev_mode {
        app = app.merge(api::frontend::frontend_router());
    }

    let app = app
        .with_state(state)
        .layer(ServiceBuilder::new().layer(TraceLayer::new_for_http()));

    let host_port = format!("{}:{}", settings.server.host, settings.server.port);
    let addr = tokio::net::lookup_host(&host_port)
        .await
        .map_err(|e| format!("cannot resolve server address \"{host_port}\": {e}"))?
        .next()
        .ok_or_else(|| format!("server address \"{host_port}\" resolved to no addresses"))?;

    if settings.server.tls.enabled {
        let (cert_path, key_path) = ensure_certificates(&settings.server.tls).await?;
        let config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
        info!(%addr, ?settings.server, vault_root = %vault_root.display(), "listening (HTTPS)");
        axum_server::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await?;
    } else {
        info!(%addr, ?settings.server, vault_root = %vault_root.display(), "listening (HTTP)");
        axum_server::bind(addr)
            .serve(app.into_make_service())
            .await?;
    }

    Ok(())
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
}
