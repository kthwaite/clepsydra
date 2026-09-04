//! The Task Patch: the Task Fields rules behind one pure interface
//! (CONTEXT.md: Task Fields, Task Patch).
//!
//! [`apply_task_patch`] is the core: given a Task's `PageMeta`, a
//! [`TaskPatch`] and a [`BoardLookups`] snapshot of the index facts the rules
//! need, it validates every field and then applies every field. Nothing in
//! this file touches the index, the filesystem, or the clock, so the whole
//! rule set is testable through this one interface. [`plan_task_patch`] and
//! [`new_task_meta`] wrap the core for the PATCH and POST handlers.
#![allow(dead_code)]

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use rusqlite::params;

use crate::api::AppState;
use crate::api::error::ApiError;
use crate::vault::board_vocab::{DEFAULT_PRIORITY, DEFAULT_STATUS};
use crate::vault::code::{self, CodeLookup};
use crate::vault::kind::Kind;
use crate::vault::mutation_coordinator::{ProjectAssignment, UpdatePageCommand};
use crate::vault::page::{Page, PageMeta};

use super::{COLUMNS, CreateTaskRequest, PRIORITIES, PatchTaskRequest, code_stems};

/// The Cycle sentinel that means "no Cycle" (Backlog) on any write.
pub(crate) const BACKLOG: &str = "BACKLOG";

/// One Task Field change.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum FieldChange {
    #[default]
    Keep,
    Clear,
    Set(String),
}

impl FieldChange {
    /// From a PATCH tri-state: absent keeps, `null` clears, a value sets.
    /// An empty or whitespace-only value clears.
    pub(crate) fn from_tri_state(field: Option<Option<String>>) -> Self {
        match field {
            None => FieldChange::Keep,
            Some(None) => FieldChange::Clear,
            Some(Some(value)) if value.trim().is_empty() => FieldChange::Clear,
            Some(Some(value)) => FieldChange::Set(value),
        }
    }

    /// From a create field: absent keeps (the field stays unset), a value
    /// sets. An empty or whitespace-only value is treated as absent.
    pub(crate) fn from_create(field: Option<String>) -> Self {
        match field {
            Some(value) if !value.trim().is_empty() => FieldChange::Set(value),
            _ => FieldChange::Keep,
        }
    }
}

/// A Task Patch: every clearable Task Field is kept, cleared, or set. Title,
/// tags, status and priority cannot be cleared, so they are plain options.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TaskPatch {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub project: FieldChange,
    pub cycle: FieldChange,
    pub assignee: FieldChange,
    pub estimate: FieldChange,
    pub due: FieldChange,
    pub start: FieldChange,
    pub hold: FieldChange,
    pub link: FieldChange,
}

impl From<PatchTaskRequest> for TaskPatch {
    fn from(body: PatchTaskRequest) -> Self {
        TaskPatch {
            title: body.title,
            tags: body.tags,
            status: body.status,
            priority: body.priority,
            // The Project wire sentinel: "" clears, any other value sets.
            project: match body.project {
                None => FieldChange::Keep,
                Some(slug) if slug.is_empty() => FieldChange::Clear,
                Some(slug) => FieldChange::Set(slug),
            },
            cycle: FieldChange::from_tri_state(body.cycle),
            assignee: FieldChange::from_tri_state(body.assignee),
            estimate: FieldChange::from_tri_state(body.estimate),
            due: FieldChange::from_tri_state(body.due),
            start: FieldChange::from_tri_state(body.start),
            hold: FieldChange::from_tri_state(body.hold),
            link: FieldChange::from_tri_state(body.link),
        }
    }
}

