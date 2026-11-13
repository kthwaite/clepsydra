//! Explicit vault-backed snapshots, independent of any client's open workspace.

use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing::get};
use clep_vault::atomic_file::{atomic_create, atomic_replace, flush_directory};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::{ApiError, parse_request_path};
use super::page_identity::{AttemptError, MissingFile, read_page_once, read_stable_by_id};
use crate::vault::path::VaultPath;

const DIRECTORY: &str = ".clepsydra/quires";
const VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SavedQuireColor {
    Sepia,
    Verdigris,
    Slate,
    Madder,
    Ochre,
    Indigo,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SavedQuireMemberInput {
    pub page_id: Option<String>,
    pub path: String,
    pub label: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SavedQuireMember {
    pub page_id: String,
    pub path: String,
    pub label: String,
    pub missing: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SavedQuire {
    pub id: String,
    pub name: String,
    pub color: SavedQuireColor,
    pub revision: String,
    pub members: Vec<SavedQuireMember>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSavedQuire {
    pub name: String,
    pub color: SavedQuireColor,
    pub members: Vec<SavedQuireMemberInput>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateSavedQuire {
    pub expected_revision: String,
    pub name: String,
    pub color: SavedQuireColor,
    /// Omit to rename without replacing the saved membership.
    pub members: Option<Vec<SavedQuireMemberInput>>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteSavedQuire {
    pub expected_revision: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredMember {
    page_id: Uuid,
    path: String,
    label: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    id: Uuid,
    name: String,
    color: SavedQuireColor,
    members: Vec<StoredMember>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_quires).post(create_quire))
        .route(
            "/{id}",
            get(get_quire).put(update_quire).delete(delete_quire),
        )
}

fn io_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(format!("saved quire storage: {error}"))
}

fn quire_id(id: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(id).map_err(|_| ApiError::bad_request("invalid saved quire UUID"))
}

fn document_path(id: Uuid) -> VaultPath {
    VaultPath::new(&format!("{DIRECTORY}/{id}.json")).expect("UUID storage path")
}

fn validate_text(value: &str, field: &str, maximum: usize) -> Result<(), ApiError> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request(format!(
            "{field} must contain 1–{maximum} characters and no control characters"
        )));
    }
    Ok(())
}

fn member_path(path: &str) -> Result<VaultPath, ApiError> {
    if path.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "member path cannot contain control characters",
        ));
    }
    parse_request_path(path, "invalid member path")
}

