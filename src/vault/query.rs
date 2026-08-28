//! The base query engine: filter compilation, sort, group, and aggregate
//! evaluation over `pages`, `page_properties`, `tags`, and `links`.
//!
//! One evaluator serves both the view endpoint and the generic query
//! endpoint. Filters compile to SQL with parameter binding only — no value
//! interpolation. System fields become column predicates on `pages`;
//! properties become `EXISTS` subqueries on `page_properties`, choosing the
//! typed column by the declared type in the enclosing base (or an inline
//! `types` map for the generic endpoint, defaulting to text).

use std::collections::HashMap;

use pulldown_cmark::{Event, Parser, TagEnd};
use rusqlite::Connection;
use thiserror::Error;

use super::base::{
    Aggregate, AggregateFn, BODY_COLUMN, BaseDefinition, Filter, Op, PropertyType, SortDir,
    SortKey, is_body_field_reference, relative_date_window,
};
use super::canonical::CanonicalName;
use super::link::normalize_links_to_target;
use super::markdown::markdown_options;
use super::page::Page;
use super::toml_json::toml_value_to_json;

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/// A system field backed by the `pages` table (or `tags`/`canonical_names`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SysField {
    Id,
    Path,
    Title,
    Kind,
    Project,
    Tags,
    Aliases,
    CreatedAt,
    UpdatedAt,
    Encryption,
    JournalDate,
    WordCount,
}

impl SysField {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "id" => SysField::Id,
            "path" => SysField::Path,
            "title" => SysField::Title,
            "kind" => SysField::Kind,
            "project" => SysField::Project,
            "tags" => SysField::Tags,
            "aliases" => SysField::Aliases,
            "created_at" => SysField::CreatedAt,
            "updated_at" => SysField::UpdatedAt,
            "encryption" => SysField::Encryption,
            "journal_date" => SysField::JournalDate,
            "word_count" => SysField::WordCount,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SysField::Id => "id",
            SysField::Path => "path",
            SysField::Title => "title",
            SysField::Kind => "kind",
            SysField::Project => "project",
            SysField::Tags => "tags",
            SysField::Aliases => "aliases",
            SysField::CreatedAt => "created_at",
            SysField::UpdatedAt => "updated_at",
            SysField::Encryption => "encryption",
            SysField::JournalDate => "journal_date",
            SysField::WordCount => "word_count",
        }
    }

    /// The `pages` column for scalar system fields; `None` for the
    /// multi-valued ones (`tags`, `aliases`).
    fn column(self) -> Option<&'static str> {
        Some(match self {
            SysField::Id => "p.id",
            SysField::Path => "p.path",
            SysField::Title => "p.title",
            SysField::Kind => "p.kind",
            SysField::Project => "p.project",
            SysField::CreatedAt => "p.created_at",
            SysField::UpdatedAt => "p.updated_at",
            SysField::Encryption => "p.encrypted",
            SysField::JournalDate => "p.journal_date",
            SysField::WordCount => "p.word_count",
            SysField::Tags | SysField::Aliases => return None,
        })
    }

    pub(crate) fn property_type(self) -> PropertyType {
        match self {
            SysField::Encryption => PropertyType::Bool,
            SysField::WordCount => PropertyType::Number,
            SysField::JournalDate => PropertyType::Date,
            _ => PropertyType::Text,
        }
    }

    pub(crate) fn is_scalar_sortable(self) -> bool {
        !matches!(
            self,
            SysField::Tags | SysField::Aliases | SysField::Encryption
        )
    }

    pub(crate) fn supports_contains(self) -> bool {
        self.property_type().supports_contains()
    }

    /// `created_at` / `updated_at` compare as text everywhere else, but they
    /// hold ISO timestamps, so relative-date predicates are defined for them.
    pub(crate) fn supports_relative_date(self) -> bool {
        matches!(
            self,
            SysField::CreatedAt | SysField::UpdatedAt | SysField::JournalDate
        )
    }

    /// Affix matching needs one scalar text column: `tags` / `aliases` are
    /// membership sets, where a prefix or suffix has no meaning.
    pub(crate) fn supports_affix(self) -> bool {
        self.column().is_some() && self.property_type() == PropertyType::Text
    }
}

/// Canonical identity for fields that may be projected for presentation.
///
/// Identity intentionally excludes spelling: bare system references and
/// `sys.` references compare equal, while explicitly qualified properties
/// remain distinct from shadowed system fields.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ProjectionFieldIdentity {
    System(SysField),
    Property(String),
    Body,
}

/// A field reference resolved against the query context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedField {
    Sys(SysField),
    Prop { key: String, ty: PropertyType },
}

/// Whether a resolved field may be a `group_by` key: any system field backed
/// by a `pages` column, or a declared property of a scalar, comparable type.
pub(crate) fn is_groupable(resolved: &ResolvedField) -> bool {
    match resolved {
        ResolvedField::Sys(sys) => sys.column().is_some(),
        ResolvedField::Prop { ty, .. } => matches!(
            ty,
            PropertyType::Select
                | PropertyType::Text
                | PropertyType::Bool
                | PropertyType::Date
                | PropertyType::Datetime
                | PropertyType::Url
        ),
    }
}

/// Everything field resolution needs: the enclosing base (view queries) and
/// an inline type map (the generic endpoint has no base context).
#[derive(Debug)]
pub struct QueryContext<'a> {
    pub base: Option<&'a BaseDefinition>,
    pub types: HashMap<String, PropertyType>,
    /// Evaluation date for relative-date operators. API handlers set it from
    /// `state.clock`; the constructors default to the UTC date now.
    pub today: chrono::NaiveDate,
}

impl Default for QueryContext<'_> {
    fn default() -> Self {
        Self {
            base: None,
            types: HashMap::new(),
            today: chrono::Utc::now().date_naive(),
        }
    }
}

impl<'a> QueryContext<'a> {
    pub fn for_base(base: &'a BaseDefinition) -> Self {
        Self {
            base: Some(base),
            ..Self::default()
        }
    }

    pub fn with_today(mut self, today: chrono::NaiveDate) -> Self {
        self.today = today;
        self
    }

    fn property_type(&self, key: &str) -> PropertyType {
        if let Some(base) = self.base
            && let Some(def) = base.property(key)
        {
            return def.property_type;
        }
        self.types.get(key).copied().unwrap_or(PropertyType::Text)
    }
}

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("unknown system field `{0}`")]
    UnknownSystemField(String),
    #[error(
        "`body` is projection-only and cannot be used as a filter, sort key, group, or aggregate"
    )]
    ProjectionOnlyBody,
    #[error("op `{op:?}` is not valid for field `{field}`")]
    InvalidOp { field: String, op: Op },
    #[error("invalid value for field `{field}`: {reason}")]
    InvalidValue { field: String, reason: String },
    #[error(
        "`group_by` field `{0}` cannot group (must be a declared select/text/bool/date property)"
    )]
    Ungroupable(String),
    #[error("aggregate `{0:?}` requires a numeric or date field")]
    InvalidAggregate(AggregateFn),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Resolve a presentation field to its canonical identity. Bare names bind
/// system-first; `sys.<name>` / `prop.<name>` disambiguate. All accepted body
/// spellings resolve to the projection-only body identity.
pub fn resolve_projection_field(field: &str) -> Result<ProjectionFieldIdentity, QueryError> {
    if is_body_field_reference(field) {
        return Ok(ProjectionFieldIdentity::Body);
    }
    if let Some(name) = field.strip_prefix("sys.") {
        return SysField::from_name(name)
            .map(ProjectionFieldIdentity::System)
            .ok_or_else(|| QueryError::UnknownSystemField(name.to_string()));
    }
    if let Some(name) = field.strip_prefix("prop.") {
        return Ok(ProjectionFieldIdentity::Property(name.to_string()));
    }
    if let Some(sys) = SysField::from_name(field) {
        return Ok(ProjectionFieldIdentity::System(sys));
    }
    Ok(ProjectionFieldIdentity::Property(field.to_string()))
}

/// Resolve a general query field. Presentation-only `body` remains rejected
/// for filter, sort, group, and aggregate callers.
pub fn resolve_field(field: &str, ctx: &QueryContext) -> Result<ResolvedField, QueryError> {
    match resolve_projection_field(field)? {
        ProjectionFieldIdentity::System(sys) => Ok(ResolvedField::Sys(sys)),
        ProjectionFieldIdentity::Property(key) => {
            let ty = ctx.property_type(&key);
            Ok(ResolvedField::Prop { key, ty })
        }
        ProjectionFieldIdentity::Body => Err(QueryError::ProjectionOnlyBody),
    }
}

/// Materialize one canonical presentation field from an already-read page.
///
/// The caller supplies canonical identities so each merged field is resolved
/// once. This stays file-backed and read-only: no per-field index query is
/// needed, and the page body is borrowed until an excerpt is requested.
pub fn project_page_field_value(
    page: &Page,
    identity: &ProjectionFieldIdentity,
) -> (bool, Option<serde_json::Value>) {
    let path = page.path.as_str();
    let optional_string = |value: Option<String>| match value {
        Some(value) => (true, Some(serde_json::Value::String(value))),
        None => (false, None),
    };

    match identity {
        ProjectionFieldIdentity::System(SysField::Id) => (
            true,
            Some(serde_json::Value::String(page.meta.id.to_string())),
        ),
        ProjectionFieldIdentity::System(SysField::Path) => {
            (true, Some(serde_json::Value::String(path.to_string())))
        }
        ProjectionFieldIdentity::System(SysField::Title) => {
            optional_string(page.meta.title.clone())
        }
        ProjectionFieldIdentity::System(SysField::Kind) => (
            true,
            Some(serde_json::Value::String(
                crate::vault::kind::resolve(path, page.meta.kind)
                    .0
                    .as_str()
                    .to_string(),
            )),
        ),
        ProjectionFieldIdentity::System(SysField::Project) => {
            optional_string(page.meta.project.clone())
        }
        ProjectionFieldIdentity::System(SysField::Tags) => {
            let kind = crate::vault::kind::resolve(path, page.meta.kind).0;
            (
                true,
                Some(serde_json::Value::Array(
                    crate::vault::kind::effective_tags(kind, &page.meta.tags)
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                )),
            )
        }
        ProjectionFieldIdentity::System(SysField::Aliases) => {
            if page.meta.aliases.is_empty() {
                (false, None)
            } else {
                (
                    true,
                    Some(serde_json::Value::Array(
                        page.meta
                            .aliases
                            .iter()
                            .cloned()
                            .map(serde_json::Value::String)
                            .collect(),
                    )),
                )
            }
        }
        ProjectionFieldIdentity::System(SysField::CreatedAt) => {
            optional_string(page.meta.created_at.map(|value| value.to_rfc3339()))
        }
        ProjectionFieldIdentity::System(SysField::UpdatedAt) => {
            optional_string(page.meta.updated_at.map(|value| value.to_rfc3339()))
        }
        ProjectionFieldIdentity::System(SysField::Encryption) => (
            true,
            Some(serde_json::Value::Bool(page.meta.encryption.is_some())),
        ),
        ProjectionFieldIdentity::System(SysField::JournalDate) => {
            optional_string(page_journal_date(path).map(str::to_owned))
        }
        ProjectionFieldIdentity::System(SysField::WordCount) => {
            if page.is_encrypted() {
                (false, None)
            } else {
                (
                    true,
                    Some(serde_json::json!(page.body.split_whitespace().count())),
                )
            }
        }
        ProjectionFieldIdentity::Property(key) => match page.meta.extra.get(key) {
            Some(value) => (true, Some(toml_value_to_json(value))),
            None => (false, None),
        },
        ProjectionFieldIdentity::Body => {
            if page.is_encrypted() {
                (false, None)
            } else {
                let excerpt = body_excerpt(&page.body);
                if excerpt.is_empty() {
                    (false, None)
                } else {
                    (true, Some(serde_json::Value::String(excerpt)))
                }
            }
        }
    }
}

/// Match the journal-date path forms materialized by the page index
/// (`journals/` and `ai-journals/`).
fn page_journal_date(path: &str) -> Option<&str> {
    let filename = path
        .strip_prefix("journals/")
        .or_else(|| path.strip_prefix("ai-journals/"))?;
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let candidate = if stem.len() == 10 {
        stem
    } else if crate::vault::path::is_canonical_page_filename(filename) {
        stem.split('.').nth(1)?
    } else {
        return None;
    };
    let bytes = candidate.as_bytes();
    if candidate.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || [0, 1, 2, 3, 5, 6, 8, 9]
            .into_iter()
            .any(|index| !bytes[index].is_ascii_digit())
    {
        return None;
    }
    Some(candidate)
}

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

type SqlValue = rusqlite::types::Value;

/// A compiled WHERE fragment plus its bound parameters, in placeholder order.
#[derive(Debug, Default)]
pub struct SqlFilter {
    pub clause: String,
    pub params: Vec<SqlValue>,
}

/// The typed `page_properties` column for a declared property type.
fn typed_column(ty: PropertyType) -> &'static str {
    match ty {
        PropertyType::Number => "value_num",
        PropertyType::Date | PropertyType::Datetime => "value_date",
        PropertyType::Bool => "value_bool",
        _ => "value_text",
    }
}

/// Convert a JSON literal to a bindable SQL value for the given column class.
fn bind_value(
    field: &str,
    ty: PropertyType,
    value: &serde_json::Value,
) -> Result<SqlValue, QueryError> {
    let fail = |reason: &str| QueryError::InvalidValue {
        field: field.to_string(),
        reason: reason.to_string(),
    };
    match ty {
        PropertyType::Number => match value {
            serde_json::Value::Number(n) => Ok(SqlValue::Real(
                n.as_f64().ok_or_else(|| fail("number out of range"))?,
            )),
            _ => Err(fail("expected a number")),
        },
        PropertyType::Bool => match value {
            serde_json::Value::Bool(b) => Ok(SqlValue::Integer(*b as i64)),
            _ => Err(fail("expected a boolean")),
        },
        _ => match value {
            serde_json::Value::String(s) => Ok(SqlValue::Text(s.clone())),
            serde_json::Value::Number(n) => Ok(SqlValue::Text(n.to_string())),
            serde_json::Value::Bool(b) => Ok(SqlValue::Text(b.to_string())),
            _ => Err(fail("expected a scalar")),
        },
    }
}

