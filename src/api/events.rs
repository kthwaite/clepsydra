use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Serialize;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use super::AppState;

/// A notification emitted after the vault index changes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncNotification {
    /// Pages were created, modified, or removed.
    IndexChanged {
        upserted: Vec<String>,
        removed: Vec<String>,
    },
}

/// SSE endpoint that streams [`SyncNotification`] events to connected clients.
///
/// Lagged messages (when a client falls behind the broadcast buffer) are
/// silently dropped.
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
