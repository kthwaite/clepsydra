# Bases Frontend Authoring Design

**Date:** 2026-08-08
**Status:** Approved design

## Problem

Clepsydra Bases already provide typed, non-owning views over vault pages. The frontend can render saved table views and edit declared page properties, but creating or changing a base requires direct vault intervention: users must create `bases/<slug>.base.toml`, author recursive filters, declare typed properties, and configure views by hand.

This exposes an implementation format before users can reach the feature. It also makes otherwise recoverable mistakes—invalid TOML, an incompatible operator, a duplicate view name, or an undeclared field—hard to discover until evaluation.

The goal is complete base-definition authoring in the frontend while preserving the local-file model, external editor interoperability, and the invariant that bases never own or delete pages.

## Existing system

The current domain model is already suitable for a structured editor:

- `BaseFile` contains name, description, optional membership filter, ordered property declarations, and saved views.
- `Filter` is a recursive `all` / `any` / `not` / comparison AST.
- The closed property type set is text, number, boolean, date, date-time, select, multi-select, URL, and relation.
- Views contain a name, layout, optional filter, ordered sorts, optional grouping, aggregates, and ordered columns.
- `GET /api/vault/bases`, `GET /api/vault/bases/{slug}`, and saved-view evaluation already expose the read path.
- The table UI already uses React Aria and type-specific cell editors.
- `base_registry_changed` already invalidates frontend base and query caches.
- Page property writes already establish the desired mutation conventions: optimistic revisions, conflict responses, surgical TOML updates, and comment preservation.

The missing pieces are domain-specific base-definition mutations, unsaved preview, discovery/navigation, creation affordances, and a structured definition workspace.

## Research findings

### Obsidian Bases

