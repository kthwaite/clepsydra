# Folio Base Embedding Design

**Date:** 2026-08-09
**Status:** Approved

## Problem

A Folio can edit page metadata and body content, and a Base can render and edit a live collection of matching pages, but a Folio cannot currently contain a live Base view. Authors must leave the document to consult or update a related Base, and there is no durable document syntax for a locally narrowed Base view.

## Outcome

A Folio author can insert a first-class Base embed, select a saved Base and saved view, optionally narrow it with a structured filter, override its sort, and cap its row count. The block renders the full Base table experience inside the Folio: saved-view navigation, property editing, member creation, Base configuration navigation, title navigation, and sorting.

The embed remains a reference to a saved Base. It does not copy or own Base definitions or member pages.

## User stories

- As a Folio author, I want to embed a saved Base view so that a document can contain a live collection without duplicating its pages.
- As a Folio author, I want to add an extra structured filter so that the embedded table can express document-local context.
- As a Folio author, I want view switches, sorting, and the row limit to persist with the document so that every reader sees the intended table.
- As a Base user, I want to edit properties and create members from the embed so that I do not need to navigate away from the Folio.
- As a keyboard user, I want the embed and its inspector to have explicit focus boundaries so that nested table controls do not corrupt the Slate selection.
- As a vault owner, I want malformed or stale embed references to remain recoverable in the document rather than disappear.

## Decisions

1. The persisted block references a saved Base and saved view.
2. Persisted overrides are an extra filter, sort keys, and a row limit.
3. Extra filters use the existing structured `Filter` model and visual filter builder. No query-expression language is introduced.
4. The embedded table exposes the full Base table behavior.
5. Member creation must atomically match Base membership, the saved view, and the embed filter. A failed create leaves neither a page file nor an index row.
6. The editor uses a first-class `base-embed` Slate void block rather than overloading generic code blocks.
7. The portable Markdown representation is a fenced `base` block containing TOML.
8. Configuration uses a rendered block plus a labelled inspector rather than an always-visible source editor.

## Document contract

### Slate node

```ts
interface BaseEmbedElementBase {
  type: "base-embed";
  children: [{ text: "" }];
}

interface UnconfiguredBaseEmbedElement extends BaseEmbedElementBase {
  status: "unconfigured";
}

interface ConfiguredBaseEmbedElement extends BaseEmbedElementBase {
  status: "configured";
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
  limit?: number;
}

interface InvalidBaseEmbedElement extends BaseEmbedElementBase {
  status: "invalid";
  rawBlock: string;
  parseError: string;
}

type BaseEmbedElement =
  | UnconfiguredBaseEmbedElement
  | ConfiguredBaseEmbedElement
  | InvalidBaseEmbedElement;
```

The element is a void block. Its renderer owns all interactive content inside a `contentEditable={false}` DOM descendant of the Slate editor. The empty text child exists only to satisfy Slate's void-node invariant.

### Markdown representation

```markdown
```base
base = "reading-log"
view = "Currently reading"
filter = { field = "rating", op = "gte", value = 4 }
sort = [{ field = "rating", dir = "desc" }]
limit = 20
```
```

`base` and `view` are required strings containing at least one non-whitespace character. Their non-whitespace content is otherwise preserved rather than trimmed. `filter`, `sort`, and `limit` are optional. An absent `sort` inherits the saved view's sort; an empty sort array explicitly removes saved sorting; a non-empty array replaces it. Clicking a sortable table header writes a one-element replacement array.

Configured serialization is deterministic: top-level key order is `base`, `view`, `filter`, `sort`, `limit`; recursive filter keys are `all`, `any`, or `not`, or `field`, `op`, followed by `value` only when that Filter operator carries a value; arrays and tables use inline TOML form; strings use double-quoted TOML syntax; output uses LF line endings and exactly one terminal newline. Valid comments and formatting may canonicalize away. Unknown keys at the top level or within any nested filter/sort table make the fence invalid rather than being dropped.