impl From<&CreateTaskRequest> for TaskPatch {
    fn from(body: &CreateTaskRequest) -> Self {
        TaskPatch {
            title: Some(body.title.clone()),
            tags: body.tags.clone(),
            status: body.status.clone(),
            priority: body.priority.clone(),
            // An empty Project on create means none; anything else is
            // validated as a slug.
            project: match body.project.as_deref() {
                None | Some("") => FieldChange::Keep,
                Some(slug) => FieldChange::Set(slug.to_string()),
            },
            cycle: FieldChange::from_create(body.cycle.clone()),
            assignee: FieldChange::from_create(body.assignee.clone()),
            estimate: FieldChange::from_create(body.estimate.clone()),
            due: FieldChange::from_create(body.due.clone()),
            start: FieldChange::from_create(body.start.clone()),
            hold: FieldChange::Keep,
            link: FieldChange::from_create(body.link.clone()),
        }
    }
}

/// The index facts the Task Fields rules need, loaded once per request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BoardLookups {
    /// Filename stems of every CYCLE page — these are the Cycle Codes.
    pub cycle_stems: BTreeSet<String>,
    /// Every Project slug some PROJECT page declares.
    pub project_slugs: BTreeSet<String>,
}

impl BoardLookups {
    pub(crate) async fn load(state: &AppState) -> Result<Self, ApiError> {
        state
            .index
            .with_index(|index, _vault| {
                let conn = index.connection();
                let cycle_stems = code_stems(conn, Kind::Cycle)?;
                let mut statement = conn.prepare(
                    "SELECT DISTINCT project FROM pages \
                     WHERE kind = ?1 AND project IS NOT NULL AND project != ''",
                )?;
                let project_slugs = statement
                    .query_map(params![Kind::Project.as_str()], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<BTreeSet<String>, _>>()?;
                Ok::<_, rusqlite::Error>(BoardLookups {
                    cycle_stems,
                    project_slugs,
                })
            })
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?
            .map_err(|error| ApiError::internal(error.to_string()))
    }
}

/// Why a Task Patch was refused. Every variant is a client error; the
/// messages live in the `ApiError` mapping below and match what the handlers
/// have always returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TaskPatchError {
    UnknownStatus(String),
    UnknownPriority(String),
    UnknownCycle(String),
    AmbiguousCycle {
        input: String,
        candidates: Vec<String>,
    },
    InvalidProjectSlug {
        slug: String,
        reason: String,
    },
    UnknownProject(String),
}

