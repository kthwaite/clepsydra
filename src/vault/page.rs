use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::path::VaultPath;

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

/// Parse YAML frontmatter from a markdown document.
///
/// Expects the content to begin with `---\n`, followed by YAML, followed by
/// `---\n`. Returns the deserialized [`PageMeta`] and the body text after the
/// closing fence.
pub fn parse_frontmatter(content: &str) -> Result<(PageMeta, String), FrontmatterError> {
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
            // Handle case where yaml is immediately followed by `---` at start of rest
            if rest.starts_with("---") {
                Some(after_open)
            } else {
                None
            }
        })
        .ok_or(FrontmatterError::Unterminated)?;

    let yaml_str = &content[after_open..closing];
    let meta: PageMeta = serde_yaml::from_str(yaml_str)?;

    // Body starts after the closing `---` line
    let after_closing = closing + 3; // skip `---`
    let body = if after_closing < content.len() {
        // Skip the newline immediately after `---`
        let body_start = if content[after_closing..].starts_with('\n') {
            after_closing + 1
        } else {
            after_closing
        };
        content[body_start..].to_string()
    } else {
        String::new()
    };

    Ok((meta, body))
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
