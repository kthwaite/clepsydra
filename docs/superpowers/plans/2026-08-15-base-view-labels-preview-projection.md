# Base View Labels and Preview Projection Implementation Plan

> **For agentic workers:** execute one task at a time with strict RED/GREEN evidence, exact-path commits, and a report in `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/`. Do not run project-wide formatters, linters, builds, or full suites inside tasks; the coordinator owns final gates.

**Goal:** Implement TSK-0085: per-view Base field labels plus one Base-level ordered property projection rendered in generic page and inactive-tab previews.

**Architecture:** Extend the canonical Base TOML model additively. Normalize preview references through the existing Base field resolver, merge matching Base projections deterministically in the existing page-properties response, generate TypeScript types from OpenAPI, and keep React authoring inside `BaseDefinitionWorkspace`’s explicit-save draft. Link and tab consumers fetch one shared TanStack Query response and pass projection state into the presentational `PreviewBody`.

**Tech stack:** Rust 2024, serde, toml/toml_edit, Axum 0.8, rusqlite, utoipa; React 19, TypeScript 5.9, TanStack Query, React Aria Components, Tailwind v4, Vitest/Testing Library.

**Approved specification:** `docs/superpowers/specs/2026-08-15-base-view-labels-preview-projection-design.md`

## Global constraints

- Strict RED/GREEN TDD. Observe each focused test fail for the intended missing behavior before implementation.
- `ui/src/api/schema.d.ts` is generated only; never hand-edit it.
- `ui/src/routeTree.gen.ts` is unrelated and must not be edited.
- Preserve Base non-ownership, exact revisions, comment-preserving TOML mutation, explicit Save/Discard, and existing property PATCH behavior.
- Stable references use the existing bare / `sys.` / `prop.` grammar. Canonical identity distinguishes system fields, custom properties, and `body`.
- `body` is projection-only and never writable.
- Matching Bases sort by slug; first projection occurrence fixes position; effective-label disagreement falls back to the canonical key with a conflict marker.
- API returns at most four fields plus `remaining_count`; configuration remains uncapped.
- Passive preview failures never toast or replace existing page content.
- Stage only files named by the active task. Never use `git add .` or `git add -A`.
- Every task ends with its focused tests green and one exact-path commit.

## Task interfaces and dependency graph

```text
Task 1 Base model + canonical projection identity
  ├── Task 2 comment-preserving Base document persistence
  ├── Task 3 authoritative page projection + OpenAPI
  │     ├── Task 4 frontend draft + authoring UI
  │     └── Task 5 link/tab preview data and rendering
  └──────────────────────────────────────────────┐
                                                 └── Task 6 documentation
```

Tasks 2 and 3 consume Task 1. Tasks 4 and 5 consume Task 3’s generated wire contract. Task 6 consumes the final observed behavior. The coordinator reviews every task before the next dependent task begins.

---

## Task 1: Base presentation model, canonical identity, and validation

**Files**

- Modify: `src/vault/base.rs`
- Modify: `src/vault/query.rs`
- Test: `src/vault/base.rs` test module
- Test: `src/vault/query.rs` test module
- Report: `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-1-report.md`

**Produces**

- `PreviewFieldDefinition { field, label }`.
- `BaseFile.preview: Vec<PreviewFieldDefinition>`.
- `ViewDefinition.labels` as a deterministic string map.
- A reusable projection-field resolver/canonical identity covering system, custom property, and `body` while retaining existing filter/sort rejection of `body`.
- Addressed Base diagnostics for empty labels, duplicate canonical preview identities, and unknown presentation references.

**Consumes**

- `SYSTEM_FIELDS`, `BODY_COLUMN`, `is_body_field_reference`.
- Existing `QueryContext` / `resolve_field` grammar and Base diagnostic conventions.

### Steps

1. Add failing serde tests proving:
   - legacy TOML produces empty `preview` and empty per-view labels;
   - new TOML preserves preview order and labels;
   - empty collections are omitted on serialization;
   - `body`, bare, `sys.`, and `prop.` references round-trip exactly.
