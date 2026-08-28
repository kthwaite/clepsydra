//! Base registry and view-evaluation endpoints.
//!
//! The registry is loaded from `bases/*.base.toml` per request — the files
//! are few and small, and this keeps the API in lockstep with the on-disk
//! truth without cache-invalidation machinery. The view endpoint is sugar
//! over the query engine: one evaluator, two entry points (see
//! `api::query` for the generic endpoint).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use super::query::redact_conversation_columns;
use crate::api::events::SyncNotification;
use crate::vault::base::{
    BaseDefinition, BaseDiagnostic, BaseDiagnosticSeverity, BaseFile, BaseRegistry, Filter,
    PreviewFieldDefinition, PropertyDefinition, SortDir, SortKey, ViewDefinition,
    validate_definition,
};
use crate::vault::base_document::ViewOrigin;
use crate::vault::base_document::{self, BaseDocumentError, StoredBase};
use crate::vault::base_embed::{
    EmbedOverrides, EmbedValidationDiagnostic, composed_query_spec, validate_embed_overrides,
    validate_embed_window,
};
use crate::vault::base_member::{
    BaseMemberCapability, BaseMemberDiagnostic, BaseMemberScope, composed_member_capability,
    creation_capabilities,
};
use crate::vault::query::{GroupRowLimit, QueryContext, QueryOutput, QuerySpec, evaluate};

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

/// One declared Base property in canonical file order.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BasePropertyEntry {
    pub key: String,
    pub definition: PropertyDefinition,
}

/// API representation of a Base file. Property order is explicit on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BaseFilePayload {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preview: Vec<PreviewFieldDefinition>,
    #[serde(default)]
    pub properties: Vec<BasePropertyEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<ViewDefinition>,
}

impl From<BaseFile> for BaseFilePayload {
    fn from(file: BaseFile) -> Self {
        Self {
            name: file.name,
            description: file.description,
            title_template: file.title_template,
            filter: file.filter,
            preview: file.preview,
            properties: file
                .properties
                .into_iter()
                .map(|(key, definition)| BasePropertyEntry { key, definition })
                .collect(),
            views: file.views,
        }
    }
}

impl From<BaseFilePayload> for BaseFile {
    fn from(payload: BaseFilePayload) -> Self {
        Self {
            name: payload.name,
            description: payload.description,
            title_template: payload.title_template,
            filter: payload.filter,
            preview: payload.preview,
            properties: payload
                .properties
                .into_iter()
                .map(|entry| (entry.key, entry.definition))
                .collect(),
            views: payload.views,
        }
    }
}

/// Parsed Base definition represented through the ordered API payload.
#[derive(Debug, Serialize, ToSchema)]
pub struct BaseDefinitionPayload {
    pub slug: String,
    #[serde(flatten)]
    pub file: BaseFilePayload,
}

