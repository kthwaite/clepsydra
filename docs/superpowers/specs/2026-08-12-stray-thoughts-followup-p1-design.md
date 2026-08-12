# Clepsydra Stray Thoughts Follow-up P1 Design

**Date:** 2026-08-12  
**Status:** Approved design, pending written-spec review  
**Source:** `Clepsydra: Stray Thoughts`

## Goal

Deliver the five outstanding P1 items in two sequential, independently releasable waves:

1. correct the Folio outbound-link count;
2. remove tab pinning;
3. make Gazetteer result tags apply tag filters;
4. display bounded task-body excerpts on Tasking cards; and
5. add a dedicated property panel for the currently open Folio page.

Wave 1 contains the three bounded UI corrections. Wave 2 adds the server projections and shared editing primitives needed by Tasking excerpts and the Folio property panel. Wave 1 merges into `develop` before Wave 2 branches from the merged result.

## Non-goals

- Removing metadata-reference edges from the index or relation-diagnostics APIs.
- Replacing Gazetteer's URL-backed filter model.
- Persisting a compatibility pin control or a second tab-ordering model.
- Fetching task bodies individually from the browser.
- Treating embedded Base-table editing as the Folio property panel.
- Making one Base authoritative when a page matches several Bases.
- Automatically resolving incompatible Base declarations.
- Introducing a second page-property persistence path.

## Wave 1: bounded UI corrections

### Folio outbound-link semantics

The Folio **Links** value means resolved, user-facing outbound page or block links. Metadata-reference edges such as tag-derived `property_ref` entries remain available to index diagnostics but do not appear in the Folio count, tab badge, or outbound-link list.

One shared frontend projection filters the API response. The metadata value, tab badge, empty state, and rendered list all consume that projection so their counts cannot diverge.

#### Acceptance criteria

- A page with five tag-derived `property_ref` edges and no page links displays **Links: 0**.
- A resolved page or block link increments the count and appears in the outbound list.
- Unresolved or diagnostic-only metadata edges do not inflate the count.
- Backlink behavior and relation-diagnostics APIs remain unchanged.

### Remove tab pinning

Remove pinning as a clean cutover from tab types, state actions, controls, keyboard behavior, ordering, recent/open-page presentations, tests, and persisted workspace writes. Open tabs use the existing recency ordering and retain ordinary activation and close behavior.

Previously persisted objects may contain an extra `pinned` property. Loading ignores that obsolete field; Clepsydra does not expose a migration control, compatibility alias, or deprecated action.

#### Acceptance criteria

- No tab or open-page surface displays pin or unpin controls.
- Tab state and new persistence writes contain no `pinned` field.
- Previously persisted tabs still load, activate, order by recency, and close.
- Removing pinning does not change active-tab restoration or page-creation behavior.

### Gazetteer result-tag filtering

Each tag displayed in a Gazetteer result row becomes a keyboard-operable button. Activation adds the tag to the existing URL-backed tag filter through the authoritative route-state reducer.

The change composes with text, Kind, Project, sort, and existing tag filters. An already active tag is not duplicated. Browser history remains authoritative and restores the prior filter set.

#### Acceptance criteria

- Activating a result tag adds it to the URL filter and refreshes authoritative results.
- Existing text, Kind, Project, sort, and other tag filters remain intact.
- An already selected tag is inert rather than duplicated.
- Back and forward navigation restore the previous tag-filter state.
- Pointer and keyboard activation produce the same result and expose an accessible name and state.

## Wave 2: bounded projections and property editing

### Task body excerpts

Board responses include a server-produced optional body excerpt. The implementation reuses the existing Markdown-to-plain-text Base body projection semantics and 240-character Unicode-scalar bound by moving that logic to a shared backend helper rather than copying it.

The board loads excerpts in bulk as part of its authoritative projection. The browser never issues a page-body request per card. Protected or locked body content yields no excerpt. The response must distinguish unavailable protected content from an available but empty body if the UI renders those states differently.

Task cards render a bounded, secondary-text excerpt with a fixed line clamp. The excerpt does not replace the task title, checklist progress, tags, or metadata.

#### Acceptance criteria

- A task with Markdown body content receives a plain-text excerpt of at most 240 Unicode scalar values.
- Markdown syntax and raw HTML markup do not appear in the excerpt.
- Board loading performs no per-card body requests.
- Locked or encrypted body content is not exposed.
- Empty bodies do not render placeholder prose.
- Existing card activation, filtering, dragging, and inline controls remain operable.

### Folio property panel

The currently open Folio gains a dedicated property panel. It is independent of embedded Base tables and covers every Base whose membership predicate currently matches the page.

A backend projection uses the authoritative Base membership evaluator to return:

- matching Base identity and display name;
- declared property keys and schemas;
- each property's current page value;
- declaration provenance; and
- compatibility or conflict state for duplicate keys.

Declarations are grouped by property key. Compatible duplicate declarations produce one typed editor and list every declaring Base. Incompatible declarations show the current raw value, source Bases, and a visible schema conflict; editing is disabled until the Base definitions are reconciled. Base ordering never chooses schema semantics implicitly.

The panel distinguishes these empty states:

