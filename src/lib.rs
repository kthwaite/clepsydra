pub mod api;
pub mod app_config;
pub mod vault;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, response::IntoResponse, routing::get};
use config::{Config, Environment, File};
use serde::Deserialize;
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::trace::TraceLayer;
use tracing::{Level, info};
use tracing_subscriber::{EnvFilter, fmt};

use api::{AppState, api_router};
use app_config::{config_candidates, find_config_path};
use vault::Vault;
use vault::index::VaultIndex;
use vault::sync::watcher::VaultWatcher;
use vault::sync::{ChangeEvent, SyncEngine};

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
            .set_default("server.host", "127.0.0.1")?
            .set_default("server.port", 3000)?
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

    // Wrap index for shared access
    let index = Arc::new(parking_lot::Mutex::new(index));

    // Broadcast channel for SSE notifications
    let (change_broadcast_tx, _) = tokio::sync::broadcast::channel::<api::events::SyncNotification>(64);

    // Build post-move hooks
    let hooks: Vec<Box<dyn vault::hooks::PostMoveHook>> = vec![
        Box::new(vault::academic_hook::AcademicMoveHook),
    ];

    // Build shared state
    let state = Arc::new(AppState {
        vault,
        index: Arc::clone(&index),
        warnings: parking_lot::Mutex::new(stats.warnings),
        change_tx: change_broadcast_tx,
        hooks,
    });

    // Spawn file watcher + sync loop
    let vault_root_buf = state.vault.root().to_path_buf();
    let sync_index = Arc::clone(&state.index);
    let sync_vault = state.vault.clone();
    let (change_tx, mut change_rx) = tokio::sync::mpsc::unbounded_channel::<ChangeEvent>();
    let sync_change_tx = state.change_tx.clone();

    let _watcher = VaultWatcher::start(
        vault_root_buf,
        Duration::from_millis(500),
        change_tx,
    )?;

    tokio::spawn(async move {
        let mut batch: Vec<ChangeEvent> = Vec::new();
        loop {
            match change_rx.recv().await {
                Some(event) => {
                    batch.push(event);
                    // Drain any additional buffered events
                    while let Ok(event) = change_rx.try_recv() {
                        batch.push(event);
                    }
                }
                None => break,
            }

            let mut idx = sync_index.lock();
            match SyncEngine::process_events(&batch, &sync_vault, &mut idx) {
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

                    // Notify connected SSE clients
                    let mut upserted: Vec<String> = Vec::new();
                    let mut removed: Vec<String> = Vec::new();
                    for ev in &batch {
                        match ev {
                            ChangeEvent::Upsert(vp) => upserted.push(vp.as_str().to_string()),
                            ChangeEvent::Remove(vp) => removed.push(vp.as_str().to_string()),
                        }
                    }
                    if !upserted.is_empty() || !removed.is_empty() {
                        let _ = sync_change_tx.send(
                            api::events::SyncNotification::IndexChanged { upserted, removed },
                        );
                    }
                }
                Err(e) => {
                    tracing::error!("sync error: {e}");
                }
            }
            batch.clear();
        }
    });

    let app = Router::new()
        .route("/", get(root))
        .nest("/api/vault", api_router())
        .with_state(state)
        .layer(ServiceBuilder::new().layer(TraceLayer::new_for_http()));

    let addr = format!("{}:{}", settings.server.host, settings.server.port);

    let listener = TcpListener::bind(&addr).await?;
    info!(%addr, ?settings.server, vault_root = %settings.vault.root, "listening");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn root() -> impl IntoResponse {
    "ok"
}
