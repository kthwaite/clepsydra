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
use axum::routing::get;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::base::{BaseDefinition, BaseDiagnostic, BaseRegistry, Filter, SortDir, SortKey};
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
    let bases = registry
        .bases
        .iter()
        .map(|base| BaseSummary {
            slug: base.slug.clone(),
            name: base.file.name.clone(),
            description: base.file.description.clone(),
            views: base.file.views.iter().map(|v| v.name.clone()).collect(),
            diagnostic_count: registry
                .diagnostics
                .iter()
                .filter(|d| d.slug == base.slug)
                .count(),
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
    params(("slug" = String, Path, description = "Base slug (filename stem)")),
    responses(
        (status = 200, body = BaseDetailResponse),
        (status = 404, description = "Unknown base")
    )
)]
pub async fn get_base(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Json<BaseDetailResponse>, ApiError> {
    let registry = BaseRegistry::load(state.vault.root());
    let base = registry
        .get(&slug)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("no base with slug `{slug}`")))?;
    let diagnostics = registry
        .diagnostics
        .iter()
        .filter(|d| d.slug == slug)
        .cloned()
        .collect();
    Ok(Json(BaseDetailResponse {
        definition: base,
        diagnostics,
    }))
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
    let view = base
        .file
        .views
        .iter()
        .find(|v| v.name.eq_ignore_ascii_case(&view_name))
        .cloned()
        .ok_or_else(|| {
            ApiError::not_found(format!("base `{slug}` has no view named `{view_name}`"))
        })?;

    // Membership filter AND view filter.
    let filter = match (base.file.filter.clone(), view.filter.clone()) {
        (Some(a), Some(b)) => Some(Filter::All(vec![a, b])),
        (a, b) => a.or(b),
    };
    let sort = match &params.sort {
        Some(field) => vec![SortKey {
            field: field.clone(),
            dir: match params.dir.as_deref() {
                Some("desc") => SortDir::Desc,
                _ => SortDir::Asc,
            },
        }],
        None => view.sort.clone(),
    };

    let spec = QuerySpec {
        filter,
        sort,
        group_by: view.group_by.clone(),
        aggregates: view.aggregates.clone(),
        columns: view.columns.clone(),
        limit: params.limit,
        offset: params.offset.unwrap_or(0),
        group_row_limit: None,
    };

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
        .route("/", get(list_bases))
        .route("/{slug}", get(get_base))
        .route("/{slug}/views/{view}", get(evaluate_view))
}
