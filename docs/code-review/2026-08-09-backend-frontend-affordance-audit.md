# Backend–Frontend Affordance Audit

Date: 2026-08-09  
Scope: registered HTTP routes, CLI surfaces, the React frontend, and the browser extension.  
Method: static route inventory, frontend call-site and reachability tracing, source-level stub/TODO review, generated OpenAPI comparison, and `bun run knip`.

## Executive Summary

Clepsydra registers **89 HTTP operations**: 88 under `/api/vault` and one root deeplink redirect.

- **56** operations have a live integration through the web UI, browser extension, or OS deeplink flow.
- **33** operations have no live frontend affordance.
- Six of those 33 are alternate client APIs with equivalent UI behavior.
- The remaining **27 operations represent substantive missing or partially surfaced product capabilities**.

The largest gaps are the academic library, attachment and archive-media handling, page/folder organization, and index diagnostics. Seven additional implementation areas are visibly partial: CAS rendering, archive fidelity, OpenAPI coverage, pagination, settings placeholders, synthetic task telemetry, and explicit stubs.

## Missing Frontend Coverage

| Backend area | Missing operations | Assessment |
| --- | ---: | --- |
| Academic library | 10 | Entire subsystem has CRUD, annotations, and BibTeX/DOI/ISBN/Zotero imports, but no UI route or component. |
| Attachments | 4 | List/get/upload/delete exist, but there is no live attachment manager or editor support. |
| Pages and folders | 9 | Page move/default creation/by-ID operations and most folder management are absent. |
| Index maintenance | 6 | No unresolved-link, ambiguity, warning, rebuild, mutation-preview, or atomic create-from-link UI. |
| Archive CAS | 1 | The extension creates `cas:` resources, but the editor does not resolve them. |
| Journal alternatives | 2 | Range and by-date APIs are unused; the UI reaches journals through general page navigation instead. |
| Generic query | 1 | The backend supports ad-hoc structured queries, but only saved Base views are exposed. |
| **Total** | **33** | |

The six alternate client-oriented operations are page get/update by UUID, folder top-level/content reads, and journal range/by-date reads. They lack direct frontend calls but have broadly equivalent live UI flows.

## Findings

### P1 · High benefit: archive and media handling is broken at the frontend seam

The archive extension emits `cas:<hash>` links and the backend serves them through `GET /api/vault/cas/{hash}`. The archive design explicitly requires the frontend to rewrite those links, but the current editor treats non-HTTP links as vault page paths.

Evidence:

- CAS serving: `src/api/archive.rs:416`
- Intended frontend rewrite: `docs/plans/archive/2026-02-14-browser-extension-design.md:218`
- Current link dispatch: `ui/src/editor/elements/LinkElement.tsx:80`

Images are also reduced to alt text during Markdown-to-Slate conversion:

- `ui/src/editor/convert/mdast-to-slate.ts:382`

Impact: archived snapshots and archived images cannot be opened or rendered correctly in the primary editor.

Suggested change: centralize resource-URL resolution, rewrite `cas:<hash>` to `/api/vault/cas/<hash>`, add an image element to the Slate schema, and cover both editable and read-only renderers with CAS integration tests.

The extension itself is partial. It stores `document.documentElement.outerHTML` and contains an explicit TODO to integrate SingleFile for faithful, self-contained snapshots:

- `extension/src/content/capture.ts:30`

### P1 · High benefit: academic and attachment backends are effectively headless

The academic router exposes ten operations, including four importers, but there is no academic route, API wrapper, or user-facing component under `ui/src`:

- `src/api/academic.rs:187`

The backend is itself partial relative to its feature contract. The specified work-asset attachment endpoint and annotation-to-work reverse lookup are absent:

- `002-academic-library.md:185`
- `002-academic-library.md:497`

The attachment router similarly provides four complete operations with no live UI:

- `src/api/attachments.rs:39`

Suggested change: implement media rendering first, then add attachment upload/browse/delete controls and an academic route covering works, annotations, and imports.

### P2 · High benefit: page and folder organization is only partly surfaced

The backend supports page move/rename, safe deletion, mutation previews, folder create/delete/move, and folder-content listing:

- `src/api/pages.rs:260`
- `src/api/folders.rs:58`

The live UI exposes page creation/editing and assignment, but:

- There is no general page move or rename control.
- Page deletion is exposed only as task destruction, not for ordinary notes.
- There is no live folder create, delete, or move control.
- The only folder-create UI is in an unused legacy `Sidebar`: `ui/src/components/Sidebar.tsx:23`.
- There is no safe mutation preview despite both HTTP and MCP support.

`bun run knip` confirmed that `Sidebar`, `PageList`, `PageHeader`, `SyncIndicator`, and two other frontend files are unused; it also flags `useCreateFolder` as an unused export.

Suggested change: add a single page/folder context-menu workflow backed by mutation preview, then require confirmation before move or destructive operations.

### P2 · Medium benefit: index diagnostics exist, but Settings advertises placeholders

Six index operations have no UI integration: unresolved links, ambiguous names, warnings, rebuild, create-from-link, and mutation preview.

- Backend router: `src/api/index_routes.rs:185`
- Frontend wrapper: `ui/src/api/index.ts:3`

Settings shows Diagnostics and Data Management as “Coming Soon,” even though several corresponding backend operations already exist. Editor defaults and Markdown tools are placeholders too:

- `ui/src/components/SettingsModal.tsx:130`

Suggested change: add an index-health panel with unresolved/ambiguous links and warnings, plus guarded rebuild and data-maintenance actions.

### P2 · Medium benefit: 17 active API operations are absent from OpenAPI

The generated schema contains 71 operations, while the router registers 88 API operations. The omitted 17 are:

- Archive/CAS: 3
- Journal: 6
- Tasks: 2
- Agenda: 3
- Blocks: 3

The OpenAPI path registration ends without these modules:

- `src/api/openapi.rs:73`

Consequently, those frontend integrations use raw `fetch` and hand-maintained response interfaces instead of the typed client:

- `ui/src/api/journal.ts:32`
- `ui/src/api/tasks.ts:34`
- `ui/src/api/blocks.ts:17`

Suggested change: annotate and register all active routes, regenerate `ui/src/api/schema.d.ts`, and migrate these wrappers to the generated client.

### P2 · Medium benefit: pagination is cosmetic

`list_pages` loads every matching page and then applies offset/limit in Rust. It presents a paginated contract without reducing database work:

- `src/api/pages.rs:396`
- `src/api/pagination.rs:27`

Suggested change: execute a separate count query and push `LIMIT`/`OFFSET` into the page-list SQL.

### P3 · Low/medium benefit: visible prototype and stub behavior remains

- Tasking’s 14-day seal sparkline is hardcoded: `ui/src/components/tasking/BoardHeader.tsx:126`.
- Cycle burndown is synthetic rather than historical telemetry: `ui/src/components/tasking/CycleView.tsx:125`.
- `clepsydra env` is publicly advertised but only prints “not implemented yet”: `src/bin/cli.rs:264`.
- Inquiry is an explicitly deferred stub with no model, API, or live panel: `_features/005-codex-inquiry-list.md:1`.
- Habits is an explicitly deferred stub with no model, API, or live panel: `_features/006-codex-habits.md:1`.

Bases intentionally supports only table layouts in both backend and guided editor. This appears to be a declared v1 limitation rather than accidental incompleteness:

- `src/vault/base.rs:771`
- `ui/src/components/bases/ViewDefinitionEditor.tsx:198`

## Areas With Good End-to-End Coverage

The following are substantially integrated and were not counted as gaps:

- Encrypted-note setup, lock/unlock, password change, protect, and unprotect flows
- Base creation, editing, preview, saved-view evaluation, deletion, and property patching
- Board/task/cycle CRUD and agenda views
- Today-journal creation and quick capture
- Page editing, assignment, search, graph, backlinks, outlinks, and similar pages
- BCL, vault location/geocoding, uptime, event-stream invalidation, and deeplink resolution
- Browser-extension archive ingest and status checks, excluding CAS rendering and snapshot fidelity

## Recommended Order of Work

1. Repair `cas:` and image rendering, then expose attachments.
2. Add page/folder move, delete, and mutation-preview controls.
3. Build the academic library and importer UI.
4. Surface index health and maintenance under Settings.
5. Register the missing 17 OpenAPI operations and remove raw client contracts.
6. Replace cosmetic pagination and synthetic task telemetry.

## Verification Notes

No implementation files were changed during the audit. The evidence is based on static repository inspection and `bun run knip`, rather than runtime UI acceptance testing. `knip` exited non-zero because it found the existing unused-file, export, and dependency inventory described above.
