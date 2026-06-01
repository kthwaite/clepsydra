use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use super::pages::page_detail_from_meta;
use super::pagination::{PaginatedResponse, PaginationParams};
use crate::api::events::SyncNotification;
use crate::vault::index::UnresolvedReason;
use crate::vault::mutation::{MutationOp, MutationPlanner, RewriteMode};
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;

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
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VaultStats {
    pages: i64,
    links_total: i64,
    links_resolved: i64,
    links_unresolved: i64,
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
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

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
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
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
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

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

#[utoipa::path(
    get,
    path = "/index/tags",
    context_path = "/api/vault",
    tag = "Index",
    responses(
        (status = 200, description = "Tag counts", body = [TagCount]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn tags(State(state): State<Arc<AppState>>) -> Result<Json<Vec<TagCount>>, ApiError> {
    let tag_counts = state
        .index
        .with_index(move |index, _vault| {
            let mut stmt = index.connection().prepare(
                "SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC",
            )?;

            let tag_counts: Vec<TagCount> = stmt
                .query_map([], |row| {
                    Ok(TagCount {
                        tag: row.get(0)?,
                        count: row.get(1)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();

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

    let (pages, links_total, links_resolved, links_unresolved, tags_count, last_indexed_at) = state
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
        vault_path = VaultPath::new(&combined)
            .map_err(|e| ApiError::bad_request(format!("invalid folder path: {e}")))?;
    }

    let abs_path = state.vault.resolve(&vault_path);
    if abs_path.exists() {
        return Err(ApiError::conflict(format!(
            "page already exists: {}",
            vault_path.as_str()
        )));
    }

    // Create parent directories
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // Build PageMeta
    let mut meta = PageMeta::new();
    meta.title = Some(body.target_raw.clone());

    let page_body = body.body.unwrap_or_default();

    // Write file
    let content = write_page_content(&meta, &page_body);
    std::fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // Index the new page and resolve links
    {
        let vp = vault_path.clone();
        state
            .index
            .with_index(move |index, vault| {
                index.index_page(vault, &vp)?;
                index.resolve_links_for_page(&vp)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .map_err(|e| ApiError::internal(format!("index failed: {e}")))?
            .map_err(|e| ApiError::internal(format!("index failed: {e}")))?;
    }

    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    Ok((
        StatusCode::CREATED,
        Json(page_detail_from_meta(&vault_path, meta, page_body)),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Content index (Quartz-style per-page metadata)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentEntry {
    path: String,
    title: Option<String>,
    tags: Vec<String>,
    links: Vec<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    word_count: Option<i64>,
    kind: String,
    inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
}

#[utoipa::path(
    get,
    path = "/index/content-index",
    context_path = "/api/vault",
    tag = "Index",
    params(
        ("limit" = Option<u32>, Query, description = "Maximum number of entries"),
        ("offset" = Option<u32>, Query, description = "Entry offset")
    ),
    responses(
        (status = 200, description = "Content index", body = ContentIndexResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn content_index(
    State(state): State<Arc<AppState>>,
    Query(pagination): Query<PaginationParams>,
) -> Result<Json<PaginatedResponse<ContentEntry>>, ApiError> {
    let entries = state
        .index
        .with_index(move |index, vault| {
            let conn = index.connection();

            let mut page_stmt =
                conn.prepare("SELECT id, path, title, kind, kind_inferred, project FROM pages")?;

            type PageRow = (String, String, Option<String>, String, i64, Option<String>);
            let pages: Vec<PageRow> = page_stmt
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })?
                .filter_map(|r| r.ok())
                .collect();

            // Bulk-load tags grouped by page_id (was N+1 per page).
            let mut tags_by_page: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::with_capacity(pages.len());
            {
                let mut stmt = conn.prepare("SELECT page_id, tag FROM tags")?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                for (pid, tag) in rows.flatten() {
                    tags_by_page.entry(pid).or_default().push(tag);
                }
            }

            // Bulk-load distinct outbound links grouped by source_id (was N+1 per page).
            let mut links_by_page: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::with_capacity(pages.len());
            {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT source_id, target_path FROM links \
                     WHERE target_path IS NOT NULL",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                for (sid, target) in rows.flatten() {
                    links_by_page.entry(sid).or_default().push(target);
                }
            }

            let mut entries = Vec::with_capacity(pages.len());

            for (page_id, path, title, kind, kind_inferred, project) in &pages {
                let tags = tags_by_page.remove(page_id).unwrap_or_default();
                let links = links_by_page.remove(page_id).unwrap_or_default();

                let vault_path = match VaultPath::new(path) {
                    Ok(vp) => vp,
                    Err(_) => continue,
                };
                let abs_path = vault.resolve(&vault_path);
                let (created_at, updated_at, description, word_count) = if abs_path.exists() {
                    match Page::from_file(&abs_path, vault_path) {
                        Ok(page) => {
                            let desc = page.body.chars().take(200).collect::<String>();
                            let created = page.meta.created_at.map(|d| d.to_rfc3339());
                            let updated = page.meta.updated_at.map(|d| d.to_rfc3339());
                            let words = page.body.split_whitespace().count() as i64;
                            (created, updated, desc, Some(words))
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

            Ok::<_, rusqlite::Error>(entries)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(PaginatedResponse::from_vec(entries, &pagination)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use axum::extract::{Query, State};

    use super::*;
    use crate::api::pagination::PaginationParams;
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
            Query(PaginationParams {
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
