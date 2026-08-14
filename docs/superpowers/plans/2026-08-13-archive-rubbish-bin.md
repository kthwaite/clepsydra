# Archive and Rubbish Bin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Each task uses strict RED/GREEN TDD, receives a fresh implementation subagent, and is reviewed for specification compliance and code quality before the next task begins.

**Goal:** Replace permanent individual-page deletion with a byte-preserving active → rubbish → restored/purged lifecycle across Rust, REST/OpenAPI, MCP, and React, while leaving folder deletion explicitly permanent.

**Architecture:** A new `RubbishStore` owns `.clepsydra/rubbish/<item-id>/{page.md,manifest.json}` and validated item identities. `VaultIndex` owns a rebuildable `rubbish_items` catalog, while the CAS owns purge idempotency. Explicit archive/restore batch intents reuse the existing mutation coordinator's locks, expected-byte validation, staged publication, rollback, recovery, index reconciliation, and notification boundary; they never reuse `MovePage` or `DeletePage`. Dedicated API/MCP/UI surfaces address rubbish items only by opaque item UUID.

**Tech Stack:** Rust, Axum, rusqlite, serde, utoipa, rmcp, React 19, TypeScript, TanStack Router/Query, Vitest, Testing Library, Biome.

**Approved specification:** `docs/superpowers/specs/2026-08-13-archive-rubbish-bin-design.md`

**Global constraints:**

- Page bytes are immutable through archive and restore. Never parse then reserialize `page.md`.
- Rubbish item IDs are UUIDs, not `VaultPath`s. Internal paths are constructed only by `RubbishStore`.
- Archive/restore never rewrite inbound links and never invoke `PostMoveHook` or `PostDeleteHook`.
- CAS references change only during purge, through an item-ID idempotency ledger.
- Existing hard-delete `force`/`rewrite` contracts and `vault_delete_page` are removed; no compatibility shim.
- Recursive folder deletion remains permanent and outside this lifecycle.
- Do not hand-edit `ui/src/api/schema.d.ts`; regenerate it from OpenAPI.

---

## Task 1: Implement the validated rubbish store

**Files:**
- Create: `src/vault/rubbish.rs`
- Modify: `src/vault/mod.rs`
- Test: `src/vault/rubbish.rs` unit-test module

### Step 1: Write failing store tests

Cover observable storage rules:

- `RubbishManifest::new` records version 1, independent item/page UUIDs, validated original Markdown path, title, kind, deletion timestamp, and optional archive URL.
- `prepare_item` rejects malformed IDs and path traversal; callers never supply or concatenate internal filesystem paths.
- durable publication creates exactly `<root>/<item-id>/page.md` and `manifest.json` and preserves arbitrary/encrypted bytes exactly.
- `read_item` validates manifest ID against directory ID and validates the original vault path.
- unsupported manifest versions and malformed JSON return typed item validation errors without modifying bytes.
- enumeration returns valid and invalid entries, newest valid entries first with deterministic item-ID tie-breaking.
- duplicate publication refuses an occupied item directory.

Use `tempfile::TempDir`, fixed timestamps, and fixed UUIDs. Assert byte equality, not parsed-page equality.

### Step 2: Run the focused tests and observe RED

Run: `cargo test vault::rubbish::tests -- --nocapture`

Expected: compilation/test failures because the store and types do not exist.

### Step 3: Implement the minimum store

Add boring domain types:

```rust
pub const RUBBISH_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RubbishManifest { /* exact fields from the approved spec */ }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RubbishItem { pub manifest: RubbishManifest, pub bytes: Vec<u8> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RubbishListEntry {
    Valid(RubbishManifest),
    Invalid { item_id: String, error: String },
}

pub struct RubbishStore { root: PathBuf }
```

The store owns `item_dir`, `page_path`, and `manifest_path`; keep those helpers private. Parse item IDs with `uuid::Uuid`, original paths with `VaultPath`, use version-first validation, and use `atomic_file`/directory fsync patterns already present in `src/vault/atomic_file.rs` and `src/vault/batch_mutation.rs`. Keep publication primitives suitable for Task 4's transaction coordinator: staging must be separable from final rename and cleanup.

### Step 4: Run focused tests and observe GREEN

Run: `cargo test vault::rubbish::tests -- --nocapture`

Expected: all rubbish-store unit tests pass.

