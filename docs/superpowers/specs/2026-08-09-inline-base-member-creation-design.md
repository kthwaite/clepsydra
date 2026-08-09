# Inline Base Member Creation Design

**Date:** 2026-08-09
**Status:** Approved for planning

## Problem

A Base is a filtered view over vault pages rather than an owning collection. Existing Base rows can edit declared custom properties, but creating a member requires leaving the table, creating a Folio, assigning metadata, and returning to the Base. That interrupts repeated data entry and can create a page that does not satisfy the Base or active-view filter.

Inline member creation must preserve the file-first model: a successful row creates one canonical Markdown page, while a rejected row creates nothing.

## Scope

This feature adds one-page-at-a-time creation from a saved Base table view. It includes:

- an inline draft row;
- typed metadata/property entry;
- atomic Base-membership and active-view validation;
- server-side canonical path generation;
- capability reporting for filters a blank page cannot satisfy;
- focused API, UI, browser, and documentation coverage.

Adding an existing page to a Base is out of scope. Editing a page body during row creation is out of scope. Embedding Base views in a Folio is a separate follow-on feature and design.

## Decisions

1. **Create a new page.** “Add member” creates a new vault page; it does not enroll an existing page.
2. **Inline draft row.** Entry happens in the table rather than a modal or Folio.
3. **Atomic member or no page.** A rejected submission leaves no file or index row.
4. **Match the active view.** The candidate must satisfy both Base membership and the active saved-view filter.
5. **Expose relevant fields.** The draft contains active-view fields plus additional fields referenced by membership or view filters.
6. **Disable impossible creation.** If a non-creatable derived constraint cannot be satisfied by a blank page, the action is disabled with the exact reason.
7. **Dedicated Base endpoint.** Base-specific validation remains in the Base API rather than coupling it to generic page creation or composing multiple client mutations.
8. **One draft at a time.** This keeps focus, cancellation, and failure recovery deterministic.

## Table Interaction

The Base toolbar gains **Add member**. Activating it inserts one unsaved draft table directly above the current results and focuses Title. The draft remains separate from flat or grouped results until creation succeeds, so it does not imply a group or sort position prematurely.

The draft always includes Title, even when the active view omits it. Remaining fields are composed in this order:

1. creatable fields visible in the active view;
2. additional fields referenced by the Base membership filter;
3. additional fields referenced by the active-view filter.

Duplicate field references collapse to one control. Filter-only fields are marked as required by the relevant filter. Base-declared properties use the existing typed cell-editor registry. Creatable system metadata uses existing controls where available:

- kind;
- project;
- tags;
- aliases.

Derived fields such as id, path, timestamps, and word count are read-only previews or capability inputs, not editable draft cells.

**Save** and `Ctrl/Cmd+Enter` submit the complete row. **Cancel** and `Escape` discard it. Escape first belongs to an open cell editor; row cancellation occurs only when no cell editor consumes the key. Add member is disabled while a draft exists.

On success, the draft disappears, Base and page queries refresh, and the server-created row appears in its actual sorted or grouped location. On any failure, entered values remain intact.

## Creation Capability

Base detail exposes creation capability for each saved view. The capability contains:

- whether blank-page creation can potentially satisfy membership and the view;
- the fields referenced by those filters;
- blocking filter-path diagnostics for non-creatable derived constraints.

The server owns this analysis. React must not reimplement filter semantics.

A constraint is blocking when no editable create-time input or generated blank-page value can satisfy it. For example, a positive word-count requirement cannot be satisfied without body authoring and disables Add member. The response identifies the field, operator, filter path, and reason. The analysis is conservative: it disables creation only when impossibility is provable; otherwise it permits a draft and leaves the create endpoint authoritative. Constraints involving generated values such as path or timestamps use the same candidate semantics as submission.

Capability is advisory against concurrent definition changes; the create endpoint remains authoritative.

## API Contract

Add:

```http
POST /api/vault/bases/{slug}/members
Content-Type: application/json
```

Request:

```json
{
  "base_revision": "revision-token",
  "view": "Unread",
  "title": "The Left Hand of Darkness",
  "fields": {
    "kind": "BOOK",
    "status": "unread",
    "rating": 5
  }
}
```

`fields` accepts Base-declared properties and creatable system metadata. Title is required as a top-level field. The Base property schema determines native TOML conversion; callers do not send independent type hints.

Successful response:

```json
{
  "id": "page-uuid",
  "path": "books/20260809.the-left-hand-of-darkness.Ab3xYz90.md",
  "title": "The Left Hand of Darkness",
  "revision": "page-revision"
}
```

The client uses `path` for normal page navigation and reruns the active Base view query to obtain authoritative grouping, sorting, aggregates, and row projection.

Failure classes:

- `400`: malformed request or unsupported field;
- `404`: Base or saved view not found;
- `409`: stale Base revision or exhausted generated-path collision retries;
- `422`: field conversion, Base-membership, or active-view mismatch;
- `500`: mutation or indexing failure through the existing API error path.

