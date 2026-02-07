use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use super::pages::PageDetail;
use crate::vault::canonical::CanonicalName;
use crate::vault::index::UnresolvedReason;
use crate::vault::page::{PageMeta, write_page_content};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct RebuildResponse {
    pages_indexed: usize,
    pages_skipped: usize,
    pages_removed: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct OutlinkEntry {
    target_raw: String,
    target_path: Option<String>,
    target_id: Option<String>,
    kind: String,
    source_field: Option<String>,
}

#[derive(Debug, Serialize)]
struct UnresolvedLink {
    source_id: String,
    source_path: String,
    target_raw: String,
    target_canonical: Option<String>,
    kind: String,
    span_start: i64,
    reason: String,
    candidates: Vec<CandidateEntry>,
}

#[derive(Debug, Serialize)]
struct CandidateEntry {
    page_id: String,
    path: String,
    title: Option<String>,
}

#[derive(Debug, Serialize)]
struct BacklinkEntry {
    source_id: String,
    source_path: String,
    source_title: Option<String>,
    target_raw: String,
    kind: String,
    context: String,
}

#[derive(Debug, Deserialize)]
struct CreateFromLinkRequest {
    target_raw: String,
    #[serde(default)]
    folder: String,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct AmbiguousName {
    canonical_name: String,
    page_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct TagCount {
    tag: String,
    count: i64,
}

#[derive(Debug, Serialize)]
struct VaultStats {
    pages: i64,
    links_total: i64,
    links_resolved: i64,
    links_unresolved: i64,
    tags: i64,
    attachments: i64,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/backlinks/{*path}", get(backlinks))
        .route("/outlinks/{*path}", get(outlinks))
        .route("/unresolved", get(unresolved))
        .route("/ambiguous", get(ambiguous))
        .route("/warnings", get(warnings))
        .route("/tags", get(tags))
        .route("/stats", get(stats))
        .route("/rebuild", post(rebuild_index))
        .route("/create-from-link", post(create_from_link))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn backlinks(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<Vec<BacklinkEntry>>, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let backlinks = index
        .backlinks_with_context(&state.vault, &vault_path, 200)
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

async fn outlinks(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<Vec<OutlinkEntry>>, ApiError> {
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    // Look up the page's UUID from its path
    let page_id: String = index
        .connection()
        .query_row(
            "SELECT id FROM pages WHERE path = ?1",
            params![vault_path.as_str()],
            |row| row.get(0),
        )
        .map_err(|_| ApiError::not_found(format!("page not found in index: {path}")))?;

    let mut stmt = index
        .connection()
        .prepare(
            "SELECT l.target_raw, l.target_path, l.target_id, l.kind, l.source_field
             FROM links l WHERE l.source_id = ?1",
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let links: Vec<OutlinkEntry> = stmt
        .query_map(params![page_id], |row| {
            Ok(OutlinkEntry {
                target_raw: row.get(0)?,
                target_path: row.get(1)?,
                target_id: row.get(2)?,
                kind: row.get(3)?,
                source_field: row.get(4)?,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(links))
}

async fn unresolved(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<UnresolvedLink>>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let details = index
        .unresolved_with_candidates()
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let strategy = state.vault.config().vault.disambiguation_strategy;

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

    Ok(Json(links))
}

async fn ambiguous(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AmbiguousName>>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let mut stmt = index
        .connection()
        .prepare(
            "SELECT cn.canonical_name, GROUP_CONCAT(cn.page_id) as page_ids
             FROM canonical_names cn
             GROUP BY cn.canonical_name
             HAVING COUNT(*) > 1",
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let names: Vec<AmbiguousName> = stmt
        .query_map([], |row| {
            let name: String = row.get(0)?;
            let ids_str: String = row.get(1)?;
            let page_ids: Vec<String> = ids_str.split(',').map(|s| s.to_string()).collect();
            Ok(AmbiguousName {
                canonical_name: name,
                page_ids,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(names))
}

async fn warnings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let warnings = state
        .warnings
        .lock()
        .map_err(|_| ApiError::internal("warnings lock poisoned"))?;

    Ok(Json(warnings.clone()))
}

async fn tags(State(state): State<Arc<AppState>>) -> Result<Json<Vec<TagCount>>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let mut stmt = index
        .connection()
        .prepare("SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC")
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let tag_counts: Vec<TagCount> = stmt
        .query_map([], |row| {
            Ok(TagCount {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(tag_counts))
}

async fn stats(State(state): State<Arc<AppState>>) -> Result<Json<VaultStats>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let conn = index.connection();

    let pages: i64 = conn
        .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let links_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM links", [], |row| row.get(0))
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let links_resolved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let links_unresolved: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let tags_count: i64 = conn
        .query_row("SELECT COUNT(DISTINCT tag) FROM tags", [], |row| row.get(0))
        .map_err(|e| ApiError::internal(e.to_string()))?;

    // Count attachments on disk
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let attachment_dir = state.vault.root().join(attachment_folder);
    let attachments: i64 = if attachment_dir.is_dir() {
        walkdir::WalkDir::new(&attachment_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .count() as i64
    } else {
        0
    };

    Ok(Json(VaultStats {
        pages,
        links_total,
        links_resolved,
        links_unresolved,
        tags: tags_count,
        attachments,
    }))
}

async fn rebuild_index(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let mut index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let build_stats = index
        .build(&state.vault)
        .map_err(|e| ApiError::internal(format!("index build failed: {e}")))?;

    index
        .resolve_links()
        .map_err(|e| ApiError::internal(format!("link resolution failed: {e}")))?;

    // Store warnings for the /warnings endpoint
    {
        let mut warnings = state
            .warnings
            .lock()
            .map_err(|_| ApiError::internal("warnings lock poisoned"))?;
        *warnings = build_stats.warnings.clone();
    }

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

async fn create_from_link(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateFromLinkRequest>,
) -> Result<Response, ApiError> {
    // Generate path from title
    let mut vault_path = VaultPath::from_title(&body.target_raw);

    // Prepend folder if non-empty
    if !body.folder.is_empty() {
        let combined = format!("{}/{}", body.folder.trim_end_matches('/'), vault_path.as_str());
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
        let mut index = state
            .index
            .lock()
            .map_err(|_| ApiError::internal("index lock poisoned"))?;

        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(format!("index failed: {e}")))?;

        index
            .resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(format!("link resolution failed: {e}")))?;
    }

    let canonical = if let Some(ref title) = meta.title {
        CanonicalName::from_title(title)
    } else {
        CanonicalName::from_filename(vault_path.stem())
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
