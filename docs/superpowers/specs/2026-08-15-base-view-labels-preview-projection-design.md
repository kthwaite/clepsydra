# Base View Labels and Preview Projection Design

## Goal

Deliver the first independently mergeable slice of [[TSK-0065]]: presentation metadata for Base fields and a deterministic Base-property summary in generic page and tab previews.

A Base author can:

- give any field a per-view display label without changing the stored field key;
- configure one Base-level ordered projection for generic page previews;
- include the unique read-only `body` field in either configuration;
- understand missing values and conflicts when a page matches multiple Bases.

The feature preserves the existing Base query language, explicit-save workspace, revision checks, comment-preserving TOML updates, page-property storage, and non-owning Base model.

## Scope

This slice includes:

1. optional per-view display labels;
2. a Base-level ordered preview projection with optional preview-specific labels;
3. validation and comment-preserving persistence for both additions;
4. authoritative multi-Base preview projection in the existing page-properties API;
5. compact projected-property rendering in path-backed link previews and inactive-tab previews;
6. authoring controls, tests, and Bases documentation.

This slice does not include:

- compound-filter authoring or tag-specific all-of, any-of, and none-of controls;
- general Base button-hierarchy cleanup;
- replacing existing field references with rich objects;
- page-member creation;
- embedded Base capacity or presentation;
- block-scoped records;
- drag-and-drop infrastructure;
- a new filter, property, or condition language.

Those remain separate slices of TSK-0065 or separate existing epics.

## Existing Contracts to Preserve

- `bases/*.base.toml` is canonical. There is no database mirror or persisted client draft.
- Base definition writes use exact revisions and preserve unknown TOML keys, comments, and untouched managed nodes.
- A Base is non-owning. Definition changes never migrate, rewrite, or delete matching pages.
- Stored property and system-field keys are authoritative references.
- `body` is a unique read-only projection field. It cannot become a declared or writable property.
- Boolean membership and tag semantics remain the existing recursive `Filter` AST.
- The definition workspace uses explicit Save and Discard.
- Ordering remains keyboard-accessible through Move up and Move down controls; drag-and-drop is not required.
- Pages may match multiple Bases. No Base silently becomes authoritative over another.

## Persisted Model

### Base-level preview projection

`BaseFile` gains an ordered `preview` list:

```rust
pub struct PreviewFieldDefinition {
    pub field: String,
    pub label: Option<String>,
}

pub struct BaseFile {
    // existing fields
    pub preview: Vec<PreviewFieldDefinition>,
}
```

TOML:

```toml
name = "Reading"

preview = [
  { field = "status", label = "State" },
  { field = "rating" },
  { field = "body", label = "Summary" },
]
```

Rules:

- list order is display priority;
- `field` is always the stable Base field reference used by columns, filters, and sorts;
- `label` affects this generic preview projection only;
- duplicate references to the same canonical field identity within one Base preview list are invalid;
- an empty preview list is omitted when serialized;
- an absent preview list preserves current behavior: no Base-property summary is rendered.

### Per-view labels

`ViewDefinition` gains a label map:

```rust
pub struct ViewDefinition {
    // existing fields
    pub labels: BTreeMap<String, String>,
}
```

TOML:

```toml
[[views]]
name = "All"
layout = "table"
columns = ["title", "status", "body"]
labels = { status = "State", body = "Summary" }
```

Rules:

- map keys are stable Base field references;
- values are view-local human-facing labels;
- labels may target fields that are not current table columns;
- labels may target `body`;
- changing or removing a label never changes columns, filters, sorts, aggregates, property declarations, or page frontmatter;
- an empty label map is omitted when serialized;
- existing files deserialize with an empty map and serialize unchanged unless edited.

A label map is intentionally separate from `columns`. Preview selection is intentionally separate from both. This avoids coupling table layout, generic preview content, and field identity.

## Field Vocabulary

Both label and preview controls use the same field vocabulary already accepted by Base views:

- system fields;
- declared custom properties;
- the unique read-only `body` field.

The implementation must reuse the Base domain’s field-capability helpers and query field projection. It must not create a second field registry.

