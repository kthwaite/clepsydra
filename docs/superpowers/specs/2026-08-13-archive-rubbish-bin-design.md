# Archive and Rubbish Bin Design

## Goal

Replace direct page deletion with a reversible page lifecycle: archive an active page into an internal Rubbish Bin, restore it to its original path, or permanently purge it from the Rubbish Bin.

## Scope

TSK-0063 covers individual Markdown pages across the Rust mutation/domain layer, REST/OpenAPI, MCP, and the React UI. It does not change recursive folder deletion, attachment ownership, automated retention, alternate-path restore, or external-filesystem deletion semantics.

The UI action is named **Archive Page** because that is the user-facing intent. Backend types use `Rubbish`/`Bin` terminology to avoid collision with the existing `Kind::Archive`, `archive/` filing domain, captured-web-archive APIs, and `ArchiveDeleteHook`.

## Existing behavior being replaced

`DELETE /api/vault/pages/{path}` currently plans `MutationOp::DeletePage`, removes the Markdown file, optionally rewrites inbound links, removes the page from the index, emits a removal notification, and then runs `PostDeleteHook`s. The UI always forces deletion after a backlink preview. MCP exposes the same operation as `vault_delete_page`.

This hard-delete path cannot provide restoration: it discards the page bytes, can permanently rewrite backlinks, and decrements CAS references for captured archive pages.

## Lifecycle and invariants

A page has exactly one lifecycle state:

```text
active ──archive──▶ rubbish ──restore──▶ active
                         └────purge────▶ absent
```

### Archive

Archiving MUST:

- preserve the page bytes byte-for-byte, including UUID, frontmatter, encryption envelope, and body;
- atomically remove the original path and create one internal rubbish item;
- remove the page from the normal index;
- leave every inbound link byte-identical so it becomes unresolved while the target is in rubbish;
- retain captured-archive CAS references;
- avoid `PostMoveHook` and `PostDeleteHook` execution;
- work for readonly, captured-archive, protected, and encrypted pages without unlocking, decrypting, or rewriting them;
- emit one vault mutation notification after filesystem publication and index reconciliation;
- fail without partial state when source bytes or destination state change during preparation.

### Restore

Restoring MUST:

- restore the exact stored bytes to the manifest's original vault path;
- preserve the original UUID;
- refuse with HTTP 409 when the original path exists;
- leave the rubbish item intact on every failure;
- remove the rubbish item only in the same durable transaction that recreates the active page;
- upsert the restored page into the normal index so unchanged inbound links naturally re-resolve;
- avoid `PostMoveHook`, `PostDeleteHook`, and CAS reference changes;
- emit one vault mutation notification after filesystem publication and index reconciliation.

Alternate destination, overwrite, replacement, and merge restore modes are prohibited.

### Purge

Purging MUST:

- address a rubbish item by opaque item ID, never by a normal page path;
- permanently remove its stored page bytes and manifest;
- run page cleanup exactly once using the original path, UUID, and parsed metadata;
- decrement captured-archive CAS references only at this stage through an idempotent cleanup operation keyed by rubbish item ID;
- leave ordinary attachments untouched because the current model does not establish exclusive page ownership;
- require explicit destructive confirmation in UI and destructive MCP annotations;
- surface cleanup failures truthfully instead of reporting unconditional success.

Manual item purge and **Empty Rubbish Bin** are supported. No age-, capacity-, or schedule-based retention exists in this task.

## Internal storage

Rubbish lives below the already excluded and watcher-ignored `.clepsydra/` tree:

```text
.clepsydra/rubbish/
  <item-id>/
    page.md
    manifest.json
```

`<item-id>` is a new UUID generated for the lifecycle item. It is not the page UUID and is safe to expose in REST/UI/MCP identifiers.

`manifest.json` has a versioned schema:

```json
{
  "version": 1,
  "item_id": "<uuid>",
  "page_id": "<uuid>",
  "original_path": "notes/example.md",
  "title": "Example",
  "kind": "NOTE",
  "deleted_at": "2026-08-13T00:00:00Z",
  "archive_url": null
}
```

- `page_id`, title, kind, and optional captured-archive URL are snapshots extracted before archival.
- `original_path` is a validated vault-relative Markdown path.
- `deleted_at` is UTC RFC 3339.
- The manifest is lifecycle metadata; `page.md` remains untouched.
- Unknown manifest versions fail closed with a typed error and remain recoverable on disk.
- A malformed item is reported by dedicated rubbish APIs as an item error and never admitted to normal page indexing.

The rubbish store owns enumeration, manifest validation, exact-byte reads, and item path construction. Callers never concatenate internal filesystem paths.

### Rubbish catalog

