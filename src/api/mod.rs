pub mod academic;
pub mod agenda;
pub mod archive;
pub mod attachments;
pub mod error;
pub mod events;
pub mod folders;
pub mod frontend;
pub mod index_routes;
pub mod journal;
pub mod openapi;
pub mod pages;
pub mod pagination;
pub mod tasks;

use std::sync::Arc;

use axum::Router;
use tokio::sync::broadcast;

use crate::api::events::SyncNotification;
use crate::vault::Vault;
use crate::vault::cas::ContentStore;
use crate::vault::index_handle::IndexHandle;

/// Shared application state threaded through all API handlers.
pub struct AppState {
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
        .nest("/agenda", agenda::router())
}
