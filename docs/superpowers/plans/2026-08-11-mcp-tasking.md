# MCP Tasking Tools

Expose the shipped tasking/board subsystem through the MCP server: five new
`vault_*` tools mirroring the board HTTP API 1:1, plus instructions/docs, plus a
one-time migration of the 53 slug-named xxii tasks to TSK-coded pages.

## Decisions (interview, 2026-08-11)

1. **Full parity, 5 tools**: `vault_board`, `vault_task_create`,
   `vault_task_update`, `vault_cycle_create`, `vault_cycle_update` — including
   cycle sealing/carryover.
2. **Addressing**: `vault_task_update` / `vault_cycle_update` accept a TSK/S
   code or a vault path (UUID passthrough accepted when the string parses as
   one). Resolution happens in the tool, not the server.
3. **Creation routes through the board** (`POST /board/tasks`) so MCP-created
   tasks get TSK codes; the existing 53 xxii slug tasks are migrated to
   TSK-coded filenames as this feature's final step.

## Existing surface being mirrored (no backend changes)

- `GET /api/vault/board` → `BoardResponse { columns, operations, cycles, tasks }`
- `POST /api/vault/board/tasks` → `CreateTaskRequest`; defaults status=INTAKE,
  priority=P2; cycle "BACKLOG" ≡ absent; validates cycle stems; reserves
  `TSK-NNNN` via index; checklist items become `- [ ]` body lines
- `PATCH /api/vault/board/tasks/{id}` → `PatchTaskRequest`; tri-state
  cycle/assignee/estimate/due/hold/link (absent=keep, null=clear, value=set);
  `project: ""` clears project
- `POST /api/vault/board/cycles` → `CreateCycleRequest` (state PLANNED|ACTIVE;
  CLOSED rejected at creation; explicit code 409s on collision)
- `PATCH /api/vault/board/cycles/{id}` → `PatchCycleRequest`; `carry_to` only
  valid with state=CLOSED ("BACKLOG" clears, cycle code re-assigns)
- Statuses: INTAKE, TRIAGE, FIELD, REVIEW, SEALED. Priorities: P0–P3.

The board read endpoint takes no query params; `vault_board`'s optional
`project` filter is applied tool-side to `tasks` and `operations`.

## Tasks (TDD; each = failing test first, then implementation, then review)

### T1 — `patch_json` on the MCP API client

`src/mcp/client.rs`: add `patch_json(&self, path, body)` mirroring
`post_json` (same auth/error mapping, `reqwest::Method::PATCH`).
Test: alongside existing client tests (wiremock if present there; otherwise
unit-level construction parity with `post_json`).

### T2 — Param plumbing: tri-state + reference classification

In `src/mcp/server.rs` (or a small `src/mcp/tasking.rs` if server.rs growth
warrants — implementer's call, keep module wiring in `src/mcp/mod.rs`):

- `deserialize_tri_state` for param structs (same semantics as
  `src/api/board/mod.rs`), with `#[schemars(with = "Option<String>")]` so the
  JSON schema stays a nullable string. Empty string is normalized to null
  before sending (defensive against clients that can't emit null).
- `enum TaskRef { Id(Uuid), Path(String), Code(String) }` +
  `classify_ref(&str) -> TaskRef`: parses as UUID → Id; contains '/' or ends
  with ".md" → Path; else Code (case-normalized to upper).
- Async resolvers: Path → `GET /api/vault/pages/{encoded}` → `meta.id`;
  Code → `GET /api/vault/board` → match `tasks[].code` (or `cycles[].code`).

Unit tests: classification table (UUID, `tasks/xxii/TSK-0001.md`, `TSK-0001`,
`tsk-0001`, `S-13`), tri-state deserialization (absent/null/value/empty-string).

### T3 — Task tools

- `vault_board` (read_only_hint=true, idempotent): GET board, optional
  `project` filter; render like other read tools.
- `vault_task_create`: params mirror `CreateTaskRequest` (title required;
  status/priority documented with vocabularies; checklist documented).
  Description: tasks created here get TSK codes and file under
  `tasks/<project>/`; LLM-authored tasks must include `ai-generated` in tags.
- `vault_task_update`: `task` (code|path|id) + title, project,
  clear_project (maps to `project: ""`), status, priority, tags, and tri-state
  cycle/assignee/estimate/due/hold/link. Resolves ref → UUID → PATCH.
  Description spells out absent/null/value semantics and `cycle: "BACKLOG"`.

Tests: `tool_router_exposes_the_read_and_write_surface` gains the five names;
serde round-trip tests for the param structs (tri-state fields on
`vault_task_update` in particular).

### T4 — Cycle tools

- `vault_cycle_create`: mirror `CreateCycleRequest`; description notes CLOSED
  is invalid at creation and code auto-generates as `S-{max+1}`.
- `vault_cycle_update`: `cycle` (code|path|id) + state/goal/start/end/carry_to;
  description documents the seal-with-carryover flow.

Tests: router list (covered in T3's assertion), param serde tests.

### T5 — Instructions, skill, docs

- `MCP_INSTRUCTIONS`: add tasking guidance — orient with `vault_board`; move
  tasks through INTAKE → TRIAGE → FIELD → REVIEW → SEALED with
  `vault_task_update`; create tasks with `vault_task_create` (not
  `vault_create_page`) so they receive TSK codes; the `ai-generated` tag policy
  applies to LLM-authored tasks; seal cycles with `vault_cycle_update`
  (carry_to).
- Extend `server_instructions_define_llm_page_authoring_policy` (or a sibling
  test) with the new required clauses.
- `.claude/skills/vault/SKILL.md`: tool table rows + a short "Tasking"
  workflow section.
- `ui/src/docs/content/mcp.mdx`: document the five tools.

### T6 — Gates

`cargo fmt --check`, `cargo clippy`, `cargo test` (full suite). `bun run
typecheck` + `lint` in `ui/` (mcp.mdx touched). No OpenAPI regen (no backend
route/DTO changes).

### T7 — Merge + migrate

Merge `feature/mcp-tasking` → develop, remove worktree. Then, against the live
vault (existing `vault_move_page` suffices — moves preserve page id, aliases,
`task_history`, and rewrite inbound links; `max_code_number` scans stems so
subsequent board creates continue past the moved codes):

1. Move the 53 `tasks/xxii/2026….md` slug pages to `tasks/xxii/TSK-0001.md` …
   `TSK-0053.md` (stable order: Foundations, A–I, FIXME carry-over).
2. Spot-check: `[[XXII F1]]`-style alias links in the "XXII Backlog" note still
   resolve; board shows TSK codes.
3. Rebuild/install `clep` and restart `clep serve` so future MCP sessions load
   the new tools.