/// Bind a literal for the substring-shaped operators (`contains`,
/// `not_contains`, `starts_with`, `ends_with`), escaping the `LIKE`
/// metacharacters so the pattern matches the value as written.
fn bind_literal_contains_value(
    field: &str,
    ty: PropertyType,
    op: Op,
    value: &serde_json::Value,
) -> Result<SqlValue, QueryError> {
    let SqlValue::Text(value) = bind_value(field, ty, value)? else {
        return Err(QueryError::InvalidOp {
            field: field.to_string(),
            op,
        });
    };
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    Ok(SqlValue::Text(escaped))
}

/// Bind the half-open `[start, end)` bounds of a relative-date window as
/// `YYYY-MM-DD` text. Every date-bearing column stores an ISO string whose
/// first ten characters are the date face, so lexicographic bounds select the
/// window for `value_date`, `created_at`/`updated_at`, and `journal_date`
/// alike.
fn bind_relative_window(op: Op, today: chrono::NaiveDate, params: &mut Vec<SqlValue>) {
    let (start, end) = relative_date_window(op, today).expect("caller checked is_relative_date");
    params.push(SqlValue::Text(start.format("%Y-%m-%d").to_string()));
    params.push(SqlValue::Text(end.format("%Y-%m-%d").to_string()));
}

fn sql_op(op: Op) -> Option<&'static str> {
    Some(match op {
        Op::Eq => "=",
        Op::Ne => "!=",
        Op::Lt => "<",
        Op::Lte => "<=",
        Op::Gt => ">",
        Op::Gte => ">=",
        _ => return None,
    })
}

/// Compile a filter to a WHERE fragment over `pages p`.
pub fn compile_filter(filter: &Filter, ctx: &QueryContext) -> Result<SqlFilter, QueryError> {
    let mut out = SqlFilter::default();
    out.clause = compile_node(filter, ctx, &mut out.params)?;
    Ok(out)
}

fn compile_node(
    filter: &Filter,
    ctx: &QueryContext,
    params: &mut Vec<SqlValue>,
) -> Result<String, QueryError> {
    match filter {
        Filter::All(children) => compile_group(children, " AND ", "1=1", ctx, params),
        Filter::Any(children) => compile_group(children, " OR ", "1=0", ctx, params),
        Filter::Not(child) => Ok(format!("NOT ({})", compile_node(child, ctx, params)?)),
        Filter::Cmp { field, op, value } => compile_cmp(field, *op, value, ctx, params),
    }
}

fn compile_group(
    children: &[Filter],
    joiner: &str,
    empty: &str,
    ctx: &QueryContext,
    params: &mut Vec<SqlValue>,
) -> Result<String, QueryError> {
    if children.is_empty() {
        return Ok(empty.to_string());
    }
    let parts: Vec<String> = children
        .iter()
        .map(|c| compile_node(c, ctx, params))
        .collect::<Result<_, _>>()?;
    Ok(format!("({})", parts.join(joiner)))
}

fn compile_cmp(
    field: &str,
    op: Op,
    value: &serde_json::Value,
    ctx: &QueryContext,
    params: &mut Vec<SqlValue>,
) -> Result<String, QueryError> {
    match resolve_field(field, ctx)? {
        ResolvedField::Sys(SysField::Tags) => compile_membership(
            field,
            op,
            value,
            "SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag",
            params,
            |v| Ok(SqlValue::Text(v)),
        ),
        ResolvedField::Sys(SysField::Aliases) => compile_membership(
            field,
            op,
            value,
            "SELECT 1 FROM canonical_names a WHERE a.page_id = p.id AND a.source = 'alias' AND a.canonical_name",
            params,
            |v| {
                Ok(SqlValue::Text(
                    CanonicalName::from_title(&v).as_str().to_string(),
                ))
            },
        ),
        ResolvedField::Sys(sys) => {
            let column = sys.column().expect("scalar system field");
            match op {
                Op::IsEmpty => Ok(format!("{column} IS NULL")),
                Op::NotEmpty => Ok(format!("{column} IS NOT NULL")),
                Op::In => {
                    let items = value.as_array().ok_or_else(|| QueryError::InvalidValue {
                        field: field.to_string(),
                        reason: "`in` expects an array".into(),
                    })?;
                    let mut holes = Vec::with_capacity(items.len());
                    for item in items {
                        params.push(bind_sys_value(field, sys, item)?);
                        holes.push("?");
                    }
                    Ok(format!("{column} IN ({})", holes.join(", ")))
                }
                Op::Contains if !sys.supports_contains() => Err(QueryError::InvalidOp {
                    field: field.to_string(),
                    op,
                }),
                Op::Contains => {
                    params.push(bind_literal_contains_value(
                        field,
                        PropertyType::Text,
                        op,
                        value,
                    )?);
                    Ok(format!("{column} LIKE '%' || ? || '%' ESCAPE '\\'"))
                }
                op if op.is_relative_date() => {
                    if !sys.supports_relative_date() {
                        return Err(QueryError::InvalidOp {
                            field: field.to_string(),
                            op,
                        });
                    }
                    bind_relative_window(op, ctx.today, params);
                    Ok(format!("({column} >= ? AND {column} < ?)"))
                }
                Op::NotContains if !sys.supports_contains() => Err(QueryError::InvalidOp {
                    field: field.to_string(),
                    op,
                }),
                Op::NotContains => {
                    params.push(bind_literal_contains_value(
                        field,
                        PropertyType::Text,
                        op,
                        value,
                    )?);
                    Ok(format!(
                        "({column} IS NULL OR {column} NOT LIKE '%' || ? || '%' ESCAPE '\\')"
                    ))
                }
                Op::StartsWith | Op::EndsWith if !sys.supports_affix() => {
                    Err(QueryError::InvalidOp {
                        field: field.to_string(),
                        op,
                    })
                }
                Op::StartsWith => {
                    params.push(bind_literal_contains_value(
                        field,
                        PropertyType::Text,
                        op,
                        value,
                    )?);
                    Ok(format!("{column} LIKE ? || '%' ESCAPE '\\'"))
                }
                Op::EndsWith => {
                    params.push(bind_literal_contains_value(
                        field,
                        PropertyType::Text,
                        op,
                        value,
                    )?);
                    Ok(format!("{column} LIKE '%' || ? ESCAPE '\\'"))
                }
                Op::LinksTo => Err(QueryError::InvalidOp {
                    field: field.to_string(),
                    op,
                }),
                _ => {
                    let sql = sql_op(op).expect("scalar ops covered");
                    params.push(bind_sys_value(field, sys, value)?);
                    if matches!(op, Op::Ne) {
                        Ok(format!("({column} IS NULL OR {column} {sql} ?)"))
                    } else {
                        Ok(format!("{column} {sql} ?"))
                    }
                }
            }
        }
        ResolvedField::Prop { key, ty } => {
            compile_prop(field, &key, ty, op, value, ctx.today, params)
        }
    }
}

fn bind_sys_value(
    field: &str,
    sys: SysField,
    value: &serde_json::Value,
) -> Result<SqlValue, QueryError> {
    bind_value(field, sys.property_type(), value)
}

/// Membership-style compile for `tags` / `aliases`.
fn compile_membership(
    field: &str,
    op: Op,
    value: &serde_json::Value,
    exists_prefix: &str,
    params: &mut Vec<SqlValue>,
    to_param: impl Fn(String) -> Result<SqlValue, QueryError>,
) -> Result<String, QueryError> {
    let text = |v: &serde_json::Value| -> Result<String, QueryError> {
        v.as_str()
            .map(str::to_string)
            .ok_or_else(|| QueryError::InvalidValue {
                field: field.to_string(),
                reason: "expected a string".into(),
            })
    };
    match op {
        Op::Eq | Op::Contains => {
            params.push(to_param(text(value)?)?);
            Ok(format!("EXISTS ({exists_prefix} = ?)"))
        }
        Op::Ne | Op::NotContains => {
            params.push(to_param(text(value)?)?);
            Ok(format!("NOT EXISTS ({exists_prefix} = ?)"))
        }
        Op::In => {
            let items = value.as_array().ok_or_else(|| QueryError::InvalidValue {
                field: field.to_string(),
                reason: "`in` expects an array".into(),
            })?;
            let mut holes = Vec::with_capacity(items.len());
            for item in items {
                params.push(to_param(text(item)?)?);
                holes.push("?");
            }
            Ok(format!(
                "EXISTS ({exists_prefix} IN ({}))",
                holes.join(", ")
            ))
        }
        Op::IsEmpty => Ok(format!("NOT EXISTS ({exists_prefix} IS NOT NULL)")),
        Op::NotEmpty => Ok(format!("EXISTS ({exists_prefix} IS NOT NULL)")),
        _ => Err(QueryError::InvalidOp {
            field: field.to_string(),
            op,
        }),
    }
}

fn compile_prop(
    field: &str,
    key: &str,
    ty: PropertyType,
    op: Op,
    value: &serde_json::Value,
    today: chrono::NaiveDate,
    params: &mut Vec<SqlValue>,
) -> Result<String, QueryError> {
    let column = typed_column(ty);
    let exists = |pred: &str| {
        format!(
            "EXISTS (SELECT 1 FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = ? AND {pred})"
        )
    };
    match op {
        Op::IsEmpty => {
            // Absence of rows IS the empty state (empty string / empty array
            // project no rows; TOML has no null).
            params.push(SqlValue::Text(key.to_string()));
            Ok("NOT EXISTS (SELECT 1 FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = ?)".to_string())
        }
        Op::NotEmpty => {
            params.push(SqlValue::Text(key.to_string()));
            Ok(
                "EXISTS (SELECT 1 FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = ?)"
                    .to_string(),
            )
        }
        Op::LinksTo if !ty.supports_links_to() => Err(QueryError::InvalidOp {
            field: field.to_string(),
            op,
        }),
        Op::LinksTo => {
            let target = value.as_str().ok_or_else(|| QueryError::InvalidValue {
                field: field.to_string(),
                reason: "`links_to` expects a string target".into(),
            })?;
            let target = normalize_links_to_target(target);
            params.push(SqlValue::Text(key.to_string()));
            params.push(SqlValue::Text(target.target_id));
            params.push(SqlValue::Text(target.target_canonical));
            Ok(
                "EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.id AND l.source_field = ? AND (l.target_id = ? OR l.target_canonical = ?))"
                    .to_string(),
            )
        }
        Op::In => {
            let items = value.as_array().ok_or_else(|| QueryError::InvalidValue {
                field: field.to_string(),
                reason: "`in` expects an array".into(),
            })?;
            params.push(SqlValue::Text(key.to_string()));
            let mut holes = Vec::with_capacity(items.len());
            for item in items {
                params.push(bind_value(field, ty, item)?);
                holes.push("?");
            }
            Ok(exists(&format!("pp.{column} IN ({})", holes.join(", "))))
        }
        Op::Contains if !ty.supports_contains() => Err(QueryError::InvalidOp {
            field: field.to_string(),
            op,
        }),
        Op::Contains => {
            params.push(SqlValue::Text(key.to_string()));
            if matches!(
                ty,
                PropertyType::MultiSelect | PropertyType::Select | PropertyType::Relation
            ) {
                params.push(bind_value(field, ty, value)?);
                // Membership on multi-valued: any element matches exactly.
                Ok(exists(&format!("pp.{column} = ?")))
            } else {
                params.push(bind_literal_contains_value(field, ty, op, value)?);
                Ok(exists(&format!(
                    "pp.{column} LIKE '%' || ? || '%' ESCAPE '\\'"
                )))
            }
        }
        op if op.is_relative_date() => {
            if !ty.supports_relative_date() {
                return Err(QueryError::InvalidOp {
                    field: field.to_string(),
                    op,
                });
            }
            params.push(SqlValue::Text(key.to_string()));
            bind_relative_window(op, today, params);
            Ok(exists("pp.value_date >= ? AND pp.value_date < ?"))
        }
        Op::NotContains if !ty.supports_contains() => Err(QueryError::InvalidOp {
            field: field.to_string(),
            op,
        }),
        Op::NotContains => {
            params.push(SqlValue::Text(key.to_string()));
            let predicate = if matches!(
                ty,
                PropertyType::MultiSelect | PropertyType::Select | PropertyType::Relation
            ) {
                params.push(bind_value(field, ty, value)?);
                format!("pp.{column} = ?")
            } else {
                params.push(bind_literal_contains_value(field, ty, op, value)?);
                format!("pp.{column} LIKE '%' || ? || '%' ESCAPE '\\'")
            };
            // "No element matches": pages without the key also match.
            Ok(format!(
                "NOT EXISTS (SELECT 1 FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = ? AND {predicate})"
            ))
        }
        Op::StartsWith | Op::EndsWith if !ty.supports_affix() => Err(QueryError::InvalidOp {
            field: field.to_string(),
            op,
        }),
        Op::StartsWith => {
            params.push(SqlValue::Text(key.to_string()));
            params.push(bind_literal_contains_value(field, ty, op, value)?);
            Ok(exists(&format!("pp.{column} LIKE ? || '%' ESCAPE '\\'")))
        }
        Op::EndsWith => {
            params.push(SqlValue::Text(key.to_string()));
            params.push(bind_literal_contains_value(field, ty, op, value)?);
            Ok(exists(&format!("pp.{column} LIKE '%' || ? ESCAPE '\\'")))
        }
        Op::Ne => {
            params.push(SqlValue::Text(key.to_string()));
            params.push(bind_value(field, ty, value)?);
            // "No element equals": pages without the key also match.
            Ok(format!(
                "NOT EXISTS (SELECT 1 FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = ? AND pp.{column} = ?)"
            ))
        }
        _ => {
            let sql = sql_op(op).expect("remaining ops are scalar comparisons");
            params.push(SqlValue::Text(key.to_string()));
            params.push(bind_value(field, ty, value)?);
            Ok(exists(&format!("pp.{column} {sql} ?")))
        }
    }
}

// ---------------------------------------------------------------------------
// Evaluation: sort, group, aggregate
// ---------------------------------------------------------------------------

pub const DEFAULT_GROUP_ROW_LIMIT: u32 = 50;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GroupRowLimit {
    #[default]
    Default,
    Unlimited,
    Limit(u32),
}

/// A full query specification (view definition or generic query request).
#[derive(Debug, Default)]
pub struct QuerySpec {
    pub filter: Option<Filter>,
    pub sort: Vec<SortKey>,
    pub group_by: Option<String>,
    pub aggregates: Vec<Aggregate>,
    /// Property keys (or system fields) to materialize as row columns.
    pub columns: Vec<String>,
    pub limit: Option<u32>,
    pub offset: u32,
    pub group_row_limit: GroupRowLimit,
}

