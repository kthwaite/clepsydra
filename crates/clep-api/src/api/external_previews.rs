//! External requests are initiated only by the opt-in JSON POST endpoint.
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{AppState, error::ApiError};
use crate::external_previews::{PreviewError, PreviewResponse};

#[derive(Deserialize, ToSchema)]
#[schema(as = ExternalPreviewRequest)]
pub struct PreviewRequest {
    pub url: String,
}

#[derive(Serialize, ToSchema)]
#[schema(as = ExternalPreviewStatus)]
pub struct PreviewStatus {
    pub enabled: bool,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/external-previews", post(request))
        .route("/external-previews/embed", post(embed))
        .route("/external-previews/status", get(status))
        .route("/external-previews/images/{key}", get(image))
        .layer(DefaultBodyLimit::max(32 * 1024))
}

#[utoipa::path(
    get, path = "/external-previews/status", context_path = "/api/vault",
    tag = "External previews",
    responses((status = 200, description = "External preview opt-in status; never fetches", body = PreviewStatus))
)]
pub async fn status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(PreviewStatus {
            enabled: state.external_previews.enabled(),
        }),
    )
}

#[utoipa::path(
    post, path = "/external-previews", context_path = "/api/vault",
    tag = "External previews", request_body = PreviewRequest,
    responses(
        (status = 200, description = "Cached preview or bounded asynchronous capture status", body = PreviewResponse),
        (status = 400, description = "Invalid URL", body = ApiError),
        (status = 403, description = "Cross-site request rejected", body = ApiError),
        (status = 500, description = "Preview cache unavailable", body = ApiError)
    )
)]
pub async fn request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PreviewRequest>,
) -> Result<Json<PreviewResponse>, ApiError> {
    // JSON rejects simple HTML form requests. Fetch metadata adds protection for
    // cross-site browser requests without breaking non-browser API clients.
    if headers
        .get("sec-fetch-site")
        .is_some_and(|value| value == "cross-site")
    {
        return Err(ApiError::forbidden(
            "cross-site preview requests are not allowed",
        ));
    }
    state
        .external_previews
        .request(&request.url)
        .await
        .map(Json)
        .map_err(|error| match error {
            PreviewError::InvalidUrl(message) => ApiError::bad_request(message),
            PreviewError::CacheUnavailable => ApiError::internal("preview cache unavailable"),
        })
}

#[utoipa::path(
    post, path = "/external-previews/embed", context_path = "/api/vault",
    tag = "External previews", request_body = PreviewRequest,
    responses(
        (status = 200, description = "Checked embed candidate, not confirmation that a browser loaded it", body = crate::external_embeds::ExternalEmbedResponse),
        (status = 403, description = "Cross-site request rejected", body = ApiError)
    )
)]
pub async fn embed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PreviewRequest>,
) -> Result<impl IntoResponse, ApiError> {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|value| value == "cross-site")
    {
        return Err(ApiError::forbidden(
            "cross-site preview requests are not allowed",
        ));
    }
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(crate::external_embeds::resolve(&state, &request.url).await),
    ))
}

#[utoipa::path(
    get, path = "/external-previews/images/{key}", context_path = "/api/vault",
    tag = "External previews",
    params(("key" = String, Path, description = "64 hexadecimal characters")),
    responses(
        (status = 200, description = "Cached JPEG; never fetches", content_type = "image/jpeg", body = Vec<u8>),
        (status = 404, description = "Preview image unavailable")
    )
)]
pub async fn image(State(state): State<Arc<AppState>>, Path(key): Path<String>) -> Response {
    match state.external_previews.image(&key).await {
        Some(bytes) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                // A refreshed screenshot retains the same key, so never reuse an old
                // browser-cached body in preference to the current cache entry.
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_previews::PreviewState;

    #[tokio::test]
    async fn disabled_http_routes_never_admit_capture_and_forms_are_rejected() {
        let (state, _tmp) = crate::state_test_support::make_state().await;
        let server = axum_test::TestServer::new(router().with_state(state)).unwrap();
        let status = server.get("/external-previews/status").await;
        assert_eq!(status.json::<serde_json::Value>()["enabled"], false);
        let response = server
            .post("/external-previews")
            .json(&serde_json::json!({
                "url": "http://127.0.0.1/private?secret=value"
            }))
            .await;
        response.assert_status_ok();
        assert_eq!(
            response.json::<PreviewResponse>().state,
            PreviewState::Disabled
        );
        server
            .post("/external-previews")
            .content_type("application/x-www-form-urlencoded")
            .text("url=https://example.com")
            .await
            .assert_status(StatusCode::UNSUPPORTED_MEDIA_TYPE);
        server
            .get(&format!("/external-previews/images/{}", "a".repeat(64)))
            .await
            .assert_status_not_found();
    }

    #[tokio::test]
    async fn cross_site_browser_capture_is_rejected() {
        let (state, _tmp) = crate::state_test_support::make_state().await;
        let server = axum_test::TestServer::new(router().with_state(state)).unwrap();
        server
            .post("/external-previews")
            .add_header("sec-fetch-site", "cross-site")
            .json(&serde_json::json!({"url": "https://example.com"}))
            .await
            .assert_status_forbidden();
    }

    #[tokio::test]
    async fn embed_http_requires_same_site_json_and_never_returns_a_disabled_url() {
        let (state, _tmp) = crate::state_test_support::make_state().await;
        let server = axum_test::TestServer::new(router().with_state(state)).unwrap();
        let response = server
            .post("/external-previews/embed")
            .json(&serde_json::json!({"url": "http://127.0.0.1/private"}))
            .await;
        response.assert_status_ok();
        response.assert_header("cache-control", "no-store");
        let response = response.json::<crate::external_embeds::ExternalEmbedResponse>();
        assert_eq!(
            response.state,
            crate::external_embeds::ExternalEmbedState::Disabled
        );
        assert!(response.url.is_none());
        assert!(response.source.is_none());
        assert!(!response.scripts);
        server
            .post("/external-previews/embed")
            .add_header("sec-fetch-site", "cross-site")
            .json(&serde_json::json!({"url": "https://example.com"}))
            .await
            .assert_status_forbidden();
        server
            .post("/external-previews/embed")
            .content_type("application/x-www-form-urlencoded")
            .text("url=https://example.com")
            .await
            .assert_status(axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
}
