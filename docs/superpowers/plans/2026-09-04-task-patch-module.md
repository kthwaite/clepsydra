# Task Patch Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the Task Fields rules out of the two board HTTP handlers into one pure, unit-tested module, and make the Code prefix rule a single pure function shared by the server and the MCP tools.

**Architecture:** `src/api/board/task_patch.rs` owns `TaskPatch` (every clearable field is keep/clear/set), `BoardLookups` (an index snapshot), `TaskPatchError`, and the core `apply_task_patch`; `plan_task_patch` and `new_task_meta` wrap it for the two handlers, which shrink to resolve → read → plan → execute → DTO. `src/vault/code.rs::resolve_prefix` becomes the one exact-then-unique-prefix resolver. No new dependencies.

**Tech Stack:** Rust 2024, axum 0.8, rusqlite, chrono, serde, toml; axum-test integration tests in `tests/api_board_test.rs`; `cargo run --example openapi` + `bun run openapi:file` for schema regeneration.

**Spec:** `docs/superpowers/specs/2026-09-04-task-patch-module-design.md` (read it first; decisions 1–14 are binding).

## Global Constraints

- Branch `feature/task-patch` off `develop`, in worktree `.worktrees/task-patch`. Merge to `develop` when done; remove the worktree.
- CI runs `cargo clippy --locked --all-targets -- -D warnings` and `cargo fmt --all -- --check`; every commit must pass both. `rustfmt` needs `--edition 2024` when run directly; `cargo fmt` is fine.
- `cargo test` needs `ui/dist` to exist (rust-embed). Copy it from the main checkout: `cp -R /Users/kit/Source/_p.pkm/clepsydra/ui/dist ui/dist`.
- Never run `clep` without `CLEPSYDRA__VAULT__ROOT` set; the ambient config points at the live vault. Nothing in this plan starts the server.
- Run tests with `cargo test --quiet -- --test-threads=4` (the Justfile `test-api` recipe). Single file: `cargo test --test api_board_test`.
- Do not touch `tests/api_board_test.rs` except to append the two tests in Task 5. The existing 51 tests are the behaviour net.
- Error messages must stay byte-identical to today's (they are listed in Task 2's mapping test).
- Vocabulary in code comments and commits: Task, Task Fields, Task Patch, Cycle, Backlog, Project, Code (CONTEXT.md). Commit messages: conventional, no attribution lines.
- Stage explicit paths (`git add <paths>`), never `git add .`.

---

### Task 0: Worktree

**Files:** none (workspace setup)

- [ ] **Step 1: Create the worktree and branch**

```bash
cd /Users/kit/Source/_p.pkm/clepsydra
git worktree add .worktrees/task-patch -b feature/task-patch develop
cd .worktrees/task-patch
cp -R /Users/kit/Source/_p.pkm/clepsydra/ui/dist ui/dist
```

- [ ] **Step 2: Bring over the uncommitted spec, plan, and CONTEXT.md from the main checkout**

```bash
cp /Users/kit/Source/_p.pkm/clepsydra/CONTEXT.md CONTEXT.md
cp /Users/kit/Source/_p.pkm/clepsydra/docs/superpowers/specs/2026-09-04-task-patch-module-design.md docs/superpowers/specs/
cp /Users/kit/Source/_p.pkm/clepsydra/docs/superpowers/plans/2026-09-04-task-patch-module.md docs/superpowers/plans/
git add CONTEXT.md docs/superpowers/specs/2026-09-04-task-patch-module-design.md docs/superpowers/plans/2026-09-04-task-patch-module.md
git commit -m "docs(board): Task Fields and Task Patch terms; task-patch module design and plan"
```

- [ ] **Step 3: Prove the baseline is green**

Run: `cargo test --quiet --test api_board_test -- --test-threads=4`
Expected: 51 passed.

---

### Task 1: One pure Code prefix resolver

**Files:**
- Modify: `src/vault/code.rs` (append after `family_of`, tests in the existing `mod tests`)
- Modify: `src/api/board/mod.rs:354-390` (`CodeLookup` enum + `resolve_code`)
- Modify: `src/mcp/tasking.rs:100-158` (`find_board_id`)

