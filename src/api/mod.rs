pub mod attachments;
pub mod error;
pub mod events;
pub mod folders;
pub mod index_routes;
pub mod pages;

use std::sync::{Arc, Mutex};

use axum::Router;
use tokio::sync::broadcast;

use crate::api::events::SyncNotification;
use crate::vault::Vault;
use crate::vault::index::VaultIndex;

/// Shared application state threaded through all API handlers.
pub struct AppState {
    pub vault: Vault,
    pub index: Arc<Mutex<VaultIndex>>,
    pub warnings: Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
}

/// Build the API router mounted at `/api/vault`.
pub fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/events", axum::routing::get(events::event_stream))
        .nest("/pages", pages::router())
        .nest("/pages-move", pages::move_router())
        .nest("/folders", folders::router())
        .nest("/folders-move", folders::move_router())
        .nest("/attachments", attachments::router())
        .nest("/index", index_routes::router())
}
