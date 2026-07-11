//! Handlers for managing attachments in the vault.
//! Attachments are files stored in a designated folder within the vault, and can be
//! uploaded, listed, retrieved, and deleted via the API.
use std::io::{self, ErrorKind};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

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

use super::AppState;
use super::error::ApiError;
use crate::vault::atomic_file::install_noreplace;
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

fn attachment_io_error(error: io::Error, action: &str, path: &str) -> ApiError {
    if error.kind() == ErrorKind::NotFound {
        ApiError::not_found(format!("attachment not found: {path}"))
    } else {
        ApiError::internal(format!("failed to {action} attachment: {error}"))
    }
}

async fn require_attachment_file(abs_path: &FsPath, path: &str) -> Result<(), ApiError> {
    let metadata = tokio::fs::metadata(abs_path)
        .await
        .map_err(|error| attachment_io_error(error, "inspect", path))?;
    if metadata.is_file() {
        Ok(())
    } else {
        Err(ApiError::not_found(format!("attachment not found: {path}")))
    }
}

#[derive(Default)]
struct PendingTemporaryState {
    cancelled: bool,
    temporary: Option<tempfile::NamedTempFile>,
    creation_thread: Option<std::thread::ThreadId>,
}

struct PendingTemporaryCreation {
    state: Arc<Mutex<PendingTemporaryState>>,
    completed: std::sync::mpsc::Receiver<()>,
    armed: bool,
}

impl Drop for PendingTemporaryCreation {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.cancelled = true;
            drop(state.temporary.take());
        }
        let _ = self.completed.recv();
        if let Ok(mut state) = self.state.lock() {
            drop(state.temporary.take());
        }
    }
}

async fn create_upload_temporary_file(
    parent: PathBuf,
) -> Result<(tempfile::NamedTempFile, std::thread::ThreadId), ApiError> {
    let state = Arc::new(Mutex::new(PendingTemporaryState::default()));
    let worker_state = Arc::clone(&state);
    let (completed_tx, completed_rx) = std::sync::mpsc::channel();
    let mut pending = PendingTemporaryCreation {
        state,
        completed: completed_rx,
        armed: true,
    };
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            let temporary = tempfile::Builder::new()
                .prefix(".upload-")
                .rand_bytes(32)
                .tempfile_in(parent)?;
            let mut creation = worker_state
                .lock()
                .map_err(|_| io::Error::other("temporary attachment state poisoned"))?;
            if creation.cancelled {
                drop(creation);
                drop(temporary);
                return Err(io::Error::new(
                    ErrorKind::Interrupted,
                    "attachment upload cancelled during temporary file creation",
                ));
            }
            creation.creation_thread = Some(std::thread::current().id());
            creation.temporary = Some(temporary);
            Ok(())
        })();
        let _ = completed_tx.send(());
        result
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "temporary attachment creation task failed: {error}"
        ))
    })?
    .map_err(|error| {
        ApiError::internal(format!("failed to create temporary attachment: {error}"))
    })?;

    let (temporary, creation_thread) = {
        let mut state = pending
            .state
            .lock()
            .map_err(|_| ApiError::internal("temporary attachment state poisoned".to_string()))?;
        (
            state.temporary.take().ok_or_else(|| {
                ApiError::internal("temporary attachment task returned no file".to_string())
            })?,
            state.creation_thread.take().ok_or_else(|| {
                ApiError::internal("temporary attachment task returned no thread".to_string())
            })?,
        )
    };
    pending.armed = false;
    Ok((temporary, creation_thread))
}

async fn run_blocking_attachment_scan<T>(
    scan: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError>
where
    T: Send + 'static,
{
    tokio::task::spawn_blocking(scan)
        .await
        .map_err(|error| ApiError::internal(format!("attachment scan task failed: {error}")))
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
    let attachment_folder = state.vault.config().vault.attachment_folder.clone();
    let vault_root = state.vault.root().to_path_buf();
    let attachments = run_blocking_attachment_scan(move || {
        let abs_dir = vault_root.join(&attachment_folder);
        if !abs_dir.is_dir() {
            return Vec::new();
        }
        let mut attachments = Vec::new();
        for entry in walkdir::WalkDir::new(&abs_dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let absolute = entry.path();
            let relative = absolute.strip_prefix(&vault_root).unwrap_or(absolute);
            let relative = relative.to_string_lossy().replace('\\', "/");
            let path = relative
                .strip_prefix(&attachment_folder)
                .unwrap_or(&relative)
                .trim_start_matches('/')
                .to_string();
            attachments.push(AttachmentInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path,
                size: entry.metadata().map(|metadata| metadata.len()).unwrap_or(0),
            });
        }
        attachments.sort_by(|left, right| left.path.cmp(&right.path));
        attachments
    })
    .await?;
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
    let parent = abs_path
        .parent()
        .ok_or_else(|| ApiError::internal("attachment path has no parent".to_string()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;

    let (temporary, _creation_thread) = create_upload_temporary_file(parent.to_path_buf()).await?;
    let (temporary_file, temporary_path) = temporary.into_parts();
    let mut temporary_file = tokio::fs::File::from_std(temporary_file);

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
        temporary_file
            .write_all(&chunk)
            .await
            .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| ApiError::internal("attachment size overflow".to_string()))?;
    }

    temporary_file
        .flush()
        .await
        .map_err(|e| ApiError::internal(format!("failed to flush attachment: {e}")))?;
    temporary_file
        .sync_all()
        .await
        .map_err(|e| ApiError::internal(format!("failed to sync attachment: {e}")))?;
    drop(temporary_file);

    let install_destination = abs_path.clone();
    let (_temporary_path, install_result) = tokio::task::spawn_blocking(move || {
        let result = install_noreplace(&temporary_path, &install_destination);
        (temporary_path, result)
    })
    .await
    .map_err(|e| ApiError::internal(format!("failed to install attachment: {e}")))?;
    install_result.map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            ApiError::conflict(format!("attachment already exists: {path}"))
        } else if error.kind() == ErrorKind::Unsupported {
            ApiError::internal(format!(
                "atomic no-replace attachment installation is unsupported: {error}"
            ))
        } else {
            ApiError::internal(format!("failed to install attachment: {error}"))
        }
    })?;

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
    let attachment_folder = &state.vault.config().vault.attachment_folder;
    let rel_path = format!("{attachment_folder}/{path}");

    let vault_path = VaultPath::new(&rel_path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    require_attachment_file(&abs_path, &path).await?;

    let bytes = tokio::fs::read(&abs_path)
        .await
        .map_err(|error| attachment_io_error(error, "read", &path))?;

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
    require_attachment_file(&abs_path, &path).await?;

    tokio::fs::remove_file(&abs_path)
        .await
        .map_err(|error| attachment_io_error(error, "delete", &path))?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn attachment_scan_runs_off_the_tokio_worker() {
        let runtime_thread = std::thread::current().id();
        let scan_thread = run_blocking_attachment_scan(|| std::thread::current().id())
            .await
            .unwrap();

        assert_ne!(scan_thread, runtime_thread);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn attachment_temporary_creation_runs_off_the_tokio_worker() {
        let parent = tempfile::tempdir().unwrap();
        let runtime_thread = std::thread::current().id();
        let (temporary, creation_thread) =
            create_upload_temporary_file(parent.path().to_path_buf())
                .await
                .unwrap();

        assert_ne!(creation_thread, runtime_thread);
        drop(temporary);
    }
}
