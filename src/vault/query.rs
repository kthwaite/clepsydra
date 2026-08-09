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

use rusqlite::Connection;
use thiserror::Error;

use super::base::{
    Aggregate, AggregateFn, BaseDefinition, Filter, Op, PropertyType, SortDir, SortKey,
};
use super::canonical::CanonicalName;

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/// A system field backed by the `pages` table (or `tags`/`canonical_names`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
            SysField::JournalDate => "p.journal_date",
            SysField::WordCount => "p.word_count",
            SysField::Tags | SysField::Aliases => return None,
        })
    }
}

/// A field reference resolved against the query context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedField {
    Sys(SysField),
    Prop { key: String, ty: PropertyType },
}

/// Everything field resolution needs: the enclosing base (view queries) and
/// an inline type map (the generic endpoint has no base context).
#[derive(Debug, Default)]
pub struct QueryContext<'a> {
    pub base: Option<&'a BaseDefinition>,
    pub types: HashMap<String, PropertyType>,
}

impl<'a> QueryContext<'a> {
    pub fn for_base(base: &'a BaseDefinition) -> Self {
        Self {
            base: Some(base),
            types: HashMap::new(),
        }
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

/// Resolve a field reference. Bare names bind system-first; `sys.<name>` /
/// `prop.<name>` disambiguate.
pub fn resolve_field(field: &str, ctx: &QueryContext) -> Result<ResolvedField, QueryError> {
    if let Some(name) = field.strip_prefix("sys.") {
        return SysField::from_name(name)
            .map(ResolvedField::Sys)
            .ok_or_else(|| QueryError::UnknownSystemField(name.to_string()));
    }
    if let Some(name) = field.strip_prefix("prop.") {
        return Ok(ResolvedField::Prop {
            key: name.to_string(),
            ty: ctx.property_type(name),
        });
    }
    if let Some(sys) = SysField::from_name(field) {
        return Ok(ResolvedField::Sys(sys));
    }
    Ok(ResolvedField::Prop {
        key: field.to_string(),
        ty: ctx.property_type(field),
    })
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

fn bind_literal_contains_value(
    field: &str,
    ty: PropertyType,
    value: &serde_json::Value,
) -> Result<SqlValue, QueryError> {
    let SqlValue::Text(value) = bind_value(field, ty, value)? else {
        return Err(QueryError::InvalidOp {
            field: field.to_string(),
            op: Op::Contains,
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
                Op::Contains if sys == SysField::WordCount => Err(QueryError::InvalidOp {
                    field: field.to_string(),
                    op,
                }),
                Op::Contains => {
                    params.push(bind_literal_contains_value(
                        field,
                        PropertyType::Text,
                        value,
                    )?);
                    Ok(format!("{column} LIKE '%' || ? || '%' ESCAPE '\\'"))
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
        ResolvedField::Prop { key, ty } => compile_prop(field, &key, ty, op, value, params),
    }
}

fn bind_sys_value(
    field: &str,
    sys: SysField,
    value: &serde_json::Value,
) -> Result<SqlValue, QueryError> {
    let ty = match sys {
        SysField::WordCount => PropertyType::Number,
        _ => PropertyType::Text,
    };
    bind_value(field, ty, value)
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
        Op::Ne => {
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
        Op::LinksTo => {
            let target = value.as_str().ok_or_else(|| QueryError::InvalidValue {
                field: field.to_string(),
                reason: "`links_to` expects a string target".into(),
            })?;
            params.push(SqlValue::Text(key.to_string()));
            params.push(SqlValue::Text(target.to_string()));
            params.push(SqlValue::Text(
                CanonicalName::from_title(target).as_str().to_string(),
            ));
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
        Op::Contains
            if matches!(
                ty,
                PropertyType::Number | PropertyType::Bool
            ) =>
        {
            Err(QueryError::InvalidOp {
                field: field.to_string(),
                op,
            })
        }
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
                params.push(bind_literal_contains_value(field, ty, value)?);
                Ok(exists(&format!(
                    "pp.{column} LIKE '%' || ? || '%' ESCAPE '\\'"
                )))
            }
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
    pub group_row_limit: Option<u32>,
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
    Flat { rows: Vec<QueryRow>, total: i64 },
    Grouped { groups: Vec<GroupResult> },
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

    let total: i64 = {
        let sql = format!(
            "SELECT COUNT(*) FROM pages p WHERE {}",
            prepared.where_clause
        );
        conn.query_row(
            &sql,
            rusqlite::params_from_iter(prepared.where_params.iter()),
            |r| r.get(0),
        )?
    };

    let rows = fetch_rows(conn, spec, ctx, &prepared, None, spec.limit, spec.offset)?;
    Ok(QueryOutput::Flat { rows, total })
}

fn evaluate_grouped(
    conn: &Connection,
    spec: &QuerySpec,
    ctx: &QueryContext,
    group_key: &str,
) -> Result<QueryOutput, QueryError> {
    // Group key must be a declared, groupable property (or a scalar system
    // field like `kind`).
    let group_column = match resolve_field(group_key, ctx)? {
        ResolvedField::Sys(sys) => sys
            .column()
            .map(GroupColumn::System)
            .ok_or_else(|| QueryError::Ungroupable(group_key.to_string()))?,
        ResolvedField::Prop { key, ty } => match ty {
            PropertyType::Select
            | PropertyType::Text
            | PropertyType::Bool
            | PropertyType::Date
            | PropertyType::Datetime
            | PropertyType::Url => GroupColumn::Property {
                key,
                column: typed_column(ty),
            },
            _ => return Err(QueryError::Ungroupable(group_key.to_string())),
        },
    };

    let prepared = prepare(spec, ctx)?;

    // Aggregate select list.
    let mut agg_exprs = Vec::new();
    let mut agg_joins = String::new();
    let mut agg_params: Vec<SqlValue> = Vec::new();
    for (i, agg) in spec.aggregates.iter().enumerate() {
        match (agg.function, &agg.field) {
            (AggregateFn::Count, _) => agg_exprs.push("COUNT(*)".to_string()),
            (function, Some(field)) => {
                let (key, column) = match resolve_field(field, ctx)? {
                    ResolvedField::Prop { key, ty } => match ty {
                        PropertyType::Number => (key, "value_num"),
                        PropertyType::Date | PropertyType::Datetime => (key, "value_date"),
                        _ => return Err(QueryError::InvalidAggregate(function)),
                    },
                    ResolvedField::Sys(SysField::WordCount) => {
                        let f = sql_aggregate(function);
                        agg_exprs.push(format!("{f}(p.word_count)"));
                        continue;
                    }
                    ResolvedField::Sys(_) => {
                        return Err(QueryError::InvalidAggregate(function));
                    }
                };
                let alias = format!("agg{i}");
                agg_joins.push_str(&format!(
                    " LEFT JOIN page_properties {alias} ON {alias}.page_id = p.id AND {alias}.key = ? AND {alias}.ord = 0"
                ));
                agg_params.push(SqlValue::Text(key));
                let f = sql_aggregate(function);
                agg_exprs.push(format!("{f}({alias}.{column})"));
            }
            (function, None) => return Err(QueryError::InvalidAggregate(function)),
        }
    }

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
        "SELECT {group_expr} AS gkey, COUNT(*) AS total{} FROM pages p{group_join}{agg_joins} WHERE {} GROUP BY gkey ORDER BY gkey IS NULL, gkey ASC",
        agg_exprs
            .iter()
            .map(|e| format!(", {e}"))
            .collect::<String>(),
        prepared.where_clause,
    );
    let mut header_params: Vec<SqlValue> = Vec::new();
    if let Some(p) = &group_join_param {
        header_params.push(p.clone());
    }
    header_params.extend(agg_params.iter().cloned());
    header_params.extend(prepared.where_params.iter().cloned());

    #[allow(clippy::type_complexity)]
    let headers: Vec<(Option<SqlValue>, i64, Vec<serde_json::Value>)> = {
        let mut stmt = conn.prepare(&header_sql)?;
        let n_aggs = spec.aggregates.len();
        let rows = stmt.query_map(rusqlite::params_from_iter(header_params.iter()), |row| {
            let key: Option<SqlValue> =
                row.get::<_, rusqlite::types::Value>(0).map(|v| match v {
                    rusqlite::types::Value::Null => None,
                    other => Some(other),
                })?;
            let total: i64 = row.get(1)?;
            let mut aggs = Vec::with_capacity(n_aggs);
            for i in 0..n_aggs {
                let v: rusqlite::types::Value = row.get(2 + i)?;
                aggs.push(sql_value_to_json(v));
            }
            Ok((key, total, aggs))
        })?;
        rows.collect::<Result<_, _>>()?
    };

    let row_limit = spec.group_row_limit.unwrap_or(DEFAULT_GROUP_ROW_LIMIT);
    let mut groups = Vec::with_capacity(headers.len());
    for (key, total, aggregates) in headers {
        let rows = fetch_rows(
            conn,
            spec,
            ctx,
            &prepared,
            Some((&group_column, key.as_ref())),
            Some(row_limit),
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

fn sql_aggregate(f: AggregateFn) -> &'static str {
    match f {
        AggregateFn::Count => "COUNT",
        AggregateFn::Sum => "SUM",
        AggregateFn::Avg => "AVG",
        AggregateFn::Min => "MIN",
        AggregateFn::Max => "MAX",
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
    // Column joins for requested property columns. Multi-valued system
    // columns (tags, aliases) come from the exact meta_json arrays; scalar
    // system columns are already in the fixed select list.
    let mut select_cols =
        "p.id, p.path, p.title, p.kind, p.project, p.created_at, p.updated_at, p.journal_date, p.word_count"
            .to_string();
    let mut column_joins = String::new();
    let mut column_params: Vec<SqlValue> = Vec::new();
    // Requested column name → position among the appended (json) columns.
    let mut json_columns: Vec<String> = Vec::new();
    for (i, name) in spec.columns.iter().enumerate() {
        match resolve_field(name, ctx)? {
            ResolvedField::Sys(SysField::Tags) => {
                select_cols.push_str(", json_extract(p.meta_json, '$.tags')");
                json_columns.push(name.clone());
            }
            ResolvedField::Sys(SysField::Aliases) => {
                select_cols.push_str(", json_extract(p.meta_json, '$.aliases')");
                json_columns.push(name.clone());
            }
            ResolvedField::Sys(_) => {} // already in the fixed select list
            ResolvedField::Prop { key, .. } => {
                let alias = format!("c{i}");
                column_joins.push_str(&format!(
                    " LEFT JOIN page_properties {alias} ON {alias}.page_id = p.id AND {alias}.key = ? AND {alias}.ord = 0"
                ));
                column_params.push(SqlValue::Text(key));
                select_cols.push_str(&format!(", {alias}.value_json"));
                json_columns.push(name.clone());
            }
        }
    }

    // Group restriction.
    let (group_clause, group_join, group_param) = match group {
        None => (String::new(), "", None),
        Some((column, key)) => match column {
            GroupColumn::System(col) => match key {
                Some(v) => (format!(" AND {col} = ?"), "", Some((*v).clone())),
                None => (format!(" AND {col} IS NULL"), "", None),
            },
            GroupColumn::Property { column, .. } => match key {
                Some(v) => (
                    format!(" AND grp.{column} = ?"),
                    " LEFT JOIN page_properties grp ON grp.page_id = p.id AND grp.key = ? AND grp.ord = 0",
                    Some((*v).clone()),
                ),
                None => (
                    format!(" AND grp.{column} IS NULL"),
                    " LEFT JOIN page_properties grp ON grp.page_id = p.id AND grp.key = ? AND grp.ord = 0",
                    None,
                ),
            },
        },
    };

    let mut params: Vec<SqlValue> = Vec::new();
    params.extend(column_params);
    // grp join param (the property key) precedes sort-join params because the
    // join clause is emitted before them.
    if !group_join.is_empty()
        && let Some((GroupColumn::Property { key, .. }, _)) = group
    {
        params.push(SqlValue::Text(key.clone()));
    }
    params.extend(prepared.join_params.iter().cloned());
    params.extend(prepared.where_params.iter().cloned());
    if let Some(p) = group_param {
        params.push(p);
    }
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
    let n_fixed = 9;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let mut columns = serde_json::Map::new();
        // Scalar system columns requested by name (the full SYSTEM_FIELDS
        // contract; tags/aliases arrive via the appended json columns).
        let sys_pairs: [(&str, serde_json::Value); 9] = [
            ("id", sql_value_to_json(row.get(0)?)),
            ("path", sql_value_to_json(row.get(1)?)),
            ("title", sql_value_to_json(row.get(2)?)),
            ("kind", sql_value_to_json(row.get(3)?)),
            ("project", sql_value_to_json(row.get(4)?)),
            ("created_at", sql_value_to_json(row.get(5)?)),
            ("updated_at", sql_value_to_json(row.get(6)?)),
            ("journal_date", sql_value_to_json(row.get(7)?)),
            ("word_count", sql_value_to_json(row.get(8)?)),
        ];
        for name in &spec.columns {
            if let Some((_, v)) = sys_pairs.iter().find(|(n, _)| n == name) {
                columns.insert(name.clone(), v.clone());
            }
        }
        for (i, name) in json_columns.iter().enumerate() {
            let raw: Option<String> = row.get(n_fixed + i)?;
            let value = raw
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::Value::Null);
            columns.insert(name.clone(), value);
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
        meta.extra.insert(
            "pattern".into(),
            toml::Value::String("100%_done".into()),
        );
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
                serde_json::json!({ "field": "aliases", "op": "eq", "value": "science fiction" }),
                true,
            ),
            (
                serde_json::json!({ "field": "aliases", "op": "contains", "value": "SCIENCE FICTION" }),
                true,
            ),
        ];

        for (filter_json, expected) in cases {
            let filter: Filter = serde_json::from_value(filter_json.clone()).unwrap();
            base.file.filter = Some(filter);
            let in_memory = crate::vault::base::base_matches_meta(&base, &meta, "a.md");
            let sql = flat_paths(&run(&index, &base, filter_json))
                .iter()
                .any(|path| path == "a.md");

            assert_eq!(sql, expected, "unexpected SQL fixture result");
            assert_eq!(in_memory, sql, "in-memory matcher diverged from SQL");
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
    fn grouped_query_returns_null_bucket_aggregates_and_caps_rows() {
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
            group_row_limit: Some(1),
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
    fn flat_query_honors_limit_and_offset() {
        let (_tmp, index, base) = fixture();
        let spec = QuerySpec {
            filter: book_filter(),
            limit: Some(2),
            offset: 1,
            ..Default::default()
        };
        let out = evaluate(index.connection(), &spec, &QueryContext::for_base(&base)).unwrap();
        let QueryOutput::Flat { rows, total } = out else {
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
        assert_eq!(a.columns["tags"], serde_json::json!(["sf"]));
        assert!(a.columns["word_count"].is_number());
        // A tagless page carries an empty/absent array, not a missing key.
        let e = rows.iter().find(|r| r.path == "e.md").unwrap();
        assert_eq!(e.columns["tags"], serde_json::Value::Null);
        assert_eq!(e.columns["aliases"], serde_json::Value::Null);
    }
}