**Interfaces:**
- Produces: `crate::vault::code::CodeLookup { Found(String), NotFound, Ambiguous(Vec<String>) }` and `crate::vault::code::resolve_prefix<'a>(candidates: impl IntoIterator<Item = &'a str>, input: &str) -> CodeLookup`. Task 2 uses both.

- [ ] **Step 1: Write the failing tests in `src/vault/code.rs`**

Inside the existing `#[cfg(test)] mod tests { ... }` add:

```rust
    const CODES: [&str; 3] = [
        "TSK-brave-finch-7q3zd",
        "TSK-brave-otter-9k2ma",
        "TSK-calm-heron-2xm9p",
    ];

    #[test]
    fn resolve_prefix_exact_match_wins_case_insensitively() {
        assert_eq!(
            resolve_prefix(CODES, "tsk-BRAVE-finch-7q3zd"),
            CodeLookup::Found("TSK-brave-finch-7q3zd".into())
        );
    }

    #[test]
    fn resolve_prefix_unique_prefix_resolves_to_the_stored_code() {
        assert_eq!(
            resolve_prefix(CODES, "tsk-calm"),
            CodeLookup::Found("TSK-calm-heron-2xm9p".into())
        );
    }

    #[test]
    fn resolve_prefix_ambiguous_prefix_lists_candidates_in_order() {
        assert_eq!(
            resolve_prefix(CODES, "TSK-brave"),
            CodeLookup::Ambiguous(vec![
                "TSK-brave-finch-7q3zd".into(),
                "TSK-brave-otter-9k2ma".into()
            ])
        );
    }

    #[test]
    fn resolve_prefix_exact_match_beats_an_ambiguous_prefix() {
        assert_eq!(
            resolve_prefix(["TSK-brave", "TSK-brave-finch-7q3zd"], "TSK-brave"),
            CodeLookup::Found("TSK-brave".into())
        );
    }

    #[test]
    fn resolve_prefix_blank_input_never_matches() {
        for blank in ["", "   "] {
            assert_eq!(resolve_prefix(CODES, blank), CodeLookup::NotFound, "{blank:?}");
        }
    }

    #[test]
    fn resolve_prefix_miss_is_not_found_and_input_is_trimmed() {
        assert_eq!(resolve_prefix(CODES, "TSK-zzz"), CodeLookup::NotFound);
        assert_eq!(
            resolve_prefix(CODES, "  TSK-calm  "),
            CodeLookup::Found("TSK-calm-heron-2xm9p".into())
        );
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --quiet --lib vault::code::tests::resolve_prefix`
Expected: compile error, `resolve_prefix` and `CodeLookup` not found.

- [ ] **Step 3: Implement in `src/vault/code.rs`** (append after `family_of`, before `#[cfg(test)]`)

```rust
/// The outcome of resolving user input against a set of Codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeLookup {
    Found(String),
    NotFound,
    Ambiguous(Vec<String>),
}

/// Resolve `input` against `candidates`: an exact case-insensitive match
/// wins; otherwise a unique case-insensitive prefix match; otherwise
/// `NotFound` (no match, or blank input) or `Ambiguous` (every prefix match,
/// in candidate order). Whichever candidate is stored is what comes back —
/// Codes are never re-cased here.
pub fn resolve_prefix<'a>(
    candidates: impl IntoIterator<Item = &'a str>,
    input: &str,
) -> CodeLookup {
    let needle = input.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return CodeLookup::NotFound;
    }
    let candidates: Vec<&str> = candidates.into_iter().collect();
    if let Some(exact) = candidates
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(&needle))
    {
        return CodeLookup::Found((*exact).to_string());
    }
    let matches: Vec<String> = candidates
        .iter()
        .filter(|candidate| candidate.to_ascii_lowercase().starts_with(&needle))
        .map(|candidate| (*candidate).to_string())
        .collect();
    match matches.len() {
        0 => CodeLookup::NotFound,
        1 => CodeLookup::Found(matches.into_iter().next().expect("one match")),
        _ => CodeLookup::Ambiguous(matches),
    }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --quiet --lib vault::code::tests`
