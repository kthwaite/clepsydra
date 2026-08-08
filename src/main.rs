mod feeds;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::Router;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tokio::sync::Notify;
use tower_http::services::{ServeDir, ServeFile};

const MANIFEST_TEMPLATE: &str = "\
# feeds

Subscriptions live in this note. `##` sections are groups; `#tags` on a
heading apply to the whole section. List items are feed URLs, optionally
`[Title](url)` to override the display name, with their own trailing `#tags`.

## Feeds
";

pub struct Config {
    pub db_path: PathBuf,
    pub vault_dir: PathBuf,
    pub ui_dist: PathBuf,
    pub port: u16,
    pub fetch_interval_mins: i64,
    pub retention_days: i64,
    pub unread_retention_days: i64,
}

impl Config {
    fn from_env() -> Self {
        let var = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Self {
            db_path: var("CLEPSYDRA_DB", "clepsydra.db").into(),
            vault_dir: var("CLEPSYDRA_VAULT", "vault").into(),
            ui_dist: var("CLEPSYDRA_UI_DIST", "ui/dist").into(),
            port: var("CLEPSYDRA_PORT", "8640").parse().expect("invalid port"),
            fetch_interval_mins: var("CLEPSYDRA_FETCH_INTERVAL_MINS", "30")
                .parse()
                .expect("invalid fetch interval"),
            retention_days: var("CLEPSYDRA_RETENTION_DAYS", "30")
                .parse()
                .expect("invalid retention"),
            unread_retention_days: var("CLEPSYDRA_UNREAD_RETENTION_DAYS", "90")
                .parse()
                .expect("invalid unread retention"),
        }
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.vault_dir.join("feeds.md")
    }
}

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
    pub config: Arc<Config>,
    pub refresh: Arc<Notify>,
    pub http: reqwest::Client,
    pub manifest_warnings: Arc<Mutex<Vec<String>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clepsydra=info,tower_http=warn".into()),
        )
        .init();

    let config = Arc::new(Config::from_env());
    std::fs::create_dir_all(&config.vault_dir)?;
    if !config.manifest_path().exists() {
        std::fs::write(config.manifest_path(), MANIFEST_TEMPLATE)?;
    }

    let opts = SqliteConnectOptions::new()
        .filename(&config.db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    sqlx::migrate!().run(&pool).await?;

    let http = reqwest::Client::builder()
        .user_agent(concat!("clepsydra/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()?;

    let state = AppState {
        pool,
        config: config.clone(),
        refresh: Arc::new(Notify::new()),
        http,
        manifest_warnings: Arc::new(Mutex::new(Vec::new())),
    };

    if let Err(e) = feeds::reconcile(&state).await {
        tracing::warn!("initial feeds.md reconcile failed: {e:#}");
    }
    feeds::scheduler::spawn(state.clone());

    let app = Router::new()
        .nest("/api", feeds::api::router())
        .fallback_service(
            ServeDir::new(&config.ui_dist)
                .fallback(ServeFile::new(config.ui_dist.join("index.html"))),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!("clepsydra listening on http://localhost:{}", config.port);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
