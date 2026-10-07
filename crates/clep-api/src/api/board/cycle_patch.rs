//! The Cycle patch: the rules for changing a Cycle, behind one pure
//! interface (CONTEXT.md: Cycle).
//!
//! [`plan_cycle_patch`] takes a Cycle's `PageMeta`, a [`CyclePatch`] and the
//! [`BoardLookups`] snapshot. It validates `carry_to`, applies the field
//! changes, and picks the Tasks to carry over when the Cycle closes. Nothing
//! here touches the index, the filesystem, or the clock, apart from
//! [`load_cycle_tasks`], which feeds [`BoardLookups::load`]. The PATCH
//! handler reads the pages, plans, and executes the plan as one batch.

use chrono::{DateTime, Utc};
use rusqlite::params;

use crate::api::error::ApiError;
use crate::vault::kind::Kind;
use crate::vault::page::PageMeta;

use super::blockers::DONE_STATUS;
use super::task_patch::{BACKLOG, BoardLookups, CycleRefError};
use super::{CycleState, PatchCycleRequest, extra_str};

/// One Task that is in a Cycle, as the carry-over rule sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CycleTask {
    pub path: String,
    /// The Code of the Cycle the Task is in.
    pub cycle: String,
    /// The persisted `status`, or empty when absent.
    pub status: String,
}

/// Read every TASK page that names a Cycle, in path order.
pub(crate) fn load_cycle_tasks(
    conn: &rusqlite::Connection,
) -> Result<Vec<CycleTask>, rusqlite::Error> {
    let mut statement =
        conn.prepare("SELECT path, meta_json FROM pages WHERE kind = ?1 ORDER BY path")?;
    let rows = statement
        .query_map(params![Kind::Task.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(path, meta_json)| {
            let meta: serde_json::Value =
                serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);
            let cycle = extra_str(&meta, "cycle")?;
            let status = extra_str(&meta, "status").unwrap_or_default();
            Some(CycleTask {
                path,
                cycle,
                status,
            })
        })
        .collect())
}

/// A change to a Cycle. Absent fields are kept. `carry_to` is a Cycle
/// reference or [`BACKLOG`], and is only allowed when `state` closes the
/// Cycle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CyclePatch {
    pub state: Option<CycleState>,
    pub goal: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub carry_to: Option<String>,
}

impl CyclePatch {
    fn is_closing(&self) -> bool {
        self.state == Some(CycleState::Closed)
    }
}

impl TryFrom<PatchCycleRequest> for CyclePatch {
    type Error = CyclePatchError;

    fn try_from(body: PatchCycleRequest) -> Result<Self, Self::Error> {
        let state = body
            .state
            .as_deref()
            .map(|value| value.parse::<CycleState>())
            .transpose()
            .map_err(CyclePatchError::InvalidState)?;
        let patch = CyclePatch {
            state,
            goal: body.goal,
            start: body.start,
            end: body.end,
            carry_to: body.carry_to,
        };
        if patch.carry_to.is_some() && !patch.is_closing() {
            return Err(CyclePatchError::CarryWithoutClose);
        }
        Ok(patch)
    }
}

/// Why a Cycle patch was refused. Every variant is a client error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CyclePatchError {
    /// The `state` parse error.
    InvalidState(String),
    CarryWithoutClose,
    /// `carry_to` names no Cycle, or more than one.
    CarryTo(CycleRefError),
    /// `carry_to` names the Cycle being closed.
    SelfCarry,
}

impl From<CyclePatchError> for ApiError {
    fn from(error: CyclePatchError) -> Self {
        match error {
            CyclePatchError::InvalidState(error) => {
                ApiError::bad_request(format!("{error}; valid values: PLANNED, ACTIVE, CLOSED"))
            }
            CyclePatchError::CarryWithoutClose => {
                ApiError::bad_request("carry_to is only valid when state is CLOSED")
            }
            CyclePatchError::CarryTo(error) => error.into(),
            CyclePatchError::SelfCarry => {
                ApiError::bad_request("carry_to cannot reference the cycle being closed")
            }
        }
    }
}

/// Tasks moved out of a closing Cycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CarryOver {
    /// The Cycle Code the Tasks move to, or `None` for the Backlog.
    pub to: Option<String>,
    /// The Tasks' paths, in path order.
    pub task_paths: Vec<String>,
}

/// What a Cycle patch does.
#[derive(Debug, Clone)]
pub(crate) struct CyclePlan {
    /// The Cycle's new meta.
    pub meta: PageMeta,
    /// The Tasks to carry over, when the patch closes the Cycle with a
    /// `carry_to`.
    pub carry_over: Option<CarryOver>,
}

