//! Base definitions: TOML files under `bases/` declaring a membership filter,
//! a property schema, and saved views over pages.
//!
//! Bases are views over pages; they never own pages. A page may match many
//! bases; deleting a base deletes nothing else. Parse failures never poison
//! the registry — a broken base is listed with its diagnostics and excluded
//! from evaluation.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// System fields addressable in filters/sorts/columns without declaration.
/// Bases may not declare properties with these names; resolution is
/// system-first for bare names (escape with `prop.<name>` / `sys.<name>`).
pub const SYSTEM_FIELDS: &[&str] = &[
    "id",
    "path",
    "title",
    "kind",
    "project",
    "tags",
    "aliases",
    "created_at",
    "updated_at",
    "journal_date",
    "word_count",
];

/// Closed set of declarable property types (v1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Text,
    Number,
    Bool,
    Date,
    Datetime,
    Select,
    MultiSelect,
    Url,
    Relation,
}

impl PropertyType {
    /// Whether an ordering comparison (`lt`/`gt`/…) makes sense for values of
    /// this type. `select` options are categories, not an ordered domain.
    pub fn is_ordered(self) -> bool {
        matches!(
            self,
            PropertyType::Number | PropertyType::Date | PropertyType::Datetime
        )
    }
}

/// A declared property in a base's schema.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct PropertyDefinition {
    #[serde(rename = "type")]
    pub property_type: PropertyType,
    /// Options for `select` / `multi_select`. An empty list means open
    /// vocabulary: completion offers observed values, no diagnostics for
    /// novel ones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// Advisory single-value constraint for `relation` (diagnostic, never
    /// enforcement).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub many: Option<bool>,
}

/// Comparison operators for filter predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    /// Substring on text; membership on multi-valued.
    Contains,
    /// Value is an array of candidates.
    In,
    /// Relation → links table, canonical-name (or UUID) match.
    LinksTo,
    IsEmpty,
    NotEmpty,
}

impl Op {
    pub fn is_ordering(self) -> bool {
        matches!(self, Op::Lt | Op::Lte | Op::Gt | Op::Gte)
    }
}

/// The filter AST. Deserializes identically from base files (TOML — inline
/// tables or array-of-tables) and the generic query endpoint (JSON).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    All(Vec<Filter>),
    Any(Vec<Filter>),
    Not(Box<Filter>),
    #[serde(untagged)]
    Cmp {
        field: String,
        op: Op,
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        value: serde_json::Value,
    },
}

/// One sort key in a view.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SortKey {
    pub field: String,
    #[serde(default)]
    pub dir: SortDir,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SortDir {
    #[default]
    Asc,
    Desc,
}

/// An aggregate over a group (or the whole result set).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Aggregate {
    #[serde(rename = "fn")]
    pub function: AggregateFn,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AggregateFn {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

/// A saved view: layout, optional extra filter, sort, grouping, columns.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ViewDefinition {
    pub name: String,
    #[serde(default = "default_layout")]
    pub layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<SortKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aggregates: Vec<Aggregate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<String>,
}

fn default_layout() -> String {
    "table".to_string()
}

/// The parsed model of a `.base.toml` file.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BaseFile {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    /// Declared properties in file order.
    #[serde(with = "property_map")]
    pub properties: Vec<(String, PropertyDefinition)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<ViewDefinition>,
}

/// Loose first-stage model: properties stay raw TOML so a single bad
/// declaration (e.g. an unknown type token) becomes a per-property
/// diagnostic instead of failing the whole file.
#[derive(Debug, Deserialize)]
struct RawBaseFile {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    filter: Option<Filter>,
    #[serde(default)]
    properties: toml::Table,
    #[serde(default)]
    views: Vec<ViewDefinition>,
}

/// Serialize declared properties as a map, keeping file order.
mod property_map {
    use super::PropertyDefinition;
    use serde::ser::{SerializeMap, Serializer};

    pub fn serialize<S: Serializer>(
        props: &[(String, PropertyDefinition)],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(props.len()))?;
        for (k, v) in props {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// A parsed, validated base.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BaseDefinition {
    /// Filename stem; the API identity.
    pub slug: String,
    #[serde(flatten)]
    pub file: BaseFile,
}

impl BaseDefinition {
    pub fn property(&self, key: &str) -> Option<&PropertyDefinition> {
        self.file
            .properties
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, def)| def)
    }
}

/// A validation diagnostic for a base file. Never fatal to the registry.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BaseDiagnostic {
    /// Slug of the base (filename stem), even when parsing failed.
    pub slug: String,
    pub message: String,
}