/// Check every component, including broken symlinks, before filesystem access.
fn safe_path(root: &FsPath, path: &VaultPath) -> Result<PathBuf, ApiError> {
    let mut absolute = root.to_path_buf();
    for component in path.as_str().split('/') {
        absolute.push(component);
        match fs::symlink_metadata(&absolute) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ApiError::bad_request("saved quires do not follow symlinks"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(absolute)
}

fn ensure_directory(root: &FsPath) -> Result<(), ApiError> {
    for relative in [".clepsydra", DIRECTORY] {
        let path = VaultPath::new(relative).expect("storage directory path");
        let absolute = safe_path(root, &path)?;
        match fs::create_dir(&absolute) {
            Ok(()) => {
                flush_directory(absolute.parent().expect("directory parent")).map_err(io_error)?
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if !fs::symlink_metadata(&absolute).map_err(io_error)?.is_dir() {
                    return Err(ApiError::bad_request(
                        "saved quire storage must be a directory",
                    ));
                }
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn load(root: &FsPath, id: Uuid) -> Result<(Document, String), ApiError> {
    let path = safe_path(root, &document_path(id))?;
    let bytes = fs::read(path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            ApiError::not_found("saved quire not found")
        } else {
            io_error(error)
        }
    })?;
    let document: Document = serde_json::from_slice(&bytes).map_err(io_error)?;
    if document.version != VERSION || document.id != id {
        return Err(ApiError::internal(
            "invalid saved quire version or identity",
        ));
    }
    validate_text(&document.name, "name", 200).map_err(|error| io_error(error.error))?;
    let mut ids = HashSet::with_capacity(document.members.len());
    for member in &document.members {
        member_path(&member.path).map_err(|error| io_error(error.error))?;
        if !ids.insert(member.page_id) {
            return Err(ApiError::internal("duplicate saved quire member"));
        }
    }
    Ok((document, blake3::hash(&bytes).to_hex().to_string()))
}

async fn load_locked(state: &AppState, id: Uuid) -> Result<(Document, String), ApiError> {
    let _guard = state
        .mutation_coordinator
        .lock_paths(&[document_path(id)])
        .await;
    load(state.vault.root(), id)
}

async fn current_member(state: &AppState, id: Uuid) -> Result<Option<StoredMember>, ApiError> {
    let id_string = id.to_string();
    let result = read_stable_by_id(
        state,
        &id_string,
        None,
        || ApiError::not_found("saved member is missing"),
        |path| async move {
            safe_path(state.vault.root(), &path)?;
            let (_, meta, _) = read_page_once(state, &path, MissingFile::NotFound)?;
            if meta.id != id {
                return Err(AttemptError::Vanished(ApiError::not_found(
                    "saved member is missing",
                )));
            }
            let label = meta
                .title
                .filter(|title| !title.trim().is_empty())
                .unwrap_or_else(|| path.as_str().to_owned());
            Ok(StoredMember {
                page_id: id,
                path: path.as_str().to_owned(),
                label,
            })
        },
    )
    .await;
    match result {
        Ok(member) => Ok(Some(member)),
        Err(error) if error.status == StatusCode::NOT_FOUND.as_u16() => Ok(None),
        Err(error) => Err(error),
    }
}

async fn prepare_members(
    state: &AppState,
    inputs: Vec<SavedQuireMemberInput>,
    previous: &[StoredMember],
) -> Result<Vec<StoredMember>, ApiError> {
    let mut members = Vec::with_capacity(inputs.len());
    let mut ids = HashSet::with_capacity(inputs.len());
    for input in inputs {
        let path = member_path(&input.path)?;
        validate_text(&input.label, "member label", 1024)?;
        safe_path(state.vault.root(), &path)?;
        let id = match input.page_id {
            Some(id) => Uuid::parse_str(&id)
                .map_err(|_| ApiError::bad_request("invalid member page UUID"))?,
            None => {
                let _guard = state
                    .mutation_coordinator
                    .lock_paths(std::slice::from_ref(&path))
                    .await;
                safe_path(state.vault.root(), &path)?;
                let (_, meta, _) = read_page_once(state, &path, MissingFile::NotFound)
                    .map_err(ApiError::from)
                    .map_err(|error| {
                        if error.status == StatusCode::NOT_FOUND.as_u16() {
                            ApiError::bad_request("new saved member must identify an existing page")
                        } else {
                            error
                        }
                    })?;
                meta.id
            }
        };
        if !ids.insert(id) {
            return Err(ApiError::bad_request("saved quire members must be unique"));
        }
        let member = match current_member(state, id).await? {
            Some(member) => member,
            None => previous
                .iter()
                .find(|member| member.page_id == id)
                .cloned()
                .ok_or_else(|| {
                    ApiError::bad_request("new saved member must identify an existing page")
                })?,
        };
        members.push(member);
    }
    Ok(members)
}

async fn response(
    state: &AppState,
    document: Document,
    revision: String,
) -> Result<SavedQuire, ApiError> {
    let mut members = Vec::with_capacity(document.members.len());
    for saved in document.members {
        let current = current_member(state, saved.page_id).await?;
        let missing = current.is_none();
        let member = current.unwrap_or(saved);
        members.push(SavedQuireMember {
            page_id: member.page_id.to_string(),
            path: member.path,
            label: member.label,
            missing,
        });
    }
    Ok(SavedQuire {
        id: document.id.to_string(),
        name: document.name,
        color: document.color,
        revision,
        members,
    })
}

fn check_revision(expected: &str, current: &str) -> Result<(), ApiError> {
    if expected != current {
        return Err(ApiError::conflict_with_detail(
            "saved quire changed since expected_revision",
            serde_json::json!({"revision": current}),
        ));
    }
    Ok(())
}

#[utoipa::path(get, path = "/api/vault/quires", tag = "Quires", responses(
    (status = 200, description = "Saved snapshots resolved against current pages", body = [SavedQuire]),
    (status = 400, description = "Unsafe storage path", body = ApiError),
    (status = 500, description = "Storage failure", body = ApiError)
))]
pub async fn list_quires(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<SavedQuire>>, ApiError> {
    let directory = VaultPath::new(DIRECTORY).expect("storage directory path");
    let documents = {
        let _guard = state
            .mutation_coordinator
            .lock_paths(std::slice::from_ref(&directory))
            .await;
        let path = safe_path(state.vault.root(), &directory)?;
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Json(Vec::new())),
            Err(error) => return Err(io_error(error)),
        };
        let mut documents = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            let Ok(id) = Uuid::parse_str(stem) else {
                continue;
            };
            // Only canonical UUID filenames are documents; never alias another file.
            if stem != id.to_string() {
                continue;
            }
            documents.push(load(state.vault.root(), id)?);
        }
        documents.sort_by(|(a, _), (b, _)| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        documents
    };
    let mut snapshots = Vec::with_capacity(documents.len());
    for (document, revision) in documents {
        snapshots.push(response(&state, document, revision).await?);
    }
    Ok(Json(snapshots))
}

