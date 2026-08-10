pub mod academic;
pub mod agenda;
pub mod archive;
pub mod attachments;
pub mod base_members;
pub mod bases;
pub mod bcl;
pub mod blocks;
pub mod board;
pub mod conversations;
pub mod deeplink;
pub mod encryption;
pub mod error;
pub mod events;
pub mod feeds;
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
    /// Time source for date-sensitive API behavior. Defaults to `SystemClock`.
    pub clock: Arc<dyn Clock>,
    /// Vault instance, shared across all API handlers.
    pub vault: Vault,
    /// Index handle, shared across all API handlers.
    pub index: IndexHandle,
    /// Content-addressable storage (CAS) instance, shared across all API handlers.
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
    /// Broadcast channel for notifying API clients of vault changes.
    pub warnings: parking_lot::Mutex<Vec<String>>,
    /// Broadcast channel for notifying API clients of vault changes.
    pub change_tx: broadcast::Sender<SyncNotification>,
    /// Hooks for post-move and post-delete operations, shared across all API handlers.
    pub hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostMoveHook>>>,
    /// Hooks for post-delete operations, shared across all API handlers.
    pub delete_hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostDeleteHook>>>,
    /// Mutation coordinator for serializing vault mutations, shared across all API handlers.
    pub mutation_coordinator: crate::vault::mutation_coordinator::MutationCoordinator,
    /// Serialized feed/entry storage backed by `.clepsydra/feeds.db`.
    pub feeds: crate::feeds::store::FeedStoreHandle,
    /// Checked HTTP client enforcing the RSS network boundary.
    pub feed_client: crate::feeds::network::CheckedHttpClient,
    /// Bounds subscribe discovery independently of manifest serialization.
    pub feed_discovery_semaphore: tokio::sync::Semaphore,
    /// Shared wake-up for manifest edits and explicit refresh requests.
    pub feed_refresh: tokio::sync::Notify,
    /// Diagnostics from the current raw manifest. Warning-bearing manifests do
    /// not replace the last-good subscription set.
    pub feed_manifest_diagnostics: parking_lot::RwLock<Vec<crate::feeds::types::ManifestWarning>>,
    /// Serializes API read/transform/CAS membership mutations.
    pub feed_manifest_lock: tokio::sync::Mutex<()>,
    #[cfg(test)]
    pub(crate) feed_before_reconcile_commit_hook:
        parking_lot::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) feed_after_list_snapshot_hook:
        parking_lot::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    pub(crate) feed_before_opml_parse_hook: parking_lot::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Feed scheduler limits resolved from the application configuration.
    pub feed_settings: crate::FeedsSettings,
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

pub(crate) fn mutation_notifier(
    state: &AppState,
) -> Arc<dyn Fn(crate::vault::mutation_coordinator::MutationNotification) + Send + Sync> {
    let change_tx = state.change_tx.clone();
    Arc::new(move |notification| {
        let _ = change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    })
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
        | MutationError::FilesystemRollback { .. }
        | MutationError::Index { .. }
        | MutationError::IndexRollback { .. }
        | MutationError::IndexCompensation { .. }
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
        .nest("/encryption", encryption::router())
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
        .nest("/conversations", conversations::router())
        .nest("/board", board::router())
        .nest("/agenda", agenda::router())
        .nest("/bases", bases::router())
        .nest("/feeds", feeds::router())
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
