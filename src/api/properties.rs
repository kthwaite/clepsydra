//! The Base-aware property projection and its one mutation path.
//!
//! GET evaluates authoritative Base membership and groups declared properties
//! without making any Base authoritative over another. PATCH is a splice, not
//! a rewrite: the raw page content goes through `toml_patch::splice_frontmatter`,
//! so comments and untouched keys survive byte-for-byte, then rides
//! `ReplacePageContentCommand` for optimistic concurrency. A legacy `---` page
//! heals to TOML first (full serialization) — the one documented exception to
//! comment preservation, and only during the transition.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use super::AppState;
use super::error::ApiError;
use super::events::SyncNotification;
use crate::vault::base::{
    BODY_COLUMN, BaseDefinition, BaseRegistry, Filter, Op, PropertyDefinition, PropertyType,
    SYSTEM_FIELDS,
};
use crate::vault::mutation_coordinator::{MutationNotification, ReplacePageContentCommand};
use crate::vault::page::{Page, page_revision, parse_or_repair_frontmatter, write_page_content};
use crate::vault::path::VaultPath;
use crate::vault::query::{
    ProjectionFieldIdentity, QueryContext, QueryOutput, QuerySpec, evaluate,
    project_page_field_value, resolve_projection_field,
};
use crate::vault::toml_json::toml_value_to_json;
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
    #[schema(value_type = std::collections::HashMap<String, serde_json::Value>)]
    pub properties: serde_json::Map<String, serde_json::Value>,
}

/// Identity and display label for one matching Base.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PageBaseIdentity {
    pub slug: String,
    pub name: String,
}

/// One matching Base that contributed a configured preview field.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PagePreviewSource {
    pub base: PageBaseIdentity,
    /// The configured label, absent only for malformed legacy input that has
    /// no usable label and therefore falls back to the canonical key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One original property declaration and the Base that supplied it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PagePropertyDeclaration {
    pub base: PageBaseIdentity,
    pub definition: PropertyDefinition,
}

/// Whether every declaration for a key has the same editor semantics.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PagePropertyCompatibility {
    Compatible,
    Conflict,
}

/// Backend-authoritative reasons that a projected property cannot be patched.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PagePropertyBlocker {
    SchemaConflict,
    ReservedKey,
}

/// One property key grouped across every matching Base declaration.
#[derive(Debug, Serialize, ToSchema)]
pub struct PageBaseProperty {
    pub key: String,
    /// Distinguishes an absent declared property from a present JSON `null`.
    pub present: bool,
    /// Current custom frontmatter value. Reserved and absent values are `null`.
    #[schema(value_type = Option<serde_json::Value>, required = true)]
    pub value: Option<serde_json::Value>,
    pub compatibility: PagePropertyCompatibility,
    /// Editor-semantic normalized definition; absent for conflicts.
    #[schema(required = true)]
    pub definition: Option<PropertyDefinition>,
    pub declarations: Vec<PagePropertyDeclaration>,
    /// Backend capability only; Folio lock/read-only state is applied by clients.
    pub patchable: bool,
    pub blockers: Vec<PagePropertyBlocker>,
}

/// One canonical field in the merged current-page preview projection.
#[derive(Debug, Serialize, ToSchema)]
pub struct PagePreviewField {
    pub key: String,
    pub label: String,
    pub present: bool,
    #[schema(value_type = Option<serde_json::Value>, required = true)]
    pub value: Option<serde_json::Value>,
    pub schema_conflict: bool,
    pub label_conflict: bool,
    pub sources: Vec<PagePreviewSource>,
}

/// Bounded generic preview data merged from every matching Base.
#[derive(Debug, Default, Serialize, ToSchema)]
pub struct PagePreviewProjection {
    pub fields: Vec<PagePreviewField>,
    pub remaining_count: usize,
}

/// Authoritative Base property projection for one current page.
#[derive(Debug, Serialize, ToSchema)]
pub struct PageBasePropertiesResponse {
    pub id: String,
    pub path: String,
    pub revision: String,
    pub encrypted: bool,
    pub matching_bases: Vec<PageBaseIdentity>,
    pub properties: Vec<PageBaseProperty>,
    pub preview: PagePreviewProjection,
}