Expected: all pass (the six new tests plus the existing word-list tests).

- [ ] **Step 5: Make the board resolver delegate**

In `src/api/board/mod.rs`, delete the local enum:

```rust
pub(crate) enum CodeLookup {
    Found(String),
    NotFound,
    Ambiguous(Vec<String>),
}
```

and replace it with a re-export placed at the same spot:

```rust
pub(crate) use crate::vault::code::CodeLookup;
```

Replace the body of `resolve_code` (keep its doc comment) with:

```rust
pub(crate) fn resolve_code(
    conn: &rusqlite::Connection,
    kind: Kind,
    input: &str,
) -> Result<CodeLookup, rusqlite::Error> {
    let stems = code_stems(conn, kind)?;
    Ok(code::resolve_prefix(stems.iter().map(String::as_str), input))
}
```

`code` is already imported at the top of the file (`use crate::vault::code::{self, CodeFamily};`).

- [ ] **Step 6: Make the MCP resolver delegate**

In `src/mcp/tasking.rs` add to the imports:

```rust
use crate::vault::code::{CodeLookup, resolve_prefix};
```

Replace `find_board_id` from its doc comment to its closing brace with:

```rust
/// Find the page UUID for `code` in a `GET /board` response, matching the
/// `code` field of the kind's collection (`tasks` or `cycles`). Resolution is
/// [`resolve_prefix`]'s: an exact case-insensitive match wins; otherwise a
/// unique case-insensitive prefix. A miss names the unknown code and points
/// at vault_board for the live code list; an ambiguous prefix lists every
/// candidate.
pub fn find_board_id(board: &Value, kind: BoardKind, code: &str) -> Result<String, String> {
    let entries: Vec<(&str, &str)> = board
        .get(kind.collection())
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry_code = entry.get("code").and_then(Value::as_str)?;
            let id = entry.get("id").and_then(Value::as_str)?;
            Some((entry_code, id))
        })
        .collect();

    let not_found = || {
        format!(
            "no {} with code '{code}' — list codes with vault_board",
            kind.noun()
        )
    };

    match resolve_prefix(entries.iter().map(|(entry_code, _)| *entry_code), code) {
        CodeLookup::Found(found) => entries
            .iter()
            .find(|(entry_code, _)| *entry_code == found)
            .map(|(_, id)| (*id).to_string())
            .ok_or_else(not_found),
        CodeLookup::NotFound => Err(not_found()),
        CodeLookup::Ambiguous(codes) => Err(format!(
            "ambiguous {} prefix '{code}': candidates {}",
            kind.noun(),
            codes.join(", ")
        )),
    }
}
```

The existing `find_board_id_*` tests stay: they cover the JSON extraction and the message wording.

- [ ] **Step 7: Run the affected suites**

Run: `cargo test --quiet --lib mcp::tasking` then `cargo test --quiet --test api_board_test -- --test-threads=4`
Expected: all pass (MCP resolver tests unchanged; 51 board tests).

- [ ] **Step 8: Lint, format, commit**

```bash
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
git add src/vault/code.rs src/api/board/mod.rs src/mcp/tasking.rs
git commit -m "refactor(code): one pure Code prefix resolver shared by the board and MCP"
```

---

### Task 2: The Task Patch module and its unit suite

**Files:**
- Create: `src/api/board/task_patch.rs`
- Modify: `src/api/board/mod.rs:11-13` (add `pub(crate) mod task_patch;`)

**Interfaces:**
- Consumes: `crate::vault::code::{resolve_prefix, CodeLookup}` (Task 1); `super::{COLUMNS, PRIORITIES, code_stems, CreateTaskRequest, PatchTaskRequest}` (private items of the parent module are visible to a child module); `crate::api::projects::unknown_project`; `crate::vault::project::validate_slug`.
- Produces (used by Tasks 3–5): `FieldChange`, `TaskPatch`, `BoardLookups::load(&AppState)`, `TaskPatchError` (+ `From<TaskPatchError> for ApiError`), `Applied`, `apply_task_patch`, `plan_task_patch`, `new_task_meta`, `BACKLOG`.

