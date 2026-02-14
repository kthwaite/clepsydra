use std::fs;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::AppState;
use super::error::ApiError;
use super::events::SyncNotification;
use crate::vault::cas::ContentStore;
use crate::vault::page::{PageMeta, parse_frontmatter, write_page_content};
use crate::vault::path::VaultPath;

#[derive(Debug, Deserialize)]
pub struct ArchiveRequest {
    pub url: String,
    pub canonical_url: Option<String>,
    pub domain: String,
    pub title: String,
    pub description: Option<String>,
    pub captured_at: String,
    pub content_hash: String,
    pub snapshot_hash: String,
    pub markdown_body: String,
    pub tags: Vec<String>,
    pub blobs: Vec<BlobUpload>,
}

#[derive(Debug, Deserialize)]
pub struct BlobUpload {
    pub hash: String,
    pub content_type: String,
    pub data: String, // base64
}

#[derive(Debug, Serialize)]
pub struct ArchiveResponse {
    pub page_id: String,
    pub vault_path: String,
    pub blobs_stored: u32,
    pub blobs_deduped: u32,
    pub status: ArchiveStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveStatus {
    Created,
    AlreadyExists,
    ContentChanged,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", post(ingest_archive))
}

/// Convert a title to a URL-safe slug, truncated to `max_len` chars.
pub(crate) fn slugify(title: &str, max_len: usize) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    // Collapse runs of dashes, trim leading/trailing dashes
    let collapsed: String = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.len() > max_len {
        // Truncate at a dash boundary if possible
        match collapsed[..max_len].rfind('-') {
            Some(pos) if pos > max_len / 2 => collapsed[..pos].to_string(),
            _ => collapsed[..max_len].to_string(),
        }
    } else {
        collapsed
    }
}

