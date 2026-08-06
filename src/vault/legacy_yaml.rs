//! Quarantined legacy YAML frontmatter reader.
//!
//! `---`-fenced frontmatter is the pre-TOML format. This module holds the
//! relocated serde_yaml parse logic for the dual-read transition: legacy pages
//! are read here, converted into the TOML-native [`PageMeta`] representation,
//! and written back (when touched) as `+++` TOML by `page::write_page_content`.
//!
//! Scheduled for removal — along with the serde_yaml dependency — once the
//! doctor legacy census reads zero.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;

use super::kind::Kind;
use super::page::{ExtraMap, FrontmatterError, PageMeta, ensure_populated_meta, split_fenced};

/// Strict legacy model: `id` is required, unknown keys land in `extra`.
#[derive(Debug, Deserialize)]
struct YamlPageMeta {
    id: Uuid,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default, rename = "type")]
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

/// Loose salvage model: every field optional, used when the strict model fails
/// (typically a missing `id`).
#[derive(Debug, Deserialize)]
struct LooseYamlPageMeta {
    #[serde(default)]
    id: Option<Uuid>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default, rename = "type")]
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

/// Convert a YAML value into its TOML equivalent.
///
/// TOML has no null, so YAML nulls vanish: a null entry is dropped from
/// mappings and skipped in sequences (absence is the empty state). Tagged
/// values collapse to their inner value; non-string mapping keys are dropped.
pub fn yaml_value_to_toml(value: serde_yaml::Value) -> Option<toml::Value> {
    match value {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::Bool(b) => Some(toml::Value::Boolean(b)),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(toml::Value::Integer(i))
            } else {
                n.as_f64().map(toml::Value::Float)
            }
        }
        serde_yaml::Value::String(s) => Some(toml::Value::String(s)),
        serde_yaml::Value::Sequence(seq) => Some(toml::Value::Array(
            seq.into_iter().filter_map(yaml_value_to_toml).collect(),
        )),
        serde_yaml::Value::Mapping(map) => {
            let mut table = toml::map::Map::new();
            for (k, v) in map {
                if let serde_yaml::Value::String(key) = k
                    && let Some(converted) = yaml_value_to_toml(v)
                {
                    table.insert(key, converted);
                }
            }
            Some(toml::Value::Table(table))
        }
        serde_yaml::Value::Tagged(tagged) => yaml_value_to_toml(tagged.value),
    }
}

fn convert_extra(extra: HashMap<String, serde_yaml::Value>) -> ExtraMap {
    let mut map = ExtraMap::new();
    for (k, v) in extra {
        if let Some(converted) = yaml_value_to_toml(v) {
            map.insert(k, converted);
        }
    }
    map
}

/// Strict legacy parse: requires valid YAML with a present, valid `id`.
pub fn parse_frontmatter(content: &str) -> Result<(PageMeta, String), FrontmatterError> {
    let (yaml_str, body) = split_fenced(content, "---")?;
    let strict: YamlPageMeta = serde_yaml::from_str(yaml_str)?;
    let meta = PageMeta {
        id: strict.id,
        title: strict.title,
        tags: strict.tags,
        aliases: strict.aliases,
        kind: strict.kind,
        project: strict.project,
        created_at: strict.created_at,
        updated_at: strict.updated_at,
        extra: convert_extra(strict.extra),
    };
    Ok((meta, body.to_string()))
}

/// Legacy parse-or-repair: strict, then loose salvage, then default meta
/// without touching the file. Mirrors the TOML path's semantics exactly.
pub fn parse_or_repair_frontmatter(content: &str) -> (PageMeta, String, bool, Option<String>) {
    if let Ok((mut meta, body)) = parse_frontmatter(content) {
        let rewrote = ensure_populated_meta(&mut meta);
        return (meta, body, rewrote, None);
    }

    // Frontmatter fence exists but strict model failed (e.g. missing id).
    // Try to salvage user-authored fields with a loose model.
    if let Ok((yaml_str, body)) = split_fenced(content, "---") {
        if let Ok(loose) = serde_yaml::from_str::<LooseYamlPageMeta>(yaml_str) {
            let mut meta = PageMeta {
                id: loose.id.unwrap_or_else(Uuid::now_v7),
                title: loose.title,
                tags: loose.tags,
                aliases: loose.aliases,
                kind: loose.kind,
                project: loose.project,
                created_at: loose.created_at,
                updated_at: loose.updated_at,
                extra: convert_extra(loose.extra),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_null_is_dropped_entirely() {
        let (meta, _, _, _) = parse_or_repair_frontmatter(
            "---\nid: 01900000-0000-7000-8000-000000000001\nempty:\n---\nBody",
        );
        assert!(!meta.extra.contains_key("empty"));
    }

    #[test]
    fn yaml_scalars_convert_to_native_toml_values() {
        let (meta, body, _, warning) = parse_or_repair_frontmatter(
            "---\nid: 01900000-0000-7000-8000-000000000001\nrating: 4.5\nyear: 2020\ndone: true\nauthor: Gene Wolfe\nthemes:\n  - memory\n  - identity\n---\nBody",
        );
        assert!(warning.is_none());
        assert_eq!(body, "Body");
        assert_eq!(meta.extra["rating"], toml::Value::Float(4.5));
        assert_eq!(meta.extra["year"], toml::Value::Integer(2020));
        assert_eq!(meta.extra["done"], toml::Value::Boolean(true));
        assert_eq!(
            meta.extra["author"],
            toml::Value::String("Gene Wolfe".into())
        );
        assert_eq!(
            meta.extra["themes"],
            toml::Value::Array(vec![
                toml::Value::String("memory".into()),
                toml::Value::String("identity".into())
            ])
        );
    }

    #[test]
    fn nested_mapping_becomes_table() {
        let (meta, _, _, _) = parse_or_repair_frontmatter(
            "---\nid: 01900000-0000-7000-8000-000000000001\narchive:\n  url: https://example.com\n  fetched: true\n---\n",
        );
        let toml::Value::Table(archive) = &meta.extra["archive"] else {
            panic!("archive should be a table");
        };
        assert_eq!(
            archive["url"],
            toml::Value::String("https://example.com".into())
        );
        assert_eq!(archive["fetched"], toml::Value::Boolean(true));
    }
}
