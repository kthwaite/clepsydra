//! Handlers for managing attachments in the vault.
//! Attachments are files stored in a designated folder within the vault, and can be
//! uploaded, listed, retrieved, and deleted via the API.
use std::io::ErrorKind;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
pub struct AttachmentInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(list_attachments)).route(
        "/{*path}",
        get(get_attachment)
            .post(upload_attachment)
            .delete(delete_attachment),
    )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/attachments",
    context_path = "/api/vault",
    tag = "Attachments",
    responses(
        (status = 200, description = "List attachments", body = [AttachmentInfo]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn list_attachments(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<AttachmentInfo>>, ApiError> {
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let abs_dir = state.vault.root().join(attachment_folder);

    if !abs_dir.is_dir() {
        return Ok(Json(Vec::new()));
    }

    let mut attachments = Vec::new();

    for entry in walkdir::WalkDir::new(&abs_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let abs_path = entry.path();
        let rel = abs_path
            .strip_prefix(state.vault.root())
            .unwrap_or(abs_path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        // Strip the attachment folder prefix so paths are relative to the
        // attachment folder — get/delete handlers prepend it back.
        let rel_str = rel_str
            .strip_prefix(attachment_folder)
            .unwrap_or(&rel_str)
            .trim_start_matches('/')
            .to_string();
        let name = entry.file_name().to_string_lossy().to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        attachments.push(AttachmentInfo {
            name,
            path: rel_str,
            size,
        });
    }

    attachments.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(attachments))
}

#[utoipa::path(
    post,
    path = "/attachments/{path}",
    context_path = "/api/vault",
    tag = "Attachments",
    params(("path" = String, Path, description = "Attachment path relative to attachment folder")),
    request_body(content = String, content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "Attachment uploaded", body = AttachmentInfo),
        (status = 400, description = "Invalid request", body = ApiError),
        (status = 409, description = "Attachment already exists", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn upload_attachment(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let rel_path = format!("{attachment_folder}/{path}");

    let vault_path = VaultPath::new(&rel_path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);

    if tokio::fs::try_exists(&abs_path)
        .await
        .map_err(|e| ApiError::internal(format!("failed to check attachment: {e}")))?
    {
        return Err(ApiError::conflict(format!(
            "attachment already exists: {path}"
        )));
    }

    let parent = abs_path
        .parent()
        .ok_or_else(|| ApiError::internal("attachment path has no parent".to_string()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;

    let file_name = abs_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    let (temp_path, mut temp_file) = loop {
        let candidate = parent.join(format!(".{file_name}.{}.upload", Uuid::now_v7()));
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(ApiError::internal(format!(
                    "failed to create temporary attachment: {error}"
                )));
            }
        }
    };

    let upload_result = async {
        let mut field = multipart
            .next_field()
            .await
            .map_err(|e| ApiError::bad_request(format!("invalid multipart: {e}")))?
            .ok_or_else(|| ApiError::bad_request("no file field in multipart body".to_string()))?;
        let mut size = 0_u64;

        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| ApiError::bad_request(format!("failed to read file: {e}")))?
        {
            temp_file
                .write_all(&chunk)
                .await
                .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;
            size = size
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| ApiError::internal("attachment size overflow".to_string()))?;
        }

        temp_file
            .flush()
            .await
            .map_err(|e| ApiError::internal(format!("failed to flush attachment: {e}")))?;
        temp_file
            .sync_all()
            .await
            .map_err(|e| ApiError::internal(format!("failed to sync attachment: {e}")))?;
        drop(temp_file);

        tokio::fs::hard_link(&temp_path, &abs_path)
            .await
            .map_err(|error| {
                if error.kind() == ErrorKind::AlreadyExists {
                    ApiError::conflict(format!("attachment already exists: {path}"))
                } else {
                    ApiError::internal(format!("failed to install attachment: {error}"))
                }
            })?;

        Ok::<u64, ApiError>(size)
    }
    .await;

    let cleanup_result = tokio::fs::remove_file(&temp_path).await;
    let size = match upload_result {
        Ok(size) => {
            cleanup_result.map_err(|e| {
                ApiError::internal(format!("failed to remove temporary attachment: {e}"))
            })?;
            size
        }
        Err(error) => {
            let _ = cleanup_result;
            return Err(error);
        }
    };

    let name = abs_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok((
        StatusCode::CREATED,
        Json(AttachmentInfo { name, path, size }),
    )
        .into_response())
}

#[utoipa::path(
    get,
    path = "/attachments/{path}",
    context_path = "/api/vault",
    tag = "Attachments",
    params(("path" = String, Path, description = "Attachment path relative to attachment folder")),
    responses(
        (status = 200, description = "Attachment bytes", body = String, content_type = "application/octet-stream"),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Attachment not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_attachment(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    // Build the vault path relative to the attachment folder
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let rel_path = format!("{attachment_folder}/{path}");

    let vault_path = VaultPath::new(&rel_path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.is_file() {
        return Err(ApiError::not_found(format!("attachment not found: {path}")));
    }

    let bytes = tokio::fs::read(&abs_path)
        .await
        .map_err(|e| ApiError::internal(format!("failed to read attachment: {e}")))?;

    let content_type = mime_guess::from_path(&abs_path)
        .first_or_octet_stream()
        .to_string();

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type)],
        Body::from(bytes),
    )
        .into_response())
}

#[utoipa::path(
    delete,
    path = "/attachments/{path}",
    context_path = "/api/vault",
    tag = "Attachments",
    params(("path" = String, Path, description = "Attachment path relative to attachment folder")),
    responses(
        (status = 204, description = "Attachment deleted"),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 404, description = "Attachment not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn delete_attachment(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let rel_path = format!("{attachment_folder}/{path}");

    let vault_path = VaultPath::new(&rel_path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.is_file() {
        return Err(ApiError::not_found(format!("attachment not found: {path}")));
    }

    tokio::fs::remove_file(&abs_path)
        .await
        .map_err(|e| ApiError::internal(format!("failed to delete attachment: {e}")))?;

    Ok(StatusCode::NO_CONTENT.into_response())
}