/// Search archive pages for an existing archive of the given URL.
///
/// Returns `Some((page_id, vault_path, content_hash))` if found.
fn find_existing_archive(
    state: &AppState,
    url: &str,
    prefix: &str,
) -> Option<(String, String, String)> {
    let archive_dir = state.vault.root().join(prefix);
    if !archive_dir.exists() {
        return None;
    }

    for entry in WalkDir::new(&archive_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (meta, _body) = match parse_frontmatter(&content) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        // Check the archive.url field in extra metadata
        if let Some(archive_val) = meta.extra.get("archive")
            && let Some(mapping) = archive_val.as_mapping()
        {
            let url_key = serde_yaml::Value::String("url".to_string());
            if let Some(serde_yaml::Value::String(archive_url)) = mapping.get(&url_key)
                && archive_url == url
            {
                let hash_key = serde_yaml::Value::String("content_hash".to_string());
                let content_hash = mapping
                    .get(&hash_key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let rel_path = path
                    .strip_prefix(state.vault.root())
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();

                return Some((meta.id.to_string(), rel_path, content_hash));
            }
        }
    }

    None
}

async fn ingest_archive(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ArchiveRequest>,
) -> Result<Response, ApiError> {
    let archive_config = &state.vault.config().archive;
    let prefix = &archive_config.default_path_prefix;

    // 1. Check for existing archive of this URL
    if let Some((page_id, vault_path, existing_hash)) =
        find_existing_archive(&state, &req.url, prefix)
    {
        if existing_hash == req.content_hash {
            return Ok((
                StatusCode::OK,
                Json(ArchiveResponse {
                    page_id,
                    vault_path,
                    blobs_stored: 0,
                    blobs_deduped: 0,
                    status: ArchiveStatus::AlreadyExists,
                }),
            )
                .into_response());
        } else {
            return Err(ApiError::conflict_with_detail(
                format!("archive exists with different content: {}", req.url),
                serde_json::json!({
                    "existing_hash": existing_hash,
                    "new_hash": req.content_hash,
                    "page_id": page_id,
                    "vault_path": vault_path,
                }),
            ));
        }
    }

    // 2. Store blobs in CAS
    let mut blobs_stored: u32 = 0;
    let mut blobs_deduped: u32 = 0;

    for blob in &req.blobs {
        let data = BASE64
            .decode(&blob.data)
            .map_err(|e| ApiError::bad_request(format!("invalid base64 in blob: {e}")))?;

        // Verify the declared hash matches
        let computed_hash = ContentStore::hash_bytes(&data);
        if computed_hash != blob.hash {
            return Err(ApiError::bad_request(format!(
                "blob hash mismatch: declared={}, computed={}",
                blob.hash, computed_hash
            )));
        }

        let cas = state.cas.lock();
        let result = cas
            .store(&data, &blob.content_type)
            .map_err(|e| ApiError::internal(format!("CAS store error: {e}")))?;

        if result.already_existed {
            blobs_deduped += 1;
        } else {
            blobs_stored += 1;
        }
    }

    // 3. Create the vault page
    let slug = slugify(&req.title, 80);
    let slug = if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    };

    let base_path = format!("{}/{}/{}.md", prefix, req.domain, slug);
    let mut page_path = base_path.clone();

    // Handle path collisions with numeric suffix
    let vault_root = state.vault.root();
    let mut counter = 1u32;
    while vault_root.join(&page_path).exists() {
        page_path = format!("{}/{}/{}-{}.md", prefix, req.domain, slug, counter);
        counter += 1;
        if counter > 1000 {
            return Err(ApiError::internal(
                "too many path collisions for archive page".to_string(),
            ));
        }
    }

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::bad_request(format!("invalid generated path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);

    // Create parent directories
    if let Some(parent) = abs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| ApiError::internal(format!("failed to create directories: {e}")))?;
    }

    // Build PageMeta with archive metadata in extra
    let mut meta = PageMeta::new();
    meta.title = Some(req.title.clone());
    meta.tags = req.tags.clone();

    // Build archive metadata as a nested YAML mapping
    let mut archive_map = serde_yaml::Mapping::new();
    archive_map.insert(
        serde_yaml::Value::String("url".to_string()),
        serde_yaml::Value::String(req.url.clone()),
    );
    if let Some(ref canonical_url) = req.canonical_url {
        archive_map.insert(
            serde_yaml::Value::String("canonical_url".to_string()),
            serde_yaml::Value::String(canonical_url.clone()),
        );
    }
    archive_map.insert(
        serde_yaml::Value::String("domain".to_string()),
        serde_yaml::Value::String(req.domain.clone()),
    );
    archive_map.insert(
        serde_yaml::Value::String("captured_at".to_string()),
        serde_yaml::Value::String(req.captured_at.clone()),
    );
    archive_map.insert(
        serde_yaml::Value::String("content_hash".to_string()),
        serde_yaml::Value::String(req.content_hash.clone()),
    );
    archive_map.insert(
        serde_yaml::Value::String("snapshot_hash".to_string()),
        serde_yaml::Value::String(req.snapshot_hash.clone()),
    );
    if let Some(ref description) = req.description {
        archive_map.insert(
            serde_yaml::Value::String("description".to_string()),
            serde_yaml::Value::String(description.clone()),
        );
    }

    // Add blob hashes list
    if !req.blobs.is_empty() {
        let blob_hashes: Vec<serde_yaml::Value> = req
            .blobs
            .iter()
            .map(|b| serde_yaml::Value::String(b.hash.clone()))
            .collect();
        archive_map.insert(
            serde_yaml::Value::String("blobs".to_string()),
            serde_yaml::Value::Sequence(blob_hashes),
        );
    }

    meta.extra.insert(
        "archive".to_string(),
        serde_yaml::Value::Mapping(archive_map),
    );

    let page_body = &req.markdown_body;

    // Write file
    let content = write_page_content(&meta, page_body);
    fs::write(&abs_path, &content)
        .map_err(|e| ApiError::internal(format!("failed to write file: {e}")))?;

    let page_id = meta.id.to_string();

    // 4. Index the page
    {
        let mut index = state.index.lock();
        index
            .index_page(&state.vault, &vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
        index
            .resolve_links_for_page(&vault_path)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }

    // 5. Broadcast change
    let _ = state.change_tx.send(SyncNotification::IndexChanged {
        upserted: vec![vault_path.as_str().to_string()],
        removed: vec![],
    });

    // 6. Return response
    Ok((
        StatusCode::CREATED,
        Json(ArchiveResponse {
            page_id,
            vault_path: vault_path.as_str().to_string(),
            blobs_stored,
            blobs_deduped,
            status: ArchiveStatus::Created,
        }),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World", 80), "hello-world");
    }

    #[test]
    fn slugify_special_chars() {
        assert_eq!(
            slugify("The Architecture of Open-Source Applications!", 80),
            "the-architecture-of-open-source-applications"
        );
    }

    #[test]
    fn slugify_truncates() {
        let long_title = "a ".repeat(50); // 100 chars worth
        let slug = slugify(&long_title, 20);
        assert!(slug.len() <= 20);
    }

    #[test]
    fn slugify_unicode() {
        // Unicode alphanumeric chars should be preserved
        assert_eq!(slugify("Über die Grenzen", 80), "über-die-grenzen");
    }

    #[test]
    fn slugify_empty() {
        assert_eq!(slugify("", 80), "");
    }

    #[test]
    fn slugify_all_special() {
        assert_eq!(slugify("---!!!", 80), "");
    }
}