#[utoipa::path(get, path = "/api/vault/quires/{id}", tag = "Quires", params(("id" = String, Path)), responses(
    (status = 200, description = "Saved snapshot", body = SavedQuire),
    (status = 400, description = "Invalid UUID or unsafe path", body = ApiError),
    (status = 404, description = "Snapshot not found", body = ApiError)
))]
pub async fn get_quire(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SavedQuire>, ApiError> {
    let (document, revision) = load_locked(&state, quire_id(&id)?).await?;
    Ok(Json(response(&state, document, revision).await?))
}

#[utoipa::path(post, path = "/api/vault/quires", tag = "Quires", request_body = CreateSavedQuire, responses(
    (status = 201, description = "Snapshot created", body = SavedQuire),
    (status = 400, description = "Invalid snapshot", body = ApiError)
))]
pub async fn create_quire(
    State(state): State<Arc<AppState>>,
    request: Result<Json<CreateSavedQuire>, JsonRejection>,
) -> Result<(StatusCode, Json<SavedQuire>), ApiError> {
    let Json(request) = request.map_err(|error| ApiError::bad_request(error.body_text()))?;
    validate_text(&request.name, "name", 200)?;
    let members = prepare_members(&state, request.members, &[]).await?;
    let document = Document {
        version: VERSION,
        id: Uuid::now_v7(),
        name: request.name.trim().to_owned(),
        color: request.color,
        members,
    };
    let bytes = serde_json::to_vec(&document).map_err(io_error)?;
    {
        let path = document_path(document.id);
        let _guard = state
            .mutation_coordinator
            .lock_paths(std::slice::from_ref(&path))
            .await;
        ensure_directory(state.vault.root())?;
        atomic_create(&safe_path(state.vault.root(), &path)?, &bytes).map_err(io_error)?;
    }
    let revision = blake3::hash(&bytes).to_hex().to_string();
    Ok((
        StatusCode::CREATED,
        Json(response(&state, document, revision).await?),
    ))
}

#[utoipa::path(put, path = "/api/vault/quires/{id}", tag = "Quires", params(("id" = String, Path)), request_body = UpdateSavedQuire, responses(
    (status = 200, description = "Snapshot updated", body = SavedQuire),
    (status = 400, description = "Invalid snapshot", body = ApiError),
    (status = 404, description = "Snapshot not found", body = ApiError),
    (status = 409, description = "Snapshot revision changed", body = ApiError)
))]
pub async fn update_quire(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    request: Result<Json<UpdateSavedQuire>, JsonRejection>,
) -> Result<Json<SavedQuire>, ApiError> {
    let id = quire_id(&id)?;
    let Json(request) = request.map_err(|error| ApiError::bad_request(error.body_text()))?;
    validate_text(&request.name, "name", 200)?;
    let (mut document, revision) = load_locked(&state, id).await?;
    check_revision(&request.expected_revision, &revision)?;
    // Resolve pages outside the snapshot lock: nested gate acquisition can
    // deadlock when a sync window is queued. Recheck the revision before writing.
    if let Some(inputs) = request.members {
        document.members = prepare_members(&state, inputs, &document.members).await?;
    }
    document.name = request.name.trim().to_owned();
    document.color = request.color;
    let bytes = serde_json::to_vec(&document).map_err(io_error)?;
    {
        let path = document_path(id);
        let _guard = state
            .mutation_coordinator
            .lock_paths(std::slice::from_ref(&path))
            .await;
        let (_, current) = load(state.vault.root(), id)?;
        check_revision(&request.expected_revision, &current)?;
        atomic_replace(&safe_path(state.vault.root(), &path)?, &bytes).map_err(io_error)?;
    }
    Ok(Json(
        response(&state, document, blake3::hash(&bytes).to_hex().to_string()).await?,
    ))
}

#[utoipa::path(delete, path = "/api/vault/quires/{id}", tag = "Quires", params(
    ("id" = String, Path), ("expected_revision" = String, Query)
), responses(
    (status = 204, description = "Snapshot deleted; pages unchanged"),
    (status = 400, description = "Invalid request", body = ApiError),
    (status = 404, description = "Snapshot not found", body = ApiError),
    (status = 409, description = "Snapshot revision changed", body = ApiError)
))]
pub async fn delete_quire(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    query: Result<Query<DeleteSavedQuire>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let id = quire_id(&id)?;
    let Query(query) = query.map_err(|error| ApiError::bad_request(error.body_text()))?;
    let path = document_path(id);
    let _guard = state
        .mutation_coordinator
        .lock_paths(std::slice::from_ref(&path))
        .await;
    let (_, revision) = load(state.vault.root(), id)?;
    check_revision(&query.expected_revision, &revision)?;
    let absolute = safe_path(state.vault.root(), &path)?;
    fs::remove_file(&absolute).map_err(io_error)?;
    flush_directory(absolute.parent().expect("snapshot parent")).map_err(io_error)?;
    Ok(StatusCode::NO_CONTENT)
}
