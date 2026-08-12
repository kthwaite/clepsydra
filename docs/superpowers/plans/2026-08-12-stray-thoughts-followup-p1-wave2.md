# Clepsydra Stray Thoughts Follow-up P1 Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Write failing tests before production code. Do not mark vault checkboxes complete until merged behavior is verified.

**Goal:** Deliver Tasking body excerpts and a dedicated current-Folio Base property panel without per-card body reads, frontend membership evaluation, duplicate typed editors, or a second persistence path.

**Architecture:** Extend the authoritative board projection with a privacy-guarded, server-produced `body_excerpt`. Add a read projection on the existing page-properties resource that evaluates every Base against the current page and groups declarations by key. Reuse `EditableCell` and the existing revision-aware property PATCH endpoint in a Folio-side panel; refetch projection membership after successful mutation.

**Tech stack:** Rust, Axum, SQLite, Utoipa/OpenAPI, React 19, TanStack Query, React Aria Components, Vitest, Testing Library, Bun.

**Source of truth:** `docs/superpowers/specs/2026-08-12-stray-thoughts-followup-p1-design.md`

---

## Shared contracts

- `BoardTask.body_excerpt` is nullable and is always serialized. `null` means protected/unavailable; `""` means available but empty. Non-empty values are Markdown-to-plain-text excerpts bounded to 240 Unicode scalar values.
- `GET /api/vault/pages/by-id/{uuid}/properties` shares the existing route with PATCH. It returns current page revision, encryption state, every matching Base, and property declarations grouped by key.
- Base membership uses the existing SQL evaluator under `QueryContext::for_base`; never use the completion-only metadata matcher in the API.
- Duplicate declarations are compatible only after editor-semantic normalization: same type; exact ordered select options; relation `many: None` equals `Some(true)`; irrelevant schema fields are cleared. Otherwise the key is a data-level conflict and has no editor.
- Projection capabilities come from the backend. Reserved/system-shadow keys and `conversation` remain visible as declaration provenance but expose neither private values nor mutation controls.
- The frontend combines backend `patchable` capability with local locked and declaratively read-only Folio state.
- Property mutation continues through `PATCH /api/vault/pages/by-id/{uuid}/properties` with `expected_revision`. Successful mutation invalidates/refetches the GET projection because membership may change. A 409 retains the editor draft and offers the existing reload/discard conflict decision.

## Task 1: Add Tasking body excerpts end to end

**Files:**
- Modify: `src/vault/query.rs`
- Modify: `src/api/board/mod.rs`
- Modify: `src/api/board/read.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_board_test.rs`
- Modify: `tests/api_encryption_test.rs`
- Modify: `ui/src/api/schema.d.ts` through OpenAPI regeneration only
- Modify: `ui/src/components/tasking/TaskCard.tsx`
- Modify: `ui/src/components/tasking/__tests__/KanbanView.test.tsx`
- Modify: `ui/src/components/tasking/__tests__/fixtures.ts`

### Step 1: Write failing backend contracts

- Keep the excerpt converter's 239/240/241-scalar, multibyte, whitespace, Markdown, math, link-label, and raw-HTML cases attached to the one shared implementation.
- Add board-response coverage for rich Markdown, available empty body, a body over 240 Unicode scalars, and an encrypted TASK.
- Assert plain text, the 240-scalar bound, `""` for empty, `null` for protected, and absence of ciphertext/secret content.
- Cover both board bulk materialization and mutation read-back so every `BoardTask` constructor has the field.
- Strengthen the BoardTask OpenAPI assertion for nullable `body_excerpt`.

### Step 2: Share the existing excerpt converter

- Promote the existing `body_excerpt` implementation to the narrowest shared vault-domain visibility or move only that converter into a small shared module.
- Keep Base body projection semantics unchanged; no generic summarization abstraction or stored excerpt cache.

### Step 3: Extend both BoardTask projections

- Add `body_excerpt: Option<String>` to `BoardTask` without `skip_serializing_if`.
- In `load_tasks` and `build_board_task_dto`, add one `LEFT JOIN page_bodies` and select `CASE WHEN p.encrypted = 1 THEN NULL ELSE body_index.body END`.
- Convert selected bodies through the shared helper while constructing the DTO.
- Preserve one set-based board request and the existing SQLite snapshot boundary. No filesystem/page-detail reads per task.

