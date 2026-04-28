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
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use super::pages::PageSummary;
use crate::api::events::SyncNotification;
use crate::vault::mutation::{MutationOp, MutationPlanner};
use crate::vault::page::{Page, PageMeta};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FolderListing {
    pub path: String,
    pub folders: Vec<FolderInfo>,
    pub pages: Vec<PageSummary>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FolderTreeResponse {
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteFolderQuery {
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct MoveFolderRequest {
    pub destination: String,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_folders))
        .route("/tree", get(list_folder_tree))
        .route(
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

#[utoipa::path(
    get,
    path = "/folders",
    context_path = "/api/vault",
    tag = "Folders",
    responses(
        (status = 200, description = "List top-level folders", body = [FolderInfo]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_folders(
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

#[utoipa::path(
    get,
    path = "/folders/tree",
    context_path = "/api/vault",
    tag = "Folders",
    responses(
        (status = 200, description = "All non-hidden folder paths", body = FolderTreeResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_folder_tree(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FolderTreeResponse>, ApiError> {
    let root = state.vault.root();
    let mut paths = Vec::new();

    for entry in walkdir::WalkDir::new(root).min_depth(1).sort_by_file_name() {
        let entry = entry.map_err(|e| ApiError::internal(e.to_string()))?;
        if !entry.file_type().is_dir() {
            continue;
        }

        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();

        // Skip hidden directories (any segment starting with '.')
        if rel.split('/').any(|seg| seg.starts_with('.')) {
            continue;
        }

        // Skip _attachments and other excluded paths
        if rel.split('/').next() == Some("_attachments") {
            continue;
        }

        if let Ok(vp) = VaultPath::new(&rel)
            && state.vault.is_excluded(&vp)
        {
            continue;
        }

        paths.push(rel);
    }

    Ok(Json(FolderTreeResponse { paths }))
}

#[utoipa::path(
    get,
    path = "/folders/{path}",
    context_path = "/api/vault",
    tag = "Folders",
    params(("path" = String, Path, description = "Vault-relative folder path")),
    responses(
        (status = 200, description = "Folder contents", body = FolderListing),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Folder not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_folder_contents(
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
    let mut md_children: Vec<(String, VaultPath)> = Vec::new();

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
        } else if name.ends_with(".md")
            && let Ok(vp) = VaultPath::new(&child_rel)
        {
            md_children.push((name, vp));
        }
    }

    // Look up all markdown children in the index in one closure
    let pages = state
        .index
        .with_index(move |index, _vault| {
            let mut pages = Vec::new();
            for (name, vp) in &md_children {
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
                    pages.push(PageSummary {
                        id: String::new(),
                        path: vp.as_str().to_string(),
                        title: None,
                        canonical_name: name.trim_end_matches(".md").to_string(),
                    });
                }
            }
            pages
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;

    folders.sort_by(|a, b| a.name.cmp(&b.name));
    let mut pages = pages;
    pages.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(Json(FolderListing {
        path,
        folders,
        pages,
    }))
}

#[utoipa::path(
    post,
    path = "/folders/{path}",
    context_path = "/api/vault",
    tag = "Folders",
    params(("path" = String, Path, description = "Vault-relative folder path")),
    responses(
        (status = 201, description = "Folder created", body = FolderInfo),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_folder(
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

#[utoipa::path(
    delete,
    path = "/folders/{path}",
    context_path = "/api/vault",
    tag = "Folders",
    params(
        ("path" = String, Path, description = "Vault-relative folder path"),
        ("recursive" = Option<bool>, Query, description = "Delete non-empty folders recursively")
    ),
    responses(
        (status = 204, description = "Folder deleted"),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Folder not found", body = ApiError),
        (status = 409, description = "Folder not empty", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn delete_folder(
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

    // Collect page metadata BEFORE deletion so post-delete hooks can run.
    // Pages with unparseable frontmatter are skipped — matches the best-effort
    // semantics used by `delete_page`.
    let hook_targets: Vec<(VaultPath, PageMeta)> = if query.recursive {
        collect_pages_for_hooks(&state, &abs_path)
    } else {
        Vec::new()
    };

    if query.recursive {
        fs::remove_dir_all(&abs_path)
            .map_err(|e| ApiError::internal(format!("failed to delete folder: {e}")))?;
    } else {
        fs::remove_dir(&abs_path).map_err(|e| {
            if matches!(e.raw_os_error(), Some(66) | Some(39))
                || e.to_string().contains("not empty")
                || e.to_string().contains("Directory not empty")
            {
                ApiError::conflict("folder is not empty; use recursive=true to delete")
            } else {
                ApiError::internal(format!("failed to delete folder: {e}"))
            }
        })?;
    }

    // Remove orphaned pages from the index via SyncEngine (handles dependency re-resolution)
    {
        let folder_prefix = format!("{}/", vault_path.as_str());
        let orphaned = state
            .index
            .with_index(move |index, vault| {
                // Find pages that were under this folder
                let orphaned: Vec<String> = {
                    let mut stmt = index
                        .connection()
                        .prepare("SELECT path FROM pages WHERE path LIKE ?1")?;
                    stmt.query_map(params![format!("{}%", folder_prefix)], |row| {
                        row.get::<_, String>(0)
                    })?
                    .filter_map(|r| r.ok())
                    .collect()
                };

                if !orphaned.is_empty() {
                    use crate::vault::sync::{ChangeEvent, SyncEngine};
                    let events: Vec<ChangeEvent> = orphaned
                        .iter()
                        .filter_map(|p| VaultPath::new(p).ok())
                        .map(ChangeEvent::Remove)
                        .collect();
                    SyncEngine::process_events(&events, vault, index)?;
                }

                Ok::<_, crate::vault::index::IndexError>(orphaned)
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(|e| ApiError::internal(e.to_string()))?;

        if !orphaned.is_empty() {
            let _ = state.change_tx.send(SyncNotification::IndexChanged {
                upserted: vec![],
                removed: orphaned,
            });
        }
    }

    // Fire post-delete hooks for each page that was under the folder.
    // Hook errors are logged but do not fail the request (matches `delete_page`).
    for (vp, meta) in &hook_targets {
        for hook in state.delete_hooks.iter() {
            if let Err(e) = hook.on_page_deleted(vp, &meta.id, meta) {
                tracing::warn!("delete hook error for {}: {e}", vp.as_str());
            }
        }
    }

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Walk a folder and parse markdown frontmatter for each `.md` file, returning
/// `(VaultPath, PageMeta)` pairs suitable for invoking `PostDeleteHook`s.
fn collect_pages_for_hooks(
    state: &AppState,
    folder_abs: &std::path::Path,
) -> Vec<(VaultPath, PageMeta)> {
    let root = state.vault.root();
    let mut targets = Vec::new();
    for entry in walkdir::WalkDir::new(folder_abs)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel) = p.strip_prefix(root) else {
            continue;
        };
        let Ok(child_vp) = VaultPath::new(&rel.to_string_lossy()) else {
            continue;
        };
        if let Ok(page) = Page::from_file(p, child_vp.clone()) {
            targets.push((child_vp, page.meta));
        }
    }
    targets
}

// ---------------------------------------------------------------------------
// Move folder handler
// ---------------------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/folders-move/{path}",
    context_path = "/api/vault",
    tag = "Folders",
    params(("path" = String, Path, description = "Source folder path")),
    request_body = MoveFolderRequest,
    responses(
        (status = 200, description = "Folder moved"),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 404, description = "Folder not found", body = ApiError),
        (status = 409, description = "Destination conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn move_folder(
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
    let op = MutationOp::MoveFolder {
        source: path.clone(),
        destination: body.destination.clone(),
    };
    let hooks = Arc::clone(&state.hooks);
    state
        .index
        .with_index(move |index, vault| {
            let planner = MutationPlanner::new(vault, index);
            let plan = planner
                .plan(&op)
                .map_err(|e| crate::vault::index::IndexError::Other(format!("plan failed: {e}")))?;
            plan.execute(vault, index, &hooks)
                .map_err(|e| crate::vault::index::IndexError::Other(format!("execute failed: {e}")))?;
            Ok::<_, crate::vault::index::IndexError>(())
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![body.destination.clone()],
        removed: vec![path.clone()],
    });

    Ok(StatusCode::OK.into_response())
}
