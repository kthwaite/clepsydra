use std::collections::BTreeSet;
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
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use super::pagination::PaginatedResponse;
use crate::api::events::SyncNotification;
use crate::vault::batch_mutation::{
    BatchMutationCommand, BatchPathIntent, ExpectedPathState,
};
use crate::vault::canonical::CanonicalName;
use crate::vault::encryption::{EncryptionFormat, EncryptionMeta, validate_age_armor};
use crate::vault::mutation::{MutationOp, MutationPlanner, RewriteMode};
use crate::vault::mutation_coordinator::{
    CreatePageCommand, MutationError, MutationNotification, ProjectAssignment, UpdatePageCommand,
};
use crate::vault::new_note::build_note_path;
use crate::vault::page::{Page, PageMeta, page_revision, parse_frontmatter, write_page_content};
use crate::vault::path::VaultPath;
use crate::vault::projection::{project_path, project_path_cleared};
use crate::vault::sync::ChangeEvent;
use crate::vault::task_history::heal_task_update;

// ---------------------------------------------------------------------------
// Response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct PageSummary {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub canonical_name: String,
    #[schema(value_type = crate::vault::kind::Kind)]
    pub kind: String,
    pub inferred: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub tags: Vec<String>,
    pub computed_tags: Vec<String>,
    pub encrypted: bool,
}

