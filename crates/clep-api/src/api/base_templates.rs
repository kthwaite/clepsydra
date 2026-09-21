//! HTTP access to vault-authored, revision-guarded Markdown templates.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use clep_bases::template_document::{self, TemplateDocument, TemplateError};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;

// A 1 MiB source may use six JSON bytes per character when escaped.
pub(crate) const TEMPLATE_REQUEST_BYTES: usize = 6 * 1024 * 1024 + 64 * 1024;

#[derive(Debug, Serialize, ToSchema)]
pub struct TemplateListResponse {
    pub templates: Vec<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateTemplateRequest {
    pub source: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateTemplateRequest {
    pub source: String,
    pub expected_revision: String,
}

pub(crate) fn template_error(error: TemplateError) -> ApiError {
    let code = match &error {
        TemplateError::InvalidSlug(_)
        | TemplateError::UnsafePath
        | TemplateError::InvalidSource => "invalid_template",
        TemplateError::TooLarge => "template_resource_limit",
        TemplateError::NotFound(_) => "missing_template",
        TemplateError::AlreadyExists(_) => "template_exists",
        TemplateError::Conflict { .. } => "template_revision_conflict",
        TemplateError::PublishedButNotDurable(_) | TemplateError::Io(_) => "template_storage_error",
    };
    let mut result = match error {
        TemplateError::Conflict { current_revision } => {
            return ApiError::conflict_with_detail(
                "template changed since it was loaded",
                serde_json::json!({ "code": code, "current_revision": current_revision }),
            );
        }
        TemplateError::NotFound(_) => ApiError::not_found("template was not found"),
        TemplateError::AlreadyExists(_) => ApiError::conflict("template already exists"),
        TemplateError::InvalidSlug(_) => ApiError::bad_request("invalid template slug"),
        TemplateError::UnsafePath => ApiError::bad_request(
            "template path must contain only physical directories and a regular file",
        ),
        TemplateError::InvalidSource => ApiError::bad_request("template source is not valid UTF-8"),
        TemplateError::TooLarge => ApiError::bad_request("template source exceeds the 1 MiB limit"),
        TemplateError::PublishedButNotDurable(error) => {
            tracing::error!(%error, "template publication was not durably synchronized");
            ApiError::internal(
                "template was saved but durability could not be confirmed; reload before retrying",
            )
        }
        TemplateError::Io(error) => {
            tracing::error!(%error, "template storage failed");
            ApiError::internal("template storage is unavailable")
        }
    };
    result.detail = Some(serde_json::json!({ "code": code }));
    result
}

#[utoipa::path(
    get, path = "/base-templates", context_path = "/api/vault", tag = "Bases",
    responses((status = 200, body = TemplateListResponse), (status = 500, body = ApiError))
)]
pub async fn list_templates(
    State(state): State<Arc<AppState>>,
) -> Result<Json<TemplateListResponse>, ApiError> {
    let root = state.vault.root().to_path_buf();
    let templates = tokio::task::spawn_blocking(move || template_document::list_templates(&root))
        .await
        .map_err(|_| ApiError::internal("template worker failed"))?
        .map_err(template_error)?;
    Ok(Json(TemplateListResponse { templates }))
}

#[utoipa::path(
    get, path = "/base-templates/{slug}", context_path = "/api/vault", tag = "Bases",
    params(("slug" = String, Path, description = "Direct-child template slug")),
    responses((status = 200, body = TemplateDocument), (status = 400, body = ApiError), (status = 404, body = ApiError), (status = 500, body = ApiError))
)]
pub async fn get_template(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<TemplateDocument>, ApiError> {
    let root = state.vault.root().to_path_buf();
    let document =
        tokio::task::spawn_blocking(move || template_document::read_template(&root, &slug))
            .await
            .map_err(|_| ApiError::internal("template worker failed"))?
            .map_err(template_error)?;
    Ok(Json(document))
}

#[utoipa::path(
    post, path = "/base-templates/{slug}", context_path = "/api/vault", tag = "Bases",
    params(("slug" = String, Path, description = "Direct-child template slug")),
    request_body = CreateTemplateRequest,
    responses((status = 201, body = TemplateDocument), (status = 400, body = ApiError), (status = 409, body = ApiError), (status = 500, body = ApiError))
)]
pub async fn create_template(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<CreateTemplateRequest>,
) -> Result<(StatusCode, Json<TemplateDocument>), ApiError> {
    let root = state.vault.root().to_path_buf();
    let document = tokio::task::spawn_blocking(move || {
        template_document::create_template(&root, &slug, &request.source)
    })
    .await
    .map_err(|_| ApiError::internal("template worker failed"))?
    .map_err(template_error)?;
    Ok((StatusCode::CREATED, Json(document)))
}

#[utoipa::path(
    put, path = "/base-templates/{slug}", context_path = "/api/vault", tag = "Bases",
    params(("slug" = String, Path, description = "Direct-child template slug")),
    request_body = UpdateTemplateRequest,
    responses((status = 200, body = TemplateDocument), (status = 400, body = ApiError), (status = 404, body = ApiError), (status = 409, body = ApiError), (status = 500, body = ApiError))
)]
pub async fn update_template(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<UpdateTemplateRequest>,
) -> Result<Json<TemplateDocument>, ApiError> {
    let root = state.vault.root().to_path_buf();
    let document = tokio::task::spawn_blocking(move || {
        template_document::update_template(
            &root,
            &slug,
            &request.source,
            &request.expected_revision,
        )
    })
    .await
    .map_err(|_| ApiError::internal("template worker failed"))?
    .map_err(template_error)?;
    Ok(Json(document))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_templates))
        .route(
            "/{slug}",
            get(get_template).post(create_template).put(update_template),
        )
        .layer(DefaultBodyLimit::max(TEMPLATE_REQUEST_BYTES))
}