- [ ] **Step 1: Register the module**

In `src/api/board/mod.rs` change the submodule block to:

```rust
pub(crate) mod cycles;
pub(crate) mod read;
pub(crate) mod task_patch;
pub(crate) mod tasks;
```

- [ ] **Step 2: Create `src/api/board/task_patch.rs` with the tests first**

Write the file with the header and the test module below. The `#![allow(dead_code)]` is temporary: nothing calls the module until Task 3, and CI denies warnings. Task 4 removes it.

```rust
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
        assert_eq!(FieldChange::from_create(Some("  ".into())), FieldChange::Keep);
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
        assert_eq!(patch.project, FieldChange::Keep, "an empty project on create means none");
    }

    // -- apply_task_patch: vocabulary ----------------------------------------

    #[test]
    fn apply_rejects_unknown_status_and_priority() {
        let mut meta = task_meta();
        let patch = TaskPatch { status: Some("BOGUS".into()), ..TaskPatch::default() };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownStatus("BOGUS".into()))
        );
        let patch = TaskPatch { priority: Some("P9".into()), ..TaskPatch::default() };
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
        let patch = TaskPatch { cycle: FieldChange::Set(BACKLOG.into()), ..TaskPatch::default() };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "cycle"), None);
    }

    #[test]
    fn apply_resolves_a_cycle_prefix_to_its_canonical_code() {
        let mut meta = task_meta();
        let patch = TaskPatch { cycle: FieldChange::Set("s-calm-h".into()), ..TaskPatch::default() };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "cycle").as_deref(), Some("S-calm-heron-2xm9p"));
    }

    #[test]
    fn apply_rejects_unknown_and_ambiguous_cycles() {
        let mut meta = task_meta();
        let patch = TaskPatch { cycle: FieldChange::Set("S-99".into()), ..TaskPatch::default() };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownCycle("S-99".into()))
        );
        let patch = TaskPatch { cycle: FieldChange::Set("S-calm".into()), ..TaskPatch::default() };
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
        let patch = TaskPatch { assignee: FieldChange::Clear, ..TaskPatch::default() };
        apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(extra(&meta, "assignee"), None);
        assert_eq!(extra(&meta, "cycle").as_deref(), Some("S-13"), "untouched field kept");

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
        let patch = TaskPatch { project: FieldChange::Set("ghost".into()), ..TaskPatch::default() };
        assert_eq!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::UnknownProject("ghost".into()))
        );
        let patch = TaskPatch { project: FieldChange::Set("../x".into()), ..TaskPatch::default() };
        assert!(matches!(
            apply_task_patch(&mut meta, &patch, &lookups(), now()),
            Err(TaskPatchError::InvalidProjectSlug { ref slug, .. }) if slug == "../x"
        ));
    }

    #[test]
    fn apply_project_set_and_clear_reconcile_but_keep_does_not() {
        let mut meta = task_meta();
        let patch = TaskPatch { project: FieldChange::Set("ops".into()), ..TaskPatch::default() };
        let applied = apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(applied, Applied { project: ProjectAssignment::Set("ops".into()), reconcile: true });
        assert_eq!(meta.project.as_deref(), Some("ops"));

        let patch = TaskPatch { project: FieldChange::Clear, ..TaskPatch::default() };
        let applied = apply_task_patch(&mut meta, &patch, &lookups(), now()).unwrap();
        assert_eq!(applied, Applied { project: ProjectAssignment::Clear, reconcile: true });
        assert_eq!(meta.project, None);

        let applied = apply_task_patch(&mut meta, &TaskPatch::default(), &lookups(), now()).unwrap();
        assert_eq!(applied, Applied { project: ProjectAssignment::Unchanged, reconcile: false });
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
        let patch = TaskPatch { project: FieldChange::Set("ops".into()), ..TaskPatch::default() };
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
        assert_eq!(error.error, "unknown priority: 'P9'; valid values: P0, P1, P2, P3");
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
        assert!(error.error.starts_with("unknown project: ghost;"), "{}", error.error);
        let error: ApiError = TaskPatchError::InvalidProjectSlug {
            slug: "../x".into(),
            reason: "bad slug".into(),
        }
        .into();
        assert_eq!(error.status, 400);
        assert_eq!(error.error, "bad slug");
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cargo test --quiet --lib api::board::task_patch`
Expected: compile errors for every missing item.

