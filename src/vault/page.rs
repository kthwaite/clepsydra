use std::fs;
use std::path::Path;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::ser::{Serialize, SerializeMap, Serializer};
use thiserror::Error;
use uuid::Uuid;

use super::legacy_yaml;
use super::path::VaultPath;
use super::toml_json::toml_value_to_json;
use crate::vault::encryption::{EncryptionMeta, validate_age_armor};
use crate::vault::kind::Kind;

/// Frontmatter extras: every key that is not a system field, holding native
/// TOML values. Backed by an order-preserving map so extras round-trip in
/// first-seen order.
pub type ExtraMap = toml::map::Map<String, toml::Value>;

// ---------------------------------------------------------------------------
// PageMeta
// ---------------------------------------------------------------------------

/// TOML frontmatter metadata for a vault page.
///
/// Extras hold native `toml::Value`s so downstream consumers (the property
/// deriver, link extraction) see real dates, numbers, and booleans instead of
/// sniffing strings. JSON serialization (`meta_json`, page-detail responses)
/// goes through an explicit conversion that renders date-times as ISO 8601
/// strings — see [`crate::vault::toml_json`].
#[derive(Debug, Clone)]
pub struct PageMeta {
    pub id: Uuid,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    /// Declared kind, from frontmatter `type =` only. `None` => inferred.
    /// NOTE: `kind` is intentionally NOT read here; the academic subsystem
    /// uses `kind = "work"` with a different meaning, and we must not hijack it.
    pub kind: Option<Kind>,
    /// Optional project slug; forms a subfolder beneath the kind.
    pub project: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    pub encryption: Option<EncryptionMeta>,
    /// Explicit write-protection for the page body. `None` defers to the
    /// kind's default (see `Kind::readonly_by_default`), so archived pages are
    /// protected without every one of them carrying the flag, and any page can
    /// opt in or out by declaring it.
    pub readonly: Option<bool>,
    pub extra: ExtraMap,
}

impl PageMeta {
    /// Create a new `PageMeta` with a fresh v7 UUID and timestamps set to now.
    pub fn new() -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::now_v7(),
            title: None,
            tags: Vec::new(),
            aliases: Vec::new(),
            kind: None,
            project: None,
            readonly: None,
            created_at: Some(now),
            updated_at: Some(now),
            encryption: None,
            extra: ExtraMap::new(),
        }
    }
}

impl Default for PageMeta {
    fn default() -> Self {
        Self::new()
    }
}

/// JSON-safe serialization: extras go through [`toml_value_to_json`] so TOML
/// date-times land as ISO strings rather than the toml crate's private serde
/// representation. This impl backs `meta_json` and the page-detail response.
impl Serialize for PageMeta {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        if let Some(title) = &self.title {
            map.serialize_entry("title", title)?;
        }
        if !self.tags.is_empty() {
            map.serialize_entry("tags", &self.tags)?;
        }
        if !self.aliases.is_empty() {
            map.serialize_entry("aliases", &self.aliases)?;
        }
        if let Some(kind) = &self.kind {
            map.serialize_entry("type", kind)?;
        }
        if let Some(project) = &self.project {
            map.serialize_entry("project", project)?;
        }
        if let Some(created_at) = &self.created_at {
            map.serialize_entry("created_at", created_at)?;
        }
        if let Some(updated_at) = &self.updated_at {
            map.serialize_entry("updated_at", updated_at)?;
        }
        if let Some(encryption) = &self.encryption {
            map.serialize_entry("encryption", encryption)?;
        }
        if let Some(readonly) = &self.readonly {
            map.serialize_entry("readonly", readonly)?;
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, &toml_value_to_json(value))?;
        }
        map.end()
    }
}

// ---------------------------------------------------------------------------
// FrontmatterError
// ---------------------------------------------------------------------------

