//! API endpoints related to server-sent events (SSE) for vault synchronization notifications.
use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Serialize;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use utoipa::ToSchema;

use super::AppState;

/// A notification emitted after the vault index changes.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncNotification {
    /// Pages were created, modified, or removed.
    IndexChanged {
        upserted: Vec<String>,
        removed: Vec<String>,
    },
    /// A base definition file changed; open views should refetch.
    BaseRegistryChanged,
}

/// SSE endpoint that streams [`SyncNotification`] events to connected clients.
///
/// Lagged messages (when a client falls behind the broadcast buffer) are
/// silently dropped.
#[utoipa::path(
    get,
    path = "/events",
    context_path = "/api/vault",
    tag = "Events",
    responses(
        (status = 200, description = "Server-sent events stream", body = String, content_type = "text/event-stream")
    )
)]
pub async fn event_stream(
    State(state): State<Arc<AppState>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.change_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(notification) => {
            let json = serde_json::to_string(&notification).ok()?;
            Some(Ok(Event::default().data(json)))
        }
        Err(_) => None, // skip lagged messages
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
