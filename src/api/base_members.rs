use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AppState;
use super::error::ApiError;
use crate::vault::base::{BaseDefinition, Filter, SYSTEM_FIELDS, candidate_link_targets};
use crate::vault::base_document;
use crate::vault::base_embed::{
    EmbedOverrides, EmbedValidationDiagnostic, validate_embed_overrides,
};
use crate::vault::base_member::{
    BaseMemberDiagnostic, BaseMemberScope, CandidateDerived,
    composed_candidate_matches_with_link_targets, composed_member_capability,
};
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::{CreatePageCommand, MutationError};
use crate::vault::new_note::build_projected_note_path;
use crate::vault::page::{PageMeta, page_revision};
use crate::vault::property_value::coerce_property_value;

const MAX_PATH_ATTEMPTS: usize = 4;
const MAX_EMBED_FILTER_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize, ToSchema)]
pub struct BaseMemberCreateRequest {
    pub base_revision: String,
    pub view: String,
    pub title: String,
    #[serde(default)]
    pub fields: HashMap<String, serde_json::Value>,
    pub embed_filter: Option<Filter>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseMemberCreateResponse {
    pub id: String,
    pub path: String,
    pub title: String,
    pub revision: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct BaseMemberValidationDetail {
    pub diagnostics: Vec<BaseMemberDiagnostic>,
}

fn field_diagnostic(field: &str, message: impl Into<String>) -> BaseMemberDiagnostic {
    BaseMemberDiagnostic {
        scope: BaseMemberScope::Field,
        field: Some(field.to_owned()),
        filter_path: None,
        message: message.into(),
    }
}

fn string_array(key: &str, value: &serde_json::Value) -> Result<Vec<String>, BaseMemberDiagnostic> {
    let values = value
        .as_array()
        .ok_or_else(|| field_diagnostic(key, format!("{key} must be an array of strings")))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| field_diagnostic(key, format!("{key} must be an array of strings")))
        })
        .collect()
}