1. the page matches no Bases; and
2. the page matches Bases that declare no properties.

Absent declared properties remain available so the user can add them. Clearing an optional value removes the corresponding page-frontmatter property through existing metadata mutation semantics.

Typed controls are extracted from the existing Base table editing implementation and shared. The panel uses the existing revision-aware page metadata mutation path; it does not introduce a panel-specific save endpoint or frontend-only property store.

After a successful mutation, the panel refetches authoritative membership and declarations. If the edited value causes the page to leave a Base, that Base and its declarations disappear from the refreshed projection. A revision conflict retains the user's draft and uses the existing reload/discard conflict flow.

Locked or declaratively read-only Folios expose values and declaration provenance without edit controls.

#### Acceptance criteria

- The panel lists declarations from every matching Base, including absent values that may be added.
- Compatible duplicate declarations render one editor with complete provenance.
- Incompatible duplicate declarations render a conflict and cannot be edited.
- No Base is chosen implicitly by ordering.
- Each supported property type uses the same semantics as Base-table editing.
- Successful edits update page frontmatter through the existing revision/CAS path.
- Clearing an optional value removes its frontmatter key.
- Revision conflicts retain the unsaved draft.
- Membership and declarations refresh after each successful mutation.
- Read-only and locked Folios expose no mutation controls.

## Shared architecture and invariants

- Markdown pages remain the source of truth for task bodies and page properties.
- Base definitions remain advisory, non-owning schemas; a page may match any number of Bases.
- Base membership is evaluated server-side through the existing domain implementation.
- URL route state remains authoritative for Gazetteer filters.
- The relation index remains authoritative and complete; Folio applies a presentation-specific outbound-link projection.
- Existing page revision and compare-and-swap behavior remains the sole property mutation boundary.
- Body excerpts are bounded and privacy-aware before leaving the backend.
- No N+1 body or Base-definition fetches are introduced.
- New interactive controls are keyboard operable, visibly focusable, and named for assistive technology.

## Error handling

- Missing or malformed outbound-link targets remain diagnostic data but do not inflate Folio-visible counts.
- Obsolete persisted pin fields are ignored without blocking workspace restoration.
- Gazetteer filter navigation failures preserve the current route state and existing error presentation.
- Board excerpt failure follows the board request's existing failure contract; the UI does not retry bodies separately.
- A property-panel projection failure leaves Folio reading and editing available and provides a bounded retry action for the panel.
- An individual property mutation failure retains the draft value and reports the existing mutation error.
- Conflicting Base declarations are data diagnostics, not transport failures.
- A page leaving a Base after a successful edit is an authoritative state transition, not an error.

## TDD and verification

Each wave begins with failing tests for observable contracts and receives focused code review before integration.

### Wave 1 tests

- Folio count/list consistency across page links, block links, unresolved targets, and `property_ref` edges.
- Tab loading from obsolete persisted pin fields and pin-free state/actions/rendering.
- Gazetteer result-tag activation, filter composition, deduplication, accessibility, and history restoration.

### Wave 2 tests

- Shared excerpt conversion, exact 239/240/241-scalar boundaries, Markdown flattening, raw-HTML omission, and protected-body handling.
- Board projection and Task-card rendering without per-card fetches.
- Matching-Base aggregation, compatible deduplication, incompatible conflict projection, and both empty states.
- Every supported typed property editor, absent-property creation, clearing, successful mutation, revision conflict, post-save membership refresh, and read-only behavior.

### Repository gates

For each wave:

- affected focused tests;
- UI typecheck;
- UI lint;
- full UI test suite;
- production UI build; and
- desktop and mobile browser smoke tests against a disposable vault.

When backend contracts change, also run:

- Rust formatting check;
- `cargo check`;
- Clippy across all targets and features with warnings denied;
- full Cargo test suite;
- OpenAPI regeneration; and
- generated-client type verification.

## Smoke scenarios

### Wave 1

1. Open `Clepsydra: Stray Thoughts` and verify its tag-derived metadata edges no longer produce **Links: 5**.
2. Open, activate, reorder by use, close, reload, and restore several tabs from state that previously contained pin fields.
3. Click a Gazetteer result tag with text, Kind, and Project filters active; verify composition and browser back/forward restoration.

### Wave 2

1. Open Tasking with tasks containing rich Markdown, empty bodies, long Unicode bodies, and protected bodies; verify bounded excerpts and unchanged card interactions.
2. Open a Folio matching several Bases with compatible and conflicting declarations; add, edit, clear, and conflict a property value.
3. Edit a membership-driving property and verify the refreshed panel reflects the page's new matching-Base set.
4. Repeat the panel flow on locked and read-only Folios and at desktop and mobile widths.

## Delivery

Wave 1 and Wave 2 each receive a detailed TDD plan, isolated worktree, subagent execution, focused review, repository gates, and browser smoke proof. Wave 1 merges to `develop` and its worktree is removed before Wave 2 starts from the merged result.

The corresponding `Clepsydra: Stray Thoughts` checkboxes are marked complete through the vault MCP only after merged behavior is verified. No obsolete pin code, duplicate typed editors, frontend membership evaluator, per-card body fetch, compatibility alias, or parallel persistence path remains after the clean cutover.