Field references retain the existing resolution grammar: bare references resolve system-first, while `sys.<key>` and `prop.<key>` disambiguate collisions. Validation and projection normalize each reference to a canonical identity of either system field, custom-property key, or `body`. Presentation labels never replace that identity. De-duplication treats equivalent bare and qualified references as one field, but never conflates a system field with a shadowed custom property.

`body` remains excluded from property declaration and page-property PATCH paths. Its preview value uses the existing `vault::query::body_excerpt` Markdown-to-plain-text pipeline and its existing scalar bound.

## Validation

Validation produces machine-addressable diagnostics using the existing severity/path model.

Errors:

- blank or whitespace-only display label;
- blank preview field reference;
- duplicate field in one Base preview list.

Warnings:

- label or preview reference to a field unavailable from system fields, declared properties, or `body`;
- the existing system-field/property-shadowing conditions.

Valid cases:

- `body` in a view label map;
- `body` in the Base preview list;
- a view label for a field not currently present in `columns`;
- a Base with no preview projection;
- a view with no label overrides.

Validation must not change query evaluation. Invalid presentation metadata blocks the same explicit Save path as other definition errors; warnings remain saveable under the current policy.

## Comment-Preserving Mutation

`base_document` owns create/update serialization and comment-preserving merge for the new nodes.

Requirements:

- new definitions use stable formatting;
- adding or changing `preview` preserves unrelated root comments and unknown keys;
- adding or changing `views.labels` preserves comments and unknown keys in the same view;
- unchanged preview entries and label entries remain byte-identical where the current managed-node merge contract guarantees this;
- removing the final preview entry or final label override removes the empty managed node without disturbing neighbouring content;
- stale revisions return `409` and leave the file byte-identical.

No vault migration runs. No existing Base file is rewritten merely because the server understands the new fields.

## Authoritative Page Projection

### Existing endpoint

Extend:

```text
GET /api/vault/pages/by-id/{uuid}/properties
```

The endpoint already loads the page, evaluates matching Bases, groups declarations by key, distinguishes missing values from present JSON `null`, and reports schema compatibility. It remains the single authoritative boundary for both property editing and preview projection.

The response gains:

```rust
pub struct PagePreviewProjection {
    pub fields: Vec<PagePreviewField>,
    pub remaining_count: usize,
}

pub struct PagePreviewField {
    pub key: String,
    pub label: String,
    pub present: bool,
    pub value: Option<serde_json::Value>,
    pub schema_conflict: bool,
    pub label_conflict: bool,
    pub sources: Vec<PagePreviewSource>,
}

pub struct PagePreviewSource {
    pub base: PageBaseIdentity,
    pub label: Option<String>,
}
```

`PageBasePropertiesResponse` gains a required `preview` field. Required-with-empty output avoids undefined-versus-empty ambiguity for generated clients.

### Merge algorithm

For an unlocked page:

1. Evaluate matching Bases through the existing membership path.
2. Sort matching Bases by slug ascending.
3. Walk each Base’s `preview` list in configured order.
4. Normalize each configured reference to its canonical system/property/body identity and deduplicate by that identity.
5. The first occurrence fixes the merged field position.
6. Every later occurrence contributes source and label information to the same key.
7. Resolve the field value once from the current page using the existing Base field projection logic.
8. Return the first four merged fields.
9. Set `remaining_count` to the number of merged fields beyond four.

The cap is a response/display cap, not a configuration cap. Authors may configure longer lists without losing persisted intent.

### Label agreement

Each source has an effective label:

```text
configured label, otherwise canonical field key
```

- If every contributing source has the same effective label, return it and set `label_conflict = false`.
- If effective labels differ, return the canonical field key and set `label_conflict = true`.
- A missing explicit label and an explicit non-key label therefore conflict.

This makes conflict handling deterministic and avoids silently choosing one Base’s wording.

### Schema compatibility

- Reuse the existing normalized declaration compatibility result for custom properties.
- System fields and `body` do not have declaration conflicts.
- A schema-conflicted custom property may still show its raw current value through conservative read-only formatting; set `schema_conflict = true` so the UI does not imply agreement.
- Preview projection never changes `patchable`, blockers, or PATCH behavior in the existing property response.

