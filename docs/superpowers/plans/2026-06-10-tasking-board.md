# TASKING Board (Kanban) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the TASKING board from the Claude Design handoff — a kanban screen with a SCOPE rail (operations + cycles), four view modes (CARD / BACKLOG / CYCLE / TIMELINE), task creation modal, right-dock edit panel, and cycle lifecycle modals — backed by file-first task/cycle pages and a new `/api/vault/board` API.

**Architecture:** Tasks, operations, and cycles are **markdown pages** (vault stays source of truth; SQLite remains a derived index — ADR 0001). Board fields ride in YAML frontmatter (`PageMeta.extra`), already persisted to `pages.meta_json`, so **no index schema migration is needed**. A new `src/api/board.rs` aggregates the board in one GET and mutates frontmatter via the existing update-page pattern. The frontend adds a `/tasking` route + nav entry, a zustand-persisted board store, and a `components/tasking/` family translated pixel-faithfully from the design prototype into Vessel tokens.

**Tech Stack:** Rust (Axum 0.8, utoipa, rusqlite), React 19, TanStack Router/Query, zustand, react-aria-components, Tailwind v4 Vessel tokens, native HTML5 drag-and-drop (no new deps).

---

## Design source (authoritative spec)

The handoff bundle is mirrored in-repo. **Recreate these pixel-faithfully; do not copy their internal structure.**

| File | Content |
|---|---|
| `docs/pkm-redesign/project/view-board.jsx` | Board shell: SCOPE rail, header (title/modes/stats), body router, persistence, deep-link |
| `docs/pkm-redesign/project/board-modes.jsx` | `TaskCard`, `CardView` (kanban+DnD), `BacklogView`, `SprintView`, `TimelineView` |
| `docs/pkm-redesign/project/board-panels.jsx` | `NewTaskModal`, `CardEditPanel`, `NewSprintModal`, `StartSprintModal`, `EndSprintModal` |
| `docs/pkm-redesign/project/fixtures-board.js` | Data shapes: columns, 5 operations, 5 cycles, 28 tasks |
| `docs/pkm-redesign/project/styles-board.css` | Exact spacing/color/typography for every board class |
| `docs/pkm-redesign/chats/chat11.md`, `chat12.md` | Intent: what the user asked for and where they landed |

Design intent highlights (from chats): tab named **TASKING**; "blocked" is a **HOLD stamp** on cards, not a sixth column; rail replaces horizontal project chips; last-active view persists across reloads; cycle modals warn on double-ACTIVE and route carryover on seal.

## Domain mapping (design vocabulary → Clepsydra)

| Design | Clepsydra model |
|---|---|
| Task (`TSK-0481`) | Page, **new `type: TASK`**, filed `tasks/<op>/TSK-NNNN.md`. Filename stem = diegetic code. Board fields in frontmatter; checklist = body checkboxes (already indexed in `blocks`); dossier link = `link:` frontmatter holding a wikilink (see decision 9). **TASK is distinct from the existing TODO kind** (lightweight todo notes) and from checkbox-block tasks (the agenda/`/api/vault/tasks` system) — the board touches neither. |
| Operation (`OP-SIG3`) | Page, `type: PROJECT`, opting into the board with explicit **`board: true`** frontmatter (`health:`/`lead:`/`target:` are optional decoration). Tasks attach via the **existing** `project:` label == the operation page's project slug, so metadata projection (`src/vault/projection.rs`) keeps task files filed under `tasks/<op>/` for free. TASK pages whose `project:` is absent or matches no `board: true` operation group under a synthetic **UNFILED** rail row — every TASK page is board-native; none are ever invisible. |
| Cycle / sprint (`S-13`) | Page, **new `type: CYCLE`**, filed `cycles/S-13.md`, frontmatter `state/start/end/goal`. |
| Disposition columns | `status:` frontmatter ∈ `INTAKE · TRIAGE · FIELD · REVIEW · SEALED`. Column metadata (labels, subs, WIP limits) is a backend constant for now. |
| HOLD | `hold:` frontmatter (free-text reason; absent = active). |
| Priority | `priority:` ∈ `P0 · P1 · P2 · P3`. |
| Backlog | `cycle:` absent or `BACKLOG`. |

### Decisions (locked in grilling session, 2026-06-10)

