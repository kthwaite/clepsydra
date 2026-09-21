//! Read-only, bounded snapshots of Base selections as authored Markdown.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, Read, Write};
use std::ops::Range;
use std::path::{Component, Path};

use chrono::NaiveDate;
use clep_vault::page::{Page, parse_frontmatter};
use clep_vault::path::VaultPath;
use clep_vault::toml_json::toml_value_to_json;
use minijinja::{AutoEscape, Environment, UndefinedBehavior, Value, context};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use utoipa::ToSchema;

use crate::base::{Filter, Op, PropertyType, SortKey, ViewDefinition};
use crate::base_document::{self, BaseDocumentError};
use crate::base_embed::{
    EmbedOverrides, GroupOverride, composed_query_spec, validate_embed_overrides,
};
use crate::query::{
    GroupRowLimit, QueryContext, QueryError, QueryOutput, QueryRow, ResolvedField, evaluate,
    resolve_field,
};

/// Budgets apply to one complete render, never to a successful truncated result.
pub const MAX_TEMPLATE_BYTES: usize = 1024 * 1024;
pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ROWS: u32 = 1000;
pub const RENDER_FUEL: u64 = 1_000_000;
pub const RECURSION_LIMIT: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RenderSelection {
    pub base: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<Vec<SortKey>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    pub template: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RenderOutput {
    pub markdown: String,
    pub selected_count: usize,
    pub limit: Option<u32>,
}

#[derive(Debug, Error)]
pub enum RenderError {
    #[error(transparent)]
    Base(#[from] BaseDocumentError),
    #[error("saved view `{0}` was not found")]
    MissingView(String),
    #[error("invalid render selection: {0}")]
    InvalidSelection(String),
    #[error("render resource limit exceeded: {0}")]
    ResourceLimit(&'static str),
    #[error("source cannot be read: {0}")]
    InaccessibleSource(String),
    #[error("source changed; refresh and retry: {0}")]
    SourceChanged(String),
    #[error(transparent)]
    Template(#[from] minijinja::Error),
    #[error(transparent)]
    Query(#[from] QueryError),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("invalid generated output: {0}")]
    InvalidOutput(String),
}

/// Collect one observed snapshot. No files or index records are mutated.
pub fn render_base(
    root: &Path,
    conn: &Connection,
    selection: &RenderSelection,
    destination: &Page,
    template_source: &str,
    today: NaiveDate,
) -> Result<RenderOutput, RenderError> {
    if template_source.len() > MAX_TEMPLATE_BYTES {
        return Err(RenderError::ResourceLimit("template source (1 MiB)"));
    }
    if selection
        .limit
        .is_some_and(|limit| !(1..=MAX_ROWS).contains(&limit))
    {
        return Err(RenderError::InvalidSelection(
            "limit must be between 1 and 1000".into(),
        ));
    }
    let vault = clep_vault::Vault::open(root)
        .map_err(|error| RenderError::Io(io::Error::other(error.to_string())))?;
    let root = vault.root();
    let stored = base_document::load(root, &selection.base)?;
    let base = &stored.definition;
    let empty_view = ViewDefinition {
        name: String::new(),
        labels: BTreeMap::new(),
        layout: "table".into(),
        filter: None,
        sort: Vec::new(),
        group_by: None,
        aggregates: Vec::new(),
        columns: Vec::new(),
    };
    let view = match &selection.view {
        Some(name) => base
            .view(name)
            .ok_or_else(|| RenderError::MissingView(name.clone()))?,
        None => &empty_view,
    };
    validate_embed_overrides(
        base,
        EmbedOverrides {
            filter: selection.filter.as_ref(),
            sort: selection.sort.as_deref(),
            limit: None,
            group_by: view.group_by.as_deref(),
        },
    )
    .map_err(|diagnostics| {
        RenderError::InvalidSelection(
            diagnostics
                .into_iter()
                .map(|diagnostic| diagnostic.message)
                .collect::<Vec<_>>()
                .join("; "),
        )
    })?;
    let mut spec = composed_query_spec(
        base,
        view,
        selection.filter.clone(),
        selection.sort.clone(),
        None,
        Some(GroupOverride::Flat),
    );
    spec.limit = Some(selection.limit.unwrap_or(MAX_ROWS + 1));
    spec.columns.clear();
    spec.aggregates.clear();
    let query_context = QueryContext::for_base(base).with_today(today);
    let QueryOutput::Flat {
        rows: identities, ..
    } = evaluate(conn, &spec, &query_context)?
    else {
        unreachable!("render identity selection is flat")
    };
    if identities.len() > MAX_ROWS as usize {
        return Err(RenderError::ResourceLimit("selected rows (1000)"));
    }

    let mut remaining_input = MAX_INPUT_BYTES - template_source.len();
    charge_input(&mut remaining_input, destination.raw_content.len())?;
    let page = page_context(destination);
    let mut rows = Vec::with_capacity(identities.len());
    for identity in &identities {
        let source = hydrate(&vault, conn, identity, &mut remaining_input)?;
        let mut record = identity_context(&source);
        let body = rebase_body(
            root,
            source.body,
            &identity.path,
            destination.path.as_str(),
            &mut remaining_input,
        )?;
        record.insert("body", Value::from(body));
        rows.push(Value::from(record));
    }
    let selected_count = rows.len();
    let mut groups = Vec::new();
    if let Some(group_by) = &view.group_by {
        // Select globally first. Reuse the evaluator's typed group keys and
        // ordering over this bounded set, never its ordinary table windows.
        spec.filter = Some(Filter::Cmp {
            field: "sys.id".into(),
            op: Op::In,
            value: serde_json::Value::Array(
                identities
                    .iter()
                    .map(|identity| serde_json::Value::String(identity.id.clone()))
                    .collect(),
            ),
        });
        spec.group_by = Some(group_by.clone());
        spec.group_row_limit = GroupRowLimit::Unlimited;
        spec.limit = None;
        let QueryOutput::Grouped {
            groups: selected_groups,
        } = evaluate(conn, &spec, &query_context)?
        else {
            unreachable!("render grouping has a group key")
        };
        let records: HashMap<_, _> = identities
            .iter()
            .zip(&rows)
            .map(|(identity, record)| (identity.id.as_str(), record))
            .collect();
        let boolean_key = matches!(
            resolve_field(group_by, &query_context)?,
            ResolvedField::Prop {
                ty: PropertyType::Bool,
                ..
            }
        );
        for group in selected_groups {
            let key = if boolean_key && !group.key.is_null() {
                serde_json::Value::Bool(group.key.as_i64() == Some(1))
            } else {
                group.key
            };
            let label = match &key {
                serde_json::Value::Null => "(empty)".to_owned(),
                serde_json::Value::String(label) => label.clone(),
                key => key.to_string(),
            };
            let group_rows: Vec<_> = group
                .rows
                .iter()
                .map(|row| records[row.id.as_str()].clone())
                .collect();
            groups.push(context!(key => Value::from_serialize(key), label, rows => group_rows));
        }
    }

    let mut environment = Environment::new();
    environment.set_auto_escape_callback(|_| AutoEscape::None);
    environment.set_undefined_behavior(UndefinedBehavior::Strict);
    environment.set_keep_trailing_newline(true);
    environment.set_fuel(Some(RENDER_FUEL));
    environment.set_recursion_limit(RECURSION_LIMIT);
    let template = environment.template_from_str(template_source)?;
    let mut output = BoundedOutput::default();
    let result = template.render_captured_to(context!(page, rows, groups), &mut output);
    if output.exceeded {
        return Err(RenderError::ResourceLimit("output (4 MiB)"));
    }
    if let Err(error) = result {
        if error.kind() == minijinja::ErrorKind::OutOfFuel {
            return Err(RenderError::ResourceLimit("render fuel (1000000)"));
        }
        if error.kind() == minijinja::ErrorKind::InvalidOperation
            && error.detail() == Some("recursion limit exceeded")
        {
            return Err(RenderError::ResourceLimit("recursion (64)"));
        }
        return Err(RenderError::Template(error));
    }
    let mut markdown = String::from_utf8(output.bytes).expect("MiniJinja writes UTF-8");
    if markdown.contains('\r') {
        markdown = markdown.replace("\r\n", "\n");
    }
    crate::generated_region::ensure_inert_output(&markdown)
        .map_err(|error| RenderError::InvalidOutput(error.to_string()))?;
    Ok(RenderOutput {
        markdown,
        selected_count,
        limit: selection.limit,
    })
}

fn charge_input(remaining: &mut usize, bytes: usize) -> Result<(), RenderError> {
    *remaining = remaining
        .checked_sub(bytes)
        .ok_or(RenderError::ResourceLimit("total input (16 MiB)"))?;
    Ok(())
}

fn hydrate(
    vault: &clep_vault::Vault,
    conn: &Connection,
    identity: &QueryRow,
    remaining: &mut usize,
) -> Result<Page, RenderError> {
    let path = VaultPath::new(&identity.path)
        .map_err(|_| RenderError::InaccessibleSource(identity.path.clone()))?;
    if vault.is_excluded(&path) {
        return Err(RenderError::InaccessibleSource(identity.path.clone()));
    }
    // Do not follow a symlink into unindexed or external content. Verify every
    // component, not just the leaf, before opening the selected source.
    let mut absolute = vault.root().to_path_buf();
    for component in Path::new(path.as_str()).components() {
        let Component::Normal(component) = component else {
            return Err(RenderError::InaccessibleSource(identity.path.clone()));
        };
        absolute.push(component);
        let metadata = std::fs::symlink_metadata(&absolute)
            .map_err(|error| source_read_error(&identity.path, error))?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(RenderError::InaccessibleSource(identity.path.clone()));
        }
    }
    let indexed: Option<(String, bool)> = conn
        .query_row(
            "SELECT content_hash, encrypted FROM pages WHERE id = ?1 AND path = ?2",
            [&identity.id, &identity.path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(QueryError::from)?;
    let Some((expected_hash, encrypted)) = indexed else {
        return Err(RenderError::SourceChanged(identity.path.clone()));
    };
    if encrypted {
        return Err(RenderError::InaccessibleSource(identity.path.clone()));
    }
    let file =
        std::fs::File::open(&absolute).map_err(|error| source_read_error(&identity.path, error))?;
    let mut bytes = Vec::new();
    file.take((*remaining + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| source_read_error(&identity.path, error))?;
    charge_input(remaining, bytes.len())?;
    let raw_content = String::from_utf8(bytes)
        .map_err(|_| RenderError::InaccessibleSource(identity.path.clone()))?;
    if blake3::hash(raw_content.as_bytes()).to_hex().as_str() != expected_hash {
        return Err(RenderError::SourceChanged(identity.path.clone()));
    }
    let (meta, body) = parse_frontmatter(&raw_content)
        .map_err(|_| RenderError::InaccessibleSource(identity.path.clone()))?;
    if meta.encryption.is_some() {
        return Err(RenderError::InaccessibleSource(identity.path.clone()));
    }
    if meta.id.to_string() != identity.id {
        return Err(RenderError::SourceChanged(identity.path.clone()));
    }
    Ok(Page {
        path,
        meta,
        body,
        raw_content,
    })
}

fn source_read_error(path: &str, error: io::Error) -> RenderError {
    if error.kind() == io::ErrorKind::NotFound {
        RenderError::SourceChanged(path.into())
    } else {
        RenderError::InaccessibleSource(path.into())
    }
}

fn identity_context(page: &Page) -> BTreeMap<&'static str, Value> {
    let properties: BTreeMap<_, _> = page
        .meta
        .extra
        .iter()
        .filter(|(key, _)| key.as_str() != clep_vault::conversation::CONVERSATION_META_KEY)
        .map(|(key, value)| {
            (
                key.as_str(),
                Value::from_serialize(toml_value_to_json(value)),
            )
        })
        .collect();
    BTreeMap::from([
        ("id", Value::from(page.meta.id.to_string())),
        ("path", Value::from(page.path.as_str())),
        ("title", Value::from(page.meta.title.as_deref())),
        (
            "kind",
            Value::from(
                clep_vault::kind::resolve(page.path.as_str(), page.meta.kind)
                    .0
                    .as_str(),
            ),
        ),
        ("project", Value::from(page.meta.project.as_deref())),
        ("properties", Value::from(properties)),
    ])
}

fn page_context(page: &Page) -> Value {
    Value::from(identity_context(page))
}

/// Change only destination byte spans. Serializing a Markdown tree would
/// normalize authored whitespace, titles, reference links, and literal code.
fn rebase_body(
    root: &Path,
    body: String,
    source: &str,
    destination: &str,
    remaining: &mut usize,
) -> Result<String, RenderError> {
    let source_url = url::Url::from_file_path(root.join(source))
        .map_err(|_| RenderError::InaccessibleSource(source.into()))?;
    let destination_url = url::Url::from_file_path(root.join(destination))
        .map_err(|_| RenderError::InaccessibleSource(destination.into()))?;
    let parser = Parser::new_ext(&body, Options::ENABLE_WIKILINKS);
    let mut edits = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        if let Some(replacement) =
            rebased_target(&source_url, &destination_url, &definition.dest, false)
        {
            let raw = &body[definition.span.clone()];
            if let Some(start) =
                label_end(raw).and_then(|end| raw[end..].strip_prefix(':').map(|_| end + 1))
                && let Some(span) = destination_span(raw, start)
            {
                edits.push((
                    definition.span.start + span.start..definition.span.start + span.end,
                    replacement,
                ));
            }
        }
    }
    for (event, range) in parser.into_offset_iter() {
        let Event::Start(
            Tag::Link {
                link_type,
                dest_url,
                ..
            }
            | Tag::Image {
                link_type,
                dest_url,
                ..
            },
        ) = event
        else {
            continue;
        };
        let wiki = matches!(link_type, LinkType::WikiLink { .. });
        if !wiki && link_type != LinkType::Inline {
            continue;
        }
        let Some(replacement) = rebased_target(&source_url, &destination_url, &dest_url, wiki)
        else {
            continue;
        };
        let raw = &body[range.clone()];
        let span = if wiki {
            raw.find("[[").map(|start| {
                let start = start + 2;
                let end = raw[start..]
                    .find('|')
                    .map(|offset| start + offset)
                    .unwrap_or(raw.len() - 2);
                start..end
            })
        } else {
            label_end(raw).and_then(|end| {
                raw[end..]
                    .strip_prefix('(')
                    .and_then(|_| destination_span(raw, end + 1))
            })
        };
        if let Some(span) = span {
            edits.push((
                range.start + span.start..range.start + span.end,
                replacement,
            ));
        }
    }
    if edits.is_empty() {
        return Ok(body);
    }
    edits.sort_by_key(|(range, _)| range.start);
    edits.dedup_by(|left, right| left.0 == right.0);
    let removed: usize = edits.iter().map(|(range, _)| range.len()).sum();
    let inserted: usize = edits.iter().map(|(_, replacement)| replacement.len()).sum();
    charge_input(remaining, inserted.saturating_sub(removed))?;
    let mut rebased = String::with_capacity(body.len() - removed + inserted);
    let mut cursor = 0;
    for (range, replacement) in edits {
        rebased.push_str(&body[cursor..range.start]);
        rebased.push_str(&replacement);
        cursor = range.end;
    }
    rebased.push_str(&body[cursor..]);
    Ok(rebased)
}

fn rebased_target(
    source: &url::Url,
    destination: &url::Url,
    target: &str,
    wiki: bool,
) -> Option<String> {
    // Canonical wikilink names are vault identities, not relative filenames.
    if target.starts_with('/')
        || url::Url::parse(target).is_ok()
        || (wiki
            && !target.starts_with("./")
            && !target.starts_with("../")
            && !target.starts_with('#'))
    {
        return None;
    }
    let resolved = source.join(target).ok()?;
    let relative = destination.make_relative(&resolved)?;
    if relative == target {
        return None;
    }
    // Parentheses are legal URL bytes but may terminate a Markdown destination.
    Some(relative.replace('(', "%28").replace(')', "%29"))
}

/// Offset immediately after the outer link/reference label. Inline code and
/// escaped brackets do not alter label nesting.
fn label_end(raw: &str) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut cursor = usize::from(raw.starts_with('!'));
    if bytes.get(cursor) != Some(&b'[') {
        return None;
    }
    let mut depth = 0;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' => cursor += 2,
            b'`' => {
                let start = cursor;
                while bytes.get(cursor) == Some(&b'`') {
                    cursor += 1;
                }
                let fence = &raw[start..cursor];
                if let Some(end) = raw[cursor..].find(fence) {
                    cursor += end + fence.len();
                }
            }
            b'[' => {
                depth += 1;
                cursor += 1;
            }
            b']' => {
                depth -= 1;
                cursor += 1;
                if depth == 0 {
                    return Some(cursor);
                }
            }
            _ => cursor += 1,
        }
    }
    None
}

fn destination_span(raw: &str, mut start: usize) -> Option<Range<usize>> {
    let bytes = raw.as_bytes();
    while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    let angle = bytes.get(start) == Some(&b'<');
    if angle {
        start += 1;
    }
    let mut cursor = start;
    let mut depth = 0;
    while let Some(&byte) = bytes.get(cursor) {
        match byte {
            b'\\' => cursor += 2,
            b'>' if angle => return Some(start..cursor),
            b'(' if !angle => {
                depth += 1;
                cursor += 1;
            }
            b')' if !angle && depth == 0 => return Some(start..cursor),
            b')' if !angle => {
                depth -= 1;
                cursor += 1;
            }
            byte if !angle && byte.is_ascii_whitespace() => return Some(start..cursor),
            _ => cursor += 1,
        }
    }
    (!angle).then_some(start..cursor.min(raw.len()))
}

#[derive(Default)]
struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_OUTPUT_BYTES - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other("render output budget exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
