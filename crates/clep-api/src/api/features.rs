//! Runtime feature capabilities.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use utoipa::ToSchema;

use super::AppState;

#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureFlagsResponse {
    pub academic: bool,
    pub feeds: bool,
}

#[utoipa::path(
    get,
    path = "/features",
    context_path = "/api",
    tag = "Features",
    responses(
        (status = 200, description = "Effective server feature capabilities", body = FeatureFlagsResponse),
    )
)]
pub async fn get_features(State(state): State<Arc<AppState>>) -> Json<FeatureFlagsResponse> {
    Json(FeatureFlagsResponse {
        academic: state.features.academic,
        feeds: state.features.feeds,
    })
}