An absent node `limit` remains absent in Markdown but has embed semantics of 50: the embedded controller sends 50 and normalizes the query key as 50. The evaluation API itself treats an absent request limit as uncapped. Explicit limits accept 1 through 200. The block does not persist an offset. For a flat view, the limit caps total returned rows. For a grouped view, it caps returned rows per group while true group totals and aggregates remain visible. The rendered table reports either form of capping.

### Deserialization and invalid source

The Markdown-to-Slate converter recognizes fenced code with the exact language token `base` before the generic code-block branch. Valid TOML becomes a configured `base-embed` node.

Malformed TOML, unknown keys, or an invalid block shape becomes an `InvalidBaseEmbedElement`. `rawBlock` is the exact original fenced-block substring from the opening delimiter start through the closing delimiter and its existing line ending; an unclosed fence extends through the mdast node end. Conversion receives the original Markdown source and extracts this substring from mdast position offsets instead of relying on normalized `node.value`.

A dedicated Base-fence Markdown handler writes invalid `rawBlock` without transformation. This preserves the original delimiter length, internal delimiter runs, comments, spacing, CRLF, final-newline state, and closed/unclosed state. Source-repair mode derives its textarea body from `rawBlock`; saving valid configuration replaces the entire invalid node, so configured serialization can use its canonical fence.

The invalid recovery panel opens the inspector in source-repair mode; saving valid TOML replaces it with one configured node and returns the inspector to structured mode. Normal configured embeds never expose or require source editing. Unknown fenced languages remain ordinary code blocks.

## Folio experience

### Insertion

The editor command surface adds **Base embed**. The factory creates an `UnconfiguredBaseEmbedElement`, inserts that exact node, selects it, and opens the inspector. Saving atomically replaces it with a configured node. Cancelling removes that exact unconfigured node by Slate identity; cancelling edits to an existing block leaves its complete prior node unchanged.

An unconfigured node has emergency serialization as an empty fenced `base` block. If autosave or a crash persists it, reload deserializes the empty body as an invalid embed and exposes source recovery rather than losing content. Tests cover insert/Cancel and emergency save/reload.

### Inspector

The labelled modal inspector contains:

- a Base selector populated from the Base registry;
- a saved-view selector scoped to the selected Base;
- the existing structured filter builder, using the selected Base's declared and supported system fields;
- ordered sort controls using the existing `SortKey` model;
- a numeric limit control constrained to 1–200;
- Save and Cancel actions.

The inspector edits a local draft. It writes one Slate node update only after client validation succeeds. While the draft is invalid, field diagnostics are visible and Save is disabled. Existing rendered output remains mounted until a valid configuration is committed. Cancel restores the complete prior node unchanged.

Changing the Base selects its first saved view, clears filter and sort, and retains the limit. Changing only the saved view retains filter and limit but clears sort to absent so the new view's saved sort applies. The same view-change reset applies to rendered view tabs.

### Rendered block

The block header identifies the Base and active view and provides **Edit embed** and **Remove** controls. The body renders the existing Base table behavior:

- saved-view tabs;
- sortable columns;
- editable declared-property cells;
- title links that open member Folios;
- **Add member**;
- **Configure Base** navigation;
- grouped or flat output according to the saved view.

Changing the saved view or a column sort updates the embed node, so the choice persists with the Folio. A view switch retains filter/limit and resets sort to inherited; a header click writes one replacement sort key. Property edits and member creation mutate member pages through their existing APIs and do not modify the Folio body.

### Focus and accessibility

The renderer is a `contentEditable={false}` descendant of Slate and treats the embed as one selected void block. It does not add a second `role="application"`: `BaseTableView` supplies the single labelled table region and continues to own focus only inside its React Aria table. It exposes an explicit entry-focus handle; the Slate renderer owns the surrounding selection, before/after focus guards, inspector restoration, and removal fallback.

The keyboard contract is:

- with the Slate void selected, Enter or F2 focuses the first enabled target in this order: active view/table control, **Edit embed**, **Remove**;
- Shift+Tab reaching the before guard restores the Slate point before the block; when no preceding point exists, it uses the guaranteed point after the block;
- Tab reaching the after guard restores the Slate point after the block;
- Escape exits after the block only when a descendant did not already prevent it for cell cancellation, a dialog, or another nested interaction;
- Backspace/Delete remove the block only while Slate owns focus;
- removal focuses the following Slate point, falling back to the preceding point.

The document normalizer includes `base-embed` in `ensureTrailingParagraph`, so an embed at document end always has an after point. Guards are not additional application regions and do not compete with table focus.

The inspector is a labelled modal with initial focus and validation descriptions. Cancel/Escape from a configured or invalid source-repair inspector restores **Edit embed**. New insertion records a pre-insertion Slate bookmark; cancelling and removing that unconfigured node restores the bookmark when valid, otherwise uses the removal fallback. Query failures and creation notices use live regions without replacing persisted controls.

## Query and creation contracts

### Saved-view evaluation

Add a structured evaluation endpoint:

```http
POST /api/vault/bases/{slug}/views/{view}/evaluate
Content-Type: application/json

{
  "filter": { "field": "rating", "op": "gte", "value": 4 },
  "sort": [{ "field": "rating", "dir": "desc" }],
  "limit": 20
}
```

The server loads the saved Base and view and constructs one query specification:

```text
(Base membership) AND (saved-view filter) AND (embed filter)
```

The OpenAPI request and response are:

```rust
struct BaseViewEvaluateRequest {
    filter: Option<Filter>,
    // None inherits the saved sort; Some([]) removes it.
    sort: Option<Vec<SortKey>>,
    // None is uncapped at the API boundary.
    limit: Option<u32>,
}

struct BaseViewEvaluateResponse {
    output: QueryOutput,
    revision: String,
    member_creation: BaseMemberCapability,
}
```

An absent embed sort retains the saved view's sort, an empty array removes it, and a non-empty array replaces it. Saved columns, grouping, and aggregates remain authoritative. The limit maps to the flat row limit for flat output and the per-group row limit for grouped output.

The handler calls `base_document::load` once, resolves the named view from that `StoredBase`, and derives output, revision, and capability from that single snapshot. It must not combine registry data from one load with revision-bearing detail from another. The composed capability adds `Embed` to `BaseMemberScope`, `embed: bool` to `BaseMemberFieldRequirement`, and uses diagnostic root `embed_filter` for blockers contributed by the override. Successful responses have no duplicate top-level diagnostics; invalid overrides use the canonical 400 response below.

This avoids a client-side approximation of whether a filtered embed can create a matching member and gives the client one revision/capability pair bound to the evaluated predicate.

### Atomic filtered member creation

`BaseMemberCreateRequest` gains the exact optional wire field `embed_filter?: Filter` and retains the existing `base_revision` and `view` fields. Creation loads and revision-checks the Base, validates `embed_filter` with the same override validator, recomputes the same composed capability, and matches the completed candidate against membership, saved view, and `embed_filter` before publication. It never trusts capability data supplied by the client.

The draft exposes required editable fields from all three scopes. Save succeeds only if the completed candidate matches the uncapped composed predicate. The existing mutation coordinator remains the sole create boundary: validation occurs before publication, and any publication/index failure rolls back the page and index mutation.

Sort and limit do not participate in atomic membership. After success, the controller refreshes the capped query and focuses the created row only when that response contains its UUID. Otherwise it retains success and announces that the member matches the embed filter but falls outside the current row cap.

If `base_revision` is stale, the server returns conflict. When predicate identity is unchanged, the mounted draft retains every value, disables Save while evaluation refreshes, and retries only with the replacement capability identity.

## Frontend architecture

### Shared controller

Extract the orchestration currently owned by standalone `BaseTable` into a non-Slate `useBaseTableController` with:

```ts
type BaseTableMode = "standalone" | "embedded";

interface BaseTableControllerOptions {
  mode: BaseTableMode;
  slug: string;
  activeView: string;
  sort: SortKey[] | undefined;
  filter?: BaseFilter;
  limit?: number;
  onViewChange(view: string): void;
  onSortChange(sort: SortKey[] | undefined): void;
}
```