/// Plan a Cycle patch on the Cycle with Code `code`. `carry_to` must be
/// [`BACKLOG`] or resolve to exactly one Cycle other than this one. The
/// carried-over Tasks are this Cycle's Tasks that are not Done. `updated_at`
/// becomes `now`.
pub(crate) fn plan_cycle_patch(
    code: &str,
    mut meta: PageMeta,
    patch: &CyclePatch,
    lookups: &BoardLookups,
    now: DateTime<Utc>,
) -> Result<CyclePlan, CyclePatchError> {
    let carry_to = match patch.carry_to.as_deref() {
        None => None,
        Some(BACKLOG) => Some(None),
        Some(input) => {
            let target = lookups
                .resolve_cycle(input)
                .map_err(CyclePatchError::CarryTo)?;
            if target == code {
                return Err(CyclePatchError::SelfCarry);
            }
            Some(Some(target))
        }
    };

    if let Some(state) = patch.state {
        set_field(&mut meta, "state", state.as_str());
    }
    for (key, value) in [
        ("goal", &patch.goal),
        ("start", &patch.start),
        ("end", &patch.end),
    ] {
        if let Some(value) = value {
            set_field(&mut meta, key, value);
        }
    }
    meta.updated_at = Some(now);

    let carry_over = carry_to.filter(|_| patch.is_closing()).map(|to| CarryOver {
        to,
        task_paths: lookups
            .cycle_tasks
            .iter()
            .filter(|task| task.cycle == code && task.status != DONE_STATUS)
            .map(|task| task.path.clone())
            .collect(),
    });
    Ok(CyclePlan { meta, carry_over })
}

/// Move one carried-over Task's meta to `to` (`None` is the Backlog).
pub(crate) fn carry_task(meta: &mut PageMeta, to: Option<&str>, now: DateTime<Utc>) {
    match to {
        Some(cycle) => set_field(meta, "cycle", cycle),
        None => {
            meta.extra.remove("cycle");
        }
    }
    meta.updated_at = Some(now);
}

