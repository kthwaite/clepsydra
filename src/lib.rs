pub mod api;
pub mod vault;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{Router, response::IntoResponse, routing::get};
use config::{Config, ConfigError, Environment, File};
use serde::Deserialize;
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::trace::TraceLayer;
use tracing::{Level, info};
use tracing_subscriber::{EnvFilter, fmt};

use api::{AppState, api_router};
use vault::Vault;
use vault::index::VaultIndex;

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
    fn load() -> Result<Self, ConfigError> {
        // Precedence (later wins): defaults < config.toml < env vars
        // Env vars use: CLEPSYDRA__SERVER__HOST / CLEPSYDRA__SERVER__PORT
        Config::builder()
            .set_default("server.host", "127.0.0.1")?
            .set_default("server.port", 3000)?
            .set_default("vault.root", "./vault")?
            .add_source(File::with_name("config").required(false))
            .add_source(Environment::with_prefix("CLEPSYDRA").separator("__"))
            .build()?
            .try_deserialize()
    }
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

    let settings = Settings::load()?;

    // Resolve vault root path
    let vault_root = PathBuf::from(&settings.vault.root);

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

    // Build shared state
    let state = Arc::new(AppState {
        vault,
        index: Mutex::new(index),
        warnings: Mutex::new(stats.warnings),
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