### Step 4: Regenerate and render

- Regenerate `ui/src/api/schema.d.ts` from the running OpenAPI server; never hand-edit it.
- Render a truthy excerpt in `TaskCard` immediately below the title as secondary text with a fixed line clamp.
- Render no placeholder for `null`, empty, or omitted values. Do not change card activation, drag targets, filtering, checklist progress, tags, or inline-control propagation.

### Step 5: Focused verification

- Run the focused Rust board/encryption/OpenAPI tests and the existing excerpt/Base query tests.
- Run focused `KanbanView`/Tasking tests proving rendering and unchanged interactions.
- Commit one focused task commit.

## Task 2: Add the authoritative Folio property projection

**Files:**
- Modify: `src/api/properties.rs`
- Modify: `src/api/pages.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/property_patch.rs`
- Modify: `tests/openapi_contract.rs`
- Modify: `ui/src/docs/content/api-reference.mdx`
- Modify: `ui/src/api/schema.d.ts` through OpenAPI regeneration only

### Step 1: Write failing projection contracts

Cover:

- several matching Bases plus an excluded nonmatch;
- an index-only membership predicate such as `links_to`;
- complete declaration provenance and deterministic ordering;
- compatible duplicate scalar declarations and normalized relation `many`;
- conflicts for differing types, cardinality, ordered select options, and option order;
- absent, false, zero, empty-array, date, datetime, and raw incompatible values;
- no matching Bases versus matching Bases with no declared properties;
- encrypted page metadata without body exposure;
- suppressed `conversation` value and nonpatchable reserved/system-shadow declarations;
- unknown/malformed IDs and evaluator failure;
- PATCH followed immediately by GET showing authoritative membership entry/exit.

### Step 2: Define projection DTOs and compatibility

In `src/api/properties.rs`, add narrow DTOs for:

- matching Base identity (`slug`, display `name`);
- one declaration (`base`, original `PropertyDefinition`);
- compatibility (`compatible` or `conflict`);
- mutation blockers (`schema_conflict`, `reserved_key`);
- one grouped property (`key`, `present`, nullable value, normalized optional definition, declarations, `patchable`, blockers);
- response (`id`, `path`, `revision`, `encrypted`, matching Bases, grouped properties).

Normalize only editor-relevant fields. Never choose the first Base's schema implicitly.

### Step 3: Implement GET on the existing properties resource

- Resolve UUID/path and read the page once; compute exact-byte revision with the existing helper.
- Load the `BaseRegistry` once.
- Evaluate each Base authoritatively in one index closure with its own declaration context plus a `sys.id == uuid` constraint.
- Group all matched declarations by key and project only declared custom values through `toml_value_to_json`.
- Preserve provenance for reserved keys but suppress their values and editing capability, especially `conversation`.
- Treat schema conflicts as successful data; treat membership evaluation failures as request failures.

### Step 4: Wire route, OpenAPI, docs, and generated types

- Compose GET and PATCH at `/api/vault/pages/by-id/{uuid}/properties` in `pages::router`.
- Register the new path and schemas in `ApiDoc`.
- Update exact OpenAPI operation/schema tests and the canonical API reference heading.
- Regenerate `ui/src/api/schema.d.ts`; inspect that generated changes match the Rust contract.

### Step 5: Focused verification

- Run `tests/property_patch.rs`, OpenAPI contract tests, and docs API coverage.
- Run Rust formatting check on touched Rust files.
- Commit one focused task commit.

## Task 3: Add the dedicated Folio property panel

**Files:**
- Modify: `ui/src/api/bases.ts`
- Modify: `ui/src/api/keys.ts` only if the existing path-prefix key cannot address the new GET
- Modify: `ui/src/components/bases/EditableCell.tsx` only for a minimal reusable async/error contract
- Modify: `ui/src/components/bases/useBaseTableController.ts`
- Modify: `ui/src/components/codex/ReadingContinues.tsx`
- Create or modify a focused component under `ui/src/components/codex/` for the property panel
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Add focused panel tests following existing codex test placement