impl From<TaskPatchError> for ApiError {
    fn from(error: TaskPatchError) -> Self {
        match error {
            TaskPatchError::UnknownStatus(status) => ApiError::bad_request(format!(
                "unknown status: '{status}'; valid values: {}",
                COLUMNS
                    .iter()
                    .map(|&(id, _, _)| id)
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            TaskPatchError::UnknownPriority(priority) => ApiError::bad_request(format!(
                "unknown priority: '{priority}'; valid values: {}",
                PRIORITIES.join(", ")
            )),
            TaskPatchError::UnknownCycle(input) => ApiError::bad_request(format!(
                "unknown cycle '{input}'; must match an existing cycle code or a unique prefix of one"
            )),
            TaskPatchError::AmbiguousCycle { input, candidates } => ApiError::bad_request(format!(
                "ambiguous cycle prefix '{input}': candidates {}",
                candidates.join(", ")
            )),
            TaskPatchError::InvalidProjectSlug { reason, .. } => ApiError::bad_request(reason),
            TaskPatchError::UnknownProject(slug) => crate::api::projects::unknown_project(&slug),
        }
    }
}

/// What the coordinator needs beyond the new meta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Applied {
    pub project: ProjectAssignment,
    /// Whether metadata projection must run: true iff the Project changed.
    pub reconcile: bool,
}

/// Validate every rule, then apply every field. Rules, in order: status and
/// priority must be board vocabulary; a set Cycle is `BACKLOG` (clears) or
/// resolves to exactly one Code; a set Project is a valid slug some PROJECT
/// page declares. `meta` is untouched when any rule fails. `updated_at`
/// becomes `now`.
pub(crate) fn apply_task_patch(
    meta: &mut PageMeta,
    patch: &TaskPatch,
    lookups: &BoardLookups,
    now: DateTime<Utc>,
) -> Result<Applied, TaskPatchError> {
    if let Some(status) = &patch.status
        && !COLUMNS.iter().any(|&(id, _, _)| id == status)
    {
        return Err(TaskPatchError::UnknownStatus(status.clone()));
    }
    if let Some(priority) = &patch.priority
        && !PRIORITIES.contains(&priority.as_str())
    {
        return Err(TaskPatchError::UnknownPriority(priority.clone()));
    }
    let cycle = match &patch.cycle {
        FieldChange::Set(input) if input == BACKLOG => FieldChange::Clear,
        FieldChange::Set(input) => {
            match code::resolve_prefix(lookups.cycle_stems.iter().map(String::as_str), input) {
                CodeLookup::Found(canonical) => FieldChange::Set(canonical),
                CodeLookup::NotFound => return Err(TaskPatchError::UnknownCycle(input.clone())),
                CodeLookup::Ambiguous(candidates) => {
                    return Err(TaskPatchError::AmbiguousCycle {
                        input: input.clone(),
                        candidates,
                    });
                }
            }
        }
        other => other.clone(),
    };
    let applied = match &patch.project {
        FieldChange::Keep => Applied {
            project: ProjectAssignment::Unchanged,
            reconcile: false,
        },
        FieldChange::Clear => Applied {
            project: ProjectAssignment::Clear,
            reconcile: true,
        },
        FieldChange::Set(slug) => {
            crate::vault::project::validate_slug(slug).map_err(|error| {
                TaskPatchError::InvalidProjectSlug {
                    slug: slug.clone(),
                    reason: error.to_string(),
                }
            })?;
            if !lookups.project_slugs.contains(slug) {
                return Err(TaskPatchError::UnknownProject(slug.clone()));
            }
            Applied {
                project: ProjectAssignment::Set(slug.clone()),
                reconcile: true,
            }
        }
    };

    // Every rule passed: now change the meta.
    if let Some(title) = &patch.title {
        meta.title = Some(title.clone());
    }
    if let Some(tags) = &patch.tags {
        meta.tags = tags.clone();
    }
    if let Some(status) = &patch.status {
        set_field(meta, "status", status);
    }
    if let Some(priority) = &patch.priority {
        set_field(meta, "priority", priority);
    }
    apply_field(meta, "cycle", &cycle);
    apply_field(meta, "assignee", &patch.assignee);
    apply_field(meta, "estimate", &patch.estimate);
    apply_field(meta, "due", &patch.due);
    apply_field(meta, "start", &patch.start);
    apply_field(meta, "hold", &patch.hold);
    apply_field(meta, "link", &patch.link);
    match &applied.project {
        ProjectAssignment::Unchanged => {}
        ProjectAssignment::Clear => meta.project = None,
        ProjectAssignment::Set(slug) => meta.project = Some(slug.clone()),
    }
    meta.updated_at = Some(now);
    Ok(applied)
}

/// Plan a PATCH: the Task page as read from disk plus the patch become the
/// coordinator command. `page.raw_content` is the stale-write guard.
pub(crate) fn plan_task_patch(
    page: Page,
    patch: &TaskPatch,
    lookups: &BoardLookups,
    now: DateTime<Utc>,
) -> Result<UpdatePageCommand, TaskPatchError> {
    let Page {
        path,
        mut meta,
        body,
        raw_content,
    } = page;
    let applied = apply_task_patch(&mut meta, patch, lookups, now)?;
    Ok(UpdatePageCommand {
        path,
        expected_content: raw_content,
        meta,
        body,
        project: applied.project,
        reconcile: applied.reconcile,
    })
}

/// Plan a create: a fresh TASK meta with the default status and priority,
/// then the patch on top. The handler mints the Code and builds the path
/// afterwards, so a refused create never consumes a Code.
pub(crate) fn new_task_meta(
    patch: &TaskPatch,
    lookups: &BoardLookups,
    now: DateTime<Utc>,
) -> Result<PageMeta, TaskPatchError> {
    let mut meta = PageMeta::new();
    meta.kind = Some(Kind::Task);
    set_field(&mut meta, "status", DEFAULT_STATUS);
    set_field(&mut meta, "priority", DEFAULT_PRIORITY);
    apply_task_patch(&mut meta, patch, lookups, now)?;
    Ok(meta)
}

fn set_field(meta: &mut PageMeta, key: &str, value: &str) {
    meta.extra
        .insert(key.to_string(), toml::Value::String(value.to_string()));
}

fn apply_field(meta: &mut PageMeta, key: &str, change: &FieldChange) {
    match change {
        FieldChange::Keep => {}
        FieldChange::Clear => {
            meta.extra.remove(key);
        }
        FieldChange::Set(value) => set_field(meta, key, value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 4, 12, 0, 0).unwrap()
    }

    fn lookups() -> BoardLookups {
        BoardLookups {
            cycle_stems: ["S-13", "S-calm-heron-2xm9p", "S-calm-otter-9k2ma"]
                .into_iter()
                .map(String::from)
                .collect(),
            project_slugs: ["falls", "ops"].into_iter().map(String::from).collect(),
        }
    }

    /// A Task as it sits on disk: in FIELD, P0, in Cycle S-13, no Project.
    fn task_meta() -> PageMeta {
        let mut meta = PageMeta::new();
        meta.kind = Some(Kind::Task);
        meta.title = Some("FREEZE LEGACY SYNC WRITES".into());
        meta.tags = vec!["infra".into()];
        set_field(&mut meta, "status", "FIELD");
        set_field(&mut meta, "priority", "P0");
        set_field(&mut meta, "cycle", "S-13");
        set_field(&mut meta, "assignee", "kit");
        meta
    }

    fn extra(meta: &PageMeta, key: &str) -> Option<String> {
        meta.extra
            .get(key)
            .and_then(toml::Value::as_str)
            .map(str::to_string)
    }

    fn patch_request(body: serde_json::Value) -> PatchTaskRequest {
        serde_json::from_value(body).expect("valid PatchTaskRequest")
    }

    fn create_request(body: serde_json::Value) -> CreateTaskRequest {
        serde_json::from_value(body).expect("valid CreateTaskRequest")
    }

    // -- FieldChange conversions ------------------------------------------

    #[test]
    fn from_tri_state_maps_absent_null_value_and_blank() {
        assert_eq!(FieldChange::from_tri_state(None), FieldChange::Keep);
        assert_eq!(FieldChange::from_tri_state(Some(None)), FieldChange::Clear);
        assert_eq!(
            FieldChange::from_tri_state(Some(Some("kit".into()))),
            FieldChange::Set("kit".into())
        );
        assert_eq!(
            FieldChange::from_tri_state(Some(Some("".into()))),
            FieldChange::Clear
        );
        assert_eq!(
            FieldChange::from_tri_state(Some(Some("   ".into()))),
            FieldChange::Clear
        );
    }

    #[test]
    fn from_create_maps_absent_blank_and_value() {
        assert_eq!(FieldChange::from_create(None), FieldChange::Keep);
        assert_eq!(FieldChange::from_create(Some("".into())), FieldChange::Keep);
        assert_eq!(
            FieldChange::from_create(Some("  ".into())),
            FieldChange::Keep
        );
        assert_eq!(
            FieldChange::from_create(Some("kit".into())),
            FieldChange::Set("kit".into())
        );
    }

    #[test]
    fn patch_request_converts_with_the_project_sentinel() {
        let patch = TaskPatch::from(patch_request(json!({
            "title": "T", "status": "REVIEW", "project": "",
            "cycle": null, "assignee": "  ", "due": "2026-09-30", "tags": ["a"]
        })));
        assert_eq!(patch.title.as_deref(), Some("T"));
        assert_eq!(patch.status.as_deref(), Some("REVIEW"));
        assert_eq!(patch.priority, None);
        assert_eq!(patch.project, FieldChange::Clear);
        assert_eq!(patch.cycle, FieldChange::Clear);
        assert_eq!(patch.assignee, FieldChange::Clear);
        assert_eq!(patch.due, FieldChange::Set("2026-09-30".into()));
        assert_eq!(patch.start, FieldChange::Keep);
        assert_eq!(patch.hold, FieldChange::Keep);
        assert_eq!(patch.tags, Some(vec!["a".to_string()]));

        let patch = TaskPatch::from(patch_request(json!({ "project": "ops" })));
        assert_eq!(patch.project, FieldChange::Set("ops".into()));
        let patch = TaskPatch::from(patch_request(json!({})));
        assert_eq!(patch.project, FieldChange::Keep);
    }

    #[test]
    fn create_request_converts_with_empty_as_absent() {
        let patch = TaskPatch::from(&create_request(json!({
            "title": "New", "project": "ops", "cycle": "", "assignee": "kit",
            "estimate": "  ", "link": "[[Spec]]"
        })));
        assert_eq!(patch.title.as_deref(), Some("New"));
        assert_eq!(patch.status, None);
        assert_eq!(patch.project, FieldChange::Set("ops".into()));
        assert_eq!(patch.cycle, FieldChange::Keep);
        assert_eq!(patch.assignee, FieldChange::Set("kit".into()));
        assert_eq!(patch.estimate, FieldChange::Keep);
        assert_eq!(patch.link, FieldChange::Set("[[Spec]]".into()));
        assert_eq!(patch.hold, FieldChange::Keep, "create has no hold field");

        let patch = TaskPatch::from(&create_request(json!({ "title": "x", "project": "" })));
        assert_eq!(
            patch.project,
            FieldChange::Keep,
            "an empty project on create means none"
        );
    }

    // -- apply_task_patch: vocabulary ----------------------------------------

    #[test]
    fn apply_rejects_unknown_status_and_priority() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            status: Some("BOGUS".into()),
            ..TaskPatch::default()
        };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownStatus("BOGUS".into()))
        );
        let patch = TaskPatch {
            priority: Some("P9".into()),
            ..TaskPatch::default()
        };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownPriority("P9".into()))
        );
    }

    #[test]
    fn apply_sets_status_and_priority() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            status: Some("SEALED".into()),
            priority: Some("P3".into()),
            ..TaskPatch::default()
        };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "status").as_deref(), Some("SEALED"));
        assert_eq!(extra(&meta, "priority").as_deref(), Some("P3"));
    }

    // -- apply_task_patch: Cycle ----------------------------------------------

    #[test]
    fn apply_backlog_sentinel_clears_the_cycle() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            cycle: FieldChange::Set(BACKLOG.into()),
            ..TaskPatch::default()
        };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "cycle"), None);
    }

    #[test]
    fn apply_resolves_a_cycle_prefix_to_its_canonical_code() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            cycle: FieldChange::Set("s-calm-h".into()),
            ..TaskPatch::default()
        };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "cycle").as_deref(), Some("S-calm-heron-2xm9p"));
    }

    #[test]
    fn apply_rejects_unknown_and_ambiguous_cycles() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            cycle: FieldChange::Set("S-99".into()),
            ..TaskPatch::default()
        };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownCycle("S-99".into()))
        );
        let patch = TaskPatch {
            cycle: FieldChange::Set("S-calm".into()),
            ..TaskPatch::default()
        };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::AmbiguousCycle {
                input: "S-calm".into(),
                candidates: vec!["S-calm-heron-2xm9p".into(), "S-calm-otter-9k2ma".into()],
            })
        );
    }

    // -- apply_task_patch: clearable fields ----------------------------------

    #[test]
    fn apply_clear_removes_and_keep_preserves_a_task_field() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            assignee: FieldChange::Clear,
            ..TaskPatch::default()
        };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "assignee"), None);
        assert_eq!(
            extra(&meta, "cycle").as_deref(),
            Some("S-13"),
            "untouched field kept"
        );

        let mut meta = task_meta();
        apply_task_patch(&mut meta, &TaskPatch::default(), &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "assignee").as_deref(), Some("kit"));
    }

    #[test]
    fn apply_sets_every_clearable_task_field() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            estimate: FieldChange::Set("3d".into()),
            due: FieldChange::Set("2026-09-30".into()),
            start: FieldChange::Set("2026-09-10".into()),
            hold: FieldChange::Set("waiting on legal".into()),
            link: FieldChange::Set("[[Spec]]".into()),
            ..TaskPatch::default()
        };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "estimate").as_deref(), Some("3d"));
        assert_eq!(extra(&meta, "due").as_deref(), Some("2026-09-30"));
        assert_eq!(extra(&meta, "start").as_deref(), Some("2026-09-10"));
        assert_eq!(extra(&meta, "hold").as_deref(), Some("waiting on legal"));
        assert_eq!(extra(&meta, "link").as_deref(), Some("[[Spec]]"));
    }

    // -- apply_task_patch: Project -------------------------------------------

    #[test]
    fn apply_project_set_requires_a_declared_valid_slug() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            project: FieldChange::Set("ghost".into()),
            ..TaskPatch::default()
        };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownProject("ghost".into()))
        );
        let patch = TaskPatch {
            project: FieldChange::Set("../x".into()),
            ..TaskPatch::default()
        };
        assert!(matches!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::InvalidProjectSlug { ref slug, .. }) if slug == "../x"
        ));
    }

    #[test]
    fn apply_project_set_and_clear_reconcile_but_keep_does_not() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            project: FieldChange::Set("ops".into()),
            ..TaskPatch::default()
        };
        let applied = apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(
            applied,
            Applied {
                project: ProjectAssignment::Set("ops".into()),
                reconcile: true
            }
        );
        assert_eq!(meta.project.as_deref(), Some("ops"));

        let patch = TaskPatch {
            project: FieldChange::Clear,
            ..TaskPatch::default()
        };
        let applied = apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(
            applied,
            Applied {
                project: ProjectAssignment::Clear,
                reconcile: true
            }
        );
        assert_eq!(meta.project, None);

        let applied =
            apply_task_patch(&mut meta, &TaskPatch::default(), &lookups(), now()).unwrap();
        assert_eq!(
            applied,
            Applied {
                project: ProjectAssignment::Unchanged,
                reconcile: false
            }
        );
    }

    // -- apply_task_patch: title, tags, timestamp, atomicity ------------------

    #[test]
    fn apply_updates_title_tags_and_updated_at() {
        let mut meta = task_meta();
        let patch = TaskPatch {
            title: Some("Renamed".into()),
            tags: Some(vec!["x".into(), "y".into()]),
            ..TaskPatch::default()
        };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Renamed"));
        assert_eq!(meta.tags, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(meta.updated_at, Some(now()));
    }

    #[test]
    fn apply_changes_nothing_when_any_rule_fails() {
        let mut meta = task_meta();
        let before = meta.clone();
        let patch = TaskPatch {
            title: Some("Renamed".into()),
            status: Some("SEALED".into()),
            project: FieldChange::Set("ghost".into()),
            ..TaskPatch::default()
        };
        assert!(apply_task_patch(&mut meta, &patch, &lookups(), now()).is_err());
        // PageMeta derives Clone but not PartialEq: compare the parts a patch touches.
        assert_eq!(meta.title, before.title);
        assert_eq!(meta.tags, before.tags);
        assert_eq!(meta.project, before.project);
        assert_eq!(meta.extra, before.extra);
        assert_eq!(meta.updated_at, before.updated_at);
    }

    #[test]
    fn apply_reports_the_first_failing_rule_in_order() {
        // status, then priority, then cycle, then project.
        let mut meta = task_meta();
        let patch = TaskPatch {
            status: Some("BOGUS".into()),
            priority: Some("P9".into()),
            cycle: FieldChange::Set("S-99".into()),
            project: FieldChange::Set("ghost".into()),
            ..TaskPatch::default()
        };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownStatus("BOGUS".into()))
        );
    }

    // -- planners -------------------------------------------------------------

    #[test]
    fn plan_task_patch_preserves_path_body_and_stale_guard() {
        let raw = "---\ntitle: T\n---\nbody text\n".to_string();
        let page = Page {
            path: crate::vault::path::VaultPath::new("tasks/TSK-brave-finch-7q3zd.md").unwrap(),
            meta: task_meta(),
            body: "body text\n".into(),
            raw_content: raw.clone(),
        };
        let patch = TaskPatch {
            project: FieldChange::Set("ops".into()),
            ..TaskPatch::default()
        };
        let command = plan_task_patch(page, &patch, &lookups(), now()).unwrap();
        assert_eq!(command.path.as_str(), "tasks/TSK-brave-finch-7q3zd.md");
        assert_eq!(command.expected_content, raw);
        assert_eq!(command.body, "body text\n");
        assert_eq!(command.meta.project.as_deref(), Some("ops"));
        assert_eq!(command.project, ProjectAssignment::Set("ops".into()));
        assert!(command.reconcile);
    }

    #[test]
    fn new_task_meta_applies_defaults_then_the_patch() {
        let meta = new_task_meta(&TaskPatch::default(), &lookups(), now()).unwrap();
        assert_eq!(meta.kind, Some(Kind::Task));
        assert_eq!(extra(&meta, "status").as_deref(), Some(DEFAULT_STATUS));
        assert_eq!(extra(&meta, "priority").as_deref(), Some(DEFAULT_PRIORITY));
        assert_eq!(meta.updated_at, Some(now()));
        assert_eq!(meta.project, None);

        let patch = TaskPatch {
            title: Some("New".into()),
            status: Some("TRIAGE".into()),
            cycle: FieldChange::Set("s-13".into()),
            project: FieldChange::Set("falls".into()),
            ..TaskPatch::default()
        };
        let meta = new_task_meta(&patch, &lookups(), now()).unwrap();
        assert_eq!(meta.title.as_deref(), Some("New"));
        assert_eq!(extra(&meta, "status").as_deref(), Some("TRIAGE"));
        assert_eq!(extra(&meta, "priority").as_deref(), Some(DEFAULT_PRIORITY));
        assert_eq!(extra(&meta, "cycle").as_deref(), Some("S-13"));
        assert_eq!(meta.project.as_deref(), Some("falls"));
    }

    // -- error mapping --------------------------------------------------------

    #[test]
    fn errors_map_to_bad_request_with_the_established_messages() {
        let error: ApiError = TaskPatchError::UnknownStatus("BOGUS".into()).into();
        assert_eq!(error.status, 400);
        assert_eq!(
            error.error,
            "unknown status: 'BOGUS'; valid values: INTAKE, TRIAGE, FIELD, REVIEW, SEALED"
        );
        let error: ApiError = TaskPatchError::UnknownPriority("P9".into()).into();
        assert_eq!(
            error.error,
            "unknown priority: 'P9'; valid values: P0, P1, P2, P3"
        );
        let error: ApiError = TaskPatchError::UnknownCycle("S-99".into()).into();
        assert_eq!(
            error.error,
            "unknown cycle 'S-99'; must match an existing cycle code or a unique prefix of one"
        );
        let error: ApiError = TaskPatchError::AmbiguousCycle {
            input: "S-calm".into(),
            candidates: vec!["S-calm-heron-2xm9p".into(), "S-calm-otter-9k2ma".into()],
        }
        .into();
        assert_eq!(
            error.error,
            "ambiguous cycle prefix 'S-calm': candidates S-calm-heron-2xm9p, S-calm-otter-9k2ma"
        );
        let error: ApiError = TaskPatchError::UnknownProject("ghost".into()).into();
        assert_eq!(error.status, 400);
        assert!(
            error.error.starts_with("unknown project: ghost;"),
            "{}",
            error.error
        );
        let error: ApiError = TaskPatchError::InvalidProjectSlug {
            slug: "../x".into(),
            reason: "bad slug".into(),
        }
        .into();
        assert_eq!(error.status, 400);
        assert_eq!(error.error, "bad slug");
    }
}