- [ ] **Step 4: Implement the module** (insert between the `use` block and `#[cfg(test)]`)

```rust
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
            TaskPatchError::AmbiguousCycle { input, candidates } => {
                ApiError::bad_request(format!(
                    "ambiguous cycle prefix '{input}': candidates {}",
                    candidates.join(", ")
                ))
            }
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
```

- [ ] **Step 5: Run to verify they pass**

Run: `cargo test --quiet --lib api::board::task_patch`
Expected: 19 passed.

- [ ] **Step 6: Lint, format, commit**

```bash
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
git add src/api/board/task_patch.rs src/api/board/mod.rs
git commit -m "feat(board): Task Patch module — Task Fields rules behind one pure interface"
```

---

### Task 3: Switch `patch_task` to the planner

**Files:**
- Modify: `src/api/board/tasks.rs` (`patch_task`, lines ~195–340, and the `use` block)

**Interfaces:**
- Consumes: `super::task_patch::{BoardLookups, TaskPatch, plan_task_patch}` (Task 2).
- Produces: nothing new. Behaviour identical to today except: resolution before validation (404 beats 400 on a nonexistent Task), `now` from `state.clock`, one disk read instead of two.

- [ ] **Step 1: Replace the handler body**

Keep the `#[utoipa::path(...)]` attribute unchanged. Replace `patch_task` with:

```rust
pub(crate) async fn patch_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<PatchTaskRequest>,
) -> Result<Json<BoardTask>, ApiError> {
    // 1. Resolve the TASK page by UUID.
    let id_clone = id.clone();
    let page_path = state
        .index
        .with_index(move |index, _vault| {
            let conn = index.connection();
            // Must be a TASK page
            conn.query_row(
                "SELECT path FROM pages WHERE id = ?1 AND kind = ?2",
                params![id_clone, Kind::Task.as_str()],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found(format!("task not found with id: {id}")))?;

    let vault_path = VaultPath::new(&page_path)
        .map_err(|e| ApiError::internal(format!("invalid stored path: {e}")))?;
    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!(
            "task file missing: {page_path}"
        )));
    }

    // 2. Read once: `raw_content` doubles as the stale-write guard.
    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    // 3. Plan the Task Patch.
    let lookups = BoardLookups::load(&state).await?;
    let patch = TaskPatch::from(body);
    let command = plan_task_patch(page, &patch, &lookups, state.clock.now())?;

    // 4. Execute.
    let notify = |notification: MutationNotification| {
        let _ = state.change_tx.send(SyncNotification::IndexChanged {
            upserted: notification.upserted,
            removed: notification.removed,
        });
    };
    let result = state
        .mutation_coordinator
        .update_page(
            &state.vault,
            &state.index,
            Arc::clone(&state.hooks),
            command,
            &notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    let code = path_stem(result.path.as_str()).to_string();
    let task_dto = build_board_task_dto(&state, &result.path, &code).await?;
    Ok(Json(task_dto))
}
```

Delete the private `apply_tri_state` helper and its "Helpers" banner at the bottom of the file.

- [ ] **Step 2: Fix the imports**

Add to the `use super::{...}` list: `task_patch::{BoardLookups, TaskPatch, plan_task_patch}` — i.e.

```rust
use super::task_patch::{BoardLookups, TaskPatch, plan_task_patch};
```

Remove what is now unused in `patch_task` only: `UpdatePageCommand`, `ProjectAssignment` are still used by `create_task` until Task 4 — leave them. Let the compiler tell you: `cargo build` and remove exactly the imports it reports unused (`chrono::Utc` and `fs` stay while `create_task` still uses them; `PageMeta` too).