#[derive(Debug, Serialize)]
pub struct PageDetail {
    pub path: String,
    pub canonical_name: String,
    pub meta: PageMeta,
    pub computed_tags: Vec<String>,
    pub body: String,
    pub revision: String,
    pub kind: String,
    pub inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub encrypted: bool,
    pub encryption: Option<EncryptionMetaResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<super::conversations::ConversationSummaryResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EncryptionMetaResponse {
    pub format: String,
    pub version: u8,
    pub key_id: String,
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
    pub computed_tags: Vec<String>,
    pub body: String,
    pub revision: String,
    #[schema(value_type = crate::vault::kind::Kind)]
    pub kind: String,
    pub inferred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub encrypted: bool,
    pub encryption: Option<EncryptionMetaResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<super::conversations::ConversationSummaryResponse>,
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
    /// Declared kind token (case-insensitive, e.g. `QUOTE`), written to the
    /// page's `type:` frontmatter as part of the same create mutation.
    #[serde(default)]
    pub kind: Option<crate::vault::kind::Kind>,
    /// Declared project slug, written to the page's `project:` frontmatter as
    /// part of the same create mutation.
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateDefaultPageRequest {
    pub title: String,
    pub body: Option<String>,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct UpdatePageRequest {
    pub expected_revision: String,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ProtectPageRequest {
    pub expected_revision: String,
    pub encryption: EncryptionMetaResponse,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UnprotectPageRequest {
    pub expected_revision: String,
    pub body: String,
}

impl From<&EncryptionMeta> for EncryptionMetaResponse {
    fn from(meta: &EncryptionMeta) -> Self {
        let format = match meta.format {
            EncryptionFormat::Age => "age",
        };
        Self {
            format: format.to_string(),
            version: meta.version,
            key_id: meta.key_id.clone(),
        }
    }
}

impl EncryptionMetaResponse {
    fn into_meta(self) -> Result<EncryptionMeta, ApiError> {
        let format = match self.format.as_str() {
            "age" => EncryptionFormat::Age,
            _ => return Err(ApiError::bad_request("unsupported encryption format")),
        };
        let meta = EncryptionMeta {
            format,
            version: self.version,
            key_id: self.key_id,
        };
        meta.validate()
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        Ok(meta)
    }
}

/// Query parameters for `GET /pages`: pagination plus optional filters.
#[derive(Debug, Deserialize)]
pub struct ListPagesQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// Resolved kind token (case-insensitive).
    pub kind: Option<String>,
    /// Exact tag match.
    pub tag: Option<String>,
    /// Exact declared-project match.
    pub project: Option<String>,
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

#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignRequest {
    /// Declared kind token (case-insensitive, e.g. `QUOTE`). When present and
    /// valid it overwrites the page's `type` frontmatter.
    #[serde(default)]
    pub kind: Option<String>,
    /// Declared project. When present (and `clear_project` is false) it
    /// overwrites the page's `project` frontmatter.
    #[serde(default)]
    pub project: Option<String>,
    /// Clear the page's `project` frontmatter. Takes precedence over `project`.
    #[serde(default)]
    pub clear_project: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BulkAssignRequest {
    /// Page paths assigned as one atomic mutation.
    pub paths: Vec<String>,
    /// Declared kind token applied to every path (see `AssignRequest::kind`).
    #[serde(default)]
    pub kind: Option<String>,
    /// Declared project applied to every path (see `AssignRequest::project`).
    #[serde(default)]
    pub project: Option<String>,
    /// Clear the project on every path (see `AssignRequest::clear_project`).
    #[serde(default)]
    pub clear_project: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BulkAssignResponse {
    /// `original -> final` for every page relocated by the atomic assignment.
    pub moved: Vec<(String, String)>,
    /// Paths assigned successfully without relocation.
    pub unchanged: Vec<String>,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_pages).post(create_default_page))
        .route("/by-id/{uuid}/protect", post(protect_page_by_id))
        .route("/by-id/{uuid}/unprotect", post(unprotect_page_by_id))
        .route("/by-id/{uuid}", get(get_page_by_id).put(update_page_by_id))
        .route(
            "/by-id/{uuid}/properties",
            axum::routing::patch(crate::api::properties::patch_properties),
        )
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

/// Separate router for assign operations, nested at `/pages-assign`.
/// Like `move_router`, the wildcard must terminate the route, so we use
/// `POST /pages-assign/{*path}`.
pub fn assign_router() -> Router<Arc<AppState>> {
    Router::new().route("/{*path}", post(assign_page))
}

// ---------------------------------------------------------------------------
// Canonical PageDetail mapping
// ---------------------------------------------------------------------------

fn sanitize_editable_tags(kind: crate::vault::kind::Kind, tags: &mut Vec<String>) {
    *tags = crate::vault::kind::editable_tags(kind, tags)
        .into_iter()
        .map(str::to_owned)
        .collect();
}

/// Map a complete page returned by reads and mutations into the public detail
/// response without cloning page contents.
pub(crate) fn page_detail(page: Page) -> PageDetail {
    let revision = crate::vault::page::page_revision(&page.raw_content);
    let canonical = page
        .meta
        .title
        .as_deref()
        .map(CanonicalName::from_title)
        .unwrap_or_else(|| CanonicalName::from_filename(page.path.filename()));
    let (kind, inferred) = crate::vault::kind::resolve(page.path.as_str(), page.meta.kind);
    let project = page.meta.project.clone();
    let encryption = page
        .meta
        .encryption
        .as_ref()
        .map(EncryptionMetaResponse::from);
    let encrypted = encryption.is_some();
    let conversation = super::conversations::conversation_summary(&page.meta);
    let mut meta = page.meta;
    sanitize_editable_tags(kind, &mut meta.tags);
    // Conversation identity and ledger hashes are operational metadata, not
    // public page metadata. Keep ordinary reads non-destructive by sanitizing
    // only this response-owned copy.
    meta.extra
        .remove(crate::vault::conversation::CONVERSATION_META_KEY);
    PageDetail {
        path: page.path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta,
        computed_tags: vec![kind.computed_tag().to_owned()],
        body: page.body,
        revision,
        kind: kind.as_str().to_string(),
        inferred,
        project,
        encrypted,
        encryption,
        conversation,
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Map a `pages` row to a `PageSummary`. Both `list_pages` and the folder
/// listing query rely on this shared mapper, so their SELECT statements MUST
/// use the same column order:
/// `id, path, title, canonical_name, kind, kind_inferred, project, encrypted,
/// <effective tags subquery>, <computed tags subquery>`.
/// Tag subqueries are `group_concat` values joined by the unit separator
/// (`char(31)`) so commas in tag text don't fragment the split.
pub(crate) fn page_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PageSummary> {
    fn split_tags(tags_raw: String) -> Vec<String> {
        if tags_raw.is_empty() {
            Vec::new()
        } else {
            tags_raw.split('\u{1f}').map(str::to_string).collect()
        }
    }
    let computed_tags = split_tags(row.get(9)?);
    let mut tags = split_tags(row.get(8)?);
    tags.retain(|tag| {
        !computed_tags
            .iter()
            .any(|computed| tag.trim().eq_ignore_ascii_case(computed.trim()))
    });
    tags.extend(computed_tags.iter().cloned());

    Ok(PageSummary {
        id: row.get(0)?,
        path: row.get(1)?,
        title: row.get(2)?,
        canonical_name: row.get(3)?,
        kind: row.get(4)?,
        inferred: row.get::<_, i64>(5)? != 0,
        project: row.get(6)?,
        encrypted: row.get::<_, i64>(7)? != 0,
        tags,
        computed_tags,
    })
}

#[utoipa::path(
    get,
    path = "/pages",
    context_path = "/api/vault",
    tag = "Pages",
    params(
        ("limit" = Option<u32>, Query, description = "Maximum number of pages to return"),
        ("offset" = Option<u32>, Query, description = "Page offset for pagination"),
        ("kind" = Option<String>, Query, description = "Only pages of this resolved kind token (e.g. QUOTE)"),
        ("tag" = Option<String>, Query, description = "Only pages carrying this tag"),
        ("project" = Option<String>, Query, description = "Only pages declaring this project")
    ),
    responses(
        (status = 200, description = "List pages", body = PageSummaryListResponse),
        (status = 400, description = "Unknown kind token", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_pages(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListPagesQuery>,
) -> Result<Json<PaginatedResponse<PageSummary>>, ApiError> {
    // Validate the kind filter up front: an unknown token is a client error,
    // not an empty result set.
    let kind = query
        .kind
        .as_deref()
        .map(|token| {
            crate::vault::kind::Kind::from_token(token)
                .map(|k| k.as_str().to_string())
                .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {token}")))
        })
        .transpose()?;
    let tag = query.tag.clone();
    let project = query.project.clone();
    let limit = query.limit;
    let offset = query.offset.unwrap_or(0);

    let (pages, total) = state
        .index
        .with_index(move |index, _vault| {
            let mut where_sql = String::new();
            let mut clauses: Vec<&str> = Vec::new();
            let mut values: Vec<rusqlite::types::Value> = Vec::new();
            if let Some(kind) = kind {
                clauses.push("p.kind = ?");
                values.push(kind.into());
            }
            if let Some(tag) = tag {
                clauses
                    .push("EXISTS (SELECT 1 FROM tags t2 WHERE t2.page_id = p.id AND t2.tag = ?)");
                values.push(tag.into());
            }
            if let Some(project) = project {
                clauses.push("p.project = ?");
                values.push(project.into());
            }
            if !clauses.is_empty() {
                where_sql.push_str(" WHERE ");
                where_sql.push_str(&clauses.join(" AND "));
            }

            let count_sql = format!("SELECT COUNT(*) FROM pages p{where_sql}");
            let total = index.connection().query_row(
                &count_sql,
                rusqlite::params_from_iter(values.iter()),
                |row| row.get::<_, u32>(0),
            )?;

            let mut page_sql = String::from(
                "SELECT p.id, p.path, p.title, p.canonical_name, p.kind, p.kind_inferred,
                        p.project, p.encrypted,
                        COALESCE((SELECT group_concat(t.tag, char(31))
                                    FROM tags t WHERE t.page_id = p.id), ''),
                        COALESCE((SELECT group_concat(t.tag, char(31))
                                    FROM tags t
                                   WHERE t.page_id = p.id AND t.computed = 1), '')
                   FROM pages p",
            );
            page_sql.push_str(&where_sql);
            page_sql.push_str(" ORDER BY p.path LIMIT ? OFFSET ?");
            values.push(rusqlite::types::Value::Integer(limit.map_or(-1, i64::from)));
            values.push(rusqlite::types::Value::Integer(i64::from(offset)));

            let mut stmt = index.connection().prepare(&page_sql)?;
            let pages: Vec<PageSummary> = stmt
                .query_map(
                    rusqlite::params_from_iter(values.iter()),
                    page_summary_from_row,
                )?
                .collect::<Result<_, _>>()?;

            Ok::<_, rusqlite::Error>((pages, total))
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(PaginatedResponse {
        items: pages,
        total,
        limit,
        offset,
    }))
}

#[utoipa::path(
    post,
    path = "/pages",
    context_path = "/api/vault",
    tag = "Pages",
    request_body = CreateDefaultPageRequest,
    responses(
        (status = 201, description = "Page created", body = PageDetailResponse),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 409, description = "Page already exists", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_default_page(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateDefaultPageRequest>,
) -> Result<Response, ApiError> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(ApiError::bad_request("title must not be blank"));
    }

    let created = state.clock.now();
    let vault_path = build_note_path(&state.vault, title, created)
        .map_err(|error| ApiError::internal(format!("failed to build note path: {error}")))?;
    let mut meta = PageMeta::new();
    meta.title = Some(title.to_string());
    meta.created_at = Some(created);
    meta.updated_at = Some(created);

    let notify = super::mutation_notifier(state.as_ref());
    let result = state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path,
                meta,
                body: body.body.unwrap_or_default(),
            },
            notify,
        )
        .await
        .map_err(super::mutation_error)?;

    Ok((StatusCode::CREATED, Json(page_detail(result))).into_response())
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
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    Ok(Json(page_detail(page)))
}

const BY_ID_PATH_ATTEMPTS: usize = 8;

async fn indexed_page_path_by_id(state: &AppState, uuid: &str) -> Result<VaultPath, ApiError> {
    let indexed_uuid = uuid.to_string();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path FROM pages WHERE id = ?1",
                    params![indexed_uuid],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("page not found with id: {uuid}")))?;

    crate::api::error::parse_internal_path(&page_path, "invalid stored path")
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
    for _ in 0..BY_ID_PATH_ATTEMPTS {
        let candidate = indexed_page_path_by_id(&state, &uuid).await?;
        state
            .mutation_coordinator
            .observe_page_id_lookup(&candidate);
        let guard = state
            .mutation_coordinator
            .lock_paths(std::slice::from_ref(&candidate))
            .await;
        let confirmed = indexed_page_path_by_id(&state, &uuid).await?;
        if confirmed != candidate {
            drop(guard);
            continue;
        }

        let abs_path = state.vault.resolve(&candidate);
        let page = match Page::from_file(&abs_path, candidate.clone()) {
            Ok(page) => page,
            Err(crate::vault::page::FrontmatterError::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                drop(guard);
                let current = indexed_page_path_by_id(&state, &uuid).await?;
                if current != candidate {
                    continue;
                }
                return Err(ApiError::not_found(format!(
                    "page file missing: {}",
                    candidate.as_str()
                )));
            }
            Err(error) => {
                return Err(ApiError::internal(format!("failed to read page: {error}")));
            }
        };

        if page.meta.id.to_string() != uuid {
            drop(guard);
            let current = indexed_page_path_by_id(&state, &uuid).await?;
            if current != candidate {
                continue;
            }
            return Err(ApiError::internal(format!(
                "indexed page identity mismatch for id: {uuid}"
            )));
        }

        let _guard = guard;
        return Ok(Json(page_detail(page)));
    }

    Err(ApiError::internal(format!(
        "page path did not stabilize for id: {uuid}"
    )))
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
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

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
    // Declared kind/project ride the same create mutation, so a page never
    // exists in a half-assigned state (and a failed create leaves nothing).
    meta.kind = body.kind;
    if let Some(project) = body.project {
        validate_project_slug(&project).map_err(ApiError::bad_request)?;
        meta.project = Some(project);
    }
    let page_body = body.body.unwrap_or_default();

    let notify = super::mutation_notifier(state.as_ref());
    let result = state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path,
                meta,
                body: page_body,
            },
            notify,
        )
        .await
        .map_err(super::mutation_error)?;

    Ok((StatusCode::CREATED, Json(page_detail(result))).into_response())
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
        (status = 409, description = "Page changed since it was loaded", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn update_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<UpdatePageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;
    update_page_at_path(state, vault_path, body, None).await
}

#[utoipa::path(
    put,
    path = "/pages/by-id/{uuid}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("uuid" = String, Path, description = "Page UUID")),
    request_body = UpdatePageRequest,
    responses(
        (status = 200, description = "Updated page", body = PageDetailResponse),
        (status = 400, description = "Invalid input", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Page changed since it was loaded", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn update_page_by_id(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
    Json(body): Json<UpdatePageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    for _ in 0..BY_ID_PATH_ATTEMPTS {
        let candidate = indexed_page_path_by_id(&state, &uuid).await?;
        state
            .mutation_coordinator
            .observe_page_id_lookup(&candidate);
        let attempted = candidate.clone();
        match update_page_at_path(Arc::clone(&state), candidate, body.clone(), Some(&uuid)).await {
            Ok(updated) => return Ok(updated),
            Err(error) if error.status == StatusCode::NOT_FOUND.as_u16() => {
                let current = indexed_page_path_by_id(&state, &uuid).await?;
                if current != attempted {
                    continue;
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        }
    }

    Err(ApiError::internal(format!(
        "page path did not stabilize for id: {uuid}"
    )))
}

#[utoipa::path(
    post,
    path = "/pages/by-id/{uuid}/protect",
    context_path = "/api/vault",
    tag = "Pages",
    params(("uuid" = String, Path, description = "Page UUID")),
    request_body = ProtectPageRequest,
    responses(
        (status = 200, description = "Protected page", body = PageDetailResponse),
        (status = 400, description = "Invalid encryption descriptor or body", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Page changed since it was loaded", body = ApiError),
        (status = 500, description = "Page protected but cache maintenance failed", body = ApiError)
    )
)]
pub async fn protect_page_by_id(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
    Json(body): Json<ProtectPageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    let encryption = body.encryption.into_meta()?;
    validate_age_armor(&body.body)
        .map_err(|error| ApiError::bad_request(format!("invalid encrypted body: {error}")))?;
    transition_page_by_id(
        state,
        &uuid,
        EncryptionTransition::Protect {
            expected_revision: body.expected_revision,
            encryption,
            body: body.body,
        },
    )
    .await
}

#[utoipa::path(
    post,
    path = "/pages/by-id/{uuid}/unprotect",
    context_path = "/api/vault",
    tag = "Pages",
    params(("uuid" = String, Path, description = "Page UUID")),
    request_body = UnprotectPageRequest,
    responses(
        (status = 200, description = "Unprotected page", body = PageDetailResponse),
        (status = 400, description = "Page is not protected", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Page changed since it was loaded", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn unprotect_page_by_id(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
    Json(body): Json<UnprotectPageRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    transition_page_by_id(
        state,
        &uuid,
        EncryptionTransition::Unprotect {
            expected_revision: body.expected_revision,
            body: body.body,
        },
    )
    .await
}

#[derive(Clone)]
enum EncryptionTransition {
    Protect {
        expected_revision: String,
        encryption: EncryptionMeta,
        body: String,
    },
    Unprotect {
        expected_revision: String,
        body: String,
    },
}

impl EncryptionTransition {
    fn expected_revision(&self) -> &str {
        match self {
            Self::Protect {
                expected_revision, ..
            }
            | Self::Unprotect {
                expected_revision, ..
            } => expected_revision,
        }
    }

    fn is_protection(&self) -> bool {
        matches!(self, Self::Protect { .. })
    }
}

async fn transition_page_by_id(
    state: Arc<AppState>,
    uuid: &str,
    transition: EncryptionTransition,
) -> Result<Json<PageDetail>, ApiError> {
    for _ in 0..BY_ID_PATH_ATTEMPTS {
        let candidate = indexed_page_path_by_id(&state, uuid).await?;
        state
            .mutation_coordinator
            .observe_page_id_lookup(&candidate);
        let attempted = candidate.clone();
        match transition_page_at_path(Arc::clone(&state), candidate, uuid, transition.clone()).await
        {
            Ok(updated) => return Ok(updated),
            Err(error) if error.status == StatusCode::NOT_FOUND.as_u16() => {
                let current = indexed_page_path_by_id(&state, uuid).await?;
                if current != attempted {
                    continue;
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        }
    }

    Err(ApiError::internal(format!(
        "page path did not stabilize for id: {uuid}"
    )))
}

async fn transition_page_at_path(
    state: Arc<AppState>,
    vault_path: VaultPath,
    expected_uuid: &str,
    transition: EncryptionTransition,
) -> Result<Json<PageDetail>, ApiError> {
    let page_path = vault_path.as_str().to_string();
    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path.clone()).map_err(|error| match error {
        crate::vault::page::FrontmatterError::Io(error)
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            ApiError::not_found(format!("page not found: {page_path}"))
        }
        error => ApiError::internal(format!("failed to read page: {error}")),
    })?;
    if page.meta.id.to_string() != expected_uuid {
        return Err(ApiError::not_found(format!(
            "page moved while resolving id: {expected_uuid}"
        )));
    }

    let current_revision = page_revision(&page.raw_content);
    if current_revision != transition.expected_revision() {
        return Err(ApiError::revision_conflict(current_revision));
    }
    match &transition {
        EncryptionTransition::Protect { .. } if page.is_encrypted() => {
            return Err(ApiError::bad_request("page is already protected"));
        }
        EncryptionTransition::Unprotect { .. } if !page.is_encrypted() => {
            return Err(ApiError::bad_request("page is not protected"));
        }
        _ => {}
    }

    let expected_content = page.raw_content;
    let mut meta = page.meta;
    let page_body = match transition.clone() {
        EncryptionTransition::Protect {
            encryption, body, ..
        } => {
            meta.encryption = Some(encryption);
            body
        }
        EncryptionTransition::Unprotect { body, .. } => {
            meta.encryption = None;
            body
        }
    };
    meta.updated_at = Some(Utc::now());

    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    let result = match state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            UpdatePageCommand {
                path: vault_path,
                expected_content,
                meta,
                body: page_body,
                project: ProjectAssignment::Unchanged,
                reconcile: false,
            },
            &notify,
        )
        .await
    {
        Ok(result) => result,
        Err(MutationError::Stale(_)) => match fs::read_to_string(&abs_path) {
            Ok(content) => {
                if let Ok((current_meta, _)) = crate::vault::page::parse_frontmatter(&content)
                    && current_meta.id.to_string() != expected_uuid
                {
                    return Err(ApiError::not_found(format!(
                        "page moved while resolving id: {expected_uuid}"
                    )));
                }
                return Err(ApiError::revision_conflict(page_revision(&content)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ApiError::not_found(format!("page not found: {page_path}")));
            }
            Err(error) => {
                return Err(ApiError::internal(format!("failed to read page: {error}")));
            }
        },
        Err(error) => return Err(super::mutation_error(error)),
    };

    if transition.is_protection() {
        state
            .index
            .scrub_deleted_content()
            .await
            .map_err(|_| ApiError::internal("note is protected but the cache scrub failed"))?;
    }

    Ok(Json(page_detail(result)))
}

async fn update_page_at_path(
    state: Arc<AppState>,
    vault_path: VaultPath,
    body: UpdatePageRequest,
    expected_uuid: Option<&str>,
) -> Result<Json<PageDetail>, ApiError> {
    let page_path = vault_path.as_str().to_string();
    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path.clone()).map_err(|error| match error {
        crate::vault::page::FrontmatterError::Io(error)
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            ApiError::not_found(format!("page not found: {page_path}"))
        }
        error => ApiError::internal(format!("failed to read page: {error}")),
    })?;
    if let Some(uuid) = expected_uuid
        && page.meta.id.to_string() != uuid
    {
        return Err(ApiError::not_found(format!(
            "page moved while resolving id: {uuid}"
        )));
    }

    let current_revision = page_revision(&page.raw_content);
    if current_revision != body.expected_revision {
        return Err(ApiError::revision_conflict(current_revision));
    }

    if page.is_encrypted()
        && let Some(new_body) = body.body.as_deref()
    {
        validate_age_armor(new_body).map_err(|error| {
            ApiError::bad_request(format!(
                "protected page body must remain canonical age armor: {error}"
            ))
        })?;
    }

    let expected_content = page.raw_content;
    let mut meta = page.meta;
    let mut page_body = page.body;

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
    meta.updated_at = Some(Utc::now());

    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    let result = match state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            UpdatePageCommand {
                path: vault_path,
                expected_content,
                meta,
                body: page_body,
                project: ProjectAssignment::Unchanged,
                reconcile: false,
            },
            &notify,
        )
        .await
    {
        Ok(result) => result,
        Err(MutationError::Stale(_)) => match fs::read_to_string(&abs_path) {
            Ok(content) => {
                if let Some(uuid) = expected_uuid
                    && let Ok((current_meta, _)) = crate::vault::page::parse_frontmatter(&content)
                    && current_meta.id.to_string() != uuid
                {
                    return Err(ApiError::not_found(format!(
                        "page moved while resolving id: {uuid}"
                    )));
                }
                return Err(ApiError::revision_conflict(page_revision(&content)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ApiError::not_found(format!("page not found: {page_path}")));
            }
            Err(error) => {
                return Err(ApiError::internal(format!("failed to read page: {error}")));
            }
        },
        Err(error) => return Err(super::mutation_error(error)),
    };

    Ok(Json(page_detail(result)))
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
    let vault_path = crate::api::error::parse_request_path(&path, "invalid path")?;

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

    let op = MutationOp::DeletePage {
        path: path.clone(),
        rewrite: rewrite_mode,
    };
    let command = state
        .index
        .with_index(move |index, vault| {
            MutationPlanner::new(vault, index)
                .plan(&op)?
                .into_batch_command(vault)
        })
        .await
        .map_err(|error| ApiError::internal(format!("mutation failed: {error}")))?
        .map_err(|error| ApiError::internal(format!("mutation failed: {error}")))?;
    state
        .mutation_coordinator
        .execute_batch(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            super::mutation_notifier(&state),
        )
        .await
        .map_err(super::mutation_error)?;

    // Run post-delete hooks (e.g. CAS ref_count cleanup for archive pages)
    if let Some(ref meta) = page_meta {
        for hook in state.delete_hooks.iter() {
            if let Err(e) = hook.on_page_deleted(&vault_path, &meta.id, meta) {
                tracing::warn!("delete hook error: {e}");
            }
        }
    }

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
    let source_vp = crate::api::error::parse_request_path(&path, "invalid path")?;
    let dest_vp = crate::api::error::parse_request_path(&body.destination, "invalid destination")?;
    let planning_guard = state
        .mutation_coordinator
        .lock_paths(&[source_vp.clone(), dest_vp.clone()])
        .await;

    let source_abs = state.vault.resolve(&source_vp);
    if !source_abs.exists() {
        return Err(ApiError::not_found(format!("page not found: {path}")));
    }

    let dest_abs = state.vault.resolve(&dest_vp);
    if dest_abs.exists() {
        return Err(ApiError::conflict(format!(
            "destination already exists: {}",
            body.destination
        )));
    }

    let op = MutationOp::MovePage {
        source: path.clone(),
        destination: body.destination.clone(),
    };
    let command = state
        .index
        .with_index(move |index, vault| {
            MutationPlanner::new(vault, index)
                .plan(&op)?
                .into_batch_command(vault)
        })
        .await
        .map_err(|error| ApiError::internal(format!("mutation failed: {error}")))?
        .map_err(|error| ApiError::internal(format!("mutation failed: {error}")))?;
    drop(planning_guard);
    state
        .mutation_coordinator
        .execute_batch(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            super::mutation_notifier(&state),
        )
        .await
        .map_err(super::mutation_error)?;

    let page = Page::from_file(&dest_abs, dest_vp)
        .map_err(|error| ApiError::internal(format!("failed to read moved page: {error}")))?;

    Ok(Json(page_detail(page)))
}

/// Validate a `project` slug before it is persisted to frontmatter and used to
/// build a folder path. Defense-in-depth: `VaultPath::new` rejects `..`
/// downstream, but the value is persisted and Project is defined as a slug, so
/// we reject anything non-slug at the boundary.
pub(super) fn validate_project_slug(p: &str) -> Result<(), String> {
    if p.is_empty()
        || p.contains("..")
        || p.starts_with('/')
        || p.ends_with('/')
        || p.chars().any(|c| c.is_control() || c == '\0')
    {
        return Err("invalid project name".to_string());
    }
    if p.chars()
        .any(|c| !(c.is_alphanumeric() || c == '-' || c == '_' || c == '/'))
    {
        return Err("invalid project name".to_string());
    }
    Ok(())
}

#[utoipa::path(
    post,
    path = "/pages-assign/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Page path to assign")),
    request_body = AssignRequest,
    responses(
        (status = 200, description = "Assigned + reconciled", body = PageDetailResponse),
        (status = 400, description = "Invalid path or unknown kind", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Destination or stale mutation conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn assign_page(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    Json(body): Json<AssignRequest>,
) -> Result<Json<PageDetail>, ApiError> {
    let vp = crate::api::error::parse_request_path(&path, "invalid path")?;
    let abs = state.vault.resolve(&vp);
    let expected_content = fs::read_to_string(&abs).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!("page not found: {path}"))
        } else {
            ApiError::internal(format!("failed to read page: {error}"))
        }
    })?;
    let mut page = Page::from_file(&abs, vp.clone())
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    if body.kind.is_none() && body.project.is_none() && !body.clear_project {
        return Ok(Json(page_detail(page)));
    }

    if let Some(token) = &body.kind {
        let parsed = crate::vault::kind::Kind::from_token(token)
            .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {token}")))?;
        page.meta.kind = Some(parsed);
    }
    let project = if body.clear_project {
        page.meta.project = None;
        ProjectAssignment::Clear
    } else if let Some(project) = &body.project {
        validate_project_slug(project).map_err(ApiError::bad_request)?;
        page.meta.project = Some(project.clone());
        ProjectAssignment::Set(project.clone())
    } else {
        ProjectAssignment::Unchanged
    };
    page.meta.updated_at = Some(Utc::now());

    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    let result = state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            UpdatePageCommand {
                path: vp,
                expected_content,
                meta: page.meta,
                body: page.body,
                project,
                reconcile: true,
            },
            &notify,
        )
        .await
        .map_err(super::mutation_error)?;

