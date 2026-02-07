use std::fs;
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

use super::AppState;
use super::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::canonical::CanonicalName;
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;
use crate::vault::mutation::{MutationOp, MutationPlanner, RewriteMode};

// ---------------------------------------------------------------------------
// Response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PageSummary {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub canonical_name: String,
}

#[derive(Debug, Serialize)]
pub struct PageDetail {
    pub path: String,
    pub canonical_name: String,
    pub meta: PageMeta,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct CreatePageRequest {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

async fn list_pages(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<PageSummary>>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let mut stmt = index
        .connection()
        .prepare("SELECT id, path, title, canonical_name FROM pages ORDER BY path")
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let pages: Vec<PageSummary> = stmt
        .query_map([], |row| {
            Ok(PageSummary {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                canonical_name: row.get(3)?,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(pages))
}

async fn get_page(
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

async fn get_page_by_id(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<PageDetail>, ApiError> {
    // Look up the path from the index
    let page_path = {
        let index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        let path: Option<String> = index
            .connection()
            .query_row(
                "SELECT path FROM pages WHERE id = ?1",
                params![uuid],
                |row| row.get(0),
            )
            .ok();

        path.ok_or_else(|| ApiError::not_found(format!("page not found with id: {uuid}")))?
    };

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

async fn create_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<CreatePageRequest>,
) -> Result<Response, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if abs_path.exists() {
        return Err(ApiError::conflict(format!("page already exists: {path}")));
    }

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

    // Write file
    let content = write_page_content(&meta, &page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // Re-index the file
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;
        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .resolve_links_for_page(&vault_path)
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

async fn update_page(
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
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;
        index
            .invalidate_links_to(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let deps = index
            .reverse_deps(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        for dep_path in &deps {
            index
                .resolve_links_for_page(dep_path)
                .map_err(|e| ApiError::internal(e.to_string()))?;
        }
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

async fn delete_page(
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
        let index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        let page_id: Option<String> = index
            .connection()
            .query_row(
                "SELECT id FROM pages WHERE path = ?1",
                params![vault_path.as_str()],
                |row| row.get(0),
            )
            .ok();

        if let Some(ref pid) = page_id {
            let canonical = CanonicalName::from_filename(vault_path.filename());
            let mut stmt = index
                .connection()
                .prepare(
                    "SELECT DISTINCT p.path FROM links l
                     JOIN pages p ON p.id = l.source_id
                     WHERE (l.target_id = ?1 OR l.target_path = ?2 OR l.target_canonical = ?3)
                       AND l.source_id != ?1",
                )
                .map_err(|e| ApiError::internal(e.to_string()))?;

            let backlinks: Vec<String> = stmt
                .query_map(
                    params![pid, vault_path.as_str(), canonical.as_str()],
                    |row| row.get(0),
                )
                .map_err(|e| ApiError::internal(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();

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
        // index lock dropped here
    }

    // Plan and execute the delete
    let rewrite_mode = match query.rewrite.as_str() {
        "unlink" => RewriteMode::Unlink,
        "none" => RewriteMode::None,
        _ => RewriteMode::PlainText,
    };

    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        let planner = MutationPlanner::new(&state.vault, &index);
        let plan = planner
            .plan(&MutationOp::DeletePage {
                path: path.clone(),
                rewrite: rewrite_mode,
            })
            .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

        plan.execute(&state.vault, &mut index)
            .map_err(|e| ApiError::internal(format!("execute failed: {e}")))?;
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

async fn move_page(
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
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        let planner = MutationPlanner::new(&state.vault, &index);
        let plan = planner
            .plan(&MutationOp::MovePage {
                source: path.clone(),
                destination: body.destination.clone(),
            })
            .map_err(|e| ApiError::internal(format!("plan failed: {e}")))?;

        plan.execute(&state.vault, &mut index)
            .map_err(|e| ApiError::internal(format!("execute failed: {e}")))?;
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

