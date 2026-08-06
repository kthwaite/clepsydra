pub mod academic;
pub mod agenda;
pub mod archive;
pub mod attachments;
pub mod bases;
pub mod bcl;
pub mod blocks;
pub mod board;
pub mod deeplink;
pub mod error;
pub mod events;
pub mod folders;
pub mod frontend;
pub mod index_routes;
pub mod journal;
pub mod location;
pub mod openapi;
pub mod pages;
pub mod pagination;
pub mod properties;
pub mod query;
pub mod tasks;
pub mod uptime;

use std::sync::Arc;

use axum::Router;
use tokio::sync::broadcast;

use crate::api::events::SyncNotification;
use crate::vault::Vault;
use crate::vault::cas::ContentStore;
use crate::vault::index_handle::IndexHandle;

/// Time source for date-sensitive API behavior.
pub trait Clock: Send + Sync {
    fn now(&self) -> chrono::DateTime<chrono::Utc>;
}

/// Production UTC wall clock.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }
}

/// Shared application state threaded through all API handlers.
pub struct AppState {
    /// Monotonic instant captured when this state is built at startup. The
    /// `/uptime` endpoint reports `started_at.elapsed()`, giving true server
    /// uptime independent of any client's tab lifetime.
    pub started_at: std::time::Instant,
    pub clock: Arc<dyn Clock>,
    pub vault: Vault,
    pub index: IndexHandle,
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
    pub warnings: parking_lot::Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
    pub hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostMoveHook>>>,
    pub delete_hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostDeleteHook>>>,
    pub mutation_coordinator: crate::vault::mutation_coordinator::MutationCoordinator,
    /// Serializes archive ingest to prevent concurrent race conditions
    /// (duplicate URL check, path collision, file write/index atomicity).
    pub archive_ingest_lock: tokio::sync::Mutex<()>,
    /// Optional Brimley-Cocoon Line birth date, loaded once at startup from
    /// `<vault>/.clepsydra/bcl` (with a one-time copy from `~/.config/bcl`
    /// when the vault file is absent). `None` means the feature is hidden.
    pub bcl: Option<chrono::NaiveDate>,
    /// Vault location, loaded at startup from
    /// `<vault>/.clepsydra/location.toml` (with a one-time copy from
    /// `~/.config/clepsydra/location.toml` when the vault file is absent).
    /// `None` means the feature is hidden. Wrapped in an `RwLock` so the
    /// `PUT /location` handler can update it live without a restart.
    pub location: parking_lot::RwLock<Option<crate::vault::location::Location>>,
}

pub(crate) fn mutation_error(
    error: crate::vault::mutation_coordinator::MutationError,
) -> error::ApiError {
    use crate::vault::mutation_coordinator::MutationError;

    match error {
        MutationError::InvalidInput(message) => error::ApiError::bad_request(message),
        MutationError::NotFound(path) => {
            error::ApiError::not_found(format!("page not found: {}", path.as_str()))
        }
        MutationError::Conflict(message) => error::ApiError::conflict(message),
        MutationError::Stale(path) => {
            error::ApiError::conflict(format!("page changed during mutation: {}", path.as_str()))
        }
        MutationError::Filesystem { .. }
        | MutationError::Index { .. }
        | MutationError::Reconcile { .. }
        | MutationError::Hook { .. } => error::ApiError::internal(error.to_string()),
    }
}

/// Build the API router mounted at `/api/vault`.
pub fn api_router() -> Router<Arc<AppState>> {
    api_router_with_archive_limit(100 * 1024 * 1024) // default 100 MB
}

/// Build the API router with a custom archive body limit (in bytes).
pub fn api_router_with_archive_limit(archive_body_limit: usize) -> Router<Arc<AppState>> {
    Router::new()
        .route("/events", axum::routing::get(events::event_stream))
        .nest("/pages", pages::router())
        .nest("/pages-move", pages::move_router())
        .nest("/pages-assign", pages::assign_router())
        .route(
            "/pages-assign-bulk",
            axum::routing::post(pages::assign_bulk),
        )
        .nest("/folders", folders::router())
        .nest("/folders-move", folders::move_router())
        .nest("/attachments", attachments::router())
        .nest("/academic", academic::router())
        .nest(
            "/archive",
            archive::router_with_body_limit(archive_body_limit),
        )
        .nest("/cas", archive::cas_router())
        .nest("/index", index_routes::router())
        .nest("/journal", journal::router())
        .nest("/tasks", tasks::router())
        .nest("/board", board::router())
        .nest("/agenda", agenda::router())
        .nest("/bases", bases::router())
        .nest("/query", query::router())
        .nest("/blocks", blocks::router())
        .route("/bcl", axum::routing::get(bcl::get_bcl))
        .route(
            "/location",
            axum::routing::get(location::get_location).put(location::put_location),
        )
        .route("/geocode", axum::routing::get(location::geocode_search))
        .route("/uptime", axum::routing::get(uptime::get_uptime))
        .merge(deeplink::router())
}