/// Errors that can occur when parsing or writing frontmatter.
#[derive(Debug, Error)]
pub enum FrontmatterError {
    #[error("no frontmatter found (missing +++ or --- fences)")]
    NotFound,
    #[error("failed to parse TOML frontmatter: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("failed to parse YAML frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("frontmatter is missing a valid id")]
    MissingId,
    #[error("invalid frontmatter field: {0}")]
    InvalidField(String),
    #[error("unterminated frontmatter (missing closing fence)")]
    Unterminated,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// Fence splitting
// ---------------------------------------------------------------------------

/// Split content into `(frontmatter, body)` delimited by the given fence
/// (`+++` for TOML, `---` for legacy YAML).
pub(crate) fn split_fenced<'a>(
    content: &'a str,
    fence: &str,
) -> Result<(&'a str, &'a str), FrontmatterError> {
    if !content.starts_with(fence) {
        return Err(FrontmatterError::NotFound);
    }

    // Find the end of the opening fence line.
    let after_open = match content[fence.len()..].find('\n') {
        Some(pos) => fence.len() + pos + 1,
        None => return Err(FrontmatterError::Unterminated),
    };

    // Find the closing fence.
    let rest = &content[after_open..];
    let newline_fence = format!("\n{fence}");
    let closing = rest
        .find(&newline_fence)
        .map(|pos| after_open + pos + 1) // position of the fence in the original string
        .or_else(|| {
            // Handle empty frontmatter: closing fence at the start of rest.
            if rest.starts_with(fence) {
                Some(after_open)
            } else {
                None
            }
        })
        .ok_or(FrontmatterError::Unterminated)?;

    let fm_str = &content[after_open..closing];

    // Body starts after the closing fence line.
    let after_closing = closing + fence.len();
    let body_start = if after_closing < content.len() && content[after_closing..].starts_with('\n')
    {
        after_closing + 1
    } else {
        after_closing
    };
    let body = if body_start <= content.len() {
        &content[body_start..]
    } else {
        ""
    };

    Ok((fm_str, body))
}

/// Find the byte offset where the body begins (after the closing frontmatter
/// fence — `+++` or `---`). Returns 0 if no frontmatter is detected.
pub fn body_offset(content: &str) -> usize {
    let fence = if content.starts_with("+++") {
        "+++"
    } else if content.starts_with("---") {
        "---"
    } else {
        return 0;
    };
    match split_fenced(content, fence) {
        Ok((_, body)) => content.len() - body.len(),
        Err(_) => 0,
    }
}

// ---------------------------------------------------------------------------
// TOML field extraction
// ---------------------------------------------------------------------------

fn take_bool(table: &mut toml::Table, key: &str) -> Result<Option<bool>, FrontmatterError> {
    match table.remove(key) {
        None => Ok(None),
        Some(toml::Value::Boolean(value)) => Ok(Some(value)),
        Some(_) => Err(FrontmatterError::InvalidField(format!(
            "{key} must be a boolean"
        ))),
    }
}

fn take_string(
    table: &mut toml::Table,
    key: &'static str,
) -> Result<Option<String>, FrontmatterError> {
    match table.remove(key) {
        None => Ok(None),
        Some(toml::Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(FrontmatterError::InvalidField(format!(
            "{key} must be a string"
        ))),
    }
}

fn take_string_array(
    table: &mut toml::Table,
    key: &'static str,
) -> Result<Vec<String>, FrontmatterError> {
    match table.remove(key) {
        None => Ok(Vec::new()),
        Some(toml::Value::Array(items)) => items
            .into_iter()
            .map(|item| match item {
                toml::Value::String(s) => Ok(s),
                _ => Err(FrontmatterError::InvalidField(format!(
                    "{key} must be an array of strings"
                ))),
            })
            .collect(),
        Some(_) => Err(FrontmatterError::InvalidField(format!(
            "{key} must be an array of strings"
        ))),
    }
}

/// Convert a TOML date-time (or a tolerated RFC 3339 string) into UTC.
///
/// Local date-times are assumed UTC; local dates resolve to midnight UTC.
fn toml_datetime_to_utc(dt: &toml::value::Datetime) -> Option<DateTime<Utc>> {
    let text = dt.to_string();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&text) {
        return Some(parsed.with_timezone(&Utc));
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&text, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(naive.and_utc());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(&text, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc());
    }
    None
}

