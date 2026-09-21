//! Read-only rendering and explicitly reviewed, exact-content generated-region writes.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{DefaultBodyLimit, State};
use axum::routing::post;
use axum::{Extension, Json, Router};
use clep_bases::base_document::BaseDocumentError;
use clep_bases::base_render::{RenderError, RenderOutput, RenderSelection, render_base};
use clep_bases::generated_region::{RegionError, insert_region, parse_regions, replace_region};
use clep_bases::template_document::read_template;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::base_templates::{TEMPLATE_REQUEST_BYTES, template_error};
use super::error::{ApiError, parse_request_path};
use crate::vault::Vault;
use crate::vault::mutation_coordinator::{MutationError, ReplacePageContentCommand};
use crate::vault::page::{Page, body_is_protected, body_of, page_revision, parse_frontmatter};
use crate::vault::path::VaultPath;

const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PREVIEWS: usize = 32;
const MAX_PREVIEW_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenderRequest {
    pub selection: RenderSelection,
    pub page_path: String,
    /// Unsaved source is allowed only for a read-only render, never region application.
    pub template_source: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreviewRequest {
    pub page_path: String,
    pub expected_revision: String,
    pub selection: RenderSelection,
    pub region_id: Option<String>,
    /// UTF-8 byte offset in the exact saved body; required only for insertion.
    pub insert_offset: Option<usize>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PreviewResponse {
    pub token: String,
    /// Exact proposed payload, including the generated-region separator newlines.
    pub markdown: String,
    pub current_markdown: String,
    pub modified: bool,
    pub selected_count: usize,
    pub region_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplyRequest {
    pub token: String,
    pub overwrite_modified: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ApplyResponse {
    pub body: String,
    pub revision: String,
}

struct PreviewSnapshot {
    path: VaultPath,
    expected_content: String,
    content: String,
    modified: bool,
}

impl PreviewSnapshot {
    fn stored_bytes(&self) -> usize {
        self.expected_content.capacity()
            + self.content.capacity()
            + self.path.as_str().len()
            + std::mem::size_of::<Self>()
            + 36
    }
}

struct PreviewEntry {
    token: String,
    created: Instant,
    snapshot: Arc<PreviewSnapshot>,
}

#[derive(Default)]
pub struct PreviewStore {
    entries: VecDeque<PreviewEntry>,
    bytes: usize,
}

impl PreviewStore {
    fn remove_oldest(&mut self) {
        if let Some(entry) = self.entries.pop_front() {
            self.bytes -= entry.snapshot.stored_bytes();
        }
    }

    fn expire(&mut self) {
        while self
            .entries
            .front()
            .is_some_and(|entry| entry.created.elapsed() >= PREVIEW_TTL)
        {
            self.remove_oldest();
        }
    }

    fn insert(&mut self, snapshot: PreviewSnapshot) -> Result<String, ApiError> {
        let bytes = snapshot.stored_bytes();
        if bytes > MAX_PREVIEW_BYTES {
            return Err(ApiError::unprocessable_with_detail(
                "destination and generated output exceed the preview storage limit",
                serde_json::json!({ "code": "preview_resource_limit" }),
            ));
        }
        self.expire();
        while self.entries.len() >= MAX_PREVIEWS || self.bytes + bytes > MAX_PREVIEW_BYTES {
            self.remove_oldest();
        }
        let token = uuid::Uuid::now_v7().to_string();
        self.entries.push_back(PreviewEntry {
            token: token.clone(),
            created: Instant::now(),
            snapshot: Arc::new(snapshot),
        });
        self.bytes += bytes;
        Ok(token)
    }

    fn get(&mut self, token: &str) -> Result<Arc<PreviewSnapshot>, ApiError> {
        self.expire();
        self.entries
            .iter()
            .find(|entry| entry.token == token)
            .map(|entry| Arc::clone(&entry.snapshot))
            .ok_or_else(|| {
                ApiError::conflict_with_detail(
                    "preview expired or is unavailable; preview again",
                    serde_json::json!({ "code": "preview_expired" }),
                )
            })
    }

    fn remove(&mut self, token: &str) {
        if let Some(index) = self.entries.iter().position(|entry| entry.token == token)
            && let Some(entry) = self.entries.remove(index)
        {
            self.bytes -= entry.snapshot.stored_bytes();
        }
    }
}

fn region_error(_error: RegionError) -> ApiError {
    // TOML diagnostics can contain the original page source. Never put that
    // source into an API error (including a malformed confidential payload).
    ApiError::bad_request_with_detail(
        "invalid generated region or insertion position; repair its source before regenerating",
        serde_json::json!({ "code": "invalid_region" }),
    )
}

fn render_error(error: RenderError) -> ApiError {
    let (mut result, code) = match error {
        RenderError::Base(BaseDocumentError::NotFound(_)) => {
            (ApiError::not_found("Base was not found"), "missing_base")
        }
        RenderError::MissingView(_) => (
            ApiError::not_found("saved Base view was not found"),
            "missing_view",
        ),
        RenderError::Base(BaseDocumentError::InvalidSlug(_)) | RenderError::InvalidSelection(_) => {
            (
                ApiError::bad_request("invalid Base render selection"),
                "invalid_selection",
            )
        }
        RenderError::Base(
            BaseDocumentError::UnsupportedDocument(_) | BaseDocumentError::InvalidDefinition(_),
        ) => (
            ApiError::conflict("Base definition is unavailable"),
            "invalid_base",
        ),
        RenderError::SourceChanged(_) => (
            ApiError::conflict("a selected source changed; refresh and preview again"),
            "source_changed",
        ),
        RenderError::InaccessibleSource(_) => (
            ApiError::forbidden("a selected source cannot be read"),
            "inaccessible_source",
        ),
        RenderError::ResourceLimit(limit) => (
            ApiError::unprocessable_with_detail(
                "render resource limit exceeded",
                serde_json::json!({ "code": "render_resource_limit", "limit": limit }),
            ),
            "render_resource_limit",
        ),
        RenderError::Template(error) => {
            return ApiError::unprocessable_with_detail(
                "template could not be rendered",
                serde_json::json!({ "code": "template_error", "kind": error.kind().to_string(), "line": error.line() }),
            );
        }
        RenderError::InvalidOutput(_) => (
            ApiError::unprocessable_with_detail(
                "rendered output contains an active generated directive",
                serde_json::json!({ "code": "invalid_output" }),
            ),
            "invalid_output",
        ),
        RenderError::Query(_) => (
            ApiError::bad_request("Base query could not be evaluated"),
            "invalid_selection",
        ),
        RenderError::Base(_) | RenderError::Io(_) => (
            ApiError::internal("render inputs could not be read"),
            "render_storage_error",
        ),
    };
    if result.detail.is_none() {
        result.detail = Some(serde_json::json!({ "code": code }));
    }
    result
}

/// Runs only on a blocking worker. Resolve physical page paths before opening
/// them, so this endpoint cannot expose a symlink target or reserved vault data.
fn read_destination(vault: &Vault, path: VaultPath) -> Result<Page, ApiError> {
    let current_vault = Vault::open(vault.root())
        .map_err(|_| ApiError::internal("vault access policy could not be read"))?;
    if current_vault.is_excluded(&path)
        || !path.as_str().ends_with(".md")
        || path
            .as_str()
            .split('/')
            .any(|component| component.starts_with('.'))
    {
        return Err(ApiError::forbidden(
            "destination is not an accessible vault page",
        ));
    }
    let leaf = vault.resolve(&path);
    let mut absolute = vault.root().to_path_buf();
    for component in std::path::Path::new(path.as_str()).components() {
        absolute.push(component);
        let metadata = std::fs::symlink_metadata(&absolute).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found("destination page was not found")
            } else {
                ApiError::internal("destination page could not be read")
            }
        })?;
        if metadata.file_type().is_symlink() {
            return Err(ApiError::forbidden(
                "destination path cannot contain symlinks",
            ));
        }
        if (absolute == leaf && !metadata.is_file()) || (absolute != leaf && !metadata.is_dir()) {
            return Err(ApiError::forbidden(
                "destination must be a regular file in physical directories",
            ));
        }
    }
    let file = std::fs::File::open(&absolute)
        .map_err(|_| ApiError::internal("destination page could not be read"))?;
    let mut bytes = Vec::new();
    file.take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::internal("destination page could not be read"))?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(ApiError::unprocessable_with_detail(
            "destination exceeds the render input limit",
            serde_json::json!({ "code": "render_resource_limit" }),
        ));
    }
    let raw_content = String::from_utf8(bytes)
        .map_err(|_| ApiError::bad_request("destination page is not valid UTF-8"))?;
    let (meta, body) = parse_frontmatter(&raw_content)
        .map_err(|_| ApiError::bad_request("destination frontmatter is invalid"))?;
    let page = Page {
        path,
        meta,
        body,
        raw_content,
    };
    if page.is_encrypted() {
        return Err(ApiError::forbidden(
            "encrypted destinations cannot be rendered or regenerated",
        ));
    }
    Ok(page)
}