    Ok(Json(page_detail(result)))
}

fn read_assignment_page_once(
    state: &AppState,
    path: &VaultPath,
    indexed_paths: &BTreeSet<String>,
) -> Result<(String, PageMeta, String), ApiError> {
    let expected = fs::read(state.vault.resolve(path)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            if indexed_paths.contains(path.as_str()) {
                ApiError::conflict(format!("page changed during mutation: {}", path.as_str()))
            } else {
                ApiError::not_found(format!("page not found: {}", path.as_str()))
            }
        } else {
            ApiError::internal(format!("failed to read page {}: {error}", path.as_str()))
        }
    })?;
    let expected = String::from_utf8(expected).map_err(|error| {
        ApiError::internal(format!(
            "failed to read page {} as UTF-8: {error}",
            path.as_str()
        ))
    })?;
    let (meta, body) = parse_frontmatter(&expected).map_err(|error| {
        ApiError::internal(format!("failed to parse page {}: {error}", path.as_str()))
    })?;
    Ok((expected, meta, body))
}

fn collect_missing_assignment_directories(
    state: &AppState,
    destination: &VaultPath,
    directories: &mut BTreeSet<String>,
) -> Result<(), ApiError> {
    let components = destination.as_str().split('/').collect::<Vec<_>>();
    for end in 1..components.len() {
        let directory = components[..end].join("/");
        let path = VaultPath::new(&directory)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        if !state.vault.resolve(&path).exists() {
            directories.insert(directory);
        }
    }
    Ok(())
}

