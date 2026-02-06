use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Uniform error payload for all API responses.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub status: u16,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self)).into_response()
    }
}

impl ApiError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: 404,
            error: msg.into(),
            detail: None,
            hint: None,
        }
    }

    pub fn conflict(msg: impl Into<String>) -> Self {
        Self {
            status: 409,
            error: msg.into(),
            detail: None,
            hint: None,
        }
    }

    pub fn conflict_with_detail(msg: impl Into<String>, detail: serde_json::Value) -> Self {
        Self {
            status: 409,
            error: msg.into(),
            detail: Some(detail),
            hint: None,
        }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: 400,
            error: msg.into(),
            detail: None,
            hint: None,
        }
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: 500,
            error: msg.into(),
            detail: None,
            hint: None,
        }
    }
}
