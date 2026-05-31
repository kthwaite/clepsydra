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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

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
                .query_map([], |row| {
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
                })?
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

    let canonical = if let Some(ref title) = page.meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    Ok(Json(PageDetail {
        path: vault_path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta,
        body: page.body,
    }))
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

    let canonical = if let Some(ref title) = page.meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    Ok(Json(PageDetail {
        path: vault_path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta,
        body: page.body,
    }))
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

    let canonical = if let Some(ref title) = meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    Ok((
        StatusCode::CREATED,
        Json(PageDetail {
            path: vault_path.as_str().to_string(),
            canonical_name: canonical.as_str().to_string(),
            meta,
            body: page_body,
        }),
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

    let canonical = if let Some(ref title) = meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.filename())
    };

    Ok(Json(PageDetail {
        path: vault_path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta,
        body: page_body,
    }))
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

    let canonical = if let Some(ref title) = page.meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(dest_vp.filename())
    };

    Ok(Json(PageDetail {
        path: dest_vp.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta,
        body: page.body,
    }))
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
}