fn ensure_writable(page: &Page) -> Result<(), ApiError> {
    if body_is_protected(page.path.as_str(), &page.meta) {
        return Err(ApiError::forbidden("destination page body is read-only"));
    }
    Ok(())
}

#[utoipa::path(
    post, path = "/base-render/render", context_path = "/api/vault", tag = "Bases",
    request_body = RenderRequest,
    responses((status = 200, body = RenderOutput), (status = 400, body = ApiError), (status = 403, body = ApiError), (status = 404, body = ApiError), (status = 409, body = ApiError), (status = 422, body = ApiError), (status = 500, body = ApiError))
)]
pub async fn render(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RenderRequest>,
) -> Result<Json<RenderOutput>, ApiError> {
    let path = parse_request_path(&request.page_path, "invalid destination path")?;
    let today = state.clock.now().date_naive();
    let output = state
        .index
        .with_index(move |index, vault| {
            let destination = read_destination(vault, path)?;
            let source = match request.template_source {
                Some(source) => source,
                None => {
                    read_template(vault.root(), &request.selection.template)
                        .map_err(template_error)?
                        .source
                }
            };
            render_base(
                vault.root(),
                index.connection(),
                &request.selection,
                &destination,
                &source,
                today,
            )
            .map_err(render_error)
        })
        .await
        .map_err(|_| ApiError::internal("render worker failed"))??;
    Ok(Json(output))
}