impl From<BaseDefinition> for BaseDefinitionPayload {
    fn from(definition: BaseDefinition) -> Self {
        Self {
            slug: definition.slug,
            file: definition.file.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseDetailResponse {
    #[serde(flatten)]
    pub definition: BaseDefinitionPayload,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
    pub member_creation: Vec<BaseMemberCapability>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateBaseRequest {
    pub slug: String,
    pub definition: BaseFilePayload,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateBaseRequest {
    pub expected_revision: String,
    pub definition: BaseFilePayload,
    pub view_origins: Vec<ViewOrigin>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteBaseRequest {
    pub expected_revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseMutationResponse {
    #[serde(flatten)]
    pub definition: BaseDefinitionPayload,
    pub diagnostics: Vec<BaseDiagnostic>,
    pub revision: String,
}

impl From<StoredBase> for BaseMutationResponse {
    fn from(stored: StoredBase) -> Self {
        Self {
            definition: stored.definition.into(),
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
    pub definition: BaseFilePayload,
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

#[derive(Debug, Deserialize, ToSchema)]
pub struct BaseViewEvaluateRequest {
    pub filter: Option<Filter>,
    #[schema(max_items = 8)]
    pub sort: Option<Vec<SortKey>>,
    #[schema(minimum = 1, maximum = 200)]
    pub limit: Option<u32>,
    /// Rows to skip before the window. Flat views only.
    #[schema(minimum = 0)]
    pub offset: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseViewEvaluateResponse {
    pub output: QueryOutput,
    pub revision: String,
    pub member_creation: BaseMemberCapability,
}

struct PreparedEmbeddedEvaluation {
    base: BaseDefinition,
    spec: QuerySpec,
    revision: String,
    member_creation: BaseMemberCapability,
}

fn prepare_embedded_evaluation<L>(
    root: &std::path::Path,
    slug: &str,
    view_name: &str,
    request: BaseViewEvaluateRequest,
    today: chrono::NaiveDate,
    load: L,
) -> Result<PreparedEmbeddedEvaluation, ApiError>
where
    L: FnOnce(&std::path::Path, &str) -> Result<StoredBase, BaseDocumentError>,
{
    let stored = load(root, slug).map_err(embedded_document_error)?;
    let view = stored.definition.view(view_name).cloned().ok_or_else(|| {
        ApiError::not_found(format!("base `{slug}` has no view named `{view_name}`"))
    })?;
    validate_embed_overrides(
        &stored.definition,
        EmbedOverrides {
            filter: request.filter.as_ref(),
            sort: request.sort.as_deref(),
            limit: request.limit,
        },
    )
    .map_err(invalid_embed_query)?;
    let offset = request.offset.unwrap_or(0);
    validate_embed_window(&view, offset).map_err(invalid_embed_query)?;

    let member_creation =
        composed_member_capability(&stored.definition, &view, request.filter.as_ref(), today);
    let mut spec = composed_query_spec(
        &stored.definition,
        &view,
        request.filter,
        request.sort,
        request.limit,
    );
    spec.offset = offset;

    Ok(PreparedEmbeddedEvaluation {
        base: stored.definition,
        spec,
        revision: stored.revision,
        member_creation,
    })
}

async fn evaluate_embedded_view_with<L, E, F>(
    root: &std::path::Path,
    slug: &str,
    view_name: &str,
    request: BaseViewEvaluateRequest,
    today: chrono::NaiveDate,
    load: L,
    evaluate_prepared: E,
) -> Result<BaseViewEvaluateResponse, ApiError>
where
    L: FnOnce(&std::path::Path, &str) -> Result<StoredBase, BaseDocumentError> + Send,
    E: FnOnce(BaseDefinition, QuerySpec) -> F + Send,
    F: std::future::Future<Output = Result<QueryOutput, ApiError>> + Send,
{
    let PreparedEmbeddedEvaluation {
        base,
        spec,
        revision,
        member_creation,
    } = prepare_embedded_evaluation(root, slug, view_name, request, today, load)?;
    let output = evaluate_prepared(base, spec).await?;
    Ok(BaseViewEvaluateResponse {
        output,
        revision,
        member_creation,
    })
}

pub(super) fn invalid_embed_query(diagnostics: Vec<EmbedValidationDiagnostic>) -> ApiError {
    ApiError::invalid_embed_query(
        diagnostics
            .into_iter()
            .map(public_embed_diagnostic)
            .collect(),
    )
}

fn public_embed_diagnostic(diagnostic: EmbedValidationDiagnostic) -> BaseMemberDiagnostic {
    let filter_path = diagnostic.filter_path.map(|path| {
        path.strip_prefix("filter")
            .map_or(path.clone(), |suffix| format!("embed_filter{suffix}"))
    });
    BaseMemberDiagnostic {
        scope: BaseMemberScope::Embed,
        field: diagnostic.field,
        filter_path,
        message: diagnostic.message,
    }
}

fn embedded_document_error(error: BaseDocumentError) -> ApiError {
    match error {
        BaseDocumentError::InvalidSlug(_) => ApiError::bad_request("invalid base reference"),
        BaseDocumentError::NotFound(slug) => {
            ApiError::not_found(format!("no base with slug `{slug}`"))
        }
        error @ (BaseDocumentError::UnsupportedDocument(_)
        | BaseDocumentError::InvalidDefinition(_)) => {
            tracing::warn!(error = ?error, error_display = %error, "Base definition unavailable");
            ApiError::conflict("base definition is unavailable")
        }
        error @ (BaseDocumentError::Io(_)
        | BaseDocumentError::PublishedButNotDurable(_)
        | BaseDocumentError::AlreadyExists(_)
        | BaseDocumentError::Conflict { .. }) => internal_evaluation_error(error),
    }
}

fn internal_evaluation_error(error: impl std::fmt::Debug + std::fmt::Display) -> ApiError {
    tracing::error!(error = ?error, error_display = %error, "Base view evaluation failed");
    ApiError::internal("base evaluation failed")
}

fn query_spec(
    base: &BaseDefinition,
    view: Option<&ViewDefinition>,
    limit: Option<u32>,
    offset: u32,
    sort_override: Option<&str>,
    sort_dir: Option<&str>,
) -> QuerySpec {
    let sort = sort_override.map(|field| {
        vec![SortKey {
            field: field.to_owned(),
            dir: match sort_dir {
                Some("desc") => SortDir::Desc,
                _ => SortDir::Asc,
            },
        }]
    });

    match view {
        Some(view) => {
            let mut spec = composed_query_spec(base, view, None, sort, limit);
            spec.offset = offset;
            spec.group_row_limit = GroupRowLimit::Default;
            spec
        }
        None => QuerySpec {
            filter: base.file.filter.clone(),
            sort: sort.unwrap_or_default(),
            limit,
            offset,
            group_row_limit: GroupRowLimit::Default,
            ..Default::default()
        },
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
    let today = state.clock.now().date_naive();
    let match_counts = state
        .index
        .with_index(move |index, _vault| {
            count_bases
                .iter()
                .map(|base| {
                    let spec = query_spec(base, None, Some(0), 0, None, None);
                    match evaluate(
                        index.connection(),
                        &spec,
                        &QueryContext::for_base(base).with_today(today),
                    ) {
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
    let member_creation = creation_capabilities(&stored.definition, state.clock.now().date_naive());
    Ok(Json(BaseDetailResponse {
        definition: stored.definition.into(),
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
    let definition = request.definition.into();
    let stored = base_document::create(state.vault.root(), &request.slug, &definition)
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
    let definition = request.definition.into();
    let stored = base_document::update(
        state.vault.root(),
        &slug,
        &request.expected_revision,
        &definition,
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
    let validation = validate_definition("__preview__", request.definition.into());
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
    let today = state.clock.now().date_naive();
    let evaluation = state
        .index
        .with_index(move |index, _vault| {
            evaluate(
                index.connection(),
                &spec,
                &QueryContext::for_base(&base).with_today(today),
            )
        })
        .await;
    let (output, evaluation_error) = match evaluation {
        Ok(Ok(mut output)) => {
            redact_conversation_columns(&mut output);
            (Some(output), None)
        }
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

    let today = state.clock.now().date_naive();
    let mut output = state
        .index
        .with_index(move |index, _vault| {
            let ctx = QueryContext::for_base(&base).with_today(today);
            evaluate(index.connection(), &spec, &ctx)
        })
        .await
        .map_err(|e| ApiError::internal(format!("index error: {e}")))?
        .map_err(|e| ApiError::bad_request(format!("query error: {e}")))?;
    redact_conversation_columns(&mut output);
    Ok(Json(output))
}

/// Evaluate a saved view with request-owned embed overrides.
#[utoipa::path(
    post,
    path = "/{slug}/views/{view}/evaluate",
    context_path = "/api/vault/bases",
    tag = "Bases",
    params(
        ("slug" = String, Path, description = "Base slug"),
        ("view" = String, Path, description = "Saved view name")
    ),
    request_body = BaseViewEvaluateRequest,
    responses(
        (status = 200, body = BaseViewEvaluateResponse),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
        (status = 500, body = ApiError)
    )
)]
pub async fn evaluate_embedded_view(
    State(state): State<Arc<AppState>>,
    Path((slug, view_name)): Path<(String, String)>,
    payload: Result<Bytes, BytesRejection>,
) -> Result<Json<BaseViewEvaluateResponse>, ApiError> {
    let bytes = payload.map_err(|_| ApiError::invalid_embed_query(Vec::new()))?;
    let request =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid_embed_query(Vec::new()))?;
    let index = state.index.clone();
    let today = state.clock.now().date_naive();
    let response = evaluate_embedded_view_with(
        state.vault.root(),
        &slug,
        &view_name,
        request,
        today,
        base_document::load,
        move |base, spec| async move {
            index
                .with_index(move |index, _vault| {
                    evaluate(
                        index.connection(),
                        &spec,
                        &QueryContext::for_base(&base).with_today(today),
                    )
                })
                .await
                .map_err(internal_evaluation_error)?
                .map_err(internal_evaluation_error)
        },
    )
    .await?;

    Ok(Json(response))
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
            "/{slug}/views/{view}/evaluate",
            post(evaluate_embedded_view).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/{slug}/members",
            post(super::base_members::create_base_member),
        )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{BaseViewEvaluateRequest, document_error, evaluate_embedded_view_with};
    use crate::vault::base::{BaseDefinition, BaseFile, Filter, Op, ViewDefinition};
    use crate::vault::base_document::{BaseDocumentError, StoredBase};
    use crate::vault::query::{QueryOutput, QueryRow};

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

    #[tokio::test]
    async fn evaluate_embedded_full_response_uses_one_injected_snapshot() {
        let ambient = tempfile::tempdir().unwrap();
        fs::create_dir_all(ambient.path().join("bases")).unwrap();
        fs::write(
            ambient.path().join("bases/embedded.base.toml"),
            "name = \"Ambient disk Base\"\n[[views]]\nname = \"Ambient View\"\nlayout = \"table\"\n",
        )
        .unwrap();
        let load_calls = Arc::new(AtomicUsize::new(0));
        let evaluation_calls = Arc::new(AtomicUsize::new(0));
        let snapshot = StoredBase {
            definition: BaseDefinition {
                slug: "injected".to_string(),
                file: BaseFile {
                    name: "Injected Snapshot".to_string(),
                    description: None,
                    title_template: None,
                    filter: None,
                    properties: Vec::new(),
                    preview: Vec::new(),
                    views: vec![ViewDefinition {
                        name: "Configured View".to_string(),
                        labels: Default::default(),
                        layout: "table".to_string(),
                        filter: None,
                        sort: Vec::new(),
                        group_by: None,
                        aggregates: Vec::new(),
                        columns: vec!["title".to_string()],
                    }],
                },
            },
            diagnostics: Vec::new(),
            revision: "injected-revision".to_string(),
        };
        let request = BaseViewEvaluateRequest {
            filter: Some(Filter::Cmp {
                field: "title".to_string(),
                op: Op::Eq,
                value: serde_json::json!("Injected Snapshot"),
            }),
            sort: None,
            limit: Some(1),
            offset: None,
        };
        let counted_loads = Arc::clone(&load_calls);
        let counted_evaluations = Arc::clone(&evaluation_calls);

        let response = evaluate_embedded_view_with(
            ambient.path(),
            "embedded",
            "CONFIGURED VIEW",
            request,
            chrono::Utc::now().date_naive(),
            move |_, _| {
                counted_loads.fetch_add(1, Ordering::SeqCst);
                Ok(snapshot)
            },
            move |base, spec| async move {
                counted_evaluations.fetch_add(1, Ordering::SeqCst);
                assert_eq!(base.slug, "injected");
                assert_eq!(base.file.name, "Injected Snapshot");
                assert_eq!(spec.columns, vec!["title"]);
                assert_eq!(spec.limit, Some(1));
                Ok(QueryOutput::Flat {
                    rows: vec![QueryRow {
                        id: base.slug.clone(),
                        path: format!("{}.md", base.slug),
                        title: Some(base.file.name.clone()),
                        kind: "NOTE".to_string(),
                        project: None,
                        columns: serde_json::Map::new(),
                    }],
                    total: 1,
                    aggregates: Vec::new(),
                })
            },
        )
        .await
        .unwrap();
        let serialized = serde_json::to_value(response).unwrap();

        assert_eq!(load_calls.load(Ordering::SeqCst), 1);
        assert_eq!(evaluation_calls.load(Ordering::SeqCst), 1);
        assert_eq!(serialized["output"]["rows"][0]["id"], "injected");
        assert_eq!(
            serialized["output"]["rows"][0]["title"],
            "Injected Snapshot"
        );
        assert_eq!(serialized["revision"], "injected-revision");
        assert_eq!(serialized["member_creation"]["view"], "Configured View");
        assert_eq!(serialized["member_creation"]["fields"][0]["field"], "title");
        assert_eq!(serialized["member_creation"]["fields"][0]["embed"], true);
    }
}