2. Run the named tests and record RED because the fields/types do not exist.
3. Add failing validation tests proving:
   - whitespace-only labels are errors at `preview[i].label` and `views[i].labels.<field>`;
   - duplicate preview entries resolving to one canonical identity are errors at the later row;
   - unknown `sys.` references and unavailable custom-property references are warnings at addressed paths;
   - `body` presentation references are valid while writable `body` declarations remain invalid;
   - a shadowed custom property and system field remain distinct when explicitly qualified.
4. Run the named tests and record RED for missing validation.
5. Implement the additive serde model with defaults and empty omission.
6. Add the smallest reusable canonical projection identity/resolver. Do not weaken `resolve_field`’s current `ProjectionOnlyBody` behavior for filter/sort/group/aggregate callers.
7. Extend `validate_definition` through existing field-capability validation helpers; do not build another field registry.
8. Run focused Rust tests:

```bash
cargo test vault::base::tests -- --nocapture
cargo test vault::query::tests -- --nocapture
```

9. Record RED/GREEN commands and results in the task report.
10. Commit exact paths:

```bash
git add src/vault/base.rs src/vault/query.rs .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-1-report.md
git commit -m "feat(bases): model preview fields and view labels"
```

---

## Task 2: Comment-preserving presentation metadata persistence

**Files**

- Modify: `src/vault/base_document.rs`
- Test: `src/vault/base_document.rs` test module
- Report: `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-2-report.md`

**Produces**

- Managed root `preview` mutation.
- Managed per-view `labels` mutation through existing named-view identity mapping.
- Preservation/removal behavior matching the approved specification.

**Consumes**

- Task 1’s `BaseFile.preview` and `ViewDefinition.labels`.
- Existing `merge_document`, `merge_views_key`, `ViewOrigin`, revision, and byte-preservation contracts.

### Steps

1. Add failing tests for new-file serialization of ordered preview entries and view labels.
2. Add failing update tests proving:
   - adding/editing/reordering/removing `preview` preserves unrelated root comments and unknown keys;
   - adding/editing/removing `views.labels` preserves unknown keys/comments in the correctly mapped named view;
   - reordering/renaming views still associates label edits with the supplied `ViewOrigin`;
   - removing the final preview row or label removes only that empty managed node;
   - stale revisions leave bytes unchanged.
3. Run each named test and record RED because `preview` is not managed and/or label nodes are not merged safely.
4. Add `preview` to the root managed-key set and route it through existing structural merge primitives.
5. Reuse named-view merge logic for `labels`; do not replace a whole view table when a targeted nested merge is possible.
6. Keep unknown/comment-bearing node removal safeguards intact.
7. Run focused tests:

```bash
cargo test vault::base_document::tests -- --nocapture
```

8. Record evidence and commit:

```bash
git add src/vault/base_document.rs .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-2-report.md
git commit -m "feat(bases): persist presentation metadata losslessly"
```

---

## Task 3: Authoritative page preview projection and generated wire contract

**Files**

- Modify: `src/vault/query.rs`
- Modify: `src/api/properties.rs`
- Modify: `src/api/openapi.rs`
- Modify by regeneration only: `ui/src/api/schema.d.ts`
- Test: `src/vault/query.rs` test module
- Test: `tests/property_patch.rs`
- Test: `src/api/openapi.rs` test module
- Report: `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-3-report.md`

**Produces**

- Read-only current-page projection for canonical system/custom/body fields.
- `PagePreviewProjection`, `PagePreviewField`, and source/provenance DTOs.
- Required `PageBasePropertiesResponse.preview`.
- Deterministic multi-Base merge, label/schema conflict flags, missing-value distinction, protected-page suppression, four-field cap, and remainder count.
- Regenerated TypeScript schema.

**Consumes**

- Task 1 canonical identities and Base metadata.
- Existing matching-Base evaluation and grouped declaration compatibility in `properties.rs`.
- Existing `body_excerpt`, effective-kind/tag logic, page metadata, and page raw body.

### Steps