fn plan_bulk_assignment(
    state: &AppState,
    body: &BulkAssignRequest,
    paths: &[VaultPath],
    indexed_paths: &BTreeSet<String>,
    now: chrono::DateTime<Utc>,
) -> Result<BatchMutationCommand, ApiError> {
    let assigned_kind = body
        .kind
        .as_deref()
        .map(|token| {
            crate::vault::kind::Kind::from_token(token)
                .ok_or_else(|| ApiError::bad_request(format!("unknown kind: {token}")))
        })
        .transpose()?;
    if let Some(project) = &body.project
        && !body.clear_project
    {
        validate_project_slug(project).map_err(ApiError::bad_request)?;
    }

    let source_paths = paths
        .iter()
        .map(|path| path.as_str().to_string())
        .collect::<BTreeSet<_>>();
    let mut final_paths = BTreeSet::new();
    let mut intents = Vec::with_capacity(paths.len() * 2);
    let mut directories = BTreeSet::new();
    let mut upserted = BTreeSet::new();
    let mut removed = BTreeSet::new();
    let mut moved_pages = Vec::new();

    for path in paths {
        let path = path.clone();
        let (expected, mut meta, page_body) =
            read_assignment_page_once(state, &path, indexed_paths)?;
        if let Some(kind) = assigned_kind {
            meta.kind = Some(kind);
        }
        if body.clear_project {
            meta.project = None;
        } else if let Some(project) = &body.project {
            meta.project = Some(project.clone());
        }
        meta.updated_at = Some(now);
        heal_task_update(&path, &expected, &mut meta).map_err(ApiError::bad_request)?;
        let content = write_page_content(&meta, &page_body).into_bytes();
        let projected = if body.clear_project {
            project_path_cleared(path.as_str(), meta.kind)
        } else {
            project_path(path.as_str(), meta.kind, meta.project.as_deref())
        };

        if let Some(destination) = projected {
            let destination =
                crate::api::error::parse_internal_path(&destination, "invalid projected path")?;
            if source_paths.contains(destination.as_str()) && destination != path {
                return Err(ApiError::conflict(format!(
                    "assignment destination is also a source: {}",
                    destination.as_str()
                )));
            }
            if !final_paths.insert(destination.as_str().to_string()) {
                return Err(ApiError::conflict(format!(
                    "duplicate assignment destination: {}",
                    destination.as_str()
                )));
            }
            collect_missing_assignment_directories(state, &destination, &mut directories)?;
            intents.push(BatchPathIntent::Delete {
                path: path.clone(),
                expected: expected.into_bytes(),
            });
            intents.push(BatchPathIntent::Write {
                path: destination.clone(),
                expected: ExpectedPathState::Missing,
                content,
            });
            removed.insert(path.as_str().to_string());
            upserted.insert(destination.as_str().to_string());
            moved_pages.push((path, destination));
        } else {
            if !final_paths.insert(path.as_str().to_string()) {
                return Err(ApiError::conflict(format!(
                    "duplicate assignment destination: {}",
                    path.as_str()
                )));
            }
            upserted.insert(path.as_str().to_string());
            intents.push(BatchPathIntent::Write {
                path,
                expected: ExpectedPathState::Bytes(expected.into_bytes()),
                content,
            });
        }
    }

    let mut index_events = Vec::with_capacity(upserted.len() + removed.len());
    for path in upserted {
        index_events.push(ChangeEvent::Upsert(
            VaultPath::new(&path).map_err(|error| ApiError::internal(error.to_string()))?,
        ));
    }
    for path in removed {
        index_events.push(ChangeEvent::Remove(
            VaultPath::new(&path).map_err(|error| ApiError::internal(error.to_string()))?,
        ));
    }
    let create_directories = directories
        .into_iter()
        .map(|path| VaultPath::new(&path).map_err(|error| ApiError::internal(error.to_string())))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(BatchMutationCommand {
        intents,
        create_directories,
        remove_directories: Vec::new(),
        index_events,
        moved_pages,
    })
}

