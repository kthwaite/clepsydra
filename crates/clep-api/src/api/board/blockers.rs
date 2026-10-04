//! Blockers: the Task graph behind `blocked_by` (CONTEXT.md: Blocker,
//! Blocked).
//!
//! A Task records the Tasks it waits on in its `blocked_by` frontmatter
//! list, as wikilinks to their codes. Only the waiting Task stores the
//! edge. `blocks` (the inverse) and `blocked` (any open Blocker, or `hold`)
//! are derived here on every read and never persisted.
//!
//! [`load_task_nodes`] reads the graph from the index in one query. The rest
//! is pure: [`TaskNodes`] answers the derived questions and finds the cycle
//! a proposed `blocked_by` list would close.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rusqlite::params;

use crate::vault::board_vocab::{BLOCKED_BY_KEY, DEFAULT_STATUS};
use crate::vault::kind::Kind;

use super::{extra_str, path_stem};

/// The Done status. A Blocker in this status no longer blocks.
pub(crate) const DONE_STATUS: &str = "SEALED";

/// One Task as the Blocker rules see it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TaskNode {
    /// The persisted `status`, or the default when absent.
    pub status: String,
    /// The codes this Task is blocked by, in stored order. A code that names
    /// an existing Task is that Task's code as stored; any other entry is
    /// kept as written (a dangling Blocker).
    pub blocked_by: Vec<String>,
}

/// Every Task, keyed by its code.
pub(crate) type TaskNodes = BTreeMap<String, TaskNode>;

/// Strip wikilink syntax from one `blocked_by` entry: `[[CODE]]`,
/// `[[CODE|label]]` and a bare `CODE` all yield `CODE`. Blank yields `None`.
pub(crate) fn blocker_target(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("[[")
        .and_then(|rest| rest.strip_suffix("]]"))
        .unwrap_or(trimmed);
    let target = inner.split_once('|').map_or(inner, |(target, _)| target);
    let target = target.trim();
    (!target.is_empty()).then_some(target)
}

