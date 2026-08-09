//! Base registry and view-evaluation endpoints.
//!
//! The registry is loaded from `bases/*.base.toml` per request — the files
//! are few and small, and this keeps the API in lockstep with the on-disk
//! truth without cache-invalidation machinery. The view endpoint is sugar
//! over the query engine: one evaluator, two entry points (see
//! `api::query` for the generic endpoint).

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::base::{
    BaseDefinition, BaseDiagnostic, BaseDiagnosticSeverity, BaseFile, BaseRegistry, Filter,
    SortDir, SortKey, ViewDefinition, validate_definition,
};
use crate::vault::base_document::ViewOrigin;
use crate::vault::base_document::{self, BaseDocumentError, StoredBase};
use crate::vault::base_member::{BaseMemberCapability, creation_capabilities};
use crate::vault::query::{QueryContext, QueryOutput, QuerySpec, evaluate};

/// One entry in the registry listing.
#[derive(Debug, Serialize, ToSchema)]
pub struct BaseSummary {
    pub slug: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub views: Vec<String>,
    pub diagnostic_count: usize,
    pub match_count: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseListResponse {
    pub bases: Vec<BaseSummary>,
    /// Diagnostics for files that failed to parse entirely (their slug never
    /// reaches the `bases` list).
    pub diagnostics: Vec<BaseDiagnostic>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseDetailResponse {
    #[serde(flatten)]
    pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
    pub member_creation: Vec<BaseMemberCapability>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateBaseRequest {
    pub slug: String,
    pub definition: BaseFile,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateBaseRequest {
    pub expected_revision: String,
    pub definition: BaseFile,
    pub view_origins: Vec<ViewOrigin>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteBaseRequest {
    pub expected_revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseMutationResponse {
    #[serde(flatten)]
    pub definition: BaseDefinition,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
}

impl From<StoredBase> for BaseMutationResponse {
    fn from(stored: StoredBase) -> Self {
        Self {
            definition: stored.definition,
            diagnostics: stored.diagnostics,
            revision: stored.revision,
        }
    }
}

/// Ephemeral per-request view overrides.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ViewParams {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// Override the view's sort with a single field for this request.
    pub sort: Option<String>,
    /// Direction for the `sort` override: `asc` (default) or `desc`.
    pub dir: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BasePreviewRequest {
    pub definition: BaseFile,
    pub view: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BasePreviewResponse {
    pub diagnostics: Vec<BaseDiagnostic>,
    pub output: Option<QueryOutput>,
    pub evaluation_error: Option<String>,
}

fn query_spec(
    base: &BaseDefinition,
    view: Option<&ViewDefinition>,
    limit: Option<u32>,
    offset: u32,
    sort_override: Option<&str>,
    sort_dir: Option<&str>,
) -> QuerySpec {
    let view_filter = view.and_then(|view| view.filter.clone());
    let filter = match (base.file.filter.clone(), view_filter) {
        (Some(membership), Some(view)) => Some(Filter::All(vec![membership, view])),
        (membership, view) => membership.or(view),
    };
    let sort = match sort_override {
        Some(field) => vec![SortKey {
            field: field.to_owned(),
            dir: match sort_dir {
                Some("desc") => SortDir::Desc,
                _ => SortDir::Asc,
            },
        }],
        None => view.map_or_else(Vec::new, |view| view.sort.clone()),
    };

    QuerySpec {
        filter,
        sort,
        group_by: view.and_then(|view| view.group_by.clone()),
        aggregates: view.map_or_else(Vec::new, |view| view.aggregates.clone()),
        columns: view.map_or_else(Vec::new, |view| view.columns.clone()),
        limit,
        offset,
        group_row_limit: None,
    }
}

/// List every base with its views and diagnostic count.
#[utoipa::path(
    get,
    path = "",
    context_path = "/api/vault/bases",
    tag = "Bases",
    responses((status = 200, body = BaseListResponse))
)]
pub async fn list_bases(State(state): State<Arc<AppState>>) -> Json<BaseListResponse> {
    let registry = BaseRegistry::load(state.vault.root());
    let count_bases = registry.bases.clone();
    let base_count = count_bases.len();
    let match_counts = state
        .index
        .with_index(move |index, _vault| {
            count_bases
                .iter()
                .map(|base| {
                    let spec = query_spec(base, None, Some(0), 0, None, None);
                    match evaluate(index.connection(), &spec, &QueryContext::for_base(base)) {
                        Ok(QueryOutput::Flat { total, .. }) => u32::try_from(total).ok(),
                        Ok(QueryOutput::Grouped { .. }) | Err(_) => None,
                    }
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_else(|_| vec![None; base_count]);
    let bases = registry
        .bases
        .iter()
        .zip(match_counts)
        .map(|(base, match_count)| BaseSummary {
            slug: base.slug.clone(),
            name: base.file.name.clone(),
            description: base.file.description.clone(),
            views: base.file.views.iter().map(|v| v.name.clone()).collect(),
            diagnostic_count: registry
                .diagnostics
                .iter()
                .filter(|d| d.slug == base.slug)
                .count(),
            match_count,
        })
        .collect();
    let orphan_diagnostics = registry
        .diagnostics
        .iter()
        .filter(|d| registry.get(&d.slug).is_none())
        .cloned()
        .collect();
    Json(BaseListResponse {
        bases,
        diagnostics: orphan_diagnostics,
    })
}

/// Full parsed definition plus diagnostics for one base.
#[utoipa::path(
    get,
    path = "/{slug}",
    context_path = "/api/vault/bases",
    tag = "Bases",
    responses(
        (status = 200, body = BaseDetailResponse),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn get_base(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<BaseDetailResponse>, ApiError> {
    let stored = base_document::load(state.vault.root(), &slug).map_err(document_error)?;
    let member_creation = creation_capabilities(&stored.definition);
    Ok(Json(BaseDetailResponse {
        definition: stored.definition,
        diagnostics: stored.diagnostics,
        revision: stored.revision,
        member_creation,
    }))
}

#[utoipa::path(
    post,
    path = "",
    context_path = "/api/vault/bases",
    tag = "Bases",
    request_body = CreateBaseRequest,
    responses(
        (status = 200, body = BaseMutationResponse),
        (status = 400, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn create_base(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateBaseRequest>,
) -> Result<Json<BaseMutationResponse>, ApiError> {
    let stored = base_document::create(state.vault.root(), &request.slug, &request.definition)
        .map_err(document_error)?;
    let _ = state.change_tx.send(SyncNotification::BaseRegistryChanged);
    Ok(Json(stored.into()))
}

#[utoipa::path(
    put,
    path = "/{slug}",
    context_path = "/api/vault/bases",
    tag = "Bases",
    params(("slug" = String, Path, description = "Base slug (filename stem)")),
    request_body = UpdateBaseRequest,
    responses(
        (status = 200, body = BaseMutationResponse),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn update_base(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<UpdateBaseRequest>,
) -> Result<Json<BaseMutationResponse>, ApiError> {
    let stored = base_document::update(
        state.vault.root(),
        &slug,
        &request.expected_revision,
        &request.definition,
        &request.view_origins,
    )
    .map_err(document_error)?;
    let _ = state.change_tx.send(SyncNotification::BaseRegistryChanged);
    Ok(Json(stored.into()))
}

#[utoipa::path(
    delete,
    path = "/{slug}",
    context_path = "/api/vault/bases",
    tag = "Bases",
    params(("slug" = String, Path, description = "Base slug (filename stem)")),
    request_body = DeleteBaseRequest,
    responses(
        (status = 200, description = "Base definition deleted"),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn delete_base(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(request): Json<DeleteBaseRequest>,
) -> Result<StatusCode, ApiError> {
    base_document::delete(state.vault.root(), &slug, &request.expected_revision)
        .map_err(document_error)?;
    let _ = state.change_tx.send(SyncNotification::BaseRegistryChanged);
    Ok(StatusCode::OK)
}

pub(super) fn document_error(error: BaseDocumentError) -> ApiError {
    match error {
        BaseDocumentError::InvalidSlug(message) => ApiError::bad_request(message),
        BaseDocumentError::NotFound(message) => ApiError::not_found(message),
        BaseDocumentError::AlreadyExists(message) => ApiError::conflict(message),
        BaseDocumentError::Conflict { current_revision } => ApiError::conflict_with_detail(
            "base definition changed since expected_revision",
            serde_json::json!({ "revision": current_revision }),
        ),
        BaseDocumentError::InvalidDefinition(diagnostics) => ApiError::bad_request_with_detail(
            "base definition is invalid",
            serde_json::json!({ "diagnostics": diagnostics }),
        ),
        BaseDocumentError::UnsupportedDocument(message) => ApiError::conflict(message),
        BaseDocumentError::PublishedButNotDurable(error) => ApiError::internal(format!(
            "base definition was published but not durably synchronized: {error}"
        )),
        BaseDocumentError::Io(error) => ApiError::internal(error.to_string()),
    }
}

/// Evaluate an unsaved definition without mutating vault files or the index.
#[utoipa::path(
    post,
    path = "/preview",
    context_path = "/api/vault/bases",
    tag = "Bases",
    request_body = BasePreviewRequest,
    responses((status = 200, body = BasePreviewResponse))
)]
pub async fn preview_base(
    State(state): State<Arc<AppState>>,
    Json(request): Json<BasePreviewRequest>,
) -> Json<BasePreviewResponse> {
    let validation = validate_definition("__preview__", request.definition);
    let diagnostics = validation.diagnostics;
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == BaseDiagnosticSeverity::Error)
    {
        return Json(BasePreviewResponse {
            diagnostics,
            output: None,
            evaluation_error: None,
        });
    }

    let base = validation.definition;
    let selected_view = match request.view {
        Some(view_name) => match base.view(&view_name).cloned() {
            Some(view) => Some(view),
            None => {
                return Json(BasePreviewResponse {
                    diagnostics,
                    output: None,
                    evaluation_error: Some(format!("base preview has no view named `{view_name}`")),
                });
            }
        },
        None => None,
    };
    let limit = Some(request.limit.unwrap_or(100).min(100));
    let spec = query_spec(
        &base,
        selected_view.as_ref(),
        limit,
        request.offset.unwrap_or(0),
        None,
        None,
    );
    let evaluation = state
        .index
        .with_index(move |index, _vault| {
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base))
        })
        .await;
    let (output, evaluation_error) = match evaluation {
        Ok(Ok(output)) => (Some(output), None),
        Ok(Err(error)) => (None, Some(format!("query error: {error}"))),
        Err(error) => (None, Some(format!("index error: {error}"))),
    };

    Json(BasePreviewResponse {
        diagnostics,
        output,
        evaluation_error,
    })
}

/// Evaluate a saved view, honoring its filter, sort, grouping, and
/// aggregates, with per-request pagination and sort overrides.
#[utoipa::path(
    get,
    path = "/{slug}/views/{view}",
    context_path = "/api/vault/bases",
    tag = "Bases",
    params(
        ("slug" = String, Path, description = "Base slug"),
        ("view" = String, Path, description = "View name"),
        ("limit" = Option<u32>, Query, description = "Flat row limit"),
        ("offset" = Option<u32>, Query, description = "Flat row offset"),
        ("sort" = Option<String>, Query, description = "Sort-field override"),
        ("dir" = Option<String>, Query, description = "asc | desc for the sort override")
    ),
    responses(
        (status = 200, body = QueryOutput),
        (status = 404, description = "Unknown base or view")
    )
)]
pub async fn evaluate_view(
    State(state): State<Arc<AppState>>,
    Path((slug, view_name)): Path<(String, String)>,
    Query(params): Query<ViewParams>,
) -> Result<Json<QueryOutput>, ApiError> {
    let registry = BaseRegistry::load(state.vault.root());
    let base = registry
        .get(&slug)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("no base with slug `{slug}`")))?;
    let view = base.view(&view_name).cloned().ok_or_else(|| {
        ApiError::not_found(format!("base `{slug}` has no view named `{view_name}`"))
    })?;

    let spec = query_spec(
        &base,
        Some(&view),
        params.limit,
        params.offset.unwrap_or(0),
        params.sort.as_deref(),
        params.dir.as_deref(),
    );

    let output = state
        .index
        .with_index(move |index, _vault| {
            let ctx = QueryContext::for_base(&base);
            evaluate(index.connection(), &spec, &ctx)
        })
        .await
        .map_err(|e| ApiError::internal(format!("index error: {e}")))?
        .map_err(|e| ApiError::bad_request(format!("query error: {e}")))?;
    Ok(Json(output))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_bases).post(create_base))
        .route("/preview", post(preview_base))
        .route(
            "/{slug}",
            get(get_base).put(update_base).delete(delete_base),
        )
        .route("/{slug}/views/{view}", get(evaluate_view))
        .route(
            "/{slug}/members",
            post(super::base_members::create_base_member),
        )
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::document_error;
    use crate::vault::base_document::BaseDocumentError;

    #[test]
    fn published_but_not_durable_maps_to_distinct_internal_error() {
        let error = document_error(BaseDocumentError::PublishedButNotDurable(io::Error::other(
            "directory sync failed",
        )));

        assert_eq!(error.status, 500);
        assert_eq!(
            error.error,
            "base definition was published but not durably synchronized: directory sync failed"
        );
        assert_eq!(error.detail, None);
        assert_eq!(error.hint, None);
    }
}