fn apply_system_field(
    meta: &mut PageMeta,
    key: &str,
    value: &serde_json::Value,
) -> Result<bool, BaseMemberDiagnostic> {
    match key {
        "kind" => {
            let token = value
                .as_str()
                .ok_or_else(|| field_diagnostic(key, "kind must be a string"))?;
            meta.kind =
                Some(Kind::from_token(token).ok_or_else(|| {
                    field_diagnostic(key, format!("unknown page kind `{token}`"))
                })?);
            Ok(true)
        }
        "project" => {
            let project = value
                .as_str()
                .ok_or_else(|| field_diagnostic(key, "project must be a string"))?;
            super::pages::validate_project_slug(project)
                .map_err(|message| field_diagnostic(key, message))?;
            meta.project = Some(project.to_owned());
            Ok(true)
        }
        "tags" => {
            meta.tags = string_array(key, value)?;
            Ok(true)
        }
        "aliases" => {
            meta.aliases = string_array(key, value)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn apply_custom_field(
    meta: &mut PageMeta,
    base: &BaseDefinition,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), BaseMemberDiagnostic> {
    let bare = key.strip_prefix("prop.").unwrap_or(key);
    let definition = base
        .property(bare)
        .ok_or_else(|| field_diagnostic(key, format!("base has no declared property `{bare}`")))?;
    let value = coerce_property_value(bare, value, definition)
        .map_err(|error| field_diagnostic(key, error.to_string()))?;
    meta.extra.insert(bare.to_owned(), value);
    Ok(())
}

fn validation_error(diagnostics: Vec<BaseMemberDiagnostic>) -> ApiError {
    ApiError::unprocessable_with_detail(
        "candidate is not valid for the selected Base view",
        serde_json::to_value(BaseMemberValidationDetail { diagnostics })
            .expect("Base member diagnostics must serialize"),
    )
}

fn internal_creation_error(error: impl std::fmt::Debug + std::fmt::Display) -> ApiError {
    tracing::error!(error = ?error, error_display = %error, "Base member creation failed");
    ApiError {
        status: 500,
        error: "Base member creation failed".to_owned(),
        detail: Some(serde_json::json!({
            "code": "base_member_creation_failed"
        })),
        hint: None,
    }
}

fn base_load_error(error: base_document::BaseDocumentError) -> ApiError {
    let response = super::bases::document_error(error);
    if response.status == 500 {
        internal_creation_error(response.error)
    } else {
        response
    }
}
fn validate_create_embed_filter(
    base: &BaseDefinition,
    embed_filter: Option<&Filter>,
) -> Result<(), ApiError> {
    if let Some(filter) = embed_filter
        && serde_json::to_vec(filter)
            .expect("Filter serialization must be infallible")
            .len()
            > MAX_EMBED_FILTER_BYTES
    {
        return Err(super::bases::invalid_embed_query(vec![
            EmbedValidationDiagnostic {
                field: None,
                filter_path: Some("filter".to_owned()),
                message: format!("serialized embed filter exceeds {MAX_EMBED_FILTER_BYTES} bytes"),
            },
        ]));
    }

    validate_embed_overrides(
        base,
        EmbedOverrides {
            filter: embed_filter,
            sort: None,
            limit: None,
        },
    )
    .map_err(super::bases::invalid_embed_query)
}

fn is_reserved_field(key: &str) -> bool {
    matches!(
        key,
        "id" | "path"
            | "title"
            | "created_at"
            | "updated_at"
            | "encryption"
            | "journal_date"
            | "word_count"
    )
}

fn is_unpersistable_custom_shadow(key: &str) -> bool {
    matches!(
        key,
        "id" | "path"
            | "title"
            | "project"
            | "tags"
            | "aliases"
            | "created_at"
            | "updated_at"
            | "encryption"
    )
}

async fn create_base_member_with_ids(
    state: Arc<AppState>,
    slug: String,
    request: BaseMemberCreateRequest,
    mut short_ids: impl Iterator<Item = String>,
    fixed_page_id: Option<uuid::Uuid>,
) -> Result<BaseMemberCreateResponse, ApiError> {
    let stored = base_document::load(state.vault.root(), &slug).map_err(base_load_error)?;
    if stored.revision != request.base_revision {
        return Err(ApiError::conflict_with_detail(
            "base changed since the draft was opened",
            serde_json::json!({
                "code": "base_revision_conflict",
                "current_revision": stored.revision,
            }),
        ));
    }
    let view = stored
        .definition
        .view(&request.view)
        .cloned()
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "base `{slug}` has no view named `{}`",
                request.view
            ))
        })?;
    validate_create_embed_filter(&stored.definition, request.embed_filter.as_ref())?;
    let today = state.clock.now().date_naive();
    let capability = composed_member_capability(
        &stored.definition,
        &view,
        request.embed_filter.as_ref(),
        today,
    );
    if !capability.enabled {
        return Err(validation_error(capability.blockers));
    }

    let title = request.title.trim();
    if title.is_empty() {
        return Err(ApiError::bad_request("title must not be blank"));
    }

    let created = state.clock.now();
    let mut meta = PageMeta::new();
    if let Some(id) = fixed_page_id {
        meta.id = id;
    }
    meta.title = Some(title.to_owned());
    meta.created_at = Some(created);
    meta.updated_at = Some(created);

    let mut normalized_fields = Vec::with_capacity(request.fields.len());
    let mut targets = HashSet::with_capacity(request.fields.len());
    for (key, value) in &request.fields {
        let explicit_custom = key.starts_with("prop.");
        let logical = key.strip_prefix("prop.").unwrap_or(key);
        let targets_custom_property = explicit_custom || !SYSTEM_FIELDS.contains(&logical);
        if !targets.insert((logical, targets_custom_property)) {
            return Err(ApiError::bad_request(format!(
                "field `{logical}` was provided more than once"
            )));
        }
        if explicit_custom && is_unpersistable_custom_shadow(logical) {
            return Err(ApiError::bad_request(format!(
                "custom property `{key}` cannot be persisted without changing its meaning"
            )));
        }
        if !explicit_custom && is_reserved_field(logical) {
            return Err(ApiError::bad_request(format!(
                "field `{key}` cannot be set when creating a Base member"
            )));
        }
        normalized_fields.push((key.as_str(), logical, explicit_custom, value));
    }

    let mut diagnostics = Vec::new();
    for (original, logical, explicit_custom, value) in normalized_fields {
        if !explicit_custom {
            match apply_system_field(&mut meta, original, value) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(diagnostic) => {
                    return Err(ApiError::bad_request(diagnostic.message));
                }
            }
        }
        if stored.definition.property(logical).is_none() {
            return Err(ApiError::bad_request(format!(
                "base `{slug}` has no declared property `{logical}`"
            )));
        }
        if let Err(diagnostic) = apply_custom_field(&mut meta, &stored.definition, original, value)
        {
            diagnostics.push(diagnostic);
        }
    }
    if !diagnostics.is_empty() {
        return Err(validation_error(diagnostics));
    }
    if meta.kind.is_none() {
        meta.kind = Some(Kind::Note);
    }
    // A member's project must be one some PROJECT page declares — unless the
    // member is itself a PROJECT, in which case it is the declaration.
    if let Some(project) = &meta.project
        && meta.kind != Some(Kind::Project)
    {
        super::projects::ensure_project_exists(&state, project).await?;
    }
    let link_base = stored.definition.clone();
    let link_meta = meta.clone();
    let link_targets = state
        .index
        .with_index(move |index, _| {
            candidate_link_targets(&link_base, &link_meta, |target_canonical| {
                index.resolve_link_target_id(target_canonical)
            })
        })
        .await
        .map_err(internal_creation_error)?
        .map_err(internal_creation_error)?;

    let notify = super::mutation_notifier(state.as_ref());

    for _ in 0..MAX_PATH_ATTEMPTS {
        let short_id = short_ids
            .next()
            .ok_or_else(|| internal_creation_error("Base member path ID source was exhausted"))?;
        let path = build_projected_note_path(
            title,
            created,
            meta.kind.expect("defaulted above"),
            meta.project.as_deref(),
            &short_id,
        )
        .map_err(internal_creation_error)?;

        composed_candidate_matches_with_link_targets(
            &stored.definition,
            &view,
            request.embed_filter.as_ref(),
            &meta,
            path.as_str(),
            &CandidateDerived {
                word_count: 0,
                journal_date: None,
            },
            &link_targets,
            today,
        )
        .map_err(validation_error)?;

        let generated_path = path.as_str().to_owned();
        match state
            .mutation_coordinator
            .create_page(
                &state.vault,
                &state.index,
                CreatePageCommand {
                    path,
                    meta: meta.clone(),
                    body: String::new(),
                },
                Arc::clone(&notify),
            )
            .await
        {
            Ok(page) => {
                return Ok(BaseMemberCreateResponse {
                    id: page.meta.id.to_string(),
                    path: page.path.as_str().to_owned(),
                    title: page.meta.title.expect("validated title"),
                    revision: page_revision(&page.raw_content),
                });
            }
            Err(MutationError::Conflict(message))
                if message == format!("page already exists: {generated_path}") => {}
            Err(error) => return Err(internal_creation_error(error)),
        }
    }

    Err(ApiError::conflict(format!(
        "could not allocate a unique Base member path after {MAX_PATH_ATTEMPTS} attempts"
    )))
}

