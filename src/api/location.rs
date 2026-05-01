//! Location endpoint.
//!
//! Reads the location loaded once at startup (see [`crate::vault::location`])
//! and returns latitude/longitude plus an optional human label. When no config
//! is present the response fields are all `null`; the frontend treats this as
//! "feature disabled" and falls back gracefully.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;

#[derive(Debug, Serialize, ToSchema)]
pub struct LocationResponse {
    /// Configured latitude in degrees, range `[-90, 90]`. `None` when unconfigured.
    pub latitude: Option<f64>,
    /// Configured longitude in degrees, range `[-180, 180]`. `None` when unconfigured.
    pub longitude: Option<f64>,
    /// Optional human-readable label (e.g. `"London"`).
    pub label: Option<String>,
}

#[utoipa::path(
    get,
    path = "/location",
    context_path = "/api/vault",
    tag = "Location",
    responses(
        (status = 200, description = "Vault location (fields null when unconfigured)", body = LocationResponse),
    )
)]
pub async fn get_location(
    State(state): State<Arc<AppState>>,
) -> Result<Json<LocationResponse>, ApiError> {
    let Some(loc) = &state.location else {
        return Ok(Json(LocationResponse {
            latitude: None,
            longitude: None,
            label: None,
        }));
    };

    Ok(Json(LocationResponse {
        latitude: Some(loc.latitude),
        longitude: Some(loc.longitude),
        label: loc.label.clone(),
    }))
}
