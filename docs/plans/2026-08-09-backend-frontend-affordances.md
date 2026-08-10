# Backend–Frontend Affordances Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the substantive backend/frontend affordance gaps in the audited order, with safe mutation UX, typed API coverage, and real data replacing cosmetic behavior.

**Architecture:** Extend the existing registry-driven Slate editor and generated OpenAPI client instead of creating parallel rendering or networking stacks. Put shared resource resolution and data hooks at the API/editor boundaries, keep destructive operations behind backend mutation previews, and add each product surface to the existing route and settings shells.

**Tech Stack:** Rust/Axum/SQLite, React 19, TanStack Router and Query, Slate, TypeScript, Vitest/Testing Library, Bun, Biome, Cargo.

## Checkpoint 1: CAS resources and image nodes

**Files:**
- Create: `ui/src/lib/resourceUrl.ts`
- Create: `ui/src/lib/__tests__/resourceUrl.test.ts`
- Create: `ui/src/editor/schema/elements/image.tsx`
- Modify: `ui/src/editor/schema/types.ts`
- Modify: `ui/src/editor/schema/registry.ts`
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`
- Modify: `ui/src/editor/elements/LinkElement.tsx`
- Modify: `ui/src/components/MarkdownRenderer.tsx`
- Test: `ui/src/editor/convert/__tests__/mdast-to-slate.test.ts`
- Test: `ui/src/editor/convert/__tests__/round-trip.test.ts`
- Test: `ui/src/components/MarkdownRenderer.test.tsx`

1. Add failing tests for `cas:<hash>` URL resolution, ordinary external links, and vault-page links.
2. Add failing conversion and round-trip tests proving Markdown images remain typed image nodes with alt text, optional title, and source.
3. Implement a pure resource resolver that maps CAS URIs to `/api/vault/cas/<hash>` and classifies external versus internal targets.
4. Add the registry-owned void image element and use the resolver from both image rendering and link activation.
5. Run `cd ui && bun run test -- src/lib/__tests__/resourceUrl.test.ts src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/round-trip.test.ts src/components/MarkdownRenderer.test.tsx`.
6. Run `cd ui && bun run lint && bun run build`.
7. Commit: `feat(ui): render archived CAS links and images`.

## Checkpoint 2: Attachment management

**Files:**
- Create: `ui/src/api/attachments.ts`
- Create: `ui/src/components/attachments/AttachmentManager.tsx`
- Create: `ui/src/components/attachments/__tests__/AttachmentManager.test.tsx`
- Modify: `ui/src/components/PageView.tsx`
- Modify: `ui/src/editor/Editor.tsx`

1. Add failing API-hook tests for list, upload, retrieve URL, and delete behavior.
2. Add failing component tests for empty, loading, upload, copy/insert, and confirmed-delete states.
3. Implement generated-client hooks and a lazy attachment panel in the page workspace.
4. Insert selected images as Markdown image nodes and other files as links using vault attachment URLs.
5. Run focused tests, then `cd ui && bun run lint && bun run build`.
6. Commit: `feat(ui): expose page attachment management`.

## Checkpoint 3: Page and folder mutations

**Files:**
- Modify: `ui/src/api/pages.ts`
- Modify: `ui/src/api/folders.ts`
- Modify: `ui/src/api/index.ts`
- Create: `ui/src/components/page-tree/PageActionsMenu.tsx`
- Create: `ui/src/components/page-tree/FolderActionsMenu.tsx`
- Create: `ui/src/components/page-tree/MutationPreviewDialog.tsx`
- Test: `ui/src/components/page-tree/__tests__/mutation-actions.test.tsx`

1. Add failing hook and interaction tests for rename/move/delete plus folder create/move/delete.
2. Implement a common mutation-preview query and a dialog that shows affected paths, warnings, and link rewrites.
3. Require a fresh preview before executing destructive or path-changing mutations, then invalidate page, folder, search, and graph queries.
4. Run focused tests, the full UI suite, lint, and build.
5. Commit: `feat(ui): add previewed page and folder mutations`.

## Checkpoint 4: Academic library and importers

**Files:**
- Create: `ui/src/api/academic.ts`
- Create: `ui/src/routes/academic.tsx`
- Create: `ui/src/components/academic/AcademicLibrary.tsx`
- Create: `ui/src/components/academic/WorkDetail.tsx`
- Create: `ui/src/components/academic/ImportDialog.tsx`
- Test: `ui/src/components/academic/__tests__/academic-library.test.tsx`

1. Add failing tests for work listing/detail, annotation CRUD, and BibTeX/DOI/ISBN/Zotero import modes.
2. Implement typed query/mutation hooks with cache invalidation shared across list and detail views.
3. Add the route, searchable work list, work detail, annotation editor, and validated importer dialog.
4. Run focused tests, full UI tests, lint, and build.
5. Commit: `feat(ui): add academic library and import workflows`.

## Checkpoint 5: Index health and maintenance

**Files:**
- Modify: `ui/src/api/index.ts`
- Modify: `ui/src/components/SettingsModal.tsx`
- Create: `ui/src/components/settings/IndexHealthPanel.tsx`
- Test: `ui/src/components/settings/__tests__/IndexHealthPanel.test.tsx`

1. Add failing tests for unresolved links, ambiguous names, warnings, atomic create-from-link, and guarded rebuild.
2. Implement parallel index-health queries with explicit partial-error states.
3. Replace the Diagnostics/Data Management placeholders with evidence lists and confirmed maintenance actions.
4. Run focused tests, full UI tests, lint, and build.
5. Commit: `feat(ui): surface index diagnostics and maintenance`.

## Checkpoint 6: Complete OpenAPI coverage

**Files:**
- Modify: `src/api/archive.rs`
- Modify: `src/api/journal.rs`
- Modify: `src/api/tasks.rs`
- Modify: `src/api/agenda.rs`
- Modify: `src/api/blocks.rs`
- Modify: `src/api/openapi.rs`
- Regenerate: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/journal.ts`
- Modify: `ui/src/api/tasks.ts`
- Modify: `ui/src/api/blocks.ts`
- Test: `tests/openapi_contract.rs`

