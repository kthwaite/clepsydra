use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};

use super::{
    AppState,
    error::{ApiError, parse_request_path},
};

/// Export one saved plaintext page as a read-only Word snapshot.
#[utoipa::path(
    get,
    path = "/pages-export/word/{path}",
    context_path = "/api/vault",
    tag = "Pages",
    params(("path" = String, Path, description = "Vault-relative saved Markdown page path")),
    responses(
        (status = 200, description = "Word document download", body = String, content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        (status = 400, description = "Invalid page path", body = ApiError),
        (status = 403, description = "Encrypted, excluded, private, or unsafe source", body = ApiError),
        (status = 404, description = "Page or attachment not found", body = ApiError),
        (status = 422, description = "Unavailable embed, remote or unsupported image, recursive content, or export resource limit", body = ApiError),
        (status = 500, description = "Export worker failed", body = ApiError)
    )
)]
pub async fn export_word(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Response, ApiError> {
    let path = parse_request_path(&path, "invalid export page path")?;
    let (title, bytes) = crate::page_export::export_word(state, path).await?;
    download(
        &title,
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Body::from(bytes),
    )
}

/// An attachment response named after the page title, never cached or sniffed.
fn download(
    title: &str,
    extension: &str,
    content_type: &'static str,
    body: Body,
) -> Result<Response, ApiError> {
    let mut filename: String = title
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| {
            if matches!(ch, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*') {
                '-'
            } else {
                ch
            }
        })
        .take(120)
        .collect();
    filename = filename.trim_matches([' ', '.']).to_string();
    if filename.is_empty() {
        filename.push_str("page");
    }
    filename.push('.');
    filename.push_str(extension);
    let ascii: String = filename
        .chars()
        .map(|ch| if ch.is_ascii() { ch } else { '_' })
        .collect();
    let encoded =
        percent_encoding::utf8_percent_encode(&filename, percent_encoding::NON_ALPHANUMERIC);
    let disposition = HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .map_err(|_| ApiError::internal("download filename could not be encoded"))?;
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        body,
    )
        .into_response())
}
