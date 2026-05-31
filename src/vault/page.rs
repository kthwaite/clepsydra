use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::path::VaultPath;
use crate::vault::kind::Kind;

// ---------------------------------------------------------------------------
// PageMeta
// ---------------------------------------------------------------------------

/// YAML frontmatter metadata for a vault page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageMeta {
    pub id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    /// Declared kind, from frontmatter `type:` (alias `kind:`). `None` => inferred.
    #[serde(
        default,
        rename = "type",
        alias = "kind",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<Kind>,
    /// Optional project slug; forms a subfolder beneath the kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
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
            created_at: Some(now),
            updated_at: Some(now),
            extra: HashMap::new(),
        }
    }
}

impl Default for PageMeta {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// FrontmatterError
// ---------------------------------------------------------------------------

/// Errors that can occur when parsing or writing frontmatter.
#[derive(Debug, Error)]
pub enum FrontmatterError {
    #[error("no YAML frontmatter found (missing --- fences)")]
    NotFound,
    #[error("failed to parse YAML frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("unterminated frontmatter (missing closing ---)")]
    Unterminated,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / writing
// ---------------------------------------------------------------------------

/// Split markdown content into `(yaml_frontmatter, body)`.
fn split_frontmatter(content: &str) -> Result<(&str, &str), FrontmatterError> {
    // Must start with `---`
    if !content.starts_with("---") {
        return Err(FrontmatterError::NotFound);
    }

    // Find the end of the opening `---` line
    let after_open = match content[3..].find('\n') {
        Some(pos) => 3 + pos + 1,
        None => return Err(FrontmatterError::Unterminated),
    };

    // Find the closing `---`
    let rest = &content[after_open..];
    let closing = rest
        .find("\n---")
        .map(|pos| after_open + pos + 1) // position of the `---` in the original string
        .or_else(|| {
            // Handle case where YAML is immediately followed by `---` at start of rest
            if rest.starts_with("---") {
                Some(after_open)
            } else {
                None
            }
        })
        .ok_or(FrontmatterError::Unterminated)?;

    let yaml_str = &content[after_open..closing];

    // Body starts after the closing `---` line
    let after_closing = closing + 3; // skip `---`
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

    Ok((yaml_str, body))
}

#[derive(Debug, Deserialize)]
struct LoosePageMeta {
    #[serde(default)]
    id: Option<Uuid>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default, rename = "type", alias = "kind")]
    kind: Option<Kind>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
    #[serde(flatten)]
    extra: HashMap<String, serde_yaml::Value>,
}

/// Ensure required metadata fields are populated.
///
/// Returns `true` if any fields were filled in.
fn ensure_populated_meta(meta: &mut PageMeta) -> bool {
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

/// Parse YAML frontmatter from a markdown document.
///
/// Expects the content to begin with `---\n`, followed by YAML, followed by
/// `---\n`. Returns the deserialized [`PageMeta`] and the body text after the
/// closing fence.
pub fn parse_frontmatter(content: &str) -> Result<(PageMeta, String), FrontmatterError> {
    let (yaml_str, body) = split_frontmatter(content)?;
    let meta: PageMeta = serde_yaml::from_str(yaml_str)?;
    Ok((meta, body.to_string()))
}

/// Parse frontmatter, repairing it when missing/malformed/incomplete.
///
/// Returns `(meta, body, rewrote, warning)` where `rewrote = true` means callers
/// should persist `write_page_content(meta, body)` back to disk. When `warning`
/// is `Some`, the frontmatter YAML was unparseable and the file was left
/// unmodified (indexed with default metadata only).
pub fn parse_or_repair_frontmatter(content: &str) -> (PageMeta, String, bool, Option<String>) {
    if let Ok((mut meta, body)) = parse_frontmatter(content) {
        let rewrote = ensure_populated_meta(&mut meta);
        return (meta, body, rewrote, None);
    }

    // Frontmatter fence exists but strict model failed (e.g. missing id).
    // Try to salvage user-authored fields with a loose model.
    if let Ok((yaml_str, body)) = split_frontmatter(content) {
        if let Ok(loose) = serde_yaml::from_str::<LoosePageMeta>(yaml_str) {
            let mut meta = PageMeta {
                id: loose.id.unwrap_or_else(Uuid::now_v7),
                title: loose.title,
                tags: loose.tags,
                aliases: loose.aliases,
                kind: loose.kind,
                project: loose.project,
                created_at: loose.created_at,
                updated_at: loose.updated_at,
                extra: loose.extra,
            };
            let _ = ensure_populated_meta(&mut meta);
            return (meta, body.to_string(), true, None);
        }

        // Could not parse YAML at all; keep body, do NOT rewrite the file.
        return (
            PageMeta::new(),
            body.to_string(),
            false,
            Some(
                "frontmatter YAML is unparseable; indexing with default metadata (file not modified)"
                    .into(),
            ),
        );
    }

    // No recognizable frontmatter fences; treat whole file as body.
    (PageMeta::new(), content.to_string(), true, None)
}

/// Serialize a [`PageMeta`] and body into a complete markdown document with
/// YAML frontmatter fences.
pub fn write_page_content(meta: &PageMeta, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).expect("PageMeta should always serialize");
    format!("---\n{yaml}---\n{body}")
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

#[cfg(test)]
mod kind_field_tests {
    use super::*;
    use crate::vault::kind::Kind;

    #[test]
    fn parses_declared_type_into_kind_field() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\ntype: quote\nproject: clepsydra\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(meta.kind, Some(Kind::Quote));
        assert_eq!(meta.project.as_deref(), Some("clepsydra"));
        // type/project must NOT leak into the extra bucket
        assert!(!meta.extra.contains_key("type"));
        assert!(!meta.extra.contains_key("project"));
    }

    #[test]
    fn kind_round_trips_back_to_type_key() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\ntype: BOOK\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        let out = serde_yaml::to_string(&meta).unwrap();
        assert!(out.contains("type: BOOK"), "serialized as: {out}");
    }

    #[test]
    fn absent_type_is_none() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(meta.kind, None);
        assert_eq!(meta.project, None);
    }

    #[test]
    fn parses_kind_alias_key() {
        let yaml = "id: 0190f8a0-0000-7000-8000-000000000000\nkind: journal\n";
        let meta: PageMeta = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(meta.kind, Some(Kind::Journal));
        // must not appear in the flatten bucket
        assert!(!meta.extra.contains_key("kind"));
    }
}

/// A vault page: its path, parsed metadata, body text, and raw content.
#[derive(Debug)]
pub struct Page {
    pub path: VaultPath,
    pub meta: PageMeta,
    pub body: String,
    pub raw_content: String,
}

impl Page {
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