/// The `blocked_by` targets in a page's meta JSON. A list of strings is the
/// stored shape; a single string is read as a one-item list.
pub(crate) fn blocked_by_targets(meta: &serde_json::Value) -> Vec<String> {
    let values: Vec<&str> = match meta.get(BLOCKED_BY_KEY) {
        Some(serde_json::Value::Array(items)) => {
            items.iter().filter_map(serde_json::Value::as_str).collect()
        }
        Some(serde_json::Value::String(value)) => vec![value.as_str()],
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(blocker_target)
        .map(str::to_string)
        .collect()
}

/// Build the node map from `(code, meta JSON)` pairs. Blocker targets are
/// matched to Task codes case-insensitively (the way wikilinks resolve), so
/// every edge to an existing Task uses that Task's stored code.
pub(crate) fn task_nodes_from<'a>(
    tasks: impl IntoIterator<Item = (String, &'a serde_json::Value)>,
) -> TaskNodes {
    let raw: Vec<(String, String, Vec<String>)> = tasks
        .into_iter()
        .map(|(code, meta)| {
            let status = extra_str(meta, "status").unwrap_or_else(|| DEFAULT_STATUS.to_string());
            (code, status, blocked_by_targets(meta))
        })
        .collect();
    let by_folded: BTreeMap<String, String> = raw
        .iter()
        .map(|(code, _, _)| (code.to_lowercase(), code.clone()))
        .collect();
    raw.into_iter()
        .map(|(code, status, targets)| {
            let mut seen = BTreeSet::new();
            let blocked_by = targets
                .into_iter()
                .map(|target| {
                    by_folded
                        .get(&target.to_lowercase())
                        .cloned()
                        .unwrap_or(target)
                })
                .filter(|target| seen.insert(target.clone()))
                .collect();
            (code, TaskNode { status, blocked_by })
        })
        .collect()
}

/// Read every TASK page's code, status and `blocked_by` from the index.
pub(crate) fn load_task_nodes(conn: &rusqlite::Connection) -> Result<TaskNodes, rusqlite::Error> {
    let mut statement = conn.prepare("SELECT path, meta_json FROM pages WHERE kind = ?1")?;
    let rows: Vec<(String, serde_json::Value)> = statement
        .query_map(params![Kind::Task.as_str()], |row| {
            let path = row.get::<_, String>(0)?;
            let meta_json = row.get::<_, String>(1)?;
            Ok((path, meta_json))
        })?
        .map(|row| {
            row.map(|(path, meta_json)| {
                let meta = serde_json::from_str(&meta_json).unwrap_or(serde_json::Value::Null);
                (path_stem(&path).to_string(), meta)
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(task_nodes_from(
        rows.iter().map(|(code, meta)| (code.clone(), meta)),
    ))
}

/// Whether the Task `code` reads Blocked: `hold` is set, or any Blocker is
/// an existing Task that is not Done. A dangling Blocker does not count.
pub(crate) fn is_blocked(nodes: &TaskNodes, code: &str, hold: Option<&str>) -> bool {
    if hold.is_some_and(|hold| !hold.trim().is_empty()) {
        return true;
    }
    nodes.get(code).is_some_and(|node| {
        node.blocked_by.iter().any(|blocker| {
            nodes
                .get(blocker)
                .is_some_and(|blocker| blocker.status != DONE_STATUS)
        })
    })
}

/// The inverse of `blocked_by` for every Task: code → the codes of the
/// Tasks it blocks, sorted.
pub(crate) fn blocks_index(nodes: &TaskNodes) -> BTreeMap<String, Vec<String>> {
    let mut blocks: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (code, node) in nodes {
        for blocker in &node.blocked_by {
            blocks
                .entry(blocker.clone())
                .or_default()
                .push(code.clone());
        }
    }
    blocks
}

/// The cycle that giving Task `code` the Blockers `proposed` would close,
/// or `None`. The returned path starts and ends at `code`; each Task in it
/// is blocked by the next. The search follows the current `blocked_by`
/// edges of every other Task and finds a shortest cycle.
pub(crate) fn find_cycle(
    nodes: &TaskNodes,
    code: &str,
    proposed: &[String],
) -> Option<Vec<String>> {
    let mut parent: BTreeMap<&str, &str> = BTreeMap::new();
    let mut queue: VecDeque<&str> = VecDeque::new();
    for blocker in proposed {
        if blocker == code {
            return Some(vec![code.to_string(), code.to_string()]);
        }
        if !parent.contains_key(blocker.as_str()) {
            parent.insert(blocker, code);
            queue.push_back(blocker);
        }
    }
    while let Some(current) = queue.pop_front() {
        let Some(node) = nodes.get(current) else {
            continue;
        };
        for next in &node.blocked_by {
            if next == code {
                let mut path = vec![code.to_string()];
                let mut cursor = current;
                while cursor != code {
                    path.push(cursor.to_string());
                    cursor = parent[cursor];
                }
                path.push(code.to_string());
                // Built from the far end back: reverse the inner hops so the
                // path reads code → first Blocker → … → code.
                let last = path.len() - 1;
                path[1..last].reverse();
                return Some(path);
            }
            if !parent.contains_key(next.as_str()) {
                parent.insert(next, current);
                queue.push_back(next);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nodes(edges: &[(&str, &str, &[&str])]) -> TaskNodes {
        edges
            .iter()
            .map(|(code, status, blocked_by)| {
                (
                    code.to_string(),
                    TaskNode {
                        status: status.to_string(),
                        blocked_by: blocked_by.iter().map(|s| s.to_string()).collect(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn blocker_target_strips_wikilink_syntax() {
        assert_eq!(blocker_target("[[TSK-a]]"), Some("TSK-a"));
        assert_eq!(blocker_target(" [[TSK-a|label]] "), Some("TSK-a"));
        assert_eq!(blocker_target("TSK-a"), Some("TSK-a"));
        assert_eq!(blocker_target("  "), None);
        assert_eq!(blocker_target("[[]]"), None);
    }

    #[test]
    fn task_nodes_match_targets_case_insensitively_and_keep_dangling_ones() {
        let a =
            json!({ "status": "FIELD", "blocked_by": ["[[tsk-B]]", "[[TSK-gone]]", "[[TSK-b]]"] });
        let b = json!({});
        let c = json!({ "blocked_by": "[[TSK-a]]" });
        let nodes = task_nodes_from([
            ("TSK-a".to_string(), &a),
            ("TSK-b".to_string(), &b),
            ("TSK-c".to_string(), &c),
        ]);
        assert_eq!(nodes["TSK-a"].status, "FIELD");
        assert_eq!(nodes["TSK-a"].blocked_by, vec!["TSK-b", "TSK-gone"]);
        assert_eq!(nodes["TSK-b"].status, DEFAULT_STATUS);
        assert!(nodes["TSK-b"].blocked_by.is_empty());
        assert_eq!(
            nodes["TSK-c"].blocked_by,
            vec!["TSK-a"],
            "a single string reads as a one-item list"
        );
    }

    #[test]
    fn blocked_follows_open_blockers_and_hold() {
        let graph = nodes(&[
            ("TSK-a", "FIELD", &["TSK-b"]),
            ("TSK-b", "TRIAGE", &[]),
            ("TSK-c", "FIELD", &["TSK-d"]),
            ("TSK-d", DONE_STATUS, &[]),
            ("TSK-e", "FIELD", &["TSK-gone"]),
        ]);
        assert!(is_blocked(&graph, "TSK-a", None), "open blocker");
        assert!(!is_blocked(&graph, "TSK-c", None), "sealed blocker");
        assert!(!is_blocked(&graph, "TSK-e", None), "dangling blocker");
        assert!(!is_blocked(&graph, "TSK-b", None), "no blockers");
        assert!(is_blocked(&graph, "TSK-b", Some("legal")), "hold alone");
        assert!(!is_blocked(&graph, "TSK-b", Some("  ")), "blank hold");
    }

    #[test]
    fn blocks_index_is_the_inverse() {
        let graph = nodes(&[
            ("TSK-a", "FIELD", &["TSK-c"]),
            ("TSK-b", "FIELD", &["TSK-c", "TSK-a"]),
            ("TSK-c", "FIELD", &[]),
        ]);
        let blocks = blocks_index(&graph);
        assert_eq!(blocks["TSK-c"], vec!["TSK-a", "TSK-b"]);
        assert_eq!(blocks["TSK-a"], vec!["TSK-b"]);
        assert!(!blocks.contains_key("TSK-b"));
    }

    #[test]
    fn find_cycle_reports_the_closing_path() {
        let graph = nodes(&[
            ("TSK-a", "FIELD", &[]),
            ("TSK-b", "FIELD", &["TSK-c"]),
            ("TSK-c", "FIELD", &["TSK-a"]),
            ("TSK-d", "FIELD", &[]),
        ]);
        assert_eq!(
            find_cycle(&graph, "TSK-a", &["TSK-b".to_string()]),
            Some(vec![
                "TSK-a".to_string(),
                "TSK-b".to_string(),
                "TSK-c".to_string(),
                "TSK-a".to_string()
            ])
        );
        assert_eq!(
            find_cycle(&graph, "TSK-a", &["TSK-c".to_string()]),
            Some(vec![
                "TSK-a".to_string(),
                "TSK-c".to_string(),
                "TSK-a".to_string()
            ])
        );
        assert_eq!(find_cycle(&graph, "TSK-a", &["TSK-d".to_string()]), None);
        assert_eq!(find_cycle(&graph, "TSK-d", &["TSK-b".to_string()]), None);
    }

    #[test]
    fn find_cycle_ignores_the_tasks_own_current_edges() {
        // TSK-a is currently blocked by TSK-b; replacing that list with
        // TSK-c must not trip over the edge being replaced.
        let graph = nodes(&[
            ("TSK-a", "FIELD", &["TSK-b"]),
            ("TSK-b", "FIELD", &[]),
            ("TSK-c", "FIELD", &[]),
        ]);
        assert_eq!(find_cycle(&graph, "TSK-a", &["TSK-c".to_string()]), None);
    }
}