fn take_timestamp(
    table: &mut toml::Table,
    key: &'static str,
) -> Result<Option<DateTime<Utc>>, FrontmatterError> {
    match table.remove(key) {
        None => Ok(None),
        Some(toml::Value::Datetime(dt)) => toml_datetime_to_utc(&dt).map(Some).ok_or_else(|| {
            FrontmatterError::InvalidField(format!("{key} is not a valid date-time"))
        }),
        // Tolerate quoted RFC 3339 strings (hand-authored or legacy-shaped).
        Some(toml::Value::String(s)) => DateTime::parse_from_rfc3339(&s)
            .map(|dt| Some(dt.with_timezone(&Utc)))
            .map_err(|_| FrontmatterError::InvalidField(format!("{key} is not a valid date-time"))),
        Some(_) => Err(FrontmatterError::InvalidField(format!(
            "{key} must be a date-time"
        ))),
    }
}

fn take_encryption(table: &mut toml::Table) -> Result<Option<EncryptionMeta>, FrontmatterError> {
    let Some(value) = table.remove("encryption") else {
        return Ok(None);
    };
    if !value.is_table() {
        return Err(FrontmatterError::InvalidField(
            "encryption must be a table or inline table".into(),
        ));
    }
    let meta: EncryptionMeta = value.try_into().map_err(|_| {
        FrontmatterError::InvalidField("encryption must contain format, version, and key_id".into())
    })?;
    meta.validate()
        .map_err(|e| FrontmatterError::InvalidField(e.to_string()))?;
    Ok(Some(meta))
}

fn validate_encrypted_body(meta: &PageMeta, body: &str) -> Result<(), FrontmatterError> {
    if meta.encryption.is_some() {
        validate_age_armor(body).map_err(|e| FrontmatterError::InvalidField(e.to_string()))?;
    }
    Ok(())
}

/// Extract a [`PageMeta`] from a parsed TOML table. Returns the meta and
/// whether the `id` was absent (and therefore freshly generated).
///
/// A present-but-invalid field (wrong type, malformed UUID, unknown kind
/// token) is an error; a missing `id` is salvageable.
fn meta_from_table(mut table: toml::Table) -> Result<(PageMeta, bool), FrontmatterError> {
    let (id, id_generated) = match table.remove("id") {
        None => (Uuid::now_v7(), true),
        Some(toml::Value::String(s)) => match Uuid::from_str(&s) {
            Ok(id) => (id, false),
            Err(_) => {
                return Err(FrontmatterError::InvalidField(format!(
                    "id is not a valid UUID: {s}"
                )));
            }
        },
        Some(_) => {
            return Err(FrontmatterError::InvalidField("id must be a string".into()));
        }
    };

    let title = take_string(&mut table, "title")?;
    let kind = match take_string(&mut table, "type")? {
        None => None,
        Some(raw) => Some(
            Kind::from_token(&raw)
                .ok_or_else(|| FrontmatterError::InvalidField(format!("unknown kind: {raw}")))?,
        ),
    };
    let project = take_string(&mut table, "project")?;
    let tags = take_string_array(&mut table, "tags")?;
    let aliases = take_string_array(&mut table, "aliases")?;
    let created_at = take_timestamp(&mut table, "created_at")?;
    let updated_at = take_timestamp(&mut table, "updated_at")?;
    let encryption = take_encryption(&mut table)?;
    let readonly = take_bool(&mut table, "readonly")?;

    Ok((
        PageMeta {
            id,
            title,
            tags,
            aliases,
            kind,
            project,
            created_at,
            updated_at,
            encryption,
            readonly,
            extra: table,
        },
        id_generated,
    ))
}