#[utoipa::path(
    post, path = "/base-render/preview", context_path = "/api/vault", tag = "Bases",
    request_body = PreviewRequest,
    responses((status = 200, body = PreviewResponse), (status = 400, body = ApiError), (status = 403, body = ApiError), (status = 404, body = ApiError), (status = 409, body = ApiError), (status = 422, body = ApiError), (status = 500, body = ApiError))
)]
pub async fn preview(
    State(state): State<Arc<AppState>>,
    Extension(store): Extension<Arc<Mutex<PreviewStore>>>,
    Json(request): Json<PreviewRequest>,
) -> Result<Json<PreviewResponse>, ApiError> {
    let path = parse_request_path(&request.page_path, "invalid destination path")?;
    if request.region_id.is_some() == request.insert_offset.is_some() {
        return Err(ApiError::bad_request(
            "supply exactly one of region_id or insert_offset",
        ));
    }
    let today = state.clock.now().date_naive();
    let (snapshot, mut response) = state
        .index
        .with_index(move |index, vault| {
            let destination = read_destination(vault, path)?;
            let revision = page_revision(&destination.raw_content);
            if revision != request.expected_revision {
                return Err(ApiError::revision_conflict(revision));
            }
            ensure_writable(&destination)?;
            let body = body_of(&destination.raw_content);
            let regions = parse_regions(body).map_err(region_error)?;
            let existing = match request.region_id.as_deref() {
                Some(id) => Some(
                    regions
                        .iter()
                        .find(|region| region.descriptor.id == id)
                        .ok_or_else(|| ApiError::not_found("generated region was not found"))?,
                ),
                None => None,
            };
            let region_id = existing
                .map(|region| region.descriptor.id.clone())
                .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
            let modified = existing.is_some_and(|region| region.modified);
            let current_markdown = existing
                .map(|region| body[region.payload.clone()].to_owned())
                .unwrap_or_default();
            let source =
                read_template(vault.root(), &request.selection.template).map_err(template_error)?;
            let output = render_base(
                vault.root(),
                index.connection(),
                &request.selection,
                &destination,
                &source.source,
                today,
            )
            .map_err(render_error)?;
            let new_body = match existing {
                Some(region) => replace_region(body, region, &request.selection, &output.markdown),
                None => insert_region(
                    body,
                    request.insert_offset.expect("insertion offset validated"),
                    &region_id,
                    &request.selection,
                    &output.markdown,
                ),
            }
            .map_err(region_error)?;
            // The formatter owns LF normalization and separators. Return precisely
            // its payload, not the pre-format renderer output, for honest review.
            let generated = parse_regions(&new_body).map_err(region_error)?;
            let region = generated
                .iter()
                .find(|region| region.descriptor.id == region_id)
                .ok_or_else(|| {
                    ApiError::internal("generated output is not an addressable region")
                })?;
            let markdown = new_body[region.payload.clone()].to_owned();
            let prefix_len = destination.raw_content.len() - body.len();
            let mut content = String::with_capacity(prefix_len + new_body.len());
            content.push_str(&destination.raw_content[..prefix_len]);
            content.push_str(&new_body);
            let snapshot = PreviewSnapshot {
                path: destination.path,
                expected_content: destination.raw_content,
                content,
                modified,
            };
            Ok((
                snapshot,
                PreviewResponse {
                    token: String::new(),
                    markdown,
                    current_markdown,
                    modified,
                    selected_count: output.selected_count,
                    region_id,
                },
            ))
        })
        .await
        .map_err(|_| ApiError::internal("preview worker failed"))??;
    response.token = store.lock().insert(snapshot)?;
    Ok(Json(response))
}