### Step 5: Self-review and commit

Check: no normal vault indexing, hooks, link rewriting, or CAS behavior has leaked into the store.

```bash
git add src/vault/rubbish.rs src/vault/mod.rs
git commit -m "feat(vault): add validated rubbish item store"
```

---

## Task 2: Add the rebuildable rubbish catalog and archive-URL reservation

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `src/vault/reconcile.rs`
- Modify: `src/vault/mod.rs` if shared catalog DTOs require exports
- Test: `src/vault/index.rs` unit tests
- Test: `tests/index_test.rs`
- Test: `tests/archive_test.rs` or the existing captured-web-archive API test file

### Step 1: Write failing catalog tests

Cover:

- schema setup creates `rubbish_items` separately from `pages`, with fields for item ID, page ID, original path, title, kind, deletion time, archive URL, validity, and diagnostic;
- catalog upsert/list/get/remove is deterministic and valid entries sort newest-first;
- invalid manifest directories become error rows and never appear in `pages`, canonical names, FTS, tags, graph, properties, or page lookup;
- startup and explicit index rebuild reconcile the catalog from `RubbishStore`, remove stale catalog rows, and do not modify item files;
- repeated reconciliation is idempotent;
- `find_by_archive_url` checks active pages and the rubbish catalog and identifies which lifecycle location owns the URL.

Introduce an explicit return type instead of overloading the old tuple, for example:

```rust
pub enum ArchiveUrlOwner {
    Active { page_id: String, path: String, source_hash: String },
    Rubbish { item_id: String, page_id: String, original_path: String },
}
```

The exact active payload may retain existing fields. Rubbish lookup must use SQLite, not scan manifests.

### Step 2: Run focused tests and observe RED

Run: `cargo test rubbish_catalog -- --nocapture`

Expected: failures because catalog schema/APIs and lifecycle-aware duplicate lookup do not exist.

### Step 3: Implement catalog schema and reconciliation

Extend `SCHEMA` and `VaultIndex::setup_connection`. Add narrow methods used by later tasks:

- `upsert_rubbish_entry`
- `remove_rubbish_entry`
- `rubbish_entries`
- `rubbish_entry`
- `reconcile_rubbish_catalog`
- lifecycle-aware `find_by_archive_url`

Catalog error rows must preserve an opaque directory/item identifier and diagnostic. Reconciliation reads through `RubbishStore`; it never joins rubbish rows to `pages` and never indexes rubbish page bodies.

Wire startup and explicit rebuild at the existing reconciliation boundaries. Update captured-archive duplicate handling so a binned URL returns the existing rubbish identity rather than creating a page or adding CAS references.

### Step 4: Run focused tests and observe GREEN

Run:
- `cargo test rubbish_catalog -- --nocapture`
- `cargo test archive_url -- --nocapture`

Expected: catalog and duplicate-capture tests pass.

### Step 5: Self-review and commit

Check SQLite migration works both for fresh and existing index databases; no filesystem-wide scan occurs in request-time duplicate lookup.

```bash
git add src/vault/index.rs src/vault/reconcile.rs src/vault/mod.rs tests/index_test.rs tests/archive_test.rs
git commit -m "feat(index): catalog rubbish items outside page index"
```

Adjust the final file list to actual touched test files; do not add nonexistent paths.

---

## Task 3: Make captured-archive cleanup idempotent by rubbish item

**Files:**
- Modify: `src/vault/cas.rs`
- Modify: `src/vault/archive_hook.rs`
- Test: `src/vault/cas.rs` unit tests
- Test: `tests/archive_test.rs` or the existing archive-hook integration tests

### Step 1: Write failing CAS tests

Cover:

- CAS setup creates a cleanup ledger keyed by rubbish item ID;
- releasing a set of unique, valid captured-archive hashes decrements each reference and records completion in one SQLite transaction;
- duplicate hashes in page metadata decrement once;
- invalid or missing hashes fail before any ref count changes;
- retry with the same item ID after completion is a no-op;
- simulate success of CAS cleanup followed by failure to remove the rubbish directory, then retry purge and prove ref counts decrement exactly once;
- archive and restore paths do not call this operation.

Expose a single API shaped around the invariant, for example:

```rust
pub fn release_rubbish_archive_refs(
    &mut self,
    item_id: Uuid,
    hashes: &BTreeSet<String>,
) -> Result<ReleaseOutcome, CasError>;
```

