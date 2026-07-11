//! Handlers for block-related API endpoints.
use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::AppState;
use super::error::ApiError;
use super::events::SyncNotification;
use crate::vault::block::parse_blocks;
use crate::vault::block_id::BlockId;
use crate::vault::mutation_coordinator::{MutationNotification, ReplacePageContentCommand};
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct BlockResponse {
    pub block_id: Option<String>,
    pub content: String,
    pub block_type: String,
    pub properties: HashMap<String, String>,
    pub page_path: String,
    pub page_title: Option<String>,
    pub span_start: i64,
    pub span_end: i64,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    8
}

#[derive(Debug, Deserialize)]
pub struct AssignIdRequest {
    pub page_path: String,
    pub span_start: i64,
}

#[derive(Debug, Serialize)]
pub struct AssignIdResponse {
    pub block_id: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /blocks/{block_id} — single block lookup
async fn get_block(
    State(state): State<Arc<AppState>>,
    Path(block_id): Path<String>,
) -> Result<Json<BlockResponse>, ApiError> {
    let block_id_clone = block_id.clone();
    let result = state
        .index
        .with_index(move |index, _vault| {
            let block_id = block_id_clone;
            let conn = index.connection();

            // Query block with join to pages table
            let mut stmt = conn.prepare(
                "SELECT b.block_id, b.content, b.block_type, b.span_start, b.span_end, b.page_id, p.path, p.title
                 FROM blocks b JOIN pages p ON p.id = b.page_id
                 WHERE b.block_id = ?1"
            )?;

            let row: Result<_, rusqlite::Error> = stmt.query_row(params![&block_id], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            });

            let row = match row {
                Ok(r) => r,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(e),
            };

            let (bid, content, block_type, span_start, span_end, page_id, page_path, page_title) = row;

            // Fetch properties
            let mut properties = HashMap::new();
            let mut prop_stmt = conn.prepare(
                "SELECT key, value FROM block_properties WHERE page_id = ?1 AND span_start = ?2"
            )?;
            let prop_rows = prop_stmt.query_map(params![&page_id, span_start], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;

            for prop in prop_rows {
                let (key, value) = prop?;
                properties.insert(key, value);
            }

            Ok(Some(BlockResponse {
                block_id: Some(bid.unwrap_or_else(|| block_id.clone())),
                content,
                block_type,
                properties,
                page_path,
                page_title,
                span_start,
                span_end,
            }))
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    match result {
        Some(block) => Ok(Json(block)),
        None => Err(ApiError::not_found(format!(
            "Block not found: {}",
            block_id
        ))),
    }
}

/// GET /blocks/search?q=&limit= — block content search
async fn search_blocks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<BlockResponse>>, ApiError> {
    let search_pattern = format!("%{}%", query.q);
    let limit = query.limit;

    let result = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();

            let mut stmt = conn.prepare(
                "SELECT b.block_id, b.content, b.block_type, b.span_start, b.span_end, b.page_id, p.path, p.title
                 FROM blocks b JOIN pages p ON p.id = b.page_id
                 WHERE b.content LIKE ?1 COLLATE NOCASE
                   AND b.block_type IN ('listitem', 'paragraph', 'heading')
                 LIMIT ?2"
            )?;

            let rows = stmt.query_map(params![&search_pattern, limit], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })?;

            let mut results = Vec::new();
            for row in rows {
                let (bid, content, block_type, span_start, span_end, page_id, page_path, page_title) = row?;

                // Fetch properties for this block
                let mut properties = HashMap::new();
                let mut prop_stmt = conn.prepare(
                    "SELECT key, value FROM block_properties WHERE page_id = ?1 AND span_start = ?2"
                )?;
                let prop_rows = prop_stmt.query_map(params![&page_id, span_start], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;

                for prop in prop_rows {
                    let (key, value) = prop?;
                    properties.insert(key, value);
                }

                results.push(BlockResponse {
                    block_id: bid,
                    content,
                    block_type,
                    properties,
                    page_path,
                    page_title,
                    span_start,
                    span_end,
                });
            }

            Ok::<_, rusqlite::Error>(results)
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    Ok(Json(result))
}

/// POST /blocks/assign-id — auto-assign block ID
async fn assign_block_id(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AssignIdRequest>,
) -> Result<Json<AssignIdResponse>, ApiError> {
    let vault_path = VaultPath::new(&req.page_path)
        .map_err(|e| ApiError::bad_request(format!("Invalid path: {}", e)))?;
    let span_start = req.span_start;
    let page_path = req.page_path.clone();

    let lookup_path = page_path.clone();
    let indexed_block = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            let mut stmt = conn.prepare(
                "SELECT span_end, content, block_id
                 FROM blocks
                 WHERE page_id = (SELECT id FROM pages WHERE path = ?1)
                   AND span_start = ?2",
            )?;

            match stmt.query_row(params![&lookup_path, span_start], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            }) {
                Ok(block) => Ok::<_, rusqlite::Error>(Some(block)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let (span_end, indexed_content, indexed_block_id) = indexed_block.ok_or_else(|| {
        ApiError::conflict(format!(
            "Block target is stale at path={}, span_start={}",
            page_path, span_start
        ))
    })?;

    let abs_path = state.vault.resolve(&vault_path);
    let mut content = std::fs::read_to_string(&abs_path)
        .map_err(|e| ApiError::internal(format!("Failed to read file: {}", e)))?;
    let expected_content = content.clone();
    let body_offset = find_body_offset(&content);
    let body = content
        .get(body_offset..)
        .ok_or_else(|| ApiError::conflict("Block target is stale"))?;
    let span_start = usize::try_from(span_start)
        .map_err(|_| ApiError::conflict("Block target has an invalid span_start"))?;
    let span_end = usize::try_from(span_end)
        .map_err(|_| ApiError::conflict("Block target has an invalid span_end"))?;
    let current_block = parse_blocks(body).into_iter().find(|block| {
        block.span.start == span_start
            && block.span.end == span_end
            && block.content == indexed_content
            && block.block_id == indexed_block_id
    });
    if current_block.is_none() {
        return Err(ApiError::conflict(format!(
            "Block target is stale at path={}, span_start={}",
            page_path, span_start
        )));
    }
    if !body.is_char_boundary(span_start) || !body.is_char_boundary(span_end) {
        return Err(ApiError::conflict(
            "Block target is not on UTF-8 boundaries",
        ));
    }

    let file_span_end = body_offset
        .checked_add(span_end)
        .ok_or_else(|| ApiError::conflict("Block target span overflowed"))?;
    if file_span_end > content.len() || !content.is_char_boundary(file_span_end) {
        return Err(ApiError::conflict("Block target is stale"));
    }
    let insert_pos =
        if file_span_end > 0 && content.as_bytes().get(file_span_end - 1) == Some(&b'\n') {
            file_span_end - 1
        } else {
            file_span_end
        };
    if !content.is_char_boundary(insert_pos) {
        return Err(ApiError::conflict(
            "Block target is not on a UTF-8 boundary",
        ));
    }

    let id_str = BlockId::generate().to_string();
    content.insert_str(insert_pos, &format!(" ^{}", id_str));
    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    state
        .mutation_coordinator
        .replace_page_content(
            &state.vault,
            &state.index,
            ReplacePageContentCommand {
                path: vault_path,
                expected_content,
                content,
            },
            &notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    Ok(Json(AssignIdResponse { block_id: id_str }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Find the byte offset where the body begins (after the closing `---\n`
/// frontmatter fence). Returns 0 if no frontmatter is detected.
fn find_body_offset(content: &str) -> usize {
    if !content.starts_with("---") {
        return 0;
    }
    let after_open = match content[3..].find('\n') {
        Some(pos) => 3 + pos + 1,
        None => return 0,
    };
    let rest = &content[after_open..];
    let closing = if let Some(pos) = rest.find("\n---") {
        after_open + pos + 1
    } else if rest.starts_with("---") {
        after_open
    } else {
        return 0;
    };
    let after_closing = closing + 3;
    if after_closing < content.len() && content.as_bytes()[after_closing] == b'\n' {
        after_closing + 1
    } else {
        after_closing
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/search", get(search_blocks))
        .route("/assign-id", post(assign_block_id))
        .route("/{block_id}", get(get_block))
}