- [ ] **Step 3: Run the board suite**

Run: `cargo test --quiet --test api_board_test -- --test-threads=4`
Expected: 51 passed, unchanged tests.

- [ ] **Step 4: Lint, format, commit**

```bash
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
git add src/api/board/tasks.rs
git commit -m "refactor(board): patch_task plans through the Task Patch module"
```

---

### Task 4: Switch `create_task` to the core; delete the old validators

**Files:**
- Modify: `src/api/board/tasks.rs` (`create_task`, lines ~35–175)
- Modify: `src/api/board/mod.rs` (`validate_status`, `validate_priority` deleted)
- Modify: `src/api/board/task_patch.rs:10` (remove `#![allow(dead_code)]`)

**Interfaces:**
- Consumes: `super::task_patch::{BoardLookups, FieldChange, TaskPatch, new_task_meta}`.

- [ ] **Step 1: Replace the handler body**

Keep the `#[utoipa::path(...)]` attribute. Replace `create_task` with:

```rust
pub(crate) async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateTaskRequest>,
) -> Result<Response, ApiError> {
    // 1. Validate and build the meta: defaults, then the request on top.
    let lookups = BoardLookups::load(&state).await?;
    let patch = TaskPatch::from(&body);
    let meta = new_task_meta(&patch, &lookups, state.clock.now())?;

    // 2. Mint a fresh TASK Code (re-rolls on collision) and file the page
    //    under its Project, if any.
    let code = mint_unique_code(&state, CodeFamily::Task).await?;
    let vault_path_str = match &patch.project {
        FieldChange::Set(project) => {
            format!("{}/{project}/{code}.md", Kind::Task.canonical_folder())
        }
        _ => format!("{}/{code}.md", Kind::Task.canonical_folder()),
    };
    let vault_path = VaultPath::new(&vault_path_str)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;

    // 3. The page body: the brief first, then the checklist, separated by a
    //    blank line so the two read as distinct blocks.
    let page_body = task_body(body.body.as_deref(), body.checklist.as_deref());

    let notify = crate::api::mutation_notifier(state.as_ref());
    state
        .mutation_coordinator
        .create_page(
            &state.vault,
            &state.index,
            CreatePageCommand {
                path: vault_path.clone(),
                meta,
                body: page_body,
            },
            notify,
        )
        .await
        .map_err(crate::api::mutation_error)?;

    // 4. Build and return BoardTask DTO
    let task_dto = build_board_task_dto(&state, &vault_path, &code).await?;
    Ok((StatusCode::CREATED, Json(task_dto)).into_response())
}

/// The brief first, then the checklist, separated by a blank line.
fn task_body(brief: Option<&str>, checklist: Option<&[String]>) -> String {
    let brief = brief.map(str::trim).filter(|brief| !brief.is_empty());
    let checklist = checklist
        .into_iter()
        .flatten()
        .map(|item| format!("- [ ] {item}\n"))
        .collect::<String>();
    match (brief, checklist.as_str()) {
        (None, list) => list.to_string(),
        (Some(brief), "") => format!("{brief}\n"),
        (Some(brief), list) => format!("{brief}\n\n{list}"),
    }
}
```

Remove the `#[allow(clippy::too_many_lines)]` on `create_task` if it is now short enough (clippy will tell you: an unused allow is not an error, but keep the file tidy).

- [ ] **Step 2: Delete the old validators and fix imports**

In `src/api/board/mod.rs` delete `validate_status` and `validate_priority` (and the "Shared validation helpers" banner if nothing else remains under it). In `src/api/board/tasks.rs` run `cargo build` and remove every import it reports unused (expect `fs`, `chrono::Utc`, `PageMeta`, `ProjectAssignment`, `UpdatePageCommand`, `DEFAULT_PRIORITY`, `DEFAULT_STATUS`, `ensure_cycle_exists`, `validate_priority`, `validate_status`, `ensure_project_exists`). `ensure_cycle_exists` must stay in `mod.rs`: `cycles.rs` uses it for `carry_to`.