/// Ensure required metadata fields are populated.
///
/// Returns `true` if any fields were filled in.
pub(crate) fn ensure_populated_meta(meta: &mut PageMeta) -> bool {
    let mut changed = false;

    if meta.created_at.is_none() {
        let now = Utc::now();
        meta.created_at = Some(now);
        changed = true;
    }

    if meta.updated_at.is_none() {
        meta.updated_at = meta.created_at.or_else(|| Some(Utc::now()));
        changed = true;
    }

    changed
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / writing
// ---------------------------------------------------------------------------

/// Parse frontmatter from a markdown document, dispatching on the fence.
///
/// `+++` means TOML; `---` means legacy YAML (dual-read transition). Strict in
/// both cases: a missing or invalid `id`, or a mistyped system field, is an
/// error. Returns the deserialized [`PageMeta`] and the body text after the
/// closing fence.
pub fn parse_frontmatter(content: &str) -> Result<(PageMeta, String), FrontmatterError> {
    if content.starts_with("+++") {
        let (toml_str, body) = split_fenced(content, "+++")?;
        let table: toml::Table = toml_str.parse()?;
        let (meta, id_generated) = meta_from_table(table)?;
        if id_generated {
            return Err(FrontmatterError::MissingId);
        }
        validate_encrypted_body(&meta, body)?;
        Ok((meta, body.to_string()))
    } else if content.starts_with("---") {
        legacy_yaml::parse_frontmatter(content)
    } else {
        Err(FrontmatterError::NotFound)
    }
}

/// Parse frontmatter, repairing it when missing/malformed/incomplete.
///
/// Returns `(meta, body, rewrote, warning)` where `rewrote = true` means callers
/// should persist `write_page_content(meta, body)` back to disk. When `warning`
/// is `Some`, the frontmatter was unparseable and the file was left unmodified
/// (indexed with default metadata only).
pub fn parse_or_repair_frontmatter(content: &str) -> (PageMeta, String, bool, Option<String>) {
    if content.starts_with("+++") {
        match split_fenced(content, "+++") {
            Ok((toml_str, body)) => match toml_str.parse::<toml::Table>() {
                Ok(table) => match meta_from_table(table) {
                    Ok((mut meta, id_generated)) => {
                        if let Err(e) = validate_encrypted_body(&meta, body) {
                            return (
                                meta,
                                body.to_string(),
                                false,
                                Some(format!(
                                    "encrypted body is invalid ({e}); indexing as protected with parsed metadata (file not modified)"
                                )),
                            );
                        }
                        let mut rewrote = id_generated;
                        rewrote |= ensure_populated_meta(&mut meta);
                        (meta, body.to_string(), rewrote, None)
                    }
                    // A mistyped field: keep body, do NOT rewrite the file.
                    Err(e) => (
                        PageMeta::new(),
                        body.to_string(),
                        false,
                        Some(format!(
                            "frontmatter TOML is invalid ({e}); indexing with default metadata (file not modified)"
                        )),
                    ),
                },
                Err(_) => (
                    PageMeta::new(),
                    body.to_string(),
                    false,
                    Some(
                        "frontmatter TOML is unparseable; indexing with default metadata (file not modified)"
                            .into(),
                    ),
                ),
            },
            // Unterminated fence; treat whole file as body.
            Err(_) => (PageMeta::new(), content.to_string(), true, None),
        }
    } else if content.starts_with("---") {
        legacy_yaml::parse_or_repair_frontmatter(content)
    } else {
        // No recognizable frontmatter fences; treat whole file as body.
        (PageMeta::new(), content.to_string(), true, None)
    }
}

/// Render a chrono timestamp as a native TOML offset date-time.
fn chrono_to_toml_datetime(dt: &DateTime<Utc>) -> toml::Value {
    let text = dt.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
    let parsed = text
        .parse::<toml::value::Datetime>()
        .expect("RFC 3339 UTC timestamp is always a valid TOML date-time");
    toml::Value::Datetime(parsed)
}

/// Serialize a [`PageMeta`] and body into a complete markdown document with
/// TOML frontmatter fences.
///
/// Canonical key order: `id`, `title`, `type`, `project`, `tags`, `aliases`,
/// `created_at`, `updated_at`, `encryption`, then extras in first-seen order.
/// Used where no prior formatting exists to preserve; surgical edits go
/// through `toml_patch` instead.
pub fn write_page_content(meta: &PageMeta, body: &str) -> String {
    let mut system = toml::Table::new();
    system.insert("id".into(), toml::Value::String(meta.id.to_string()));
    if let Some(title) = &meta.title {
        system.insert("title".into(), toml::Value::String(title.clone()));
    }
    if let Some(kind) = &meta.kind {
        system.insert(
            "type".into(),
            toml::Value::String(kind.as_str().to_string()),
        );
    }
    if let Some(project) = &meta.project {
        system.insert("project".into(), toml::Value::String(project.clone()));
    }
    if !meta.tags.is_empty() {
        system.insert(
            "tags".into(),
            toml::Value::Array(meta.tags.iter().cloned().map(toml::Value::String).collect()),
        );
    }
    if !meta.aliases.is_empty() {
        system.insert(
            "aliases".into(),
            toml::Value::Array(
                meta.aliases
                    .iter()
                    .cloned()
                    .map(toml::Value::String)
                    .collect(),
            ),
        );
    }
    if let Some(created_at) = &meta.created_at {
        system.insert("created_at".into(), chrono_to_toml_datetime(created_at));
    }
    if let Some(updated_at) = &meta.updated_at {
        system.insert("updated_at".into(), chrono_to_toml_datetime(updated_at));
    }
    if let Some(readonly) = meta.readonly {
        system.insert("readonly".into(), toml::Value::Boolean(readonly));
    }

    let mut toml = toml::to_string(&system).expect("PageMeta system fields should serialize");
    if let Some(encryption) = &meta.encryption {
        let value = toml::Value::try_from(encryption)
            .expect("validated encryption metadata should serialize");
        toml.push_str(&format!("encryption = {value}\n"));
    }

    let mut extras = toml::Table::new();
    for (key, value) in &meta.extra {
        if !system.contains_key(key) && key != "encryption" {
            extras.insert(key.clone(), value.clone());
        }
    }
    toml.push_str(&toml::to_string(&extras).expect("PageMeta extras should serialize"));

    format!("+++\n{toml}+++\n{body}")
}

/// Return the lowercase BLAKE3 digest of the exact serialized page bytes.
pub fn page_revision(serialized: &str) -> String {
    blake3::hash(serialized.as_bytes()).to_hex().to_string()
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/// A vault page: its path, parsed metadata, body text, and raw content.
#[derive(Debug)]
pub struct Page {
    pub path: VaultPath,
    pub meta: PageMeta,
    pub body: String,
    pub raw_content: String,
}

impl Page {
    pub fn is_encrypted(&self) -> bool {
        self.meta.encryption.is_some()
    }

    /// Read a file and parse its frontmatter.
    ///
    /// Returns an error if the file cannot be read or the frontmatter is
    /// missing / malformed.
    pub fn from_file(abs_path: &Path, vault_path: VaultPath) -> Result<Self, FrontmatterError> {
        let raw_content = fs::read_to_string(abs_path)?;
        let (meta, body) = parse_frontmatter(&raw_content)?;
        Ok(Self {
            path: vault_path,
            meta,
            body,
            raw_content,
        })
    }

    /// Read a file, parsing frontmatter if present. If frontmatter is absent,
    /// create a fresh [`PageMeta`] (with a new v7 UUID) and treat the entire
    /// file content as the body.
    pub fn from_file_or_create_meta(
        abs_path: &Path,
        vault_path: VaultPath,
    ) -> Result<Self, FrontmatterError> {
        let raw_content = fs::read_to_string(abs_path)?;
        match parse_frontmatter(&raw_content) {
            Ok((meta, body)) => Ok(Self {
                path: vault_path,
                meta,
                body,
                raw_content,
            }),
            Err(FrontmatterError::NotFound) => {
                let meta = PageMeta::new();
                Ok(Self {
                    path: vault_path,
                    meta,
                    body: raw_content.clone(),
                    raw_content,
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Write the page (frontmatter + body) to disk.
    pub fn to_file(&self, abs_path: &Path) -> Result<(), std::io::Error> {
        let content = write_page_content(&self.meta, &self.body);
        fs::write(abs_path, content)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod revision_tests {
    use super::page_revision;

    #[test]
    fn revision_is_stable_for_identical_serialized_content() {
        let content = "---\nid: 01900000-0000-7000-8000-000000000001\n---\nBody";
        assert_eq!(page_revision(content), page_revision(content));
        assert_eq!(page_revision(content).len(), 64);
    }

    #[test]
    fn revision_changes_when_any_serialized_byte_changes() {
        assert_ne!(page_revision("body\n"), page_revision("body"));
    }
}

#[cfg(test)]
mod toml_frontmatter_tests {
    use super::*;
    use chrono::TimeZone;

    const SPEC_EXAMPLE: &str = r#"+++
id = "01900000-0000-7000-8000-000000000001"
title = "The Book of the New Sun"
type = "BOOK"
tags = ["sf", "wolfe"]
created_at = 2026-08-06T09:00:00Z
updated_at = 2026-08-06T09:00:00Z

# --- properties (any base may interpret these) ---
author = "Gene Wolfe"
status = "reading"
rating = 4.5
started = 2026-07-30
series = ["[[Solar Cycle]]"]
+++
Body begins here.
"#;

    #[test]
    fn parses_spec_example_with_native_types() {
        let (meta, body) = parse_frontmatter(SPEC_EXAMPLE).unwrap();
        assert_eq!(
            meta.id,
            Uuid::from_str("01900000-0000-7000-8000-000000000001").unwrap()
        );
        assert_eq!(meta.title.as_deref(), Some("The Book of the New Sun"));
        assert_eq!(meta.kind, Some(Kind::Book));
        assert_eq!(meta.tags, vec!["sf", "wolfe"]);
        assert_eq!(
            meta.created_at,
            Some(Utc.with_ymd_and_hms(2026, 8, 6, 9, 0, 0).unwrap())
        );
        assert_eq!(body, "Body begins here.\n");

        // Native TOML types survive into extras — no string sniffing.
        assert_eq!(
            meta.extra["author"],
            toml::Value::String("Gene Wolfe".into())
        );
        assert_eq!(meta.extra["rating"], toml::Value::Float(4.5));
        assert!(matches!(meta.extra["started"], toml::Value::Datetime(_)));
        assert_eq!(
            meta.extra["series"],
            toml::Value::Array(vec![toml::Value::String("[[Solar Cycle]]".into())])
        );
        // System fields must not leak into the extras bucket.
        assert!(!meta.extra.contains_key("type"));
        assert!(!meta.extra.contains_key("id"));
        assert!(!meta.extra.contains_key("created_at"));
    }

    #[test]
    fn round_trip_preserves_meta_and_canonical_order() {
        let (meta, body) = parse_frontmatter(SPEC_EXAMPLE).unwrap();
        let written = write_page_content(&meta, &body);
        assert!(written.starts_with("+++\n"));

        let (meta2, body2) = parse_frontmatter(&written).unwrap();
        assert_eq!(meta2.id, meta.id);
        assert_eq!(meta2.title, meta.title);
        assert_eq!(meta2.kind, meta.kind);
        assert_eq!(meta2.tags, meta.tags);
        assert_eq!(meta2.created_at, meta.created_at);
        assert_eq!(meta2.extra, meta.extra);
        assert_eq!(body2, body);

        // Canonical key order: system fields first, in declared order.
        let id_pos = written.find("id = ").unwrap();
        let title_pos = written.find("title = ").unwrap();
        let type_pos = written.find("type = ").unwrap();
        let tags_pos = written.find("tags = ").unwrap();
        let created_pos = written.find("created_at = ").unwrap();
        let author_pos = written.find("author = ").unwrap();
        assert!(id_pos < title_pos);
        assert!(title_pos < type_pos);
        assert!(type_pos < tags_pos);
        assert!(tags_pos < created_pos);
        assert!(created_pos < author_pos);

        // Timestamps serialize as native TOML date-times, not quoted strings.
        assert!(written.contains("created_at = 2026-08-06T09:00:00Z"));
        assert!(written.contains("started = 2026-07-30\n"));
    }

    #[test]
    fn legacy_yaml_page_still_parses_with_identical_meta() {
        let yaml = "---\nid: 01900000-0000-7000-8000-000000000001\ntitle: The Book of the New Sun\ntype: BOOK\ntags:\n  - sf\n  - wolfe\nauthor: Gene Wolfe\nrating: 4.5\n---\nBody begins here.\n";
        let (meta, body) = parse_frontmatter(yaml).unwrap();
        assert_eq!(
            meta.id,
            Uuid::from_str("01900000-0000-7000-8000-000000000001").unwrap()
        );
        assert_eq!(meta.title.as_deref(), Some("The Book of the New Sun"));
        assert_eq!(meta.kind, Some(Kind::Book));
        assert_eq!(meta.tags, vec!["sf", "wolfe"]);
        assert_eq!(
            meta.extra["author"],
            toml::Value::String("Gene Wolfe".into())
        );
        assert_eq!(meta.extra["rating"], toml::Value::Float(4.5));
        assert_eq!(body, "Body begins here.\n");
    }

    #[test]
    fn dispatch_on_first_bytes() {
        // Neither fence: whole file is body, fresh meta, rewrote.
        let (meta, body, rewrote, warning) = parse_or_repair_frontmatter("Just a body.\n");
        assert_eq!(body, "Just a body.\n");
        assert!(rewrote);
        assert!(warning.is_none());
        assert!(!meta.id.is_nil());
    }

    #[test]
    fn toml_missing_id_salvages_loose() {
        let content = "+++\ntitle = \"No id here\"\nauthor = \"Someone\"\n+++\nBody\n";
        assert!(matches!(
            parse_frontmatter(content),
            Err(FrontmatterError::MissingId)
        ));

        let (meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);
        assert!(warning.is_none());
        assert!(rewrote, "generated id must trigger a rewrite");
        assert!(!meta.id.is_nil());
        assert_eq!(meta.title.as_deref(), Some("No id here"));
        assert_eq!(meta.extra["author"], toml::Value::String("Someone".into()));
        assert_eq!(body, "Body\n");
    }

    #[test]
    fn unparseable_toml_leaves_file_untouched_with_warning() {
        let content = "+++\nthis is not = = toml\n+++\nBody\n";
        let (meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);
        assert!(!rewrote, "unparseable frontmatter must not be rewritten");
        assert!(warning.is_some());
        assert_eq!(body, "Body\n");
        assert!(!meta.id.is_nil());
        assert!(meta.extra.is_empty());
    }

    #[test]
    fn mistyped_field_leaves_file_untouched_with_warning() {
        let content =
            "+++\nid = \"01900000-0000-7000-8000-000000000001\"\ntags = \"notalist\"\n+++\nBody\n";
        let (_, body, rewrote, warning) = parse_or_repair_frontmatter(content);
        assert!(!rewrote);
        assert!(warning.is_some());
        assert_eq!(body, "Body\n");
    }

    #[test]
    fn meta_json_has_no_private_datetime_artifact() {
        let (meta, _) = parse_frontmatter(SPEC_EXAMPLE).unwrap();
        let json = serde_json::to_string(&meta).unwrap();
        assert!(
            !json.contains("$__toml_private_datetime"),
            "artifact leaked: {json}"
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["started"], serde_json::json!("2026-07-30"));
        assert_eq!(value["rating"], serde_json::json!(4.5));
        assert_eq!(value["type"], serde_json::json!("BOOK"));
        assert_eq!(value["title"], serde_json::json!("The Book of the New Sun"));
    }

    #[test]
    fn nested_table_extra_round_trips() {
        let content = "+++\nid = \"01900000-0000-7000-8000-000000000001\"\n\n[archive]\nurl = \"https://example.com\"\nfetched = true\n+++\nBody\n";
        let (meta, body) = parse_frontmatter(content).unwrap();
        let toml::Value::Table(archive) = &meta.extra["archive"] else {
            panic!("archive should be a table");
        };
        assert_eq!(
            archive["url"],
            toml::Value::String("https://example.com".into())
        );
        let written = write_page_content(&meta, &body);
        let (meta2, _) = parse_frontmatter(&written).unwrap();
        assert_eq!(meta2.extra, meta.extra);
    }

    #[test]
    fn empty_frontmatter_parses_as_missing_id() {
        let content = "+++\n+++\nBody\n";
        let (meta, body, rewrote, warning) = parse_or_repair_frontmatter(content);
        assert!(warning.is_none());
        assert!(rewrote);
        assert_eq!(body, "Body\n");
        assert!(!meta.id.is_nil());
    }
}

#[cfg(test)]
mod kind_field_tests {
    use super::*;
    use crate::vault::kind::Kind;

    #[test]
    fn parses_declared_type_into_kind_field() {
        let content = "+++\nid = \"0190f8a0-0000-7000-8000-000000000000\"\ntype = \"quote\"\nproject = \"clepsydra\"\n+++\n";
        let (meta, _) = parse_frontmatter(content).unwrap();
        assert_eq!(meta.kind, Some(Kind::Quote));
        assert_eq!(meta.project.as_deref(), Some("clepsydra"));
        // type/project must NOT leak into the extra bucket
        assert!(!meta.extra.contains_key("type"));
        assert!(!meta.extra.contains_key("project"));
    }

    #[test]
    fn kind_round_trips_back_to_type_key() {
        let content = "+++\nid = \"0190f8a0-0000-7000-8000-000000000000\"\ntype = \"BOOK\"\n+++\n";
        let (meta, body) = parse_frontmatter(content).unwrap();
        let out = write_page_content(&meta, &body);
        assert!(out.contains("type = \"BOOK\""), "serialized as: {out}");
    }

    #[test]
    fn absent_type_is_none() {
        let content = "+++\nid = \"0190f8a0-0000-7000-8000-000000000000\"\n+++\n";
        let (meta, _) = parse_frontmatter(content).unwrap();
        assert_eq!(meta.kind, None);
        assert_eq!(meta.project, None);
    }

    #[test]
    fn bare_kind_key_is_not_consumed_as_page_kind() {
        // The academic subsystem uses `kind = "work"` with a different meaning;
        // the page-kind field must only bind to `type`, never `kind`.
        let content = "+++\nid = \"0190f8a0-0000-7000-8000-000000000000\"\nkind = \"work\"\n+++\n";
        let (meta, _) = parse_frontmatter(content).unwrap();
        assert_eq!(meta.kind, None); // not consumed as a page Kind
        assert!(meta.extra.contains_key("kind")); // stays in the extras bucket
    }
}

/// Whether this page's body is write-protected.
///
/// An explicit `readonly =` in the frontmatter always wins; otherwise the
/// page's resolved kind decides. Declared *or* inferred kinds count, so a page
/// sitting in `archive/` is protected even before its kind is written out.
pub fn body_is_protected(path: &str, meta: &PageMeta) -> bool {
    if let Some(readonly) = meta.readonly {
        return readonly;
    }
    let (kind, _) = crate::vault::kind::resolve(path, meta.kind);
    kind.readonly_by_default()
}

/// The body portion of a stored page, i.e. everything after the frontmatter.
pub fn body_of(content: &str) -> &str {
    &content[body_offset(content)..]
}
