//! BCL (Brimley-Cocoon Line) endpoint.
//!
//! Reads the birth date loaded once at startup (see [`crate::vault::bcl`]) and
//! returns the configured date, the computed BCL date, and seconds remaining.
//! When no config is present the response fields are all `null`; the frontend
//! treats this as "feature disabled" and renders nothing.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use chrono::{NaiveDate, Utc};
use serde::Serialize;
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::bcl;

#[derive(Debug, Serialize, ToSchema)]
pub struct BclResponse {
    /// Configured date of birth, `YYYY-MM-DD`. `None` when unconfigured.
    pub birth_date: Option<String>,
    /// Computed Brimley-Cocoon Line date, `YYYY-MM-DD`. `None` when unconfigured.
    pub bcl_date: Option<String>,
    /// Seconds from now until the BCL. Negative once the line is crossed.
    /// `None` when unconfigured.
    pub remaining_seconds: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/bcl",
    context_path = "/api/vault",
    tag = "BCL",
    responses(
        (status = 200, description = "BCL countdown (fields null when unconfigured)", body = BclResponse),
    )
)]
pub async fn get_bcl(State(state): State<Arc<AppState>>) -> Result<Json<BclResponse>, ApiError> {
    let Some(birth) = state.bcl else {
        return Ok(Json(BclResponse {
            birth_date: None,
            bcl_date: None,
            remaining_seconds: None,
        }));
    };

    let bcl_date = bcl::bcl_date(birth);
    let remaining = remaining_seconds_until(bcl_date);

    Ok(Json(BclResponse {
        birth_date: Some(birth.format("%Y-%m-%d").to_string()),
        bcl_date: Some(bcl_date.format("%Y-%m-%d").to_string()),
        remaining_seconds: Some(remaining),
    }))
}

/// Treat the BCL as midnight UTC on its date, then diff against `now`.
/// Aligning on UTC gives a stable cross-timezone answer; the day-level
/// granularity of birth date makes sub-day precision meaningless anyway.
fn remaining_seconds_until(bcl_date: NaiveDate) -> i64 {
    let bcl_dt = bcl_date
        .and_hms_opt(0, 0, 0)
        .expect("midnight is always valid")
        .and_utc();
    bcl_dt.signed_duration_since(Utc::now()).num_seconds()
}
