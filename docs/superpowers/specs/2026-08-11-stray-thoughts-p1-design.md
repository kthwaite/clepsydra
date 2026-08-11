# Clepsydra Stray Thoughts P1 Design

**Date:** 2026-08-11  
**Status:** Approved design, pending written-spec review

## Context

The vault page **Clepsydra: Stray Thoughts** contains nine open items triaged as P1. They span editor correctness, discovery performance, navigation continuity, RSS behavior, MCP authoring guidance, and the computed-tag model:

1. preserve new todo items across navigation without degrading them into irremovable bullets;
2. show todo checkbox changes immediately without requiring a refresh;
3. make search and Folio tag suggestions reliably respond within one second on the current vault;
4. allow the caret to leave inline code at the end of a line;
5. restore the open Folio and editing position after in-session navigation;
6. filter Gazetteer by Kind and Project;
7. retain read RSS items by default behind an explicit **Hide read** filter;
8. document MCP page and project authoring rules for LLMs; and
9. make kind-derived classifications visible, queryable computed tags.

This batch implements all nine items in one isolated feature worktree. The work is divided into four vertical slices so independent defects can be developed and reviewed separately without inventing parallel editor, search, or tag models.

## Goals

- Fix the two todo defects and terminal-inline-code trap at the shared Slate operation or normalization boundary.
- Make discovery reliable under real vault load, with stale-query protection and an observed one-second response target.
- Preserve Folio working context across navigation during the current application session.
- Add metadata filters to Gazetteer using the existing Kind and Project vocabulary and controls.
- Make RSS read-state filtering explicit and non-destructive.
- Give MCP clients unambiguous page creation, provenance, project filing, and project documentation rules.
- Establish Kind as the semantic source of kind-derived tags while remaining compatible with legacy stored tags.

## Non-goals

- Persisting Folio position across reloads or encoding caret/scroll state in URLs.
- Redesigning Gazetteer, Folio metadata, the tag picker, RSS feed management, or editor list presentation.
- A new search engine or index architecture without profiling evidence that the current design cannot meet the target.
- Automatically tagging edits, journal captures, or conversation captures as `ai-generated`.
- Eagerly rewriting every vault page to remove legacy kind-derived tags.
- General tag permissions, arbitrary computed expressions, user-defined computed tags, or a second metadata source of truth.

## Delivery structure

### Slice A: Editor integrity

The editor slice covers both todo defects and the terminal inline-code boundary. The implementation begins with reproductions through the real Slate input and serialization paths.

#### Todo checkbox state

An interactive checkbox operation must update the corresponding `list-item.checked` value through a Slate transform in the current editor transaction. The rendered checkbox, text presentation, editor value, autosave payload, and serialized Markdown must agree without a reload.

The checkbox component remains a projection of editor state. It must not maintain a second local checked value or force a visual refresh that hides an unchanged Slate document.

**Acceptance criteria**

- Activating an unchecked todo immediately renders it checked and applies the completed presentation.
- The editor change callback observes the updated list item.
- Serialized Markdown contains `[x]` after checking and `[ ]` after unchecking.
- Reloading the saved page preserves the state shown before navigation.
- One activation produces one undoable editor change.

#### Todo creation and navigation round trip

Creating a todo through existing autoformat or continuation commands must produce the canonical list shape accepted by both Markdown conversion directions. Saving, navigating away, and returning must reproduce the same editable todo item rather than a plain or structurally trapped bullet.

The correction belongs in the shared transform, normalization, or converter invariant revealed by the failing round trip. Navigation-specific repair and deletion exceptions are prohibited.

**Acceptance criteria**

- A newly created todo serializes to valid GFM task-list Markdown.
- Parsing the saved Markdown recreates a `list-item` with explicit checked state.
- The restored item can be edited, checked, unchecked, emptied, and removed through ordinary list commands.
- No extra bullet or empty list item appears after the round trip.

#### Terminal inline-code boundary

At a collapsed caret at the right edge of an inline-code leaf at the end of a text block, the user must be able to enter ordinary unmarked text. The editor will expose this through the normal forward/right-boundary interaction already used by its mark-boundary behavior; it must not require editing serialized backticks.

The fix must clear only the inherited `code` mark for the new insertion context. Moving or typing within the code span continues to edit code, and block code elements are unaffected.

**Acceptance criteria**

- A caret at the end of terminal inline code can advance to an ordinary-text insertion point.
- Text entered there uses the regular text presentation and serializes outside the backticks.
- Text entered inside inline code remains code.
- Bold, italic, links, block code, undo, and Markdown round trips retain existing behavior.

### Slice B: Discovery and Folio continuity

#### Search and tag-suggestion responsiveness

Search for page titles/content and Folio tag suggestions must either return results or present a specific failure state within one second on the current local vault. The implementation must first measure request, backend query, response, and render phases to locate the delay. Only the measured bottleneck is changed.