1. Add failing query/domain tests for projecting each system shape, custom scalars/arrays, missing custom values, and `body` through `body_excerpt`. Include Unicode excerpt behavior and effective tags.
2. Run the named tests and record RED for the absent page-field projection helper.
3. Implement one read-only projection helper in `vault::query`; avoid SQL per projected field and avoid cloning the page body.
4. Add failing integration tests in `tests/property_patch.rs` for:
   - no matches and matches without preview configuration returning empty required projection;
   - slug/list ordering and same-canonical-key de-duplication;
   - agreed default/explicit labels and disagreement fallback;
   - schema conflicts retaining a conservative raw value plus conflict flag;
   - present false versus present values, arrays, false, zero, and non-finite/null conversion;
   - `body` excerpt;
   - protected page returning an empty preview while retaining existing property response behavior;
   - first four fields and exact remainder count;
   - existing `properties`, blockers, compatibility, and PATCH tests unchanged.
5. Run the new integration tests and record RED because the response has no preview contract.
6. Implement DTOs and merge inside the existing projection path. Resolve each value once per merged canonical identity. Pre-index compatibility by custom key rather than rescanning all declarations for each row.
7. Register new schemas in `src/api/openapi.rs`; add a focused OpenAPI test asserting `preview` is required and nested fields have required `present`, `value`, and conflict booleans.
8. Run focused backend tests:

```bash
cargo test --test property_patch get_ -- --nocapture
cargo test api::openapi::tests -- --nocapture
cargo test vault::query::tests -- --nocapture
```

9. Regenerate, never hand-edit, `ui/src/api/schema.d.ts` using a temporary initialized vault and a harness-managed server on port 3000:
   - create a temporary `XDG_CONFIG_HOME` and initialize a disposable vault;
   - start `cargo run -- serve --port 3000` through the process manager after `ui/dist` exists;
   - run `bun run openapi` from `ui/`;
   - stop the server;
   - confirm generated `BaseFilePayload`, `ViewDefinition`, and `PageBasePropertiesResponse` contain the new required/optional fields.
10. Run `bun run typecheck` only to expose generated-contract callsites that Task 4/5 must migrate. Record expected failures precisely if consumers do not yet provide required fields; do not patch frontend consumers in this task.
11. Record evidence and commit:

```bash
git add src/vault/query.rs src/api/properties.rs src/api/openapi.rs tests/property_patch.rs ui/src/api/schema.d.ts .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-3-report.md
git commit -m "feat(api): project Base fields into page previews"
```

---

## Task 4: Frontend draft model and authoring controls

**Files**

- Modify: `ui/src/components/bases/definition-model.ts`
- Modify: `ui/src/components/bases/local-validation.ts`
- Modify: `ui/src/components/bases/BaseDefinitionWorkspace.tsx`
- Modify: `ui/src/components/bases/ViewsEditor.tsx`
- Modify: `ui/src/components/bases/ViewDefinitionEditor.tsx`
- Create: `ui/src/components/bases/PreviewPropertiesEditor.tsx`
- Create if separation improves focus: `ui/src/components/bases/DisplayLabelsEditor.tsx`
- Test: `ui/src/components/bases/__tests__/definition-model.test.ts`
- Test: `ui/src/components/bases/__tests__/local-validation.test.ts`
- Test: `ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx`
- Test: `ui/src/components/bases/__tests__/ViewsEditor.test.tsx`
- Create: `ui/src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx`
- Report: `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-4-report.md`

**Produces**

- `BaseDraft.preview` with client-only row identity.
- `DraftView.labels`.
- Exact wire/draft conversion, defaults, cloning, and local validation.
- Base-level Preview properties editor after Properties.
- Per-view Display labels subsection.
- Existing explicit Save/Discard/conflict lifecycle for both additions.

**Consumes**

- Task 3 generated types.
- Existing `SYSTEM_PROPERTY_FIELDS`, property draft list, `moveItem`, diagnostic focus registration, and React Aria `Button`/field control patterns.

### Steps

