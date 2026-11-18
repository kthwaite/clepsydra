//! Handlers for block-related API endpoints.
use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::AppState;
use super::error::ApiError;
use crate::vault::block::{Block, BlockType, parse_blocks};
use crate::vault::block_id::BlockId;
use crate::vault::mutation_coordinator::ReplacePageContentCommand;
use crate::vault::page::Page;
use crate::vault::path::VaultPath;

// ---------------------------------------------------------------------------
// Response / request types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, ToSchema)]
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

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    8
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignIdRequest {
    pub page_path: String,
    pub span_start: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AssignIdResponse {
    pub block_id: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /blocks/{block_id} — single block lookup
#[utoipa::path(
    get,
    path = "/blocks/{block_id}",
    context_path = "/api/vault",
    tag = "Blocks",
    params(("block_id" = String, Path, description = "Block ID")),
    responses(
        (status = 200, description = "Block detail", body = BlockResponse),
        (status = 404, description = "Block not found", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn get_block(
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
#[utoipa::path(
    get,
    path = "/blocks/search",
    context_path = "/api/vault",
    tag = "Blocks",
    params(SearchQuery),
    responses(
        (status = 200, description = "Matching blocks", body = [BlockResponse]),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn search_blocks(
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
#[utoipa::path(
    post,
    path = "/blocks/assign-id",
    context_path = "/api/vault",
    tag = "Blocks",
    request_body = AssignIdRequest,
    responses(
        (status = 200, description = "Assigned block ID", body = AssignIdResponse),
        (status = 400, description = "Invalid block target", body = ApiError),
        (status = 409, description = "Block target is stale or protected", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn assign_block_id(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AssignIdRequest>,
) -> Result<Json<AssignIdResponse>, ApiError> {
    let vault_path = VaultPath::new(&req.page_path)
        .map_err(|e| ApiError::bad_request(format!("Invalid path: {}", e)))?;
    let span_start = req.span_start;
    let page_path = req.page_path.clone();

    let abs_path = state.vault.resolve(&vault_path);
    if Page::from_file(&abs_path, vault_path.clone()).is_ok_and(|page| page.is_encrypted()) {
        return Err(ApiError::conflict(
            "cannot assign a block ID inside a protected page",
        ));
    }

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

    let content = std::fs::read_to_string(&abs_path)
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
    let blocks = parse_blocks(body);
    let target = blocks.iter().position(|block| {
        block.span.start == span_start
            && block.span.end == span_end
            && block.content == indexed_content
            && block.block_id == indexed_block_id
    });
    let Some(target) = target else {
        return Err(ApiError::conflict(format!(
            "Block target is stale at path={}, span_start={}",
            page_path, span_start
        )));
    };
    if !body.is_char_boundary(span_start) || !body.is_char_boundary(span_end) {
        return Err(ApiError::conflict(
            "Block target is not on UTF-8 boundaries",
        ));
    }

    // A block has one id: a second marker would turn the first into text and
    // break every reference to it.
    if let Some(existing) = &blocks[target].block_id {
        return Ok(Json(AssignIdResponse {
            block_id: existing.clone(),
        }));
    }

    let id_str = BlockId::generate().to_string();
    let marker = format!(" ^{id_str}");
    let new_body = id_insertion_offset(body, &blocks, target)
        .map(|offset| format!("{}{marker}{}", &body[..offset], &body[offset..]))
        .filter(|new_body| {
            only_adds_id(
                &blocks,
                &parse_blocks(new_body),
                target,
                &id_str,
                marker.len(),
            )
        })
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "Block at path={}, span_start={} cannot carry a block ID at the end of its text",
                page_path, span_start
            ))
        })?;
    let content = format!("{}{new_body}", &content[..body_offset]);
    let notify = crate::api::mutation_notifier(&state);
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
            notify.as_ref(),
        )
        .await
        .map_err(crate::api::mutation_error)?;

    Ok(Json(AssignIdResponse { block_id: id_str }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Byte offset in `body` where ` ^id` attaches to `blocks[target]`: the end
/// of the block's own text, before trailing spaces and the line terminator.
///
/// The block's span is not enough to find it. A tight list item's span runs
/// over its nested children and over the blank line that ends the list, and a
/// setext heading's span runs over its underline. The block's own text is the
/// part of the span before the first nested block, less trailing blank lines
/// (inside a blockquote those hold only `>` markers) and less the underline.
/// In an ATX heading with a closing sequence (`# Title #`) the id goes before
/// the closing hashes, which would otherwise become heading text.
///
/// Returns `None` for a block whose last line is syntax an id would break: a
/// code block (the id would be code, or stop the fence closing) and a block
/// ending in a `$$` math fence.
fn id_insertion_offset(body: &str, blocks: &[Block], target: usize) -> Option<usize> {
    const INLINE_SPACE: [char; 3] = [' ', '\t', '\r'];

    let block = &blocks[target];
    if block.block_type == BlockType::Code {
        return None;
    }
    let own_end = blocks
        .get(target + 1)
        .map(|next| next.span.start)
        .filter(|start| block.span.contains(start))
        .unwrap_or(block.span.end);
    let own = body.get(block.span.start..own_end)?;

    // (offset in `own`, text without trailing spaces or line terminator).
    let mut lines: Vec<(usize, &str)> = Vec::new();
    let mut offset = 0;
    for line in own.split_inclusive('\n') {
        lines.push((
            offset,
            line.trim_end_matches('\n').trim_end_matches(INLINE_SPACE),
        ));
        offset += line.len();
    }
    let is_blank = |text: &str| {
        text.chars()
            .all(|ch| INLINE_SPACE.contains(&ch) || ch == '>')
    };
    while lines.len() > 1 && lines.last().is_some_and(|(_, text)| is_blank(text)) {
        lines.pop();
    }
    if block.block_type == BlockType::Heading
        && lines.len() > 1
        && lines.last().is_some_and(|(_, text)| {
            let underline = text.trim_start_matches(|ch| INLINE_SPACE.contains(&ch) || ch == '>');
            !underline.is_empty()
                && (underline.chars().all(|ch| ch == '=') || underline.chars().all(|ch| ch == '-'))
        })
    {
        lines.pop();
    }

    let (line_start, mut text) = *lines.last()?;
    if text.ends_with("$$") {
        return None;
    }
    if block.block_type == BlockType::Heading && lines.len() == 1 && text.starts_with('#') {
        let without_closing = text.trim_end_matches('#');
        if without_closing.len() < text.len() && without_closing.ends_with([' ', '\t']) {
            text = without_closing.trim_end_matches(INLINE_SPACE);
        }
    }
    Some(block.span.start + line_start + text.len())
}

/// Whether `after` (the blocks of the page with the id marker inserted) is
/// `before` with `id` on `before[target]` and nothing else changed: the same
/// blocks, in the same places, with the same text. This is the guard that
/// keeps an insertion from changing any other block of the user's page.
fn only_adds_id(
    before: &[Block],
    after: &[Block],
    target: usize,
    id: &str,
    marker_len: usize,
) -> bool {
    before.len() == after.len()
        && before
            .iter()
            .zip(after)
            .enumerate()
            .all(|(index, (old, new))| {
                let shift = if index > target { marker_len } else { 0 };
                let id_matches = if index == target {
                    new.block_id.as_deref() == Some(id)
                } else {
                    new.block_id == old.block_id
                };
                id_matches
                    && new.block_type == old.block_type
                    && new.content == old.content
                    && new.properties == old.properties
                    && new.checkbox == old.checkbox
                    && new.depth == old.depth
                    && new.span.start == old.span.start + shift
            })
}

/// Find the byte offset where the body begins (after the closing frontmatter
/// fence, `+++` or legacy `---`). Returns 0 if no frontmatter is detected.
fn find_body_offset(content: &str) -> usize {
    crate::vault::page::body_offset(content)
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