Interactive clients will debounce duplicate work where appropriate, cancel or logically supersede stale requests, and prevent an older response from replacing results for a newer query. A loading state may appear immediately; indefinite blank or stale interfaces are not acceptable.

Tokenization must continue to match title punctuation sensibly: a title such as `Clepsydra: Stray Thoughts` remains discoverable with `clep` and `clepsydra`. The colon is not itself treated as a required token.

**Acceptance criteria**

- Searches for `clep` and `clepsydra` find **Clepsydra: Stray Thoughts**.
- Folio tag suggestions open and resolve within one second on the current vault.
- Page search resolves within one second on the current vault.
- A superseded request cannot overwrite the latest query's results.
- Timeout and backend failures produce actionable UI feedback and permit retry.
- Existing exact, prefix, and general text matching behavior remains covered.

The one-second target is a smoke-performance contract against the current local vault, not a timing assertion in a shared unit-test runner. Automated tests cover tokenization, request supersession, and visible loading/error transitions deterministically.

#### Gazetteer Kind and Project filters

Gazetteer gains optional Kind and Project filters using the repository's existing Kind selector and Project combobox conventions. Both filters combine with the text query and with each other using AND semantics. Empty values mean no restriction.

Filtering occurs at the authoritative query layer rather than discarding a partially loaded client page. Filter selections remain in the Gazetteer route state so browser history restores them, but they do not become global application preferences.

**Acceptance criteria**

- Kind-only, Project-only, and combined filters return the expected pages.
- Filters combine with text search.
- Clearing either filter removes only that restriction.
- Back/forward navigation restores the route's query and filters.
- Unknown or removed project values fail closed with a clear empty state rather than broadening the query silently.

#### In-session Folio restoration

The Codex view stores a bounded in-memory restoration record for the active Folio before navigating to another application surface. The record contains the page identity, scroll position, and Slate selection needed to resume work. On return, the page opens first; scroll and selection restore only after the matching content revision has mounted.

Restoration is scoped to the running application session. Reloading the browser uses existing URL/default behavior. A stale record for a deleted, moved, protected, or changed page must not be applied to a different document.

**Acceptance criteria**

- Navigate from an open Folio to another application page and back: the same Folio reopens.
- Scroll and caret/selection restore after the editor mounts.
- Restoration never applies a position to a different page or incompatible content revision.
- Missing or inaccessible pages fall back to the existing safe empty/error state.
- Explicitly opening another page supersedes the saved restoration record.

### Slice C: RSS defaults and MCP authoring guidance

#### RSS read visibility

The feed river defaults to all entries, including read entries. A visible **Hide read** control applies the unread-only filter and can be reversed without changing read state. Marking an entry read updates its presentation but does not remove it unless the filter is active.

The setting may remain in route/component state according to the existing feed filter model; this batch does not introduce a new durable preferences subsystem.

**Acceptance criteria**

- Opening RSS shows both read and unread entries by default.
- Reading an entry does not remove it in the default view.
- Enabling **Hide read** removes read entries from the current result.
- Disabling it restores those entries without refetch inconsistencies or read-state mutation.
- Pagination and cache updates obey the active filter.

#### MCP authoring guidance

The MCP-facing instructions and user documentation will state one consistent workflow for LLM-authored pages:

1. search before creating to avoid duplicates;
2. use the page's real Kind rather than defaulting every page to Capture or Note;
3. add `ai-generated` to every standalone page authored by an LLM;
4. do not add `ai-generated` merely because an LLM edits a page, appends a journal capture, or captures a conversation;
5. assign the relevant project through the project field/assignment operation rather than inventing folders;
6. link substantial project documentation back to its project or hub page; and
7. use the dedicated journal and conversation-capture operations for those intents.

Tool descriptions, server-provided instructions, and in-app MCP documentation must not contradict one another. The guidance is normative for cooperating MCP clients; this batch does not add server-side authorship detection or reject pages lacking provenance.

**Acceptance criteria**

- An MCP client reading the server instructions can identify the correct create, capture, edit, and assignment operations.
- The `ai-generated` requirement and its exclusions are explicit.
- Project filing and project-documentation linking are explicit.
- Existing server/tool contract tests verify the shipped instruction text or structured guidance at its authoritative source.

### Slice D: Computed tags

Computed tags are system-derived classifications projected as tags for display and query without becoming removable user metadata. The initial derivation maps a resolved page Kind to its canonical lowercase tag, including `journal` for `JOURNAL`.

Kind is the sole semantic source of truth. A shared domain function computes canonical tags and merges them with stored user tags using normalized deduplication. APIs and index/query projections expose enough provenance to distinguish computed values from editable values; clients must not infer immutability from tag spelling alone.

#### Read-compatible cutover

New and updated page-writing paths stop adding redundant Kind-derived tags. Legacy frontmatter values remain readable. When a page is subsequently rewritten through an affected metadata path, a redundant stored value is omitted; there is no eager vault-wide migration.