The standalone wrapper retains local view/sort state, the existing uncapped GET view endpoint, and detail-provided capabilities. The embedded wrapper is controlled by the Slate node, uses a custom TanStack query over the generated client's POST evaluation operation, sends an absent node limit as 50, and takes revision/capability from that evaluation response.

The controller owns property commits, member draft state, atomic member creation, refresh/focus reconciliation, and notices. `BaseTableView` remains presentational and imports neither Slate nor the controller. Its sort contract becomes `SortKey[] | undefined`: it displays the first key as the React Aria descriptor and header clicks emit a one-key replacement; ordered inspector sorts remain intact until a header replaces them. `EmbeddedBaseTable` alone translates controlled view/sort callbacks into one `Transforms.setNodes`.

### Query and operation identity

Configuration normalization recursively sorts object keys while preserving logical-filter child order and sort-array order. It distinguishes absent sort from `[]`, and maps absent embed limit to 50.

`predicateIdentity` is `{ slug, asciiFold(view), normalizedFilter }`. `capabilityIdentity` is `{ predicateIdentity, revision }`; evaluation capability and create submission bind to it. `queryIdentity` is `{ predicateIdentity, normalizedSort, normalizedLimit }`; row-placement focus additionally captures response revision and an operation token.

A predicate-identity change obsoletes every older draft operation, member focus target, and local notice. A sort/limit change leaves capability valid but obsoletes older row-placement focus and any cap inclusion/exclusion notice bound to the prior `queryIdentity`; a predicate-independent generic creation success may remain. A stale revision with unchanged predicate identity retains draft values while replacing capability identity. Property and member mutations invalidate saved GET views, embedded POST evaluations, and affected page caches through the existing invalidation boundary.

Responses apply only to their exact TanStack key. When an error occurs for a key that already has successful cached output, the table keeps that output mounted and renders the error alert alongside it. Loading/error replaces the grid only when that exact key has no successful data.

### Editor schema

The `base-embed` implementation follows the registry pattern:

- one element descriptor and factory;
- registration in the schema registry;
- a typed `BaseEmbedElement` union member;
- a renderer component;
- deterministic Markdown serialization;
- one explicit Markdown deserialization branch with original-source access;
- insertion command wiring;
- `base-embed` participation in the trailing-paragraph document rule.

Normalization repairs only the void child invariant and recognized status shape. A malformed configured in-memory node without original source becomes `{ status: "invalid", rawBlock: "\u0060\u0060\u0060base\n\u0060\u0060\u0060\n", parseError: "Invalid persisted base-embed node" }`; it never guesses Base, view, filter, or sort values. Serialization must emit that recovery fence, and reloading it must produce one invalid embed. No global renderer switch or second schema convention is introduced.

## Error and recovery behavior

- **Missing Base:** retain the block; show the missing slug with **Edit embed** and **Remove**.
- **Missing or renamed view:** retain the block; offer a valid saved-view selection in the inspector.
- **Invalid filter, sort, or limit:** show field-level inspector diagnostics; do not commit invalid configuration.
- **Server evaluation failure:** preserve the last successful output only for the same normalized query key, show an alert beside it, and allow retry/edit. A key with no successful data shows the error state instead of a grid.
- **Loading:** preserve same-key cached output with a loading status; without prior output, render a labelled loading state with stable dimensions.
- **Property conflict:** retain existing toast/refetch behavior.
- **Member creation conflict:** keep the draft mounted and populated. For unchanged predicate identity, refresh revision/capability and disable Save until they arrive; for changed predicate identity, close/obsolete the old operation without announcing into the new embed.
- **Base deletion while open:** transition to the missing-Base recovery state without rewriting the document.

## Race invariants

1. Query results, header status, and row focus apply only to the exact normalized query identity that started them.
2. Inspector drafts never alter live query identity before Save.
3. Slug, view, or filter changes obsolete older member focus and local notices; sort/limit changes obsolete older placement focus.
4. A filtered creation request validates the exact `embed_filter` and `base_revision` serialized in that request.
5. Cell mutation invalidation cannot rewrite the Folio node.
6. Removing the embed cancels or obsoletes pending query, inspector, focus, and member-creation effects.
7. If queries A then B resolve B then A, only B may render or receive focus.