/// The in-process collection of parsed bases plus per-file diagnostics.
///
/// Loaded from `<vault>/bases/*.base.toml` before the first index build (the
/// linkable-set epoch depends on it). Broken files contribute diagnostics but
/// never poison the rest of the registry.
#[derive(Debug, Default, Clone)]
pub struct BaseRegistry {
    pub bases: Vec<BaseDefinition>,
    pub diagnostics: Vec<BaseDiagnostic>,
}

impl BaseRegistry {
    /// Parse every `bases/*.base.toml` under the vault root, in filename
    /// order. A missing `bases/` directory yields an empty registry.
    pub fn load(vault_root: &Path) -> Self {
        let mut registry = BaseRegistry::default();
        let dir = vault_root.join("bases");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return registry;
        };
        let mut paths: Vec<_> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(".base.toml"))
            })
            .collect();
        paths.sort();

        for path in paths {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    registry.diagnostics.push(BaseDiagnostic {
                        slug: slug_from_path(&path),
                        message: format!("cannot read base file: {e}"),
                    });
                    continue;
                }
            };
            let (base, mut diagnostics) = parse_base(&path, &content);
            registry.diagnostics.append(&mut diagnostics);
            if let Some(base) = base {
                if registry.bases.iter().any(|b| b.slug == base.slug) {
                    registry.diagnostics.push(BaseDiagnostic {
                        slug: base.slug.clone(),
                        message: format!("duplicate base slug `{}`", base.slug),
                    });
                } else {
                    registry.bases.push(base);
                }
            }
        }
        registry
    }

    pub fn get(&self, slug: &str) -> Option<&BaseDefinition> {
        self.bases.iter().find(|b| b.slug == slug)
    }

    /// Keys of every relation-typed property declared by any base.
    pub fn relation_property_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .bases
            .iter()
            .flat_map(|b| b.file.properties.iter())
            .filter(|(_, def)| def.property_type == PropertyType::Relation)
            .map(|(k, _)| k.clone())
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }
}

/// The effective linkable-property set: `config ∪ relation-typed keys across
/// all bases`, deduped with config order first.
pub fn effective_linkable_properties(
    config_linkable: &[String],
    registry: &BaseRegistry,
) -> Vec<String> {
    let mut effective = config_linkable.to_vec();
    for key in registry.relation_property_keys() {
        if !effective.contains(&key) {
            effective.push(key);
        }
    }
    effective
}

/// Stable fingerprint of the effective linkable set. Persisted in
/// `derivation_meta`; a mismatch disables skip-unchanged for one build so
/// existing pages get their links re-derived under the new set.
pub fn linkable_epoch(effective: &[String]) -> String {
    let mut sorted = effective.to_vec();
    sorted.sort();
    sorted.dedup();
    blake3::hash(sorted.join("\n").as_bytes())
        .to_hex()
        .to_string()
}

/// Derive the base slug from its file path (`bases/reading.base.toml` →
/// `reading`).
pub fn slug_from_path(path: &Path) -> String {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.strip_suffix(".base.toml")
        .unwrap_or_else(|| name.strip_suffix(".toml").unwrap_or(name))
        .to_string()
}

/// Parse and validate one base file.
///
/// Returns the definition (if the TOML parses) plus any diagnostics.
/// Validation problems are advisory: an invalid declaration is reported but
/// the base is still listed. Broken TOML yields `(None, [file-level diag])`.
pub fn parse_base(path: &Path, content: &str) -> (Option<BaseDefinition>, Vec<BaseDiagnostic>) {
    let slug = slug_from_path(path);
    let mut diagnostics = Vec::new();

    let raw: RawBaseFile = match toml::from_str(content) {
        Ok(f) => f,
        Err(e) => {
            diagnostics.push(BaseDiagnostic {
                slug: slug.clone(),
                message: format!("invalid base file: {e}"),
            });
            return (None, diagnostics);
        }
    };

    // Convert properties one at a time: a bad declaration is dropped with a
    // diagnostic; the base itself stays listed.
    let mut properties = Vec::with_capacity(raw.properties.len());
    for (key, value) in raw.properties {
        match value.try_into::<PropertyDefinition>() {
            Ok(def) => properties.push((key, def)),
            Err(e) => diagnostics.push(BaseDiagnostic {
                slug: slug.clone(),
                message: format!("property `{key}`: invalid declaration ({e})"),
            }),
        }
    }

    let file = BaseFile {
        name: raw.name,
        description: raw.description,
        filter: raw.filter,
        properties,
        views: raw.views,
    };
    let base = BaseDefinition { slug, file };
    validate(&base, &mut diagnostics);
    (Some(base), diagnostics)
}