### Step 2: Run focused tests and observe RED

Run: `cargo test rubbish_cleanup -- --nocapture`

Expected: failures because the ledger and atomic release operation do not exist.

### Step 3: Implement transactional release

Add the ledger in `ContentStore::open`. Validate all hashes and verify rows/backing files before opening the mutation transaction. In one SQLite transaction, short-circuit a completed item ID; otherwise decrement every unique reference and insert the completion record. Do not run GC here. Keep `ArchiveDeleteHook` usable for any remaining non-page permanent deletion boundary, but extract/reuse metadata-to-hash parsing so Task 5 purge supplies original path, UUID, and metadata without invoking ordinary delete hooks twice.

### Step 4: Run focused tests and observe GREEN

Run:
- `cargo test rubbish_cleanup -- --nocapture`
- `cargo test archive_hook -- --nocapture`

Expected: all focused CAS/archive cleanup tests pass.

### Step 5: Self-review and commit

Check: no decrement is possible before full prevalidation; ledger insertion and decrements share a transaction; no age-based retention or attachment deletion was added.

```bash
git add src/vault/cas.rs src/vault/archive_hook.rs tests/archive_test.rs
git commit -m "feat(cas): make rubbish purge cleanup idempotent"
```

---

## Task 4: Add atomic archive and restore mutation intents

**Files:**
- Modify: `src/vault/mutation.rs`
- Modify: `src/vault/batch_mutation.rs`
- Modify: `src/vault/mutation_coordinator.rs`
- Modify: `src/vault/reconcile.rs`
- Modify: `src/vault/recovery.rs` if recovery records are defined separately
- Modify: `src/vault/mod.rs`
- Test: `tests/mutation_test.rs`
- Test: `tests/batch_mutation_test.rs`
- Test: existing recovery integration tests

### Step 1: Write failing lifecycle mutation tests

Archive tests:

- moves exact bytes from active path into one fresh rubbish item, preserves page UUID, removes active path, and removes only the target's normal index row;
- leaves backlink source bytes unchanged and clears target resolution through existing index removal behavior;
- works for readonly, protected, captured-archive, and encrypted page bytes without parsing/reserializing content;
- invokes neither move nor delete hooks and leaves CAS counts unchanged;
- rejects source missing with not-found and source byte drift after planning with conflict; creates no item;
- publication or index-reconciliation failure recovers to exactly one authoritative active state, never both active and rubbish;
- emits one `ChangeEvent::Remove`/batched notification only after publication.

Restore tests:

- recreates exact bytes and UUID at the manifest original path, removes the item/catalog row, and re-resolves inbound links;
- refuses an occupied original path with conflict while retaining item bytes, manifest, and catalog row;
- rejects alternate destination/overwrite because those inputs do not exist;
- invokes neither move nor delete hooks, leaves CAS unchanged, and emits one `ChangeEvent::Upsert` after publication;
- publication/index failure recovers to exactly one authoritative rubbish state.

### Step 2: Run focused tests and observe RED

Run: `cargo test --test mutation_test rubbish -- --nocapture`

Expected: failures because explicit lifecycle mutation operations do not exist.

### Step 3: Implement explicit mutation operations

Add explicit operations/intents such as:

```rust
MutationOp::ArchivePage { path, expected_bytes, item }
MutationOp::RestorePage { item_id, original_path, expected_item_bytes }
```

Names may follow existing enum conventions, but do not encode these as `MovePage` or `DeletePage`. Extend lock collection to cover the active path and internal item identity. Extend transaction preparation/publication/rollback/recovery records to stage exact bytes and manifest together. Preflight all requested operations before serializing or mutating any item, matching the existing bulk preflight invariant.

Index reconciliation:

- archive: remove active page, insert catalog row, then run the normal unresolved-link reconciliation;
- restore: upsert active page, remove catalog row, then run normal link re-resolution;
- preserve a single mutation-notification boundary.

### Step 4: Run focused tests and observe GREEN

Run:
- `cargo test --test mutation_test rubbish -- --nocapture`
- `cargo test --test batch_mutation_test rubbish -- --nocapture`
- the existing recovery-focused test target identified while implementing

Expected: every lifecycle, rollback, and crash-recovery test passes.

### Step 5: Self-review and commit