## Security and resource bounds

- Base and view identifiers remain path parameters encoded by the generated client.
- A shared embed-override validator runs before SQL compilation or capability recursion for both evaluate and create. It enforces: filter depth at most 8; at most 64 total filter nodes; at most 32 children in one `all`/`any`; at most 100 values in one `in`; at most 8 sort keys; field identifiers at most 256 UTF-8 bytes; and scalar strings at most 4 KiB. Depth counts the root as 1.
- The 64 KiB configuration bound is measured as UTF-8 bytes of the extracted raw TOML fence body before parsing, raw bytes of the evaluate request body before JSON extraction, and compact `serde_json::to_vec(embed_filter)` bytes for the create request's filter subtree only. Existing title/member fields are not included in the create bound. A route-specific/custom extractor maps oversized evaluate bodies, and client-side TOML decoding maps oversized fence bodies, to the same canonical invalid-query diagnostic; create validates the serialized subtree before capability work.
- Embed filter/sort fields are canonicalized first, then accepted only when they resolve to the documented system-field allowlist or a property declared by the selected Base. Unknown bare names and unknown `prop.*` names are rejected; canonical aliases cannot bypass duplicate or reserved-name validation. Saved Base/view filters retain their existing definition-compatibility rules.
- The server enforces limit 1–200 independently of the UI. Every complexity bound is tested at the limit and limit plus one.
- Invalid override requests return HTTP 400 through the public envelope: `error = "invalid embed query"` and `detail = { code: "invalid_embed_query", diagnostics: [...] }`. Diagnostics use `BaseMemberScope::Embed`, canonical request field names, and `embed_filter` paths. Internal filesystem/database causes remain server-side.
- TOML parsing is data-only; no expression evaluation is introduced.

## Testing strategy

### Rust

- composition order and semantics for membership, saved view, and embed filters across typed scalar, relation, and logical cases;
- one-load snapshot consistency among output, revision, and capability, with capability blockers asserted separately;
- absent/empty/non-empty sort behavior; saved columns/grouping/aggregates; flat and per-group limits at 1 and 200; rejection at 0 and 201;
- every complexity bound at its limit and limit plus one, including undeclared/oversized/canonical-alias field rejection;
- `Embed` capability scope and `embed` field provenance from simple and nested filters;
- filtered creation success matches the uncapped composed predicate; capped output focuses it only when present and otherwise returns the explicit cap-exclusion notice;
- mismatch plus injected failures before publication, after file publication, and during index mutation, with direct assertions that both page path and index UUID are absent;
- stale Base revision, missing Base/view, invalid-request envelope, and sanitized internal failures;
- generated OpenAPI request/response schemas and exact wire names.

### Frontend model and API

- deterministic normalization: sorted object keys, preserved logical/sort order, absent sort versus `[]`, and absent limit normalized to 50;
- generated-client POST request shape, exact query keys, and mutation invalidation;
- standalone controller remains uncapped on GET while embedded mode uses response revision/capability and a 50 default;
- Base change clears filter/sort and retains limit; view change retains filter/limit and clears sort; Cancel preserves the original node;
- inspector validation, immutable node replacement, composed member fields/diagnostics, and stale-revision draft retention.

### Slate and Markdown

- descriptor classification as a void block, unconfigured factory default, and trailing-paragraph rule;
- insertion Cancel removes the exact node; emergency autosave/reload turns an empty fence into recoverable invalid state;
- configured semantic round trip for nested filters, absent/empty sort, limit, TOML escaping, and canonical final newline;
- invalid `rawBlock` equality for comments, unknown nested keys, spacing, CRLF, final-newline state, 4+ character fences with internal backtick runs, and unclosed fences;
- unknown fenced languages remain code blocks;
- malformed in-memory node normalization does not invent configuration.

### UI

