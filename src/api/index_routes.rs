use std::fmt;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rusqlite::params;
use serde::de::{Error as _, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::{ApiError, parse_internal_path};
use super::pages::page_detail;
use super::pagination::PaginatedResponse;
use crate::api::events::SyncNotification;
use crate::vault::index::UnresolvedReason;
use crate::vault::mutation::{MutationOp, MutationPlan, MutationPlanner, RewriteMode};
use crate::vault::mutation_coordinator::{CreatePageCommand, MutationNotification};
use crate::vault::kind::Kind;
use crate::vault::page::{Page, PageMeta};
use crate::vault::path::VaultPath;
use crate::vault::reference_issues::{
    ReferenceCandidate as VaultReferenceCandidate, ReferenceIssue as VaultReferenceIssue,
    ReferenceIssueAction as VaultReferenceIssueAction,
    ReferenceIssueFilter as VaultReferenceIssueFilter,
    ReferenceIssueKind as VaultReferenceIssueKind,
};
use crate::vault::reference_repair::{
    ReferenceRepairAction as VaultReferenceRepairAction,
    ReferenceRepairError as VaultReferenceRepairError,
    ReferenceRepairRequest as VaultReferenceRepairRequest, prepare_reference_repair,
};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct RebuildResponse {
    pages_indexed: usize,
    pages_skipped: usize,
    pages_removed: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OutlinkEntry {
    target_raw: String,
    target_path: Option<String>,
    target_id: Option<String>,
    kind: String,
    source_field: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UnresolvedLink {
    source_id: String,
    source_path: String,
    target_raw: String,
    target_canonical: Option<String>,
    kind: String,
    span_start: i64,
    reason: String,
    candidates: Vec<CandidateEntry>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CandidateEntry {
    page_id: String,
    path: String,
    title: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BacklinkEntry {
    source_id: String,
    source_path: String,
    source_title: Option<String>,
    target_raw: String,
    kind: String,
    context: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateFromLinkRequest {
    target_raw: String,
    #[serde(default)]
    folder: String,
    body: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AmbiguousName {
    canonical_name: String,
    page_ids: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TagCount {
    tag: String,
    count: i64,
    computed_count: i64,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TagQuery {
    /// Case-insensitive substring used to filter tag suggestions.
    pub q: Option<String>,
    /// Maximum suggestions to return when `q` is present (default 12, max 50).
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VaultStats {
    pages: i64,
    links_total: i64,
    links_resolved: i64,
    links_unresolved: i64,
    /// Pages with zero inbound (resolved) links — the canonical "orphan".
    orphan_pages: i64,
    /// Pages with no resolved links inbound or outbound.
    isolated_pages: i64,
    tags: i64,
    attachments: i64,
    /// RFC3339 timestamp of the most recent `pages.updated_at`, or null on empty vault.
    last_indexed_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GraphResponse {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GraphNode {
    id: String,
    path: String,
    title: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GraphEdge {
    source: String,
    target: String,
    kind: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentIndexResponse {
    pub items: Vec<ContentEntry>,
    pub total: u32,
    pub limit: Option<u32>,
    pub offset: u32,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PreviewMutationRequest {
    operation: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    destination: String,
    #[serde(default = "default_rewrite_mode")]
    rewrite: String,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SearchResultEntry {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
    pub snippet: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SimilarEntry {
    pub path: String,
    pub title: Option<String>,
    pub shared_tags: Vec<String>,
    pub score: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SimilarResponse {
    pub items: Vec<SimilarEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
#[schema(rename_all = "snake_case")]
pub enum ReferenceIssueKindDto {
    UnresolvedPageLink,
    AmbiguousPageLink,
    BrokenBlockRef,
    InvalidRelationTarget,
    OrphanPage,
    IsolatedPage,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
#[schema(rename_all = "snake_case")]
pub enum ReferenceIssueActionDto {
    Create,
    Replace,
    OpenSource,
    None,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReferenceCandidateDto {
    pub page_id: String,
    pub path: String,
    pub title: Option<String>,
    pub rationale: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReferenceIssueDto {
    pub fingerprint: String,
    pub kind: ReferenceIssueKindDto,
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    pub source_revision: String,
    pub span_start: Option<i64>,
    pub span_end: Option<i64>,
    pub source_field: Option<String>,
    pub snippet: Option<String>,
    pub target_raw: Option<String>,
    pub candidates: Vec<ReferenceCandidateDto>,
    pub actions: Vec<ReferenceIssueActionDto>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReferenceIssuesResponse {
    pub items: Vec<ReferenceIssueDto>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReferenceRepairActionDto {
    Create { folder: String, body: Option<String> },
    Replace { candidate_page_id: String },
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ReferenceRepairRequest {
    pub fingerprint: String,
    pub source_revision: String,
    pub action: ReferenceRepairActionDto,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReferenceRepairPreviewResponse {
    pub fingerprint: String,
    pub before: String,
    pub after: String,
    pub plan: MutationPlan,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReferenceRepairApplyResponse {
    pub fingerprint: String,
    pub notification: MutationNotification,
}

impl From<ReferenceRepairRequest> for VaultReferenceRepairRequest {
    fn from(value: ReferenceRepairRequest) -> Self {
        let action = match value.action {
            ReferenceRepairActionDto::Create { folder, body } => {
                VaultReferenceRepairAction::Create { folder, body }
            }
            ReferenceRepairActionDto::Replace { candidate_page_id } => {
                VaultReferenceRepairAction::Replace { candidate_page_id }
            }
        };
        Self {
            fingerprint: value.fingerprint,
            source_revision: value.source_revision,
            action,
        }
    }
}

#[derive(Debug, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ReferenceIssuesParams {
    /// Issue kinds. The parameter may be repeated and each value may be comma-separated.
    pub kind: Option<Vec<ReferenceIssueKindDto>>,
    pub project: Option<String>,
    pub page_kind: Option<Kind>,
    pub actionable: Option<bool>,
    /// Page size. Defaults to 50.
    #[param(minimum = 1, maximum = 200)]
    pub limit: Option<u32>,
    /// Zero-based result offset. Defaults to 0.
    pub offset: Option<u32>,
}

#[derive(Debug, Default)]
pub struct ReferenceIssuesQuery {
    kind: Vec<String>,
    project: Vec<String>,
    page_kind: Vec<String>,
    actionable: Vec<String>,
    limit: Vec<String>,
    offset: Vec<String>,
}

impl<'de> Deserialize<'de> for ReferenceIssuesQuery {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ReferenceIssuesQueryVisitor;

        impl<'de> Visitor<'de> for ReferenceIssuesQueryVisitor {
            type Value = ReferenceIssuesQuery;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("reference issue query parameters")
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut query = ReferenceIssuesQuery::default();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    match key.as_str() {
                        "kind" => query.kind.push(value),
                        "project" => query.project.push(value),
                        "page_kind" => query.page_kind.push(value),
                        "actionable" => query.actionable.push(value),
                        "limit" => query.limit.push(value),
                        "offset" => query.offset.push(value),
                        _ => {
                            return Err(M::Error::custom(format!(
                                "unknown query parameter '{key}'"
                            )));
                        }
                    }
                }
                Ok(query)
            }
        }

        deserializer.deserialize_map(ReferenceIssuesQueryVisitor)
    }
}

impl ReferenceIssuesQuery {
    fn into_filter(self) -> Result<VaultReferenceIssueFilter, ApiError> {
        let mut kinds = Vec::new();
        for value in self.kind {
            for token in value.split(',') {
                let token = token.trim();
                let kind = match token {
                    "unresolved_page_link" => VaultReferenceIssueKind::UnresolvedPageLink,
                    "ambiguous_page_link" => VaultReferenceIssueKind::AmbiguousPageLink,
                    "broken_block_ref" => VaultReferenceIssueKind::BrokenBlockRef,
                    "invalid_relation_target" => VaultReferenceIssueKind::InvalidRelationTarget,
                    "orphan_page" => VaultReferenceIssueKind::OrphanPage,
                    "isolated_page" => VaultReferenceIssueKind::IsolatedPage,
                    _ => {
                        return Err(ApiError::bad_request("invalid reference issue kind"));
                    }
                };
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
        }

        let project = take_single_query_value(self.project, "project")?
            .map(|value| {
                let value = value.trim();
                if value.is_empty() {
                    Err(ApiError::bad_request("project must not be empty"))
                } else {
                    Ok(value.to_owned())
                }
            })
            .transpose()?;
        let page_kind = take_single_query_value(self.page_kind, "page_kind")?
            .map(|value| {
                Kind::from_token(&value)
                    .ok_or_else(|| ApiError::bad_request("invalid page_kind"))
            })
            .transpose()?;
        let actionable = take_single_query_value(self.actionable, "actionable")?
            .map(|value| match value.as_str() {
                "true" => Ok(true),
                "false" => Ok(false),
                _ => Err(ApiError::bad_request("invalid actionable value")),
            })
            .transpose()?;
        let limit = parse_u32_query_value(self.limit, "limit", 50)?;
        if !(1..=200).contains(&limit) {
            return Err(ApiError::bad_request("limit must be between 1 and 200"));
        }
        let offset = parse_u32_query_value(self.offset, "offset", 0)?;

        Ok(VaultReferenceIssueFilter {
            kinds,
            project,
            page_kind,
            actionable,
            limit,
            offset,
        })
    }
}

fn take_single_query_value(
    mut values: Vec<String>,
    name: &'static str,
) -> Result<Option<String>, ApiError> {
    if values.len() > 1 {
        return Err(ApiError::bad_request(format!(
            "'{name}' may be specified only once"
        )));
    }
    Ok(values.pop())
}

fn parse_u32_query_value(
    values: Vec<String>,
    name: &'static str,
    default: u32,
) -> Result<u32, ApiError> {
    take_single_query_value(values, name)?
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| ApiError::bad_request(format!("invalid {name}")))
        })
        .transpose()
        .map(|value| value.unwrap_or(default))
}

impl From<VaultReferenceIssueKind> for ReferenceIssueKindDto {
    fn from(value: VaultReferenceIssueKind) -> Self {
        match value {
            VaultReferenceIssueKind::UnresolvedPageLink => Self::UnresolvedPageLink,
            VaultReferenceIssueKind::AmbiguousPageLink => Self::AmbiguousPageLink,
            VaultReferenceIssueKind::BrokenBlockRef => Self::BrokenBlockRef,
            VaultReferenceIssueKind::InvalidRelationTarget => Self::InvalidRelationTarget,
            VaultReferenceIssueKind::OrphanPage => Self::OrphanPage,
            VaultReferenceIssueKind::IsolatedPage => Self::IsolatedPage,
        }
    }
}

impl From<VaultReferenceIssueAction> for ReferenceIssueActionDto {
    fn from(value: VaultReferenceIssueAction) -> Self {
        match value {
            VaultReferenceIssueAction::Create => Self::Create,
            VaultReferenceIssueAction::Replace => Self::Replace,
            VaultReferenceIssueAction::OpenSource => Self::OpenSource,
            VaultReferenceIssueAction::None => Self::None,
        }
    }
}

impl From<VaultReferenceCandidate> for ReferenceCandidateDto {
    fn from(value: VaultReferenceCandidate) -> Self {
        Self {
            page_id: value.page_id,
            path: value.path,
            title: value.title,
            rationale: value.rationale,
        }
    }
}

impl From<VaultReferenceIssue> for ReferenceIssueDto {
    fn from(value: VaultReferenceIssue) -> Self {
        Self {
            fingerprint: value.fingerprint,
            kind: value.kind.into(),
            source_id: value.source_id,
            source_path: value.source_path,
            source_title: value.source_title,
            source_revision: value.source_revision,
            span_start: value.span_start,
            span_end: value.span_end,
            source_field: value.source_field,
            snippet: value.snippet,
            target_raw: value.target_raw,
            candidates: value.candidates.into_iter().map(Into::into).collect(),
            actions: value.actions.into_iter().map(Into::into).collect(),
        }
    }
}

fn reference_repair_error(error: VaultReferenceRepairError) -> ApiError {
    match error {
        VaultReferenceRepairError::Invalid(message) => ApiError::bad_request(message),
        VaultReferenceRepairError::Stale => {
            ApiError::conflict("reference issue changed since it was selected")
        }
        VaultReferenceRepairError::Index(_) | VaultReferenceRepairError::Io(_) => {
            ApiError::internal("reference repair could not be prepared")
        }
    }
}

fn default_rewrite_mode() -> String {
    "plain_text".to_string()
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/backlinks/{*path}", get(backlinks))
        .route("/similar/{*path}", get(similar))
        .route("/outlinks/{*path}", get(outlinks))
        .route("/unresolved", get(unresolved))
        .route("/issues", get(reference_issues))
        .route("/issues/preview", post(reference_repair_preview))
        .route("/issues/apply", post(reference_repair_apply))
        .route("/ambiguous", get(ambiguous))
        .route("/warnings", get(warnings))
        .route("/tags", get(tags))
        .route("/stats", get(stats))
        .route("/rebuild", post(rebuild_index))
        .route("/create-from-link", post(create_from_link))
        .route("/preview-mutation", post(preview_mutation))
        .route("/graph", get(graph))
        .route("/content-index", get(content_index))
        .route("/search", get(search))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/index/issues",
    context_path = "/api/vault",
    tag = "Index",
    params(ReferenceIssuesParams),
    responses(
        (status = 200, description = "Paginated reference issue inventory", body = ReferenceIssuesResponse),
        (status = 400, description = "Invalid filter or pagination value", body = ApiError),
        (status = 500, description = "Reference issue inventory unavailable", body = ApiError)
    )
)]
pub async fn reference_issues(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ReferenceIssuesQuery>,
) -> Result<Json<ReferenceIssuesResponse>, ApiError> {
    let filter = query.into_filter()?;
    let limit = filter.limit;
    let offset = filter.offset;
    let page = state
        .index
        .with_index(move |index, _vault| index.reference_issues(filter))
        .await
        .map_err(|_| ApiError::internal("reference issue inventory unavailable"))?
        .map_err(|_| ApiError::internal("reference issue inventory unavailable"))?;

    Ok(Json(ReferenceIssuesResponse {
        items: page.items.into_iter().map(Into::into).collect(),
        total: page.total,
        limit,
        offset,
    }))
}

#[utoipa::path(
    post,
    path = "/index/issues/preview",
    context_path = "/api/vault",
    tag = "Index",
    request_body = ReferenceRepairRequest,
    responses(
        (status = 200, description = "Reference repair preview", body = ReferenceRepairPreviewResponse),
        (status = 400, description = "Action is unavailable or invalid", body = ApiError),
        (status = 409, description = "Issue or source revision is stale", body = ApiError),
        (status = 500, description = "Reference repair could not be prepared", body = ApiError)
    )
)]
pub async fn reference_repair_preview(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ReferenceRepairRequest>,
) -> Result<Json<ReferenceRepairPreviewResponse>, ApiError> {
    let prepared = state
        .index
        .with_index(move |index, vault| {
            prepare_reference_repair(vault, index, request.into())
        })
        .await
        .map_err(|_| ApiError::internal("reference repair could not be prepared"))?
        .map_err(reference_repair_error)?;

    Ok(Json(ReferenceRepairPreviewResponse {
        fingerprint: prepared.fingerprint,
        before: prepared.before,
        after: prepared.after,
        plan: prepared.plan,
    }))
}

#[utoipa::path(
    post,
    path = "/index/issues/apply",
    context_path = "/api/vault",
    tag = "Index",
    request_body = ReferenceRepairRequest,
    responses(
        (status = 200, description = "Committed reference repair", body = ReferenceRepairApplyResponse),
        (status = 400, description = "Action is unavailable or invalid", body = ApiError),
        (status = 409, description = "Issue, source revision, or path state is stale", body = ApiError),
        (status = 500, description = "Reference repair could not be committed", body = ApiError)
    )
)]
pub async fn reference_repair_apply(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ReferenceRepairRequest>,
) -> Result<Json<ReferenceRepairApplyResponse>, ApiError> {
    let exclusion = state.mutation_coordinator.exclude_mutations().await;
    let prepared = state
        .index
        .with_index(move |index, vault| {
            prepare_reference_repair(vault, index, request.into())
        })
        .await
        .map_err(|_| ApiError::internal("reference repair could not be prepared"))?
        .map_err(reference_repair_error)?;
    let fingerprint = prepared.fingerprint;
    let notification = state
        .mutation_coordinator
        .execute_batch_excluded(
            exclusion,
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            prepared.command,
            super::mutation_notifier(state.as_ref()),
        )
        .await
        .map_err(super::mutation_error)?;

    Ok(Json(ReferenceRepairApplyResponse {
        fingerprint,
        notification,
    }))
}

#[utoipa::path(
    get,
    path = "/index/backlinks/{path}",
    context_path = "/api/vault",
    tag = "Index",
    params(("path" = String, Path, description = "Vault-relative page path")),
    responses(
        (status = 200, description = "Backlinks", body = [BacklinkEntry]),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn backlinks(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<Vec<BacklinkEntry>>, ApiError> {
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

    let backlinks = state
        .index
        .backlinks(vault_path, 200)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let entries: Vec<BacklinkEntry> = backlinks
        .into_iter()
        .map(|bl| BacklinkEntry {
            source_id: bl.source_id,
            source_path: bl.source_path,
            source_title: bl.source_title,
            target_raw: bl.target_raw,
            kind: bl.kind,
            context: bl.context,
        })
        .collect();

    Ok(Json(entries))
}

#[utoipa::path(
    get,
    path = "/index/similar/{path}",
    context_path = "/api/vault",
    tag = "Index",
    params(("path" = String, Path, description = "Vault-relative page path")),
    responses(
        (status = 200, description = "Similar pages by tag overlap", body = SimilarResponse),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn similar(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<SimilarResponse>, ApiError> {
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;
    let items = state
        .index
        .similar_by_tags(vault_path, 12)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .map(|s| SimilarEntry {
            path: s.path,
            title: s.title,
            shared_tags: s.shared_tags,
            score: s.score,
        })
        .collect();
    Ok(Json(SimilarResponse { items }))
}

#[utoipa::path(
    get,
    path = "/index/outlinks/{path}",
    context_path = "/api/vault",
    tag = "Index",
    params(("path" = String, Path, description = "Vault-relative page path")),
    responses(
        (status = 200, description = "Outlinks", body = [OutlinkEntry]),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn outlinks(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<Vec<OutlinkEntry>>, ApiError> {
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

    let vp_str = vault_path.as_str().to_string();
    let path_clone = path.clone();

    let links = state
        .index
        .with_index(move |index, _vault| {
            let page_id: String = index
                .connection()
                .query_row(
                    "SELECT id FROM pages WHERE path = ?1",
                    params![vp_str],
                    |row| row.get(0),
                )
                .map_err(|_| rusqlite::Error::QueryReturnedNoRows)?;

            let mut stmt = index.connection().prepare(
                "SELECT l.target_raw, l.target_path, l.target_id, l.kind, l.source_field
                     FROM links l WHERE l.source_id = ?1",
            )?;

            let links: Vec<OutlinkEntry> = stmt
                .query_map(params![page_id], |row| {
                    Ok(OutlinkEntry {
                        target_raw: row.get(0)?,
                        target_path: row.get(1)?,
                        target_id: row.get(2)?,
                        kind: row.get(3)?,
                        source_field: row.get(4)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok::<_, rusqlite::Error>(links)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|_| ApiError::not_found(format!("page not found in index: {path_clone}")))?;

    Ok(Json(links))
}

#[utoipa::path(
    get,
    path = "/index/unresolved",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Unresolved links", body = [UnresolvedLink]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn unresolved(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<UnresolvedLink>>, ApiError> {
    let strategy = state.vault.config().vault.disambiguation_strategy;

    let links = state
        .index
        .with_index(move |index, _vault| {
            let details = index.unresolved_with_candidates()?;

            let links: Vec<UnresolvedLink> = details
                .into_iter()
                .map(|d| {
                    let ranked_candidates = if d.reason == UnresolvedReason::Ambiguous {
                        index.rank_candidates(&d.candidates, &d.source_path, strategy)
                    } else {
                        d.candidates
                    };

                    let reason_str = match d.reason {
                        UnresolvedReason::NoMatch => "no_match",
                        UnresolvedReason::Ambiguous => "ambiguous",
                    };

                    UnresolvedLink {
                        source_id: d.source_id,
                        source_path: d.source_path,
                        target_raw: d.target_raw,
                        target_canonical: d.target_canonical,
                        kind: d.kind,
                        span_start: d.span_start,
                        reason: reason_str.to_string(),
                        candidates: ranked_candidates
                            .into_iter()
                            .map(|c| CandidateEntry {
                                page_id: c.page_id,
                                path: c.path,
                                title: c.title,
                            })
                            .collect(),
                    }
                })
                .collect();

            Ok::<_, crate::vault::index::IndexError>(links)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(links))
}

#[utoipa::path(
    get,
    path = "/index/ambiguous",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Ambiguous canonical names", body = [AmbiguousName]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn ambiguous(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AmbiguousName>>, ApiError> {
    let names = state
        .index
        .with_index(move |index, _vault| {
            let mut stmt = index.connection().prepare(
                "SELECT cn.canonical_name, GROUP_CONCAT(cn.page_id) as page_ids
                     FROM canonical_names cn
                     GROUP BY cn.canonical_name
                     HAVING COUNT(*) > 1",
            )?;

            let names: Vec<AmbiguousName> = stmt
                .query_map([], |row| {
                    let name: String = row.get(0)?;
                    let ids_str: String = row.get(1)?;
                    let page_ids: Vec<String> = ids_str.split(',').map(|s| s.to_string()).collect();
                    Ok(AmbiguousName {
                        canonical_name: name,
                        page_ids,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok::<_, rusqlite::Error>(names)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(names))
}

#[utoipa::path(
    get,
    path = "/index/warnings",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Index warnings", body = [String]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn warnings(State(state): State<Arc<AppState>>) -> Result<Json<Vec<String>>, ApiError> {
    let warnings = state.warnings.lock();

    Ok(Json(warnings.clone()))
}

const DEFAULT_TAG_SUGGESTION_LIMIT: u32 = 12;
const MAX_TAG_SUGGESTION_LIMIT: u32 = 50;

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

#[utoipa::path(
    get,
    path = "/index/tags",
    context_path = "/api/vault",
    tag = "Index",
    params(TagQuery),
    responses(
        (status = 200, description = "Tag counts", body = [TagCount]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn tags(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TagQuery>,
) -> Result<Json<Vec<TagCount>>, ApiError> {
    let q = query.q.map(|value| value.trim().to_owned());
    let limit = query
        .limit
        .unwrap_or(DEFAULT_TAG_SUGGESTION_LIMIT)
        .clamp(1, MAX_TAG_SUGGESTION_LIMIT);
    let tag_counts = state
        .index
        .with_index(move |index, _vault| {
            let tag_counts = if let Some(q) = q {
                let escaped = escape_like_pattern(&q);
                let contains = format!("%{escaped}%");
                let prefix = format!("{escaped}%");
                let mut stmt = index.connection().prepare(
                    "SELECT tag,
                            COUNT(DISTINCT page_id) AS count,
                            COUNT(DISTINCT CASE WHEN computed = 1 THEN page_id END)
                                AS computed_count
                     FROM tags
                     WHERE tag LIKE ?1 ESCAPE '\\'
                     GROUP BY tag
                     ORDER BY
                       CASE
                         WHEN tag = ?2 COLLATE NOCASE THEN 0
                         WHEN tag LIKE ?3 ESCAPE '\\' THEN 1
                         ELSE 2
                       END,
                       count DESC,
                       tag COLLATE NOCASE ASC,
                       tag ASC
                     LIMIT ?4",
                )?;
                stmt.query_map(params![contains, q, prefix, i64::from(limit)], |row| {
                    Ok(TagCount {
                        tag: row.get(0)?,
                        count: row.get(1)?,
                        computed_count: row.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            } else {
                let mut stmt = index.connection().prepare(
                    "SELECT tag,
                            COUNT(DISTINCT page_id) AS count,
                            COUNT(DISTINCT CASE WHEN computed = 1 THEN page_id END)
                                AS computed_count
                       FROM tags
                      GROUP BY tag
                      ORDER BY count DESC, tag COLLATE NOCASE ASC, tag ASC",
                )?;
                stmt.query_map([], |row| {
                    Ok(TagCount {
                        tag: row.get(0)?,
                        count: row.get(1)?,
                        computed_count: row.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
            };

            Ok::<_, rusqlite::Error>(tag_counts)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(tag_counts))
}

#[utoipa::path(
    get,
    path = "/index/stats",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Vault statistics", body = VaultStats),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn stats(State(state): State<Arc<AppState>>) -> Result<Json<VaultStats>, ApiError> {
    // Count attachments on disk (doesn't need index)
    let attachment_folder = state.vault.config().vault.attachment_folder.clone();
    let attachment_dir = state.vault.root().join(&attachment_folder);
    let attachments: i64 = if attachment_dir.is_dir() {
        walkdir::WalkDir::new(&attachment_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .count() as i64
    } else {
        0
    };

    let (
        pages,
        links_total,
        links_resolved,
        links_unresolved,
        orphan_pages,
        isolated_pages,
        tags_count,
        last_indexed_at,
    ) = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            let pages: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))?;

            let links_total: i64 =
                conn.query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0))?;

            let links_resolved: i64 = conn.query_row(
                "SELECT COUNT(*) FROM links WHERE target_id IS NOT NULL",
                [],
                |row| row.get(0),
            )?;

            let links_unresolved: i64 = conn.query_row(
                "SELECT COUNT(*) FROM links WHERE target_id IS NULL",
                [],
                |row| row.get(0),
            )?;

            // Inbound arm (`l.target_id = p.id`) is inherently resolved-only:
            // an unresolved link has `target_id IS NULL`, and `NULL = p.id` is
            // never true, so dangling rows are excluded without an explicit
            // guard. The outbound arm below must spell out `target_id IS NOT
            // NULL` because `l.source_id` is set on every row regardless of
            // resolution — both arms thus measure the *resolved* graph.
            let orphan_pages: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pages p
                  WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = p.id)",
                [],
                |row| row.get(0),
            )?;

            let isolated_pages: i64 = conn.query_row(
                "SELECT COUNT(*) FROM pages p
                  WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = p.id)
                    AND NOT EXISTS (SELECT 1 FROM links l
                                     WHERE l.source_id = p.id
                                       AND l.target_id IS NOT NULL)",
                [],
                |row| row.get(0),
            )?;

            let tags_count: i64 =
                conn.query_row("SELECT COUNT(DISTINCT tag) FROM tags", [], |row| row.get(0))?;

            let last_indexed_at: Option<String> = conn
                .query_row("SELECT MAX(updated_at) FROM pages", [], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .ok()
                .flatten();

            Ok::<_, rusqlite::Error>((
                pages,
                links_total,
                links_resolved,
                links_unresolved,
                orphan_pages,
                isolated_pages,
                tags_count,
                last_indexed_at,
            ))
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(VaultStats {
        pages,
        links_total,
        links_resolved,
        links_unresolved,
        orphan_pages,
        isolated_pages,
        tags: tags_count,
        attachments,
        last_indexed_at,
    }))
}

#[utoipa::path(
    get,
    path = "/index/graph",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Resolved link graph", body = GraphResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn graph(State(state): State<Arc<AppState>>) -> Result<Json<GraphResponse>, ApiError> {
    let (nodes, edges) = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            let mut node_stmt = conn.prepare("SELECT id, path, title FROM pages")?;

            let nodes: Vec<GraphNode> = node_stmt
                .query_map([], |row| {
                    Ok(GraphNode {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        title: row.get(2)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            let mut edge_stmt = conn.prepare(
                "SELECT source_id, target_id, kind FROM links WHERE target_id IS NOT NULL",
            )?;

            let edges: Vec<GraphEdge> = edge_stmt
                .query_map([], |row| {
                    Ok(GraphEdge {
                        source: row.get(0)?,
                        target: row.get(1)?,
                        kind: row.get(2)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok::<_, rusqlite::Error>((nodes, edges))
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(GraphResponse { nodes, edges }))
}

#[utoipa::path(
    post,
    path = "/index/rebuild",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Index rebuilt", body = RebuildResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn rebuild_index(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let build_stats = state
        .index
        .with_index(move |index, vault| {
            let stats = index.build(vault)?;
            index.resolve_links()?;
            Ok::<_, crate::vault::index::IndexError>(stats)
        })
        .await
        .map_err(|e| ApiError::internal(format!("index build failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("index build failed: {e}")))?;

    // Store warnings for the /warnings endpoint
    {
        let mut warnings = state.warnings.lock();
        *warnings = build_stats.warnings.clone();
    }

    // Full rebuild — notify clients to refresh everything
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec!["*".to_string()],
        removed: vec![],
    });

    Ok((
        StatusCode::OK,
        Json(RebuildResponse {
            pages_indexed: build_stats.pages_indexed,
            pages_skipped: build_stats.pages_skipped,
            pages_removed: build_stats.pages_removed,
            warnings: build_stats.warnings,
        }),
    )
        .into_response())
}

#[utoipa::path(
    post,
    path = "/index/preview-mutation",
    context_path = "/api/vault",
    tag = "Index",
    request_body = PreviewMutationRequest,
    responses(
        (status = 200, description = "Mutation preview", body = serde_json::Value),
        (status = 400, description = "Invalid operation", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn preview_mutation(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewMutationRequest>,
) -> Result<Response, ApiError> {
    let op = match req.operation.as_str() {
        "move_page" => MutationOp::MovePage {
            source: req.source,
            destination: req.destination,
        },
        "delete_page" => {
            let rewrite = match req.rewrite.as_str() {
                "unlink" => RewriteMode::Unlink,
                "none" => RewriteMode::None,
                _ => RewriteMode::PlainText,
            };
            MutationOp::DeletePage {
                path: req.source,
                rewrite,
            }
        }
        "move_folder" => MutationOp::MoveFolder {
            source: req.source,
            destination: req.destination,
        },
        other => {
            return Err(ApiError::bad_request(format!("unknown operation: {other}")));
        }
    };

    let plan = state
        .index
        .with_index(move |index, vault| {
            let planner = MutationPlanner::new(vault, index);
            planner.plan(&op)
        })
        .await
        .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

    Ok(Json(plan).into_response())
}

#[utoipa::path(
    post,
    path = "/index/create-from-link",
    context_path = "/api/vault",
    tag = "Index",
    request_body = CreateFromLinkRequest,
    responses(
        (status = 201, description = "Page created from unresolved link", body = crate::api::pages::PageDetailResponse),
        (status = 400, description = "Invalid request", body = ApiError),
        (status = 409, description = "Page already exists", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_from_link(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateFromLinkRequest>,
) -> Result<Response, ApiError> {
    // Generate path from title
    let mut vault_path = VaultPath::from_title(&body.target_raw);

    // Prepend folder if non-empty
    if !body.folder.is_empty() {
        let combined = format!(
            "{}/{}",
            body.folder.trim_end_matches('/'),
            vault_path.as_str()
        );
        vault_path = crate::api::error::parse_request_path(&combined, "invalid folder path")?;
    }

    // Build PageMeta
    let mut meta = PageMeta::new();
    meta.title = Some(body.target_raw.clone());

    let page_body = body.body.unwrap_or_default();

    let notify = super::mutation_notifier(state.as_ref());
    let result = state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path,
                meta,
                body: page_body,
            },
            notify,
        )
        .await
        .map_err(super::mutation_error)?;

    Ok((StatusCode::CREATED, Json(page_detail(result))).into_response())
}

// ---------------------------------------------------------------------------
// Content index (Quartz-style per-page metadata)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentEntry {
    path: String,
    title: Option<String>,
    tags: Vec<String>,
    computed_tags: Vec<String>,
    links: Vec<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    word_count: Option<i64>,
    #[schema(value_type = crate::vault::kind::Kind)]
    kind: String,
    inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ContentIndexQuery {
    /// Case-insensitive substring matched against title, path, and body.
    pub q: Option<String>,
    /// Canonical page Kind token.
    pub kind: Option<String>,
    /// Exact project slug.
    pub project: Option<String>,
    /// Comma-encoded tags; every tag must match.
    pub tags: Option<String>,
    /// Maximum number of entries.
    pub limit: Option<u32>,
    /// Entry offset.
    pub offset: Option<u32>,
}

#[utoipa::path(
    get,
    path = "/index/content-index",
    context_path = "/api/vault",
    tag = "Index",
    params(ContentIndexQuery),
    responses(
        (status = 200, description = "Content index", body = ContentIndexResponse),
        (status = 400, description = "Invalid Kind filter", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn content_index(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ContentIndexQuery>,
) -> Result<Json<PaginatedResponse<ContentEntry>>, ApiError> {
    let kind = query
        .kind
        .as_deref()
        .map(|token| {
            crate::vault::kind::Kind::from_token(token)
                .map(|kind| kind.as_str().to_string())
                .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {token}")))
        })
        .transpose()?;
    let q = query
        .q
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let project = query
        .project
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let tags = query
        .tags
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let limit = query.limit;
    let offset = query.offset.unwrap_or(0);

    let (entries, total) = state
        .index
        .with_index(move |index, vault| {
            let conn = index.connection();
            let mut conditions = Vec::new();
            let mut filter_params = Vec::<rusqlite::types::Value>::new();

            if let Some(q) = q {
                let like = format!(
                    "%{}%",
                    q.replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                );
                conditions.push(
                    "EXISTS (
                        SELECT 1
                          FROM pages_fts f
                         WHERE f.page_id = p.id
                           AND (
                               LOWER(COALESCE(f.title, '')) LIKE ? ESCAPE '\\'
                            OR LOWER(f.path) LIKE ? ESCAPE '\\'
                            OR LOWER(f.body) LIKE ? ESCAPE '\\'
                           )
                    )"
                    .to_string(),
                );
                filter_params.push(rusqlite::types::Value::Text(like.clone()));
                filter_params.push(rusqlite::types::Value::Text(like.clone()));
                filter_params.push(rusqlite::types::Value::Text(like));
            }
            if let Some(kind) = kind {
                conditions.push("p.kind = ?".to_string());
                filter_params.push(rusqlite::types::Value::Text(kind));
            }
            if let Some(project) = project {
                conditions.push("p.project = ?".to_string());
                filter_params.push(rusqlite::types::Value::Text(project));
            }
            for tag in tags {
                conditions.push(
                    "EXISTS (
                        SELECT 1
                          FROM tags selected_tag
                         WHERE selected_tag.page_id = p.id
                           AND selected_tag.tag = ?
                    )"
                    .to_string(),
                );
                filter_params.push(rusqlite::types::Value::Text(tag));
            }

            let where_clause = if conditions.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", conditions.join(" AND "))
            };
            let total = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM pages p{where_clause}"),
                    rusqlite::params_from_iter(filter_params.iter()),
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| ApiError::internal(error.to_string()))?;

            let mut page_params = filter_params;
            page_params.push(rusqlite::types::Value::Integer(
                limit.map(i64::from).unwrap_or(-1),
            ));
            page_params.push(rusqlite::types::Value::Integer(i64::from(offset)));
            let mut page_stmt = conn
                .prepare(&format!(
                    "SELECT p.id, p.path, p.title, p.kind, p.kind_inferred, p.project
                       FROM pages p{where_clause}
                      ORDER BY p.path COLLATE NOCASE, p.id
                      LIMIT ? OFFSET ?"
                ))
                .map_err(|error| ApiError::internal(error.to_string()))?;

            type PageRow = (String, String, Option<String>, String, i64, Option<String>);
            let pages = page_stmt
                .query_map(rusqlite::params_from_iter(page_params.iter()), |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })
                .map_err(|error| ApiError::internal(error.to_string()))?
                .collect::<Result<Vec<PageRow>, _>>()
                .map_err(|error| ApiError::internal(error.to_string()))?;

            let mut tags_by_page: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::with_capacity(pages.len());
            let mut computed_tags_by_page: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::with_capacity(pages.len());
            let mut links_by_page: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::with_capacity(pages.len());

            if !pages.is_empty() {
                let placeholders = (0..pages.len()).map(|_| "?").collect::<Vec<_>>().join(",");
                let page_ids = pages.iter().map(|page| &page.0).collect::<Vec<_>>();

                let mut tag_stmt = conn
                    .prepare(&format!(
                        "SELECT page_id, tag, computed
                           FROM tags
                          WHERE page_id IN ({placeholders})
                          ORDER BY page_id, computed, rowid"
                    ))
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                let tag_rows = tag_stmt
                    .query_map(
                        rusqlite::params_from_iter(page_ids.iter().copied()),
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                for row in tag_rows {
                    let (page_id, tag, computed) =
                        row.map_err(|error| ApiError::internal(error.to_string()))?;
                    if computed != 0 {
                        computed_tags_by_page
                            .entry(page_id.clone())
                            .or_default()
                            .push(tag.clone());
                    }
                    tags_by_page.entry(page_id).or_default().push(tag);
                }

                let mut link_stmt = conn
                    .prepare(&format!(
                        "SELECT DISTINCT source_id, target_path
                           FROM links
                          WHERE target_path IS NOT NULL
                            AND source_id IN ({placeholders})"
                    ))
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                let link_rows = link_stmt
                    .query_map(
                        rusqlite::params_from_iter(page_ids.iter().copied()),
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(|error| ApiError::internal(error.to_string()))?;
                for row in link_rows {
                    let (page_id, target) =
                        row.map_err(|error| ApiError::internal(error.to_string()))?;
                    links_by_page.entry(page_id).or_default().push(target);
                }
            }

            let mut entries = Vec::with_capacity(pages.len());
            for (page_id, path, title, kind, kind_inferred, project) in &pages {
                let tags = tags_by_page.remove(page_id).unwrap_or_default();
                let computed_tags = computed_tags_by_page.remove(page_id).unwrap_or_default();
                let links = links_by_page.remove(page_id).unwrap_or_default();
                let vault_path = parse_internal_path(path, "invalid stored path")?;
                let abs_path = vault.resolve(&vault_path);
                let (created_at, updated_at, description, word_count) = if abs_path.exists() {
                    match Page::from_file(&abs_path, vault_path) {
                        Ok(page) => {
                            let created = page.meta.created_at.map(|date| date.to_rfc3339());
                            let updated = page.meta.updated_at.map(|date| date.to_rfc3339());
                            if page.is_encrypted() {
                                (created, updated, String::new(), None)
                            } else {
                                let description = page.body.chars().take(200).collect::<String>();
                                let words = page.body.split_whitespace().count() as i64;
                                (created, updated, description, Some(words))
                            }
                        }
                        Err(_) => (None, None, String::new(), None),
                    }
                } else {
                    (None, None, String::new(), None)
                };

                entries.push(ContentEntry {
                    path: path.clone(),
                    title: title.clone(),
                    tags,
                    computed_tags,
                    links,
                    created_at,
                    updated_at,
                    description,
                    word_count,
                    kind: kind.clone(),
                    inferred: *kind_inferred != 0,
                    project: project.clone(),
                });
            }

            Ok::<_, ApiError>((entries, total))
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))??;

    Ok(Json(PaginatedResponse {
        items: entries,
        total: u32::try_from(total).unwrap_or(u32::MAX),
        limit,
        offset,
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use axum::extract::{Query, State};

    use super::*;
    use crate::state_test_support::make_state;
    use crate::vault::index::IndexError;
    use crate::vault::path::VaultPath;

    #[tokio::test]
    async fn content_index_returns_kind_inferred_project() {
        let (state, _tmp) = make_state().await;

        // Write a page with type: quote and project: clepsydra
        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();
        let page_content = "\
---\n\
id: 01900000-0000-7000-8000-000000000010\n\
type: quote\n\
project: clepsydra\n\
---\n\
\n\
Some quoted text.\n";
        std::fs::write(page_dir.join("q.md"), page_content).unwrap();

        // Index the page
        let vp = VaultPath::new("notes/q.md").unwrap();
        state
            .index
            .with_index(move |index, vault| {
                index.index_page(vault, &vp)?;
                Ok::<_, IndexError>(())
            })
            .await
            .unwrap()
            .unwrap();

        // Call the handler
        let resp = content_index(
            State(state),
            Query(ContentIndexQuery {
                q: None,
                kind: None,
                project: None,
                tags: None,
                limit: None,
                offset: None,
            }),
        )
        .await
        .unwrap();

        let item = resp
            .0
            .items
            .iter()
            .find(|e| e.path == "notes/q.md")
            .expect("notes/q.md not found in content-index");

        assert_eq!(item.kind, "QUOTE", "kind should be QUOTE");
        assert!(!item.inferred, "kind should not be inferred when declared");
        assert_eq!(
            item.project.as_deref(),
            Some("clepsydra"),
            "project should be clepsydra"
        );
    }

    #[tokio::test]
    async fn content_index_filters_combined_query_before_pagination() {
        let (state, _tmp) = make_state().await;
        let project_dir = state.vault.root().join("projects");
        let note_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(
            project_dir.join("atlas-alpha.md"),
            "---\n\
id: 01900000-0000-7000-8000-000000000020\n\
title: Atlas Alpha\n\
type: project\n\
project: clepsydra\n\
tags: [research]\n\
---\n\
\n\
Atlas planning.\n",
        )
        .unwrap();
        std::fs::write(
            project_dir.join("atlas-beta.md"),
            "---\n\
id: 01900000-0000-7000-8000-000000000021\n\
title: Atlas Beta\n\
type: project\n\
project: clepsydra\n\
tags: [research]\n\
---\n\
\n\
Atlas delivery.\n",
        )
        .unwrap();
        std::fs::write(
            note_dir.join("atlas-note.md"),
            "---\n\
id: 01900000-0000-7000-8000-000000000022\n\
title: Atlas Note\n\
type: note\n\
project: clepsydra\n\
tags: [research]\n\
---\n\
\n\
Atlas notes.\n",
        )
        .unwrap();

        let paths = [
            VaultPath::new("projects/atlas-alpha.md").unwrap(),
            VaultPath::new("projects/atlas-beta.md").unwrap(),
            VaultPath::new("notes/atlas-note.md").unwrap(),
        ];
        state
            .index
            .with_index(move |index, vault| {
                for path in paths {
                    index.index_page(vault, &path)?;
                }
                Ok::<_, IndexError>(())
            })
            .await
            .unwrap()
            .unwrap();

        let response = content_index(
            State(state),
            Query(ContentIndexQuery {
                q: Some("atlas".to_string()),
                kind: Some("PROJECT".to_string()),
                project: Some("clepsydra".to_string()),
                tags: Some("project,research".to_string()),
                limit: Some(1),
                offset: Some(0),
            }),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(response.total, 2);
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].path, "projects/atlas-alpha.md");
        assert!(response.items[0].tags.contains(&"project".to_string()));
        assert!(
            response.items[0]
                .computed_tags
                .contains(&"project".to_string())
        );
    }

    #[tokio::test]
    async fn stats_reports_orphan_and_isolated_pages() {
        let (state, _tmp) = make_state().await;

        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();

        // Page A links to B; B has no links; C is fully disconnected;
        // D's only outbound link is dangling (unresolved).
        // After resolution:
        //   A: 0 inbound, 1 resolved outbound -> orphan, NOT isolated
        //   B: 1 inbound (from A), 0 outbound -> not orphan, not isolated
        //   C: 0 inbound, 0 outbound -> orphan AND isolated
        //   D: 0 inbound, 0 *resolved* outbound -> orphan AND isolated
        //      (its [[Nonexistent]] link stays unresolved, so it is
        //       disconnected from the resolved graph)
        std::fs::write(
            page_dir.join("a.md"),
            "\
---\n\
id: 01900000-0000-7000-8000-000000000020\n\
---\n\
\n\
see [[B]] for context\n",
        )
        .unwrap();
        std::fs::write(
            page_dir.join("B.md"),
            "\
---\n\
id: 01900000-0000-7000-8000-000000000021\n\
title: B\n\
---\n\
\n\
nothing here\n",
        )
        .unwrap();
        std::fs::write(
            page_dir.join("c.md"),
            "\
---\n\
id: 01900000-0000-7000-8000-000000000022\n\
---\n\
\n\
all alone\n",
        )
        .unwrap();
        std::fs::write(
            page_dir.join("d.md"),
            "\
---\n\
id: 01900000-0000-7000-8000-000000000023\n\
---\n\
\n\
points to [[Nonexistent]]\n",
        )
        .unwrap();

        for name in ["notes/a.md", "notes/B.md", "notes/c.md", "notes/d.md"] {
            let vp = VaultPath::new(name).unwrap();
            state
                .index
                .with_index(move |index, vault| {
                    index.index_page(vault, &vp)?;
                    Ok::<_, IndexError>(())
                })
                .await
                .unwrap()
                .unwrap();
        }

        // CRITICAL: index_page leaves target_id NULL; resolve before counting.
        state.index.resolve_links().await.unwrap();

        let s = stats(State(state)).await.unwrap().0;

        // Guard: only [[B]] resolves; D's [[Nonexistent]] stays unresolved.
        // This proves the corpus is resolved (not all-NULL) AND that D
        // contributes a dangling outbound row — the case that distinguishes
        // "isolated counts outbound rows" from "isolated counts the resolved
        // graph".
        assert_eq!(
            s.links_resolved, 1,
            "the [[B]] wikilink should resolve to exactly one target"
        );
        assert!(
            s.links_unresolved >= 1,
            "D's [[Nonexistent]] link should remain unresolved (target_id NULL)"
        );
        assert_eq!(
            s.orphan_pages, 3,
            "A, C, and D have zero inbound resolved links"
        );
        assert_eq!(
            s.isolated_pages, 2,
            "C and D are disconnected from the resolved graph \
             (D's only outbound link is unresolved)"
        );
    }
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/index/search",
    context_path = "/api/vault",
    tag = "Index",
    params(
        ("q" = Option<String>, Query, description = "Search query"),
        ("limit" = Option<u32>, Query, description = "Maximum number of search results")
    ),
    responses(
        (status = 200, description = "Search results", body = [SearchResultEntry]),
        (status = 400, description = "Invalid query", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SearchResultEntry>>, ApiError> {
    let q = query
        .q
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad_request("missing 'q' query parameter".to_string()))?;

    let limit = query.limit.unwrap_or(20) as usize;

    let results = state
        .index
        .search(q, limit)
        .await
        .map_err(|e| ApiError::internal(format!("search failed: {e}")))?;

    let entries: Vec<SearchResultEntry> = results
        .into_iter()
        .map(|r| SearchResultEntry {
            page_id: r.page_id,
            path: r.path,
            title: r.title,
            snippet: r.snippet,
        })
        .collect();

    Ok(Json(entries))
}