Check: exact expected-byte validation occurs after locks; no hook calls; no backlink rewrites; no parse/serialize round-trip; recovery cannot publish both states.

```bash
git add src/vault/mutation.rs src/vault/batch_mutation.rs src/vault/mutation_coordinator.rs src/vault/reconcile.rs src/vault/recovery.rs src/vault/mod.rs tests/mutation_test.rs tests/batch_mutation_test.rs
git commit -m "feat(vault): add atomic page archive and restore"
```

Only add `recovery.rs` if it exists/is touched.

---

## Task 5: Implement purge and Empty Rubbish Bin domain operations

**Files:**
- Modify: `src/vault/rubbish.rs`
- Modify: `src/vault/mutation.rs`
- Modify: `src/vault/mutation_coordinator.rs`
- Modify: `src/vault/archive_hook.rs`
- Modify: `src/vault/index.rs`
- Test: `tests/mutation_test.rs`
- Test: relevant archive/CAS integration test file

### Step 1: Write failing purge tests

Cover:

- purge accepts only a valid opaque item UUID and permanently removes its item directory/catalog row;
- cleanup receives original path, page UUID, and parsed metadata from stored bytes;
- captured-archive references decrement once; ordinary attachments remain untouched;
- cleanup failure returns an error and retains `page.md`/manifest; retry resumes safely;
- failure after ledger completion but before item deletion retries without another decrement;
- malformed/future-version items are not purgeable as valid items and remain visible as errors;
- Empty Bin snapshots current valid items, attempts each in newest-first deterministic order, continues after failures, and returns one ordered success/failure result per attempted item;
- purge and empty emit truthful notifications/results rather than unconditional success.

### Step 2: Run focused tests and observe RED

Run: `cargo test purge_rubbish -- --nocapture`

Expected: failures because purge orchestration/result types do not exist.

### Step 3: Implement purge orchestration

Add result types for one purge and collection purge. Read and validate through `RubbishStore`, parse page metadata without rewriting bytes, invoke exactly the cleanup needed for captured-archive CAS through Task 3's idempotent API, then durably remove item files/directory and catalog row. Do not invoke generic page `DeletePage`; do not delete ordinary attachments. Empty Bin loops through the initial valid-item snapshot and accumulates results.

### Step 4: Run focused tests and observe GREEN

Run:
- `cargo test purge_rubbish -- --nocapture`
- `cargo test empty_rubbish -- --nocapture`

Expected: purge, retry, CAS, and partial-failure tests pass.

### Step 5: Self-review and commit

Check: page bytes remain available until cleanup succeeds; item IDs—not original paths—address purge; per-item outcomes preserve actual errors.

```bash
git add src/vault/rubbish.rs src/vault/mutation.rs src/vault/mutation_coordinator.rs src/vault/archive_hook.rs src/vault/index.rs tests/mutation_test.rs
git commit -m "feat(vault): purge rubbish items safely"
```

---

## Task 6: Cut REST over to archive and add Rubbish Bin endpoints

**Files:**
- Modify: `src/api/pages.rs`
- Create: `src/api/rubbish.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/openapi.rs`
- Modify: server/router state wiring where the rubbish/CAS stores are constructed
- Test: `tests/api_test.rs`
- Create or extend: `tests/api_rubbish_test.rs`
- Test: `tests/openapi_test.rs` or existing OpenAPI/docs coverage tests

### Step 1: Write failing REST contract tests

Cover:

- `DELETE /api/vault/pages/{path}` archives and returns `201 Created` plus `RubbishItemSummary`;
- `force`/`rewrite` are absent from request DTO/OpenAPI and backlinks neither block nor rewrite;
- source missing = 404, byte drift/conflict = 409;
- list returns newest-first valid summaries plus invalid-item rows;
- detail returns lifecycle metadata and a bounded read-only preview without inserting into normal index;
- protected/encrypted preview follows existing disclosure rules and never silently decrypts;
- malformed item UUID = 400; missing item = 404;
- restore success returns original path/page UUID; occupied path = 409 naming path and retaining item;
- item delete purges; collection delete returns ordered partial outcomes;
- normal page list/get/search cannot retrieve rubbish items;
- old permanent page-delete response and backlink-preview/rewrite contract are absent.

### Step 2: Run focused tests and observe RED

Run: `cargo test --test api_rubbish_test -- --nocapture`

