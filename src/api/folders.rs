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
use super::pages::{PageSummary, page_summary_from_row};
use crate::api::events::SyncNotification;
use crate::vault::mutation::{MutationOp, MutationPlanner};
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
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.is_dir() {
        return Err(ApiError::not_found(format!("folder not found: {path}")));
    }

    let entries = fs::read_dir(&abs_path).map_err(|e| ApiError::internal(e.to_string()))?;

    let (mut folders, md_children) =
        classify_dir_entries(&path, entries.flatten(), |vp| state.vault.is_excluded(vp));

    let mut pages = state
        .index
        .with_index(move |index, _vault| {
            filesystem_authoritative_page_summaries(index, &md_children)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    sort_folder_listing(&mut folders, &mut pages);

    Ok(Json(FolderListing {
        path,
        folders,
        pages,
    }))
}

/// Classify directory entries into (folders, md_children), skipping hidden
/// directories and vault-excluded directories. Pure given an exclusion predicate.
fn classify_dir_entries(
    parent_path: &str,
    entries: impl IntoIterator<Item = std::fs::DirEntry>,
    is_excluded: impl Fn(&VaultPath) -> bool,
) -> (Vec<FolderInfo>, Vec<(String, VaultPath)>) {
    let mut folders = Vec::new();
    let mut md_children: Vec<(String, VaultPath)> = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = format!("{parent_path}/{name}");
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            if name.starts_with('.') {
                continue;
            }
            if let Ok(vp) = VaultPath::new(&child_rel)
                && is_excluded(&vp)
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
    (folders, md_children)
}

/// Build summaries only for markdown files observed in the directory. The
/// index enriches those filesystem members but never contributes membership;
/// a missing index row receives the stable fallback below.
fn filesystem_authoritative_page_summaries(
    index: &crate::vault::index::VaultIndex,
    markdown_files: &[(String, VaultPath)],
) -> rusqlite::Result<Vec<PageSummary>> {
    markdown_files
        .iter()
        .map(|(name, vault_path)| {
            match index.connection().query_row(
                "SELECT p.id, p.path, p.title, p.canonical_name, p.kind, p.kind_inferred,
                        p.project,
                        COALESCE((SELECT group_concat(t.tag, char(31))
                                    FROM tags t WHERE t.page_id = p.id), '')
                   FROM pages p WHERE p.path = ?1",
                params![vault_path.as_str()],
                page_summary_from_row,
            ) {
                Ok(summary) => Ok(summary),
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    Ok(build_page_summary_fallback(name, vault_path))
                }
                Err(error) => Err(error),
            }
        })
        .collect()
}

/// Synthetic page summary for an md file that has no index row yet.
fn build_page_summary_fallback(name: &str, vp: &VaultPath) -> PageSummary {
    PageSummary {
        id: String::new(),
        path: vp.as_str().to_string(),
        title: None,
        canonical_name: name.trim_end_matches(".md").to_string(),
        kind: "NOTE".to_string(),
        inferred: true,
        project: None,
        tags: Vec::new(),
    }
}

