pub mod api;
pub mod app_config;
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
struct Settings {
    server: ServerSettings,
    #[serde(default)]
    vault: VaultSettings,
}

#[derive(Debug, Deserialize)]
struct ServerSettings {
    host: String,
    port: u16,
    #[serde(default)]
    dev_mode: bool,
    #[serde(default)]
    tls: TlsSettings,
}

#[derive(Debug, Deserialize, Default)]
struct TlsSettings {
    #[serde(default)]
    enabled: bool,
    cert_path: Option<PathBuf>,
    key_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct VaultSettings {
    #[serde(default = "default_vault_root")]
    root: String,
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

        // Precedence (later wins): defaults < config file < env vars
        let settings = Config::builder()
            .set_default("server.host", "localhost")?
            .set_default("server.port", 3000)?
            .set_default("server.dev_mode", false)?
            .set_default("server.tls.enabled", false)?
            .set_default("vault.root", "./vault")?
            .add_source(File::from(config_path.clone()))
            .add_source(Environment::with_prefix("CLEPSYDRA").separator("__"))
            .build()?
            .try_deserialize()?;

        Ok((settings, config_path))
    }
}

fn resolve_vault_root(root: &str, config_path: &Path, cwd: &Path) -> PathBuf {
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

pub async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
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
    let cas_path = if let Some(stripped) = cas_path_raw.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(stripped)
    } else {
        PathBuf::from(cas_path_raw)
    };
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
    });

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

    let addr = format!("{}:{}", settings.server.host, settings.server.port)
        .parse::<std::net::SocketAddr>()?;

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
}
