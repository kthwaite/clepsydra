use std::collections::HashMap;
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
use crate::vault::academic::{
    AnnotationMeta, AnnotationType, ExternalIds, ReadingStatus, SourceLocation, WorkMeta,
    WorkType, WorkUrls, annotation_meta_to_extra, extra_to_annotation_meta, extra_to_work_meta,
    work_meta_to_extra,
};
use crate::vault::canonical::CanonicalName;
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateWorkRequest {
    pub work_type: WorkType,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub status: Option<ReadingStatus>,
    pub rating: Option<u8>,
    pub external_ids: Option<ExternalIds>,
    pub urls: Option<WorkUrls>,
    pub cite_key: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkRequest {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub status: Option<ReadingStatus>,
    pub rating: Option<u8>,
    pub external_ids: Option<ExternalIds>,
    pub urls: Option<WorkUrls>,
    pub cite_key: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListWorksQuery {
    pub work_type: Option<String>,
    pub status: Option<String>,
    pub year: Option<i32>,
    pub author: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAnnotationRequest {
    pub work_id: String,
    pub annotation_type: Option<AnnotationType>,
    pub source_asset: Option<String>,
    pub source_location: Option<SourceLocation>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkDetail {
    pub id: String,
    pub path: String,
    pub title: String,
    pub work_type: WorkType,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub publisher: Option<String>,
    pub status: Option<ReadingStatus>,
    pub rating: Option<u8>,
    pub external_ids: Option<ExternalIds>,
    pub urls: Option<WorkUrls>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<String>,
    pub cite_key: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct WorkSummary {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub work_type: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub status: Option<String>,
    pub cite_key: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct AnnotationDetail {
    pub id: String,
    pub path: String,
    pub work_id: String,
    pub work_path: Option<String>,
    pub annotation_type: Option<AnnotationType>,
    pub source_asset: Option<String>,
    pub source_location: Option<SourceLocation>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub body: String,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/works", get(list_works).post(create_work))
        .route("/works/by-id/{uuid}", get(get_work).put(update_work))
        .route(
            "/works/by-id/{uuid}/annotations",
            get(list_annotations),
        )
        .route("/annotations", post(create_annotation))
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/// Generate a URL-safe filename slug from a title.
///
/// Lowercase, replace non-alphanumeric chars with hyphens, collapse
/// consecutive hyphens, trim leading/trailing hyphens, append `.md`.
fn slugify(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut slug = String::with_capacity(lower.len());
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else {
            slug.push('-');
        }
    }

    // Collapse consecutive hyphens
    let mut collapsed = String::with_capacity(slug.len());
    let mut prev_dash = false;
    for ch in slug.chars() {
        if ch == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(ch);
            prev_dash = false;
        }
    }

    let trimmed = collapsed.trim_matches('-');
    format!("{trimmed}.md")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn create_work(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateWorkRequest>,
) -> Result<Response, ApiError> {
    // 1. Validate rating
    if let Some(rating) = req.rating
        && !(1..=5).contains(&rating)
    {
        return Err(ApiError {
            status: 422,
            error: "rating must be between 1 and 5".to_string(),
            detail: None,
            hint: None,
        });
    }

    // 2. Check cite_key uniqueness
    if let Some(ref cite_key) = req.cite_key {
        let cn = CanonicalName::new(cite_key);
        let index = state.index.lock();
        let exists: bool = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM canonical_names WHERE canonical_name = ?1",
                params![cn.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if exists {
            return Err(ApiError::conflict(format!(
                "cite_key already exists: {cite_key}"
            )));
        }
    }

    // 3. Determine target folder
    let config = state.vault.config();
    let folder = match req.work_type {
        WorkType::Book => &config.academic.books_folder,
        WorkType::Paper | WorkType::Thesis | WorkType::Report | WorkType::Other => {
            &config.academic.papers_folder
        }
    };

    // 4. Generate path
    let slug = slugify(&req.title);
    let vault_path_str = if folder.is_empty() {
        slug
    } else {
        format!("{folder}/{slug}")
    };
    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if abs_path.exists() {
        return Err(ApiError::conflict(format!(
            "page already exists: {vault_path_str}"
        )));
    }

    // 5. Build PageMeta
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();
    meta.aliases = req.aliases.clone();

    let work_meta = WorkMeta {
        work_type: req.work_type.clone(),
        authors: req.authors.clone(),
        year: req.year,
        venue: req.venue.clone(),
        publisher: req.publisher.clone(),
        status: req.status.clone(),
        rating: req.rating,
        external_ids: req.external_ids.clone(),
        urls: req.urls.clone(),
        assets: Vec::new(),
        cite_key: req.cite_key.clone(),
        extra: HashMap::new(),
    };
    meta.extra = work_meta_to_extra(&work_meta);

    let page_body = req.body.unwrap_or_default();

    // 6. Create parent directories and write file
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    let content = write_page_content(&meta, &page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // 7. Index page + resolve links
    {
        let mut index = state.index.lock();
        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }

    // 8. Send SyncNotification
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // 9. Build response — reconstruct WorkMeta from the extra we just set
    let wm = extra_to_work_meta(&meta.extra);

    Ok((
        StatusCode::CREATED,
        Json(WorkDetail {
            id: meta.id.to_string(),
            path: vault_path.as_str().to_string(),
            title: req.title,
            work_type: wm.as_ref().map(|w| w.work_type.clone()).unwrap_or(req.work_type),
            authors: wm.as_ref().map(|w| w.authors.clone()).unwrap_or_default(),
            year: wm.as_ref().and_then(|w| w.year),
            venue: wm.as_ref().and_then(|w| w.venue.clone()),
            publisher: wm.as_ref().and_then(|w| w.publisher.clone()),
            status: wm.as_ref().and_then(|w| w.status.clone()),
            rating: wm.as_ref().and_then(|w| w.rating),
            external_ids: wm.as_ref().and_then(|w| w.external_ids.clone()),
            urls: wm.as_ref().and_then(|w| w.urls.clone()),
            assets: wm.as_ref().map(|w| w.assets.clone()).unwrap_or_default(),
            cite_key: wm.as_ref().and_then(|w| w.cite_key.clone()),
            tags: meta.tags,
            body: page_body,
        }),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// GET /works/by-id/{uuid}
// ---------------------------------------------------------------------------

async fn get_work(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<WorkDetail>, ApiError> {
    // 1. Look up page by UUID in index
    let (page_path, meta_json) = {
        let index = state.index.lock();
        let row: Option<(String, String)> = index
            .connection()
            .query_row(
                "SELECT path, meta_json FROM pages WHERE id = ?1",
                params![uuid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        row.ok_or_else(|| ApiError::not_found(format!("work not found: {uuid}")))?
    };

    // 2. Check that it's a work
    let meta_value: serde_json::Value =
        serde_json::from_str(&meta_json).unwrap_or_default();
    if meta_value.get("kind").and_then(|k| k.as_str()) != Some("work") {
        return Err(ApiError::not_found(format!("not a work: {uuid}")));
    }

    // 3. Read the file
    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;
    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    // 4. Extract WorkMeta and build response
    let wm = extra_to_work_meta(&page.meta.extra)
        .ok_or_else(|| ApiError::internal("failed to extract work metadata"))?;

    Ok(Json(WorkDetail {
        id: page.meta.id.to_string(),
        path: vault_path.as_str().to_string(),
        title: page.meta.title.unwrap_or_default(),
        work_type: wm.work_type,
        authors: wm.authors,
        year: wm.year,
        venue: wm.venue,
        publisher: wm.publisher,
        status: wm.status,
        rating: wm.rating,
        external_ids: wm.external_ids,
        urls: wm.urls,
        assets: wm.assets,
        cite_key: wm.cite_key,
        tags: page.meta.tags,
        body: page.body,
    }))
}

// ---------------------------------------------------------------------------
// GET /works
// ---------------------------------------------------------------------------

async fn list_works(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListWorksQuery>,
) -> Result<Json<Vec<WorkSummary>>, ApiError> {
    let index = state.index.lock();

    let mut sql = String::from(
        "SELECT p.id, p.path, p.title, p.meta_json FROM pages p
         WHERE json_extract(p.meta_json, '$.kind') = 'work'",
    );
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx = 1u32;

    if let Some(ref wt) = query.work_type {
        sql.push_str(&format!(
            " AND json_extract(p.meta_json, '$.work_type') = ?{param_idx}"
        ));
        param_values.push(Box::new(wt.clone()));
        param_idx += 1;
    }

    if let Some(ref status) = query.status {
        sql.push_str(&format!(
            " AND json_extract(p.meta_json, '$.status') = ?{param_idx}"
        ));
        param_values.push(Box::new(status.clone()));
        param_idx += 1;
    }

    if let Some(year) = query.year {
        sql.push_str(&format!(
            " AND CAST(json_extract(p.meta_json, '$.year') AS INTEGER) = ?{param_idx}"
        ));
        param_values.push(Box::new(year));
        param_idx += 1;
    }

    if let Some(ref author) = query.author {
        sql.push_str(&format!(
            " AND json_extract(p.meta_json, '$.authors') LIKE '%' || ?{param_idx} || '%'"
        ));
        param_values.push(Box::new(author.clone()));
        param_idx += 1;
    }

    if let Some(ref tag) = query.tag {
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM tags WHERE tags.page_id = p.id AND tags.tag = ?{param_idx})"
        ));
        param_values.push(Box::new(tag.clone()));
        param_idx += 1;
    }

    // Suppress unused variable warning
    let _ = param_idx;

    sql.push_str(" ORDER BY p.path");

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|b| b.as_ref()).collect();

    let mut stmt = index
        .connection()
        .prepare(&sql)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let works: Vec<WorkSummary> = stmt
        .query_map(param_refs.as_slice(), |row| {
            let id: String = row.get(0)?;
            let path: String = row.get(1)?;
            let title: Option<String> = row.get(2)?;
            let mj: String = row.get(3)?;
            Ok((id, path, title, mj))
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .map(|(id, path, title, mj)| {
            let meta: serde_json::Value =
                serde_json::from_str(&mj).unwrap_or_default();
            WorkSummary {
                id,
                path,
                title,
                work_type: meta
                    .get("work_type")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                authors: meta
                    .get("authors")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
                year: meta.get("year").and_then(|v| v.as_i64()).map(|n| n as i32),
                status: meta
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                cite_key: meta
                    .get("cite_key")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                tags: meta
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(Json(works))
}

// ---------------------------------------------------------------------------
// PUT /works/by-id/{uuid}
// ---------------------------------------------------------------------------

async fn update_work(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
    Json(req): Json<UpdateWorkRequest>,
) -> Result<Json<WorkDetail>, ApiError> {
    // 1. Validate rating if provided
    if let Some(rating) = req.rating
        && !(1..=5).contains(&rating)
    {
        return Err(ApiError {
            status: 422,
            error: "rating must be between 1 and 5".to_string(),
            detail: None,
            hint: None,
        });
    }

    // 2. Look up page by UUID, verify it's a work
    let page_path = {
        let index = state.index.lock();
        let row: Option<(String, String)> = index
            .connection()
            .query_row(
                "SELECT path, meta_json FROM pages WHERE id = ?1",
                params![uuid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        let (path, mj) =
            row.ok_or_else(|| ApiError::not_found(format!("work not found: {uuid}")))?;
        let meta_value: serde_json::Value =
            serde_json::from_str(&mj).unwrap_or_default();
        if meta_value.get("kind").and_then(|k| k.as_str()) != Some("work") {
            return Err(ApiError::not_found(format!("not a work: {uuid}")));
        }
        path
    };

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;
    let abs_path = state.vault.resolve(&vault_path);

    // 3. Read existing file
    let page = Page::from_file(&abs_path, vault_path.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let mut meta = page.meta;
    let mut page_body = page.body;

    // 4. Extract current WorkMeta
    let mut wm = extra_to_work_meta(&meta.extra)
        .ok_or_else(|| ApiError::internal("failed to extract work metadata"))?;

    // 5. Merge fields
    if let Some(title) = req.title {
        meta.title = Some(title);
    }
    if let Some(tags) = req.tags {
        meta.tags = tags;
    }
    if let Some(aliases) = req.aliases {
        meta.aliases = aliases;
    }
    if let Some(body) = req.body {
        page_body = body;
    }

    if let Some(authors) = req.authors {
        wm.authors = authors;
    }
    if let Some(year) = req.year {
        wm.year = Some(year);
    }
    if let Some(venue) = req.venue {
        wm.venue = Some(venue);
    }
    if let Some(publisher) = req.publisher {
        wm.publisher = Some(publisher);
    }
    if let Some(status) = req.status {
        wm.status = Some(status);
    }
    if let Some(rating) = req.rating {
        wm.rating = Some(rating);
    }
    if let Some(external_ids) = req.external_ids {
        wm.external_ids = Some(external_ids);
    }
    if let Some(urls) = req.urls {
        wm.urls = Some(urls);
    }
    if let Some(cite_key) = req.cite_key {
        wm.cite_key = Some(cite_key);
    }

    // 6. Write back extra and update timestamp
    meta.extra = work_meta_to_extra(&wm);
    meta.updated_at = Some(Utc::now());

    let content = write_page_content(&meta, &page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // 7. Re-index
    {
        let mut index = state.index.lock();
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

    // 8. Send SyncNotification
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // 9. Return updated WorkDetail
    Ok(Json(WorkDetail {
        id: meta.id.to_string(),
        path: vault_path.as_str().to_string(),
        title: meta.title.unwrap_or_default(),
        work_type: wm.work_type,
        authors: wm.authors,
        year: wm.year,
        venue: wm.venue,
        publisher: wm.publisher,
        status: wm.status,
        rating: wm.rating,
        external_ids: wm.external_ids,
        urls: wm.urls,
        assets: wm.assets,
        cite_key: wm.cite_key,
        tags: meta.tags,
        body: page_body,
    }))
}

// ---------------------------------------------------------------------------
// POST /annotations
// ---------------------------------------------------------------------------

async fn create_annotation(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAnnotationRequest>,
) -> Result<Response, ApiError> {
    // 1. Validate work_id exists and is a work
    let work_path = {
        let index = state.index.lock();
        let row: Option<String> = index
            .connection()
            .query_row(
                "SELECT path FROM pages WHERE id = ?1 AND json_extract(meta_json, '$.kind') = 'work'",
                params![req.work_id],
                |row| row.get(0),
            )
            .ok();
        row.ok_or_else(|| {
            ApiError::not_found(format!("work not found: {}", req.work_id))
        })?
    };

    // 2. Generate filename
    let type_prefix = match &req.annotation_type {
        Some(AnnotationType::Highlight) => "highlight",
        Some(AnnotationType::Note) => "note",
        None => "annotation",
    };
    let timestamp = Utc::now().timestamp();
    let filename = format!("{type_prefix}-{timestamp}.md");

    // 3. Determine target folder
    let config = state.vault.config();
    let folder = &config.academic.annotations_folder;
    let vault_path_str = if folder.is_empty() {
        filename
    } else {
        format!("{folder}/{filename}")
    };
    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if abs_path.exists() {
        return Err(ApiError::conflict(format!(
            "annotation file already exists: {vault_path_str}"
        )));
    }

    // 4. Build PageMeta
    let work_id_uuid: uuid::Uuid = req
        .work_id
        .parse()
        .map_err(|e| ApiError::bad_request(format!("invalid work_id UUID: {e}")))?;

    let ann_meta = AnnotationMeta {
        work_id: work_id_uuid,
        work_path: Some(work_path.clone()),
        source_asset: req.source_asset.clone(),
        source_location: req.source_location.clone(),
        annotation_type: req.annotation_type.clone(),
        extra: HashMap::new(),
    };

    let mut meta = PageMeta::new();
    meta.tags = req.tags.clone();
    meta.extra = annotation_meta_to_extra(&ann_meta);

    let page_body = req.body.unwrap_or_default();

    // 5. Create parent directories and write file
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    let content = write_page_content(&meta, &page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    // 6. Index + resolve
    {
        let mut index = state.index.lock();
        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }

    // 7. Send SyncNotification
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // 8. Return 201
    Ok((
        StatusCode::CREATED,
        Json(AnnotationDetail {
            id: meta.id.to_string(),
            path: vault_path.as_str().to_string(),
            work_id: req.work_id,
            work_path: Some(work_path),
            annotation_type: req.annotation_type,
            source_asset: req.source_asset,
            source_location: req.source_location,
            tags: req.tags,
            body: page_body,
        }),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// GET /works/by-id/{uuid}/annotations
// ---------------------------------------------------------------------------

async fn list_annotations(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<Vec<AnnotationDetail>>, ApiError> {
    // Verify the work exists
    {
        let index = state.index.lock();
        let exists: bool = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM pages WHERE id = ?1 AND json_extract(meta_json, '$.kind') = 'work'",
                params![uuid],
                |row| row.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);
        if !exists {
            return Err(ApiError::not_found(format!("work not found: {uuid}")));
        }
    }

    // Query annotation pages linked to this work
    let rows: Vec<(String, String, String)> = {
        let index = state.index.lock();
        let mut stmt = index
            .connection()
            .prepare(
                "SELECT id, path, meta_json FROM pages
                 WHERE json_extract(meta_json, '$.kind') = 'annotation'
                   AND json_extract(meta_json, '$.work_id') = ?1
                 ORDER BY path",
            )
            .map_err(|e| ApiError::internal(e.to_string()))?;

        stmt.query_map(params![uuid], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect()
    };

    // For each annotation, read the file to get the body
    let mut results = Vec::with_capacity(rows.len());
    for (id, path, mj) in &rows {
        let vault_path = VaultPath::new(path)
            .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;
        let abs_path = state.vault.resolve(&vault_path);
        let page = Page::from_file(&abs_path, vault_path)
            .map_err(|e| ApiError::internal(format!("failed to read annotation: {e}")))?;

        let ann = extra_to_annotation_meta(&page.meta.extra);

        let meta_value: serde_json::Value =
            serde_json::from_str(mj).unwrap_or_default();

        results.push(AnnotationDetail {
            id: id.clone(),
            path: path.clone(),
            work_id: ann
                .as_ref()
                .map(|a| a.work_id.to_string())
                .unwrap_or_else(|| {
                    meta_value
                        .get("work_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                }),
            work_path: ann.as_ref().and_then(|a| a.work_path.clone()),
            annotation_type: ann.as_ref().and_then(|a| a.annotation_type.clone()),
            source_asset: ann.as_ref().and_then(|a| a.source_asset.clone()),
            source_location: ann.as_ref().and_then(|a| a.source_location.clone()),
            tags: page.meta.tags,
            body: page.body,
        });
    }

    Ok(Json(results))
}