/// Sort folders by name and pages by path (in place).
fn sort_folder_listing(folders: &mut [FolderInfo], pages: &mut [PageSummary]) {
    folders.sort_by(|a, b| a.name.cmp(&b.name));
    pages.sort_by(|a, b| a.path.cmp(&b.path));
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_tmp_with_entries() -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("sub")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".hidden")).unwrap();
        std::fs::write(tmp.path().join("note.md"), "# Note").unwrap();
        std::fs::write(tmp.path().join("data.bin"), "binary").unwrap();
        tmp
    }

    #[test]
    fn classify_dir_entries_basic() {
        let tmp = make_tmp_with_entries();
        let entries = std::fs::read_dir(tmp.path()).unwrap().flatten();
        let (folders, md_children) = classify_dir_entries("root", entries, |_| false);

        let folder_names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
        assert!(
            folder_names.contains(&"sub"),
            "expected 'sub' in folders: {folder_names:?}"
        );
        assert!(
            !folder_names.contains(&".hidden"),
            "'.hidden' should be skipped: {folder_names:?}"
        );

        let md_names: Vec<&str> = md_children.iter().map(|(n, _)| n.as_str()).collect();
        assert!(
            md_names.contains(&"note.md"),
            "expected 'note.md' in md_children: {md_names:?}"
        );

        // data.bin should appear in neither
        assert!(
            !md_names.contains(&"data.bin"),
            "data.bin should not appear in md_children"
        );
        assert!(
            !folder_names.contains(&"data.bin"),
            "data.bin should not appear in folders"
        );
    }

    #[test]
    fn classify_dir_entries_exclusion() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("skip")).unwrap();
        let entries = std::fs::read_dir(tmp.path()).unwrap().flatten();
        let (folders, _) =
            classify_dir_entries("root", entries, |vp| vp.as_str().ends_with("skip"));
        assert!(
            folders.is_empty(),
            "excluded dir should not appear in folders: {folders:?}"
        );
    }

    #[test]
    fn build_page_summary_fallback_fields() {
        let vp = VaultPath::new("a/Note.md").unwrap();
        let summary = build_page_summary_fallback("Note.md", &vp);
        assert_eq!(summary.canonical_name, "Note");
        assert_eq!(summary.id, "");
        assert!(summary.title.is_none());
        assert_eq!(summary.path, "a/Note.md");
        assert_eq!(summary.kind, "NOTE");
        assert!(summary.inferred);
        assert!(summary.project.is_none());
        assert!(summary.tags.is_empty());
    }

    #[test]
    fn sort_folder_listing_sorts_correctly() {
        let mut folders = vec![
            FolderInfo {
                name: "b".to_string(),
                path: "root/b".to_string(),
            },
            FolderInfo {
                name: "a".to_string(),
                path: "root/a".to_string(),
            },
        ];
        let mut pages = vec![
            PageSummary {
                id: String::new(),
                path: "x/b".to_string(),
                title: None,
                canonical_name: "b".to_string(),
                kind: "NOTE".to_string(),
                inferred: true,
                project: None,
                tags: Vec::new(),
            },
            PageSummary {
                id: String::new(),
                path: "x/a".to_string(),
                title: None,
                canonical_name: "a".to_string(),
                kind: "NOTE".to_string(),
                inferred: true,
                project: None,
                tags: Vec::new(),
            },
        ];
        sort_folder_listing(&mut folders, &mut pages);
        assert_eq!(folders[0].name, "a");
        assert_eq!(pages[0].path, "x/a");
    }
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
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

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
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;
    let result = state
        .mutation_coordinator
        .delete_folder(&state.vault, &state.index, vault_path, query.recursive)
        .await
        .map_err(|error| match error {
            crate::vault::mutation_coordinator::MutationError::NotFound(_) => {
                ApiError::not_found(format!("folder not found: {path}"))
            }
            error => super::mutation_error(error),
        })?;

    if !result.removed.is_empty() {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: Vec::new(),
            removed: result.removed,
        });
    }
    for (page_path, meta) in &result.hook_targets {
        for hook in state.delete_hooks.iter() {
            if let Err(error) = hook.on_page_deleted(page_path, &meta.id, meta) {
                tracing::warn!("delete hook error for {}: {error}", page_path.as_str());
            }
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Walk a folder and parse markdown frontmatter for each `.md` file, returning
/// `(VaultPath, PageMeta)` pairs suitable for invoking `PostDeleteHook`s.

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
    let source_vp = crate::api::error::parse_request_path(&path, "invalid path")?;
    let source_abs = state.vault.resolve(&source_vp);
    if !source_abs.is_dir() {
        return Err(ApiError::not_found(format!("folder not found: {path}")));
    }

    // Validate destination doesn't exist
    let dest_vp = crate::api::error::parse_request_path(&body.destination, "invalid destination")?;
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
            plan.execute(vault, index, &hooks).map_err(|e| {
                crate::vault::index::IndexError::Other(format!("execute failed: {e}"))
            })?;
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