#[utoipa::path(
    post,
    path = "/{slug}/members",
    context_path = "/api/vault/bases",
    tag = "Bases",
    params(("slug" = String, Path, description = "Base slug")),
    request_body = BaseMemberCreateRequest,
    responses(
        (status = 201, description = "Base member created", body = BaseMemberCreateResponse),
        (status = 400, description = "Malformed or unsupported input", body = ApiError),
        (status = 404, description = "Base or view not found", body = ApiError),
        (status = 409, description = "Stale Base revision or exhausted path retries", body = ApiError),
        (status = 422, description = "Candidate does not match Base membership or selected view", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn create_base_member(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
    payload: Result<Json<BaseMemberCreateRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<BaseMemberCreateResponse>), ApiError> {
    let Json(request) =
        payload.map_err(|error| ApiError::bad_request(format!("invalid request body: {error}")))?;
    let ids = std::iter::repeat_with(crate::vault::block_id::generate_short_id);
    create_base_member_with_ids(state, slug, request, ids, None)
        .await
        .map(|response| (StatusCode::CREATED, Json(response)))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use chrono::{DateTime, Utc};
    use tempfile::TempDir;
    use tokio::sync::broadcast;

    use super::*;
    use crate::api::Clock;
    use crate::vault::Vault;
    use crate::vault::cas::ContentStore;
    use crate::vault::index::VaultIndex;
    use crate::vault::index_handle::IndexHandle;
    use crate::vault::init::init_vault;

    #[derive(Debug)]
    struct FixedClock(DateTime<Utc>);

    impl Clock for FixedClock {
        fn now(&self) -> DateTime<Utc> {
            self.0
        }
    }

    fn setup() -> (TempDir, Arc<AppState>, String) {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("vault");
        init_vault(&root).unwrap();
        fs::create_dir_all(root.join("bases")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("bases/collision.base.toml"),
            r#"
name = "Collision"
filter = { field = "kind", op = "eq", value = "NOTE" }

[properties]
rating = { type = "number" }

[[views]]
name = "All"
"#,
        )
        .unwrap();
        fs::write(
            root.join("notes/20260809.collision.taken.md"),
            "+++\nid = \"0190f8a0-0000-7000-8000-000000000001\"\ntitle = \"Existing\"\ntype = \"NOTE\"\n+++\nexisting",
        )
        .unwrap();

        let vault = Vault::open(&root).unwrap();
        let archive_resource_concurrency = crate::api::archive::archive_resource_concurrency(
            vault.config().archive.max_blob_size_mb,
        );
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();
        let index = IndexHandle::spawn(index, vault.clone());
        let cas = Arc::new(parking_lot::Mutex::new(
            ContentStore::open(&temp.path().join("cas")).unwrap(),
        ));
        let (change_tx, _) = broadcast::channel(8);
        let rubbish = crate::vault::rubbish::RubbishStore::for_vault(vault.root());
        let state = Arc::new(AppState {
            started_at: std::time::Instant::now(),
            features: crate::FeatureFlags::default(),
            clock: Arc::new(FixedClock(
                DateTime::parse_from_rfc3339("2026-08-09T12:34:56Z")
                    .unwrap()
                    .with_timezone(&Utc),
            )),
            vault,
            index,
            cas,
            rubbish,
            warnings: parking_lot::Mutex::new(Vec::new()),
            change_tx,
            hooks: Arc::new(Vec::new()),
            delete_hooks: Arc::new(Vec::new()),
            mutation_coordinator: crate::vault::mutation_coordinator::MutationCoordinator::new(),
            sync: None,
            watcher_paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            feed_runtime: Some(
                crate::feeds::runtime::FeedRuntime::open(&root, &crate::FeedsSettings::default())
                    .unwrap(),
            ),
            archive_ingest_lock: tokio::sync::Mutex::new(()),
            archive_view_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
            archive_resource_semaphore: Arc::new(tokio::sync::Semaphore::new(
                archive_resource_concurrency,
            )),
            bcl: None,
            location: parking_lot::RwLock::new(None),
        });
        let revision = base_document::load(state.vault.root(), "collision")
            .unwrap()
            .revision;
        (temp, state, revision)
    }

    async fn indexed_uuid_count(state: &AppState, id: &str) -> i64 {
        let id = id.to_owned();
        state
            .index
            .with_index(move |index, _| {
                index
                    .connection()
                    .query_row("SELECT COUNT(*) FROM pages WHERE id = ?1", [id], |row| {
                        row.get(0)
                    })
                    .unwrap()
            })
            .await
            .unwrap()
    }

    fn filter_at_serialized_size(size: usize) -> Filter {
        use crate::vault::base::Op;

        let children = (0..16)
            .map(|index| Filter::Cmp {
                field: "title".to_owned(),
                op: Op::Eq,
                value: serde_json::Value::String(if index < 15 {
                    "x".repeat(4096)
                } else {
                    String::new()
                }),
            })
            .collect();
        let mut filter = Filter::All(children);
        let current_size = serde_json::to_vec(&filter).unwrap().len();
        let padding = size.checked_sub(current_size).unwrap();
        assert!(padding <= 4096);
        let Filter::All(children) = &mut filter else {
            unreachable!();
        };
        let Filter::Cmp { value, .. } = &mut children[15] else {
            unreachable!();
        };
        *value = serde_json::Value::String("x".repeat(padding));
        assert_eq!(serde_json::to_vec(&filter).unwrap().len(), size);
        filter
    }

    #[tokio::test]
    async fn generated_path_collision_retries_without_overwriting_the_existing_page() {
        let (_temp, state, revision) = setup();
        let collision_path = state.vault.root().join("notes/20260809.collision.taken.md");
        let existing = fs::read_to_string(&collision_path).unwrap();
        let response = create_base_member_with_ids(
            Arc::clone(&state),
            "collision".to_owned(),
            BaseMemberCreateRequest {
                base_revision: revision,
                view: "all".to_owned(),
                title: "Collision".to_owned(),
                fields: HashMap::new(),
                embed_filter: None,
            },
            ["taken".to_owned(), "free".to_owned()].into_iter(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            response.path, "notes/20260809.collision.free.md",
            "the second generated path should be used"
        );
        assert_eq!(fs::read_to_string(collision_path).unwrap(), existing);
        assert!(
            state
                .vault
                .root()
                .join("notes/20260809.collision.free.md")
                .exists()
        );
        assert_eq!(
            fs::read_dir(state.vault.root().join("notes"))
                .unwrap()
                .count(),
            2,
            "one collision seed and one created page should exist"
        );
    }

    #[tokio::test]
    async fn filtered_member_pre_boundary_rejections_leave_fixed_path_and_uuid_absent() {
        use crate::vault::base::Op;

        let (_temp, state, revision) = setup();
        let cases = [
            (
                BaseMemberCreateRequest {
                    base_revision: revision.clone(),
                    view: "All".to_owned(),
                    title: "Mismatch".to_owned(),
                    fields: HashMap::new(),
                    embed_filter: Some(Filter::Cmp {
                        field: "title".to_owned(),
                        op: Op::Eq,
                        value: serde_json::json!("Other"),
                    }),
                },
                "reject-a",
                "notes/20260809.mismatch.reject-a.md",
                "01951234-0000-7000-8000-000000000511",
                422,
            ),
            (
                BaseMemberCreateRequest {
                    base_revision: revision.clone(),
                    view: "All".to_owned(),
                    title: "Invalid filter".to_owned(),
                    fields: HashMap::new(),
                    embed_filter: Some(Filter::Cmp {
                        field: "missing".to_owned(),
                        op: Op::Eq,
                        value: serde_json::json!("x"),
                    }),
                },
                "reject-b",
                "notes/20260809.invalid-filter.reject-b.md",
                "01951234-0000-7000-8000-000000000512",
                400,
            ),
            (
                BaseMemberCreateRequest {
                    base_revision: "stale".to_owned(),
                    view: "All".to_owned(),
                    title: "Stale".to_owned(),
                    fields: HashMap::new(),
                    embed_filter: None,
                },
                "reject-c",
                "notes/20260809.stale.reject-c.md",
                "01951234-0000-7000-8000-000000000513",
                409,
            ),
        ];

        for (request, short_id, expected_path, page_id, expected_status) in cases {
            let page_id = uuid::Uuid::parse_str(page_id).unwrap();
            let error = create_base_member_with_ids(
                Arc::clone(&state),
                "collision".to_owned(),
                request,
                [short_id.to_owned()].into_iter(),
                Some(page_id),
            )
            .await
            .unwrap_err();

            assert_eq!(error.status, expected_status);
            assert!(!state.vault.root().join(expected_path).exists());
            assert_eq!(indexed_uuid_count(&state, &page_id.to_string()).await, 0);
        }

        let filtered_cases = [
            (
                "Invalid operator",
                "reject-d",
                "notes/20260809.invalid-operator.reject-d.md",
                "01951234-0000-7000-8000-000000000514",
                Filter::Cmp {
                    field: "prop.rating".to_owned(),
                    op: Op::Contains,
                    value: serde_json::json!(10),
                },
                400,
                "invalid embed query",
                Some("rating"),
                "embed_filter.op",
                "op `contains` is not valid for field `rating`",
            ),
            (
                "Too complex",
                "reject-e",
                "notes/20260809.too-complex.reject-e.md",
                "01951234-0000-7000-8000-000000000515",
                Filter::All(
                    (0..33)
                        .map(|_| Filter::Cmp {
                            field: "title".to_owned(),
                            op: Op::Eq,
                            value: serde_json::json!("x"),
                        })
                        .collect(),
                ),
                400,
                "invalid embed query",
                None,
                "embed_filter",
                "filter group has 33 children; maximum is 32",
            ),
            (
                "Exact boundary",
                "reject-f",
                "notes/20260809.exact-boundary.reject-f.md",
                "01951234-0000-7000-8000-000000000516",
                filter_at_serialized_size(MAX_EMBED_FILTER_BYTES),
                422,
                "candidate is not valid for the selected Base view",
                None,
                "embed_filter",
                "candidate does not match the embed filter",
            ),
            (
                "Oversized filter",
                "reject-g",
                "notes/20260809.oversized-filter.reject-g.md",
                "01951234-0000-7000-8000-000000000517",
                filter_at_serialized_size(MAX_EMBED_FILTER_BYTES + 1),
                400,
                "invalid embed query",
                None,
                "embed_filter",
                "serialized embed filter exceeds 65536 bytes",
            ),
        ];

        for (
            title,
            short_id,
            expected_path,
            page_id,
            embed_filter,
            expected_status,
            expected_error,
            expected_field,
            expected_filter_path,
            expected_message,
        ) in filtered_cases
        {
            let page_id = uuid::Uuid::parse_str(page_id).unwrap();
            let error = create_base_member_with_ids(
                Arc::clone(&state),
                "collision".to_owned(),
                BaseMemberCreateRequest {
                    base_revision: revision.clone(),
                    view: "All".to_owned(),
                    title: title.to_owned(),
                    fields: HashMap::new(),
                    embed_filter: Some(embed_filter),
                },
                [short_id.to_owned()].into_iter(),
                Some(page_id),
            )
            .await
            .unwrap_err();

            assert_eq!(error.status, expected_status);
            assert_eq!(error.error, expected_error);
            let detail = error.detail.unwrap();
            if expected_status == 400 {
                assert_eq!(detail["code"], "invalid_embed_query");
            }
            let diagnostics = detail["diagnostics"].as_array().unwrap().clone();
            assert_eq!(diagnostics.len(), 1);
            assert_eq!(diagnostics[0]["scope"], "embed");
            assert_eq!(
                diagnostics[0]["field"],
                expected_field
                    .map(serde_json::Value::from)
                    .unwrap_or(serde_json::Value::Null)
            );
            assert_eq!(diagnostics[0]["filter_path"], expected_filter_path);
            assert_eq!(diagnostics[0]["message"], expected_message);
            assert!(!state.vault.root().join(expected_path).exists());
            assert_eq!(indexed_uuid_count(&state, &page_id.to_string()).await, 0);
        }
    }
}
