//! Uptime endpoint.
//!
//! Reports how long the server process has been running, measured from the
//! monotonic [`std::time::Instant`] captured when [`AppState`] is constructed
//! at startup. This replaces the frontend's former tab-lifetime approximation
//! (a module-level `Date.now()` reset on every reload) with true server
//! uptime.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use utoipa::ToSchema;

use super::AppState;

#[derive(Debug, Serialize, ToSchema)]
pub struct UptimeResponse {
    /// Whole seconds the server has been running since startup.
    pub uptime_seconds: u64,
}

#[utoipa::path(
    get,
    path = "/uptime",
    context_path = "/api/vault",
    tag = "Uptime",
    responses(
        (status = 200, description = "Server uptime in seconds", body = UptimeResponse),
    )
)]
pub async fn get_uptime(State(state): State<Arc<AppState>>) -> Json<UptimeResponse> {
    Json(UptimeResponse {
        uptime_seconds: state.started_at.elapsed().as_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_test_support::make_state;

    #[tokio::test]
    async fn uptime_reports_a_fresh_startup_value() {
        let (state, _tmp) = make_state().await;
        let resp = get_uptime(State(state)).await;
        // A just-built state was started moments ago: well under a minute.
        assert!(
            resp.0.uptime_seconds < 60,
            "freshly started state should report a small uptime, got {}",
            resp.0.uptime_seconds
        );
    }
}
