use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use crate::api::events::SyncNotification;
use crate::vault::academic::{
    ExternalIds, ReadingStatus, WorkMeta, WorkType, WorkUrls, extra_to_work_meta,
    work_meta_to_extra,
};
use crate::vault::canonical::CanonicalName;
use crate::vault::page::{PageMeta, write_page_content};
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/works", post(create_work))
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