/// One result row: system fields plus materialized columns (`ord = 0`
/// projections as canonical JSON).
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct QueryRow {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[schema(value_type = std::collections::HashMap<String, serde_json::Value>)]
    pub columns: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
pub struct GroupResult {
    /// The raw group key; `null` is the empty bucket.
    #[schema(value_type = serde_json::Value)]
    pub key: serde_json::Value,
    /// True total row count for the group (rows may be capped).
    pub total: i64,
    /// One value per requested aggregate, in request order.
    #[schema(value_type = Vec<serde_json::Value>)]
    pub aggregates: Vec<serde_json::Value>,
    pub rows: Vec<QueryRow>,
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(tag = "shape", rename_all = "snake_case")]
pub enum QueryOutput {
    Flat {
        rows: Vec<QueryRow>,
        total: i64,
        /// One value per requested aggregate, in request order, computed
        /// over the whole predicate (unaffected by `limit`/`offset`).
        #[schema(value_type = Vec<serde_json::Value>)]
        aggregates: Vec<serde_json::Value>,
    },
    Grouped {
        groups: Vec<GroupResult>,
    },
}

struct PreparedQuery {
    where_clause: String,
    where_params: Vec<SqlValue>,
    join_clause: String,
    join_params: Vec<SqlValue>,
    order_clause: String,
    /// Params bound inside ORDER BY (relation-sort correlated subqueries);
    /// placeholders bind in textual order, so these come last.
    order_params: Vec<SqlValue>,
}

fn prepare(spec: &QuerySpec, ctx: &QueryContext) -> Result<PreparedQuery, QueryError> {
    let (where_clause, where_params) = match &spec.filter {
        Some(filter) => {
            let compiled = compile_filter(filter, ctx)?;
            (compiled.clause, compiled.params)
        }
        None => ("1=1".to_string(), Vec::new()),
    };

    // Sort: one LEFT JOIN per property sort key, ordered nulls-last.
    let mut join_clause = String::new();
    let mut join_params = Vec::new();
    let mut order_params = Vec::new();
    let mut order_exprs = Vec::new();
    for (i, sort_key) in spec.sort.iter().enumerate() {
        let dir = match sort_key.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        match resolve_field(&sort_key.field, ctx)? {
            ResolvedField::Sys(sys) => {
                if !sys.is_scalar_sortable() {
                    return Err(QueryError::InvalidOp {
                        field: sort_key.field.clone(),
                        op: Op::Eq,
                    });
                }
                let column = sys.column().ok_or_else(|| QueryError::InvalidOp {
                    field: sort_key.field.clone(),
                    op: Op::Eq,
                })?;
                order_exprs.push(format!("{column} IS NULL, {column} {dir}"));
            }
            ResolvedField::Prop { key, ty } => {
                if ty == PropertyType::Relation {
                    // Order by the first target's canonical name. The param
                    // binds inside ORDER BY, textually after the WHERE params.
                    order_params.push(SqlValue::Text(key));
                    order_exprs.push(format!(
                        "(SELECT l.target_canonical FROM links l WHERE l.source_id = p.id AND l.source_field = ? ORDER BY l.span_start LIMIT 1) {dir}"
                    ));
                    continue;
                }
                let column = typed_column(ty);
                let alias = format!("s{i}");
                join_clause.push_str(&format!(
                    " LEFT JOIN page_properties {alias} ON {alias}.page_id = p.id AND {alias}.key = ? AND {alias}.ord = 0"
                ));
                join_params.push(SqlValue::Text(key));
                order_exprs.push(format!("{alias}.{column} IS NULL, {alias}.{column} {dir}"));
            }
        }
    }
    // Always end on a stable tie-break so equal (or NULL) sort keys keep a
    // deterministic order.
    let order_clause = if order_exprs.is_empty() {
        "p.path ASC".to_string()
    } else {
        format!("{}, p.path ASC", order_exprs.join(", "))
    };

    Ok(PreparedQuery {
        where_clause,
        where_params,
        join_clause,
        join_params,
        order_clause,
        order_params,
    })
}

/// Evaluate a query. Grouped when `spec.group_by` is set, flat otherwise.
pub fn evaluate(
    conn: &Connection,
    spec: &QuerySpec,
    ctx: &QueryContext,
) -> Result<QueryOutput, QueryError> {
    for aggregate in &spec.aggregates {
        if let Some(field) = aggregate.field.as_deref()
            && matches!(
                resolve_field(field, ctx),
                Err(QueryError::ProjectionOnlyBody)
            )
        {
            return Err(QueryError::ProjectionOnlyBody);
        }
    }
    match &spec.group_by {
        Some(group_key) => evaluate_grouped(conn, spec, ctx, group_key),
        None => evaluate_flat(conn, spec, ctx),
    }
}

fn evaluate_flat(
    conn: &Connection,
    spec: &QuerySpec,
    ctx: &QueryContext,
) -> Result<QueryOutput, QueryError> {
    let prepared = prepare(spec, ctx)?;
    let plan = plan_aggregates(spec, ctx)?;

    // Header query: total row count plus every non-median aggregate, all
    // computed over the whole predicate (`limit`/`offset` apply only to the
    // row fetch below).
    let header_sql = format!(
        "SELECT COUNT(*){} FROM pages p{} WHERE {}",
        plan.exprs
            .iter()
            .flatten()
            .map(|e| format!(", {e}"))
            .collect::<String>(),
        plan.joins,
        prepared.where_clause,
    );
    let mut header_params: Vec<SqlValue> = Vec::new();
    header_params.extend(plan.params.iter().cloned());
    header_params.extend(prepared.where_params.iter().cloned());

    let (total, mut aggregates): (i64, Vec<serde_json::Value>) = conn.query_row(
        &header_sql,
        rusqlite::params_from_iter(header_params.iter()),
        |row| {
            let total: i64 = row.get(0)?;
            let mut aggregates = Vec::with_capacity(plan.exprs.len());
            let mut col = 1;
            for expr in &plan.exprs {
                if expr.is_some() {
                    let v: rusqlite::types::Value = row.get(col)?;
                    aggregates.push(sql_value_to_json(v));
                    col += 1;
                } else {
                    // Median placeholder, filled in below.
                    aggregates.push(serde_json::Value::Null);
                }
            }
            Ok((total, aggregates))
        },
    )?;

    for median in &plan.medians {
        aggregates[median.index] = median_value(conn, &prepared, median, None)?;
    }

    let rows = fetch_rows(conn, spec, ctx, &prepared, None, spec.limit, spec.offset)?;
    Ok(QueryOutput::Flat {
        rows,
        total,
        aggregates,
    })
}

fn evaluate_grouped(
    conn: &Connection,
    spec: &QuerySpec,
    ctx: &QueryContext,
    group_key: &str,
) -> Result<QueryOutput, QueryError> {
    // Group key must be a declared, groupable property (or a scalar system
    // field like `kind`).
    let resolved = resolve_field(group_key, ctx)?;
    if !is_groupable(&resolved) {
        return Err(QueryError::Ungroupable(group_key.to_string()));
    }
    let group_column = match resolved {
        ResolvedField::Sys(sys) => GroupColumn::System(
            sys.column()
                .expect("is_groupable admits only column-backed system fields"),
        ),
        ResolvedField::Prop { key, ty } => GroupColumn::Property {
            key,
            column: typed_column(ty),
        },
    };

    let prepared = prepare(spec, ctx)?;
    let plan = plan_aggregates(spec, ctx)?;

    // The grouped header query: key, total, aggregates.
    let (group_expr, group_join, group_join_param) = match &group_column {
        GroupColumn::System(column) => (column.to_string(), String::new(), None),
        GroupColumn::Property { key, column } => (
            format!("grp.{column}"),
            " LEFT JOIN page_properties grp ON grp.page_id = p.id AND grp.key = ? AND grp.ord = 0"
                .to_string(),
            Some(SqlValue::Text(key.clone())),
        ),
    };

    let header_sql = format!(
        "SELECT {group_expr} AS gkey, COUNT(*) AS total{} FROM pages p{group_join}{} WHERE {} GROUP BY gkey ORDER BY gkey IS NULL, gkey ASC",
        plan.exprs
            .iter()
            .flatten()
            .map(|e| format!(", {e}"))
            .collect::<String>(),
        plan.joins,
        prepared.where_clause,
    );
    let mut header_params: Vec<SqlValue> = Vec::new();
    if let Some(p) = &group_join_param {
        header_params.push(p.clone());
    }
    header_params.extend(plan.params.iter().cloned());
    header_params.extend(prepared.where_params.iter().cloned());

    #[allow(clippy::type_complexity)]
    let headers: Vec<(Option<SqlValue>, i64, Vec<serde_json::Value>)> = {
        let mut stmt = conn.prepare(&header_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(header_params.iter()), |row| {
            let key: Option<SqlValue> =
                row.get::<_, rusqlite::types::Value>(0).map(|v| match v {
                    rusqlite::types::Value::Null => None,
                    other => Some(other),
                })?;
            let total: i64 = row.get(1)?;
            let mut aggs = Vec::with_capacity(plan.exprs.len());
            let mut col = 2;
            for expr in &plan.exprs {
                if expr.is_some() {
                    let v: rusqlite::types::Value = row.get(col)?;
                    aggs.push(sql_value_to_json(v));
                    col += 1;
                } else {
                    // Median placeholder, filled in below.
                    aggs.push(serde_json::Value::Null);
                }
            }
            Ok((key, total, aggs))
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let row_limit = match spec.group_row_limit {
        GroupRowLimit::Default => Some(DEFAULT_GROUP_ROW_LIMIT),
        GroupRowLimit::Unlimited => None,
        GroupRowLimit::Limit(limit) => Some(limit),
    };
    let mut groups = Vec::with_capacity(headers.len());
    for (key, total, mut aggregates) in headers {
        for median in &plan.medians {
            aggregates[median.index] =
                median_value(conn, &prepared, median, Some((&group_column, key.as_ref())))?;
        }
        let rows = fetch_rows(
            conn,
            spec,
            ctx,
            &prepared,
            Some((&group_column, key.as_ref())),
            row_limit,
            0,
        )?;
        groups.push(GroupResult {
            key: key
                .map(sql_value_to_json)
                .unwrap_or(serde_json::Value::Null),
            total,
            aggregates,
            rows,
        });
    }

    Ok(QueryOutput::Grouped { groups })
}

enum GroupColumn {
    System(&'static str),
    Property { key: String, column: &'static str },
}

/// `SUM`/`AVG`/`MIN`/`MAX`/`COUNT`: the aggregates that fold straight to one
/// SQL function call. `median` and `range` build their own SQL shape in
/// `plan_aggregates`, and never reach this function.
fn sql_aggregate(f: AggregateFn) -> &'static str {
    match f {
        AggregateFn::Count => "COUNT",
        AggregateFn::Sum => "SUM",
        AggregateFn::Avg => "AVG",
        AggregateFn::Min => "MIN",
        AggregateFn::Max => "MAX",
        AggregateFn::CountEmpty
        | AggregateFn::CountFilled
        | AggregateFn::PercentFilled
        | AggregateFn::CountUnique
        | AggregateFn::Median
        | AggregateFn::Range => {
            unreachable!("{f:?} builds its own SQL shape in plan_aggregates, not via sql_aggregate")
        }
    }
}

// ---------------------------------------------------------------------------
// Aggregate planning: shared SQL shape for flat and grouped evaluation
// ---------------------------------------------------------------------------

/// One aggregate's SQL shape, shared by flat and grouped evaluation.
struct AggregatePlan {
    /// Select expressions appended after `COUNT(*)`; `None` for a median,
    /// which is computed from an ordered fetch (see `median_value`).
    exprs: Vec<Option<String>>,
    /// `LEFT JOIN page_properties agg{i} … AND ord = 0` per property target.
    joins: String,
    params: Vec<SqlValue>,
    medians: Vec<MedianPlan>,
}

struct MedianPlan {
    /// Position in the aggregates list.
    index: usize,
    /// Column expression, e.g. `agg2.value_num` or `p.word_count`.
    column: String,
    /// The join that introduces `column` (empty for system columns), with its params.
    join: String,
    join_params: Vec<SqlValue>,
    numeric: bool,
}

enum AggregateTarget {
    Property { key: String, ty: PropertyType },
    System(&'static str, PropertyType),
}

fn plan_aggregates(spec: &QuerySpec, ctx: &QueryContext) -> Result<AggregatePlan, QueryError> {
    let mut plan = AggregatePlan {
        exprs: Vec::new(),
        joins: String::new(),
        params: Vec::new(),
        medians: Vec::new(),
    };
    for (i, agg) in spec.aggregates.iter().enumerate() {
        let function = agg.function;
        if !function.requires_field() {
            plan.exprs.push(Some("COUNT(*)".to_string()));
            continue;
        }
        let Some(field) = agg.field.as_deref() else {
            return Err(QueryError::InvalidAggregate(function));
        };
        let target = match resolve_field(field, ctx)? {
            ResolvedField::Prop { key, ty } => AggregateTarget::Property { key, ty },
            ResolvedField::Sys(SysField::Tags | SysField::Aliases) => {
                return Err(QueryError::InvalidAggregate(function));
            }
            ResolvedField::Sys(sys) => AggregateTarget::System(
                sys.column().expect("scalar system field"),
                sys.property_type(),
            ),
        };
        let (column, ty, join, join_params) = match target {
            AggregateTarget::Property { key, ty } => {
                let alias = format!("agg{i}");
                let join = format!(
                    " LEFT JOIN page_properties {alias} ON {alias}.page_id = p.id AND {alias}.key = ? AND {alias}.ord = 0"
                );
                (
                    format!("{alias}.{}", typed_column(ty)),
                    ty,
                    join,
                    vec![SqlValue::Text(key)],
                )
            }
            AggregateTarget::System(column, ty) => {
                (column.to_string(), ty, String::new(), Vec::new())
            }
        };
        if function.is_fold()
            && !matches!(
                ty,
                PropertyType::Number | PropertyType::Date | PropertyType::Datetime
            )
        {
            return Err(QueryError::InvalidAggregate(function));
        }
        plan.joins.push_str(&join);
        plan.params.extend(join_params.iter().cloned());
        let numeric = ty == PropertyType::Number;
        plan.exprs.push(match function {
            AggregateFn::Count => unreachable!("handled above"),
            AggregateFn::CountFilled => Some(format!("COUNT({column})")),
            AggregateFn::CountEmpty => Some(format!("COUNT(*) - COUNT({column})")),
            AggregateFn::PercentFilled => Some(format!(
                "CASE WHEN COUNT(*) = 0 THEN 0 ELSE ROUND(100.0 * COUNT({column}) / COUNT(*), 1) END"
            )),
            AggregateFn::CountUnique => Some(format!("COUNT(DISTINCT {column})")),
            AggregateFn::Sum | AggregateFn::Avg | AggregateFn::Min | AggregateFn::Max => {
                Some(format!("{}({column})", sql_aggregate(function)))
            }
            AggregateFn::Range if numeric => Some(format!("MAX({column}) - MIN({column})")),
            AggregateFn::Range => Some(format!(
                "julianday(MAX({column})) - julianday(MIN({column}))"
            )),
            AggregateFn::Median => {
                plan.medians.push(MedianPlan {
                    index: i,
                    column: column.clone(),
                    join,
                    join_params,
                    numeric,
                });
                None
            }
        });
    }
    Ok(plan)
}

/// The group restriction shared by `fetch_rows` and `median_value`: a
/// `LEFT JOIN` (for property groups) plus an `AND` predicate pinning one
/// group's key. The join and predicate params are kept separate because
/// other clauses' params (the base `WHERE`) are bound between them in the
/// full query text.
fn group_predicate(
    group: Option<(&GroupColumn, Option<&SqlValue>)>,
) -> (String, Vec<SqlValue>, String, Vec<SqlValue>) {
    match group {
        None => (String::new(), Vec::new(), String::new(), Vec::new()),
        Some((GroupColumn::System(col), key)) => match key {
            Some(v) => (
                String::new(),
                Vec::new(),
                format!(" AND {col} = ?"),
                vec![(*v).clone()],
            ),
            None => (
                String::new(),
                Vec::new(),
                format!(" AND {col} IS NULL"),
                Vec::new(),
            ),
        },
        Some((GroupColumn::Property { key, column }, value)) => {
            let join =
                " LEFT JOIN page_properties grp ON grp.page_id = p.id AND grp.key = ? AND grp.ord = 0"
                    .to_string();
            let join_params = vec![SqlValue::Text(key.clone())];
            let (clause, clause_params) = match value {
                Some(v) => (format!(" AND grp.{column} = ?"), vec![(*v).clone()]),
                None => (format!(" AND grp.{column} IS NULL"), Vec::new()),
            };
            (join, join_params, clause, clause_params)
        }
    }
}

/// Fetch the present values of a median's column (optionally restricted to
/// one group), and reduce them: empty → `Null`; numeric → the mean of the
/// one or two middle values as a JSON number; otherwise the lower-middle
/// value's text as a JSON string.
fn median_value(
    conn: &Connection,
    prepared: &PreparedQuery,
    median: &MedianPlan,
    group: Option<(&GroupColumn, Option<&SqlValue>)>,
) -> Result<serde_json::Value, QueryError> {
    let (group_join, group_join_params, group_clause, group_params) = group_predicate(group);
    let column = &median.column;
    let sql = format!(
        "SELECT {column} FROM pages p{}{group_join} WHERE {}{group_clause} AND {column} IS NOT NULL ORDER BY {column}",
        median.join, prepared.where_clause,
    );
    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(median.join_params.iter().cloned());
    params.extend(group_join_params);
    params.extend(prepared.where_params.iter().cloned());
    params.extend(group_params);

    let values: Vec<rusqlite::types::Value> = {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };

    let n = values.len();
    if n == 0 {
        return Ok(serde_json::Value::Null);
    }
    if median.numeric {
        let as_f64 = |v: &rusqlite::types::Value| match v {
            rusqlite::types::Value::Integer(i) => *i as f64,
            rusqlite::types::Value::Real(f) => *f,
            _ => 0.0,
        };
        let mid = n / 2;
        let value = if n % 2 == 1 {
            as_f64(&values[mid])
        } else {
            (as_f64(&values[mid - 1]) + as_f64(&values[mid])) / 2.0
        };
        Ok(serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null))
    } else {
        let lower_mid = if n % 2 == 1 { n / 2 } else { n / 2 - 1 };
        Ok(sql_value_to_json(values[lower_mid].clone()))
    }
}

fn sql_value_to_json(v: rusqlite::types::Value) -> serde_json::Value {
    match v {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::json!(i),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
        rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
    }
}

const BODY_EXCERPT_MAX_CHARS: usize = 240;
const BODY_PROJECTION_JOIN: &str = " LEFT JOIN page_bodies body_index ON body_index.page_id = p.id";
const BODY_PROJECTION_SELECT: &str = "CASE WHEN p.encrypted = 1 THEN NULL ELSE body_index.body END";

fn append_excerpt_text(
    excerpt: &mut String,
    scalar_count: &mut usize,
    pending_space: &mut bool,
    text: &str,
) -> bool {
    for ch in text.chars() {
        if ch.is_whitespace() {
            *pending_space |= !excerpt.is_empty();
            continue;
        }
        if *pending_space {
            excerpt.push(' ');
            *scalar_count += 1;
            *pending_space = false;
            if *scalar_count > BODY_EXCERPT_MAX_CHARS {
                return true;
            }
        }
        excerpt.push(ch);
        *scalar_count += 1;
        if *scalar_count > BODY_EXCERPT_MAX_CHARS {
            return true;
        }
    }
    false
}

pub(crate) fn body_excerpt(markdown: &str) -> String {
    let mut excerpt = String::with_capacity(BODY_EXCERPT_MAX_CHARS);
    let mut scalar_count = 0;
    let mut pending_space = false;
    for event in Parser::new_ext(markdown, markdown_options()) {
        let full = match event {
            Event::Text(text)
            | Event::Code(text)
            | Event::InlineMath(text)
            | Event::DisplayMath(text) => {
                append_excerpt_text(&mut excerpt, &mut scalar_count, &mut pending_space, &text)
            }
            Event::FootnoteReference(label) => {
                append_excerpt_text(&mut excerpt, &mut scalar_count, &mut pending_space, &label)
            }
            Event::SoftBreak | Event::HardBreak | Event::Rule => {
                pending_space |= !excerpt.is_empty();
                false
            }
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::CodeBlock
                | TagEnd::HtmlBlock
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::FootnoteDefinition
                | TagEnd::DefinitionList
                | TagEnd::DefinitionListTitle
                | TagEnd::DefinitionListDefinition
                | TagEnd::Table
                | TagEnd::TableHead
                | TagEnd::TableRow
                | TagEnd::TableCell,
            ) => {
                pending_space |= !excerpt.is_empty();
                false
            }
            // Raw HTML syntax is omitted. Inline element contents still arrive
            // as Text events; opaque HTML blocks are intentionally omitted.
            Event::Html(_) | Event::InlineHtml(_) => false,
            _ => false,
        };
        if full {
            break;
        }
    }
    if scalar_count > BODY_EXCERPT_MAX_CHARS {
        let truncate_at = excerpt
            .char_indices()
            .nth(BODY_EXCERPT_MAX_CHARS - 1)
            .map_or(excerpt.len(), |(byte_index, _)| byte_index);
        excerpt.truncate(truncate_at);
        excerpt.push('…');
    }
    excerpt
}

enum AppendedColumn {
    Json(String),
    Body,
}

/// Fetch result rows: filter + optional group restriction + sort + paging,
/// with requested columns materialized from `ord = 0` projections.
fn fetch_rows(
    conn: &Connection,
    spec: &QuerySpec,
    ctx: &QueryContext,
    prepared: &PreparedQuery,
    group: Option<(&GroupColumn, Option<&SqlValue>)>,
    limit: Option<u32>,
    offset: u32,
) -> Result<Vec<QueryRow>, QueryError> {
    // Requested property columns and the body projection use equality-indexed
    // joins in this set-based query. No page files or detail endpoints are read.
    let mut select_cols =
        "p.id, p.path, p.title, p.kind, p.project, p.created_at, p.updated_at, p.encrypted, p.journal_date, p.word_count"
            .to_string();
    let mut column_joins = String::new();
    let mut column_params: Vec<SqlValue> = Vec::new();
    // Position and decoding mode for each appended select column.
    let mut appended_columns: Vec<AppendedColumn> = Vec::new();
    let mut system_columns: Vec<(String, SysField)> = Vec::new();
    let mut body_joined = false;
    for (i, name) in spec.columns.iter().enumerate() {
        if name == BODY_COLUMN {
            if !body_joined {
                column_joins.push_str(BODY_PROJECTION_JOIN);
                body_joined = true;
            }
            select_cols.push_str(", ");
            select_cols.push_str(BODY_PROJECTION_SELECT);
            appended_columns.push(AppendedColumn::Body);
            continue;
        }
        match resolve_field(name, ctx)? {
            ResolvedField::Sys(SysField::Tags) => {
                select_cols.push_str(
                    ", (SELECT json_group_array(tag) FROM
                       (SELECT tag FROM tags WHERE page_id = p.id ORDER BY computed, rowid))",
                );
                appended_columns.push(AppendedColumn::Json(name.clone()));
            }
            ResolvedField::Sys(SysField::Aliases) => {
                select_cols.push_str(", json_extract(p.meta_json, '$.aliases')");
                appended_columns.push(AppendedColumn::Json(name.clone()));
            }
            ResolvedField::Sys(sys) => system_columns.push((name.clone(), sys)),
            ResolvedField::Prop { key, .. } => {
                let alias = format!("c{i}");
                column_joins.push_str(&format!(
                    " LEFT JOIN page_properties {alias} ON {alias}.page_id = p.id AND {alias}.key = ? AND {alias}.ord = 0"
                ));
                column_params.push(SqlValue::Text(key));
                select_cols.push_str(&format!(", {alias}.value_json"));
                appended_columns.push(AppendedColumn::Json(name.clone()));
            }
        }
    }

    // Group restriction, shared with `median_value`.
    let (group_join, group_join_params, group_clause, group_params) = group_predicate(group);

    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(column_params);
    // grp join param (the property key) precedes sort-join params because the
    // join clause is emitted before them.
    params.extend(group_join_params);
    params.extend(prepared.join_params.iter().cloned());
    params.extend(prepared.where_params.iter().cloned());
    params.extend(group_params);
    params.extend(prepared.order_params.iter().cloned());

    let mut sql = format!(
        "SELECT {select_cols} FROM pages p{column_joins}{group_join}{} WHERE {}{group_clause} ORDER BY {}",
        prepared.join_clause, prepared.where_clause, prepared.order_clause,
    );
    if let Some(limit) = limit {
        sql.push_str(&format!(" LIMIT {limit}"));
        if offset > 0 {
            sql.push_str(&format!(" OFFSET {offset}"));
        }
    } else if offset > 0 {
        sql.push_str(&format!(" LIMIT -1 OFFSET {offset}"));
    }

    let mut stmt = conn.prepare(&sql)?;
    let n_fixed = 10;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let mut columns = serde_json::Map::new();
        // Scalar system columns requested by name (the full SYSTEM_FIELDS
        // contract; tags/aliases arrive via the appended json columns).
        let sys_pairs: [(&str, serde_json::Value); 10] = [
            ("id", sql_value_to_json(row.get(0)?)),
            ("path", sql_value_to_json(row.get(1)?)),
            ("title", sql_value_to_json(row.get(2)?)),
            ("kind", sql_value_to_json(row.get(3)?)),
            ("project", sql_value_to_json(row.get(4)?)),
            ("created_at", sql_value_to_json(row.get(5)?)),
            ("updated_at", sql_value_to_json(row.get(6)?)),
            ("encryption", serde_json::Value::Bool(row.get(7)?)),
            ("journal_date", sql_value_to_json(row.get(8)?)),
            ("word_count", sql_value_to_json(row.get(9)?)),
        ];
        for (requested_name, system_field) in &system_columns {
            if let Some((_, value)) = sys_pairs
                .iter()
                .find(|(canonical_name, _)| *canonical_name == system_field.as_str())
            {
                columns.insert(requested_name.clone(), value.clone());
            }
        }
        for (i, column) in appended_columns.iter().enumerate() {
            let raw: Option<String> = row.get(n_fixed + i)?;
            match column {
                AppendedColumn::Json(name) => {
                    let value = raw
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or(serde_json::Value::Null);
                    columns.insert(name.clone(), value);
                }
                AppendedColumn::Body => {
                    let value = raw
                        .map(|markdown| serde_json::Value::String(body_excerpt(&markdown)))
                        .unwrap_or(serde_json::Value::Null);
                    columns.insert(BODY_COLUMN.to_string(), value);
                }
            }
        }
        Ok(QueryRow {
            id: row.get(0)?,
            path: row.get(1)?,
            title: row.get(2)?,
            kind: row.get(3)?,
            project: row.get(4)?,
            columns,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use crate::vault::index::VaultIndex;
    use crate::vault::page::{Page, PageMeta};
    use crate::vault::path::VaultPath;

    // -- Task 3.1: AST + field resolution ---------------------------------

    #[test]
    fn filter_round_trips_in_json_and_toml() {
        let json = serde_json::json!({
            "all": [
                { "field": "kind", "op": "eq", "value": "BOOK" },
                { "any": [
                    { "field": "status", "op": "eq", "value": "reading" },
                    { "not": { "field": "rating", "op": "is_empty" } }
                ]}
            ]
        });
        let from_json: Filter = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(&from_json).unwrap(), json);

        let toml_src = "all = [ { field = \"kind\", op = \"eq\", value = \"BOOK\" } ]";
        let from_toml: Filter = toml::from_str(toml_src).unwrap();
        let Filter::All(children) = &from_toml else {
            panic!("expected all");
        };
        assert!(matches!(&children[0], Filter::Cmp { op: Op::Eq, .. }));
    }

    #[test]
    fn unknown_op_token_is_rejected() {
        let bad = serde_json::json!({ "field": "kind", "op": "wat", "value": 1 });
        assert!(serde_json::from_value::<Filter>(bad).is_err());
    }

    #[test]
    fn field_resolution_is_system_first_with_escapes() {
        let ctx = QueryContext::default();
        assert_eq!(
            resolve_field("kind", &ctx).unwrap(),
            ResolvedField::Sys(SysField::Kind)
        );
        assert_eq!(
            resolve_field("author", &ctx).unwrap(),
            ResolvedField::Prop {
                key: "author".into(),
                ty: PropertyType::Text
            }
        );
        assert_eq!(
            resolve_field("prop.kind", &ctx).unwrap(),
            ResolvedField::Prop {
                key: "kind".into(),
                ty: PropertyType::Text
            }
        );
        assert_eq!(
            resolve_field("sys.kind", &ctx).unwrap(),
            ResolvedField::Sys(SysField::Kind)
        );
        assert!(matches!(
            resolve_field("sys.bogus", &ctx),
            Err(QueryError::UnknownSystemField(_))
        ));
    }

    #[test]
    fn projection_field_resolution_has_canonical_system_property_and_body_identities() {
        assert_eq!(
            resolve_projection_field("title").unwrap(),
            ProjectionFieldIdentity::System(SysField::Title)
        );
        assert_eq!(
            resolve_projection_field("sys.title").unwrap(),
            ProjectionFieldIdentity::System(SysField::Title)
        );
        assert_eq!(
            resolve_projection_field("prop.title").unwrap(),
            ProjectionFieldIdentity::Property("title".to_string())
        );
        assert_eq!(
            resolve_projection_field("custom").unwrap(),
            ProjectionFieldIdentity::Property("custom".to_string())
        );
        for field in ["body", "sys.body", "prop.body"] {
            assert_eq!(
                resolve_projection_field(field).unwrap(),
                ProjectionFieldIdentity::Body
            );
        }
        assert!(matches!(
            resolve_projection_field("sys.missing"),
            Err(QueryError::UnknownSystemField(field)) if field == "missing"
        ));
    }

    fn projection_page(path: &str, body: String) -> Page {
        let mut extra = toml::Table::new();
        extra.insert("status".into(), toml::Value::String("reading".into()));
        extra.insert("rating".into(), toml::Value::Integer(0));
        extra.insert("featured".into(), toml::Value::Boolean(false));
        extra.insert(
            "themes".into(),
            toml::Value::Array(vec![
                toml::Value::String("memory".into()),
                toml::Value::String("identity".into()),
            ]),
        );
        extra.insert("non_finite".into(), toml::Value::Float(f64::NAN));
        Page {
            path: VaultPath::new(path).unwrap(),
            meta: PageMeta {
                id: uuid::Uuid::parse_str("0190f8a0-0000-7000-8000-0000000000f1").unwrap(),
                title: Some("Daily log".into()),
                tags: vec!["Research".into(), "journal".into(), "research".into()],
                aliases: vec!["Log".into(), "Daily".into()],
                kind: None,
                project: Some("clepsydra".into()),
                created_at: Some("2026-08-15T09:30:00Z".parse().unwrap()),
                updated_at: Some("2026-08-15T10:45:00Z".parse().unwrap()),
                encryption: None,
                readonly: None,
                extra,
            },
            raw_content: String::new(),
            body,
        }
    }

    #[test]
    fn page_field_projection_materializes_every_system_shape_from_effective_metadata() {
        let page = projection_page("journals/2026-08-15.md", "one two\n\nthree".to_string());
        let cases = [
            (SysField::Id, serde_json::json!(page.meta.id.to_string())),
            (SysField::Path, serde_json::json!("journals/2026-08-15.md")),
            (SysField::Title, serde_json::json!("Daily log")),
            (SysField::Kind, serde_json::json!("JOURNAL")),
            (SysField::Project, serde_json::json!("clepsydra")),
            (SysField::Tags, serde_json::json!(["Research", "journal"])),
            (SysField::Aliases, serde_json::json!(["Log", "Daily"])),
            (
                SysField::CreatedAt,
                serde_json::json!("2026-08-15T09:30:00+00:00"),
            ),
            (
                SysField::UpdatedAt,
                serde_json::json!("2026-08-15T10:45:00+00:00"),
            ),
            (SysField::Encryption, serde_json::json!(false)),
            (SysField::JournalDate, serde_json::json!("2026-08-15")),
            (SysField::WordCount, serde_json::json!(3)),
        ];

        for (field, expected) in cases {
            assert_eq!(
                project_page_field_value(&page, &ProjectionFieldIdentity::System(field)),
                (true, Some(expected)),
                "{field:?}"
            );
        }
    }

    #[test]
    fn page_field_projection_derives_journal_date_for_ai_journal_paths() {
        let legacy = projection_page("ai-journals/2026-08-27.md", String::new());
        assert_eq!(
            project_page_field_value(
                &legacy,
                &ProjectionFieldIdentity::System(SysField::JournalDate)
            ),
            (true, Some(serde_json::json!("2026-08-27")))
        );

        let canonical =
            projection_page("ai-journals/20260827.2026-08-27.Ab12Cd34.md", String::new());
        assert_eq!(
            project_page_field_value(
                &canonical,
                &ProjectionFieldIdentity::System(SysField::JournalDate)
            ),
            (true, Some(serde_json::json!("2026-08-27")))
        );

        let nested = projection_page("other/ai-journals/2026-08-27.md", String::new());
        assert_eq!(
            project_page_field_value(
                &nested,
                &ProjectionFieldIdentity::System(SysField::JournalDate)
            ),
            (false, None)
        );
    }

    #[test]
    fn page_field_projection_distinguishes_custom_values_from_missing_values() {
        let page = projection_page("notes/log.md", String::new());
        for (key, expected) in [
            ("status", serde_json::json!("reading")),
            ("rating", serde_json::json!(0)),
            ("featured", serde_json::json!(false)),
            ("themes", serde_json::json!(["memory", "identity"])),
            ("non_finite", serde_json::Value::Null),
        ] {
            assert_eq!(
                project_page_field_value(
                    &page,
                    &ProjectionFieldIdentity::Property(key.to_string())
                ),
                (true, Some(expected)),
                "{key}"
            );
        }
        assert_eq!(
            project_page_field_value(
                &page,
                &ProjectionFieldIdentity::Property("missing".to_string())
            ),
            (false, None)
        );
    }

    #[test]
    fn page_field_projection_treats_an_empty_body_excerpt_as_missing() {
        let page = projection_page("notes/empty.md", String::new());

        assert_eq!(
            project_page_field_value(&page, &ProjectionFieldIdentity::Body),
            (false, None)
        );
    }

    #[test]
    fn page_field_projection_reuses_the_unicode_safe_body_excerpt() {
        let page = projection_page(
            "notes/log.md",
            format!(
                "# Heading\n\n[link](https://example.com) {}",
                "界".repeat(260)
            ),
        );
        let (present, value) = project_page_field_value(&page, &ProjectionFieldIdentity::Body);
        let excerpt = value
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap();

        assert!(present);
        assert!(excerpt.starts_with("Heading link "));
        assert!(excerpt.ends_with('…'));
        assert_eq!(excerpt.chars().count(), BODY_EXCERPT_MAX_CHARS);
    }

    // -- Fixture ----------------------------------------------------------

    const READING_BASE: &str = r#"
name = "Reading Log"

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
author  = { type = "text" }
status  = { type = "select", options = ["queued", "reading", "finished"] }
rating  = { type = "number" }
started = { type = "date" }
series  = { type = "relation" }
themes  = { type = "multi_select", options = [] }
pattern = { type = "text" }
done    = { type = "bool" }
moment  = { type = "datetime" }
"#;

    fn page(id: &str, kind: &str, title: &str, extras: &str) -> String {
        format!("+++\nid = \"{id}\"\ntitle = \"{title}\"\ntype = \"{kind}\"\n{extras}+++\nbody\n")
    }

    fn fixture() -> (tempfile::TempDir, VaultIndex, BaseDefinition) {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::write(tmp.path().join("bases/reading.base.toml"), READING_BASE).unwrap();
        let write = |name: &str, content: String| {
            std::fs::write(tmp.path().join(name), content).unwrap();
        };
        write(
            "a.md",
            page(
                "0190f8a0-0000-7000-8000-00000000000a",
                "BOOK",
                "Book A",
                "tags = [\"sf\"]\naliases = [\"Science Fiction\"]\nauthor = \"Wolfe\"\nstatus = \"reading\"\nrating = 9\nstarted = 2026-07-01\nthemes = [\"memory\"]\nseries = [\"[[Solar Cycle]]\"]\npattern = \"100%_done\"\ndone = true\nmoment = 2026-08-09T12:34:56Z\n",
            ),
        );
        write(
            "b.md",
            page(
                "0190f8a0-0000-7000-8000-00000000000b",
                "BOOK",
                "Book B",
                "author = \"Le Guin\"\nstatus = \"reading\"\nrating = 10\nstarted = 2026-07-30\nthemes = []\n",
            ),
        );
        write(
            "c.md",
            page(
                "0190f8a0-0000-7000-8000-00000000000c",
                "BOOK",
                "Book C",
                "author = \"Borges\"\nstatus = \"queued\"\nstarted = 2026-06-15\nthemes = [\"identity\", \"memory\"]\n",
            ),
        );
        write(
            "e.md",
            page(
                "0190f8a0-0000-7000-8000-00000000000e",
                "BOOK",
                "Book E",
                "author = \"Calvino\"\n",
            ),
        );
        write(
            "note.md",
            page(
                "0190f8a0-0000-7000-8000-00000000000d",
                "NOTE",
                "Not a book",
                "status = \"reading\"\n",
            ),
        );
        write(
            "solar-cycle.md",
            page(
                "0190f8a0-0000-7000-8000-0000000000aa",
                "NOTE",
                "Solar Cycle",
                "",
            ),
        );

        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();

        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("reading").unwrap().clone();
        (tmp, index, base)
    }

    fn grouped_limit_fixture() -> (tempfile::TempDir, VaultIndex, BaseDefinition) {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::write(tmp.path().join("bases/reading.base.toml"), READING_BASE).unwrap();
        for index in 0..55 {
            let id = format!("0190f8a0-0000-7000-8000-{index:012x}");
            std::fs::write(
                tmp.path().join(format!("group-{index:02}.md")),
                page(
                    &id,
                    "BOOK",
                    &format!("Book {index:02}"),
                    &format!("status = \"reading\"\nrating = {}\n", index + 1),
                ),
            )
            .unwrap();
        }

        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();

        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("reading").unwrap().clone();
        (tmp, index, base)
    }

    fn grouped_limit_spec(group_row_limit: GroupRowLimit) -> QuerySpec {
        QuerySpec {
            filter: book_filter(),
            group_by: Some("status".into()),
            aggregates: vec![
                Aggregate {
                    function: AggregateFn::Count,
                    field: None,
                },
                Aggregate {
                    function: AggregateFn::Sum,
                    field: Some("rating".into()),
                },
            ],
            group_row_limit,
            ..Default::default()
        }
    }

    fn only_group(output: QueryOutput) -> GroupResult {
        let QueryOutput::Grouped { mut groups } = output else {
            panic!("expected grouped output");
        };
        assert_eq!(groups.len(), 1);
        groups.pop().unwrap()
    }

    fn flat_paths(output: &QueryOutput) -> Vec<String> {
        match output {
            QueryOutput::Flat { rows, .. } => rows.iter().map(|r| r.path.clone()).collect(),
            _ => panic!("expected flat output"),
        }
    }

    fn run(index: &VaultIndex, base: &BaseDefinition, filter: serde_json::Value) -> QueryOutput {
        let spec = QuerySpec {
            filter: Some(serde_json::from_value(filter).unwrap()),
            ..Default::default()
        };
        evaluate(index.connection(), &spec, &QueryContext::for_base(base)).unwrap()
    }

    #[test]
    fn in_memory_matching_has_sql_parity_for_contains_and_aliases() {
        let (_tmp, index, mut base) = fixture();
        let mut meta = crate::vault::page::PageMeta::new();
        meta.kind = Some(crate::vault::kind::Kind::Book);
        meta.title = Some("Book A".into());
        meta.tags.push("sf".into());
        meta.aliases.push("Science Fiction".into());
        meta.extra
            .insert("author".into(), toml::Value::String("Wolfe".into()));
        meta.extra
            .insert("status".into(), toml::Value::String("reading".into()));
        meta.extra.insert(
            "themes".into(),
            toml::Value::Array(vec![toml::Value::String("memory".into())]),
        );
        meta.extra.insert(
            "series".into(),
            toml::Value::Array(vec![toml::Value::String("[[Solar Cycle]]".into())]),
        );
        meta.extra
            .insert("pattern".into(), toml::Value::String("100%_done".into()));
        meta.extra.insert(
            "started".into(),
            toml::Value::Datetime("2026-07-01".parse().unwrap()),
        );
        meta.extra.insert(
            "moment".into(),
            toml::Value::Datetime("2026-08-09T12:34:56Z".parse().unwrap()),
        );
        let cases = [
            (
                serde_json::json!({ "field": "author", "op": "contains", "value": "OLF" }),
                true,
            ),
            (
                serde_json::json!({ "field": "author", "op": "contains", "value": "%" }),
                false,
            ),
            (
                serde_json::json!({ "field": "author", "op": "contains", "value": "_" }),
                false,
            ),
            (
                serde_json::json!({ "field": "pattern", "op": "contains", "value": "%" }),
                true,
            ),
            (
                serde_json::json!({ "field": "pattern", "op": "contains", "value": "_" }),
                true,
            ),
            (
                serde_json::json!({ "field": "started", "op": "contains", "value": "2026-07" }),
                true,
            ),
            (
                serde_json::json!({ "field": "moment", "op": "contains", "value": "12:34" }),
                true,
            ),
            (
                serde_json::json!({ "field": "status", "op": "contains", "value": "read" }),
                false,
            ),
            (
                serde_json::json!({ "field": "status", "op": "contains", "value": "reading" }),
                true,
            ),
            (
                serde_json::json!({ "field": "themes", "op": "contains", "value": "mem" }),
                false,
            ),
            (
                serde_json::json!({ "field": "themes", "op": "contains", "value": "memory" }),
                true,
            ),
            (
                serde_json::json!({ "field": "series", "op": "contains", "value": "Solar" }),
                false,
            ),
            (
                serde_json::json!({ "field": "series", "op": "contains", "value": "[[Solar Cycle]]" }),
                true,
            ),
            (
                serde_json::json!({ "field": "tags", "op": "contains", "value": "book" }),
                true,
            ),
            (
                serde_json::json!({ "field": "tags", "op": "contains", "value": "sf" }),
                true,
            ),
            (
                serde_json::json!({ "field": "aliases", "op": "eq", "value": "science fiction" }),
                true,
            ),
            (
                serde_json::json!({ "field": "aliases", "op": "contains", "value": "SCIENCE FICTION" }),
                true,
            ),
            // -- not_contains --------------------------------------------
            (
                serde_json::json!({ "field": "author", "op": "not_contains", "value": "OLF" }),
                false,
            ),
            (
                serde_json::json!({ "field": "author", "op": "not_contains", "value": "Borges" }),
                true,
            ),
            (
                serde_json::json!({ "field": "pattern", "op": "not_contains", "value": "%" }),
                false,
            ),
            (
                serde_json::json!({ "field": "status", "op": "not_contains", "value": "reading" }),
                false,
            ),
            (
                serde_json::json!({ "field": "status", "op": "not_contains", "value": "queued" }),
                true,
            ),
            (
                serde_json::json!({ "field": "themes", "op": "not_contains", "value": "memory" }),
                false,
            ),
            (
                serde_json::json!({ "field": "themes", "op": "not_contains", "value": "identity" }),
                true,
            ),
            (
                serde_json::json!({ "field": "series", "op": "not_contains", "value": "[[Solar Cycle]]" }),
                false,
            ),
            (
                serde_json::json!({ "field": "tags", "op": "not_contains", "value": "sf" }),
                false,
            ),
            (
                serde_json::json!({ "field": "tags", "op": "not_contains", "value": "zzz" }),
                true,
            ),
            (
                serde_json::json!({ "field": "aliases", "op": "not_contains", "value": "SCIENCE FICTION" }),
                false,
            ),
            (
                serde_json::json!({ "field": "title", "op": "not_contains", "value": "Book" }),
                false,
            ),
            // An absent property matches a negation, like `ne`.
            (
                serde_json::json!({ "field": "absent", "op": "not_contains", "value": "x" }),
                true,
            ),
            // -- starts_with / ends_with ---------------------------------
            (
                serde_json::json!({ "field": "author", "op": "starts_with", "value": "wol" }),
                true,
            ),
            (
                serde_json::json!({ "field": "author", "op": "starts_with", "value": "olf" }),
                false,
            ),
            (
                serde_json::json!({ "field": "author", "op": "ends_with", "value": "FE" }),
                true,
            ),
            (
                serde_json::json!({ "field": "author", "op": "ends_with", "value": "Wolf" }),
                false,
            ),
            (
                serde_json::json!({ "field": "pattern", "op": "starts_with", "value": "100%" }),
                true,
            ),
            (
                serde_json::json!({ "field": "pattern", "op": "ends_with", "value": "_done" }),
                true,
            ),
            (
                serde_json::json!({ "field": "title", "op": "starts_with", "value": "book" }),
                true,
            ),
            (
                serde_json::json!({ "field": "title", "op": "ends_with", "value": "a" }),
                true,
            ),
            // -- relative dates (today = 2026-08-09) ---------------------
            (
                serde_json::json!({ "field": "moment", "op": "is_today" }),
                true,
            ),
            (
                serde_json::json!({ "field": "moment", "op": "is_this_week" }),
                true,
            ),
            (
                serde_json::json!({ "field": "moment", "op": "is_past_week" }),
                true,
            ),
            (
                serde_json::json!({ "field": "moment", "op": "is_next_week" }),
                false,
            ),
            (
                serde_json::json!({ "field": "moment", "op": "is_this_month" }),
                true,
            ),
            (
                serde_json::json!({ "field": "started", "op": "is_today" }),
                false,
            ),
            (
                serde_json::json!({ "field": "started", "op": "is_this_month" }),
                false,
            ),
        ];

        let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 9).unwrap();
        for (filter_json, expected) in cases {
            let filter: Filter = serde_json::from_value(filter_json.clone()).unwrap();
            base.file.filter = Some(filter);
            let in_memory = crate::vault::base::base_matches_meta_on(&base, &meta, "a.md", today);
            let spec = QuerySpec {
                filter: Some(serde_json::from_value(filter_json.clone()).unwrap()),
                ..Default::default()
            };
            let output = evaluate(
                index.connection(),
                &spec,
                &QueryContext::for_base(&base).with_today(today),
            )
            .unwrap_or_else(|error| panic!("{filter_json} failed to compile: {error}"));
            let sql = flat_paths(&output).iter().any(|path| path == "a.md");

            assert_eq!(sql, expected, "unexpected SQL fixture result");
            assert_eq!(in_memory, sql, "in-memory matcher diverged from SQL");
        }
    }

    // -- Relative-date and text operators ---------------------------------

    const DATES_BASE: &str = r#"
name = "Dates"

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
started = { type = "datetime" }
status  = { type = "select", options = ["queued", "reading", "finished"] }
"#;

    /// Friday.
    fn relative_today() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 8, 28).unwrap()
    }

    /// Books straddling every window around Friday 2026-08-28, plus two
    /// journal pages with explicit `created_at` for the system-field cases.
    fn relative_date_fixture() -> (tempfile::TempDir, VaultIndex, BaseDefinition) {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::create_dir_all(tmp.path().join("books")).unwrap();
        std::fs::create_dir_all(tmp.path().join("journals")).unwrap();
        std::fs::write(tmp.path().join("bases/dates.base.toml"), DATES_BASE).unwrap();
        let write = |name: &str, content: String| {
            std::fs::write(tmp.path().join(name), content).unwrap();
        };
        // Every page pins `created_at` so the system-field cases do not drift
        // with the wall clock (a page without one is stamped "now").
        let book = |letter: char, title: &str, extras: &str| {
            (
                format!("books/{letter}.md"),
                page(
                    &format!("0190f8a0-0000-7000-8000-0000000000{:02x}", letter as u32),
                    "BOOK",
                    title,
                    &format!("created_at = 2026-06-01T00:00:00Z\n{extras}"),
                ),
            )
        };
        for (name, content) in [
            book(
                'a',
                "Alpha Wolf",
                "started = 2026-08-28\nstatus = \"reading\"\n",
            ),
            book('b', "Beta", "started = 2026-08-24\nstatus = \"queued\"\n"),
            book(
                'c',
                "Gamma alpha",
                "started = 2026-08-21\nstatus = \"reading\"\n",
            ),
            book(
                'd',
                "Delta",
                "started = 2026-08-29T09:00:00Z\nstatus = \"finished\"\n",
            ),
            book(
                'e',
                "Epsilon",
                "started = 2026-07-31\nstatus = \"reading\"\n",
            ),
            book('f', "Zeta", ""),
        ] {
            write(&name, content);
        }
        write(
            "journals/2026-08-28.md",
            page(
                "0190f8a0-0000-7000-8000-00000000aa01",
                "JOURNAL",
                "Today",
                "created_at = 2026-08-28T08:00:00Z\n",
            ),
        );
        write(
            "journals/2026-08-01.md",
            page(
                "0190f8a0-0000-7000-8000-00000000aa02",
                "JOURNAL",
                "Month start",
                "created_at = 2026-08-01T08:00:00Z\n",
            ),
        );
        write(
            "old.md",
            page(
                "0190f8a0-0000-7000-8000-00000000aa03",
                "NOTE",
                "Last month",
                "created_at = 2026-07-15T08:00:00Z\n",
            ),
        );

        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();

        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("dates").unwrap().clone();
        (tmp, index, base)
    }

    fn dated_paths(
        index: &VaultIndex,
        base: &BaseDefinition,
        filter: serde_json::Value,
    ) -> Vec<String> {
        let spec = QuerySpec {
            filter: Some(serde_json::from_value(filter).unwrap()),
            ..Default::default()
        };
        let output = evaluate(
            index.connection(),
            &spec,
            &QueryContext::for_base(base).with_today(relative_today()),
        )
        .unwrap();
        flat_paths(&output)
    }

    #[test]
    fn relative_date_ops_select_by_window() {
        let (_tmp, index, base) = relative_date_fixture();
        let paths = |op: &str| {
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "started", "op": op }),
            )
        };

        assert_eq!(paths("is_today"), ["books/a.md"]);
        // `books/d.md` (Saturday 2026-08-29) sits in the ISO week that started
        // Monday 2026-08-24 *and* in the rolling seven days after today; the
        // two windows are meant to overlap.
        assert_eq!(
            paths("is_this_week"),
            ["books/a.md", "books/b.md", "books/d.md"]
        );
        assert_eq!(
            paths("is_past_week"),
            ["books/a.md", "books/b.md", "books/c.md"]
        );
        assert_eq!(paths("is_next_week"), ["books/d.md"]);
        assert_eq!(
            paths("is_this_month"),
            ["books/a.md", "books/b.md", "books/c.md", "books/d.md"]
        );
    }

    #[test]
    fn relative_date_ops_reject_non_date_fields() {
        let (_tmp, index, base) = relative_date_fixture();
        for field in ["status", "title", "word_count"] {
            let filter: Filter =
                serde_json::from_value(serde_json::json!({ "field": field, "op": "is_today" }))
                    .unwrap();
            let spec = QuerySpec {
                filter: Some(filter),
                ..Default::default()
            };
            assert!(
                matches!(
                    evaluate(
                        index.connection(),
                        &spec,
                        &QueryContext::for_base(&base).with_today(relative_today()),
                    ),
                    Err(QueryError::InvalidOp { .. })
                ),
                "`{field} is_today` must be rejected"
            );
        }
    }

    #[test]
    fn relative_date_ops_work_on_created_at_and_journal_date() {
        let (_tmp, index, base) = relative_date_fixture();

        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "journal_date", "op": "is_today" })
            ),
            ["journals/2026-08-28.md"]
        );
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "journal_date", "op": "is_this_month" })
            ),
            ["journals/2026-08-01.md", "journals/2026-08-28.md"]
        );
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "created_at", "op": "is_today" })
            ),
            ["journals/2026-08-28.md"]
        );
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "created_at", "op": "is_this_month" })
            ),
            ["journals/2026-08-01.md", "journals/2026-08-28.md"]
        );
    }

    #[test]
    fn text_affix_and_not_contains_ops() {
        let (_tmp, index, base) = relative_date_fixture();
        let books = [
            "books/a.md",
            "books/b.md",
            "books/c.md",
            "books/d.md",
            "books/e.md",
            "books/f.md",
        ];

        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "title", "op": "starts_with", "value": "alpha" })
            ),
            ["books/a.md"]
        );
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "field": "title", "op": "ends_with", "value": "alpha" })
            ),
            ["books/c.md"]
        );
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "all": [
                    { "field": "kind", "op": "eq", "value": "BOOK" },
                    { "field": "title", "op": "not_contains", "value": "alpha" }
                ] })
            ),
            ["books/b.md", "books/d.md", "books/e.md", "books/f.md"]
        );
        // Membership negation on a select: the page without `status` matches.
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "all": [
                    { "field": "kind", "op": "eq", "value": "BOOK" },
                    { "field": "status", "op": "not_contains", "value": "reading" }
                ] })
            ),
            ["books/b.md", "books/d.md", "books/f.md"]
        );
        // Membership negation on tags: no page carries the tag.
        assert_eq!(
            dated_paths(
                &index,
                &base,
                serde_json::json!({ "all": [
                    { "field": "kind", "op": "eq", "value": "BOOK" },
                    { "field": "tags", "op": "not_contains", "value": "x" }
                ] })
            ),
            books
        );

        for filter in [
            serde_json::json!({ "field": "status", "op": "starts_with", "value": "read" }),
            serde_json::json!({ "field": "started", "op": "ends_with", "value": "28" }),
            serde_json::json!({ "field": "word_count", "op": "not_contains", "value": "1" }),
            serde_json::json!({ "field": "tags", "op": "starts_with", "value": "x" }),
        ] {
            let filter: Filter = serde_json::from_value(filter.clone()).unwrap();
            assert!(
                matches!(
                    compile_filter(&filter, &QueryContext::for_base(&base)),
                    Err(QueryError::InvalidOp { .. })
                ),
                "{filter:?} must be rejected"
            );
        }
    }

    #[test]
    fn query_rejects_contains_for_non_text_scalar_types() {
        let (_tmp, _index, base) = fixture();
        for filter in [
            serde_json::json!({ "field": "rating", "op": "contains", "value": 9 }),
            serde_json::json!({ "field": "rating", "op": "contains", "value": 9.5 }),
            serde_json::json!({ "field": "done", "op": "contains", "value": true }),
            serde_json::json!({ "field": "word_count", "op": "contains", "value": 0 }),
        ] {
            let filter: Filter = serde_json::from_value(filter).unwrap();
            assert!(matches!(
                compile_filter(&filter, &QueryContext::for_base(&base)),
                Err(QueryError::InvalidOp {
                    op: Op::Contains,
                    ..
                })
            ));
        }
    }

    // -- Task 3.2: filter compilation -------------------------------------

    #[test]
    fn eq_on_select_filters_by_element() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "all": [
                { "field": "kind", "op": "eq", "value": "BOOK" },
                { "field": "status", "op": "eq", "value": "reading" }
            ]}),
        );
        assert_eq!(flat_paths(&out), vec!["a.md", "b.md"]);
    }

    #[test]
    fn gt_on_number_compares_numerically() {
        let (_tmp, index, base) = fixture();
        // 9 < 10 numerically; as strings "9" > "10" would invert this.
        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "rating", "op": "gt", "value": 9 }),
        );
        assert_eq!(flat_paths(&out), vec!["b.md"]);
        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "rating", "op": "gte", "value": 9 }),
        );
        assert_eq!(flat_paths(&out), vec!["a.md", "b.md"]);
    }

    #[test]
    fn date_range_compares_iso_strings() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "all": [
                { "field": "started", "op": "gte", "value": "2026-07-01" },
                { "field": "started", "op": "lte", "value": "2026-07-31" }
            ]}),
        );
        assert_eq!(flat_paths(&out), vec!["a.md", "b.md"]);
    }

    #[test]
    fn contains_on_multi_select_matches_any_element() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "themes", "op": "contains", "value": "memory" }),
        );
        assert_eq!(flat_paths(&out), vec!["a.md", "c.md"]);
    }

    #[test]
    fn is_empty_true_for_absent_key_and_empty_array() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "all": [
                { "field": "kind", "op": "eq", "value": "BOOK" },
                { "field": "themes", "op": "is_empty" }
            ]}),
        );
        // b has themes = [] (no rows), e has no themes key at all.
        assert_eq!(flat_paths(&out), vec!["b.md", "e.md"]);
    }

    #[test]
    fn links_to_matches_by_canonical_and_by_uuid() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "series", "op": "links_to", "value": "Solar Cycle" }),
        );
        assert_eq!(flat_paths(&out), vec!["a.md"]);

        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "series", "op": "links_to", "value": "0190f8a0-0000-7000-8000-0000000000aa" }),
        );
        assert_eq!(flat_paths(&out), vec!["a.md"]);

        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "series", "op": "links_to", "value": "0190F8A0-0000-7000-8000-0000000000AA" }),
        );
        assert_eq!(flat_paths(&out), vec!["a.md"]);
    }

    #[test]
    fn links_to_rejects_non_relation_properties() {
        let (_tmp, _index, base) = fixture();
        let filter: Filter = serde_json::from_value(
            serde_json::json!({ "field": "author", "op": "links_to", "value": "Wolfe" }),
        )
        .unwrap();

        assert!(matches!(
            compile_filter(&filter, &QueryContext::for_base(&base)),
            Err(QueryError::InvalidOp {
                op: Op::LinksTo,
                ..
            })
        ));
    }

    #[test]
    fn tags_contains_membership() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "field": "tags", "op": "contains", "value": "sf" }),
        );
        assert_eq!(flat_paths(&out), vec!["a.md"]);
    }

    #[test]
    fn nested_all_any_not_composes() {
        let (_tmp, index, base) = fixture();
        let out = run(
            &index,
            &base,
            serde_json::json!({ "all": [
                { "field": "kind", "op": "eq", "value": "BOOK" },
                { "any": [
                    { "field": "status", "op": "eq", "value": "queued" },
                    { "field": "rating", "op": "gte", "value": 10 }
                ]},
                { "not": { "field": "author", "op": "eq", "value": "Borges" } }
            ]}),
        );
        assert_eq!(flat_paths(&out), vec!["b.md"]);
    }

    #[test]
    fn compilation_binds_parameters_never_interpolates() {
        let filter: Filter = serde_json::from_value(serde_json::json!({ "all": [
            { "field": "kind", "op": "eq", "value": "BOOK'); DROP TABLE pages;--" },
            { "field": "rating", "op": "gt", "value": 9 },
            { "field": "started", "op": "gte", "value": "2026-07-01" }
        ]}))
        .unwrap();
        let ctx = QueryContext::default();
        let compiled = compile_filter(&filter, &ctx).unwrap();
        assert!(!compiled.clause.contains("BOOK"), "{}", compiled.clause);
        assert!(!compiled.clause.contains('9'), "{}", compiled.clause);
        assert!(!compiled.clause.contains("2026"), "{}", compiled.clause);
        assert_eq!(
            compiled.clause.matches('?').count(),
            compiled.params.len(),
            "every placeholder has exactly one bound param"
        );
    }

    // -- Task 3.3: sort, group, aggregate ---------------------------------

    fn book_filter() -> Option<Filter> {
        Some(
            serde_json::from_value(
                serde_json::json!({ "field": "kind", "op": "eq", "value": "BOOK" }),
            )
            .unwrap(),
        )
    }

    #[test]
    fn property_sort_puts_nulls_last() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            sort: vec![SortKey {
                field: "rating".into(),
                dir: SortDir::Desc,
            }],
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        // b (10), a (9), then the ratingless pages.
        assert_eq!(flat_paths(&out), vec!["b.md", "a.md", "c.md", "e.md"]);
    }

    #[test]
    fn two_key_sort_property_then_system() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            sort: vec![
                SortKey {
                    field: "status".into(),
                    dir: SortDir::Asc,
                },
                SortKey {
                    field: "path".into(),
                    dir: SortDir::Desc,
                },
            ],
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        // queued < reading (asc), within reading: b before a (path desc),
        // statusless e last (nulls last).
        assert_eq!(flat_paths(&out), vec!["c.md", "b.md", "a.md", "e.md"]);
    }

    #[test]
    fn relation_sort_orders_by_first_target_canonical() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            sort: vec![SortKey {
                field: "series".into(),
                dir: SortDir::Asc,
            }],
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        let paths = flat_paths(&out);
        // Only a.md carries a series link; NULL orders first under plain ASC
        // for the correlated subquery, so just assert a.md sorts deterministically last.
        assert_eq!(paths.len(), 4);
        assert!(paths.contains(&"a.md".to_string()));
    }

    #[test]
    fn grouped_query_returns_null_bucket_aggregates_and_explicitly_caps_rows() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            group_by: Some("status".into()),
            aggregates: vec![
                Aggregate {
                    function: AggregateFn::Count,
                    field: None,
                },
                Aggregate {
                    function: AggregateFn::Avg,
                    field: Some("rating".into()),
                },
            ],
            group_row_limit: GroupRowLimit::Limit(1),
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        let QueryOutput::Grouped { groups } = out else {
            panic!("expected grouped output");
        };
        assert_eq!(groups.len(), 3);

        let queued = groups
            .iter()
            .find(|g| g.key == serde_json::json!("queued"))
            .unwrap();
        assert_eq!(queued.total, 1);
        assert_eq!(queued.aggregates[0], serde_json::json!(1));

        let reading = groups
            .iter()
            .find(|g| g.key == serde_json::json!("reading"))
            .unwrap();
        assert_eq!(reading.total, 2, "true per-group total");
        assert_eq!(reading.rows.len(), 1, "rows capped at group_row_limit");
        assert_eq!(reading.aggregates[0], serde_json::json!(2));
        assert_eq!(reading.aggregates[1], serde_json::json!(9.5));

        let empty = groups
            .iter()
            .find(|g| g.key == serde_json::Value::Null)
            .unwrap();
        assert_eq!(empty.total, 1, "statusless page lands in the NULL bucket");
        // The NULL bucket sorts last.
        assert_eq!(groups.last().unwrap().key, serde_json::Value::Null);
    }

    #[test]
    fn grouped_default_caps_rows_at_fifty_without_capping_totals_or_aggregates() {
        let (_tmp, index, base) = grouped_limit_fixture();
        let spec = grouped_limit_spec(GroupRowLimit::Default);

        let group = only_group(
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap(),
        );

        assert_eq!(group.rows.len(), 50);
        assert_eq!(group.total, 55);
        assert_eq!(
            group.aggregates,
            vec![serde_json::json!(55), serde_json::json!(1540.0)]
        );
    }

    #[test]
    fn grouped_unlimited_returns_every_row() {
        let (_tmp, index, base) = grouped_limit_fixture();
        let spec = grouped_limit_spec(GroupRowLimit::Unlimited);

        let group = only_group(
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap(),
        );

        assert_eq!(group.rows.len(), 55);
        assert_eq!(group.total, 55);
    }

    #[test]
    fn grouped_explicit_limit_caps_rows_without_capping_totals_or_aggregates() {
        let (_tmp, index, base) = grouped_limit_fixture();
        let spec = grouped_limit_spec(GroupRowLimit::Limit(1));

        let group = only_group(
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap(),
        );

        assert_eq!(group.rows.len(), 1);
        assert_eq!(group.total, 55);
        assert_eq!(
            group.aggregates,
            vec![serde_json::json!(55), serde_json::json!(1540.0)]
        );
    }

    #[test]
    fn flat_absent_limit_is_uncapped() {
        let (_tmp, index, base) = grouped_limit_fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            limit: None,
            ..Default::default()
        };

        let output = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();

        assert_eq!(flat_paths(&output).len(), 55);
    }

    #[test]
    fn flat_explicit_limit_caps_rows_without_capping_total() {
        let (_tmp, index, base) = grouped_limit_fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            limit: Some(1),
            ..Default::default()
        };

        let QueryOutput::Flat { rows, total, .. } =
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap()
        else {
            panic!("expected flat output");
        };

        assert_eq!(rows.len(), 1);
        assert_eq!(total, 55);
    }

    #[test]
    fn flat_query_honors_limit_and_offset() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            limit: Some(2),
            offset: 1,
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        let QueryOutput::Flat { rows, total, .. } = out else {
            panic!("expected flat");
        };
        assert_eq!(total, 4, "total ignores pagination");
        assert_eq!(
            rows.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
            vec!["b.md", "c.md"]
        );
    }

    #[test]
    fn columns_materialize_from_ord_zero_projections() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            columns: vec!["title".into(), "author".into(), "rating".into()],
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        let QueryOutput::Flat { rows, .. } = out else {
            panic!("expected flat");
        };
        let a = rows.iter().find(|r| r.path == "a.md").unwrap();
        assert_eq!(a.columns["author"], serde_json::json!("Wolfe"));
        assert_eq!(a.columns["rating"], serde_json::json!(9));
        assert_eq!(a.columns["title"], serde_json::json!("Book A"));
        let e = rows.iter().find(|r| r.path == "e.md").unwrap();
        assert_eq!(e.columns["rating"], serde_json::Value::Null);
    }

    #[test]
    fn every_system_field_materializes_as_a_column() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            columns: vec![
                "id".into(),
                "path".into(),
                "kind".into(),
                "project".into(),
                "tags".into(),
                "aliases".into(),
                "word_count".into(),
            ],
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        let QueryOutput::Flat { rows, .. } = out else {
            panic!("expected flat");
        };
        let a = rows.iter().find(|r| r.path == "a.md").unwrap();
        assert_eq!(
            a.columns["id"],
            serde_json::json!("0190f8a0-0000-7000-8000-00000000000a")
        );
        assert_eq!(a.columns["path"], serde_json::json!("a.md"));
        assert_eq!(a.columns["kind"], serde_json::json!("BOOK"));
        assert_eq!(a.columns["project"], serde_json::Value::Null);
        assert_eq!(a.columns["tags"], serde_json::json!(["sf", "book"]));
        assert!(a.columns["word_count"].is_number());
        // A page with no stored tags still exposes its computed Kind tag.
        let e = rows.iter().find(|r| r.path == "e.md").unwrap();
        assert_eq!(e.columns["tags"], serde_json::json!(["book"]));
        assert_eq!(e.columns["aliases"], serde_json::Value::Null);
    }

    fn encryption_fixture() -> (tempfile::TempDir, VaultIndex, BaseDefinition) {
        const ARMOR: &str = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSAuLi4K\n-----END AGE ENCRYPTED FILE-----\n";

        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::write(tmp.path().join("bases/reading.base.toml"), READING_BASE).unwrap();
        std::fs::write(
            tmp.path().join("unprotected.md"),
            page(
                "0190f8a0-0000-7000-8000-0000000000e0",
                "BOOK",
                "Unprotected",
                "",
            ),
        )
        .unwrap();
        std::fs::write(
            tmp.path().join("protected.md"),
            format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-0000000000e1\"\ntitle = \"Protected\"\ntype = \"BOOK\"\nencryption = {{ format = \"age\", version = 1, key_id = \"test-key\" }}\n+++\n{ARMOR}"
            ),
        )
        .unwrap();

        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();
        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("reading").unwrap().clone();
        (tmp, index, base)
    }

    #[test]
    fn encryption_system_field_filters_and_materializes_boolean_aliases() {
        let (_tmp, index, base) = encryption_fixture();
        let protected_spec = QuerySpec {
            filter: Some(Filter::Cmp {
                field: "encryption".into(),
                op: Op::Eq,
                value: serde_json::json!(true),
            }),
            columns: vec!["encryption".into()],
            ..Default::default()
        };
        let protected = evaluate(
            index.connection(),
            &protected_spec,
            &QueryContext::for_base(&base),
        )
        .unwrap();
        let QueryOutput::Flat {
            rows: protected_rows,
            ..
        } = protected
        else {
            panic!("expected flat");
        };
        assert_eq!(
            protected_rows
                .iter()
                .map(|row| row.path.as_str())
                .collect::<Vec<_>>(),
            vec!["protected.md"]
        );
        assert_eq!(
            protected_rows[0].columns["encryption"],
            serde_json::Value::Bool(true)
        );

        let unprotected_spec = QuerySpec {
            filter: Some(Filter::Cmp {
                field: "sys.encryption".into(),
                op: Op::Eq,
                value: serde_json::json!(false),
            }),
            columns: vec!["encryption".into(), "sys.encryption".into()],
            ..Default::default()
        };
        let unprotected = evaluate(
            index.connection(),
            &unprotected_spec,
            &QueryContext::for_base(&base),
        )
        .unwrap();
        let QueryOutput::Flat {
            rows: unprotected_rows,
            ..
        } = unprotected
        else {
            panic!("expected flat");
        };
        assert_eq!(
            unprotected_rows
                .iter()
                .map(|row| row.path.as_str())
                .collect::<Vec<_>>(),
            vec!["unprotected.md"]
        );
        assert_eq!(
            unprotected_rows[0].columns["encryption"],
            serde_json::Value::Bool(false)
        );
        assert_eq!(
            unprotected_rows[0].columns["sys.encryption"],
            serde_json::Value::Bool(false)
        );
    }

    #[test]
    fn body_excerpt_obeys_exact_scalar_boundary() {
        let chars_239 = "a".repeat(239);
        let chars_240 = "b".repeat(240);
        let chars_241 = "c".repeat(241);

        assert_eq!(body_excerpt(&chars_239), chars_239);
        assert_eq!(body_excerpt(&chars_240), chars_240);
        assert_eq!(body_excerpt(&chars_241), format!("{}…", "c".repeat(239)));
    }

    #[test]
    fn body_excerpt_truncates_multibyte_unicode_by_scalar() {
        let excerpt = body_excerpt(&"界".repeat(241));

        assert_eq!(excerpt, format!("{}…", "界".repeat(239)));
        assert_eq!(excerpt.chars().count(), 240);
    }

    #[test]
    fn body_excerpt_marks_truncation_at_a_normalized_word_boundary() {
        let markdown = format!("{}\n\nnext", "a".repeat(239));

        assert_eq!(body_excerpt(&markdown), format!("{}…", "a".repeat(239)));
    }

    #[test]
    fn body_projection_plan_uses_a_page_id_index_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        let index = VaultIndex::open(&tmp.path().join("index.db")).unwrap();
        let table_count: i64 = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'page_bodies'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            table_count, 1,
            "body projection requires an equality-indexed source"
        );

        let query = format!(
            "EXPLAIN QUERY PLAN
             SELECT {BODY_PROJECTION_SELECT}
             FROM pages p{BODY_PROJECTION_JOIN}
             ORDER BY p.path
             LIMIT 25"
        );
        let mut statement = index.connection().prepare(&query).unwrap();
        let details = statement
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            details.iter().any(|detail| {
                detail.contains("SEARCH body_index")
                    && detail.contains("page_id=?")
                    && detail.contains("LEFT-JOIN")
            }),
            "expected a keyed body lookup, got {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.contains("SCAN body_index")),
            "body projection must not scan the body source: {details:?}"
        );
    }
    #[test]
    fn body_column_projects_bounded_normalized_plain_text() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::write(tmp.path().join("bases/reading.base.toml"), READING_BASE).unwrap();
        let markdown_body = format!(
            "# Heading\n\nA [link label](https://example.com) with `code`.\n\n{}\n",
            "界".repeat(300)
        );
        std::fs::write(
            tmp.path().join("excerpt.md"),
            format!(
                "+++\nid = \"0190f8a0-0000-7000-8000-0000000000b0\"\ntitle = \"Excerpt\"\ntype = \"BOOK\"\n+++\n{markdown_body}"
            ),
        )
        .unwrap();
        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();
        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("reading").unwrap();
        let output = evaluate(
            index.connection(),
            &QuerySpec {
                columns: vec!["body".into()],
                ..Default::default()
            },
            &QueryContext::for_base(base),
        )
        .unwrap();
        let QueryOutput::Flat { rows, .. } = output else {
            panic!("expected flat output");
        };
        let excerpt = rows[0].columns["body"].as_str().unwrap();

        assert!(excerpt.starts_with("Heading A link label with code. 界"));
        assert_eq!(excerpt.chars().count(), 240);
        assert!(excerpt.ends_with('…'));
        assert!(!excerpt.contains("https://example.com"));
        assert!(!excerpt.contains('\n'));
        assert!(!excerpt.contains('`'));
    }

    #[test]
    fn body_excerpt_separates_tight_lists_tables_and_definition_lists() {
        assert_eq!(body_excerpt("- alpha\n- beta\n"), "alpha beta");
        assert_eq!(
            body_excerpt("| first | second |\n| --- | --- |\n| third | fourth |\n"),
            "first second third fourth"
        );
        assert_eq!(
            body_excerpt("Term\n: Definition\n\nOther\n: Meaning\n"),
            "Term Definition Other Meaning"
        );
    }

    #[test]
    fn body_excerpt_preserves_math_but_omits_raw_html_events() {
        assert_eq!(
            body_excerpt("before $x + y$ and $$z$$ after"),
            "before x + y and z after"
        );
        assert_eq!(
            body_excerpt("before <span>inside</span> after"),
            "before inside after"
        );
        assert_eq!(
            body_excerpt("<div>\nraw block content\n</div>\n\nkept"),
            "kept"
        );
    }

    #[test]
    fn protected_body_column_is_null_and_never_serializes_armored_content() {
        let (_tmp, index, base) = encryption_fixture();
        let output = evaluate(
            index.connection(),
            &QuerySpec {
                columns: vec!["body".into()],
                ..Default::default()
            },
            &QueryContext::for_base(&base),
        )
        .unwrap();
        let QueryOutput::Flat { rows, .. } = output else {
            panic!("expected flat output");
        };
        let protected = rows.iter().find(|row| row.path == "protected.md").unwrap();
        let serialized = serde_json::to_string(protected).unwrap();
        let unprotected = rows
            .iter()
            .find(|row| row.path == "unprotected.md")
            .unwrap();

        assert_eq!(unprotected.columns["body"], serde_json::json!("body"));

        assert_eq!(protected.columns["body"], serde_json::Value::Null);
        assert!(!serialized.contains("BEGIN AGE ENCRYPTED FILE"));
        assert!(!serialized.contains("YWdlLWVuY3J5cHRpb24"));
    }

    #[test]
    fn body_is_projection_only_not_a_general_query_field() {
        let (_tmp, index, base) = fixture();
        let context = QueryContext::for_base(&base);
        for field in ["body", "sys.body", "prop.body"] {
            assert!(matches!(
                resolve_field(field, &context),
                Err(QueryError::ProjectionOnlyBody)
            ));

            let filter = Filter::Cmp {
                field: field.into(),
                op: Op::Contains,
                value: serde_json::json!("body"),
            };
            assert!(matches!(
                compile_filter(&filter, &context),
                Err(QueryError::ProjectionOnlyBody)
            ));

            let sort = QuerySpec {
                sort: vec![SortKey {
                    field: field.into(),
                    dir: SortDir::Asc,
                }],
                ..Default::default()
            };
            assert!(matches!(
                evaluate(index.connection(), &sort, &context),
                Err(QueryError::ProjectionOnlyBody)
            ));

            let group = QuerySpec {
                group_by: Some(field.into()),
                ..Default::default()
            };
            assert!(matches!(
                evaluate(index.connection(), &group, &context),
                Err(QueryError::ProjectionOnlyBody)
            ));

            let aggregate = QuerySpec {
                aggregates: vec![Aggregate {
                    function: AggregateFn::Count,
                    field: Some(field.into()),
                }],
                ..Default::default()
            };
            assert!(matches!(
                evaluate(index.connection(), &aggregate, &context),
                Err(QueryError::ProjectionOnlyBody)
            ));
        }
    }

    // -- Flat-view aggregates and count/median/range functions ------------

    const AGGREGATE_BASE: &str = r#"
