pub mod academic;
pub mod agenda;
pub mod archive;
pub mod attachments;
pub mod bcl;
pub mod blocks;
pub mod board;
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
pub mod tasks;
pub mod uptime;

use std::sync::Arc;

use axum::Router;
use tokio::sync::broadcast;

use crate::api::events::SyncNotification;
use crate::vault::Vault;
use crate::vault::cas::ContentStore;
use crate::vault::index_handle::IndexHandle;

/// Shared application state threaded through all API handlers.
pub struct AppState {
    /// Monotonic instant captured when this state is built at startup. The
    /// `/uptime` endpoint reports `started_at.elapsed()`, giving true server
    /// uptime independent of any client's tab lifetime.
    pub started_at: std::time::Instant,
    pub vault: Vault,
    pub index: IndexHandle,
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
    pub warnings: parking_lot::Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
    pub hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostMoveHook>>>,
    pub delete_hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostDeleteHook>>>,
    /// Serializes archive ingest to prevent concurrent race conditions
    /// (duplicate URL check, path collision, file write/index atomicity).
    pub archive_ingest_lock: tokio::sync::Mutex<()>,
    /// Optional Brimley-Cocoon Line birth date, loaded once at startup from
    /// `<vault>/.clepsydra/bcl` (with a one-time copy from `~/.config/bcl`
    /// when the vault file is absent). `None` means the feature is hidden.
    pub bcl: Option<chrono::NaiveDate>,
    /// Optional vault location, loaded once at startup from
    /// `<vault>/.clepsydra/location.toml` (with a one-time copy from
    /// `~/.config/clepsydra/location.toml` when the vault file is absent).
    /// `None` means the feature is hidden.
    pub location: Option<crate::vault::location::Location>,
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
        .nest("/blocks", blocks::router())
        .route("/bcl", axum::routing::get(bcl::get_bcl))
        .route("/location", axum::routing::get(location::get_location))
        .route("/uptime", axum::routing::get(uptime::get_uptime))
}
