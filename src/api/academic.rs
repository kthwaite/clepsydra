//! API handlers for academic work and annotation management.
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
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use super::pagination::{PaginatedResponse, PaginationParams};
use crate::api::events::SyncNotification;
use crate::vault::academic::{
    AnnotationMeta, AnnotationType, ExternalIds, ReadingStatus, SourceLocation, WorkMeta, WorkType,
    WorkUrls, annotation_meta_to_extra, extra_to_annotation_meta, extra_to_work_meta,
    work_meta_to_extra,
};
use crate::vault::canonical::CanonicalName;
use crate::vault::page::{Page, PageMeta, write_page_content};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
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

#[derive(Debug, Deserialize, ToSchema)]
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

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListWorksQuery {
    pub work_type: Option<String>,
    pub status: Option<String>,
    pub year: Option<i32>,
    pub author: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAnnotationRequest {
    pub work_id: String,
    pub annotation_type: Option<AnnotationType>,
    pub source_asset: Option<String>,
    pub source_location: Option<SourceLocation>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
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

#[derive(Debug, Serialize, ToSchema)]
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

#[derive(Debug, Serialize, ToSchema)]
pub struct WorkSummaryListResponse {
    pub items: Vec<WorkSummary>,
    pub total: u32,
    pub limit: Option<u32>,
    pub offset: u32,
}

#[derive(Debug, Serialize, ToSchema)]
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

#[derive(Debug, Serialize, ToSchema)]
pub struct ImportResult {
    pub cite_key: String,
    pub status: String, // "created" | "skipped" | "updated" | "conflict" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_detail: Option<crate::vault::import_zotero::ConflictDetail>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ImportResponse {
    pub results: Vec<ImportResult>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ImportDoiRequest {
    pub doi: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ImportIsbnRequest {
    pub isbn: String,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/works", get(list_works).post(create_work))
        .route("/works/by-id/{uuid}", get(get_work).put(update_work))
        .route("/works/by-id/{uuid}/annotations", get(list_annotations))
        .route("/annotations", post(create_annotation))
        .route("/import/bibtex", post(import_bibtex))
        .route("/import/doi", post(import_doi))
        .route("/import/isbn", post(import_isbn_handler))
        .route("/import/zotero", post(import_zotero_handler))
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

async fn cite_key_in_use(state: &AppState, cite_key: &str, exclude_page_id: Option<&str>) -> bool {
    let canonical = CanonicalName::new(cite_key);
    let canonical_str = canonical.as_str().to_string();
    let exclude = exclude_page_id.map(|s| s.to_string());

    state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1
                        FROM canonical_names
                        WHERE canonical_name = ?1
                          AND source = 'cite_key'
                          AND (?2 IS NULL OR page_id != ?2)
                    )",
                    params![canonical_str, exclude],
                    |row| row.get::<_, i64>(0),
                )
                .map(|exists| exists > 0)
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Internal work creation logic shared by the create_work endpoint and importers.
pub(crate) async fn create_work_internal(
    state: &AppState,
    title: String,
    work_type: WorkType,
    authors: Vec<String>,
    year: Option<i32>,
    venue: Option<String>,
    publisher: Option<String>,
    status: Option<ReadingStatus>,
    rating: Option<u8>,
    external_ids: Option<ExternalIds>,
    urls: Option<WorkUrls>,
    cite_key: Option<String>,
    tags: Vec<String>,
    aliases: Vec<String>,
    body: Option<String>,
) -> Result<WorkDetail, ApiError> {
    // 1. Validate rating
    if let Some(rating) = rating
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
    if let Some(ref cite_key) = cite_key
        && cite_key_in_use(state, cite_key, None).await
    {
        return Err(ApiError::conflict(format!(
            "cite_key already exists: {cite_key}"
        )));
    }

    // 3. Determine target folder
    let config = state.vault.config();
    let folder = match work_type {
        WorkType::Book => &config.academic.books_folder,
        WorkType::Paper | WorkType::Thesis | WorkType::Report | WorkType::Other => {
            &config.academic.papers_folder
        }
    };

    // 4. Generate path
    let slug = slugify(&title);
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
    meta.title = Some(title.clone());
    meta.tags = tags.clone();
    meta.aliases = aliases;

    let work_meta = WorkMeta {
        work_type: work_type.clone(),
        authors: authors.clone(),
        year,
        venue: venue.clone(),
        publisher: publisher.clone(),
        status: status.clone(),
        rating,
        external_ids: external_ids.clone(),
        urls: urls.clone(),
        assets: Vec::new(),
        cite_key: cite_key.clone(),
        extra: HashMap::new(),
    };
    meta.extra = work_meta_to_extra(&work_meta);

    let page_body = body.unwrap_or_default();

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

    // 8. Send SyncNotification
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // 9. Build response — reconstruct WorkMeta from the extra we just set
    let wm = extra_to_work_meta(&meta.extra);

    Ok(WorkDetail {
        id: meta.id.to_string(),
        path: vault_path.as_str().to_string(),
        title,
        work_type: wm
            .as_ref()
            .map(|w| w.work_type.clone())
            .unwrap_or(work_type),
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
    })
}

#[utoipa::path(
    post,
    path = "/academic/import/bibtex",
    context_path = "/api/vault",
    tag = "Academic",
    request_body(content = String, content_type = "text/plain"),
    responses(
        (status = 200, description = "BibTeX import results", body = ImportResponse),
        (status = 400, description = "Invalid BibTeX", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn import_bibtex(
    State(state): State<Arc<AppState>>,
    body: String,
) -> Result<Json<ImportResponse>, ApiError> {
    let entries =
        crate::vault::import::parse_bibtex(&body).map_err(|e| ApiError::bad_request(e))?;

    let mut results = Vec::with_capacity(entries.len());

    for entry in &entries {
        // Check dedup
        let doi = entry.doi.clone();
        let isbn = entry.isbn.clone();
        let ck = entry.cite_key.clone();
        let existing = state
            .index
            .with_index(move |index, _vault| {
                crate::vault::import::find_existing_work(
                    index.connection(),
                    doi.as_deref(),
                    isbn.as_deref(),
                    Some(&ck),
                )
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;

        if let Some(path) = existing {
            results.push(ImportResult {
                cite_key: entry.cite_key.clone(),
                status: "skipped".to_string(),
                page_path: Some(path),
                error: None,
                conflict_detail: None,
            });
            continue;
        }

        // Create work via shared logic
        match create_work_internal(
            &state,
            entry.title.clone(),
            entry.work_type.clone(),
            entry.authors.clone(),
            entry.year,
            entry.venue.clone(),
            entry.publisher.clone(),
            None, // status
            None, // rating
            Some(ExternalIds {
                doi: entry.doi.clone(),
                isbn: entry.isbn.clone(),
                arxiv: entry.arxiv.clone(),
            }),
            entry.url.as_ref().map(|u| WorkUrls {
                landing: Some(u.clone()),
                pdf: None,
            }),
            Some(entry.cite_key.clone()),
            vec![], // tags
            vec![], // aliases
            None,   // body
        )
        .await
        {
            Ok(detail) => {
                results.push(ImportResult {
                    cite_key: entry.cite_key.clone(),
                    status: "created".to_string(),
                    page_path: Some(detail.path),
                    error: None,
                    conflict_detail: None,
                });
            }
            Err(e) => {
                results.push(ImportResult {
                    cite_key: entry.cite_key.clone(),
                    status: "error".to_string(),
                    page_path: None,
                    error: Some(e.error),
                    conflict_detail: None,
                });
            }
        }
    }

    Ok(Json(ImportResponse { results }))
}

#[utoipa::path(
    post,
    path = "/academic/import/doi",
    context_path = "/api/vault",
    tag = "Academic",
    request_body = ImportDoiRequest,
    responses(
        (status = 200, description = "Work already exists", body = ImportResult),
        (status = 201, description = "Work imported", body = ImportResult),
        (status = 400, description = "Invalid DOI request", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn import_doi(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportDoiRequest>,
) -> Result<Response, ApiError> {
    // 1. Check dedup by DOI
    {
        let doi = req.doi.clone();
        let existing = state
            .index
            .with_index(move |index, _vault| {
                crate::vault::import::find_existing_work(index.connection(), Some(&doi), None, None)
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
        if let Some(path) = existing {
            return Ok((
                StatusCode::OK,
                Json(ImportResult {
                    cite_key: String::new(),
                    status: "skipped".to_string(),
                    page_path: Some(path),
                    error: None,
                    conflict_detail: None,
                }),
            )
                .into_response());
        }
    }

    // 2. Fetch from Crossref
    let json = crate::vault::import_doi::fetch_doi(
        &req.doi,
        crate::vault::import_doi::DEFAULT_CROSSREF_BASE,
    )
    .await
    .map_err(|e| ApiError::bad_request(format!("DOI lookup failed: {e}")))?;

    let entry = crate::vault::import_doi::parse_crossref_response(&json)
        .map_err(|e| ApiError::bad_request(format!("Failed to parse Crossref data: {e}")))?;

    // 3. Create work
    let detail = create_work_internal(
        &state,
        entry.title,
        entry.work_type,
        entry.authors,
        entry.year,
        entry.venue,
        entry.publisher,
        None,
        None,
        Some(ExternalIds {
            doi: entry.doi.clone(),
            isbn: entry.isbn,
            arxiv: entry.arxiv,
        }),
        entry.url.map(|u| WorkUrls {
            landing: Some(u),
            pdf: None,
        }),
        Some(entry.cite_key.clone()),
        vec![],
        vec![],
        None,
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(ImportResult {
            cite_key: entry.cite_key,
            status: "created".to_string(),
            page_path: Some(detail.path),
            error: None,
            conflict_detail: None,
        }),
    )
        .into_response())
}

#[utoipa::path(
    post,
    path = "/academic/import/isbn",
    context_path = "/api/vault",
    tag = "Academic",
    request_body = ImportIsbnRequest,
    responses(
        (status = 200, description = "Work already exists", body = ImportResult),
        (status = 201, description = "Work imported", body = ImportResult),
        (status = 400, description = "Invalid ISBN request", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn import_isbn_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ImportIsbnRequest>,
) -> Result<Response, ApiError> {
    // 1. Check dedup by ISBN
    {
        let isbn = req.isbn.clone();
        let existing = state
            .index
            .with_index(move |index, _vault| {
                crate::vault::import::find_existing_work(
                    index.connection(),
                    None,
                    Some(&isbn),
                    None,
                )
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
        if let Some(path) = existing {
            return Ok((
                StatusCode::OK,
                Json(ImportResult {
                    cite_key: String::new(),
                    status: "skipped".to_string(),
                    page_path: Some(path),
                    error: None,
                    conflict_detail: None,
                }),
            )
                .into_response());
        }
    }

    // 2. Fetch from Open Library
    let (edition_json, author_names) = crate::vault::import_isbn::fetch_isbn(
        &req.isbn,
        crate::vault::import_isbn::DEFAULT_OPENLIBRARY_BASE,
    )
    .await
    .map_err(|e| ApiError::bad_request(format!("ISBN lookup failed: {e}")))?;

    let entry = crate::vault::import_isbn::parse_openlibrary_response(
        &edition_json,
        &author_names,
        &req.isbn,
    )
    .map_err(|e| ApiError::bad_request(format!("Failed to parse Open Library data: {e}")))?;

    // 3. Create work
    let detail = create_work_internal(
        &state,
        entry.title,
        entry.work_type,
        entry.authors,
        entry.year,
        entry.venue,
        entry.publisher,
        None, // status
        None, // rating
        Some(ExternalIds {
            doi: None,
            isbn: entry.isbn,
            arxiv: None,
        }),
        None, // urls
        Some(entry.cite_key.clone()),
        vec![], // tags
        vec![], // aliases
        None,   // body
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(ImportResult {
            cite_key: entry.cite_key,
            status: "created".to_string(),
            page_path: Some(detail.path),
            error: None,
            conflict_detail: None,
        }),
    )
        .into_response())
}

/// Apply source-wins merge: overwrite mapped metadata fields from the import entry,
/// preserving the page body and local-only frontmatter fields.
fn apply_source_wins(
    state: &AppState,
    page_path: &str,
    entry: &crate::vault::import::BibImportEntry,
) -> Result<(), ApiError> {
    let vp = VaultPath::new(page_path)
        .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
    let abs_path = state.vault.resolve(&vp);
    let mut page = Page::from_file(&abs_path, vp.clone())
        .map_err(|e| ApiError::internal(format!("Failed to read page: {e}")))?;
    crate::vault::import_zotero::apply_source_wins_to_meta(&mut page.meta, entry);
    let content = write_page_content(&page.meta, &page.body);
    fs::write(&abs_path, content)
        .map_err(|e| ApiError::internal(format!("Failed to write page: {e}")))?;
    Ok(())
}

/// Patch Zotero import provenance (import map, attachment refs) into the page
/// at `page_path` and reindex it.
async fn patch_zotero_provenance(
    state: &AppState,
    page_path: &str,
    item: &crate::vault::import_zotero::ZoteroItem,
    zotero_data_dir: &std::path::Path,
) -> Result<(), ApiError> {
    let vp = VaultPath::new(page_path)
        .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
    let abs_path = state.vault.resolve(&vp);

    let mut page = Page::from_file(&abs_path, vp.clone())
        .map_err(|e| ApiError::internal(format!("Failed to read page: {e}")))?;

    // Build import section
    let mut import_map = serde_yaml::Mapping::new();
    import_map.insert(
        serde_yaml::Value::String("source".to_string()),
        serde_yaml::Value::String("zotero".to_string()),
    );
    import_map.insert(
        serde_yaml::Value::String("zotero_key".to_string()),
        serde_yaml::Value::String(item.zotero_key.clone()),
    );
    import_map.insert(
        serde_yaml::Value::String("zotero_item_id".to_string()),
        serde_yaml::Value::Number(item.item_id.into()),
    );
    import_map.insert(
        serde_yaml::Value::String("imported_at".to_string()),
        serde_yaml::Value::String(Utc::now().to_rfc3339()),
    );

    page.meta
        .extra
        .insert("import".to_string(), serde_yaml::Value::Mapping(import_map));

    // Resolve and add attachment references
    let mut assets: Vec<String> = Vec::new();
    let mut pdf_url: Option<String> = None;
    for att in &item.pdf_attachments {
        if let Some(resolved) =
            crate::vault::import_zotero::resolve_attachment_path(zotero_data_dir, att)
        {
            match att.link_mode {
                0 | 2 => assets.push(resolved),
                1 | 3 => pdf_url = Some(resolved),
                _ => {}
            }
        }
    }
    if !assets.is_empty() {
        page.meta.extra.insert(
            "assets".to_string(),
            serde_yaml::to_value(&assets).unwrap_or_default(),
        );
    }
    if let Some(url) = pdf_url {
        let urls_val = page
            .meta
            .extra
            .entry("urls".to_string())
            .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
        if let serde_yaml::Value::Mapping(m) = urls_val {
            m.insert(
                serde_yaml::Value::String("pdf".into()),
                serde_yaml::Value::String(url),
            );
        }
    }

    // Write back
    let new_content = write_page_content(&page.meta, &page.body);
    fs::write(&abs_path, new_content)
        .map_err(|e| ApiError::internal(format!("Failed to write page: {e}")))?;

    // Re-index
    state
        .index
        .with_index(move |index, vault| index.index_page(vault, &vp))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(())
}

/// Returns true if a Zotero checkpoint should be saved after this import run.
fn should_save_zotero_checkpoint(results: &[ImportResult]) -> bool {
    let created_count = results.iter().filter(|r| r.status == "created").count() as u64;
    created_count > 0 || results.iter().any(|r| r.status == "skipped")
}

/// Re-index a single page by vault-relative path (used after writing changes
/// during an import).
async fn reindex_page(state: &AppState, path: &str) -> Result<(), ApiError> {
    let vp =
        VaultPath::new(path).map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
    state
        .index
        .with_index(move |index, vault| index.index_page(vault, &vp))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(())
}

/// Handle a dedup-hit on an existing work via the zotero_key path.
///
/// cite_key for Skip/Manual results uses the `zotero:<key>` form; for
/// SourceWins it uses the derived entry cite_key (matching original behavior).
async fn handle_zk_existing(
    state: &AppState,
    item: &crate::vault::import_zotero::ZoteroItem,
    path: String,
    policy: crate::vault::import_zotero::ConflictPolicy,
    dry_run: bool,
    used_cite_keys: &std::collections::HashSet<String>,
) -> Result<ImportResult, ApiError> {
    use crate::vault::import_zotero::{
        ConflictDetail, ItemActionKind, compute_field_diffs, decide_item_action, derive_cite_key,
        format_author, map_to_import_entry,
    };

    let entry = map_to_import_entry(item);

    // Manual policy needs the diffs to distinguish conflict from skipped. Read
    // the page once and reuse the diffs for both `has_diffs` and conflict_detail.
    let diffs = if matches!(policy, crate::vault::import_zotero::ConflictPolicy::Manual) {
        let vp = VaultPath::new(&path)
            .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
        let abs_path = state.vault.resolve(&vp);
        let page = Page::from_file(&abs_path, vp)
            .map_err(|e| ApiError::internal(format!("Failed to read page: {e}")))?;
        Some(compute_field_diffs(&entry, &page.meta))
    } else {
        None
    };
    let has_diffs = diffs.as_ref().is_some_and(|d| !d.is_empty());

    let action = decide_item_action(true, policy, dry_run, has_diffs);

    // SourceWins derives a cite_key (used both in the result and the apply
    // call); Skip/Manual use "zotero:<key>". Derive it once.
    let derived_cite_key = if matches!(
        policy,
        crate::vault::import_zotero::ConflictPolicy::SourceWins
    ) {
        let formatted_authors: Vec<String> = item.authors.iter().map(format_author).collect();
        Some(derive_cite_key(
            item.extra_field.as_deref(),
            &formatted_authors,
            entry.year,
            &item.title,
            used_cite_keys,
        ))
    } else {
        None
    };
    let cite_key = derived_cite_key
        .clone()
        .unwrap_or_else(|| format!("zotero:{}", item.zotero_key));

    // conflict_detail only for Manual conflicts (reuse the diffs read above).
    let conflict_detail = if action.status == "conflict" {
        diffs.map(|fields| ConflictDetail { fields })
    } else {
        None
    };

    if action.kind == ItemActionKind::ApplySourceWins {
        let mut sw_entry = entry;
        sw_entry.cite_key = derived_cite_key.expect("SourceWins derives a cite_key");
        apply_source_wins(state, &path, &sw_entry)?;
        reindex_page(state, &path).await?;
    }

    Ok(ImportResult {
        cite_key,
        status: action.status.to_string(),
        page_path: Some(path),
        error: None,
        conflict_detail,
    })
}

/// Handle a dedup-hit on an existing work via the DOI/ISBN/cite_key path.
///
/// cite_key uses the already-derived `entry.cite_key` (matching original behavior).
async fn handle_doi_existing(
    state: &AppState,
    entry: &crate::vault::import::BibImportEntry,
    path: String,
    policy: crate::vault::import_zotero::ConflictPolicy,
    dry_run: bool,
) -> Result<ImportResult, ApiError> {
    use crate::vault::import_zotero::{
        ConflictDetail, ItemActionKind, compute_field_diffs, decide_item_action,
    };

    // Manual policy: read the page once, reuse the diffs for both the
    // has_diffs decision and the conflict_detail.
    let diffs = if matches!(policy, crate::vault::import_zotero::ConflictPolicy::Manual) {
        let vp = VaultPath::new(&path)
            .map_err(|e| ApiError::internal(format!("Invalid vault path: {e}")))?;
        let abs_path = state.vault.resolve(&vp);
        let page = Page::from_file(&abs_path, vp)
            .map_err(|e| ApiError::internal(format!("Failed to read page: {e}")))?;
        Some(compute_field_diffs(entry, &page.meta))
    } else {
        None
    };
    let has_diffs = diffs.as_ref().is_some_and(|d| !d.is_empty());

    let action = decide_item_action(true, policy, dry_run, has_diffs);

    let conflict_detail = if action.status == "conflict" {
        diffs.map(|fields| ConflictDetail { fields })
    } else {
        None
    };

    if action.kind == ItemActionKind::ApplySourceWins {
        apply_source_wins(state, &path, entry)?;
        reindex_page(state, &path).await?;
    }

    Ok(ImportResult {
        cite_key: entry.cite_key.clone(),
        status: action.status.to_string(),
        page_path: Some(path),
        error: None,
        conflict_detail,
    })
}

#[utoipa::path(
    post,
    path = "/academic/import/zotero",
    context_path = "/api/vault",
    tag = "Academic",
    request_body = crate::vault::import_zotero::ImportZoteroRequest,
    responses(
        (status = 200, description = "Import results", body = ImportResponse),
        (status = 400, description = "Invalid request", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn import_zotero_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<crate::vault::import_zotero::ImportZoteroRequest>,
) -> Result<Json<ImportResponse>, ApiError> {
    use std::collections::HashSet;

    // 1. Resolve DB path
    let db_path = crate::vault::import_zotero::resolve_zotero_db_path(
        req.database_path.as_deref(),
        state
            .vault
            .config()
            .academic
            .zotero
            .database_path
            .as_deref(),
        dirs::home_dir().as_deref(),
    )
    .map_err(ApiError::bad_request)?;

    if !db_path.exists() {
        return Err(ApiError::bad_request(format!(
            "Zotero database not found at: {}",
            db_path.display()
        )));
    }

    // 2. Checkpoint / since resolution
    let checkpoint_since = if req.auto_checkpoint && req.since.is_none() {
        crate::vault::checkpoint::ImportCheckpoint::load(state.vault.root(), "zotero")
            .map(|cp| cp.last_synced)
    } else {
        None
    };

    let effective_since = req
        .since
        .as_deref()
        .map(crate::vault::import_zotero::normalize_since)
        .or(checkpoint_since);

    // 3. Open DB and query items
    let conn = crate::vault::import_zotero::open_zotero_db(&db_path).map_err(ApiError::internal)?;

    let items = crate::vault::import_zotero::query_items(
        &conn,
        req.collection.as_deref(),
        effective_since.as_deref(),
    )
    .map_err(ApiError::internal)?;

    // 4. Build set of existing cite_keys for collision detection
    let mut used_cite_keys: HashSet<String> = state
        .index
        .with_index(|index, _| {
            index
                .connection()
                .prepare("SELECT canonical_name FROM canonical_names WHERE source = 'cite_key'")
                .ok()
                .and_then(|mut stmt| {
                    stmt.query_map([], |row| row.get::<_, String>(0))
                        .ok()
                        .map(|rows| rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_else(HashSet::new)
        })
        .await
        .unwrap_or_else(|_| HashSet::new());

    let zotero_data_dir = db_path
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();

    let mut results = Vec::with_capacity(items.len());

    // 5. Process each item
    for item in &items {
        // a. Dedup by zotero_key
        let zk = item.zotero_key.clone();
        let existing_by_zk = state
            .index
            .with_index(move |index, _vault| {
                crate::vault::import_zotero::find_existing_by_zotero_key(index.connection(), &zk)
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;

        if let Some(path) = existing_by_zk {
            let result = handle_zk_existing(
                &state,
                item,
                path,
                req.conflict_policy,
                req.dry_run,
                &used_cite_keys,
            )
            .await?;
            results.push(result);
            continue;
        }

        // b. Map entry and derive cite_key
        let mut entry = crate::vault::import_zotero::map_to_import_entry(item);
        let formatted_authors: Vec<String> = item
            .authors
            .iter()
            .map(crate::vault::import_zotero::format_author)
            .collect();
        entry.cite_key = crate::vault::import_zotero::derive_cite_key(
            item.extra_field.as_deref(),
            &formatted_authors,
            entry.year,
            &item.title,
            &used_cite_keys,
        );

        // c. Dedup by DOI/ISBN/cite_key
        let doi = entry.doi.clone();
        let isbn = entry.isbn.clone();
        let ck = entry.cite_key.clone();
        let existing = state
            .index
            .with_index(move |index, _vault| {
                crate::vault::import::find_existing_work(
                    index.connection(),
                    doi.as_deref(),
                    isbn.as_deref(),
                    Some(&ck),
                )
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;

        if let Some(path) = existing {
            let result =
                handle_doi_existing(&state, &entry, path, req.conflict_policy, req.dry_run).await?;
            results.push(result);
            continue;
        }

        // Reserve cite_key only after all dedup checks pass
        used_cite_keys.insert(entry.cite_key.clone());

        // d. dry_run — report would_create without creating
        if req.dry_run {
            results.push(ImportResult {
                cite_key: entry.cite_key.clone(),
                status: "would_create".to_string(),
                page_path: None,
                error: None,
                conflict_detail: None,
            });
            continue;
        }

        // e. Create work
        match create_work_internal(
            &state,
            entry.title.clone(),
            entry.work_type.clone(),
            entry.authors.clone(),
            entry.year,
            entry.venue.clone(),
            entry.publisher.clone(),
            None, // status
            None, // rating
            Some(ExternalIds {
                doi: entry.doi.clone(),
                isbn: entry.isbn.clone(),
                arxiv: entry.arxiv.clone(),
            }),
            entry.url.as_ref().map(|u| WorkUrls {
                landing: Some(u.clone()),
                pdf: None,
            }),
            Some(entry.cite_key.clone()),
            vec![], // tags
            vec![], // aliases
            None,   // body
        )
        .await
        {
            Ok(detail) => {
                patch_zotero_provenance(&state, &detail.path, item, &zotero_data_dir).await?;
                results.push(ImportResult {
                    cite_key: entry.cite_key.clone(),
                    status: "created".to_string(),
                    page_path: Some(detail.path),
                    error: None,
                    conflict_detail: None,
                });
            }
            Err(e) => {
                results.push(ImportResult {
                    cite_key: entry.cite_key.clone(),
                    status: "error".to_string(),
                    page_path: None,
                    error: Some(e.error),
                    conflict_detail: None,
                });
            }
        }
    }

    // 6. Save checkpoint after successful import (not on dry_run)
    if req.auto_checkpoint && !req.dry_run && should_save_zotero_checkpoint(&results) {
        let created_count = results.iter().filter(|r| r.status == "created").count() as u64;
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let cp = crate::vault::checkpoint::ImportCheckpoint {
            last_synced: now,
            items_imported: created_count,
        };
        if let Err(e) = cp.save(state.vault.root(), "zotero") {
            tracing::warn!("Failed to save Zotero checkpoint: {e}");
        }
    }

    Ok(Json(ImportResponse { results }))
}

#[cfg(test)]
mod zotero_handler_tests {
    use super::*;

    #[test]
    fn should_save_checkpoint_when_created() {
        let results = vec![ImportResult {
            cite_key: "a".into(),
            status: "created".into(),
            page_path: None,
            error: None,
            conflict_detail: None,
        }];
        assert!(should_save_zotero_checkpoint(&results));
    }

    #[test]
    fn should_save_checkpoint_when_skipped() {
        let results = vec![ImportResult {
            cite_key: "b".into(),
            status: "skipped".into(),
            page_path: Some("p".into()),
            error: None,
            conflict_detail: None,
        }];
        assert!(should_save_zotero_checkpoint(&results));
    }

    #[test]
    fn should_not_save_checkpoint_when_only_errors() {
        let results = vec![ImportResult {
            cite_key: "c".into(),
            status: "error".into(),
            page_path: None,
            error: Some("oops".into()),
            conflict_detail: None,
        }];
        assert!(!should_save_zotero_checkpoint(&results));
    }

    #[test]
    fn should_not_save_checkpoint_for_empty_results() {
        assert!(!should_save_zotero_checkpoint(&[]));
    }
}

#[utoipa::path(
    post,
    path = "/academic/works",
    context_path = "/api/vault",
    tag = "Academic",
    request_body = CreateWorkRequest,
    responses(
        (status = 201, description = "Work created", body = WorkDetail),
        (status = 400, description = "Invalid request", body = ApiError),
        (status = 409, description = "Conflict", body = ApiError),
        (status = 422, description = "Validation error", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_work(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateWorkRequest>,
) -> Result<Response, ApiError> {
    let detail = create_work_internal(
        &state,
        req.title,
        req.work_type,
        req.authors,
        req.year,
        req.venue,
        req.publisher,
        req.status,
        req.rating,
        req.external_ids,
        req.urls,
        req.cite_key,
        req.tags,
        req.aliases,
        req.body,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(detail)).into_response())
}

// ---------------------------------------------------------------------------
// GET /works/by-id/{uuid}
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/academic/works/by-id/{uuid}",
    context_path = "/api/vault",
    tag = "Academic",
    params(("uuid" = String, Path, description = "Work UUID")),
    responses(
        (status = 200, description = "Work detail", body = WorkDetail),
        (status = 404, description = "Work not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_work(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<WorkDetail>, ApiError> {
    // 1. Look up page by UUID in index
    let uuid_clone = uuid.clone();
    let (page_path, meta_json) = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path, meta_json FROM pages WHERE id = ?1",
                    params![uuid_clone],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("work not found: {uuid}")))?;

    // 2. Check that it's a work
    let meta_value: serde_json::Value = serde_json::from_str(&meta_json).unwrap_or_default();
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

#[utoipa::path(
    get,
    path = "/academic/works",
    context_path = "/api/vault",
    tag = "Academic",
    params(ListWorksQuery),
    responses(
        (status = 200, description = "List works", body = WorkSummaryListResponse),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_works(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListWorksQuery>,
) -> Result<Json<PaginatedResponse<WorkSummary>>, ApiError> {
    let works = state
        .index
        .with_index(move |index, _vault| {
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
                .prepare(&sql)?;

            let works: Vec<WorkSummary> = stmt
                .query_map(param_refs.as_slice(), |row| {
                    let id: String = row.get(0)?;
                    let path: String = row.get(1)?;
                    let title: Option<String> = row.get(2)?;
                    let mj: String = row.get(3)?;
                    Ok((id, path, title, mj))
                })?
                .filter_map(|r| r.ok())
                .map(|(id, path, title, mj)| {
                    let meta: serde_json::Value = serde_json::from_str(&mj).unwrap_or_default();
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

            Ok::<_, rusqlite::Error>(works)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let pagination = PaginationParams {
        limit: query.limit,
        offset: query.offset,
    };
    Ok(Json(PaginatedResponse::from_vec(works, &pagination)))
}

// ---------------------------------------------------------------------------
// PUT /works/by-id/{uuid}
// ---------------------------------------------------------------------------

#[utoipa::path(
    put,
    path = "/academic/works/by-id/{uuid}",
    context_path = "/api/vault",
    tag = "Academic",
    params(("uuid" = String, Path, description = "Work UUID")),
    request_body = UpdateWorkRequest,
    responses(
        (status = 200, description = "Updated work", body = WorkDetail),
        (status = 409, description = "Cite key conflict", body = ApiError),
        (status = 404, description = "Work not found", body = ApiError),
        (status = 422, description = "Validation error", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn update_work(
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
    let uuid_for_lookup = uuid.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path, meta_json FROM pages WHERE id = ?1",
                    params![uuid_for_lookup],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let (path, mj) =
        page_path.ok_or_else(|| ApiError::not_found(format!("work not found: {uuid}")))?;
    let meta_value: serde_json::Value = serde_json::from_str(&mj).unwrap_or_default();
    if meta_value.get("kind").and_then(|k| k.as_str()) != Some("work") {
        return Err(ApiError::not_found(format!("not a work: {uuid}")));
    }
    let page_path = path;

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

    if let Some(ref cite_key) = req.cite_key
        && cite_key_in_use(&state, cite_key, Some(uuid.as_str())).await
    {
        return Err(ApiError::conflict(format!(
            "cite_key already exists: {cite_key}"
        )));
    }

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

#[utoipa::path(
    post,
    path = "/academic/annotations",
    context_path = "/api/vault",
    tag = "Academic",
    request_body = CreateAnnotationRequest,
    responses(
        (status = 201, description = "Annotation created", body = AnnotationDetail),
        (status = 400, description = "Invalid request", body = ApiError),
        (status = 404, description = "Work not found", body = ApiError),
        (status = 409, description = "Conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_annotation(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateAnnotationRequest>,
) -> Result<Response, ApiError> {
    // 1. Validate work_id exists and is a work
    let work_id_str = req.work_id.clone();
    let work_path = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path FROM pages WHERE id = ?1 AND json_extract(meta_json, '$.kind') = 'work'",
                    params![work_id_str],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("work not found: {}", req.work_id)))?;

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

#[utoipa::path(
    get,
    path = "/academic/works/by-id/{uuid}/annotations",
    context_path = "/api/vault",
    tag = "Academic",
    params(("uuid" = String, Path, description = "Work UUID")),
    responses(
        (status = 200, description = "List annotations for work", body = [AnnotationDetail]),
        (status = 404, description = "Work not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_annotations(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<Vec<AnnotationDetail>>, ApiError> {
    // Verify the work exists and query annotation pages in a single index access
    let uuid_owned = uuid.clone();
    let rows: Vec<(String, String, String)> = state
        .index
        .with_index(move |index, _vault| {
            // Verify the work exists
            let exists: bool = index
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM pages WHERE id = ?1 AND json_extract(meta_json, '$.kind') = 'work'",
                    params![&uuid_owned],
                    |row| row.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !exists {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            // Query annotation pages linked to this work
            let mut stmt = index
                .connection()
                .prepare(
                    "SELECT id, path, meta_json FROM pages
                     WHERE json_extract(meta_json, '$.kind') = 'annotation'
                       AND json_extract(meta_json, '$.work_id') = ?1
                     ORDER BY path",
                )?;

            let rows = stmt
                .query_map(params![&uuid_owned], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
                })?
                .filter_map(|r| r.ok())
                .collect();

            Ok(rows)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|_| ApiError::not_found(format!("work not found: {uuid}")))?;

    // For each annotation, read the file to get the body
    let mut results = Vec::with_capacity(rows.len());
    for (id, path, mj) in &rows {
        let vault_path = VaultPath::new(path)
            .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;
        let abs_path = state.vault.resolve(&vault_path);
        let page = Page::from_file(&abs_path, vault_path)
            .map_err(|e| ApiError::internal(format!("failed to read annotation: {e}")))?;

        let ann = extra_to_annotation_meta(&page.meta.extra);

        let meta_value: serde_json::Value = serde_json::from_str(mj).unwrap_or_default();

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
