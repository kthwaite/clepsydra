//! Location endpoint.
//!
//! Reads the location loaded once at startup (see [`crate::vault::location`])
//! and returns latitude/longitude plus an optional human label. When no config
//! is present the response fields are all `null`; the frontend treats this as
//! "feature disabled" and falls back gracefully.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::location::Location;

/// Production base URL for the OpenStreetMap Nominatim geocoding API.
const NOMINATIM_BASE_URL: &str = "https://nominatim.openstreetmap.org";

/// Default number of geocoding candidates to request when the caller omits
/// `limit`.
const DEFAULT_GEOCODE_LIMIT: u32 = 5;

/// Upper bound on the number of geocoding candidates, to keep upstream load
/// (and response size) bounded regardless of the requested `limit`.
const MAX_GEOCODE_LIMIT: u32 = 10;

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
    let guard = state.location.read();
    let Some(loc) = guard.as_ref() else {
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

/// Request body for `PUT /location`: the new geographic location.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateLocationRequest {
    /// Latitude in degrees, range `[-90, 90]`.
    pub latitude: f64,
    /// Longitude in degrees, range `[-180, 180]`.
    pub longitude: f64,
    /// Optional human-readable label (e.g. `"London"`).
    #[serde(default)]
    pub label: Option<String>,
}

#[utoipa::path(
    put,
    path = "/location",
    context_path = "/api/vault",
    tag = "Location",
    request_body = UpdateLocationRequest,
    responses(
        (status = 200, description = "Updated vault location", body = LocationResponse),
        (status = 400, description = "Latitude or longitude out of range"),
    )
)]
pub async fn put_location(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateLocationRequest>,
) -> Result<Json<LocationResponse>, ApiError> {
    if !(-90.0..=90.0).contains(&req.latitude) {
        return Err(ApiError::bad_request("latitude must be in range [-90, 90]"));
    }
    if !(-180.0..=180.0).contains(&req.longitude) {
        return Err(ApiError::bad_request(
            "longitude must be in range [-180, 180]",
        ));
    }

    let loc = Location {
        latitude: req.latitude,
        longitude: req.longitude,
        label: req.label.filter(|s| !s.trim().is_empty()),
    };

    crate::vault::location::write_location(state.vault.root(), &loc).map_err(ApiError::internal)?;

    *state.location.write() = Some(loc.clone());

    Ok(Json(LocationResponse {
        latitude: Some(loc.latitude),
        longitude: Some(loc.longitude),
        label: loc.label,
    }))
}

/// Query parameters for `GET /geocode`.
#[derive(Debug, Deserialize)]
pub struct GeocodeQuery {
    /// Free-text place name to geocode (e.g. `"London"`).
    pub q: String,
    /// Maximum number of candidates to return. Defaults to 5, clamped to 10.
    pub limit: Option<u32>,
}

/// A single geocoding candidate in the API response.
#[derive(Debug, Serialize, ToSchema)]
pub struct GeocodeResultDto {
    /// Human-readable place name.
    pub label: String,
    /// Latitude in degrees.
    pub latitude: f64,
    /// Longitude in degrees.
    pub longitude: f64,
}

/// Response body for `GET /geocode`.
#[derive(Debug, Serialize, ToSchema)]
pub struct GeocodeResponse {
    /// Candidate locations matching the query, possibly empty.
    pub results: Vec<GeocodeResultDto>,
}

#[utoipa::path(
    get,
    path = "/geocode",
    context_path = "/api/vault",
    tag = "Location",
    params(
        ("q" = String, Query, description = "Free-text place name to geocode"),
        ("limit" = Option<u32>, Query, description = "Max candidates (default 5, max 10)"),
    ),
    responses(
        (status = 200, description = "Geocoding candidates", body = GeocodeResponse),
        (status = 400, description = "Blank query"),
        (status = 502, description = "Upstream geocoding service failure"),
    )
)]
pub async fn geocode_search(
    State(_state): State<Arc<AppState>>,
    Query(query): Query<GeocodeQuery>,
) -> Result<Json<GeocodeResponse>, ApiError> {
    let q = query.q.trim();
    if q.is_empty() {
        return Err(ApiError::bad_request(
            "query parameter `q` must not be blank",
        ));
    }

    let limit = query
        .limit
        .unwrap_or(DEFAULT_GEOCODE_LIMIT)
        .clamp(1, MAX_GEOCODE_LIMIT);

    let client = reqwest::Client::new();
    let results = crate::vault::geocode::geocode(&client, NOMINATIM_BASE_URL, q, limit)
        .await
        .map_err(|e| ApiError {
            status: 502,
            error: format!("geocoding service unavailable: {e}"),
            detail: None,
            hint: None,
        })?;

    Ok(Json(GeocodeResponse {
        results: results
            .into_iter()
            .map(|r| GeocodeResultDto {
                label: r.label,
                latitude: r.latitude,
                longitude: r.longitude,
            })
            .collect(),
    }))
}