A non-Journal page with a user-authored `journal` tag remains an ordinary editable tag because its Kind does not compute `journal`. Conversely, a Journal page always exposes computed `journal`, regardless of legacy frontmatter.

#### Query and mutation semantics

- Tag listing and page/search filters include computed tags.
- A query for a computed tag returns pages whose resolved Kind derives it.
- Duplicate legacy values do not produce duplicate counts or chips.
- Mutation APIs reject attempts to remove a page's computed classification as though it were stored metadata, while still allowing ordinary tags with the same spelling on pages where that tag is not computed.
- API responses identify computed and editable tags explicitly or provide equivalent typed fields; a flat undifferentiated tag array is insufficient for editing clients.

**Acceptance criteria**

- Every resolved page exposes its canonical Kind-derived tag as computed.
- Computed tags are visible and queryable through the API, index, Gazetteer, and Folio tag surfaces.
- Computed tags are visually distinct or otherwise clearly non-editable and cannot be removed by pointer, keyboard, or mutation request.
- Legacy redundant stored tags are deduplicated on read and removed on the next applicable page rewrite.
- No eager migration occurs.
- A non-derived user tag with the same spelling remains editable.
- Kind changes remove the old computed classification and add the new one atomically in API/index projections.
- Encrypted and protected-page behavior does not expose body content; only existing metadata-derived classification is added.

## Shared data flow and boundaries

- Slate remains authoritative for the live editor document; React elements render Slate state and do not shadow it.
- Markdown remains authoritative on disk; editor fixes must survive both conversion directions.
- Search and Gazetteer filters execute against the backend's authoritative index/query layer.
- Route state owns shareable Gazetteer filters; bounded in-memory Codex state owns non-shareable Folio restoration.
- RSS read state remains distinct from view filtering.
- Resolved Kind owns computed tag derivation. Storage, index, API, and UI consume one shared semantic rule rather than recreating spelling checks independently.
- MCP guidance has one authoritative server-side source with in-app documentation reflecting the same contract.

## Error handling

- Editor helpers return without mutation when selection or node structure does not satisfy their contract, preserving Slate defaults.
- Failed saves keep the current editor state and use existing conflict/error reporting; they do not claim persistence.
- Search and suggestion failures replace indefinite loading with a retryable error and cannot surface stale results as current.
- Folio restoration validates page identity and content compatibility before applying selection or scroll.
- Invalid Gazetteer filter values do not silently broaden results.
- RSS filter changes never mutate entry read state.
- Computed-tag derivation is deterministic and cannot fail on unknown user tags; unknown or invalid Kind values continue through existing typed error handling.

## Testing and verification

### TDD behavior tests

- Slate checkbox interaction, autosave value, undo, Markdown serialization, and reload.
- Todo creation through each affected command followed by serialize/parse/edit/remove round trips.
- Inline-code boundary exit, insertion outside code, insertion inside code, undo, and unaffected mark/block behavior.
- Search tokenization, stale-response suppression, loading/error/retry states, and authoritative Gazetteer filter combinations.
- Codex route-away/return restoration, mount ordering, stale revision, missing page, and explicit-open precedence.
- RSS default-all behavior, hide-read filtering, cache updates, and pagination.
- MCP instruction contract and documentation consistency at the authoritative source.
- Rust computed-tag derivation, deduplication, query/filter behavior, Kind transitions, metadata rewrites, mutation rejection, and API schema.
- UI computed-tag presentation, non-removability, ordinary same-spelling tags, and filtering.

### Verification gates

- UI typecheck: `bun run typecheck`
- UI lint: `bun run lint`
- UI suite: `bun run test`
- Rust formatting check: `cargo fmt --check`
- Rust type/build check: `cargo check`
- Rust lint: `cargo clippy --all-targets --all-features -- -D warnings`
- Rust suite: `cargo test`

### Smoke verification

Run the application against the current vault and exercise:

1. create, check, uncheck, save, navigate away from, return to, edit, and remove a todo;
2. type after inline code at the end of a line and inspect saved Markdown;
3. search `clep` and `clepsydra`, open Folio tag suggestions, and record sub-one-second completion;
4. combine Gazetteer text, Kind, and Project filters and use browser back/forward;
5. navigate away from a scrolled Folio with a caret selection and return;
6. mark an RSS entry read with **Hide read** off and on;
7. inspect MCP instructions from an actual MCP session; and
8. view, filter, and attempt to remove a computed `journal` tag, then rewrite a legacy page and inspect its frontmatter.

## Delivery

Implementation occurs in a new isolated worktree from `develop`. Each vertical slice receives a written TDD plan and is executed through subagents with explicit cross-slice contracts. Every slice is reviewed before integration. After smoke verification and all repository gates pass, the feature branch is committed, merged into `develop`, and the worktree is removed. The source vault checkboxes are marked complete only after the merged behavior is verified.
