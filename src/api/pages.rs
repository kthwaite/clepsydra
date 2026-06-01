use std::fs;
use std::io::Write;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use super::pagination::{PaginatedResponse, PaginationParams};
use crate::api::events::SyncNotification;
use crate::vault::canonical::CanonicalName;
use crate::vault::mutation::{MutationOp, MutationPlanner, RewriteMode};
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct PageSummary {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub canonical_name: String,
    pub kind: String,
    pub inferred: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PageDetail {
    pub path: String,
    pub canonical_name: String,
    pub meta: PageMeta,
    pub body: String,
    pub kind: String,
    pub inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// OpenAPI schema for page metadata exposed in `PageDetail`.
#[derive(Debug, Serialize, ToSchema)]
pub struct PageMetaResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// OpenAPI schema for page detail responses.
#[derive(Debug, Serialize, ToSchema)]
pub struct PageDetailResponse {
    pub path: String,
    pub canonical_name: String,
    pub meta: PageMetaResponse,
    pub body: String,
    pub kind: String,
    pub inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// OpenAPI schema for paginated page listing.
#[derive(Debug, Serialize, ToSchema)]
pub struct PageSummaryListResponse {
    pub items: Vec<PageSummary>,
    pub total: u32,
    pub limit: Option<u32>,
    pub offset: u32,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreatePageRequest {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdatePageRequest {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    pub force: bool,
    #[serde(default = "default_rewrite")]
    pub rewrite: String,
}

fn default_rewrite() -> String {
    "plain_text".to_string()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MovePageRequest {
    pub destination: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignRequest {
    /// Declared kind token (case-insensitive, e.g. `QUOTE`). When present and
    /// valid it overwrites the page's `type` frontmatter.
    #[serde(default)]
    pub kind: Option<String>,
    /// Declared project. When present (and `clear_project` is false) it
    /// overwrites the page's `project` frontmatter.
    #[serde(default)]
    pub project: Option<String>,
    /// Clear the page's `project` frontmatter. Takes precedence over `project`.
    #[serde(default)]
    pub clear_project: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BulkAssignRequest {
    /// Page paths to assign. Each is processed independently.
    pub paths: Vec<String>,
    /// Declared kind token applied to every path (see `AssignRequest::kind`).
    #[serde(default)]
    pub kind: Option<String>,
    /// Declared project applied to every path (see `AssignRequest::project`).
    #[serde(default)]
    pub project: Option<String>,
    /// Clear the project on every path (see `AssignRequest::clear_project`).
    #[serde(default)]
    pub clear_project: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BulkAssignResponse {
    /// `from -> to` for each moved page.
    pub moved: Vec<(String, String)>,
    /// `path -> error` for failures (best-effort: one bad page doesn't abort).
    pub failed: Vec<(String, String)>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_pages))
        .route("/by-id/{uuid}", get(get_page_by_id))
        .route(
            "/{*path}",
            get(get_page)
                .post(create_page)
                .put(update_page)
                .delete(delete_page),
        )
}

/// Separate router for move operations, nested at `/pages-move`.
/// Axum wildcards must be at the end of a route, so `/{*path}/move` is not
/// possible. Instead we use `POST /pages-move/{*path}`.
pub fn move_router() -> Router<Arc<AppState>> {
    Router::new().route("/{*path}", post(move_page))
}

/// Separate router for assign operations, nested at `/pages-assign`.
/// Like `move_router`, the wildcard must terminate the route, so we use
/// `POST /pages-assign/{*path}`.
pub fn assign_router() -> Router<Arc<AppState>> {
    Router::new().route("/{*path}", post(assign_page))
}

// ---------------------------------------------------------------------------
// Shared PageDetail constructors
// ---------------------------------------------------------------------------

/// Build a `PageDetail` from an owned `Page` (borrowed) and its `VaultPath`.
///
/// Callers MUST pass the page's OWN vault path (e.g. `move_page` passes the
/// destination path). Resolves the kind from `vault_path` + `page.meta.kind`
/// and derives the canonical name from the title (else the filename).
pub(crate) fn page_detail_from_page(page: &Page, vault_path: &VaultPath) -> PageDetail {
    let canonical = if let Some(ref title) = page.meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    let (resolved_kind, inferred) =
        crate::vault::kind::resolve(vault_path.as_str(), page.meta.kind);

    PageDetail {
        path: vault_path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta.clone(),
        body: page.body.clone(),
        kind: resolved_kind.as_str().to_string(),
        inferred,
        project: page.meta.project.clone(),
    }
}

/// Build a `PageDetail` from a (typically already-mutated/consumed) `PageMeta`
/// plus an owned body string and its `VaultPath`.
///
/// Callers MUST pass the page's OWN vault path (create/update sites pass the
/// new/destination path). `meta` is consumed into the returned struct.
pub(crate) fn page_detail_from_meta(
    vault_path: &VaultPath,
    meta: PageMeta,
    body: String,
) -> PageDetail {
    let canonical = if let Some(ref title) = meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    let (resolved_kind, inferred) = crate::vault::kind::resolve(vault_path.as_str(), meta.kind);
    let project = meta.project.clone();

    PageDetail {
        path: vault_path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta,
        body,
        kind: resolved_kind.as_str().to_string(),
        inferred,
        project,
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Map a `pages` row to a `PageSummary`. Both `list_pages` and the folder
/// listing query rely on this shared mapper, so their SELECT statements MUST
/// use the same column order:
/// `id, path, title, canonical_name, kind, kind_inferred, project, <tags subquery>`.
/// The tags subquery is a `group_concat` joined by the unit separator (`char(31)`)
/// so commas in tag text don't fragment the split.
pub(crate) fn page_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PageSummary> {
    let tags_raw: String = row.get(7)?;
    let tags = if tags_raw.is_empty() {
        Vec::new()
    } else {
        tags_raw.split('\u{1f}').map(str::to_string).collect()
    };
    Ok(PageSummary {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        canonical_name: row.get(3)?,
        kind: row.get(4)?,
        inferred: row.get::<_, i64>(5)? != 0,
        project: row.get(6)?,
        tags,
    })
}

#[utoipa::path(
    get,
    path = "/pages",
    context_path = "/api/vault",
    tag = "Pages",
    params(
        ("limit" = Option<u32>, Query, description = "Maximum number of pages to return"),
        ("offset" = Option<u32>, Query, description = "Page offset for pagination")
    ),
    responses(
        (status = 200, description = "List pages", body = PageSummaryListResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_pages(
    State(state): State<Arc<AppState>>,
    Query(pagination): Query<PaginationParams>,
) -> Result<Json<PaginatedResponse<PageSummary>>, ApiError> {
    let pages = state
        .index
        .with_index(move |index, _vault| {
            let mut stmt = index.connection().prepare(
                "SELECT p.id, p.path, p.title, p.canonical_name, p.kind, p.kind_inferred,
                        p.project,
                        COALESCE((SELECT group_concat(t.tag, char(31))
                                    FROM tags t WHERE t.page_id = p.id), '')
                   FROM pages p
                  ORDER BY p.path",
            )?;

            let pages: Vec<PageSummary> = stmt
                .query_map([], page_summary_from_row)?
                .collect::<Result<_, _>>()?;

            Ok::<_, rusqlite::Error>(pages)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(PaginatedResponse::from_vec(pages, &pagination)))
}

#[utoipa::path(
    get,
    path = "/pages/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Vault-relative page path")),
    responses(
        (status = 200, description = "Page detail", body = PageDetailResponse),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<PageDetail>, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    Ok(Json(page_detail_from_page(&page, &vault_path)))
}

#[utoipa::path(
    get,
    path = "/pages/by-id/{uuid}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("uuid" = String, Path, description = "Page UUID")),
    responses(
        (status = 200, description = "Page detail", body = PageDetailResponse),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_page_by_id(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<PageDetail>, ApiError> {
    // Look up the path from the index
    let uuid_clone = uuid.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path FROM pages WHERE id = ?1",
                    params![uuid_clone],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("page not found with id: {uuid}")))?;

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!(
            "page file missing: {page_path}"
        )));
    }

    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    Ok(Json(page_detail_from_page(&page, &vault_path)))
}

#[utoipa::path(
    post,
    path = "/pages/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Vault-relative page path")),
    request_body = CreatePageRequest,
    responses(
        (status = 201, description = "Page created", body = PageDetailResponse),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 409, description = "Page already exists", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<CreatePageRequest>,
) -> Result<Response, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);

    // Create parent directories
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // Build PageMeta
    let mut meta = PageMeta::new();
    if let Some(title) = body.title {
        meta.title = Some(title);
    }
    if let Some(tags) = body.tags {
        meta.tags = tags;
    }
    if let Some(aliases) = body.aliases {
        meta.aliases = aliases;
    }

    let page_body = body.body.unwrap_or_default();

    // Write file atomically: create_new prevents overwriting a file
    // created by a concurrent endpoint (e.g. archive ingest).
    let content = write_page_content(&meta, &page_body);
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs_path)
    {
        Ok(mut file) => {
            file.write_all(content.as_bytes())
                .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(ApiError::conflict(format!("page already exists: {path}")));
        }
        Err(e) => {
            return Err(ApiError::internal(format!("failed to create file: {e}")));
        }
    }

    // Re-index the file
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
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e| ApiError::internal(e.to_string()))?;
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

#[utoipa::path(
    put,
    path = "/pages/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Vault-relative page path")),
    request_body = UpdatePageRequest,
    responses(
        (status = 200, description = "Updated page", body = PageDetailResponse),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn update_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<UpdatePageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    // Read existing page
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let mut meta = page.meta;
    let mut page_body = page.body;

    // Update only provided fields
    if let Some(title) = body.title {
        meta.title = Some(title);
    }
    if let Some(tags) = body.tags {
        meta.tags = tags;
    }
    if let Some(aliases) = body.aliases {
        meta.aliases = aliases;
    }
    if let Some(new_body) = body.body {
        page_body = new_body;
    }

    // Set updated_at
    meta.updated_at = Some(Utc::now());

    // Write back
    let content = write_page_content(&meta, &page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // Re-index
    {
        let vp = vault_path.clone();
        state
            .index
            .with_index(move |index, vault| {
                index.invalidate_links_to(&vp)?;
                index.index_page(vault, &vp)?;
                index.resolve_links_for_page(&vp)?;
                let deps = index.reverse_deps(&vp)?;
                for dep_path in &deps {
                    index.resolve_links_for_page(dep_path)?;
                }
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }

    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    Ok(Json(page_detail_from_meta(&vault_path, meta, page_body)))
}

#[utoipa::path(
    delete,
    path = "/pages/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(
        ("path" = String, Path, description = "Vault-relative page path"),
        ("force" = Option<bool>, Query, description = "Force delete despite backlinks"),
        ("rewrite" = Option<String>, Query, description = "Rewrite mode: plain_text, unlink, or none")
    ),
    responses(
        (status = 204, description = "Page deleted"),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Conflict (backlinks exist)", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn delete_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> Result<Response, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    // Check backlinks if not forcing
    if !query.force {
        let vp_str = vault_path.as_str().to_string();
        let canonical = CanonicalName::from_filename(vault_path.filename());
        let canonical_str = canonical.as_str().to_string();

        let backlinks = state
            .index
            .with_index(move |index, _vault| {
                let page_id: Option<String> = index
                    .connection()
                    .query_row(
                        "SELECT id FROM pages WHERE path = ?1",
                        params![vp_str],
                        |row| row.get(0),
                    )
                    .ok();

                if let Some(ref pid) = page_id {
                    let mut stmt = index
                        .connection()
                        .prepare(
                            "SELECT DISTINCT p.path FROM links l
                             JOIN pages p ON p.id = l.source_id
                             WHERE (l.target_id = ?1 OR l.target_path = ?2 OR l.target_canonical = ?3)
                               AND l.source_id != ?1",
                        )?;

                    let backlinks: Vec<String> = stmt
                        .query_map(
                            params![pid, vp_str, canonical_str],
                            |row| row.get(0),
                        )?
                        .filter_map(|r| r.ok())
                        .collect();

                    Ok(backlinks)
                } else {
                    Ok(Vec::new())
                }
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e: rusqlite::Error| ApiError::internal(e.to_string()))?;

        if !backlinks.is_empty() {
            return Err(ApiError::conflict_with_detail(
                format!(
                    "page has {} backlink(s); use force=true to delete",
                    backlinks.len()
                ),
                serde_json::json!({ "backlinks": backlinks }),
            ));
        }
    }

    // Read page metadata before deletion (needed by delete hooks)
    let page_meta = Page::from_file(&abs_path, vault_path.clone())
        .map(|p| p.meta)
        .ok();

    // Plan and execute the delete
    let rewrite_mode = match query.rewrite.as_str() {
        "unlink" => RewriteMode::Unlink,
        "none" => RewriteMode::None,
        _ => RewriteMode::PlainText,
    };

    {
        let op = MutationOp::DeletePage {
            path: path.clone(),
            rewrite: rewrite_mode,
        };
        let hooks = Arc::clone(&state.hooks);
        state
            .index
            .with_index(move |index, vault| {
                let planner = MutationPlanner::new(vault, index);
                let plan = planner.plan(&op)?;
                plan.execute(vault, index, &hooks)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .map_err(|e| ApiError::internal(format!("mutation failed: {e}")))?
            .map_err(|e| ApiError::internal(format!("mutation failed: {e}")))?;
    }

    // Run post-delete hooks (e.g. CAS ref_count cleanup for archive pages)
    if let Some(ref meta) = page_meta {
        for hook in state.delete_hooks.iter() {
            if let Err(e) = hook.on_page_deleted(&vault_path, &meta.id, meta) {
                tracing::warn!("delete hook error: {e}");
            }
        }
    }

    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![],
        removed: vec![path.clone()],
    });

    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// Move handler
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/pages-move/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Source page path")),
    request_body = MovePageRequest,
    responses(
        (status = 200, description = "Moved page", body = PageDetailResponse),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Destination conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn move_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<MovePageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    // 1. Validate source path exists
    let source_vp =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let source_abs = state.vault.resolve(&source_vp);
    if !source_abs.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    // 2. Validate destination path
    let dest_vp = VaultPath::new(&body.destination)
        .map_err(|e| ApiError::bad_request(format!("invalid destination: {e}")))?;
    let dest_abs = state.vault.resolve(&dest_vp);
    if dest_abs.exists() {
        return Err(ApiError::conflict(format!(
            "destination already exists: {}",
            body.destination
        )));
    }

    // 3. Plan and execute
    {
        let op = MutationOp::MovePage {
            source: path.clone(),
            destination: body.destination.clone(),
        };
        let hooks = Arc::clone(&state.hooks);
        state
            .index
            .with_index(move |index, vault| {
                let planner = MutationPlanner::new(vault, index);
                let plan = planner.plan(&op)?;
                plan.execute(vault, index, &hooks)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .map_err(|e| ApiError::internal(format!("mutation failed: {e}")))?
            .map_err(|e| ApiError::internal(format!("mutation failed: {e}")))?;
    }

    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![body.destination.clone()],
        removed: vec![path.clone()],
    });

    // 4. Return the updated PageDetail
    let dest_abs = state.vault.resolve(&dest_vp);
    let page = Page::from_file(&dest_abs, dest_vp.clone())
        .map_err(|e| ApiError::internal(format!("failed to read moved page: {e}")))?;

    Ok(Json(page_detail_from_page(&page, &dest_vp)))
}

/// Validate a `project` slug before it is persisted to frontmatter and used to
/// build a folder path. Defense-in-depth: `VaultPath::new` rejects `..`
/// downstream, but the value is persisted and Project is defined as a slug, so
/// we reject anything non-slug at the boundary.
fn validate_project_slug(p: &str) -> Result<(), String> {
    if p.is_empty()
        || p.contains("..")
        || p.starts_with('/')
        || p.ends_with('/')
        || p.chars().any(|c| c.is_control() || c == '\0')
    {
        return Err("invalid project name".to_string());
    }
    if p.chars()
        .any(|c| !(c.is_alphanumeric() || c == '-' || c == '_' || c == '/'))
    {
        return Err("invalid project name".to_string());
    }
    Ok(())
}

#[utoipa::path(
    post,
    path = "/pages-assign/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Page path to assign")),
    request_body = AssignRequest,
    responses(
        (status = 200, description = "Assigned + reconciled", body = PageDetailResponse),
        (status = 400, description = "Invalid path or unknown kind", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn assign_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<AssignRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    // 1. Validate + load the page at its current path.
    let vp =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let abs = state.vault.resolve(&vp);
    if !abs.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }
    let mut page = Page::from_file(&abs, vp.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    // No-op guard: nothing to assign means nothing to write/reconcile. Return
    // the current detail without touching the file or the index.
    if body.kind.is_none() && body.project.is_none() && !body.clear_project {
        return Ok(Json(page_detail_from_page(&page, &vp)));
    }

    // 2. Mutate declared kind/project in the loaded meta.
    if let Some(ref token) = body.kind {
        let parsed = crate::vault::kind::Kind::from_token(token)
            .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {token}")))?;
        page.meta.kind = Some(parsed);
    }
    if body.clear_project {
        page.meta.project = None;
    } else if let Some(ref project) = body.project {
        validate_project_slug(project).map_err(ApiError::bad_request)?;
        page.meta.project = Some(project.clone());
    }

    // Stamp updated_at (mirrors update_page). created_at is left intact —
    // Plan 2's filename-date projection derives from created_at.
    page.meta.updated_at = Some(Utc::now());

    // 3. Write the updated frontmatter back to the file in place.
    let content = write_page_content(&page.meta, &page.body);
    std::fs::write(&abs, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // 4 + 5. Reindex at the current path, resolve its links, then reconcile
    // (may move the page + rewrite inbound links). `reconcile_page` needs the
    // `&mut` index, so all steps run inside the same `with_index` closure.
    // Hooks (e.g. AcademicMoveHook) fire on a reconcile move, so forward them.
    let path_for_index = path.clone();
    let hooks = Arc::clone(&state.hooks);
    let clear_project = body.clear_project;
    let declared_kind = page.meta.kind;
    let final_path = state
        .index
        .with_index(move |index, vault| {
            let vp = VaultPath::new(&path_for_index)
                .map_err(|e| crate::vault::index::IndexError::Other(e.to_string()))?;
            index.index_page(vault, &vp)?;
            index.resolve_links_for_page(&vp)?;
            // An explicit clear_project strips the subfolder (deliberate user
            // action). The conservative sweep — reconcile_page via project_path
            // — never strips on absent project, so route explicit clears
            // through project_path_cleared + move_page_to instead.
            let moved = if clear_project {
                match crate::vault::projection::project_path_cleared(&path_for_index, declared_kind)
                {
                    Some(dest) => crate::vault::reconcile::move_page_to(
                        vault,
                        index,
                        &path_for_index,
                        &dest,
                        &hooks,
                    )?,
                    None => None,
                }
            } else {
                crate::vault::reconcile::reconcile_page(vault, index, &path_for_index, &hooks)?
            };
            Ok::<_, crate::vault::index::IndexError>(moved.unwrap_or(path_for_index))
        })
        .await
        .map_err(|e| ApiError::internal(format!("assign failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("assign failed: {e}")))?;

    // 6. Broadcast the change. If the page moved, the old path was removed.
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![final_path.clone()],
        removed: if final_path != path {
            vec![path.clone()]
        } else {
            vec![]
        },
    });

    // 7. Return the PageDetail at the FINAL path.
    let final_vp = VaultPath::new(&final_path)
        .map_err(|e| ApiError::internal(format!("invalid final path: {e}")))?;
    let final_abs = state.vault.resolve(&final_vp);
    let page = Page::from_file(&final_abs, final_vp.clone())
        .map_err(|e| ApiError::internal(format!("failed to read assigned page: {e}")))?;

    Ok(Json(page_detail_from_page(&page, &final_vp)))
}

#[utoipa::path(
    post,
    path = "/pages-assign-bulk",
    context_path = "/api/vault",
    tag = "Pages",
    request_body = BulkAssignRequest,
    responses(
        (status = 200, description = "Per-path assign results", body = BulkAssignResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn assign_bulk(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BulkAssignRequest>,
) -> Result<Json<BulkAssignResponse>, ApiError> {
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for path in body.paths {
        let req = AssignRequest {
            kind: body.kind.clone(),
            project: body.project.clone(),
            clear_project: body.clear_project,
        };
        match assign_page(State(Arc::clone(&state)), Path(path.clone()), Json(req)).await {
            Ok(detail) => moved.push((path, detail.0.path)),
            Err(e) => failed.push((path, e.error)),
        }
    }
    Ok(Json(BulkAssignResponse { moved, failed }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_test_support::make_state;

    #[tokio::test]
    async fn list_returns_kind_inferred_project_and_tags() {
        let (state, _tmp) = make_state().await;

        // Write a page with type: quote, project, and tags
        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();
        let page_content = "\
---\n\
id: 01900000-0000-7000-8000-000000000001\n\
type: quote\n\
project: clepsydra\n\
tags:\n\
  - a\n\
  - b\n\
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
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .unwrap()
            .unwrap();

        // Call the handler
        let resp = list_pages(
            State(state),
            Query(PaginationParams {
                limit: None,
                offset: None,
            }),
        )
        .await
        .unwrap();

        let items = &resp.0.items;
        assert_eq!(items.len(), 1, "expected exactly one page in listing");
        let item = &items[0];
        assert_eq!(item.kind, "QUOTE", "kind should be QUOTE");
        assert!(!item.inferred, "kind should not be inferred when declared");
        assert_eq!(
            item.project.as_deref(),
            Some("clepsydra"),
            "project should be clepsydra"
        );
        let mut actual_tags = item.tags.clone();
        actual_tags.sort();
        assert_eq!(actual_tags, vec!["a".to_string(), "b".to_string()]);
    }

    #[tokio::test]
    async fn detail_returns_kind_and_project() {
        let (state, _tmp) = make_state().await;

        // Write a page with type: quote and project: clepsydra
        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();
        let page_content = "\
---\n\
id: 01900000-0000-7000-8000-000000000002\n\
type: quote\n\
project: clepsydra\n\
---\n\
\n\
Some quoted text.\n";
        std::fs::write(page_dir.join("q.md"), page_content).unwrap();

        let resp = get_page(State(state), Path("notes/q.md".to_string()))
            .await
            .unwrap();

        assert_eq!(resp.0.kind, "QUOTE", "resolved kind should be QUOTE");
        assert!(
            !resp.0.inferred,
            "inferred should be false when type is declared"
        );
        assert_eq!(
            resp.0.project.as_deref(),
            Some("clepsydra"),
            "project should be clepsydra"
        );
    }

    #[tokio::test]
    async fn detail_infers_kind_from_folder() {
        let (state, _tmp) = make_state().await;

        // No `type:` declared — kind should be inferred from the folder.
        let page_dir = state.vault.root().join("journals");
        std::fs::create_dir_all(&page_dir).unwrap();
        std::fs::write(
            page_dir.join("2026-05-31.md"),
            "---\nid: 01900000-0000-7000-8000-000000000003\n---\nbody\n",
        )
        .unwrap();

        let resp = get_page(State(state), Path("journals/2026-05-31.md".to_string()))
            .await
            .unwrap();

        assert_eq!(resp.0.kind, "JOURNAL", "kind should be inferred as JOURNAL");
        assert!(
            resp.0.inferred,
            "inferred should be true when type is absent"
        );
    }

    #[tokio::test]
    async fn assign_kind_writes_frontmatter_and_moves() {
        let (state, _tmp) = make_state().await;

        // Seed a note that lives under notes/ with no declared kind.
        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();
        std::fs::write(
            page_dir.join("q.md"),
            "---\nid: 0190f8a0-0000-7000-8000-00000000000c\n---\nbody\n",
        )
        .unwrap();

        // Index the page so reconcile can plan a move against it.
        let vp = VaultPath::new("notes/q.md").unwrap();
        state
            .index
            .with_index(move |index, vault| {
                index.index_page(vault, &vp)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .unwrap()
            .unwrap();

        let resp = assign_page(
            State(Arc::clone(&state)),
            Path("notes/q.md".to_string()),
            Json(AssignRequest {
                kind: Some("QUOTE".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        // Declaring kind=QUOTE projects the page into quotes/.
        assert_eq!(resp.0.path, "quotes/q.md");
        assert_eq!(resp.0.kind, "QUOTE");
        assert!(!resp.0.inferred, "kind is declared, so not inferred");
        assert_eq!(resp.0.meta.kind, Some(crate::vault::kind::Kind::Quote));

        assert!(
            !state
                .vault
                .resolve(&VaultPath::new("notes/q.md").unwrap())
                .exists(),
            "source file should be gone after reconcile move"
        );
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/q.md").unwrap())
                .exists(),
            "page should now live at quotes/q.md"
        );
    }

    /// Seed a page on disk and index it. Shared by the assign tests below.
    async fn seed_and_index(state: &Arc<AppState>, rel: &str, content: &str) {
        let abs = state.vault.root().join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, content).unwrap();
        let vp = VaultPath::new(rel).unwrap();
        state
            .index
            .with_index(move |index, vault| {
                index.index_page(vault, &vp)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn assign_unknown_kind_returns_400() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000010\n---\nbody\n",
        )
        .await;

        let err = assign_page(
            State(Arc::clone(&state)),
            Path("notes/q.md".to_string()),
            Json(AssignRequest {
                kind: Some("BOGUS".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .expect_err("unknown kind must be rejected");

        assert_eq!(err.status, StatusCode::BAD_REQUEST.as_u16());
        // The source file must be untouched on rejection.
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("notes/q.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn assign_missing_page_returns_404() {
        let (state, _tmp) = make_state().await;

        let err = assign_page(
            State(Arc::clone(&state)),
            Path("notes/nope.md".to_string()),
            Json(AssignRequest {
                kind: Some("QUOTE".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .expect_err("missing page must 404");

        assert_eq!(err.status, StatusCode::NOT_FOUND.as_u16());
    }

    #[tokio::test]
    async fn assign_kind_no_move_when_already_in_folder() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "quotes/x.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000011\n---\nbody\n",
        )
        .await;

        let resp = assign_page(
            State(Arc::clone(&state)),
            Path("quotes/x.md".to_string()),
            Json(AssignRequest {
                kind: Some("QUOTE".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        // Already in the canonical folder: no move.
        assert_eq!(resp.0.path, "quotes/x.md");
        assert_eq!(resp.0.kind, "QUOTE");
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/x.md").unwrap())
                .exists(),
            "page should still exist at quotes/x.md"
        );
    }

    #[tokio::test]
    async fn assign_clear_project_moves_up() {
        // An explicit clear_project strips the subfolder and moves the page up
        // to the top folder (deliberate user action — unlike the conservative
        // passive sweep, which never strips on absent project).
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/clep/x.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000012\nproject: clep\n---\nbody\n",
        )
        .await;

        let resp = assign_page(
            State(Arc::clone(&state)),
            Path("notes/clep/x.md".to_string()),
            Json(AssignRequest {
                kind: None,
                project: None,
                clear_project: true,
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.0.path, "notes/x.md");
        assert_eq!(resp.0.meta.project, None, "project should be cleared in meta");
        assert!(
            !state
                .vault
                .resolve(&VaultPath::new("notes/clep/x.md").unwrap())
                .exists(),
            "source should be gone after the clear move"
        );
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("notes/x.md").unwrap())
                .exists(),
            "page should now live at notes/x.md"
        );
    }

    #[tokio::test]
    async fn assign_rejects_traversal_project() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000013\n---\nbody\n",
        )
        .await;

        let err = assign_page(
            State(Arc::clone(&state)),
            Path("notes/q.md".to_string()),
            Json(AssignRequest {
                kind: None,
                project: Some("../evil".to_string()),
                clear_project: false,
            }),
        )
        .await
        .expect_err("traversal project must be rejected");

        assert_eq!(err.status, StatusCode::BAD_REQUEST.as_u16());
        // File untouched; no escape attempt persisted.
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("notes/q.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn bulk_assign_moves_all_and_reports() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/a.md",
            "---\nid: 0190f8a0-0000-7000-8000-00000000000e\n---\nb\n",
        )
        .await;
        seed_and_index(
            &state,
            "notes/b.md",
            "---\nid: 0190f8a0-0000-7000-8000-00000000000f\n---\nb\n",
        )
        .await;

        let resp = assign_bulk(
            State(Arc::clone(&state)),
            Json(BulkAssignRequest {
                paths: vec!["notes/a.md".into(), "notes/b.md".into()],
                kind: Some("QUOTE".into()),
                project: Some("clep".into()),
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.0.moved.len(), 2);
        assert!(resp.0.failed.is_empty());
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/clep/a.md").unwrap())
                .exists()
        );
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/clep/b.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn bulk_assign_reports_failures() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/a.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000011\n---\nb\n",
        )
        .await;

        let resp = assign_bulk(
            State(Arc::clone(&state)),
            Json(BulkAssignRequest {
                paths: vec!["notes/a.md".into(), "notes/missing.md".into()],
                kind: Some("QUOTE".into()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.0.moved.len(), 1, "the valid page should move");
        assert_eq!(resp.0.failed.len(), 1, "the missing page should fail");
        assert_eq!(resp.0.failed[0].0, "notes/missing.md");
    }
}