Validation failures use:

```json
{
  "error": "candidate does not match the active view",
  "diagnostics": [
    {
      "scope": "view",
      "field": "status",
      "filter_path": "views.Unread.filter",
      "message": "status must equal unread"
    }
  ]
}
```

`scope` is `field`, `membership`, or `view`; `field` and `filter_path` are present when the diagnostic can identify them.

Validation responses contain row-level diagnostics plus optional field and filter paths. No failure response may leave a page file or index row.

## Server Data Flow

1. Resolve the Base and compare `base_revision` before constructing a mutation.
2. Resolve the named saved view using the Base’s existing case-insensitive view-name rules.
3. Validate submitted field names against creatable system metadata and the Base property schema.
4. Convert JSON values to native `toml::Value` instances according to each declared property type. Populate title, kind, project, tags, and aliases as first-class `PageMeta` fields.
5. Generate a canonical path server-side from title, kind, project, current date, and a fresh short ID using existing intake/path projection rules.
6. Evaluate the complete candidate against Base membership and then the active-view filter using the in-memory filter matcher whose semantics mirror SQL evaluation.
7. Return structured `422` diagnostics if either predicate fails. Do not invoke the mutation coordinator.
8. On success, invoke the mutation coordinator once with the complete `PageMeta`, generated path, and empty body.
9. If the generated path collides, generate a new short ID and retry within a bounded server-side loop before returning `409`.
10. Return the created page identity after the coordinator completes its file write, index update, notification, and existing rollback behavior.

The existing in-memory membership matcher should be factored only as necessary to evaluate an arbitrary saved-view filter against the same candidate. SQL and in-memory filter behavior must remain aligned.

## Client Data Flow

`BaseTable` owns the create mutation and query invalidation. `BaseTableView` owns draft presentation and emits a completed draft value. Draft field composition should live in a pure helper so capability, ordering, deduplication, and labels are testable without rendering.

On submission:

1. prevent duplicate submission;
2. send the loaded Base revision, active view name, title, and field values;
3. map structured diagnostics to cells and the row summary;
4. preserve draft state on every failure;
5. invalidate Base detail/list/view and page-structure queries on success;
6. remove draft state;
7. after the refreshed result renders, focus the created row’s title link.

A stale-revision response tells the user to reload the Base definition and retry. Reloading must not silently discard the draft.

## Accessibility and Keyboard Behavior

- Add member exposes its disabled reason through an accessible description.
- Opening a draft focuses `New member — Title`.
- Every field has the stable label `New member — <field>`.
- Filter-only fields visually identify whether membership, the active view, or both require them.
- Row-level failures use a live region; field failures are associated with their controls.
- A rejected save moves focus to the first invalid field.
- Escape cancels the row only after any active cell editor declines the event.
- `Ctrl/Cmd+Enter` saves from any draft field.
- After success and query refresh, focus moves to the new row’s title link.

## Error Handling

Field conversion errors attach to their draft cell. Membership and active-view mismatches show a concise row summary and the server’s filter-path diagnostics. Stale Base revision is a recoverable conflict, not a generic failure. Unexpected errors use the existing API error formatter.

The UI must never claim that a page was created until the endpoint returns `201`. It must never remove a failed draft automatically.

## Verification

### Rust contract tests

Cover:

- successful creation through simple membership;
- compound `all`, `any`, and `not` membership;
- active-view filter enforcement;
- every declared property type written as the expected native TOML value;
- kind, project, tags, and aliases as first-class metadata;
- unknown fields and invalid values;
- stale Base revision;
- unknown saved view;
- membership mismatch;
- active-view mismatch;
- impossible derived-constraint capability;
- generated-path collision retry;
- mutation/index failure propagation;
- proof that every rejected request leaves neither a page file nor an index row.

### React contract tests

Cover:

- opening, focusing, and cancelling the draft;
- one-draft invariant;
- field composition, ordering, and deduplication;
- filter-only field labels;
- typed property editors and creatable system controls;
- blank-title validation;
- keyboard save and Escape precedence;
- disabled capability with accessible reason;
- field and filter diagnostic mapping;
- preserved draft after `409`, `422`, and network failure;
- success invalidations and refreshed grouped/sorted placement;
- focus transfer to the created row.

### Browser smoke test

Create a page from a Base with both a membership filter and an additional grouped-view filter. Verify that the row lands in the correct group, survives reload, opens in Folio, and corresponds to one canonical Markdown page with correctly typed frontmatter.

### Documentation

Update the existing Bases user documentation with inline member creation, the atomic membership/view guarantee, relevant field behavior, keyboard controls, and the unsupported derived-filter case.

## Follow-on: Base Embeds in Folio

Folio Base embeds remain a separate design because they require persistent Markdown syntax, a new Slate block element, query configuration, live rendering, and explicit read/write semantics. The implementation should preserve `BaseTableView` as the reusable presentation seam so a future embed can render a saved Base view without duplicating the table.