[Obsidian Bases](https://obsidian.md/help/bases) is the closest storage-model analogue: database-like views are layered over local Markdown notes and note properties rather than moving records into an owned database. Its [view controls](https://obsidian.md/help/bases/views) distinguish global membership from view-specific filtering and expose visible properties, filters, sorts, grouping, and layouts through UI while retaining a file representation.

Applicable lessons:

- Keep local files canonical and editable outside the app.
- Separate collection membership from per-view presentation.
- Let users switch and configure saved views without treating views as separate data stores.
- Preserve a syntax-level escape hatch, but do not require it for ordinary use.

### Notion databases

[Notion databases](https://www.notion.com/help/intro-to-databases) provide the strongest reference for discoverable property and view configuration. Its [property controls](https://www.notion.com/help/database-properties) and [view controls](https://www.notion.com/help/views-filters-and-sorts) place schema, visible properties, filters, sorts, and grouping close to the table.

Applicable lessons:

- Use typed controls and valid-option filtering instead of asking users to know schema tokens.
- Make the distinction between database-wide properties and view-specific display settings visible.
- Provide direct, reversible add/duplicate/reorder/delete operations.

Clepsydra should not copy Notion's owned-record semantics. A property declaration is advisory and removing it must not remove page frontmatter.

### Airtable

[Airtable field configuration](https://support.airtable.com/docs/field-type-overview) is a useful reference for explaining type-specific settings and showing a schema as an ordered list of fields. Airtable's base/table/record ownership does not map to Clepsydra; only its field-editor clarity is relevant.

### Resulting direction

Use a dedicated definition workspace rather than placing all structural authoring in table column menus. Keep the table as the usage surface and make **Configure** an explicit mode transition. This provides enough room for recursive filters, diagnostics, view configuration, and live preview without turning every column header into a dense settings entry point.

## Decisions

The approved direction is:

- Full definition editing in the first frontend authoring release.
- A dedicated definition workspace.
- Explicit Save rather than per-control autosave.
- Guided minimal creation rather than templates or a blank file.
- A revisioned full-definition backend contract.
- TOML files remain canonical.
- Manual TOML remains an advanced escape hatch.

## Domain and persistence design

### Canonical storage

`bases/*.base.toml` remains the only persisted representation. Do not introduce a database mirror, frontend-only draft format, or generic vault-file mutation endpoint.

New files use stable canonical formatting. Existing updates operate on the current document with a comment-preserving TOML editor. Unsupported keys and comments must survive; unchanged managed nodes remain byte-for-byte unchanged, while changed managed nodes may be reformatted. If the backend cannot preserve an unsupported structure safely, it rejects the update instead of silently canonicalizing or dropping content. The backend—not the frontend—owns TOML parsing, validation, serialization, and publication.

### Revisions and atomic publication

Base detail responses include a revision derived from the exact file bytes. Every update or deletion supplies the revision last read by the client.

The server must:

1. Resolve and validate the slug without accepting traversal or arbitrary paths.
2. Read the current file and compare its revision.
3. Validate the complete submitted definition.
4. Prepare the new TOML without publishing an invalid intermediate state.
5. Atomically replace the file.
6. Emit `base_registry_changed`.
7. Return the refreshed definition and revision.

A stale revision returns `409 Conflict` with the current revision. The user's draft remains in the workspace; the UI offers reload/discard and retry after review, never a silent overwrite.

### API surface

#### List

`GET /api/vault/bases`

Each summary includes `match_count: number | null`. The server computes counts independently so one base's evaluation failure yields `null` plus its diagnostic without preventing the other bases from being listed.

#### Detail

`GET /api/vault/bases/{slug}`

Return the parsed definition, diagnostics, and exact-content revision.

#### Create

`POST /api/vault/bases`

Request:

```json
{
  "slug": "reading",
  "definition": {
    "name": "Reading Log",
    "description": null,
    "properties": {},
    "views": [{ "name": "All", "layout": "table" }]
  }
}
```

Creation fails rather than overwriting an existing slug.

#### Update

`PUT /api/vault/bases/{slug}`

Request:

```json
{
  "expected_revision": "…",
  "definition": { "…": "complete BaseFile payload" }
}
```

The submitted model is complete, enabling one explicit atomic Save across multiple edited sections.

#### Delete

`DELETE /api/vault/bases/{slug}` accepts `{ \"expected_revision\": \"…\" }`.

Deletion removes only the revision-matched base-definition file. It never deletes pages or removes their frontmatter properties.

#### Preview

`POST /api/vault/bases/preview`

Accept an unsaved complete definition, selected view name, and bounded pagination. Validate and evaluate it with the same backend semantics used for saved views. Do not duplicate filter compilation in the frontend.

Preview never writes to the vault. Its response separates structural errors, advisory diagnostics, and evaluation errors. Authoring diagnostics contain `severity`, `path`, and `message`, where `path` identifies a definition location such as `properties.status.options` or `views[1].sort[0]`.

### Slug policy

Creation generates a slug from the display name and lets the user edit it before creation. The slug is validated and checked for uniqueness. It is immutable in the first release; users may edit the display name and description.

Base identity renaming is excluded because it affects filenames, URLs, open tabs, and external references. It should be designed as a separate operation if needed.

## Frontend information architecture

### Bases index

Add `/bases` as a first-class route reachable from main navigation and the command palette.

Each base entry shows:

- Name and description.
- Slug.
- Saved view names or count.
- Matching page count when available.
- Diagnostic count and status.
- Actions to open, configure, or delete.

The empty state explains that a base is a saved non-owning view over existing pages and offers **Create base**.

Unparseable files still appear as recoverable diagnostic entries. They offer diagnostic detail and **Open base file**; they do not enter the structured editor until the backend can parse them safely.

### Guided creation

The creation flow asks for:

1. Name and generated editable slug.
2. Optional description.
3. Initial membership rule, defaulting explicitly to **All pages**.

It creates one valid table view named **All**. Successful creation opens the definition workspace, where properties and additional view settings can be added.

This is guidance, not a template system. Do not add domain-specific presets in this release.

### Usage and configuration surfaces

`/bases/$slug` remains the usage surface: saved-view tabs, rows, sorting, grouping, aggregates, and inline page-property edits.

Add a clear **Configure** action that enters the definition workspace. Structural editing should not be distributed across table column menus because membership, schema, recursive view filters, and diagnostics need a coherent surface.

The definition workspace contains:

- Persistent header: base name, validation state, dirty state, **Discard**, and **Save**.
- Left rail: **General**, **Membership**, **Properties**, and **Views**.
- Main pane: editor for the selected section.
- Preview region: unsaved membership or selected-view results.

Leaving with unsaved changes prompts the user to discard or stay. A successful Save refreshes base detail, list, and view queries.

## Authoring interactions

### General

Edit display name and description. Show the immutable slug and underlying `bases/<slug>.base.toml` location as secondary information. Provide **Open base file** as the advanced escape hatch.

### Membership

Render the recursive filter AST as a typed rule builder:

- Comparison rows are `field → operator → value`.
- Group controls create **all**, **any**, and **not** nodes.
- **All pages** is an explicit empty state, not a mysterious absent filter.
- Available operators depend on the selected field's type and cardinality.
- Value controls use the expected type: boolean toggle, numeric input, date/date-time input, option selector, relation page picker, or array input.

Nested groups are visually indented and semantically labelled, for example “Match all of 3 conditions.” The editor must remain fully operable without drag-and-drop.

### Properties

Present declarations as an ordered list with **Add property**.

Type-specific settings:

- Text, number, boolean, date, date-time, and URL require no additional schema settings.
- Select and multi-select expose ordered option chips; an empty list is described as open vocabulary.
- Relation exposes single or multiple cardinality and explains that it is advisory.

System fields appear in a separate read-only reference. They remain available to filters, columns, sorts, grouping, and compatible aggregates without declarations.

Removing a declaration warns that existing page values remain untouched. Renaming a property key is presented as remove-plus-add and explicitly states that existing page frontmatter is not migrated. Do not hide vault-wide data migration inside schema editing.

### Views

Users can add, duplicate, reorder, and delete views.

Each view editor exposes:

- Name.
- Layout, showing table as the only currently supported value.
- Optional nested filter, ANDed with membership.
- Ordered visible columns.
- Ordered sorts and directions.
- Optional group field.
- Ordered aggregates.

Controls offer only fields and functions valid for the selected type where the model is definitive. Existing unsupported combinations must remain visible with diagnostics rather than being silently dropped.

The guided UI keeps at least one view. The backend remains compatible with manually authored viewless files.

### Preview

Preview evaluates the unsaved draft through the backend. Requests are debounced and cancelled or superseded when a newer draft exists. Results are bounded.

Membership preview shows matching pages. View preview uses the selected view and renders the same flat or grouped output contract as the saved table.

Distinct states are required for:

- No matching pages.
- Loading or superseded preview.
- Structural validation failure.
- Advisory diagnostics.
- Query evaluation failure.
- Network failure.

Preview refreshes must not steal focus from the editor.

## Validation and conflict UX

Structural errors block Save. Advisory diagnostics do not.

Errors appear:

- Inline at the responsible control.
- In a summary linked to the relevant section and control.
- In the index for saved files with diagnostics.

A revision conflict preserves the draft and shows that the file changed externally. The primary recovery path is to inspect or reload the current definition, then reapply intentional edits. Do not implement automatic semantic merging in this release.

Deleting a base requires confirmation that clearly states: the base file will be removed; matching pages and their properties will remain.

## Accessibility

Use the existing React Aria conventions.

Requirements:

- Every rule group, comparison, property, view, option, sort, and aggregate has a stable textual accessible name.
- Reordering supports explicit move-up/move-down controls and keyboard operation; drag-and-drop is optional enhancement only.
- Validation summary links move focus to the failing control.
- Dirty, saving, saved, warning, error, and conflict states use text or live regions, not color alone.
- Nested rule hierarchy is conveyed semantically as well as visually.
- Preview updates do not move focus or reset editor controls.
- Dialogs trap focus, restore it on close, and name destructive actions precisely.

## Failure handling

- Invalid slug or duplicate slug: keep creation inputs and identify the field-level error.
- Invalid definition: do not write; return structured diagnostics associated with sections or paths.
- Stale revision: return `409`; preserve draft and offer reload/review.
- Atomic publication failure: report failure and leave the previous file intact.
- Unparseable existing TOML: show diagnostics and **Open base file**; do not fabricate a partial structured model.
- Preview failure: keep the draft editable and leave Save eligibility governed by validation, not transient network state.
- Delete failure: keep the index entry and report the backend error.

## Verification strategy

### Backend contracts

Tests must cover:

- Slug validation and traversal rejection.
- Create-no-overwrite.
- Stable serialization of new files.
- Revisioned update and stale conflict detail.
- Atomic publication and preservation of the previous file on failure.
- Semantic round-trip of every property type, nested filters, sorts, groups, columns, and aggregates.
- Preservation of untouched comments and unsupported keys.
- Preview parity with evaluating the same saved definition.
- Deletion removing only the base file.
- Registry-change notification after successful mutations only.

### Frontend contracts

Tests must cover:

- Guided creation produces a valid definition with an **All** view.
- Dirty state, discard, save, and navigation guard.
- Every property type produces the expected payload and type-specific controls.
- Nested filters round-trip without flattening or changing boolean meaning.
- View duplication, ordering, columns, sorts, grouping, and aggregates persist.
- Structural errors block Save; advisory diagnostics do not.
- Preview supersession does not render stale results.
- Revision conflicts preserve the draft.
- Delete confirmation explains non-destructive page semantics.
- Keyboard and accessible-name contracts for rule and reorder controls.

### Browser smoke path

Exercise the permanent feature end to end:

1. Open the Bases index and create a base.
2. Add typed properties.
3. Build nested membership.
4. Configure a grouped view with sort and aggregate.
5. Confirm unsaved preview.
6. Save and reload.
7. Edit a matching page property from the saved table.
8. Delete the base.
9. Confirm the page and its frontmatter property remain.

### Repository gates

Before completion, run Rust formatting, lint, and full tests; frontend typecheck, lint, full tests, and production build.

## Delivery sequence

1. Revisioned mutation and preview APIs, with OpenAPI types.
2. Bases index and guided creation.
3. Definition workspace shell, dirty-state handling, validation summary, and conflict recovery.
4. Membership editor.
5. Property editor.
6. View editor and unsaved preview integration.
7. Navigation, command-palette entry, documentation, and browser polish.

Each step must preserve the canonical-file and non-owning-page invariants. No step should introduce a placeholder write path or a second persistence model.

## Exclusions

- Property-value migration during schema rename or removal.
- Base slug/file identity rename.
- Additional view layouts.
- Template gallery.
- Collaborative multi-user merging.
- Backend-persisted drafts.
- Raw TOML editing inside the web application.
- Generic vault-file write APIs.
