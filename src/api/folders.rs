use std::fs;
use std::path::PathBuf;
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
use crate::vault::canonical::CanonicalName;
use crate::vault::page::Page;
use crate::vault::path::VaultPath;
use crate::vault::rewriter;

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
    // 1. Validate source folder exists
    let source_vp =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let source_abs = state.vault.resolve(&source_vp);
    if !source_abs.is_dir() {
        return Err(ApiError::not_found(format!("folder not found: {path}")));
    }

    // 2. Validate destination doesn't exist
    let dest_vp = VaultPath::new(&body.destination)
        .map_err(|e| ApiError::bad_request(format!("invalid destination: {e}")))?;
    let dest_abs = state.vault.resolve(&dest_vp);
    if dest_abs.exists() {
        return Err(ApiError::conflict(format!(
            "destination already exists: {}",
            body.destination
        )));
    }

    // 3. List all .md files in the source folder
    let mut md_files: Vec<(VaultPath, VaultPath)> = Vec::new(); // (old_vp, new_vp)
    for entry in walkdir::WalkDir::new(&source_abs)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
    {
        let abs = entry.path();
        let rel = abs
            .strip_prefix(state.vault.root())
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        // Compute new path: replace source_vp prefix with dest_vp
        let suffix = rel_str
            .strip_prefix(source_vp.as_str())
            .unwrap_or(&rel_str);
        let new_rel = format!("{}{suffix}", dest_vp.as_str());

        let old_vp = VaultPath::new(&rel_str)
            .map_err(|e| ApiError::internal(format!("invalid path: {e}")))?;
        let new_vp = VaultPath::new(&new_rel)
            .map_err(|e| ApiError::internal(format!("invalid new path: {e}")))?;

        md_files.push((old_vp, new_vp));
    }

    // 4. For each file, compute backlinks and build rewrites
    let mut staged_writes: Vec<(PathBuf, String)> = Vec::new();

    for (old_vp, new_vp) in &md_files {
        let old_stem = old_vp.stem().to_string();
        let new_stem = new_vp.stem().to_string();

        // Get backlink pages from the index
        let backlink_pages = {
            let index = state
                .index
                .lock()
                .map_err(|_| ApiError::internal("index lock poisoned"))?;

            let target_canonical = CanonicalName::new(&old_stem);
            let mut stmt = index
                .connection()
                .prepare(
                    "SELECT DISTINCT l.source_id, p.path
                     FROM links l
                     JOIN pages p ON p.id = l.source_id
                     WHERE l.target_path = ?1 OR l.target_canonical = ?2",
                )
                .map_err(|e| ApiError::internal(e.to_string()))?;

            let pages: Vec<(String, String)> = stmt
                .query_map(
                    params![old_vp.as_str(), target_canonical.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(|e| ApiError::internal(e.to_string()))?
                .filter_map(|r| r.ok())
                .collect();
            pages
        };

        if backlink_pages.is_empty() {
            continue;
        }

        let old_abs = state.vault.resolve(old_vp);

        for (_, ref_path_str) in &backlink_pages {
            let ref_vp = VaultPath::new(ref_path_str)
                .map_err(|e| ApiError::internal(format!("invalid ref path: {e}")))?;
            let ref_abs = state.vault.resolve(&ref_vp);

            let content = fs::read_to_string(&ref_abs)
                .map_err(|e| ApiError::internal(format!("failed to read {ref_path_str}: {e}")))?;

            let mut replacements: Vec<(String, String)> = Vec::new();

            // The stems are the same if the folder just moved (the filename didn't change)
            // but if they differ, rewrite
            if old_stem != new_stem {
                replacements.push((old_stem.clone(), new_stem.clone()));
            }

            // Try to get the title of the source page for [[Title]] style links
            if let Ok(page) = Page::from_file(&old_abs, old_vp.clone())
                && let Some(ref title) = page.meta.title
                && title != &old_stem
                && title != &new_stem
            {
                replacements.push((title.clone(), new_stem.clone()));
            }

            // Markdown links: old relative path -> new relative path
            let old_rel = compute_relative_path(ref_vp.as_str(), old_vp.as_str());
            let new_rel = compute_relative_path(ref_vp.as_str(), new_vp.as_str());
            if old_rel != new_rel {
                replacements.push((old_rel, new_rel));
            }

            if replacements.is_empty() {
                continue;
            }

            let replacement_refs: Vec<(&str, &str)> = replacements
                .iter()
                .map(|(old, new)| (old.as_str(), new.as_str()))
                .collect();

            let new_content = rewriter::rewrite_links_in_content(&content, &replacement_refs);
            if new_content != content {
                // Check if we already have a write staged for this file
                if let Some(existing) = staged_writes.iter_mut().find(|(p, _)| *p == ref_abs) {
                    // Re-apply on the already-rewritten content
                    let re_rewritten =
                        rewriter::rewrite_links_in_content(&existing.1, &replacement_refs);
                    existing.1 = re_rewritten;
                } else {
                    staged_writes.push((ref_abs, new_content));
                }
            }
        }
    }

    // 5. Apply staged writes
    if !staged_writes.is_empty() {
        rewriter::apply_staged_writes(&staged_writes)
            .map_err(|e| ApiError::internal(format!("staged write failed: {e}")))?;
    }

    // 6. Rename the folder
    if let Some(parent) = dest_abs.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }
    fs::rename(&source_abs, &dest_abs)
        .map_err(|e| ApiError::internal(format!("failed to rename folder: {e}")))?;

    // 7. Rebuild index
    {
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;
        index
            .build(&state.vault)
            .map_err(|e| ApiError::internal(format!("index rebuild failed: {e}")))?;
        index
            .resolve_links()
            .map_err(|e| ApiError::internal(format!("link resolution failed: {e}")))?;
    }

    Ok(StatusCode::OK.into_response())
}

/// Compute a relative path from `from_path` to `to_path`, where both are
/// vault-relative paths (e.g. `notes/a.md`, `notes/b.md`).
fn compute_relative_path(from_path: &str, to_path: &str) -> String {
    let from_dir = if let Some(pos) = from_path.rfind('/') {
        &from_path[..pos]
    } else {
        ""
    };

    let to_dir = if let Some(pos) = to_path.rfind('/') {
        &to_path[..pos]
    } else {
        ""
    };

    let to_filename = if let Some(pos) = to_path.rfind('/') {
        &to_path[pos + 1..]
    } else {
        to_path
    };

    if from_dir == to_dir {
        return to_filename.to_string();
    }

    let from_parts: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };

    let to_parts: Vec<&str> = if to_dir.is_empty() {
        Vec::new()
    } else {
        to_dir.split('/').collect()
    };

    let common_len = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let ups = from_parts.len() - common_len;
    let mut result = String::new();
    for _ in 0..ups {
        result.push_str("../");
    }
    for part in &to_parts[common_len..] {
        result.push_str(part);
        result.push('/');
    }
    result.push_str(to_filename);

    result
}