The normal SQLite index adds a separate `rubbish_items` catalog; rubbish items never enter the `pages` table. The catalog caches validated manifest metadata for newest-first listing, item lookup, and captured-archive URL reservation without rescanning every manifest on each request.

- Manifests and page bytes are authoritative; the catalog is rebuildable.
- Startup and explicit index rebuild reconcile the catalog from `.clepsydra/rubbish/`.
- Archive inserts the catalog row after durable publication; restore and purge remove it after durable publication.
- Invalid item directories are recorded as catalog error rows with item ID and diagnostic so dedicated list APIs can expose them without admitting them to page resolution.
- Catalog reconciliation is idempotent and never modifies item bytes.

The CAS database adds an idempotency ledger keyed by rubbish item ID. Releasing captured-archive references validates every referenced hash, decrements all unique references, and records completion in one SQLite transaction. Retrying a completed release is a no-op. This closes the crash window between CAS decrement and item-directory deletion; item publication may safely retry until both cleanup and filesystem deletion complete.

## Atomic mutation model

Add explicit batch intents for moving exact bytes between an active `VaultPath` and a validated internal rubbish item. Do not model archive/restore through `MovePage`: normal moves rewrite relative links and invoke domain move hooks. Do not model archive through `DeletePage`: hard deletion rewrites backlinks and invokes cleanup.

Archive and restore reuse:

- path/subtree locking;
- exact expected-byte validation after locks are acquired;
- staged publication and rollback manifests;
- directory fsync;
- crash recovery;
- post-publication index reconciliation;
- one batched notification.

The internal item directory and active page path form one transaction boundary. A crash may leave transaction recovery material, but MUST NOT leave both an authoritative active page and authoritative rubbish item after recovery.

## Index, links, search, and duplicate capture

Rubbish items are excluded from:

- normal page list/get APIs;
- FTS and Gazetteer;
- page tree and folders;
- graph, tags, properties, backlinks, canonical names, and normal UUID lookup;
- ordinary MCP page search/read/list operations;
- LSP page discovery and canonical resolution.

Archiving emits `ChangeEvent::Remove(original_path)`. Existing index behavior removes the page row while retaining inbound link rows with cleared targets. Restoring emits `ChangeEvent::Upsert(original_path)`, allowing existing link reconciliation to resolve those rows again.

Captured archive URLs remain reserved while an item is in rubbish. Duplicate-capture lookup checks the normal page index and the rubbish catalog. It reports the existing rubbish item rather than creating duplicate CAS references. Purge removes that reservation.

Rubbish detail exposes a read-only preview of the stored page. This is a dedicated lifecycle read, not a normal `PageDetail` response and not an index insertion.

## REST and OpenAPI

### Clean cutover

`DELETE /api/vault/pages/{path}` becomes reversible archive-to-rubbish behavior:

- response: `201 Created` with `RubbishItemSummary`;
- `force` and `rewrite` query parameters are removed;
- backlinks never block archival and are never rewritten.

The old permanent page-delete contract is removed. Permanent deletion is reachable only through the rubbish API.

### New routes

```text
GET    /api/vault/rubbish
GET    /api/vault/rubbish/{item_id}
POST   /api/vault/rubbish/{item_id}/restore
DELETE /api/vault/rubbish/{item_id}
DELETE /api/vault/rubbish
```

- List returns newest-first valid item summaries plus per-item validation errors.
- Detail returns summary metadata and a bounded read-only content preview; protected/encrypted content follows the same disclosure rules as existing page reads and never decrypts without the established authorization path.
- Restore returns the restored normal page path and UUID; occupied path returns 409.
- Item DELETE purges one item.
- Collection DELETE attempts every currently listed valid item and returns per-item success/failure records. It does not claim atomic all-or-nothing behavior.
- Missing item IDs return 404; malformed UUIDs return 400.

DTOs and routes are registered in `src/api/openapi.rs`; `ui/src/api/schema.d.ts` is regenerated through the existing OpenAPI workflow and never hand-edited.

## MCP

Remove `vault_delete_page` and its rewrite/force contract. Add:

- `vault_archive_page(path)` — reversible, non-read-only, non-destructive annotation;
- `vault_list_rubbish()` — read-only;
- `vault_get_rubbish_item(item_id)` — read-only;
- `vault_restore_page(item_id)` — non-read-only, non-destructive;
- `vault_purge_page(item_id)` — destructive and non-idempotent;
- `vault_empty_rubbish()` — destructive and non-idempotent.

Descriptions state that normal links remain unresolved while a page is in rubbish, restore is original-path-only, and purge is permanent. Preview-mutation delete support is removed because archival does not rewrite collateral files; the Archive Page dialog itself supplies the exact lifecycle consequences.

## UI

### Archive Page action

`PageActionsMenu` replaces **Delete page** with **Archive Page**.