#[utoipa::path(
    post, path = "/base-render/apply", context_path = "/api/vault", tag = "Bases",
    request_body = ApplyRequest,
    responses((status = 200, body = ApplyResponse), (status = 400, body = ApiError), (status = 403, body = ApiError), (status = 404, body = ApiError), (status = 409, body = ApiError), (status = 500, body = ApiError))
)]
pub async fn apply(
    State(state): State<Arc<AppState>>,
    Extension(store): Extension<Arc<Mutex<PreviewStore>>>,
    Json(request): Json<ApplyRequest>,
) -> Result<Json<ApplyResponse>, ApiError> {
    let snapshot = store.lock().get(&request.token)?;
    let current = {
        let state = Arc::clone(&state);
        let path = snapshot.path.clone();
        tokio::task::spawn_blocking(move || read_destination(&state.vault, path))
            .await
            .map_err(|_| ApiError::internal("destination worker failed"))??
    };
    if current.raw_content != snapshot.expected_content {
        return Err(ApiError::revision_conflict(page_revision(
            &current.raw_content,
        )));
    }
    ensure_writable(&current)?;
    if snapshot.modified && !request.overwrite_modified {
        return Err(ApiError::conflict_with_detail(
            "generated output was externally modified; explicit overwrite acknowledgement is required",
            serde_json::json!({ "code": "modified_output" }),
        ));
    }
    let notify = super::mutation_notifier(&state);
    let result = state
        .mutation_coordinator
        .replace_page_content(
            &state.vault,
            &state.index,
            ReplacePageContentCommand {
                path: snapshot.path.clone(),
                expected_content: snapshot.expected_content.clone(),
                content: snapshot.content.clone(),
            },
            notify.as_ref(),
        )
        .await;
    let result = match result {
        Ok(result) => result,
        Err(MutationError::Stale(_)) => {
            let state = Arc::clone(&state);
            let path = snapshot.path.clone();
            let current = tokio::task::spawn_blocking(move || read_destination(&state.vault, path))
                .await
                .map_err(|_| ApiError::internal("destination worker failed"))??;
            return Err(ApiError::revision_conflict(page_revision(
                &current.raw_content,
            )));
        }
        Err(error) => return Err(super::mutation_error(error)),
    };
    store.lock().remove(&request.token);
    Ok(Json(ApplyResponse {
        body: body_of(&result.content).to_owned(),
        revision: page_revision(&result.content),
    }))
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/render",
            post(render).layer(DefaultBodyLimit::max(TEMPLATE_REQUEST_BYTES)),
        )
        .route("/preview", post(preview))
        .route("/apply", post(apply))
        .layer(Extension(Arc::new(Mutex::new(PreviewStore::default()))))
}