fn validate(base: &BaseDefinition, diagnostics: &mut Vec<BaseDiagnostic>) {
    let mut push = |message: String| {
        diagnostics.push(BaseDiagnostic {
            slug: base.slug.clone(),
            message,
        })
    };

    // Properties may not shadow system fields.
    for (key, _) in &base.file.properties {
        if SYSTEM_FIELDS.contains(&key.as_str()) {
            push(format!(
                "property `{key}` shadows a system field and cannot be declared"
            ));
        }
    }

    // Filter fields referencing undeclared properties are a warning (the
    // vault may legitimately carry keys the base doesn't declare); op/type
    // mismatches are hard facts.
    if let Some(filter) = &base.file.filter {
        validate_filter(base, filter, "filter", &mut push);
    }

    let mut seen_views = HashSet::new();
    for view in &base.file.views {
        if !seen_views.insert(view.name.as_str()) {
            push(format!("duplicate view name `{}`", view.name));
        }
        if view.layout != "table" {
            push(format!(
                "view `{}` uses unsupported layout `{}` (v1 supports `table`)",
                view.name, view.layout
            ));
        }
        if let Some(filter) = &view.filter {
            validate_filter(
                base,
                filter,
                &format!("view `{}` filter", view.name),
                &mut push,
            );
        }
        if let Some(group_by) = &view.group_by
            && let Some(def) = base.property(group_by)
            && matches!(
                def.property_type,
                PropertyType::Number | PropertyType::Relation | PropertyType::MultiSelect
            )
        {
            push(format!(
                "view `{}` groups by `{group_by}` ({:?}), which is not a groupable type",
                view.name, def.property_type
            ));
        }
        for agg in &view.aggregates {
            if !matches!(agg.function, AggregateFn::Count) && agg.field.is_none() {
                push(format!(
                    "view `{}`: aggregate `{:?}` requires a field",
                    view.name, agg.function
                ));
            }
        }
    }
}