### Step 1: Write failing frontend contracts

Cover observable behavior for:

- no matching Bases;
- matching Bases with no properties;
- compatible duplicate declarations rendered once with all provenance;
- incompatible declarations showing current raw value and conflict with no editor;
- every supported editor type using existing `EditableCell` semantics;
- absent-property creation and clear-as-key-removal;
- successful PATCH with current revision followed by projection refetch;
- membership disappearance/appearance after save;
- 409 retaining the draft and exposing reload/discard;
- network mutation failure retaining the draft and a bounded retry/error state;
- locked and declaratively read-only Folios exposing values/provenance but no controls;
- panel projection failure leaving normal Folio reading/editing usable with retry;
- named controls, descriptions/provenance, focus visibility, desktop and mobile placement.

### Step 2: Add generated API hook and mutation result semantics

- Add generated-type aliases and a TanStack query hook for the GET projection in `ui/src/api/bases.ts`.
- Extend `invalidateBaseMutationQueries` so successful PATCH invalidates/refetches the page-property projection in addition to existing Base/query/page keys.
- Make `usePropertyCommit` expose an awaitable success/error result needed to retain drafts. Migrate `useBaseTableController` and `ReadingContinues` to the updated contract without changing their behavior.
- Do not create a panel-specific persistence store.

### Step 3: Build the panel from shared typed controls

- Reuse `EditableCell`, `CELL_EDITORS`, `CellValue`, and `formatCellValue`; do not embed `BaseTableView` or duplicate editor implementations.
- Use controlled edit state so a draft remains mounted until PATCH succeeds.
- For compatible patchable properties, send `set` or `clear`, schema date/datetime hints, and the projection revision to the existing PATCH route.
- For conflicts, reserved keys, locked pages, and declaratively read-only Folios, render formatted current values plus provenance only.
- Distinguish the two required empty states and provide bounded retry for projection errors.

### Step 4: Integrate with Folio surfaces

- Place the panel in the existing Folio detail/metadata layout rather than creating a parallel page mode.
- Supply current page UUID, path/state, local encryption lock state, and `folioReadOnly` from Folio's existing authority.
- Preserve body editing, metadata rails, links/backlinks, and mobile Folio behavior.

### Step 5: Focused verification

- Run focused API hook, shared editor, property-panel, and Folio tests.
- Run UI typecheck and lint on the completed task surface.
- Commit one focused task commit.

## Task 4: Whole-wave review, gates, smoke, and integration

### Step 1: Review

- Review each task commit against this plan and the approved design.
- Run a final whole-wave review for correctness, privacy, CAS behavior, accessibility, regressions, and accidental scope.
- Fix Critical/Important findings; record any concrete Minor deferral.

### Step 2: Repository gates

Run and report exactly:

- focused Rust and UI tests for changed contracts;
- `cargo fmt --check`;
- `cargo check`;
- `cargo clippy --all-targets --all-features -- -D warnings`;
- full `cargo test`;
- UI typecheck;
- UI lint;
- full UI test suite;
- production UI build;
- OpenAPI regeneration and generated-client type verification.

### Step 3: Browser smoke against a disposable vault

At desktop and mobile widths:

1. Open Tasking with rich, empty, long-Unicode, and encrypted task bodies. Verify bounded secondary excerpts, no protected content, and unchanged card interactions.
2. Open a Folio matching several Bases with compatible and conflicting declarations. Add, edit, clear, and deliberately revision-conflict a value.
3. Change a membership-driving property and verify the refreshed panel updates matching Bases/declarations.
4. Lock the Folio and exercise a declaratively read-only Folio; verify values/provenance remain and mutation controls disappear.

### Step 4: Integrate and record

- Merge the verified feature branch into local `develop` according to the project workflow.
- Re-run merged-result verification gates.
- Remove the feature worktree and branch.
- Through vault MCP only, mark Tasking body descriptions and the dedicated Folio property panel complete; update the P1 triage count and Wave 2 status.