In `src/api/board/task_patch.rs` delete the line `#![allow(dead_code)]`.

- [ ] **Step 3: Run the board suite and the unit suites**

Run: `cargo test --quiet --test api_board_test -- --test-threads=4` and `cargo test --quiet --lib api::board`
Expected: 51 integration tests pass; 19 unit tests pass.

- [ ] **Step 4: Lint, format, commit**

```bash
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
git add src/api/board/tasks.rs src/api/board/mod.rs src/api/board/task_patch.rs
git commit -m "refactor(board): create_task builds its meta through the Task Patch core"
```

---

### Task 5: Empty-clears contract — docs, schema, HTTP tests, MCP normaliser

**Files:**
- Modify: `src/api/board/mod.rs:214-275` (DTO doc comments)
- Modify: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx:194-195`
- Modify: `tests/api_board_test.rs` (append two tests after `patch_task_start_tri_state`)
- Modify: `src/mcp/tasking.rs:36-45` and its tests; `src/mcp/server.rs:20-24, 1375-1388`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:** none new. The server now owns empty-to-clear (Task 2's `FieldChange::from_tri_state`).

- [ ] **Step 1: Write the two failing HTTP tests**

Append to `tests/api_board_test.rs` directly after `patch_task_start_tri_state`:

```rust
#[tokio::test]
async fn patch_task_empty_string_clears_a_task_field() {
    let (server, _tmp) = setup_patch_target();

    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "assignee": "kit" }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["assignee"], "kit", "{body}");

    // "" clears, exactly like null.
    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "assignee": "" }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["assignee"].is_null(), "assignee should be cleared: {body}");

    // Whitespace clears too, and the Cycle is no exception (seeded as S-13).
    let res = server
        .patch("/api/vault/board/tasks/01951234-0000-7000-8000-000000000060")
        .json(&serde_json::json!({ "cycle": "   " }))
        .await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert!(body["cycle"].is_null(), "cycle should be cleared: {body}");
}