Expected: route/type failures.

### Step 3: Implement DTOs, handlers, routes, and OpenAPI

Create DTOs matching the spec, including a tagged valid/invalid list entry, bounded preview detail, restore response, purge response, and empty-bin per-item outcome. Register:

```text
GET    /api/vault/rubbish
GET    /api/vault/rubbish/{item_id}
POST   /api/vault/rubbish/{item_id}/restore
DELETE /api/vault/rubbish/{item_id}
DELETE /api/vault/rubbish
```

Change the existing page DELETE handler to archive with no query DTO. Map typed domain errors exactly to 400/404/409/500. Register all paths/schemas in `src/api/openapi.rs`. Update router/AppState construction once; do not create a second storage convention.

### Step 4: Run focused tests and observe GREEN

Run:
- `cargo test --test api_rubbish_test -- --nocapture`
- `cargo test --test api_test delete_page -- --nocapture`
- `cargo test --test docs_api_coverage_test -- --nocapture`

Expected: new lifecycle contracts pass; old hard-delete assertions have been replaced, not retained.

### Step 5: Regenerate OpenAPI TypeScript and verify drift

Use the existing repository command from `Justfile`/package scripts to regenerate `ui/src/api/schema.d.ts`. Then run the existing schema drift check. Never hand-edit the generated file.

### Step 6: Self-review and commit

```bash
git add src/api/pages.rs src/api/rubbish.rs src/api/mod.rs src/api/openapi.rs src ui/src/api/schema.d.ts tests/api_test.rs tests/api_rubbish_test.rs
git commit -m "feat(api): expose page rubbish lifecycle"
```

Tighten the broad `src` path to actual state-wiring files before commit.

---

## Task 7: Replace MCP deletion with rubbish lifecycle tools

**Files:**
- Modify: `src/mcp/server.rs`
- Modify: MCP tool coverage tests in `src/mcp/server.rs` and/or `tests/mcp_test.rs`
- Modify: `tests/docs_api_coverage_test.rs` if it inventories tools

### Step 1: Write failing MCP contract tests

Assert exact advertised tool names and annotations:

- `vault_archive_page`: mutating, non-destructive; description states normal links become unresolved and restore is available;
- `vault_list_rubbish` and `vault_get_rubbish_item`: read-only;
- `vault_restore_page`: mutating, non-destructive, original-path-only;
- `vault_purge_page` and `vault_empty_rubbish`: mutating, destructive, non-idempotent;
- `vault_delete_page` and delete preview/force/rewrite schema are absent;
- success and error payloads match REST/domain semantics, including restore conflict retention and Empty Bin partial failure.

### Step 2: Run focused tests and observe RED

Run: `cargo test mcp_rubbish -- --nocapture`

Expected: missing/new-name failures and old tool still advertised.

### Step 3: Implement the clean MCP cutover

Remove the old delete tool definition, request schema, dispatch arm, and related delete-preview support. Add narrow request types using `path` only for archive and `item_id` only for rubbish operations. Reuse the same application/domain methods as REST. Include explicit permanent-effect text for destructive tools.

### Step 4: Run focused tests and observe GREEN

Run:
- `cargo test mcp_rubbish -- --nocapture`
- `cargo test mcp_tool -- --nocapture`

Expected: lifecycle tools and annotations pass; no stale delete tool remains.

### Step 5: Self-review and commit

```bash
git add src/mcp/server.rs tests/mcp_test.rs tests/docs_api_coverage_test.rs
git commit -m "feat(mcp): expose archive restore and purge tools"
```

Add only test files that exist and changed.

---

## Task 8: Change the page action and tab/history cleanup

**Files:**
- Modify: `ui/src/api/pages.ts`
- Modify: `ui/src/components/page-tree/PageActionsMenu.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/store/workspace.ts`
- Modify: `ui/src/hooks/useFolioHistoryNavigation.ts` or the existing Folio-history owner
- Test: `ui/src/components/page-tree/PageActionsMenu.test.tsx`
- Test: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Test: `ui/src/store/workspace.test.ts` and/or Folio-history hook tests

### Step 1: Write failing UI behavior tests

Cover:

- action is labelled **Archive Page** and no **Delete page**/rewrite choice exists;
- direct confirmation explains absence from normal views, byte-identical inbound links becoming unresolved, and restoration from Rubbish Bin;
- pending editor save resolves before archive request; failed save prevents archive;
- readonly/captured-archive/protected/encrypted persisted pages expose Archive Page without changing readonly/protection state;
- successful archive closes every page tab matching UUID or path, not only the active tab;
- associated pending Folio restoration/back-forward state is cleared;
- mobile returns home after success; desktop lands on the existing workspace recovery surface;
- failed archive retains tabs and reports the server error;
- folder action copy says **Delete folder permanently** and explains pages do not enter Rubbish Bin.

### Step 2: Run focused tests and observe RED

Run from `ui/`:

```bash
bun run test -- src/components/page-tree/PageActionsMenu.test.tsx src/components/codex/__tests__/Folio.test.tsx src/store/workspace.test.ts
```

Expected: old hard-delete behavior fails the new assertions.

### Step 3: Implement archive mutation and UI behavior

Replace the API hook with archive semantics and invalidate page/index/link queries using the existing invalidation helper. Delete backlink-preview and force/rewrite state used only by page deletion. Preserve folder deletion code separately with stronger permanent wording.

Add one store action that removes all matching tabs and clears any history/restoration entries atomically; do not loop through public single-tab actions and trigger repeated navigation. Folio/PageActionsMenu must save first, archive second, then invoke that cleanup and responsive navigation.

### Step 4: Run focused tests and observe GREEN

Run the focused command from Step 2, adjusted only to actual changed test files.

Expected: all page archive, cleanup, history, readonly, and folder-warning tests pass.

### Step 5: Self-review and commit

Check no UI path can directly purge an active page and no archive control still calls mutation preview.

```bash
git add ui/src/api/pages.ts ui/src/components/page-tree/PageActionsMenu.tsx ui/src/components/page-tree/PageActionsMenu.test.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.test.tsx ui/src/store/workspace.ts ui/src/store/workspace.test.ts ui/src/hooks/useFolioHistoryNavigation.ts
git commit -m "feat(ui): archive pages and clear folio state"
```

---

## Task 9: Build the dedicated Rubbish Bin route and lifecycle UI

**Files:**
- Create: `ui/src/routes/rubbish.tsx`
- Create: `ui/src/routes/-rubbish.test.tsx`
- Create: `ui/src/api/rubbish.ts`
- Create: `ui/src/components/rubbish/RubbishBin.tsx`
- Create: `ui/src/components/rubbish/RubbishBin.test.tsx`
- Modify: `ui/src/components/codex/useCodexView.ts`
- Modify: `ui/src/components/codex/viewRegistry.ts`
- Modify: `ui/src/components/codex/viewRegistry.test.ts`
- Modify: `ui/src/components/codex/DesktopCodexFrame.tsx`
- Modify: `ui/src/components/codex/MobileCodexFrame.tsx`
- Modify: route-view tests under `ui/src/routes/__tests__/`
- Generated: `ui/src/routeTree.gen.ts`

### Step 1: Write failing route and component tests

Cover:

- `/rubbish` resolves to a registered `rubbish` Codex view and primary navigation entry named **Rubbish Bin** on desktop and mobile;
- newest-first list renders title, original path, kind, and deletion time;
- invalid-item rows render diagnostics and expose no unsafe restore action;
- selection fetches dedicated detail and renders lifecycle metadata plus bounded read-only body preview, never an editable Folio;
- empty/loading/list/detail/error states are explicit;
- Restore success removes the item, invalidates normal page/link queries, and offers/uses the restored normal path;
- 409 restore conflict names the occupied path and retains selection/item;
- Delete permanently confirmation names the page and permanent effect;
- Empty Rubbish Bin confirmation names item count and stronger permanent effect;
- Empty Bin displays per-item failures while removing successes;
- item IDs are passed only to rubbish API calls and never to page-open/navigation APIs.

### Step 2: Run focused tests and observe RED

Run from `ui/`:

```bash
bun run test -- src/components/rubbish/RubbishBin.test.tsx src/routes/-rubbish.test.tsx src/components/codex/viewRegistry.test.ts
```

Expected: missing modules/view/route failures.

### Step 3: Implement typed query/mutation hooks

Use generated OpenAPI types. Add list/detail/restore/purge/empty hooks with precise TanStack Query keys and invalidation:

- rubbish mutations invalidate rubbish list/detail;
- restore additionally invalidates normal page structures, search/link/index queries;
- purge does not invent a normal page path invalidation from item ID.

### Step 4: Implement the route and view

Follow existing full-surface route patterns and visual primitives. Add `rubbish` to `CodexView`, `VIEW_REGISTRY`, desktop rail, and mobile navigation. The layout must remain usable at narrow widths: list-first selection with detail/back affordance or the repository's established mobile master/detail pattern. Render stored Markdown with the existing read-only preview component only if its disclosure behavior matches the API payload; never fetch a normal page by original path for preview.

Generate `routeTree.gen.ts` through the existing TanStack route-generation/build command; do not hand-edit it.

### Step 5: Run focused tests and observe GREEN

Run the focused command from Step 2 plus the route-view coverage test.

Expected: all Rubbish Bin route, lifecycle, error, confirmation, and navigation tests pass.

### Step 6: Self-review and commit

```bash
git add ui/src/api/rubbish.ts ui/src/components/rubbish ui/src/routes/rubbish.tsx ui/src/routes/-rubbish.test.tsx ui/src/components/codex/useCodexView.ts ui/src/components/codex/viewRegistry.ts ui/src/components/codex/viewRegistry.test.ts ui/src/components/codex/DesktopCodexFrame.tsx ui/src/components/codex/MobileCodexFrame.tsx ui/src/routes/__tests__ ui/src/routeTree.gen.ts
git commit -m "feat(ui): add dedicated Rubbish Bin"
```

---

## Task 10: Run end-to-end lifecycle smoke and repository gates

**Files:**
- Modify only if smoke/gates expose a real defect
- Update: `.superpowers/sdd/2026-08-13-archive-rubbish-bin/progress.md` during execution

### Step 1: Run focused end-to-end API smoke

Start `clep serve` against a temporary initialized vault using the repository's built binary and a temporary config. Exercise the approved lifecycle through real HTTP calls:

1. Create A linking to B and capture exact bytes/UUID for both.
2. Archive B through page DELETE; assert 201/item ID.
3. Assert B absent from page list/get/search, A byte-identical, and A's link unresolved.
4. List/detail B through rubbish endpoints and verify metadata/read-only preview.
5. Restore B; assert exact bytes/UUID and link re-resolution.
6. Archive B again and purge by item ID; assert item absence.
7. Exercise Empty Bin with at least two items and observe ordered outcomes.

Record exact commands and HTTP statuses in the SDD ledger. Do not add a permanent smoke-test script unless an observable contract lacks automated coverage.

### Step 2: Browser-drive the real UI

Against the same temporary vault/server and built UI:

- archive B from Folio/PageActionsMenu;
- verify all B tabs close and no backlink-rewrite controls appear;
- open Rubbish Bin through desktop navigation, inspect preview, restore, and verify B opens normally;
- archive again, permanently delete with confirmation;
- verify mobile viewport exposes Rubbish Bin navigation and lifecycle controls;
- verify folder UI says permanent and excludes Rubbish Bin.

Capture screenshots for the Rubbish Bin list/detail and confirmation states as review evidence.

### Step 3: Run changed-contract/focused suites

Run the union of all focused commands named in Tasks 1–9. Fix any regression at its source and rerun the failing command.

### Step 4: Run mandatory repository gates

Rust:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

UI, from `ui/`:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Repository policy requires typecheck, lint, and full tests. Treat any known baseline failure evidence-first: verify whether changed files/lines introduced it; do not suppress diagnostics.

### Step 5: Review the complete branch

Dispatch one final code-review subagent over the approved specification, this plan, the SDD ledger, and the full merge-base diff. It must report only evidence-backed Critical/Important findings and an explicit merge-readiness verdict. Fix every valid finding, rerun affected focused tests, and re-review the scoped correction.

### Step 6: Commit verification fixes, merge, and seal

After all gates and final review pass:

```bash
git status --short
git log --oneline --decorate -n 15
git diff --stat develop...HEAD
git diff --check develop...HEAD
```

Commit any real verification fixes. Merge `feature/tsk-0063-rubbish-bin` into `develop` with `--no-ff`, rerun the required merged-tree gates, remove the worktree/feature branch, update TSK-0063 checkboxes and the linked Stray Thoughts item through vault MCP tools, then move TSK-0063 to `SEALED`.