1. Add failing model tests for wire/draft round trip, stable references, preview order, labels, client-only IDs, `createMinimalDraft`, and clone isolation.
2. Run the file and record RED.
3. Implement draft/wire conversion without casts or manual duplicate wire interfaces.
4. Add failing local-validation tests for empty labels, duplicate canonical preview identity, unknown references, and valid `body`/qualified shadow references.
5. Implement client validation matching backend diagnostic paths so Save disables before a round trip.
6. Add failing editor tests proving:
   - a Preview properties definition-navigation section appears immediately after Properties;
   - add, optional label edit, Move up/down, Remove, focus preservation, and live announcements;
   - duplicate choices are disabled with readable reasons;
   - `body` appears once and is described as read-only;
   - per-view Add label, edit, Reset, fields outside columns, and `body`;
   - label changes do not mutate columns, sorts, filters, aggregates, or property declarations;
   - Save payload includes presentation metadata, Discard restores it, and no mutation occurs before Save;
   - server diagnostics focus exact preview/label controls.
7. Run the focused files and record RED.
8. Implement controls using existing square Vessel styling and React Aria components. Move up/down must remain directly keyboard-operable; drag-and-drop is optional and must not be the only path.
9. Preserve logical row IDs across successful save responses where needed, as existing property/view identity does.
10. Run focused tests:

```bash
bun run test -- src/components/bases/__tests__/definition-model.test.ts src/components/bases/__tests__/local-validation.test.ts src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
bun run typecheck
```

11. Record evidence and commit exact paths:

```bash
git add ui/src/components/bases/definition-model.ts ui/src/components/bases/local-validation.ts ui/src/components/bases/BaseDefinitionWorkspace.tsx ui/src/components/bases/ViewsEditor.tsx ui/src/components/bases/ViewDefinitionEditor.tsx ui/src/components/bases/PreviewPropertiesEditor.tsx ui/src/components/bases/DisplayLabelsEditor.tsx ui/src/components/bases/__tests__/definition-model.test.ts ui/src/components/bases/__tests__/local-validation.test.ts ui/src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx ui/src/components/bases/__tests__/ViewsEditor.test.tsx ui/src/components/bases/__tests__/PreviewPropertiesEditor.test.tsx .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-4-report.md
git commit -m "feat(ui): author Base labels and preview fields"
```

Omit the optional `DisplayLabelsEditor.tsx` from staging if it was not created.

---

## Task 5: Shared link and tab preview projection rendering

**Files**

- Modify: `ui/src/api/bases.ts`
- Modify: `ui/src/api/bases.test.ts`
- Modify: `ui/src/components/codex/PreviewBody.tsx`
- Modify: `ui/src/components/codex/LinkPreviewLayer.tsx`
- Modify: `ui/src/components/codex/TabPreviewCard.tsx`
- Modify: `ui/src/components/codex/PreviewBody.stories.tsx`
- Test: `ui/src/components/codex/__tests__/LinkPreviewLayer.test.tsx`
- Create: `ui/src/components/codex/__tests__/PreviewBody.test.tsx`
- Create: `ui/src/components/codex/__tests__/TabPreviewCard.test.tsx`
- Report: `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-5-report.md`

**Produces**

- Generated projection type exports.
- Both preview containers call the same `usePageBaseProperties(page?.meta.id ?? "")` query.
- Presentational projection state passed to `PreviewBody`.
- Compact values, missing em dash, conflict explanations, body row, `+N more`, passive error, and protected behavior.

**Consumes**

- Task 3 generated response and existing query key/cache behavior.
- Existing `usePage`, `useBacklinks`, `PreviewBody`, and preview width/clamping.

### Steps

1. Extend `ui/src/api/bases.test.ts` with a failing contract test proving two hook consumers for one UUID share the generated query key/cache and that empty UUID disables the request.
2. Add failing `PreviewBody` tests for agreed values, missing em dash, explicit null, arrays, body layout, conflict markers with accessible descriptions, `+N more`, unavailable state, empty projection, and protected suppression. Retain existing title/excerpt/count/tag assertions.
3. Add failing container tests proving:
   - link and tab previews wait for `page.meta.id` before property fetch;
   - each passes success/error/pending state into `PreviewBody`;
   - no toast fires on query failure;
   - tab card remains `pointer-events: none`;
   - existing navigation and hover behavior remains intact.
