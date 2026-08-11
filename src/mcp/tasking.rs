//! Shared parameter plumbing for the MCP tasking tools.
//!
//! The board PATCH endpoints distinguish three states per clearable field:
//! absent (keep), JSON null (clear), and a value (set). This module carries
//! that tri-state through MCP param structs and classifies the free-form
//! task/cycle references the tools accept (UUID, vault path, or board code).
//! It mirrors the semantics of `src/api/board` without importing from the
//! HTTP layer — the MCP side only speaks to the server over HTTP.

use serde::{Deserialize, Deserializer};
use serde_json::Value;
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

/// Which board collection a code resolves against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardKind {
    Task,
    Cycle,
}

impl BoardKind {
    /// The `BoardResponse` array carrying this kind's entries.
    fn collection(self) -> &'static str {
        match self {
            BoardKind::Task => "tasks",
            BoardKind::Cycle => "cycles",
        }
    }

    /// The noun used in agent-facing error messages.
    fn noun(self) -> &'static str {
        match self {
            BoardKind::Task => "task",
            BoardKind::Cycle => "cycle",
        }
    }
}

/// Find the page UUID for `code` in a `GET /board` response, matching the
/// `code` field of the kind's collection (`tasks` or `cycles`)
/// case-insensitively. A miss names the unknown code and points at
/// vault_board for the live code list.
pub fn find_board_id(board: &Value, kind: BoardKind, code: &str) -> Result<String, String> {
    board
        .get(kind.collection())
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| {
            entry
                .get("code")
                .and_then(Value::as_str)
                .is_some_and(|c| c.eq_ignore_ascii_case(code))
        })
        .and_then(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "no {} with code '{code}' — list codes with vault_board",
                kind.noun()
            )
        })
}

/// Extract the page UUID (`meta.id`) from a `GET /pages/{path}` response.
pub fn page_meta_id(value: &Value, path: &str) -> Result<String, String> {
    value
        .get("meta")
        .and_then(|meta| meta.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("page response for {path} carried no meta.id field"))
}

/// Insert a normalized tri-state field into a PATCH body: absent = omit the
/// key entirely (keep), cleared = JSON null (clear), set = the string value.
pub fn insert_tri_state(
    body: &mut serde_json::Map<String, Value>,
    key: &str,
    field: Option<Option<String>>,
) {
    match field {
        None => {}
        Some(None) => {
            body.insert(key.to_string(), Value::Null);
        }
        Some(Some(value)) => {
            body.insert(key.to_string(), Value::String(value));
        }
    }
}

/// Resolve the `project` / `clear_project` parameter pair into the PATCH
/// body's `project` value: `clear_project` maps to the API's empty-string
/// clear sentinel, and combining it with an explicit project is a
/// contradiction that errors instead of guessing.
pub fn resolve_project_patch(
    project: Option<String>,
    clear_project: bool,
) -> Result<Option<String>, String> {
    match (project, clear_project) {
        (Some(_), true) => Err(
            "'project' and clear_project: true are mutually exclusive — pass one or the other"
                .to_string(),
        ),
        (None, true) => Ok(Some(String::new())),
        (project, false) => Ok(project),
    }
}

/// Filter a board response in place to one project: `tasks` and `operations`
/// keep only entries declaring exactly `project`; `columns` and `cycles` are
/// always left untouched.
pub fn filter_board_project(board: &mut Value, project: &str) {
    for key in ["tasks", "operations"] {
        if let Some(entries) = board.get_mut(key).and_then(Value::as_array_mut) {
            entries.retain(|entry| entry.get("project").and_then(Value::as_str) == Some(project));
        }
    }
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

    /// A minimal `GET /board` response for resolution tests.
    fn board_fixture() -> serde_json::Value {
        json!({
            "columns": [{"id": "INTAKE"}],
            "operations": [
                {"id": "op-1", "code": "SIG3", "project": "sigil"},
                {"id": "op-2", "code": "XXII", "project": "xxii"},
            ],
            "cycles": [
                {"id": "cy-13", "code": "S-13", "state": "ACTIVE"},
            ],
            "tasks": [
                {"id": "tk-1", "code": "TSK-0001", "project": "xxii"},
                {"id": "tk-2", "code": "TSK-0002", "project": null},
            ],
        })
    }

    #[test]
    fn find_board_id_matches_codes_case_insensitively() {
        let board = board_fixture();
        assert_eq!(
            find_board_id(&board, BoardKind::Task, "TSK-0001").unwrap(),
            "tk-1"
        );
        assert_eq!(
            find_board_id(&board, BoardKind::Task, "tsk-0002").unwrap(),
            "tk-2"
        );
        assert_eq!(
            find_board_id(&board, BoardKind::Cycle, "s-13").unwrap(),
            "cy-13"
        );
    }

    #[test]
    fn find_board_id_miss_names_the_code_and_hints_at_vault_board() {
        let board = board_fixture();
        let err = find_board_id(&board, BoardKind::Task, "TSK-9999").unwrap_err();
        assert!(err.contains("no task with code 'TSK-9999'"), "{err}");
        assert!(err.contains("vault_board"), "{err}");

        // A task code never resolves against cycles and vice versa.
        let err = find_board_id(&board, BoardKind::Cycle, "TSK-0001").unwrap_err();
        assert!(err.contains("no cycle with code 'TSK-0001'"), "{err}");
    }

    #[test]
    fn page_meta_id_reads_the_pages_response_shape() {
        let page = json!({"path": "tasks/TSK-0001.md", "meta": {"id": "abc-123"}});
        assert_eq!(page_meta_id(&page, "tasks/TSK-0001.md").unwrap(), "abc-123");

        let err = page_meta_id(&json!({"path": "x.md"}), "x.md").unwrap_err();
        assert!(err.contains("no meta.id"), "{err}");
    }

    #[test]
    fn insert_tri_state_omits_nulls_and_sets_values() {
        let mut body = serde_json::Map::new();
        insert_tri_state(&mut body, "cycle", None);
        insert_tri_state(&mut body, "assignee", Some(None));
        insert_tri_state(&mut body, "due", Some(Some("2026-08-15".to_string())));
        assert_eq!(
            serde_json::Value::Object(body),
            json!({"assignee": null, "due": "2026-08-15"})
        );
    }

    #[test]
    fn resolve_project_patch_maps_clear_to_the_empty_string_sentinel() {
        assert_eq!(resolve_project_patch(None, false).unwrap(), None);
        assert_eq!(
            resolve_project_patch(Some("xxii".to_string()), false).unwrap(),
            Some("xxii".to_string())
        );
        assert_eq!(
            resolve_project_patch(None, true).unwrap(),
            Some(String::new())
        );
    }

    #[test]
    fn resolve_project_patch_rejects_project_combined_with_clear() {
        let err = resolve_project_patch(Some("xxii".to_string()), true).unwrap_err();
        assert!(err.contains("mutually exclusive"), "{err}");
    }

    #[test]
    fn filter_board_project_keeps_columns_and_cycles() {
        let mut board = board_fixture();
        filter_board_project(&mut board, "xxii");
        assert_eq!(board["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(board["tasks"][0]["code"], "TSK-0001");
        assert_eq!(board["operations"].as_array().unwrap().len(), 1);
        assert_eq!(board["operations"][0]["code"], "XXII");
        // Columns and cycles survive untouched.
        assert_eq!(board["columns"].as_array().unwrap().len(), 1);
        assert_eq!(board["cycles"].as_array().unwrap().len(), 1);
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