#[tokio::test]
async fn create_task_treats_an_empty_task_field_as_absent() {
    let (server, _tmp) = setup_server_with(|_root| {});

    let res = server
        .post("/api/vault/board/tasks")
        .json(&serde_json::json!({
            "title": "x", "cycle": "", "assignee": "  ", "due": ""
        }))
        .await;
    res.assert_status(axum::http::StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    assert!(body["cycle"].is_null(), "{body}");
    assert!(body["assignee"].is_null(), "{body}");
    assert!(body["due"].is_null(), "{body}");
}
```

- [ ] **Step 2: Run them**

Run: `cargo test --quiet --test api_board_test empty -- --test-threads=4`
Expected: both PASS already — Task 2 made the server normalise. That is fine: these tests pin the contract over HTTP. If either fails, the module is wrong; fix the module, not the test.

- [ ] **Step 3: Update the DTO docs**

In `src/api/board/mod.rs`:

Replace every `/// Tri-state: absent = keep, null = clear, value = set.` (six lines) with `/// Tri-state: absent = keep, null or empty string = clear, value = set.` and the cycle line `/// Tri-state: absent = keep, null = clear (→ backlog), value = set.` with `/// Tri-state: absent = keep, null or empty string = clear (→ backlog), value = set.`

Update the block comment above `PatchTaskRequest` so the sentence

`/// For tri-state fields (...): absent = leave unchanged; `null` = clear the field; string value = set to that value.`

reads

`/// For tri-state fields (...): absent = leave unchanged; `null` or an empty string = clear the field; any other string = set to that value.`

Add a doc comment on `CreateTaskRequest`:

```rust
/// An empty or whitespace-only `cycle`, `assignee`, `estimate`, `due`,
/// `start`, or `link` is treated as absent.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateTaskRequest {
```

- [ ] **Step 4: Update the docs page**

In `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`, after the bullet ending `accept a Cycle target use `BACKLOG` to clear the Cycle.` add:

```md
- Over the API an empty string on a clearable Task Field (`cycle`, `assignee`,
  `estimate`, `due`, `start`, `hold`, `link`) clears it, the same as `null`;
  on create it means the field is not set.
```

- [ ] **Step 5: Delete the MCP normaliser**

In `src/mcp/tasking.rs` delete `normalize_tri_state` (its doc comment through its closing brace, lines ~36–45) and the two tests `normalize_tri_state_turns_empty_string_into_clear` and `normalize_tri_state_leaves_other_states_untouched`.

In `src/mcp/server.rs` remove `normalize_tri_state` from the `use super::tasking::{...}` list and replace the six call sites with:

```rust
        insert_tri_state(&mut patch_body, "cycle", params.cycle);
        insert_tri_state(&mut patch_body, "assignee", params.assignee);
        insert_tri_state(&mut patch_body, "estimate", params.estimate);
        insert_tri_state(&mut patch_body, "due", params.due);
        insert_tri_state(&mut patch_body, "hold", params.hold);
        insert_tri_state(&mut patch_body, "link", params.link);
```

`ui/src/docs/content/mcp.mdx` already says `null` or `""` clears; leave it.

- [ ] **Step 6: Regenerate the OpenAPI schema without starting the server**

```bash
cargo run -q --example openapi > target/openapi.json && (cd ui && bun run openapi:file)
git diff --stat ui/src/api/schema.d.ts
```

Expected: only description strings in the `PatchTaskRequest` and `CreateTaskRequest` schemas change.

- [ ] **Step 7: Run everything**

```bash
cargo fmt --all
cargo clippy --locked --all-targets -- -D warnings
cargo test --quiet -- --test-threads=4
cd ui && bun run typecheck && bun run lint && bun run test; cd ..
```

Expected: Rust suite green. UI: typecheck and lint clean; vitest may show the pre-existing develop failures listed in memory (mdx-smoke CAS text, InscribeModal ×2, Sheaf ×2) — compare against `develop` before treating any as a regression.

- [ ] **Step 8: Commit**

```bash
git add src/api/board/mod.rs ui/src/docs/content/tasks-agenda-journals-and-board.mdx tests/api_board_test.rs src/mcp/tasking.rs src/mcp/server.rs ui/src/api/schema.d.ts
git commit -m "feat(board): an empty value clears a Task Field; server owns the rule, MCP normaliser removed"
```

---

### Task 6: Merge

- [ ] **Step 1: Clear the main checkout's uncommitted copies of the docs**

The main checkout still holds the working copies of `CONTEXT.md`, the spec, and this plan that Task 0 copied into the branch. They are identical to what the branch committed, and `git merge` refuses to overwrite dirty files, so verify and drop them first:

```bash
cd /Users/kit/Source/_p.pkm/clepsydra
diff CONTEXT.md .worktrees/task-patch/CONTEXT.md && git checkout -- CONTEXT.md
diff docs/superpowers/specs/2026-09-04-task-patch-module-design.md .worktrees/task-patch/docs/superpowers/specs/2026-09-04-task-patch-module-design.md && rm docs/superpowers/specs/2026-09-04-task-patch-module-design.md
diff docs/superpowers/plans/2026-09-04-task-patch-module.md .worktrees/task-patch/docs/superpowers/plans/2026-09-04-task-patch-module.md && rm docs/superpowers/plans/2026-09-04-task-patch-module.md
git status --short    # expect nothing under CONTEXT.md or docs/superpowers
```

If a `diff` reports differences, the branch's copy wins (it may carry checkbox ticks); still remove the main checkout's copy.

- [ ] **Step 2: Merge to develop and clean up**

```bash
git log --oneline develop..feature/task-patch        # expect the 6 commits from Tasks 0-5 only
git checkout develop && git merge --no-ff feature/task-patch -m "Merge branch 'feature/task-patch' into develop"
git worktree remove .worktrees/task-patch
git branch -d feature/task-patch
```

- [ ] **Step 3: Confirm develop is green**

Run: `cargo test --quiet -- --test-threads=4`
Expected: green.
