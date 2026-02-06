use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Serialize;

use super::AppState;
use super::error::ApiError;
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct AttachmentInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_attachments))
        .route("/{*path}", get(get_attachment).delete(delete_attachment))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list_attachments(
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

async fn get_attachment(
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

    let bytes = fs::read(&abs_path)
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

async fn delete_attachment(
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

    fs::remove_file(&abs_path)
        .map_err(|e| ApiError::internal(format!("failed to delete attachment: {e}")))?;

    Ok(StatusCode::NO_CONTENT.into_response())
}
