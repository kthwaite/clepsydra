//! Exact page-tag renames use a read-only disk snapshot and the batch coordinator.
//! The fingerprint binds the source set, exact revisions, blockers and merge state;
//! apply reconstructs that snapshot while excluding other coordinated mutations.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use walkdir::WalkDir;

use super::AppState;
use super::error::ApiError;
use crate::vault::Vault;
use crate::vault::batch_mutation::{BatchMutationCommand, BatchPathIntent, ExpectedPathState};
use crate::vault::kind::{editable_tags, is_computed_tag, resolve};
use crate::vault::page::{body_of, page_revision, parse_or_repair_frontmatter};
use crate::vault::path::VaultPath;
use crate::vault::sync::ChangeEvent;
use crate::vault::toml_patch::{FrontmatterEdits, splice_frontmatter};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TagRenameRequest {
    /// Exact editable tag spelling; descendants and computed tags are untouched.
    pub source: String,
    pub target: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TagRenameApplyRequest {
    pub source: String,
    pub target: String,
    /// Fingerprint from the complete preview, including all source revisions.
    pub expected_fingerprint: String,
    /// Required when the destination already exists (including computed tags).
    pub acknowledge_merge: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TagRenamePage {
    pub path: String,
    pub title: String,
    pub revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TagRenameConflict {
    pub path: Option<String>,
    pub reason: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TagRenamePreview {
    pub source: String,
    pub target: String,
    pub fingerprint: String,
    pub target_exists: bool,
    /// Editable source pages, including any blocked pages listed in conflicts.
    pub affected_count: usize,
    /// Pages whose source tag is computed and will remain unchanged.
    pub computed_count: usize,
    pub pages: Vec<TagRenamePage>,
    pub conflicts: Vec<TagRenameConflict>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TagRenameResult {
    pub updated_count: usize,
}

fn validate_tag(tag: &str) -> Result<(), ApiError> {
    if tag.is_empty()
        || tag.trim() != tag
        || tag.starts_with('#')
        || tag.chars().any(char::is_control)
        || tag.split('/').any(|segment| segment.trim().is_empty())
    {
        return Err(ApiError::bad_request(
            "Tags must be nonempty, without a leading #, surrounding whitespace, control characters or empty hierarchy segments",
        ));
    }
    Ok(())
}

fn prepare(
    vault: &Vault,
    request: TagRenameRequest,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(TagRenamePreview, BatchMutationCommand), ApiError> {
    validate_tag(&request.source)?;
    validate_tag(&request.target)?;
    if request.source.eq_ignore_ascii_case(&request.target) {
        return Err(ApiError::bad_request(
            "Source and target must be different tags",
        ));
    }
    let mut preview = TagRenamePreview {
        source: request.source,
        target: request.target,
        fingerprint: String::new(),
        target_exists: false,
        affected_count: 0,
        computed_count: 0,
        pages: Vec::new(),
        conflicts: Vec::new(),
    };
    let mut command = BatchMutationCommand {
        intents: Vec::new(),
        create_directories: Vec::new(),
        remove_directories: Vec::new(),
        index_events: Vec::new(),
        moved_pages: Vec::new(),
    };
    // Do not use index membership here: external edits may not have reached the
    // watcher yet. Fail closed on unreadable entries rather than omit sources.
    for entry in WalkDir::new(vault.root())
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0 || (entry.file_name() != ".clepsydra" && entry.file_name() != ".git")
        })
    {
        let entry =
            entry.map_err(|error| ApiError::conflict(format!("Cannot inspect vault: {error}")))?;
        if !entry.file_type().is_file() || entry.path().extension().is_none_or(|ext| ext != "md") {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(vault.root())
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let path = VaultPath::new(&relative.to_string_lossy())
            .map_err(|error| ApiError::conflict(error.to_string()))?;
        if vault.is_excluded(&path) {
            continue;
        }
        let raw = std::fs::read_to_string(entry.path()).map_err(|error| {
            ApiError::conflict(format!("Cannot inspect {}: {error}", path.as_str()))
        })?;
        let (meta, _, needs_repair, warning) = parse_or_repair_frontmatter(&raw);
        // An unparseable page can conceal source membership: never claim a
        // complete source set when its metadata cannot be inspected.
        if let Some(warning) = warning {
            preview.conflicts.push(TagRenameConflict {
                path: Some(path.as_str().to_owned()),
                reason: format!("Repair frontmatter before renaming tags: {warning}"),
            });
            // Protected ciphertext and conflict-marker warnings still carry
            // parsed metadata. Count any known editable source membership and
            // bind its revision even though the whole operation is blocked.
            let kind = resolve(path.as_str(), meta.kind).0;
            if editable_tags(kind, &meta.tags).contains(&preview.source.as_str()) {
                preview.pages.push(TagRenamePage {
                    path: path.as_str().to_owned(),
                    title: meta.title.unwrap_or_else(|| path.as_str().to_owned()),
                    revision: page_revision(&raw),
                });
            }
            continue;
        }
        let kind = resolve(path.as_str(), meta.kind).0;
        let editable = editable_tags(kind, &meta.tags);
        if is_computed_tag(kind, &preview.target)
            || editable
                .iter()
                .any(|tag| tag.trim().eq_ignore_ascii_case(&preview.target))
        {
            preview.target_exists = true;
        }
        if kind.computed_tag() == preview.source {
            preview.computed_count += 1;
        }
        if !editable.contains(&preview.source.as_str()) {
            continue;
        }
        preview.pages.push(TagRenamePage {
            path: path.as_str().to_owned(),
            title: meta.title.unwrap_or_else(|| path.as_str().to_owned()),
            revision: page_revision(&raw),
        });
        let reason = if is_computed_tag(kind, &preview.target) {
            Some(
                "Target is this page's computed kind tag and cannot become an editable tag"
                    .to_owned(),
            )
        } else if needs_repair {
            Some("Repair or migrate this page's incomplete frontmatter before renaming; automatic index repair would not preserve its comments".to_owned())
        } else {
            None
        };
        if let Some(reason) = reason {
            preview.conflicts.push(TagRenameConflict {
                path: Some(path.as_str().to_owned()),
                reason,
            });
            continue;
        }
        // Replace exact occurrences only. Dedupe the destination using the
        // same normalized identity as editable_tags, leaving every other tag
        // (including descendants and redundant computed values) untouched.
        let mut target_seen = false;
        let tags: Vec<&str> = meta
            .tags
            .iter()
            .filter_map(|tag| {
                let renamed = if tag == &preview.source {
                    preview.target.as_str()
                } else {
                    tag.as_str()
                };
                if renamed.trim().eq_ignore_ascii_case(&preview.target) {
                    if target_seen {
                        return None;
                    }
                    target_seen = true;
                    return Some(preview.target.as_str());
                }
                Some(renamed)
            })
            .collect();
        let edits = FrontmatterEdits {
            set: vec![("tags".to_owned(), serde_json::json!(tags), None)],
            updated_at: Some(now),
            ..Default::default()
        };
        match splice_frontmatter(&raw, &edits) {
            Ok(content) if body_of(&content) == body_of(&raw) => {
                command.index_events.push(ChangeEvent::Upsert(path.clone()));
                command.intents.push(BatchPathIntent::Write {
                    path,
                    expected: ExpectedPathState::Bytes(raw.into_bytes()),
                    content: content.into_bytes(),
                });
            }
            Ok(_) => preview.conflicts.push(TagRenameConflict {
                path: Some(path.as_str().to_owned()),
                reason: "Tag editing would change the protected page body".to_owned(),
            }),
            Err(error) => preview.conflicts.push(TagRenameConflict {
                path: Some(path.as_str().to_owned()),
                reason: format!(
                    "Cannot losslessly edit tags; repair or migrate frontmatter first: {error}"
                ),
            }),
        }
    }
    preview.affected_count = preview.pages.len();
    if preview.affected_count == 0 {
        preview.conflicts.push(TagRenameConflict {
            path: None,
            reason: "No editable pages have this exact source tag; computed tags cannot be renamed"
                .to_owned(),
        });
    }
    preview.fingerprint = page_revision(
        &serde_json::to_string(&preview).map_err(|error| ApiError::internal(error.to_string()))?,
    );
    Ok((preview, command))
}
#[utoipa::path(
    post, path = "/index/tags/rename/preview", context_path = "/api/vault", tag = "Index",
    request_body = TagRenameRequest,
    responses(
        (status = 200, description = "No-write exact tag rename preview", body = TagRenamePreview),
        (status = 400, description = "Invalid tag names", body = ApiError),
        (status = 409, description = "Vault could not be fully inspected", body = ApiError)
    )
)]
pub async fn preview_tag_rename(
    State(state): State<Arc<AppState>>,
    Json(request): Json<TagRenameRequest>,
) -> Result<Json<TagRenamePreview>, ApiError> {
    let _exclusion = state.mutation_coordinator.exclude_mutations().await;
    let now = state.clock.now();
    let prepared = state
        .index
        .with_index(move |_, vault| prepare(vault, request, now))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))??;
    Ok(Json(prepared.0))
}

#[utoipa::path(
    post, path = "/index/tags/rename/apply", context_path = "/api/vault", tag = "Index",
    request_body = TagRenameApplyRequest,
    responses(
        (status = 200, description = "Exact page tags renamed atomically", body = TagRenameResult),
        (status = 400, description = "Invalid tag names", body = ApiError),
        (status = 409, description = "Preview stale, pages blocked, or merge not acknowledged; no pages changed", body = ApiError),
        (status = 500, description = "Batch mutation failed", body = ApiError)
    )
)]
pub async fn apply_tag_rename(
    State(state): State<Arc<AppState>>,
    Json(request): Json<TagRenameApplyRequest>,
) -> Result<Json<TagRenameResult>, ApiError> {
    let exclusion = state.mutation_coordinator.exclude_mutations().await;
    let now = state.clock.now();
    let rename = TagRenameRequest {
        source: request.source,
        target: request.target,
    };
    let (preview, command) = state
        .index
        .with_index(move |_, vault| prepare(vault, rename, now))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))??;
    let reason = if preview.fingerprint != request.expected_fingerprint {
        Some(
            "Preview is stale: source pages, revisions, protection or target membership changed. Preview again; no pages were changed.",
        )
    } else if !preview.conflicts.is_empty() {
        Some("Resolve the preview conflicts and preview again; no pages were changed.")
    } else if preview.target_exists && !request.acknowledge_merge {
        Some("Explicitly acknowledge merging into the existing target tag; no pages were changed.")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Err(ApiError::conflict_with_detail(
            reason,
            serde_json::json!({"preview": preview}),
        ));
    }
    state
        .mutation_coordinator
        .execute_batch_excluded(
            exclusion,
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            super::mutation_notifier(state.as_ref()),
        )
        .await
        .map_err(super::mutation_error)?;
    Ok(Json(TagRenameResult {
        updated_count: preview.affected_count,
    }))
}