### Values and absence

- `present = false`, `value = null` means the page has no value; render an em dash.
- `present = true`, `value = null` means the page explicitly stores JSON/TOML null; render the existing neutral null representation rather than treating it as absent.
- Multi-values retain array order and use compact read-only formatting.
- `body` uses `body_excerpt` and is absent when no body is available.
- Values are computed from the current indexed/page state; projection never writes.

### Protected pages

For an encrypted/locked page:

- return an empty preview field list and zero remainder;
- do not expose custom values or body excerpts;
- retain the endpoint’s existing page identity and encrypted status.

The preview card continues to show its existing protected-note treatment.

## Frontend Draft Model

`BaseDraft` mirrors the wire additions:

```ts
interface DraftPreviewField {
  id: string
  field: string
  label?: string
}

interface DraftView {
  // existing fields
  labels: Record<string, string>
}

interface BaseDraft {
  // existing fields
  preview: DraftPreviewField[]
}
```

`fromWire`, `toWire`, cloning, defaults, dirty comparison, and local validation must round-trip the new metadata without changing stored keys.

Client-generated `id` values are editor identity only and never cross the wire.

## Authoring UI

### Preview properties section

Add a Base-level **Preview properties** section after Properties in the definition workspace.

Each row contains:

- a field combobox using the shared available-field list;
- an optional preview-label input;
- Move up;
- Move down;
- Remove.

Behaviour:

- Add property appends one row.
- A field already selected in another preview row is disabled with an explicit duplicate reason.
- Move controls expose disabled reasons at the first/last boundary.
- Every action is keyboard-operable and text-labelled.
- `body` appears once in the field choices and remains visibly read-only/system-owned.
- Empty projection shows concise explanatory copy rather than an empty table.

### Per-view Display labels

Add a **Display labels** subsection to the selected-view editor.

Each override row contains:

- a field combobox;
- the stable key displayed read-only;
- a label input;
- Reset label.

Behaviour:

- Add label override chooses any available field, including `body` and fields outside `columns`.
- Duplicate overrides are prevented with an explicit reason.
- Reset removes only the map entry.
- Editing labels does not reorder fields or alter any other view configuration.
- Validation messages focus the exact row/control through the existing diagnostic routing.

### Save lifecycle

The new controls use the existing workspace draft and explicit Save/Discard lifecycle:

- edits mark the definition dirty;
- preview and label metadata are included in the same revisioned PUT;
- stale save conflicts retain the draft and use existing conflict recovery;
- no autosave, background mutation, or special endpoint is introduced.

## Generic Preview Rendering

### Data loading

`LinkPreviewLayer` and `TabPreviewCard` already load page data lazily. Once a page UUID is available, each requests the existing page-properties query. TanStack Query keys remain shared, so simultaneous link and tab previews reuse one response.

`PreviewBody` remains a presentation component. Consumers pass the projected summary into it rather than making `PreviewBody` own a network hook. This keeps Storybook and component tests deterministic and avoids hidden request ownership.

### Layout

Render a compact definition-list block after the current Markdown excerpt and before the optional tag row.

For each field:

- label on the left;
- compact formatted value on the right;
- missing value as `—`;
- label conflict marker with accessible text explaining that matching Bases disagree and the stored key is shown;
- schema conflict marker with accessible text explaining that matching Bases declare incompatible field schemas;
- `body` spans the row and uses a bounded plain-text line clamp;
- arrays use compact separators and preserve order.

After four fields, render `+N more` when `remaining_count > 0`.

The property block supplements rather than replaces the existing title, excerpt, word/backlink counts, protected state, and tags.

### Loading and failure

Preview chrome and existing content render immediately.

- While the property query is pending, reserve no large skeleton and do not delay the card.
- If configured projection data arrives, add the property block.
- On a passive preview query error, do not toast. Render muted `Properties unavailable` copy in the property region.
- Existing page preview content remains usable on projection failure.
- Closing/unmounting a preview relies on TanStack cancellation/cache behaviour; no custom global request state is added.

### Width and interaction