1. **V1 scope is the full design** — all four view modes plus the complete cycle lifecycle. No phasing cut.
2. **No new SQLite tables.** `pages.meta_json` already serializes `PageMeta` including the `extra` flatten bucket (`src/vault/index.rs:500`, `src/vault/page.rs:40`). Vault-scale TASK counts are small; the board GET reads all TASK/PROJECT/CYCLE pages in three indexed queries and shapes DTOs in Rust.
3. **Two new kinds**: `Kind::Task` (folder `tasks/`) and `Kind::Cycle` (folder `cycles/`). The folder synonyms `"tasks" | "task"` move from TODO to TASK (`kind.rs:84`); **behavior change**: pages under an existing `tasks/` folder re-infer TODO→TASK on next index build. `todos/todo` stay TODO.
4. **Board membership**: operations = PROJECT pages with `board: true`; tasks = **all** TASK pages (kind is the marker), with op-less/unmatched ones under a synthetic UNFILED rail row. `CreateTaskRequest.project` stays optional.
5. **Diegetic vocabulary everywhere** — frontmatter stores `status: INTAKE|TRIAGE|FIELD|REVIEW|SEALED`, `hold:`, `cycle:` as designed. No plain-token mapping layer.
6. **Task IDs**: create endpoint allocates `TSK-NNNN` = max existing numeric suffix + 1 (min 0001), uses it as the filename. Stable, wikilinkable, and matches the future `((TSK-NNNN))` note-embed feature.
7. **Checklists are derived read-only** (body checkboxes via `blocks` table); the edit panel shows `d/total` + an open-in-Folio affordance, not the prototype's steppers.
8. **Sealed-task lifecycle**: backend returns everything; the CARD view client-side hides SEALED tasks whose cycle is CLOSED (they remain visible in that cycle's CYCLE view, BACKLOG, and TIMELINE).
9. **Dossier link**: `link:` frontmatter holds a wikilink (`"[[dossier name]]"`); add `"link"` to `default_linkable_properties()` (`src/vault/config.rs:75`) so the existing prop-link deriver (`src/vault/index.rs:1532`) indexes task→dossier backlinks for free.
10. **DnD**: native HTML5 drag events, as the prototype does. No @dnd-kit dependency.
11. **Burndown / seal-rate sparklines**: synthetic, computed client-side from current stats (exactly as the prototype's `SprintView` does). Real historical series is out of scope.
12. **WIP limits**: backend constants matching the fixtures (`TRIAGE 6 · FIELD 4 · REVIEW 4`); UI renders over-capacity state. Config plumbing deferred.
13. **Delete task** reuses the existing `DELETE /api/vault/pages/{*path}` (task DTO carries `path`).
14. **Timeline window** derives from min(cycle.start)−2d … max(cycle.end)+2d, not the prototype's hardcoded dates.
15. **Nav**: TASKING appended as nav index 05 after DIURNAL (the design's "before STATUS" slot — the real app has no STATUS screen). Shortcut: **⌘J** (`nav.tasking`; ⌘T is browser-reserved and Kit prefers J).

### Out of scope (phase 2 — do not build now)

- Note↔task embeds: `((TSK-NNNN))` inline chips + `task` block in the reader (chat12). Requires editor schema work (`ui/src/editor/schema/elements/`).
- Operation create/edit UI (operations are authored as PROJECT pages for now).
- Real burndown history, per-user assignee model, timeline drag-to-reschedule, board column config.

---

## File structure

**Backend**
- Modify: `src/vault/kind.rs` — add `Kind::Cycle`
- Create: `src/api/board.rs` — DTOs + handlers + router (one file, mirrors `src/api/tasks.rs` style)
- Modify: `src/api/mod.rs` — `.nest("/board", board::router())` + `mod board;`
- Modify: `src/api/openapi.rs` — register paths + schemas
- Create: `tests/api_board_test.rs` — endpoint tests (setup copied from `tests/api_tasks_test.rs:21-58`)

**Frontend**
- Create: `ui/src/api/board.ts` — typed hooks (queries + mutations)
- Modify: `ui/src/api/keys.ts` — `queryKeys.board`
- Create: `ui/src/store/board.ts` — persisted view prefs + ephemeral edit/modal state
- Create: `ui/src/routes/tasking.tsx` — route
- Modify: `ui/src/components/codex/CodexFrame.tsx` — `View` union, `NAV`, detection, `onNav`
- Create under `ui/src/components/tasking/`:
  - `TaskingScreen.tsx` (shell: rail + header + body router)
  - `ScopeRail.tsx` (operations + cycles + NEW TASKING + collapse/popout)
  - `BoardHeader.tsx` (title, 4 mode toggles with glyphs, stats, op-meta line)
  - `KanbanView.tsx` + `TaskCard.tsx` (columns, WIP bar, DnD)
  - `BacklogView.tsx` (priority-grouped 8-column register)
  - `CycleView.tsx` (goal/metrics/burndown/progress + disposition lanes + open/seal buttons)
  - `TimelineView.tsx` (cycle-band axis + op-grouped gantt bars)
  - `NewTaskModal.tsx`, `TaskEditPanel.tsx`
  - `NewCycleModal.tsx`, `OpenCycleModal.tsx`, `SealCycleModal.tsx`
  - `board-constants.ts` (column/priority orders + labels, shared chip components)
  - `__tests__/` — vitest tests per component family
- Modify: `ui/src/lib/shortcuts.ts` + `ui/src/hooks/useGlobalShortcuts.tsx` — `nav.tasking`

---

## API contract (single source for both layers)

All under `/api/vault/board`. Errors use `ApiError` (`src/api/error.rs:9-80`).

```
GET    /api/vault/board                 → 200 BoardResponse
POST   /api/vault/board/tasks           → 201 BoardTask     (validates op/cycle exist)
PATCH  /api/vault/board/tasks/{id}      → 200 BoardTask     (partial; id = page UUID)
POST   /api/vault/board/cycles          → 201 BoardCycle
PATCH  /api/vault/board/cycles/{id}     → 200 BoardCycle    (state transitions + carry_to)
```

```rust
pub struct BoardResponse { columns: Vec<BoardColumn>, operations: Vec<BoardOperation>,
                           cycles: Vec<BoardCycle>, tasks: Vec<BoardTask> }
pub struct BoardColumn    { id: String, label: String, sub: String, wip: u32 }
pub struct BoardOperation { id: Uuid, path: String, code: String, name: String, health: String,
                            lead: Option<String>, target: Option<String>, note: Option<String>,
                            dossier: Option<String>, project: Option<String> }
pub struct BoardCycle     { id: Uuid, path: String, code: String, label: String, state: String, // PLANNED|ACTIVE|CLOSED
                            start: Option<String>, end: Option<String>, goal: Option<String> }
pub struct BoardTask      { id: Uuid, path: String, code: String, title: String,
                            project: Option<String>, status: String, priority: String,
                            cycle: Option<String>, assignee: Option<String>, estimate: Option<String>,
                            due: Option<String>, start: Option<String>, hold: Option<String>,
                            tags: Vec<String>, checks: [u32; 2], link: Option<String>, updated_at: String }
pub struct CreateTaskRequest { title: String, project: Option<String>, status: Option<String>,
                               priority: Option<String>, cycle: Option<String>, assignee: Option<String>,
                               estimate: Option<String>, due: Option<String>, tags: Option<Vec<String>>,
                               link: Option<String>, checklist: Option<Vec<String>> } // body "- [ ] item" lines
pub struct PatchTaskRequest  { title: Option<String>, project: Option<String>, status: Option<String>,
                               priority: Option<String>, cycle: Option<Option<String>>, assignee: Option<Option<String>>,
                               estimate: Option<Option<String>>, due: Option<Option<String>>,
                               hold: Option<Option<String>>, tags: Option<Vec<String>>, link: Option<Option<String>> }
pub struct CreateCycleRequest { code: Option<String>, label: String, start: String, end: String,
                                goal: Option<String>, state: Option<String> }
pub struct PatchCycleRequest  { state: Option<String>, goal: Option<String>, start: Option<String>,
                                end: Option<String>, carry_to: Option<String> } // "BACKLOG" | cycle code | absent
```

`Option<Option<T>>` (double option with `#[serde(default, with = "::serde_with::rust::double_option")]` or a custom `Patch<T>` enum — match whichever pattern `pages.rs` UpdatePageRequest uses; if none exists, use `skip_serializing_if`-style tri-state with `serde_json::Value::Null` detection) lets PATCH distinguish "clear field" (`null`) from "leave alone" (absent). Clearing matters for: cycle (→BACKLOG), hold (→active), due, assignee, link.

Validation (400 unless noted): `status` ∈ COLUMNS; `priority` ∈ P0..P3; `cycle` must match an existing CYCLE page code or `"BACKLOG"`; task `project` is **optional and unconstrained** (op-less/unmatched tasks land in the UNFILED rail group; the modal only offers `board: true` ops); cycle PATCH `state` ∈ PLANNED/ACTIVE/CLOSED.

`checks` derivation: `SELECT COUNT(*), SUM(state='done')` style query over the `blocks` table checkbox rows for the page (same data `src/api/tasks.rs` reads).

---

## Backend tasks

### Task 1: `Kind::Task` + `Kind::Cycle`

**Files:** Modify `src/vault/kind.rs`, `src/vault/config.rs`; Test: same files `#[cfg(test)]`.

- [ ] **Step 1: Extend the round-trip test** — add `Kind::Task` and `Kind::Cycle` to the `all` array in `as_str_and_from_token_are_symmetric` (`kind.rs:169-180`) and add assertions:

```rust
assert_eq!(Kind::Task.canonical_folder(), "tasks");
assert_eq!(Kind::Cycle.canonical_folder(), "cycles");
assert_eq!(Kind::from_folder("tasks"), Some(Kind::Task));   // reassigned from Todo
assert_eq!(Kind::from_folder("todos"), Some(Kind::Todo));   // unchanged
assert_eq!(Kind::from_folder("sprints"), Some(Kind::Cycle));
```

Also update the existing `folder_is_inferred_with_synonyms` test (`kind.rs:153-160`): `resolve("tasks/x.md", None)` now expects `(Kind::Task, true)`.

- [ ] **Step 2:** `cargo test -p clepsydra kind` → FAIL (variants missing).
- [ ] **Step 3:** Add both variants in all five match sites: enum (`Task`, `Cycle`); `canonical_folder` → `"tasks"` / `"cycles"`; `as_str` → `"TASK"` / `"CYCLE"`; `from_token` `"TASK"` / `"CYCLE"`; `from_folder` — **move** `"tasks" | "task"` from the Todo arm to Task, add `"cycles" | "cycle" | "sprints" | "sprint"` → Cycle. (Behavior change: pages under an existing `tasks/` folder re-infer TODO→TASK on next index build — intended.)
- [ ] **Step 4:** Add `"link"` to `default_linkable_properties()` (`src/vault/config.rs:75`) so `link:` frontmatter wikilinks index as property-ref backlinks; extend the nearest config test to assert it.
- [ ] **Step 5:** `cargo test -p clepsydra` → PASS. Also run the OpenAPI kind test (`src/api/openapi.rs:165-200`) — update its expected token list to include `"TASK"` and `"CYCLE"`.
- [ ] **Step 6:** `git add -A && git commit -m "feat(vault): add TASK and CYCLE page kinds; link as linkable property"`

### Task 2: board read model — `GET /api/vault/board`

**Files:** Create `src/api/board.rs`; Modify `src/api/mod.rs`; Test `tests/api_board_test.rs`.

- [ ] **Step 1: Write failing test.** Copy `setup_server()` verbatim from `tests/api_tasks_test.rs:21-58`. Seed via raw file writes + reindex (or the create endpoints from Task 3 once they exist — at this stage write files directly):

```rust
#[tokio::test]
async fn board_aggregates_operations_cycles_tasks() {
    let (server, tmp) = setup_server_with(|root| {
        write(root, "projects/op-sig3.md", "---\nid: <uuid>\ntitle: SIGNAL-3 MIGRATION\ntype: PROJECT\nproject: op-sig3\nboard: true\nhealth: AMBER\nlead: \"0xC1\"\ntarget: W17\n---\n");
        write(root, "cycles/S-13.md", "---\nid: <uuid>\ntitle: CYCLE 13\ntype: CYCLE\nstate: ACTIVE\nstart: 2026-04-13\nend: 2026-04-19\ngoal: freeze\n---\n");
        write(root, "tasks/op-sig3/TSK-0481.md", "---\nid: <uuid>\ntitle: FREEZE LEGACY SYNC WRITES\ntype: TASK\nproject: op-sig3\nstatus: FIELD\npriority: P0\ncycle: S-13\nassignee: \"0xC1\"\ndue: 2026-04-21\n---\n- [x] a\n- [x] b\n- [ ] c\n");
    });
    let res = server.get("/api/vault/board").await;
    res.assert_status_ok();
    let b: serde_json::Value = res.json();
    assert_eq!(b["columns"].as_array().unwrap().len(), 5);
    assert_eq!(b["operations"][0]["code"], "OP-SIG3"); // code = uppercased project slug w/ OP- prefix? NO — see Step 3 note: code = filename stem uppercased
    assert_eq!(b["cycles"][0]["code"], "S-13");
    let t = &b["tasks"][0];
    assert_eq!(t["code"], "TSK-0481");
    assert_eq!(t["status"], "FIELD");
    assert_eq!(t["checks"], serde_json::json!([2, 3]));
}
```

(`code` for every entity = filename stem, uppercased — `op-sig3.md` → `OP-SIG3`; keeps codes user-controlled and rename-safe under the page-filename-identity rules.)

- [ ] **Step 2:** `cargo test --test api_board_test` → FAIL (404).
- [ ] **Step 3: Implement.** In `board.rs`: a `COLUMNS` const (`INTAKE/unfiled/0 · TRIAGE/staged/6 · FIELD/active/4 · REVIEW/qa · seal/4 · SEALED/closed/0`); `fn router()` exposing `get(get_board)`. Handler queries the index (via `IndexHandle`, same access pattern as `src/api/tasks.rs` handlers) for pages by kind:
  - `kind='PROJECT' AND json_extract(meta_json,'$.board') = 1` → operations (YAML `board: true` serializes to JSON `true`; dossier = `$.link` wikilink target),
  - `kind='CYCLE'` → cycles sorted by `start`,
  - `kind='TASK'` → **all** task pages, no filtering; for each, parse `meta_json` to `PageMeta`, read board fields from `extra` (default `status` → `INTAKE`, `priority` → `P2`), derive `checks` from the page's checkbox blocks in one grouped query, `code` from path stem. `project` passes through as-is (possibly null/unmatched — the UI's UNFILED row owns that grouping).
  Wire in `src/api/mod.rs`: `mod board;` + `.nest("/board", board::router())` next to the existing `.nest("/tasks", …)`.
  Add a test: a TASK page with no `project:` still appears in `tasks` with `project: null`.
- [ ] **Step 4:** `cargo test --test api_board_test` → PASS; `cargo clippy` clean.
- [ ] **Step 5:** Commit `feat(api): board read model — GET /api/vault/board`.

### Task 3: task mutations — `POST /board/tasks`, `PATCH /board/tasks/{id}`

**Files:** Modify `src/api/board.rs`; Test `tests/api_board_test.rs`.

- [ ] **Step 1: Failing tests** (one per behavior):

```rust
#[tokio::test] async fn create_task_allocates_code_and_files_under_operation() {
    // POST {title:"dual-write shim", project:"op-sig3", status:"TRIAGE", priority:"P1",
    //       cycle:"S-13", checklist:["shim","overlap","verify"]}
    // → 201; code=="TSK-0001"; path=="tasks/op-sig3/TSK-0001.md"; checks==[0,3]
    // file exists on disk with type: TASK + board frontmatter; title stored as given (UI uppercases visually).
}
#[tokio::test] async fn create_task_without_project_files_at_tasks_root() {
    // POST {title:"stray"} → 201; path=="tasks/TSK-0001.md"; project==null
}
#[tokio::test] async fn create_task_rejects_unknown_cycle() { /* cycle:"S-99" → 400 */ }
#[tokio::test] async fn patch_task_moves_column_and_clears_hold() {
    // PATCH {status:"REVIEW", hold:null} → 200; frontmatter updated; GET /board reflects it
}
#[tokio::test] async fn second_create_increments_code() { /* existing TSK-0481 → next is TSK-0482 */ }
```

- [ ] **Step 2:** Run → FAIL (405/404).
- [ ] **Step 3: Implement** following the existing page-create pattern (`src/api/pages.rs:425-500`) and page-update pattern (`src/api/pages.rs:516-584`):
  - **create**: validate status/priority/cycle → allocate code (scan TASK page paths for `TSK-(\d+)`, max+1, pad 4) → build `PageMeta` (fresh UUID, timestamps, `kind: Some(Kind::Task)`, optional `project`, board fields into `extra`) → body = checklist lines as `- [ ] item` → atomic write `create_new=true` to `tasks/[<op>/]TSK-NNNN.md` → reindex page + resolve links → broadcast `SyncNotification::IndexChanged` → 201 DTO.
  - **patch**: locate path by UUID (same by-id lookup as `src/api/pages.rs:343-409`) → `parse_or_repair_frontmatter` → apply present fields (None-in-Some clears the `extra` key; `title` updates meta; `project` change ALSO triggers the projection move via the assign/mutation path used by `pages-assign` so the file refiles under the new op folder) → bump `updated_at` → write → invalidate + reindex + broadcast → 200 DTO.
- [ ] **Step 4:** Tests PASS; clippy clean.
- [ ] **Step 5:** Commit `feat(api): board task create + patch`.

### Task 4: cycle mutations — `POST /board/cycles`, `PATCH /board/cycles/{id}`

**Files:** Modify `src/api/board.rs`; Test `tests/api_board_test.rs`.

- [ ] **Step 1: Failing tests:**

```rust
#[tokio::test] async fn create_cycle_defaults_code_and_state() {
    // POST {label:"CYCLE 14", start:"2026-04-20", end:"2026-04-26"} → 201
    // code=="S-14" (max numeric existing +1), state=="PLANNED", path=="cycles/S-14.md"
}
#[tokio::test] async fn seal_cycle_routes_carryover_to_backlog() {
    // S-13 ACTIVE with one SEALED + one FIELD task.
    // PATCH /board/cycles/{id} {state:"CLOSED", carry_to:"BACKLOG"} → 200
    // FIELD task's frontmatter cycle removed; SEALED task untouched.
}
#[tokio::test] async fn seal_cycle_can_carry_to_next_cycle() { /* carry_to:"S-14" rewrites cycle: S-14 */ }
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Create mirrors task-create (kind CYCLE, folder `cycles/`). Patch: update state/goal/window; when `state:"CLOSED"` + `carry_to`, query TASK pages with `cycle == this code && status != "SEALED"` and rewrite each page's frontmatter (loop the same single-page update routine; broadcast once at the end). `carry_to:"BACKLOG"` removes the key. No transactional guarantee across files — acceptable; reconcile sweep heals stragglers (ADR 0001 posture). Opening a cycle (`state:"ACTIVE"`) does **not** auto-close others — the double-ACTIVE warning is a UI concern (per design chat).
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(api): board cycle create + lifecycle patch with carryover`.

### Task 5: OpenAPI registration + TS schema regen

**Files:** Modify `src/api/openapi.rs`; regenerate `ui/src/api/schema.d.ts`.

- [ ] **Step 1:** Add `#[utoipa::path(...)]` attributes to all five handlers (copy attribute shape from `src/api/tasks.rs`), register paths + all Board* / *Request schemas in the `#[derive(OpenApi)]` block (`src/api/openapi.rs:6-154`).
- [ ] **Step 2:** Extend the openapi test to assert `paths` contains `/api/vault/board` and components contain `BoardTask`. Run `cargo test openapi` → PASS.
- [ ] **Step 3:** `cargo run -- serve` in one shell; in `ui/`: `bun run openapi` (script at `ui/package.json:14`) → `schema.d.ts` gains `"/api/vault/board"` etc. `bun run typecheck` → PASS.
- [ ] **Step 4:** Commit `feat(api): board endpoints in OpenAPI + regenerated UI schema`.

---

## Frontend tasks

### Task 6: query hooks + keys

**Files:** Create `ui/src/api/board.ts`; Modify `ui/src/api/keys.ts`; Test `ui/src/api/board.test.ts` (pure helpers only).

- [ ] **Step 1:** Add to `keys.ts`: `board: { all: ["board"] as const }`.
- [ ] **Step 2:** Implement hooks with the `$api`/manual-fetch pattern from `ui/src/api/tasks.ts`:

```ts
import type { components } from "#/api/schema";
export type BoardTask = components["schemas"]["BoardTask"];
export type BoardCycle = components["schemas"]["BoardCycle"];
export type BoardOperation = components["schemas"]["BoardOperation"];
export type BoardResponse = components["schemas"]["BoardResponse"];

export function useBoard() {
  return useQuery<BoardResponse>({ queryKey: queryKeys.board.all, queryFn: fetchBoard });
}
export function useCreateTask() { /* POST /board/tasks; onSuccess: invalidate board.all */ }
export function usePatchTask() {
  // mutationFn PATCH /board/tasks/{id}
  // optimistic update for {status} moves: onMutate cancel+snapshot board.all,
  // setQueryData mapping the task's status; onError rollback; onSettled invalidate.
}
export function useCreateCycle() { /* invalidate board.all */ }
export function usePatchCycle() { /* invalidate board.all */ }
```

Optimistic status move is required — DnD must not snap back while the PATCH round-trips.
- [ ] **Step 3:** `bun run typecheck` PASS. Commit `feat(ui): board api hooks`.

### Task 7: board store, route, nav

**Files:** Create `ui/src/store/board.ts`, `ui/src/routes/tasking.tsx`; Modify `ui/src/components/codex/CodexFrame.tsx`, `ui/src/lib/shortcuts.ts`, `ui/src/hooks/useGlobalShortcuts.tsx`.

- [ ] **Step 1: Store** (persist pattern from `ui/src/store/workspace.ts`):

```ts
type BoardMode = "card" | "backlog" | "cycle" | "timeline";
interface BoardState {
  mode: BoardMode;            // persisted
  opFilter: string | "ALL" | "UNFILED"; // operation code or pseudo-group; persisted
  cycleSel: string;           // cycle code | "BACKLOG"; persisted
  railOpen: boolean;          // persisted
  editTaskId: string | null;  // ephemeral
  taskModal: { project?: string; status?: string; cycle?: string } | null; // ephemeral
  cycleModal: { kind: "new" } | { kind: "open" | "seal"; cycleId: string } | null; // ephemeral
  // setters for each
}
export const useBoardStore = create<BoardState>()(persist(..., {
  name: "clepsydra.board",
  partialize: (s) => ({ mode: s.mode, opFilter: s.opFilter, cycleSel: s.cycleSel, railOpen: s.railOpen }),
}));
```

- [ ] **Step 2: Route** `ui/src/routes/tasking.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { TaskingScreen } from "#/components/tasking/TaskingScreen";
export const Route = createFileRoute("/tasking")({ component: TaskingScreen });
```

- [ ] **Step 3: Nav.** In `CodexFrame.tsx`: extend the `View` union (`:16`) with `"tasking"`; append `["tasking", "TASKING"]` to `NAV` (`:19-25`); add `if (p.startsWith("/tasking")) return "tasking";` to detection (`:46-57`); add `else if (target === "tasking") navigate({ to: "/tasking" });` to `onNav` (`:59-71`).
- [ ] **Step 4: Shortcut.** Register in `SHORTCUTS` (`ui/src/lib/shortcuts.ts`, Navigate group around line 45): `"nav.tasking": { chord: { key: "j", mod: true }, label: "Open Tasking", group: "Navigate", scope: "global" }` (⌘J — decided in grilling; ⌘T is browser-reserved). Add the binding in `useGlobalShortcuts` (`ui/src/hooks/useGlobalShortcuts.tsx:49-79`; the exhaustive type makes omission a compile error).
- [ ] **Step 5:** `bun run typecheck && bun run test` PASS (routeTree regenerates on dev-server/test run). Render smoke-test: `TaskingScreen` placeholder `<div>TASKING</div>` for now. Commit `feat(ui): /tasking route, nav item, board store, shortcut`.

### Task 8: shell — `TaskingScreen` + `ScopeRail` + `BoardHeader`

**Files:** Create `TaskingScreen.tsx`, `ScopeRail.tsx`, `BoardHeader.tsx`, `board-constants.ts`; Test `__tests__/ScopeRail.test.tsx`, `__tests__/BoardHeader.test.tsx`.

**Spec:** `view-board.jsx:139-315` (structure), `styles-board.css` (visuals). Layout: `flex h-full` — rail `w-[230px] border-r border-rule flex-col` when open, else a floating `SCOPE ›` popout button (absolute, top-left); main column = header + body. **Collapse must not blank the main pane** (design chat fixed exactly this bug — when collapsed, main takes full width).

- [ ] **Step 1:** `board-constants.ts`:

```ts
export const COL_ORDER = ["INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED"] as const;
export const COL_LABEL: Record<string, string> = { INTAKE: "INTAKE", TRIAGE: "TRIAGE", FIELD: "IN-FIELD", REVIEW: "REVIEW", SEALED: "SEALED" };
export const PRI_ORDER = ["P0", "P1", "P2", "P3"] as const;
export const PRI_LABEL: Record<string, string> = { P0: "CRITICAL", P1: "HIGH", P2: "NORMAL", P3: "LOW" };
export const MODES = [
  { id: "card", label: "CARD" }, { id: "backlog", label: "BACKLOG" },
  { id: "cycle", label: "CYCLE" }, { id: "timeline", label: "TIMELINE" },
] as const;
// shared chips: <PriChip pri/>, <StatePip col/>, <HealthDot health/>, <HoldTag/>
// Colors: P0 var(--hot), P1 var(--accent), P2 var(--ink-2), P3 var(--ink-mute);
// health GREEN var(--cool) / AMBER var(--warn) / RED var(--hot);
// state pips per styles-board.css .bk-statepip.{INTAKE,TRIAGE,FIELD,REVIEW,SEALED}.
```

- [ ] **Step 2: Tests first** — ScopeRail renders ALL OPS + one row per operation with counts, clicking sets `opFilter`; an **UNFILED row appears only when tasks exist whose `project` is null or matches no operation** (count = those tasks; clicking sets `opFilter="UNFILED"`; no health dot — use the `bl-alldot` neutral style); cycle rows show state pip + window + count, clicking sets `cycleSel` and `mode="cycle"`; BKLG pseudo-row; `+` opens cycleModal `{kind:"new"}`; collapse button flips `railOpen`. BoardHeader: 4 mode buttons, active styling, stats (`OPEN` = non-SEALED count, `IN-FIELD`, `ON HOLD` count, zero-padded 2 digits), op-meta line only when `opFilter !== "ALL"` (lead/health/target/dossier link/note).
- [ ] **Step 3:** Run → FAIL. Implement against `useBoard()` + `useBoardStore`. Typography: `.cl-mono` labels with `tracking-[0.18em]`, header `<h1>` in `font-sans font-black` per `styles-board.css .board-h`. Wire `TaskingScreen` to route the body by `mode` (views stubbed) and host the modals/edit panel mounts.
- [ ] **Step 4:** Tests PASS; `bun run typecheck` PASS. Commit `feat(ui): tasking shell — scope rail + board header`.

### Task 9: `KanbanView` + `TaskCard` (DnD)

**Files:** Create `KanbanView.tsx`, `TaskCard.tsx`; Test `__tests__/KanbanView.test.tsx`.

**Spec:** `board-modes.jsx:25-126`, `styles-board.css` `.kb*` / `.kc*`. Five columns in a horizontal scroll region; per-column header (label, sub, `+` button, `NN/wip` count that flags `over` in `var(--hot)`), WIP fill bar, priority-sorted cards. Card anatomy: left priority bar, HOLD stamp (absolute, top-right, hot border), id + pri chip (+ op code when `opFilter==="ALL"`), title, hold reason line, checklist progress bar `d/total`, up to 3 minitags, footer (assignee · est · dossier link · `DUE …`).

- [ ] **Step 1: Tests first:** cards bucket by `status` and sort by priority; **the SEALED column excludes tasks whose `cycle` belongs to a CLOSED cycle** (decision 8 — they stay visible in CYCLE/BACKLOG/TIMELINE views); empty column shows `— NONE —`; over-WIP column gets the `over` class/count color; clicking a card sets `editTaskId`; column `+` opens taskModal with that status preset; **drop** calls `usePatchTask().mutate({ id, status })` — simulate with `fireEvent.dragStart(card)` then `fireEvent.drop(column)`.
- [ ] **Step 2:** FAIL → implement. DnD exactly as prototype: `draggable` on card, `dragId` + `dropCol` local state, `onDragOver` preventDefault + highlight (`.drop` → `border-accent` tint), `onDrop` fires the optimistic mutation. Dragging card gets reduced opacity.
- [ ] **Step 3:** PASS; commit `feat(ui): kanban card view with drag-and-drop`.

### Task 10: `BacklogView`

**Files:** Create `BacklogView.tsx`; Test `__tests__/BacklogView.test.tsx`.

**Spec:** `board-modes.jsx:128-193`, `styles-board.css` `.bk*`. 8-column grid header `FILE-ID · TASKING · OP · DISPOSITION · OPR · EST · DUE · CHK`; groups by priority (P0 CRITICAL → P3 LOW, empty groups dropped) with `NN ITEMS` counts; rows sorted by column order then due (due `—` sorts last); HOLD tag inline before title; disposition cell = state pip + label; CHK cell = dot-per-check with done dots filled. Row click → `editTaskId`.

- [ ] **Step 1:** Tests for grouping/sorting/empty-group-dropping/dot rendering → FAIL.
- [ ] **Step 2:** Implement (CSS grid with `grid-cols-[90px_1fr_70px_110px_50px_60px_60px_80px]` per the stylesheet's track sizes). PASS.
- [ ] **Step 3:** Commit `feat(ui): backlog register view`.

### Task 11: `CycleView`

**Files:** Create `CycleView.tsx`; Test `__tests__/CycleView.test.tsx`.

**Spec:** `board-modes.jsx:195-299`. Selected cycle from `cycleSel` (BACKLOG pseudo-cycle: label BACKLOG, win UNSCHEDULED, goal copy from `view-board.jsx:268`). Header left: window + state tag, `<h2>` label, goal, action — `▶ OPEN CYCLE` when PLANNED (opens `cycleModal {kind:"open"}`), `■ SEAL CYCLE` when ACTIVE (`{kind:"seal"}`), `✓ CYCLE SEALED` when CLOSED. Header right: metrics (COMMITTED/SEALED/IN-FIELD/HOLD, zero-padded) + synthetic burndown sparkline (reuse the existing sparkline component the Atrium uses — find it before writing a new one; prototype formula at `board-modes.jsx:212-218`). Progress bar `% SEALED · d/t CHECKS`. Body: disposition lanes (only non-empty), rows = pri chip, id, HOLD tag + title, op, assignee, `d/total`. Empty state with `+ COMMIT TASK` → taskModal `{cycle}`.

- [ ] Steps: tests (stats math incl. checks aggregation; action button per state; BACKLOG pseudo-cycle) → FAIL → implement → PASS → commit `feat(ui): cycle view`.

### Task 12: `TimelineView`

**Files:** Create `TimelineView.tsx`, `timeline-math.ts`; Test `__tests__/timeline-math.test.ts`.

**Spec:** `board-modes.jsx:301-390`. Pure helpers in `timeline-math.ts`: `windowOf(cycles)` (min start −2d … max end +2d), `pct(dateMs, win)` clamp 0–100, task bar range = `[start ?? due−2d, due]`. Axis: one band per cycle (state-styled, ACTIVE highlighted `var(--cool)`), label + window start. Body: operations grouped (health dot + code + name), rows with fixed-width label (pri pip, id, title) + track (cycle gridlines + clickable bar positioned by %, status-colored, hold variant hatched, min-width 2.5%). Footer: `NN UNSCHEDULED` count for due-less tasks. Bar click → `editTaskId`.

- [ ] Steps: math tests (window derivation, clamping, due-only fallback) → FAIL → implement helpers → PASS → implement component (light render test: bars present with computed `left`/`width`) → commit `feat(ui): timeline gantt view`.

### Task 13: `NewTaskModal` + `TaskEditPanel`

**Files:** Create `NewTaskModal.tsx`, `TaskEditPanel.tsx`; Test `__tests__/NewTaskModal.test.tsx`, `__tests__/TaskEditPanel.test.tsx`.

**Spec:** `board-panels.jsx:32-272`, `styles-board.css` `.board-modal*` / `.board-edit*`. Use the existing react-aria dialog primitives (`ui/src/components/ui/dialog.tsx`) styled to the board-modal look (hard shadow `--shadow-xl`, rule borders, mono header `+ NEW TASKING / {op} · COMMIT TO REGISTER / ESC`).

**NewTaskModal fields:** title (autofocus, ⌘↵ commits), operation select, cycle select (BACKLOG first), disposition radio row, priority radio row (P-colored), operator/est/due inputs, tags (use existing `tag-input.tsx`), subtask count → `checklist: Array.from({length:n}, (_,i) => \`step ${i+1}\`)` (or a textarea, one item per line — prefer the textarea; the count-only prototype field was a fixture shortcut), dossier link input. Footer: `⌘↵ commit · ESC cancel`, CANCEL / COMMIT TASK. On create success: close, set `editTaskId` to the new id.

**TaskEditPanel:** right-dock (`absolute right-0 inset-y-0 w-[340px]`, scrim closes), live PATCH-on-change with field-level debounce (300ms) for text inputs, immediate for radios/selects/steppers. Sections: title textarea, disposition radios, priority radios, operation+cycle selects, checklist note (checks are derived from body checkboxes — panel shows `d/total` read-only with an "open page" affordance instead of the prototype's +/− steppers; steppers would desync from the markdown source of truth. **This is a deliberate deviation from the prototype** — the body is editable in Folio), tags, HOLD toggle + reason input (toggle sets/clears `hold`), dossier link + `OPEN →` (navigates via workspace `openTab("page", path)`), footer `✕ DESTROY` (confirm, then existing pages DELETE by path) + `EDITS AUTO-SEALED`.

- [ ] Steps: tests (create payload shape incl. tags/checklist; ESC/⌘↵; patch fired on disposition change; hold toggle clears with `null`; destroy calls delete) → FAIL → implement → PASS → commit `feat(ui): task create modal + right-dock edit panel`.

### Task 14: cycle modals

**Files:** Create `NewCycleModal.tsx`, `OpenCycleModal.tsx`, `SealCycleModal.tsx`; Test `__tests__/cycleModals.test.tsx`.

**Spec:** `board-panels.jsx:275-495`.
- **New:** prefills next code `S-NN`, label `CYCLE NN`, start = day after latest cycle end, end = start+6d; date inputs; PLANNED/ACTIVE initial state; goal textarea. POST then select it (`cycleSel`, `mode="cycle"`).
- **Open:** shows committed/checks counts, `→ STATE ACTIVE`; callout if zero committed; **warning callout when another cycle is ACTIVE** (proceed allowed). Confirm PATCHes `{state:"ACTIVE"}`.
- **Seal:** stats (committed/sealed/carryover/rate + progress bar); carryover radio `→ BACKLOG` / `→ S-NN` (next PLANNED, if any) / `LEAVE IN CYCLE`; clean-close callout when carryover 0. Confirm PATCHes `{state:"CLOSED", carry_to}` (omit for LEAVE).

- [ ] Steps: tests (prefill math, double-ACTIVE warning, carryover option set, payloads) → FAIL → implement → PASS → commit `feat(ui): cycle lifecycle modals`.

### Task 15: integration polish + verification

**Files:** Modify `TaskingScreen.tsx` (mount everything); `ui/src/components/codex/__tests__/` nav test if one exists.

- [ ] **Step 1:** Wire deep-link affordance: dossier-link clicks across all views call `useWorkspaceStore.getState().openTab("page", path)` + navigate `/workspace` (the CodexFrame folio pattern, `CodexFrame.tsx:66-70`).
- [ ] **Step 2:** Full suite: `cargo test && cargo clippy && (cd ui && bun run typecheck && bun run lint && bun run test)` → all PASS.
- [ ] **Step 3:** Manual verification against the design (use the `verify`/`run` skill): seed a vault with the fixture-equivalent ops/cycles/tasks; check all four modes, rail collapse (main pane keeps full width), DnD persistence across reload, over-WIP flag, modals, edit panel, seal-with-carryover. Compare against `docs/pkm-redesign/project/screenshots/`.
- [ ] **Step 4:** Commit `feat(tasking): integration polish`; merge per `superpowers:finishing-a-development-branch`.

---

## Self-review notes

- **Spec coverage:** rail (T8), 4 modes (T9–12), create modal + edit panel (T13), 3 cycle modals (T14), nav item + view persistence (T7: store persists mode — matches the design's "remember last view" decision scoped to the board), HOLD-as-stamp (T9/T13), carryover routing (T4/T14), dossier cross-links (T9/T13/T15). Note-embed task blocks: explicitly phase 2.
- **Deliberate deviations from prototype:** checklist steppers → derived read-only checks (file-first integrity); timeline window derived not hardcoded; checklist authored as lines not a count; TASKING nav lands at index 05 after DIURNAL.
- **Type consistency:** wire format uses `status`/`cycle`/`estimate` everywhere (prototype's `col`/`sprint`/`est` are design-internal); frontend types come from generated `schema.d.ts`, so drift is a compile error after T5.
- **Open questions: all resolved in the 2026-06-10 grilling session** — see the numbered Decisions list. Headlines: dedicated `Kind::Task` (board tasks ≠ TODO notes ≠ checkbox-block tasks), `board: true` operation marker, UNFILED rail row for op-less tasks, diegetic vocabulary in frontmatter, ⌘J shortcut, CARD view hides SEALED tasks of CLOSED cycles.