4. Run the focused tests and record RED.
5. Export only generated projection types required by rendering.
6. Fetch at the two container boundaries; do not put a data hook in `PreviewBody`.
7. Add a small formatter over generated JSON values. Keep it deterministic, non-editing, and bounded; reuse existing text/date conventions where available.
8. Render the definition list after Markdown and before tags, with semantic/accessibility text for conflicts. Do not delay existing preview chrome while pending.
9. Update stories for success, conflict/missing, loading, failure, and protected states.
10. Run focused verification:

```bash
bun run test -- src/api/bases.test.ts src/components/codex/__tests__/PreviewBody.test.tsx src/components/codex/__tests__/LinkPreviewLayer.test.tsx src/components/codex/__tests__/TabPreviewCard.test.tsx
bun run typecheck
```

11. Record evidence and commit:

```bash
git add ui/src/api/bases.ts ui/src/api/bases.test.ts ui/src/components/codex/PreviewBody.tsx ui/src/components/codex/LinkPreviewLayer.tsx ui/src/components/codex/TabPreviewCard.tsx ui/src/components/codex/PreviewBody.stories.tsx ui/src/components/codex/__tests__/PreviewBody.test.tsx ui/src/components/codex/__tests__/LinkPreviewLayer.test.tsx ui/src/components/codex/__tests__/TabPreviewCard.test.tsx .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-5-report.md
git commit -m "feat(ui): show Base fields in page previews"
```

---

## Task 6: Bases documentation and focused cross-contract regression

**Files**

- Modify: `ui/src/docs/content/bases.mdx`
- Modify only if a missing cross-contract assertion is found: nearest existing Task 1–5 test file
- Report: `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-6-report.md`

**Produces**

- User-facing configuration and behavior documentation matching the shipped contract.
- One focused regression only if review finds an uncovered observable boundary; no source-text or plumbing tests.

**Consumes**

- Final implementation and approved design.

### Steps

1. Document exact `preview` and `views.labels` TOML.
2. Explain stable/qualified field references, independent columns versus generic preview, read-only `body`, multi-Base ordering/de-duplication, label/schema conflicts, missing em dash, four-field cap, and revision/conflict behavior.
3. Cross-check names and output against generated schema and rendered UI. Remove any speculative behavior.
4. Run the nearest documentation build/typecheck only if MDX imports/components changed; plain prose needs no synthetic test.
5. Record evidence and commit:

```bash
git add ui/src/docs/content/bases.mdx .superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-6-report.md
git commit -m "docs(bases): explain labels and preview projection"
```

Include a test path in the commit only if the report names the specific uncovered contract it protects.

---

## Coordinator review and final verification

After every task is implemented and individually reviewed:

1. Review the complete branch against the approved specification and task reports.
2. Build UI assets before Rust gates because `rust-embed` requires `ui/dist`.
3. Run repository gates:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
bun run typecheck          # from ui/
bun run lint               # from ui/
bun run test               # from ui/
bun run build              # from ui/
```

4. Run changed-file Biome checks if repository-wide lint reports only known upstream diagnostics; do not suppress unrelated diagnostics.
5. Start the actual feature server through the process manager and perform browser verification from the specification:
   - create or edit a disposable Base in the UI;
   - add labels and at least five preview fields including `body` and one missing value;
   - save, reload, and inspect on-disk/server state through the UI;
   - hover a path-backed link and inactive page tab;
   - observe four fields, `+1 more`, missing em dash, body excerpt, and label text;
   - exercise a multi-Base label conflict;
   - verify normal and narrow viewport overflow;
   - verify stored page property keys/values remain unchanged after label edits.
6. Request final broad code review. Correct and re-review every Critical/Important finding.
7. Merge with `--no-ff` into `develop`, update TSK-0085 checklist and status to SEALED, remove the feature worktree/branch, and report exact gate/browser evidence.
