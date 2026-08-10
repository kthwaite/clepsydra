//! Portable task state history stored in task frontmatter.
//!
//! `updated_at` describes the most recent edit, so it cannot be used as a
//! completion or cycle-transition timestamp. Tasking mutations persist compact
//! snapshots of the fields that affect telemetry. Legacy tasks are interpreted
//! once from their existing timestamps, then healed on their next mutation.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::vault::page::PageMeta;
use crate::vault::path::VaultPath;
use crate::vault::toml_json::toml_value_to_json;
use crate::vault::toml_patch::{FrontmatterEdits, splice_frontmatter};
use crate::vault::{kind::Kind, page::parse_frontmatter, page::write_page_content};

pub(crate) const TASK_HISTORY_KEY: &str = "task_history";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct TaskHistoryEvent {
    pub at: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

impl TaskHistoryEvent {
    pub(crate) fn timestamp(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.at)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
    }

    fn same_state(&self, other: &Self) -> bool {
        self.status == other.status && self.cycle == other.cycle && self.project == other.project
    }
}

fn extra_string(meta: &PageMeta, key: &str) -> Option<String> {
    meta.extra
        .get(key)
        .and_then(toml::Value::as_str)
        .map(str::to_string)
}

fn snapshot(meta: &PageMeta, at: DateTime<Utc>) -> TaskHistoryEvent {
    TaskHistoryEvent {
        at: at.to_rfc3339(),
        status: extra_string(meta, "status").unwrap_or_else(|| "INTAKE".to_string()),
        cycle: extra_string(meta, "cycle"),
        project: meta.project.clone(),
    }
}

fn legacy_history(
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    current: TaskHistoryEvent,
) -> Vec<TaskHistoryEvent> {
    let Some(first_at) = created_at.or(updated_at) else {
        return Vec::new();
    };

    if current.status == "SEALED" && updated_at.is_some_and(|updated| updated > first_at) {
        let mut before_seal = current.clone();
        before_seal.at = first_at.to_rfc3339();
        before_seal.status = "INTAKE".to_string();
        vec![before_seal, current]
    } else {
        let mut initial = current;
        initial.at = first_at.to_rfc3339();
        vec![initial]
    }
}

fn normalize(mut events: Vec<TaskHistoryEvent>) -> Vec<TaskHistoryEvent> {
    events.retain(|event| event.timestamp().is_some());
    events.sort_by_key(TaskHistoryEvent::timestamp);
    events.dedup_by(|later, earlier| later.at == earlier.at && later.same_state(earlier));
    events
}

fn parsed_page_history(meta: &PageMeta) -> Vec<TaskHistoryEvent> {
    meta.extra
        .get(TASK_HISTORY_KEY)
        .and_then(|value| value.clone().try_into::<Vec<TaskHistoryEvent>>().ok())
        .map(normalize)
        .unwrap_or_default()
}

/// Return persisted history plus a synthetic final snapshot when a task was
/// edited outside the board API. The synthetic event is persisted by the next
/// board mutation, so manually edited text remains a supported source of truth.
pub(crate) fn effective_page_history(meta: &PageMeta) -> Vec<TaskHistoryEvent> {
    let current_at = meta.updated_at.or(meta.created_at);
    let Some(current_at) = current_at else {
        return parsed_page_history(meta);
    };
    let current = snapshot(meta, current_at);
    let mut events = parsed_page_history(meta);
    if events.is_empty() {
        return legacy_history(meta.created_at, meta.updated_at, current);
    }
    if events.last().is_none_or(|last| !last.same_state(&current)) {
        events.push(current);
    }
    normalize(events)
}