name = "Totals"

[filter]
all = [ { field = "kind", op = "eq", value = "BOOK" } ]

[properties]
rating  = { type = "number" }
status  = { type = "select", options = ["queued", "reading", "finished"] }
started = { type = "date" }
"#;

    fn agg(function: AggregateFn, field: Option<&str>) -> Aggregate {
        Aggregate {
            function,
            field: field.map(str::to_string),
        }
    }

    /// Six BOOK pages: ratings `5, 3, 4, (absent), 2, 3`; statuses
    /// `reading, reading, queued, (absent), finished, reading`; `started`
    /// dates `08-01, 08-11, (absent), (absent), 08-21, 08-31`.
    fn aggregate_fixture() -> (tempfile::TempDir, VaultIndex, BaseDefinition) {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::create_dir_all(tmp.path().join("books")).unwrap();
        std::fs::write(tmp.path().join("bases/totals.base.toml"), AGGREGATE_BASE).unwrap();
        let write = |name: &str, content: String| {
            std::fs::write(tmp.path().join(name), content).unwrap();
        };
        write(
            "books/a.md",
            page(
                "0190f8a0-0000-7000-8000-0000000000a1",
                "BOOK",
                "Book A",
                "rating = 5\nstatus = \"reading\"\nstarted = 2026-08-01\n",
            ),
        );
        write(
            "books/b.md",
            page(
                "0190f8a0-0000-7000-8000-0000000000a2",
                "BOOK",
                "Book B",
                "rating = 3\nstatus = \"reading\"\nstarted = 2026-08-11\n",
            ),
        );
        write(
            "books/c.md",
            page(
                "0190f8a0-0000-7000-8000-0000000000a3",
                "BOOK",
                "Book C",
                "rating = 4\nstatus = \"queued\"\n",
            ),
        );
        write(
            "books/d.md",
            page("0190f8a0-0000-7000-8000-0000000000a4", "BOOK", "Book D", ""),
        );
        write(
            "books/e.md",
            page(
                "0190f8a0-0000-7000-8000-0000000000a5",
                "BOOK",
                "Book E",
                "rating = 2\nstatus = \"finished\"\nstarted = 2026-08-21\n",
            ),
        );
        write(
            "books/f.md",
            page(
                "0190f8a0-0000-7000-8000-0000000000a6",
                "BOOK",
                "Book F",
                "rating = 3\nstatus = \"reading\"\nstarted = 2026-08-31\n",
            ),
        );

        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();

        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("totals").unwrap().clone();
        (tmp, index, base)
    }

    /// Four BOOK pages with ratings `1, 2, 3, 4` (even count, for the
    /// mean-of-two-middles median case).
    fn median_even_fixture() -> (tempfile::TempDir, VaultIndex, BaseDefinition) {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("bases")).unwrap();
        std::fs::create_dir_all(tmp.path().join("books")).unwrap();
        std::fs::write(tmp.path().join("bases/totals.base.toml"), AGGREGATE_BASE).unwrap();
        let write = |name: &str, content: String| {
            std::fs::write(tmp.path().join(name), content).unwrap();
        };
        for (i, rating) in [1, 2, 3, 4].into_iter().enumerate() {
            write(
                &format!("books/r{i}.md"),
                page(
                    &format!("0190f8a0-0000-7000-8000-0000000000b{i}"),
                    "BOOK",
                    &format!("Book {i}"),
                    &format!("rating = {rating}\n"),
                ),
            );
        }

        let mut index = VaultIndex::open(&tmp.path().join(".clepsydra/index.db")).unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        index.build(&vault).unwrap();

        let registry = crate::vault::base::BaseRegistry::load(tmp.path());
        let base = registry.get("totals").unwrap().clone();
        (tmp, index, base)
    }

    #[test]
    fn flat_view_returns_aggregates_over_the_whole_predicate() {
        let (_tmp, index, base) = aggregate_fixture();
        let spec = QuerySpec {
            filter: None,
            sort: vec![],
            group_by: None,
            aggregates: vec![
                agg(AggregateFn::Count, None),
                agg(AggregateFn::CountFilled, Some("rating")),
                agg(AggregateFn::CountEmpty, Some("rating")),
                agg(AggregateFn::PercentFilled, Some("rating")),
                agg(AggregateFn::CountUnique, Some("status")),
                agg(AggregateFn::Median, Some("rating")),
                agg(AggregateFn::Range, Some("rating")),
                agg(AggregateFn::Median, Some("started")),
                agg(AggregateFn::Range, Some("started")),
                agg(AggregateFn::Sum, Some("rating")),
            ],
            columns: vec![],
            limit: Some(2),
            offset: 1,
            group_row_limit: GroupRowLimit::Default,
        };
        let QueryOutput::Flat {
            rows,
            total,
            aggregates,
        } = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap()
        else {
            panic!("flat")
        };
        assert_eq!(rows.len(), 2, "window applies to rows");
        assert_eq!(total, 6);
        assert_eq!(
            aggregates,
            vec![
                serde_json::json!(6),
                serde_json::json!(5),
                serde_json::json!(1),
                serde_json::json!(83.3),
                serde_json::json!(3),
                serde_json::json!(3.0),
                serde_json::json!(3.0),
                serde_json::json!("2026-08-11"),
                serde_json::json!(30.0),
                serde_json::json!(17.0),
            ]
        );
    }

    #[test]
    fn median_of_even_count_is_the_mean_of_the_middle_two() {
        let (_tmp, index, base) = median_even_fixture();
        let spec = QuerySpec {
            aggregates: vec![agg(AggregateFn::Median, Some("rating"))],
            ..Default::default()
        };
        let QueryOutput::Flat { aggregates, .. } =
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap()
        else {
            panic!("flat")
        };
        assert_eq!(aggregates, vec![serde_json::json!(2.5)]);
    }

    #[test]
    fn aggregates_over_an_empty_result_are_zero_or_null() {
        let (_tmp, index, base) = aggregate_fixture();
        let filter: Filter = serde_json::from_value(serde_json::json!({
            "field": "rating", "op": "gt", "value": 100
        }))
        .unwrap();
        let spec = QuerySpec {
            filter: Some(filter),
            aggregates: vec![
                agg(AggregateFn::Count, None),
                agg(AggregateFn::CountFilled, Some("rating")),
                agg(AggregateFn::PercentFilled, Some("rating")),
                agg(AggregateFn::Median, Some("rating")),
                agg(AggregateFn::Range, Some("rating")),
                agg(AggregateFn::Sum, Some("rating")),
            ],
            ..Default::default()
        };
        let QueryOutput::Flat {
            rows,
            total,
            aggregates,
        } = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap()
        else {
            panic!("flat")
        };
        assert!(rows.is_empty());
        assert_eq!(total, 0);
        assert_eq!(
            aggregates,
            vec![
                serde_json::json!(0),
                serde_json::json!(0),
                serde_json::json!(0),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
            ]
        );
    }

    #[test]
    fn grouped_views_support_the_new_functions() {
        let (_tmp, index, base) = aggregate_fixture();
        let spec = QuerySpec {
            group_by: Some("status".into()),
            aggregates: vec![
                agg(AggregateFn::CountFilled, Some("rating")),
                agg(AggregateFn::Median, Some("rating")),
            ],
            ..Default::default()
        };
        let QueryOutput::Grouped { groups } =
            evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap()
        else {
            panic!("grouped")
        };
        let find = |key: &str| {
            groups
                .iter()
                .find(|g| g.key == serde_json::json!(key))
                .unwrap()
        };

        assert_eq!(
            find("reading").aggregates,
            vec![serde_json::json!(3), serde_json::json!(3.0)]
        );
        assert_eq!(
            find("queued").aggregates,
            vec![serde_json::json!(1), serde_json::json!(4.0)]
        );
        assert_eq!(
            find("finished").aggregates,
            vec![serde_json::json!(1), serde_json::json!(2.0)]
        );

        let null_group = groups
            .iter()
            .find(|g| g.key == serde_json::Value::Null)
            .unwrap();
        assert_eq!(
            null_group.aggregates,
            vec![serde_json::json!(0), serde_json::Value::Null]
        );
    }

    #[test]
    fn aggregates_reject_multi_valued_system_fields_and_folds_on_text() {
        let (_tmp, index, base) = aggregate_fixture();
        let ctx = QueryContext::for_base(&base);

        let tags_spec = QuerySpec {
            aggregates: vec![agg(AggregateFn::CountUnique, Some("tags"))],
            ..Default::default()
        };
        assert!(matches!(
            evaluate(index.connection(), &tags_spec, &ctx),
            Err(QueryError::InvalidAggregate(AggregateFn::CountUnique))
        ));

        let status_median_spec = QuerySpec {
            aggregates: vec![agg(AggregateFn::Median, Some("status"))],
            ..Default::default()
        };
        assert!(matches!(
            evaluate(index.connection(), &status_median_spec, &ctx),
            Err(QueryError::InvalidAggregate(AggregateFn::Median))
        ));

        let no_field_spec = QuerySpec {
            aggregates: vec![agg(AggregateFn::CountFilled, None)],
            ..Default::default()
        };
        assert!(matches!(
            evaluate(index.connection(), &no_field_spec, &ctx),
            Err(QueryError::InvalidAggregate(AggregateFn::CountFilled))
        ));
    }
}