fn hint_for(ty: Option<&PropertyType>) -> Option<ValueHint> {
    match ty {
        Some(PropertyType::Date) => Some(ValueHint::Date),
        Some(PropertyType::Datetime) => Some(ValueHint::DateTime),
        _ => None,
    }
}

/// Frontmatter keys owned by the system serializer; patching them as
/// properties would corrupt page identity or bypass typed update paths.
const RESERVED_KEYS: [&str; 10] = [
    "id",
    "title",
    "type",
    "project",
    "tags",
    "aliases",
    "created_at",
    "updated_at",
    "encryption",
    "conversation",
];

fn page_base_identity(base: &BaseDefinition) -> PageBaseIdentity {
    PageBaseIdentity {
        slug: base.slug.clone(),
        name: base.file.name.clone(),
    }
}

fn normalized_property_definition(definition: &PropertyDefinition) -> PropertyDefinition {
    let (options, many) = match definition.property_type {
        PropertyType::Select | PropertyType::MultiSelect => (definition.options.clone(), None),
        PropertyType::Relation => (Vec::new(), Some(definition.many.unwrap_or(true))),
        _ => (Vec::new(), None),
    };
    PropertyDefinition {
        property_type: definition.property_type,
        options,
        many,
    }
}

fn same_editor_semantics(left: &PropertyDefinition, right: &PropertyDefinition) -> bool {
    left.property_type == right.property_type
        && left.options == right.options
        && left.many == right.many
}

fn is_reserved_property_key(key: &str) -> bool {
    RESERVED_KEYS.contains(&key) || SYSTEM_FIELDS.contains(&key) || key == BODY_COLUMN
}

fn project_matching_bases(
    matching: &[BaseDefinition],
    page: &Page,
) -> (Vec<PageBaseIdentity>, Vec<PageBaseProperty>) {
    let mut identities = Vec::with_capacity(matching.len());
    let mut declarations: BTreeMap<String, Vec<PagePropertyDeclaration>> = BTreeMap::new();
    for base in matching {
        let identity = page_base_identity(base);
        identities.push(identity.clone());
        for (key, definition) in &base.file.properties {
            declarations
                .entry(key.clone())
                .or_default()
                .push(PagePropertyDeclaration {
                    base: identity.clone(),
                    definition: definition.clone(),
                });
        }
    }

    let properties = declarations
        .into_iter()
        .map(|(key, declarations)| {
            let mut normalized = declarations
                .iter()
                .map(|declaration| normalized_property_definition(&declaration.definition));
            let candidate = normalized
                .next()
                .expect("grouped declarations are never empty");
            let compatible =
                normalized.all(|definition| same_editor_semantics(&candidate, &definition));
            let reserved = is_reserved_property_key(&key);
            let current = (!reserved).then(|| page.meta.extra.get(&key)).flatten();
            let mut blockers = Vec::with_capacity(usize::from(!compatible) + usize::from(reserved));
            if !compatible {
                blockers.push(PagePropertyBlocker::SchemaConflict);
            }
            if reserved {
                blockers.push(PagePropertyBlocker::ReservedKey);
            }
            PageBaseProperty {
                key,
                present: current.is_some(),
                value: current.map(toml_value_to_json),
                compatibility: if compatible {
                    PagePropertyCompatibility::Compatible
                } else {
                    PagePropertyCompatibility::Conflict
                },
                definition: compatible.then_some(candidate),
                declarations,
                patchable: compatible && !reserved,
                blockers,
            }
        })
        .collect();

    (identities, properties)
}

const PAGE_PREVIEW_FIELD_LIMIT: usize = 4;

#[derive(Debug)]
struct MergedPreviewField {
    identity: ProjectionFieldIdentity,
    key: String,
    agreed_label: String,
    label_conflict: bool,
    sources: Vec<PagePreviewSource>,
}