fn validate_filter(
    base: &BaseDefinition,
    filter: &Filter,
    context: &str,
    push: &mut impl FnMut(String),
) {
    match filter {
        Filter::All(children) | Filter::Any(children) => {
            for child in children {
                validate_filter(base, child, context, push);
            }
        }
        Filter::Not(child) => validate_filter(base, child, context, push),
        Filter::Cmp { field, op, .. } => {
            let bare = field
                .strip_prefix("prop.")
                .or_else(|| field.strip_prefix("sys."))
                .unwrap_or(field);
            let is_system = !field.starts_with("prop.") && SYSTEM_FIELDS.contains(&bare);
            if !is_system {
                match base.property(bare) {
                    Some(def) => {
                        if op.is_ordering() && !def.property_type.is_ordered() {
                            push(format!(
                                "{context}: `{op:?}` cannot order `{bare}` ({:?})",
                                def.property_type
                            ));
                        }
                    }
                    None => push(format!(
                        "{context}: field `{bare}` is not declared in [properties] (matching against raw vault values)"
                    )),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const READING_BASE: &str = r#"
# bases/reading.base.toml
name = "Reading Log"
description = "Books in flight and their wake."

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
author   = { type = "text" }
status   = { type = "select", options = ["queued", "reading", "finished", "abandoned"] }
rating   = { type = "number" }
pages    = { type = "number" }
progress = { type = "number" }
started  = { type = "date" }
finished = { type = "date" }
series   = { type = "relation" }
themes   = { type = "multi_select", options = [] }   # empty options = open vocabulary

[[views]]
name = "Continues"
layout = "table"
filter = { field = "status", op = "eq", value = "reading" }
sort = [ { field = "started", dir = "desc" } ]
columns = ["title", "author", "progress", "pages"]

[[views]]
name = "Shelf"
layout = "table"
group_by = "status"
aggregates = [ { fn = "count" }, { fn = "avg", field = "rating" } ]
sort = [ { field = "finished", dir = "desc" } ]
columns = ["title", "author", "rating", "finished"]
"#;

    fn path(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn parses_spec_reading_base_verbatim() {
        let (base, diagnostics) = parse_base(&path("bases/reading.base.toml"), READING_BASE);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let base = base.unwrap();
        assert_eq!(base.slug, "reading");
        assert_eq!(base.file.name, "Reading Log");
        assert_eq!(base.file.properties.len(), 9);
        // Declared order preserved.
        assert_eq!(base.file.properties[0].0, "author");
        assert_eq!(base.file.properties[8].0, "themes");
        assert_eq!(
            base.property("status").unwrap().property_type,
            PropertyType::Select
        );
        assert_eq!(base.property("status").unwrap().options.len(), 4);
        assert_eq!(
            base.property("series").unwrap().property_type,
            PropertyType::Relation
        );
        assert_eq!(base.file.views.len(), 2);
        assert_eq!(base.file.views[0].name, "Continues");
        assert_eq!(base.file.views[0].sort[0].dir, SortDir::Desc);
        assert_eq!(base.file.views[1].group_by.as_deref(), Some("status"));
        assert_eq!(base.file.views[1].aggregates.len(), 2);

        let Some(Filter::All(children)) = &base.file.filter else {
            panic!("expected all-filter");
        };
        assert_eq!(children.len(), 1);
        let Filter::Cmp { field, op, value } = &children[0] else {
            panic!("expected cmp");
        };
        assert_eq!(field, "kind");
        assert_eq!(*op, Op::Eq);
        assert_eq!(value, &serde_json::json!("BOOK"));
    }

    #[test]
    fn deep_filter_array_of_tables_equals_inline_spelling() {
        let inline = r#"
name = "X"
filter = { all = [ { field = "kind", op = "eq", value = "BOOK" }, { any = [ { field = "status", op = "eq", value = "reading" }, { field = "status", op = "eq", value = "queued" } ] } ] }
"#;
        let array_of_tables = r#"
name = "X"

[[filter.all]]
field = "kind"
op = "eq"
value = "BOOK"

[[filter.all]]
  [[filter.all.any]]
  field = "status"
  op = "eq"
  value = "reading"

  [[filter.all.any]]
  field = "status"
  op = "eq"
  value = "queued"
"#;
        let (a, _) = parse_base(&path("bases/x.base.toml"), inline);
        let (b, _) = parse_base(&path("bases/x.base.toml"), array_of_tables);
        let a_json = serde_json::to_value(&a.unwrap().file.filter).unwrap();
        let b_json = serde_json::to_value(&b.unwrap().file.filter).unwrap();
        assert_eq!(a_json, b_json, "the two spellings must parse identically");
    }

    #[test]
    fn slug_comes_from_filename_stem() {
        assert_eq!(slug_from_path(&path("bases/reading.base.toml")), "reading");
        assert_eq!(
            slug_from_path(&path("bases/deep-work.base.toml")),
            "deep-work"
        );
    }

    #[test]
    fn unknown_type_token_is_a_diagnostic_but_base_still_listed() {
        let content = "name = \"X\"\n\n[properties]\nrating = { type = \"stars\" }\nauthor = { type = \"text\" }\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        let base = base.expect("base must still be listed");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].slug, "x");
        assert!(diagnostics[0].message.contains("property `rating`"));
        // The bad declaration is dropped; the good one survives.
        assert!(base.property("rating").is_none());
        assert!(base.property("author").is_some());
    }

    #[test]
    fn system_field_property_declaration_is_rejected() {
        let content = "name = \"X\"\n\n[properties]\ntitle = { type = \"text\" }\nkind = { type = \"text\" }\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        assert_eq!(diagnostics.len(), 2);
        assert!(diagnostics[0].message.contains("shadows a system field"));
    }

    #[test]
    fn ordering_op_against_select_is_a_diagnostic() {
        let content = r#"
name = "X"

[filter]
field = "status"
op = "gt"
value = "reading"

[properties]
status = { type = "select", options = ["queued", "reading"] }
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        assert!(
            diagnostics
                .iter()
                .any(|d| d.message.contains("cannot order")),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn duplicate_view_names_are_a_diagnostic() {
        let content = "name = \"X\"\n\n[[views]]\nname = \"V\"\n\n[[views]]\nname = \"V\"\n";
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        assert!(
            diagnostics
                .iter()
                .any(|d| d.message.contains("duplicate view name")),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn broken_toml_yields_file_level_diagnostic_only() {
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), "name = = nope");
        assert!(base.is_none());
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("invalid base file"));
    }

    #[test]
    fn undeclared_filter_field_is_a_warning_not_fatal() {
        let content = r#"
name = "X"

[filter]
field = "mystery"
op = "eq"
value = "y"
"#;
        let (base, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(base.is_some());
        assert!(
            diagnostics
                .iter()
                .any(|d| d.message.contains("not declared")),
            "{diagnostics:?}"
        );
    }

    #[test]
    fn prop_escape_skips_system_resolution() {
        // `prop.kind` refers to the vault property, not the system field —
        // undeclared here, so it warns rather than silently binding to system.
        let content = r#"
name = "X"

[filter]
field = "prop.kind"
op = "eq"
value = "work"
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), content);
        assert!(
            diagnostics
                .iter()
                .any(|d| d.message.contains("`kind` is not declared")),
            "{diagnostics:?}"
        );

        // Bare `kind` binds to the system field: no warning.
        let bare = r#"
name = "X"

[filter]
field = "kind"
op = "eq"
value = "BOOK"
"#;
        let (_, diagnostics) = parse_base(&path("bases/x.base.toml"), bare);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
    }
}
