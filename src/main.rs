use axum::{response::IntoResponse, routing::get, Router};
use config::{Config, Environment, File};
use serde::Deserialize;
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::trace::TraceLayer;
use tracing::{info, Level};
use tracing_subscriber::{fmt, EnvFilter};

#[derive(Debug, Deserialize)]
struct Settings {
    server: ServerSettings,
}

#[derive(Debug, Deserialize)]
struct ServerSettings {
    host: String,
    port: u16,
}

impl Settings {
    fn load() -> Result<Self, config::ConfigError> {
        // Precedence (later wins): defaults < config.toml < env vars
        // Env vars use: CLEPSYDRA__SERVER__HOST / CLEPSYDRA__SERVER__PORT
        Config::builder()
            .set_default("server.host", "127.0.0.1")?
            .set_default("server.port", 3000)?
            .add_source(File::with_name("config").required(false))
            .add_source(Environment::with_prefix("CLEPSYDRA").separator("__"))
            .build()?
            .try_deserialize()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Logging via `tracing`.
    // Configure with `RUST_LOG=debug` (or e.g. `RUST_LOG=clepsydra=debug,tower_http=debug`).
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(Level::INFO.to_string())),
        )
        .init();

    let settings = Settings::load()?;

    let app = Router::new().route("/", get(root)).layer(
        ServiceBuilder::new().layer(TraceLayer::new_for_http()),
    );

    let addr = format!("{}:{}", settings.server.host, settings.server.port);

    let listener = TcpListener::bind(&addr).await?;
    info!(%addr, ?settings.server, "listening");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn root() -> impl IntoResponse {
    "ok"
}