#[utoipa::path(
    post,
    path = "/pages-assign-bulk",
    context_path = "/api/vault",
    tag = "Pages",
    request_body = BulkAssignRequest,
    responses(
        (status = 200, description = "All pages assigned atomically", body = BulkAssignResponse),
        (status = 400, description = "Invalid path, kind, project, or duplicate", body = ApiError),
        (status = 404, description = "Page not found", body = ApiError),
        (status = 409, description = "Destination or stale mutation conflict", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn assign_bulk(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BulkAssignRequest>,
) -> Result<Json<BulkAssignResponse>, ApiError> {
    if body.paths.is_empty() {
        return Ok(Json(BulkAssignResponse {
            moved: Vec::new(),
            unchanged: Vec::new(),
        }));
    }

    let mut seen_paths = BTreeSet::new();
    let mut normalized_paths = Vec::with_capacity(body.paths.len());
    for requested in &body.paths {
        let path = crate::api::error::parse_request_path(requested, "invalid path")?;
        if !seen_paths.insert(path.as_str().to_string()) {
            return Err(ApiError::bad_request(format!(
                "duplicate assignment path: {}",
                path.as_str()
            )));
        }
        normalized_paths.push(path);
    }
    let requested_paths = normalized_paths
        .iter()
        .map(|path| path.as_str().to_string())
        .collect::<Vec<_>>();
    let indexed_paths = state
        .index
        .with_index(move |index, _vault| {
            let mut indexed = BTreeSet::new();
            let mut statement = index
                .connection()
                .prepare("SELECT 1 FROM pages WHERE path = ?1")?;
            for path in requested_paths {
                if statement.exists([path.as_str()])? {
                    indexed.insert(path);
                }
            }
            Ok::<_, rusqlite::Error>(indexed)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))?;

    if body.kind.is_none() && body.project.is_none() && !body.clear_project {
        for path in &normalized_paths {
            read_assignment_page_once(&state, path, &indexed_paths)?;
        }
        return Ok(Json(BulkAssignResponse {
            moved: Vec::new(),
            unchanged: normalized_paths
                .into_iter()
                .map(|path| path.as_str().to_string())
                .collect(),
        }));
    }

    let command = plan_bulk_assignment(
        &state,
        &body,
        &normalized_paths,
        &indexed_paths,
        state.clock.now(),
    )?;
    let moved = command
        .moved_pages
        .iter()
        .map(|(source, destination)| {
            (
                source.as_str().to_string(),
                destination.as_str().to_string(),
            )
        })
        .collect::<Vec<_>>();
    let moved_sources = moved
        .iter()
        .map(|(source, _)| source.as_str())
        .collect::<BTreeSet<_>>();
    let unchanged = normalized_paths
        .iter()
        .filter(|path| !moved_sources.contains(path.as_str()))
        .map(|path| path.as_str().to_string())
        .collect();

    state
        .mutation_coordinator
        .execute_batch(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            super::mutation_notifier(&state),
        )
        .await
        .map_err(super::mutation_error)?;

    Ok(Json(BulkAssignResponse { moved, unchanged }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_test_support::make_state;
    use crate::vault::path::VaultPath;

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
            Query(ListPagesQuery {
                limit: None,
                offset: None,
                kind: None,
                tag: None,
                project: None,
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
        assert_eq!(
            actual_tags,
            vec!["a".to_string(), "b".to_string(), "quote".to_string()]
        );
        assert_eq!(item.computed_tags, vec!["quote".to_string()]);
    }

    #[tokio::test]
    async fn detail_returns_kind_and_project() {
        let (state, _tmp) = make_state().await;

        // Write a page with type: quote and project: clepsydra
        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();
        let page_content = "\
---\n\
id: 01900000-0000-7000-8000-000000000002\n\
type: quote\n\
project: clepsydra\n\
---\n\
\n\
Some quoted text.\n";
        std::fs::write(page_dir.join("q.md"), page_content).unwrap();

        let resp = get_page(State(state), Path("notes/q.md".to_string()))
            .await
            .unwrap();

        assert_eq!(resp.0.kind, "QUOTE", "resolved kind should be QUOTE");
        assert!(
            !resp.0.inferred,
            "inferred should be false when type is declared"
        );
        assert_eq!(
            resp.0.project.as_deref(),
            Some("clepsydra"),
            "project should be clepsydra"
        );
    }

    #[tokio::test]
    async fn detail_infers_kind_from_folder() {
        let (state, _tmp) = make_state().await;

        // No `type:` declared — kind should be inferred from the folder.
        let page_dir = state.vault.root().join("journals");
        std::fs::create_dir_all(&page_dir).unwrap();
        std::fs::write(
            page_dir.join("2026-05-31.md"),
            "---\nid: 01900000-0000-7000-8000-000000000003\n---\nbody\n",
        )
        .unwrap();

        let resp = get_page(State(state), Path("journals/2026-05-31.md".to_string()))
            .await
            .unwrap();

        assert_eq!(resp.0.kind, "JOURNAL", "kind should be inferred as JOURNAL");
        assert!(
            resp.0.inferred,
            "inferred should be true when type is absent"
        );
    }

    #[tokio::test]
    async fn assign_kind_writes_frontmatter_and_moves() {
        let (state, _tmp) = make_state().await;

        // Seed a note that lives under notes/ with no declared kind.
        let page_dir = state.vault.root().join("notes");
        std::fs::create_dir_all(&page_dir).unwrap();
        std::fs::write(
            page_dir.join("q.md"),
            "---\nid: 0190f8a0-0000-7000-8000-00000000000c\n---\nbody\n",
        )
        .unwrap();

        // Index the page so reconcile can plan a move against it.
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

        let resp = assign_page(
            State(Arc::clone(&state)),
            Path("notes/q.md".to_string()),
            Json(AssignRequest {
                kind: Some("QUOTE".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        // Declaring kind=QUOTE projects the page into quotes/.
        assert_eq!(resp.0.path, "quotes/q.md");
        assert_eq!(resp.0.kind, "QUOTE");
        assert!(!resp.0.inferred, "kind is declared, so not inferred");
        assert_eq!(resp.0.meta.kind, Some(crate::vault::kind::Kind::Quote));

        assert!(
            !state
                .vault
                .resolve(&VaultPath::new("notes/q.md").unwrap())
                .exists(),
            "source file should be gone after reconcile move"
        );
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/q.md").unwrap())
                .exists(),
            "page should now live at quotes/q.md"
        );
    }

    /// Seed a page on disk and index it. Shared by the assign tests below.
    async fn seed_and_index(state: &Arc<AppState>, rel: &str, content: &str) {
        let abs = state.vault.root().join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, content).unwrap();
        let vp = VaultPath::new(rel).unwrap();
        state
            .index
            .with_index(move |index, vault| {
                index.index_page(vault, &vp)?;
                Ok::<_, crate::vault::index::IndexError>(())
            })
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn assign_unknown_kind_returns_400() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000010\n---\nbody\n",
        )
        .await;

        let err = assign_page(
            State(Arc::clone(&state)),
            Path("notes/q.md".to_string()),
            Json(AssignRequest {
                kind: Some("BOGUS".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .expect_err("unknown kind must be rejected");

        assert_eq!(err.status, StatusCode::BAD_REQUEST.as_u16());
        // The source file must be untouched on rejection.
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("notes/q.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn assign_missing_page_returns_404() {
        let (state, _tmp) = make_state().await;

        let err = assign_page(
            State(Arc::clone(&state)),
            Path("notes/nope.md".to_string()),
            Json(AssignRequest {
                kind: Some("QUOTE".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .expect_err("missing page must 404");

        assert_eq!(err.status, StatusCode::NOT_FOUND.as_u16());
    }

    #[tokio::test]
    async fn assign_kind_no_move_when_already_in_folder() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "quotes/x.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000011\n---\nbody\n",
        )
        .await;

        let resp = assign_page(
            State(Arc::clone(&state)),
            Path("quotes/x.md".to_string()),
            Json(AssignRequest {
                kind: Some("QUOTE".to_string()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        // Already in the canonical folder: no move.
        assert_eq!(resp.0.path, "quotes/x.md");
        assert_eq!(resp.0.kind, "QUOTE");
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/x.md").unwrap())
                .exists(),
            "page should still exist at quotes/x.md"
        );
    }

    #[tokio::test]
    async fn assign_clear_project_moves_up() {
        // An explicit clear_project strips the subfolder and moves the page up
        // to the top folder (deliberate user action — unlike the conservative
        // passive sweep, which never strips on absent project).
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/clep/x.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000012\nproject: clep\n---\nbody\n",
        )
        .await;

        let resp = assign_page(
            State(Arc::clone(&state)),
            Path("notes/clep/x.md".to_string()),
            Json(AssignRequest {
                kind: None,
                project: None,
                clear_project: true,
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.0.path, "notes/x.md");
        assert_eq!(
            resp.0.meta.project, None,
            "project should be cleared in meta"
        );
        assert!(
            !state
                .vault
                .resolve(&VaultPath::new("notes/clep/x.md").unwrap())
                .exists(),
            "source should be gone after the clear move"
        );
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("notes/x.md").unwrap())
                .exists(),
            "page should now live at notes/x.md"
        );
    }

    #[tokio::test]
    async fn assign_rejects_traversal_project() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000013\n---\nbody\n",
        )
        .await;

        let err = assign_page(
            State(Arc::clone(&state)),
            Path("notes/q.md".to_string()),
            Json(AssignRequest {
                kind: None,
                project: Some("../evil".to_string()),
                clear_project: false,
            }),
        )
        .await
        .expect_err("traversal project must be rejected");

        assert_eq!(err.status, StatusCode::BAD_REQUEST.as_u16());
        // File untouched; no escape attempt persisted.
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("notes/q.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn bulk_assign_moves_all_and_reports() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/a.md",
            "---\nid: 0190f8a0-0000-7000-8000-00000000000e\n---\nb\n",
        )
        .await;
        seed_and_index(
            &state,
            "notes/b.md",
            "---\nid: 0190f8a0-0000-7000-8000-00000000000f\n---\nb\n",
        )
        .await;

        let resp = assign_bulk(
            State(Arc::clone(&state)),
            Json(BulkAssignRequest {
                paths: vec!["notes/a.md".into(), "notes/b.md".into()],
                kind: Some("QUOTE".into()),
                project: Some("clep".into()),
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.0.moved.len(), 2);
        assert!(resp.0.unchanged.is_empty());
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/clep/a.md").unwrap())
                .exists()
        );
        assert!(
            state
                .vault
                .resolve(&VaultPath::new("quotes/clep/b.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn bulk_assign_rejects_the_whole_request_when_a_page_is_missing() {
        let (state, _tmp) = make_state().await;
        seed_and_index(
            &state,
            "notes/a.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000011\n---\nb\n",
        )
        .await;
        let source = VaultPath::new("notes/a.md").unwrap();
        let original = fs::read(state.vault.resolve(&source)).unwrap();

        let error = assign_bulk(
            State(Arc::clone(&state)),
            Json(BulkAssignRequest {
                paths: vec!["notes/a.md".into(), "notes/missing.md".into()],
                kind: Some("QUOTE".into()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap_err();

        assert_eq!(error.status, StatusCode::NOT_FOUND.as_u16());
        assert_eq!(fs::read(state.vault.resolve(&source)).unwrap(), original);
        assert!(
            !state
                .vault
                .resolve(&VaultPath::new("quotes/a.md").unwrap())
                .exists()
        );
    }

    #[tokio::test]
    async fn bulk_assign_noop_goes_to_unchanged() {
        let (state, _tmp) = make_state().await;
        // Already in its projected folder for kind=QUOTE, so assign is a no-op move.
        seed_and_index(
            &state,
            "quotes/q.md",
            "---\nid: 0190f8a0-0000-7000-8000-000000000012\n---\nb\n",
        )
        .await;

        let resp = assign_bulk(
            State(Arc::clone(&state)),
            Json(BulkAssignRequest {
                paths: vec!["quotes/q.md".into()],
                kind: Some("QUOTE".into()),
                project: None,
                clear_project: false,
            }),
        )
        .await
        .unwrap();

        assert!(resp.0.moved.is_empty(), "no relocation should occur");
        assert_eq!(resp.0.unchanged, vec!["quotes/q.md".to_string()]);
    }
}