- Preserve the existing 340px preview width and viewport clamping.
- Projected values must wrap or truncate without horizontal overflow at normal and narrow viewport widths.
- Tab previews remain `pointer-events: none`.
- Link preview behaviour and navigation are unchanged.

## Error Handling

- Parse/type failures for new TOML fields use existing Base parse diagnostics.
- Addressed validation errors block Save and focus their controls.
- Stale revisions remain `409` and never partially publish metadata.
- Page not found retains the existing properties endpoint response.
- Projection evaluation must be total for malformed-but-loaded definitions: invalid references are skipped or returned as absent according to validation state; the endpoint must not panic.
- Passive preview-fetch failures never suppress the page’s existing title/body preview.

## Testing

### Rust domain tests

Cover:

- legacy Base deserialization with empty preview/labels;
- new TOML and JSON round trips;
- preview order;
- stable stored references after label changes;
- empty labels, duplicate preview keys, unknown fields, and addressed paths;
- valid `body` labels/projection;
- invalid writable `body` property remains rejected.

### Base document tests

Cover:

- stable new-file formatting;
- adding, editing, reordering, and removing preview metadata;
- adding, editing, and removing per-view labels;
- preservation of comments, unknown root keys, unknown view keys, and untouched managed nodes;
- stale revision byte identity.

### API tests

Cover:

- no matching Bases;
- matching Bases with no configured projection;
- deterministic Base-slug/list ordering;
- same-key de-duplication;
- agreed default and explicit labels;
- label conflicts;
- schema conflicts;
- present, missing, explicit null, scalar, and array values;
- body excerpt reuse and Unicode bound;
- encrypted pages;
- four-field cap and remainder count;
- unchanged existing property declarations, compatibility, blockers, and PATCH semantics.

### Frontend model and editor tests

Cover:

- wire/draft round trips;
- dirty comparison and cloning;
- preview add/reorder/remove;
- duplicate disabled reasons;
- per-view label add/edit/reset;
- fields outside columns and `body`;
- keyboard access and focus routing;
- Save, Discard, stale conflict, and no-autosave behaviour.

### Preview surface tests

Cover:

- shared response passed into `PreviewBody` from link and tab containers;
- agreed labels and values;
- missing em dash versus explicit null;
- label and schema conflict markers with accessible descriptions;
- body excerpt line clamp;
- arrays;
- `+N more`;
- loading, query error, empty projection, and protected page;
- existing title, excerpt, tags, and navigation remain intact.

### Browser verification

Exercise an actual saved Base and matching page:

1. add view labels and Base preview fields;
2. save and reload the definition;
3. hover a path-backed wikilink;
4. hover an inactive tab;
5. verify agreed labels, missing em dash, body excerpt, and four-field cap;
6. verify no horizontal overflow at normal and narrow widths;
7. verify changing a label does not change stored page keys or values.

## Documentation

Update `ui/src/docs/content/bases.mdx` with:

- exact TOML for `preview` and `views.labels`;
- stable-key versus presentation-label semantics;
- independence of table columns and generic preview projection;
- `body` read-only behaviour;
- deterministic multi-Base merge order;
- label/schema conflicts;
- missing-value em dash;
- four-field display cap and `+N more`;
- revision/conflict behaviour and advanced manual-file compatibility.

## Acceptance Criteria

The slice is complete when:

- a field can be relabelled independently in each view without changing its stored reference;
- `body` can be labelled and previewed but cannot be declared or patched;
- a Base author can configure an ordered generic preview projection independent of columns;
- existing Base files need no migration and are not rewritten merely by loading;
- multi-Base projections merge deterministically by stored key;
- agreed labels render, conflicting labels fall back to the key with an explanation, and schema conflicts are visible;
- missing values render as an em dash;
- body renders through the existing bounded plain-text excerpt pipeline;
- generic previews show at most four projected fields plus a remainder count;
- locked pages expose no projected values;
- link and tab previews share one backend/query contract and retain existing behaviour on failure;
- all authoring controls are keyboard-accessible, explicit-save, and revision-safe;
- focused and repository verification gates pass, except separately documented pre-existing repository baselines.
