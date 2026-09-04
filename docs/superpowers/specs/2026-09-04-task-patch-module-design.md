# Task Patch module — design

**Date:** 2026-09-04 · **Branch:** `feature/task-patch` off `develop` (2c5f9055) · **Origin:** architecture review candidate "Lift the Task patch out of the HTTP handler"

Vocabulary: CONTEXT.md (Task, Task Fields, Task Patch, Cycle, Backlog, Project, Code) for the domain; the codebase-design skill (module, interface, seam, adapter, depth, leverage, locality) for the architecture.

## Problem

`src/api/board/tasks.rs::patch_task` and `::create_task` each inline the Task Fields rules: status and priority vocabulary, the `BACKLOG` sentinel, Cycle code canonicalisation (exact, else unique prefix), Project slug shape and existence, and the seven clearable fields. Neither handler has a unit test; the rules are reachable only through `tests/api_board_test.rs` over HTTP. The Code prefix rule is also re-implemented on the MCP side (`src/mcp/tasking.rs::find_board_id`).

## Decisions (settled by grilling, 2026-09-04)

1. **Seam placement.** The module lives in `src/api/board/task_patch.rs`, a pure sibling of the handlers. One writer of Task Fields exists (HTTP); MCP is HTTP-only by design; a vault-level seam would be hypothetical.
2. **Callers.** `patch_task` and `create_task` share one Task Fields core. `patch_cycle` keeps its own planner. The generic page update in `pages.rs` stays out.
3. **Index lookups.** The handler loads a snapshot (`BoardLookups`: every Cycle code stem, every declared Project slug) before planning; the module is pure over it. Always loaded, both queries, every request.
4. **Output.** The patch planner returns the complete `UpdatePageCommand` from the loaded `Page`. The create planner returns the validated `PageMeta`, because the page path depends on a Code minted after validation; the handler assembles the `CreatePageCommand`.
5. **Errors.** A typed `TaskPatchError` with a single `From<TaskPatchError> for ApiError` in the module file; messages unchanged from today.
6. **Ride-alongs.** (i) `now` is a parameter; handlers pass `state.clock.now()`. (ii) Empty-to-clear: on PATCH an empty or whitespace-only value for any of the seven clearable Task Fields clears it, matching the MCP normaliser, which is then deleted; on create such a value means "not set". Title, tags, status, priority unchanged. The id-to-path SQL stays until the page-identity candidate replaces it.
7. **Tests.** All existing board integration tests stay untouched as the net; the module gets its own unit suite first; thinning the integration tests is a later pass.
8. **Sharing shape.** One `apply_task_patch(meta, patch, lookups, now)` core over a module-owned `TaskPatch` (every clearable field is `FieldChange::{Keep, Clear, Set}`); both request DTOs convert into it.
9. **Names.** "Task Fields" and "Task Patch" (CONTEXT.md updated).
10. **Prefix rule.** The pure exact-then-unique-prefix resolution moves to `src/vault/code.rs::resolve_prefix` with `CodeLookup`; `api::board::resolve_code` and `mcp::tasking::find_board_id` both call it. MCP keeps its JSON extraction and message wording.
11. **Contract tests.** Two new HTTP tests: empty clears on PATCH; empty is absent on create.
12. **Order.** Five steps, each green, one commit each: prefix rule → module + unit suite → patch handler switched → create handler switched → empty-clears contract (DTO docs, schema regen, docs page, HTTP tests, MCP normaliser deleted).
13. **Precedence.** Resolution before validation: an invalid field on a nonexistent Task now returns 404, not 400. Within validation the order is status, priority, cycle, project; a request with several invalid fields reports the first in that order.
14. **Workspace.** `.worktrees/task-patch`, branch `feature/task-patch`; `ui/dist` must exist for `cargo test`.

## Interface

```rust
// src/vault/code.rs
pub enum CodeLookup { Found(String), NotFound, Ambiguous(Vec<String>) }
pub fn resolve_prefix<'a>(candidates: impl IntoIterator<Item = &'a str>, input: &str) -> CodeLookup;

// src/api/board/task_patch.rs
pub(crate) const BACKLOG: &str = "BACKLOG";
pub(crate) enum FieldChange { Keep, Clear, Set(String) }
impl FieldChange { fn from_tri_state(Option<Option<String>>) -> Self; fn from_create(Option<String>) -> Self }
pub(crate) struct TaskPatch { title, tags, status, priority: Option<_>, project, cycle, assignee, estimate, due, start, hold, link: FieldChange }
impl From<PatchTaskRequest> for TaskPatch; impl From<&CreateTaskRequest> for TaskPatch;
pub(crate) struct BoardLookups { cycle_stems: BTreeSet<String>, project_slugs: BTreeSet<String> }
impl BoardLookups { async fn load(&AppState) -> Result<Self, ApiError> }
pub(crate) enum TaskPatchError { UnknownStatus(String), UnknownPriority(String), UnknownCycle(String), AmbiguousCycle { input, candidates }, InvalidProjectSlug { slug, reason }, UnknownProject(String) }
impl From<TaskPatchError> for ApiError;
pub(crate) struct Applied { project: ProjectAssignment, reconcile: bool }
pub(crate) fn apply_task_patch(&mut PageMeta, &TaskPatch, &BoardLookups, DateTime<Utc>) -> Result<Applied, TaskPatchError>;
pub(crate) fn plan_task_patch(Page, &TaskPatch, &BoardLookups, DateTime<Utc>) -> Result<UpdatePageCommand, TaskPatchError>;
pub(crate) fn new_task_meta(&TaskPatch, &BoardLookups, DateTime<Utc>) -> Result<PageMeta, TaskPatchError>;
```

Rules inside `apply_task_patch`, in order: status ∈ board columns; priority ∈ priorities; Cycle `Set("BACKLOG")` → Clear, `Set(x)` → `resolve_prefix(cycle_stems, x)` must be `Found`; Project `Set(slug)` → valid slug shape and slug ∈ declared slugs. Only after every rule passes does the meta change (atomic on error). `reconcile` is true iff the Project changed. `updated_at = now`.

## Non-goals

Validating date or estimate formats; the page-identity resolver (candidate 2); thinning integration tests; moving the module into `src/vault/`.