fn set_field(meta: &mut PageMeta, key: &str, value: &str) {
    meta.extra
        .insert(key.to_string(), toml::Value::String(value.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    const CODE: &str = "S-calm-heron-2xm9p";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 7, 12, 0, 0).unwrap()
    }

    fn task(path: &str, cycle: &str, status: &str) -> CycleTask {
        CycleTask {
            path: path.into(),
            cycle: cycle.into(),
            status: status.into(),
        }
    }

    fn lookups() -> BoardLookups {
        BoardLookups {
            cycle_stems: [CODE, "S-calm-otter-9k2ma", "S-quiet-wren-4kd8a"]
                .into_iter()
                .map(String::from)
                .collect(),
            cycle_tasks: vec![
                task("tasks/TSK-a.md", CODE, "FIELD"),
                task("tasks/TSK-b.md", "S-quiet-wren-4kd8a", "FIELD"),
                task("tasks/TSK-c.md", CODE, "SEALED"),
                task("tasks/ops/TSK-d.md", CODE, ""),
            ],
            ..Default::default()
        }
    }

    fn cycle_meta() -> PageMeta {
        let mut meta = PageMeta::new();
        meta.kind = Some(Kind::Cycle);
        meta.title = Some("Autumn".into());
        for (key, value) in [
            ("state", "ACTIVE"),
            ("start", "2026-10-01"),
            ("end", "2026-10-14"),
            ("goal", "ship"),
        ] {
            meta.extra
                .insert(key.into(), toml::Value::String(value.into()));
        }
        meta
    }

    fn extra(meta: &PageMeta, key: &str) -> Option<String> {
        meta.extra
            .get(key)
            .and_then(toml::Value::as_str)
            .map(str::to_string)
    }

    fn patch(body: serde_json::Value) -> Result<CyclePatch, CyclePatchError> {
        serde_json::from_value::<PatchCycleRequest>(body)
            .expect("valid PatchCycleRequest")
            .try_into()
    }

    fn plan(body: serde_json::Value) -> Result<CyclePlan, CyclePatchError> {
        plan_cycle_patch(CODE, cycle_meta(), &patch(body)?, &lookups(), now())
    }

    // -- request conversion ---------------------------------------------------

    #[test]
    fn request_parses_each_state() {
        for (wire, state) in [
            ("PLANNED", CycleState::Planned),
            ("ACTIVE", CycleState::Active),
            ("CLOSED", CycleState::Closed),
        ] {
            assert_eq!(patch(json!({ "state": wire })).unwrap().state, Some(state));
        }
        assert_eq!(patch(json!({})).unwrap(), CyclePatch::default());
    }

    #[test]
    fn request_rejects_an_unknown_state() {
        assert_eq!(
            patch(json!({ "state": "DONE" })),
            Err(CyclePatchError::InvalidState(
                "unknown state: 'DONE'".into()
            ))
        );
    }

    #[test]
    fn request_rejects_carry_to_unless_closing() {
        for body in [
            json!({ "carry_to": "BACKLOG" }),
            json!({ "state": "ACTIVE", "carry_to": "BACKLOG" }),
        ] {
            assert_eq!(patch(body), Err(CyclePatchError::CarryWithoutClose));
        }
    }

    // -- field changes ----------------------------------------------------------

    #[test]
    fn plan_sets_state_and_fields_and_stamps_updated_at() {
        let plan = plan(json!({
            "state": "CLOSED",
            "goal": "rest",
            "start": "2026-10-02",
            "end": "2026-10-15"
        }))
        .unwrap();
        assert_eq!(extra(&plan.meta, "state").as_deref(), Some("CLOSED"));
        assert_eq!(extra(&plan.meta, "goal").as_deref(), Some("rest"));
        assert_eq!(extra(&plan.meta, "start").as_deref(), Some("2026-10-02"));
        assert_eq!(extra(&plan.meta, "end").as_deref(), Some("2026-10-15"));
        assert_eq!(plan.meta.updated_at, Some(now()));
        assert_eq!(plan.carry_over, None);
    }

    #[test]
    fn plan_keeps_absent_fields() {
        let plan = plan(json!({})).unwrap();
        let mut expected = cycle_meta();
        expected.updated_at = Some(now());
        assert_eq!(plan.meta.extra, expected.extra);
        assert_eq!(plan.meta.title, expected.title);
        assert_eq!(plan.meta.updated_at, Some(now()));
    }

    #[test]
    fn plan_moves_between_open_states() {
        for wire in ["PLANNED", "ACTIVE"] {
            let plan = plan(json!({ "state": wire })).unwrap();
            assert_eq!(extra(&plan.meta, "state").as_deref(), Some(wire));
            assert_eq!(plan.carry_over, None);
        }
    }

    // -- carry_to ---------------------------------------------------------------

    #[test]
    fn plan_rejects_an_unknown_or_ambiguous_carry_to() {
        assert_eq!(
            plan(json!({ "state": "CLOSED", "carry_to": "S-nope" })).unwrap_err(),
            CyclePatchError::CarryTo(CycleRefError::Unknown("S-nope".into()))
        );
        assert_eq!(
            plan(json!({ "state": "CLOSED", "carry_to": "S-calm" })).unwrap_err(),
            CyclePatchError::CarryTo(CycleRefError::Ambiguous {
                input: "S-calm".into(),
                candidates: vec![CODE.into(), "S-calm-otter-9k2ma".into()],
            })
        );
    }

    #[test]
    fn plan_rejects_carrying_to_the_closing_cycle() {
        for carry_to in [CODE, "s-calm-heron"] {
            assert_eq!(
                plan(json!({ "state": "CLOSED", "carry_to": carry_to })).unwrap_err(),
                CyclePatchError::SelfCarry
            );
        }
    }

    #[test]
    fn plan_carries_this_cycles_unfinished_tasks_to_a_resolved_cycle() {
        let plan = plan(json!({ "state": "CLOSED", "carry_to": "s-quiet" })).unwrap();
        assert_eq!(
            plan.carry_over,
            Some(CarryOver {
                to: Some("S-quiet-wren-4kd8a".into()),
                task_paths: vec!["tasks/TSK-a.md".into(), "tasks/ops/TSK-d.md".into()],
            })
        );
        assert_eq!(extra(&plan.meta, "state").as_deref(), Some("CLOSED"));
    }

    #[test]
    fn plan_carries_to_the_backlog() {
        let plan = plan(json!({ "state": "CLOSED", "carry_to": "BACKLOG" })).unwrap();
        assert_eq!(
            plan.carry_over,
            Some(CarryOver {
                to: None,
                task_paths: vec!["tasks/TSK-a.md".into(), "tasks/ops/TSK-d.md".into()],
            })
        );
    }

    #[test]
    fn closing_without_carry_to_leaves_tasks_alone() {
        let plan = plan(json!({ "state": "CLOSED" })).unwrap();
        assert_eq!(plan.carry_over, None);
    }

    // -- carried Tasks ----------------------------------------------------------

    #[test]
    fn carry_task_sets_or_clears_the_cycle_and_stamps_updated_at() {
        let mut meta = PageMeta::new();
        meta.extra
            .insert("cycle".into(), toml::Value::String(CODE.into()));
        carry_task(&mut meta, Some("S-quiet-wren-4kd8a"), now());
        assert_eq!(extra(&meta, "cycle").as_deref(), Some("S-quiet-wren-4kd8a"));
        assert_eq!(meta.updated_at, Some(now()));

        carry_task(&mut meta, None, now());
        assert_eq!(extra(&meta, "cycle"), None);
    }

    // -- error mapping ----------------------------------------------------------

    #[test]
    fn errors_map_to_bad_request_with_the_established_messages() {
        let cases = [
            (
                CyclePatchError::InvalidState("unknown state: 'DONE'".into()),
                "unknown state: 'DONE'; valid values: PLANNED, ACTIVE, CLOSED",
            ),
            (
                CyclePatchError::CarryWithoutClose,
                "carry_to is only valid when state is CLOSED",
            ),
            (
                CyclePatchError::SelfCarry,
                "carry_to cannot reference the cycle being closed",
            ),
            (
                CyclePatchError::CarryTo(CycleRefError::Unknown("S-x".into())),
                "unknown cycle 'S-x'; must match an existing cycle code or a unique prefix of one",
            ),
        ];
        for (error, message) in cases {
            let error: ApiError = error.into();
            assert_eq!(error.status, 400);
            assert_eq!(error.error, message);
        }
    }
}