/// Parse the same history representation from indexed `meta_json`.
pub(crate) fn effective_indexed_history(meta: &serde_json::Value) -> Vec<TaskHistoryEvent> {
    let created_at = meta
        .get("created_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let updated_at = meta
        .get("updated_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let current_at = updated_at.or(created_at);
    let current = current_at.map(|at| TaskHistoryEvent {
        at: at.to_rfc3339(),
        status: meta
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("INTAKE")
            .to_string(),
        cycle: meta
            .get("cycle")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        project: meta
            .get("project")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    });

    let mut events = meta
        .get(TASK_HISTORY_KEY)
        .and_then(|value| serde_json::from_value::<Vec<TaskHistoryEvent>>(value.clone()).ok())
        .map(normalize)
        .unwrap_or_default();
    let Some(current) = current else {
        return events;
    };
    if events.is_empty() {
        return legacy_history(created_at, updated_at, current);
    }
    if events.last().is_none_or(|last| !last.same_state(&current)) {
        events.push(current);
    }
    normalize(events)
}

fn history_value(events: &[TaskHistoryEvent]) -> toml::Value {
    toml::Value::Array(
        events
            .iter()
            .map(|event| {
                let mut table = toml::map::Map::new();
                table.insert("at".to_string(), toml::Value::String(event.at.clone()));
                table.insert(
                    "status".to_string(),
                    toml::Value::String(event.status.clone()),
                );
                if let Some(cycle) = &event.cycle {
                    table.insert("cycle".to_string(), toml::Value::String(cycle.clone()));
                }
                if let Some(project) = &event.project {
                    table.insert("project".to_string(), toml::Value::String(project.clone()));
                }
                toml::Value::Table(table)
            })
            .collect(),
    )
}

pub(crate) fn initialize_task_history(meta: &mut PageMeta) {
    let events = effective_page_history(meta);
    meta.extra
        .insert(TASK_HISTORY_KEY.to_string(), history_value(&events));
}

/// Heal legacy/external history from the old metadata and append the new state
/// when status, cycle, or project changed.
pub(crate) fn record_task_transition(old: &PageMeta, new: &mut PageMeta, at: DateTime<Utc>) {
    let mut events = effective_page_history(old);
    let next = snapshot(new, at);
    if events.last().is_none_or(|last| !last.same_state(&next)) {
        events.push(next);
    }
    let events = normalize(events);
    new.extra
        .insert(TASK_HISTORY_KEY.to_string(), history_value(&events));
}

fn path_is_task(path: &VaultPath) -> bool {
    path.as_str()
        .split_once('/')
        .is_some_and(|(folder, _)| folder == Kind::Task.canonical_folder())
}

pub(crate) fn heal_task_update(
    path: &VaultPath,
    expected_content: &str,
    new_meta: &mut PageMeta,
) -> Result<(), String> {
    let Ok((old_meta, _)) = parse_frontmatter(expected_content) else {
        return Ok(());
    };
    if old_meta.kind != Some(Kind::Task) && new_meta.kind != Some(Kind::Task) && !path_is_task(path)
    {
        return Ok(());
    }
    let at = new_meta
        .updated_at
        .or(old_meta.updated_at)
        .or(new_meta.created_at)
        .or(old_meta.created_at)
        .unwrap_or_else(Utc::now);
    record_task_transition(&old_meta, new_meta, at);
    Ok(())
}

pub(crate) fn heal_task_replacement(
    path: &VaultPath,
    expected_content: &str,
    new_content: &str,
) -> Result<String, String> {
    let Ok((old_meta, _)) = parse_frontmatter(expected_content) else {
        return Ok(new_content.to_string());
    };
    let Ok((mut new_meta, new_body)) = parse_frontmatter(new_content) else {
        return Ok(new_content.to_string());
    };
    if old_meta.kind != Some(Kind::Task) && new_meta.kind != Some(Kind::Task) && !path_is_task(path)
    {
        return Ok(new_content.to_string());
    }
    let at = new_meta
        .updated_at
        .or(old_meta.updated_at)
        .or(new_meta.created_at)
        .or(old_meta.created_at)
        .unwrap_or_else(Utc::now);
    record_task_transition(&old_meta, &mut new_meta, at);

    if new_content.starts_with("+++") {
        let history = new_meta
            .extra
            .get(TASK_HISTORY_KEY)
            .ok_or_else(|| "task history was not recorded".to_string())?;
        let edits = FrontmatterEdits {
            set: vec![(
                TASK_HISTORY_KEY.to_string(),
                toml_value_to_json(history),
                None,
            )],
            ..Default::default()
        };
        splice_frontmatter(new_content, &edits)
            .map_err(|error| format!("cannot persist task history: {error}"))
    } else {
        Ok(write_page_content(&new_meta, &new_body))
    }
}

pub(crate) fn matches_project_scope(
    event_project: Option<&str>,
    project: Option<&str>,
    unfiled: bool,
    known_projects: &HashSet<String>,
) -> bool {
    if let Some(project) = project {
        return event_project == Some(project);
    }
    if unfiled {
        return event_project.is_none_or(|value| !known_projects.contains(value));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_state_edits_do_not_move_a_seal_event() {
        let mut old = PageMeta::new();
        old.created_at = Some("2026-08-01T09:00:00Z".parse().unwrap());
        old.updated_at = Some("2026-08-02T12:00:00Z".parse().unwrap());
        old.extra
            .insert("status".into(), toml::Value::String("SEALED".into()));
        let mut new = old.clone();
        let edited_at = "2026-08-09T12:00:00Z".parse().unwrap();

        record_task_transition(&old, &mut new, edited_at);
        new.updated_at = Some(edited_at);
        let events = effective_page_history(&new);

        assert_eq!(events.len(), 2);
        assert_eq!(events[1].at, "2026-08-02T12:00:00+00:00");
        assert_eq!(events[1].status, "SEALED");
    }
}