1. Add a failing contract test asserting all 88 registered `/api/vault` operations appear in OpenAPI.
2. Annotate and register the missing archive, journal, task, agenda, and block operations.
3. Build the UI assets if required, regenerate `schema.d.ts`, and migrate raw wrappers to the generated client.
4. Run the contract test, Rust API tests, full UI tests, lint, and build.
5. Commit: `refactor(api): complete generated client coverage`.

## Checkpoint 7: Database-backed page pagination

**Files:**
- Modify: `src/api/pages.rs`
- Modify: `src/index/query.rs`
- Test: `tests/api_pages.rs`

1. Add a failing integration test that verifies stable total/count semantics and page boundaries.
2. Add a separate filtered count query and apply `LIMIT`/`OFFSET` in SQL with deterministic ordering.
3. Run focused Rust tests and `cargo test --all-targets`.
4. Commit: `perf(api): paginate page queries in sqlite`.

## Checkpoint 8: Real task telemetry

**Files:**
- Modify: `src/api/tasks.rs`
- Modify: `src/api/agenda.rs`
- Modify: `ui/src/api/tasks.ts`
- Modify: `ui/src/components/tasking/BoardHeader.tsx`
- Modify: `ui/src/components/tasking/CycleView.tsx`
- Test: `ui/src/components/tasking/__tests__/telemetry.test.tsx`

1. Add failing backend and component tests for 14-day completion counts and historical cycle burndown.
2. Return real time-series data from the task/agenda API without per-day query waterfalls.
3. Replace hardcoded and synthetic chart values with typed query data plus honest empty states.
4. Run focused tests, full UI tests, lint, build, and `cargo test --all-targets`.
5. Commit: `feat(tasking): replace synthetic telemetry with history`.

## Final verification

1. Run `cd ui && bun run test && bun run lint && bun run build`.
2. Run `cd extension && bun run test`.
3. Run `cargo test --all-targets` after `ui/dist` exists.
4. Run `cd ui && bun run knip`; compare remaining findings with the audit and document known unrelated leftovers.
5. Manually verify archived CAS links/images, attachment insertion, mutation previews, academic imports, index diagnostics, and task telemetry in the running app.
6. Use `superpowers:finishing-a-development-branch` and present merge/PR options without merging or pushing unless approved.