- Save pending editor changes first.
- Show a direct confirmation explaining: the page leaves normal views, inbound links remain unchanged and unresolved, and restoration is available from Rubbish Bin.
- Do not show backlink rewrite options or the hard-delete mutation preview.
- On success, close every open tab whose page UUID/path identifies the archived page, clear its pending Folio restoration state, and navigate mobile users home.
- Browser Back/Forward to the absent page uses the existing missing-page recovery surface. Restoring the page makes that original route valid again.

Archive controls are available for persisted readonly/captured-archive pages without toggling `readonly=false`. Drafts must be saved before archival. Protection and encryption do not prevent byte-preserving archival.

### Rubbish Bin surface

Add a dedicated `/rubbish` route and primary navigation entry named **Rubbish Bin**.

The surface contains:

- newest-first item list with title, original path, kind, and deletion time;
- explicit invalid-item rows when manifest validation fails;
- selected-item detail with read-only body preview and lifecycle metadata;
- **Restore** action;
- **Delete permanently** action with explicit confirmation naming the page;
- **Empty Rubbish Bin** with a stronger confirmation naming the item count and permanent effect;
- restore-conflict error naming the occupied original path while retaining the selected item;
- per-item purge failures after Empty Bin.

The UI never treats an item ID as a vault path and never opens rubbish content in an editable Folio.

## Folder deletion boundary

Recursive folder deletion remains the existing permanent operation in TSK-0063. Its UI copy MUST say **Delete folder permanently** and its confirmation MUST state that pages in the folder do not enter Rubbish Bin.

A reversible folder lifecycle requires grouped-item identity, multi-page collision handling, partial restore policy, and folder-level backlink behavior. That is separate work and is not inferred here.

## Error handling and recovery

- Source missing during archive: 404, no item created.
- Source changed after planning: 409, no item created.
- Rubbish item missing: 404.
- Invalid item ID/path: 400.
- Restore destination occupied: 409 with original path; item retained.
- Invalid/unsupported manifest: typed item error; item retained and visible as invalid in the dedicated list.
- Publication/index failure: transaction rollback/recovery restores the pre-operation authoritative state.
- Purge cleanup failure: return failure and retain page bytes/manifest. A retry uses the item-ID idempotency ledger, so completed CAS release is never applied twice; item deletion resumes safely.
- Empty Bin continues across independent item failures and returns an ordered result for every attempted item.

## Testing and verification

### Domain and mutation

- archive preserves exact bytes and UUID;
- archive removes only the active path and normal index row;
- archive leaves backlink source bytes unchanged;
- archive/restore rollback under publication failure;
- restore recreates exact bytes and rejects occupied paths without consuming the item;
- restore re-resolves inbound links;
- readonly, protected, and encrypted pages archive without body mutation;
- CAS reference counts remain stable through archive/restore and decrement exactly once on purge, including retry after a simulated crash between CAS cleanup and item deletion;
- duplicate captured-archive URL lookup uses the rubbish catalog without a filesystem-wide manifest scan;
- malformed and future-version manifests fail closed.

### API/OpenAPI/MCP

- every route/tool success and error contract;
- old force/rewrite/delete contract is absent;
- list ordering and invalid-item reporting;
- bounded preview disclosure for ordinary, protected, and encrypted content;
- item purge and Empty Bin partial-failure results;
- MCP annotations and descriptions match reversibility/destructiveness.

### UI

- Archive Page labels, explanation, pending-save ordering, and request;
- absence of backlink rewrite controls;
- readonly/captured-archive archival without unlock;
- all-tab and history-state cleanup;
- Rubbish Bin list/detail, metadata, read-only preview, empty state, errors, and loading states;
- restore success and 409 conflict retention;
- item purge and Empty Bin confirmations and partial failures;
- mobile navigation;
- permanent folder-deletion warning.

### End-to-end smoke

1. Create page A linking to page B.
2. Archive B.
3. Verify B is absent from normal page/search surfaces, A is byte-identical, and its link is unresolved.
4. Inspect B in Rubbish Bin and verify its preview and metadata.
5. Restore B and verify exact bytes/UUID plus link re-resolution.
6. Archive B again, purge it, and verify CAS cleanup semantics for captured-archive metadata.

## Acceptance criteria

- Sidebar action is **Archive Page**, not direct permanent deletion.
- Archived pages are reversible, byte-preserving, absent from normal surfaces, and visible only in Rubbish Bin.
- Restore is original-path-only and conflict-safe.
- Permanent page deletion is available only from Rubbish Bin.
- Dedicated Rubbish Bin UI, REST, OpenAPI, and MCP surfaces exist.
- CAS cleanup occurs only on permanent purge.
- Existing page hard-delete force/rewrite behavior is removed in a clean cutover.
- Folder deletion remains explicitly permanent and outside the page rubbish lifecycle.