fn projection_key(identity: &ProjectionFieldIdentity) -> String {
    match identity {
        ProjectionFieldIdentity::System(field) => field.as_str().to_string(),
        ProjectionFieldIdentity::Property(key)
            if SYSTEM_FIELDS.contains(&key.as_str())
                || key.starts_with("prop.")
                || key.starts_with("sys.") =>
        {
            format!("prop.{key}")
        }
        ProjectionFieldIdentity::Property(key) => key.clone(),
        ProjectionFieldIdentity::Body => BODY_COLUMN.to_string(),
    }
}

fn project_page_preview(
    matching: &[BaseDefinition],
    page: &Page,
    properties: &[PageBaseProperty],
) -> PagePreviewProjection {
    if page.is_encrypted() {
        return PagePreviewProjection::default();
    }

    let schema_conflicts = properties
        .iter()
        .map(|property| {
            (
                property.key.as_str(),
                matches!(property.compatibility, PagePropertyCompatibility::Conflict),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut positions = HashMap::<ProjectionFieldIdentity, usize>::new();
    let mut merged = Vec::<MergedPreviewField>::new();

    for base in matching {
        let base_identity = page_base_identity(base);
        for definition in &base.file.preview {
            let Ok(identity) = resolve_projection_field(&definition.field) else {
                continue;
            };
            let key = projection_key(&identity);
            let configured_label = definition
                .label
                .clone()
                .filter(|label| !label.trim().is_empty());
            let effective_label = configured_label.clone().unwrap_or_else(|| key.clone());
            let source = PagePreviewSource {
                base: base_identity.clone(),
                label: configured_label,
            };

            if let Some(position) = positions.get(&identity).copied() {
                let field = &mut merged[position];
                if field.agreed_label != effective_label {
                    field.label_conflict = true;
                }
                field.sources.push(source);
                continue;
            }

            positions.insert(identity.clone(), merged.len());
            merged.push(MergedPreviewField {
                identity,
                key,
                agreed_label: effective_label,
                label_conflict: false,
                sources: vec![source],
            });
        }
    }

    let remaining_count = merged.len().saturating_sub(PAGE_PREVIEW_FIELD_LIMIT);
    let fields = merged
        .into_iter()
        .take(PAGE_PREVIEW_FIELD_LIMIT)
        .map(|field| {
            let schema_conflict = match &field.identity {
                ProjectionFieldIdentity::Property(key) => {
                    schema_conflicts.get(key.as_str()).copied().unwrap_or(false)
                }
                ProjectionFieldIdentity::System(_) | ProjectionFieldIdentity::Body => false,
            };
            let (present, value) = match &field.identity {
                ProjectionFieldIdentity::Property(key)
                    if is_reserved_property_key(key)
                        || !schema_conflicts.contains_key(key.as_str()) =>
                {
                    (false, None)
                }
                _ => project_page_field_value(page, &field.identity),
            };
            PagePreviewField {
                label: if field.label_conflict {
                    field.key.clone()
                } else {
                    field.agreed_label
                },
                key: field.key,
                present,
                value,
                schema_conflict,
                label_conflict: field.label_conflict,
                sources: field.sources,
            }
        })
        .collect();

    PagePreviewProjection {
        fields,
        remaining_count,
    }
}

/// Project matching Base declarations and current custom values for one page.
#[utoipa::path(
    get,
    path = "/by-id/{uuid}/properties",
    context_path = "/api/vault/pages",
    tag = "Bases",
    params(("uuid" = String, Path, description = "Page UUID")),
    responses(
        (status = 200, description = "Authoritative Base property projection", body = PageBasePropertiesResponse),
        (status = 400, description = "Malformed page UUID", body = ApiError),
        (status = 404, description = "Unknown page", body = ApiError),
        (status = 500, description = "Page read or Base evaluation failed", body = ApiError)
    )
)]
pub async fn get_page_base_properties(
    State(state): State<Arc<AppState>>,
    Path(uuid): Path<String>,
) -> Result<Json<PageBasePropertiesResponse>, ApiError> {
    let uuid = Uuid::parse_str(&uuid).map_err(|_| ApiError::bad_request("malformed page UUID"))?;
    let page_id = uuid.to_string();
    let lookup_id = page_id.clone();
    let path = state
        .index
        .with_index(move |index, _vault| {
            index.connection().query_row(
                "SELECT path FROM pages WHERE id = ?1",
                rusqlite::params![lookup_id],
                |row| row.get::<_, String>(0),
            )
        })
        .await
        .map_err(|error| ApiError::internal(format!("index error: {error}")))?
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                ApiError::not_found(format!("no page with id {page_id}"))
            }
            error => ApiError::internal(format!("page lookup failed: {error}")),
        })?;
    let vault_path = VaultPath::new(&path)
        .map_err(|error| ApiError::internal(format!("bad indexed path: {error}")))?;
    let absolute_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&absolute_path, vault_path).map_err(|error| match error {
        crate::vault::page::FrontmatterError::Io(error)
            if error.kind() == std::io::ErrorKind::NotFound =>
        {
            ApiError::not_found(format!("page file missing: {path}"))
        }
        error => ApiError::internal(format!("failed to read page: {error}")),
    })?;
    if page.meta.id != uuid {
        return Err(ApiError::internal(format!(
            "indexed page identity mismatch for id: {page_id}"
        )));
    }

    let bases = BaseRegistry::load(state.vault.root()).bases;
    let membership_id = page_id.clone();
    let matching = state
        .index
        .with_index(move |index, _vault| {
            bases
                .into_iter()
                .filter_map(|base| {
                    let identity_filter = Filter::Cmp {
                        field: "sys.id".to_string(),
                        op: Op::Eq,
                        value: serde_json::Value::String(membership_id.clone()),
                    };
                    let filter = match base.file.filter.clone() {
                        Some(base_filter) => Filter::All(vec![base_filter, identity_filter]),
                        None => identity_filter,
                    };
                    let spec = QuerySpec {
                        filter: Some(filter),
                        limit: Some(0),
                        ..Default::default()
                    };
                    let result =
                        evaluate(index.connection(), &spec, &QueryContext::for_base(&base));
                    match result {
                        Ok(QueryOutput::Flat { total: 1, .. }) => Some(Ok(base)),
                        Ok(QueryOutput::Flat { total: 0, .. }) => None,
                        Ok(QueryOutput::Flat { total, .. }) => Some(Err(format!(
                            "identity-constrained Base `{}` returned {total} pages",
                            base.slug
                        ))),
                        Ok(QueryOutput::Grouped { .. }) => Some(Err(format!(
                            "identity-constrained Base `{}` returned grouped output",
                            base.slug
                        ))),
                        Err(error) => Some(Err(format!(
                            "Base `{}` membership evaluation failed: {error}",
                            base.slug
                        ))),
                    }
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .await
        .map_err(|error| ApiError::internal(format!("index error: {error}")))?
        .map_err(ApiError::internal)?;

    let revision = page_revision(&page.raw_content);
    let encrypted = page.meta.encryption.is_some();
    let mut matching = matching;
    matching.sort_by(|left, right| left.slug.cmp(&right.slug));
    let (matching_bases, properties) = project_matching_bases(&matching, &page);
    let preview = project_page_preview(&matching, &page, &properties);
    Ok(Json(PageBasePropertiesResponse {
        id: page_id,
        path,
        revision,
        encrypted,
        matching_bases,
        properties,
        preview,
    }))
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
        (status = 400, description = "Reserved key or unrepresentable value"),
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

    if let Some(key) = request
        .set
        .keys()
        .chain(request.clear.iter())
        .find(|k| RESERVED_KEYS.contains(&k.as_str()))
    {
        return Err(ApiError::bad_request(format!(
            "`{key}` is a system frontmatter key and cannot be patched as a property"
        )));
    }

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
    let replacement = state
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
                "SELECT key, value_json FROM page_properties WHERE page_id = ?1 AND key != 'conversation' ORDER BY key, ord",
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
        revision: page_revision(&replacement.content),
        properties: grouped,
    }))
}
