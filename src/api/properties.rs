//! The property patch: the one new write path of the bases system.
//!
//! A patch is a *splice*, not a rewrite: the raw page content goes through
//! `toml_patch::splice_frontmatter`, so comments and untouched keys survive
//! byte-for-byte, then rides `ReplacePageContentCommand` for optimistic
//! concurrency. A legacy `---` page heals to TOML first (full
//! serialization) — the one documented exception to comment preservation,
//! and only during the transition.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use super::events::SyncNotification;
use crate::vault::base::PropertyType;
use crate::vault::mutation_coordinator::{MutationNotification, ReplacePageContentCommand};
use crate::vault::page::{page_revision, parse_or_repair_frontmatter, write_page_content};
use crate::vault::path::VaultPath;
use crate::vault::toml_patch::{FrontmatterEdits, SpliceError, ValueHint, splice_frontmatter};

// NOTE: the board's tri-state `Option<Option<T>>` deserializer is not reused
// here. It exists to distinguish absent-vs-null in a flat PATCH body; this
// endpoint carries explicit `set` / `clear` collections instead, so absence
// is simply "not mentioned" and no tri-state is needed.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PropertyPatchRequest {
    /// Keys to set, with their new JSON values.
    #[serde(default)]
    pub set: HashMap<String, serde_json::Value>,
    /// Keys to remove.
    #[serde(default)]
    pub clear: Vec<String>,
    /// Type hints per key (`{ "started": "date" }`): JSON has no date type,
    /// so hinted ISO strings are written as native TOML date-times.
    #[serde(default)]
    pub types: HashMap<String, PropertyType>,
    /// Revision (blake3 of the exact page bytes) the client last saw.
    pub expected_revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PropertyPatchResponse {
    pub id: String,
    pub path: String,
    /// Revision of the page after the patch.
    pub revision: String,
    /// Refreshed property projections (read-after-write): key → value, with
    /// multi-valued keys as arrays.
    #[schema(value_type = Object)]
    pub properties: serde_json::Map<String, serde_json::Value>,
}

fn hint_for(ty: Option<&PropertyType>) -> Option<ValueHint> {
    match ty {
        Some(PropertyType::Date) => Some(ValueHint::Date),
        Some(PropertyType::Datetime) => Some(ValueHint::DateTime),
        _ => None,
    }
}

/// Apply a property patch to the page with the given id.
#[utoipa::path(
    patch,
    path = "/by-id/{uuid}/properties",
    context_path = "/api/vault/pages",
    tag = "Bases",
    params(("uuid" = String, Path, description = "Page UUID")),
    request_body = PropertyPatchRequest,
    responses(
        (status = 200, body = PropertyPatchResponse),
        (status = 400, description = "Unrepresentable value"),
        (status = 404, description = "Unknown page"),
        (status = 409, description = "Stale expected_revision")
    )
)]
pub async fn patch_properties(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<Uuid>,
    Json(request): Json<PropertyPatchRequest>,
) -> Result<Json<PropertyPatchResponse>, ApiError> {
    let page_id = uuid.to_string();

    // Resolve the page path from the index.
    let lookup_id = page_id.clone();
    let path: Option<String> = state
        .index
        .with_index(move |index, _vault| {
            index
                .connection()
                .query_row(
                    "SELECT path FROM pages WHERE id = ?1",
                    rusqlite::params![lookup_id],
                    |row| row.get(0),
                )
                .ok()
        })
        .await
        .map_err(|e| ApiError::internal(format!("index error: {e}")))?;
    let path = path.ok_or_else(|| ApiError::not_found(format!("no page with id {page_id}")))?;
    let vault_path =
        VaultPath::new(&path).map_err(|e| ApiError::internal(format!("bad indexed path: {e}")))?;

    let abs_path = state.vault.resolve(&vault_path);
    let raw = std::fs::read_to_string(&abs_path)
        .map_err(|e| ApiError::internal(format!("cannot read page: {e}")))?;

    let current_revision = page_revision(&raw);
    if current_revision != request.expected_revision {
        return Err(ApiError::conflict_with_detail(
            "page content changed since expected_revision",
            serde_json::json!({ "revision": current_revision }),
        ));
    }

    let mut edits = FrontmatterEdits {
        updated_at: Some(state.clock.now()),
        ..Default::default()
    };
    for (key, value) in &request.set {
        edits
            .set
            .push((key.clone(), value.clone(), hint_for(request.types.get(key))));
    }
    edits.remove = request.clear.clone();

    let new_content = match splice_frontmatter(&raw, &edits) {
        Ok(content) => content,
        Err(SpliceError::LegacyFrontmatter) => {
            // Heal-first: full TOML serialization, then splice the healed
            // content. Legacy YAML comments are lost here by design.
            let (meta, body, _, warning) = parse_or_repair_frontmatter(&raw);
            if let Some(w) = warning {
                return Err(ApiError::conflict(format!(
                    "legacy frontmatter cannot be healed: {w}"
                )));
            }
            let healed = write_page_content(&meta, &body);
            splice_frontmatter(&healed, &edits)
                .map_err(|e| ApiError::bad_request(format!("cannot splice frontmatter: {e}")))?
        }
        Err(e @ (SpliceError::NoFrontmatter | SpliceError::Toml(_))) => {
            return Err(ApiError::conflict(format!("cannot patch page: {e}")));
        }
        Err(e) => {
            return Err(ApiError::bad_request(format!("invalid patch value: {e}")));
        }
    };

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
                path: vault_path.clone(),
                expected_content: raw,
                content: new_content.clone(),
            },
            &notify,
        )
        .await
        .map_err(super::mutation_error)?;

    // Read-after-write: refreshed projections so the UI reconciles without
    // waiting on the SSE round-trip (the board pattern).
    let props_id = page_id.clone();
    let properties = state
        .index
        .with_index(move |index, _vault| -> Result<_, rusqlite::Error> {
            let mut stmt = index.connection().prepare(
                "SELECT key, value_json FROM page_properties WHERE page_id = ?1 ORDER BY key, ord",
            )?;
            let rows: Vec<(String, String)> = stmt
                .query_map(rusqlite::params![props_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| ApiError::internal(format!("index error: {e}")))?
        .map_err(|e| ApiError::internal(format!("read-after-write failed: {e}")))?;

    let mut grouped: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    for (key, value_json) in properties {
        let value: serde_json::Value =
            serde_json::from_str(&value_json).unwrap_or(serde_json::Value::Null);
        match grouped.get_mut(&key) {
            None => {
                grouped.insert(key, value);
            }
            Some(serde_json::Value::Array(items)) => items.push(value),
            Some(existing) => {
                let first = existing.take();
                *existing = serde_json::Value::Array(vec![first, value]);
            }
        }
    }

    Ok(Json(PropertyPatchResponse {
        id: page_id,
        path,
        revision: page_revision(&new_content),
        properties: grouped,
    }))
}
