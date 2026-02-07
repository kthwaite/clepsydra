use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use super::pages::PageSummary;
use crate::api::events::SyncNotification;
use crate::vault::mutation::{MutationOp, MutationPlanner};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct FolderListing {
    pub path: String,
    pub folders: Vec<FolderInfo>,
    pub pages: Vec<PageSummary>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteFolderQuery {
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Deserialize)]
pub struct MoveFolderRequest {
    pub destination: String,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(list_folders)).route(
        "/{*path}",
        get(list_folder_contents)
            .post(create_folder)
            .delete(delete_folder),
    )
}

/// Separate router for folder move operations, nested at `/folders-move`.
pub fn move_router() -> Router<Arc<AppState>> {
    Router::new().route("/{*path}", post(move_folder))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_folders(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<FolderInfo>>, ApiError> {
    let root = state.vault.root();

    let entries = fs::read_dir(root).map_err(|e| ApiError::internal(e.to_string()))?;

    let mut folders = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip excluded directories by checking as a VaultPath
        if let Ok(vp) = VaultPath::new(&name)
            && state.vault.is_excluded(&vp)
        {
            continue;
        }

        // Also skip hidden directories (starting with .)
        if name.starts_with('.') {
            continue;
        }

        folders.push(FolderInfo {
            path: name.clone(),
            name,
        });
    }

    folders.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(folders))
}

async fn list_folder_contents(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<FolderListing>, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.is_dir() {
        return Err(ApiError::not_found(format!("folder not found: {path}")));
    }

    let entries = fs::read_dir(&abs_path).map_err(|e| ApiError::internal(e.to_string()))?;

    let mut folders = Vec::new();
    let mut pages = Vec::new();

    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = format!("{path}/{name}");

        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            // Skip hidden dirs
            if name.starts_with('.') {
                continue;
            }
            if let Ok(vp) = VaultPath::new(&child_rel)
                && state.vault.is_excluded(&vp)
            {
                continue;
            }
            folders.push(FolderInfo {
                name: name.clone(),
                path: child_rel,
            });
        } else if name.ends_with(".md") {
            // Look up in index for summary info
            if let Ok(vp) = VaultPath::new(&child_rel) {
                let summary: Option<PageSummary> = index
                    .connection()
                    .query_row(
                        "SELECT id, path, title, canonical_name FROM pages WHERE path = ?1",
                        params![vp.as_str()],
                        |row| {
                            Ok(PageSummary {
                                id: row.get(0)?,
                                path: row.get(1)?,
                                title: row.get(2)?,
                                canonical_name: row.get(3)?,
                            })
                        },
                    )
                    .ok();

                if let Some(s) = summary {
                    pages.push(s);
                } else {
                    // Not in index yet, just return basic info
                    pages.push(PageSummary {
                        id: String::new(),
                        path: child_rel,
                        title: None,
                        canonical_name: name.trim_end_matches(".md").to_string(),
                    });
                }
            }
        }
    }

    folders.sort_by(|a, b| a.name.cmp(&b.name));
    pages.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(Json(FolderListing {
        path,
        folders,
        pages,
    }))
}

async fn create_folder(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);

    fs::create_dir_all(&abs_path)
        .map_err(|e| ApiError::internal(format!("failed to create folder: {e}")))?;

    Ok((
        StatusCode::CREATED,
        Json(FolderInfo {
            name: vault_path
                .as_str()
                .rsplit('/')
                .next()
                .unwrap_or(vault_path.as_str())
                .to_string(),
            path: vault_path.as_str().to_string(),
        }),
    )
        .into_response())
}

async fn delete_folder(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Query(query): Query<DeleteFolderQuery>,
) -> Result<Response, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.is_dir() {
        return Err(ApiError::not_found(format!("folder not found: {path}")));
    }

    if query.recursive {
        fs::remove_dir_all(&abs_path)
            .map_err(|e| ApiError::internal(format!("failed to delete folder: {e}")))?;
    } else {
        fs::remove_dir(&abs_path).map_err(|e| {
            if e.to_string().contains("not empty")
                || e.to_string().contains("Directory not empty")
                || e.raw_os_error() == Some(66)
            // ENOTEMPTY on macOS
            {
                ApiError::conflict("folder is not empty; use recursive=true to delete")
            } else {
                ApiError::internal(format!("failed to delete folder: {e}"))
            }
        })?;
    }

    // Remove orphaned pages from the index
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        // Find pages that were under this folder
        let folder_prefix = format!("{}/", vault_path.as_str());
        let orphaned: Vec<String> = {
            let mut stmt = index
                .connection()
                .prepare("SELECT path FROM pages WHERE path LIKE ?1")
                .map_err(|e| ApiError::internal(e.to_string()))?;
            stmt.query_map(params![format!("{}%", folder_prefix)], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| ApiError::internal(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect()
        };

        for page_path in &orphaned {
            let vp = VaultPath::new(page_path)
                .map_err(|e| ApiError::internal(format!("invalid path: {e}")))?;
            index
                .invalidate_links_to(&vp)
                .map_err(|e| ApiError::internal(e.to_string()))?;
            index
                .remove_page(&vp)
                .map_err(|e| ApiError::internal(e.to_string()))?;
        }

        if !orphaned.is_empty() {
            let _ = state.change_tx.send(SyncNotification::IndexChanged {
                upserted: vec![],
                removed: orphaned,
            });
        }
    }

    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// Move folder handler
// ---------------------------------------------------------------------------

async fn move_folder(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<MoveFolderRequest>,
) -> Result<Response, ApiError> {
    // Validate source folder exists
    let source_vp =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let source_abs = state.vault.resolve(&source_vp);
    if !source_abs.is_dir() {
        return Err(ApiError::not_found(format!("folder not found: {path}")));
    }

    // Validate destination doesn't exist
    let dest_vp = VaultPath::new(&body.destination)
        .map_err(|e| ApiError::bad_request(format!("invalid destination: {e}")))?;
    let dest_abs = state.vault.resolve(&dest_vp);
    if dest_abs.exists() {
        return Err(ApiError::conflict(format!(
            "destination already exists: {}",
            body.destination
        )));
    }

    // Plan and execute
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        let planner = MutationPlanner::new(&state.vault, &index);
        let plan = planner
            .plan(&MutationOp::MoveFolder {
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

    Ok(StatusCode::OK.into_response())
}