- insertion, structured/source-recovery inspector Save/Cancel, and focus restoration;
- exact Enter/F2 target fallback, first-block before-exit fallback, configured/source-repair inspector restoration, new-insertion Cancel bookmark/removal fallback, before-guard Shift+Tab, after-guard Tab, unhandled Escape, Backspace/Delete ownership, and removal focus;
- full embedded-table behavior: property editing, persisted view switch/reset rules, persisted header sort, title navigation, and atomic Add-member submission with the embed filter;
- missing Base/view, same-key cached error, no-cache loading/error, and capped-result status;
- evaluate A then B and resolve B then A: only B rows/header/focus render;
- create under identity A, then change Base/view/filter: no A focus or live notice appears in B;
- removing the block obsoletes pending query, inspector, focus, and member work.

### Browser smoke

Create a temporary Base and Folio, insert an embed, select a saved view, add an extra filter, sort and cap it, edit a property, create a matching member, reload, and verify:

- the Markdown fence persisted canonically;
- the same view/filter/sort/limit render after reload;
- the property value persisted;
- the created page exists once and matches the uncapped composed predicate; when the configured cap excludes it, the embed shows the cap-exclusion success notice instead of attempting stale focus;
- no temporary page or stale document state remains.

## Alternatives considered

### Specialized generic code block

Render `code-block` nodes with language `base` as tables.

- **Benefit:** fewer schema registrations.
- **Rejected because:** one element would need incompatible source-editing and void-application behavior; code normalization, selection, syntax highlighting, and serialization would gain Base-specific branches.

### Generic query widget

Build an arbitrary vault-query element and adapt saved Bases into it.

- **Benefit:** broad future query flexibility.
- **Rejected because:** it duplicates Base context, property types, saved-view semantics, capability evaluation, and atomic creation rules. The approved use case is explicitly Base-referenced.

### Read-only embed

Render a saved view without mutations.

- **Benefit:** minimal nested interaction and backend change.
- **Rejected because:** the approved outcome requires property editing and atomic member creation from the Folio.

### Client-composed existing APIs

Fetch the saved Base, compose a generic query client-side, create against the saved view, and compensate if the row misses the embed filter.

- **Benefit:** smaller initial server diff.
- **Rejected because:** the generic query lacks Base context and client compensation cannot provide the no-page/no-index atomic guarantee.

## Out of scope

- standalone ad-hoc queries with no saved Base;
- local column, grouping, aggregate, layout, or property-schema overrides;
- a textual query-expression language;
- pagination state persisted in the document;
- embedding a Base inside another Base definition;
- copying or snapshotting result rows into Markdown;
- editing the Base definition inside the inspector.

## Acceptance criteria

1. Insertion creates an unconfigured void node; Save replaces it once, Cancel removes that exact node, and emergency autosave/reload is recoverable.
2. Configured fences serialize canonically; invalid fence bodies preserve comments, whitespace, CRLF, and final-newline state exactly.
3. The embed renders the selected saved view with persisted filter, sort, and effective limit, including defined grouped-limit behavior.
4. Base/view/header changes apply the specified reset rules and update only the Folio node; cell edits do not.
5. Standalone Base tables retain their existing uncapped GET behavior.
6. Declared properties are editable through the existing cell editors.
7. Add member is available only from the evaluation response's same-snapshot composed capability.
8. A successful filtered creation matches membership, saved view, and embed filter; capped output focuses it only when present and otherwise announces cap exclusion.
9. Mismatch and failures before/after publication leave no page path or index UUID.
10. Missing references, malformed source, and evaluation errors remain recoverable in place; same-key cached output stays visible beside errors.
11. Enter/F2, Tab, Shift+Tab, unhandled Escape, deletion, inspector restoration, and removal fallback obey the specified focus contract.
12. Out-of-order query responses and obsolete member operations cannot display, focus, or announce into newer state.
13. Both evaluate and create enforce every stated complexity, field, sort, string, body, and limit bound through the canonical 400 envelope.
14. Rust formatting, check, clippy, and tests; UI typecheck, lint, tests, and production build; and the browser smoke scenario all pass.
