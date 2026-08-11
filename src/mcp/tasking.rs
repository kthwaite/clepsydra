//! Shared parameter plumbing for the MCP tasking tools.
//!
//! The board PATCH endpoints distinguish three states per clearable field:
//! absent (keep), JSON null (clear), and a value (set). This module carries
//! that tri-state through MCP param structs and classifies the free-form
//! task/cycle references the tools accept (UUID, vault path, or board code).
//! It mirrors the semantics of `src/api/board` without importing from the
//! HTTP layer — the MCP side only speaks to the server over HTTP.

use serde::{Deserialize, Deserializer};
use uuid::Uuid;

/// Deserialize a tri-state PATCH field into `Option<Option<T>>`:
///
/// - key absent → `None` (leave the field untouched; via `#[serde(default)]`)
/// - key present with JSON null → `Some(None)` (clear the field)
/// - key present with a value → `Some(Some(v))` (set the field)
///
/// Apply on param-struct fields as
/// `#[serde(default, deserialize_with = "deserialize_tri_state")]` together
/// with `#[schemars(with = "Option<String>")]` so the advertised JSON schema
/// stays a plain nullable string.
pub fn deserialize_tri_state<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    // Deserialize as `Option<T>`: serde maps JSON null → None, value →
    // Some(v). The outer `Option` is handled by `#[serde(default)]`: when the
    // key is absent this function is never called and the field stays `None`.
    let inner: Option<T> = Option::deserialize(deserializer)?;
    Ok(Some(inner))
}

/// Normalize a deserialized tri-state string field so an empty or
/// whitespace-only string behaves as an explicit clear (`Some(None)`) —
/// defensive against MCP clients that cannot emit JSON null. Every other
/// state passes through unchanged.
pub fn normalize_tri_state(value: Option<Option<String>>) -> Option<Option<String>> {
    match value {
        Some(Some(s)) if s.trim().is_empty() => Some(None),
        other => other,
    }
}

/// How a caller referenced a task or cycle page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskRef {
    /// A page UUID, usable against the PATCH endpoints directly.
    Id(Uuid),
    /// A vault-relative page path (contains `/` or ends in `.md`).
    Path(String),
    /// A board code such as `TSK-0001` or `S-13`, normalized to uppercase.
    Code(String),
}

/// Classify a free-form task/cycle reference: trims, then parses as a UUID →
/// [`TaskRef::Id`]; contains `/` or ends in `.md` → [`TaskRef::Path`] (kept
/// as given); anything else → [`TaskRef::Code`], uppercased.
pub fn classify_ref(input: &str) -> TaskRef {
    let input = input.trim();
    if let Ok(id) = Uuid::parse_str(input) {
        return TaskRef::Id(id);
    }
    if input.contains('/') || input.ends_with(".md") {
        return TaskRef::Path(input.to_string());
    }
    TaskRef::Code(input.to_uppercase())
}

#[cfg(test)]
mod tests {
    use schemars::JsonSchema;
    use serde_json::json;

    use super::*;

    #[test]
    fn classify_ref_distinguishes_ids_paths_and_codes() {
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        let cases = [
            (uuid, TaskRef::Id(Uuid::parse_str(uuid).unwrap())),
            (
                "tasks/xxii/TSK-0001.md",
                TaskRef::Path("tasks/xxii/TSK-0001.md".to_string()),
            ),
            ("TSK-0001", TaskRef::Code("TSK-0001".to_string())),
            ("tsk-0001", TaskRef::Code("TSK-0001".to_string())),
            ("S-13", TaskRef::Code("S-13".to_string())),
            ("notes/a.md", TaskRef::Path("notes/a.md".to_string())),
        ];
        for (input, expected) in cases {
            assert_eq!(classify_ref(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn classify_ref_trims_surrounding_whitespace() {
        assert_eq!(
            classify_ref("  tsk-0002  "),
            TaskRef::Code("TSK-0002".to_string())
        );
        assert_eq!(
            classify_ref(" notes/a.md "),
            TaskRef::Path("notes/a.md".to_string())
        );
    }

    /// Stand-in for a PATCH tool param struct with one tri-state field.
    #[derive(Debug, Deserialize, JsonSchema)]
    struct TriStateProbe {
        #[serde(default, deserialize_with = "deserialize_tri_state")]
        #[schemars(with = "Option<String>")]
        cycle: Option<Option<String>>,
    }

    fn probe(body: serde_json::Value) -> Option<Option<String>> {
        serde_json::from_value::<TriStateProbe>(body).unwrap().cycle
    }

    #[test]
    fn tri_state_absent_field_means_keep() {
        assert_eq!(probe(json!({})), None);
    }

    #[test]
    fn tri_state_null_means_clear() {
        assert_eq!(probe(json!({"cycle": null})), Some(None));
    }

    #[test]
    fn tri_state_value_means_set() {
        assert_eq!(
            probe(json!({"cycle": "S-13"})),
            Some(Some("S-13".to_string()))
        );
    }

    #[test]
    fn normalize_tri_state_turns_empty_string_into_clear() {
        assert_eq!(normalize_tri_state(probe(json!({"cycle": ""}))), Some(None));
        assert_eq!(
            normalize_tri_state(probe(json!({"cycle": "   "}))),
            Some(None)
        );
    }

    #[test]
    fn normalize_tri_state_leaves_other_states_untouched() {
        assert_eq!(normalize_tri_state(None), None);
        assert_eq!(normalize_tri_state(Some(None)), Some(None));
        assert_eq!(
            normalize_tri_state(Some(Some("S-13".to_string()))),
            Some(Some("S-13".to_string()))
        );
    }

    #[test]
    fn tri_state_schema_stays_a_nullable_string() {
        /// Control struct: what schemars generates for a plain
        /// `Option<String>` field — the tri-state field must advertise the
        /// same schema despite its `Option<Option<String>>` Rust type.
        #[derive(JsonSchema)]
        struct Control {
            #[expect(dead_code)]
            cycle: Option<String>,
        }

        let probe_schema = serde_json::to_value(schemars::schema_for!(TriStateProbe)).unwrap();
        let control_schema = serde_json::to_value(schemars::schema_for!(Control)).unwrap();
        // `#[serde(default)]` adds a `"default": null` alongside; the type
        // itself must match the plain nullable string exactly.
        assert_eq!(
            probe_schema["properties"]["cycle"]["type"],
            control_schema["properties"]["cycle"]["type"]
        );
        assert_eq!(
            probe_schema["properties"]["cycle"]["type"],
            json!(["string", "null"])
        );
    }
}
