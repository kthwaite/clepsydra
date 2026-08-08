# iOS Main Views Implementation Plan
> **Superseded (2026-08-08):** The native iOS client was replaced by the responsive web application specified in [`2026-08-08-responsive-mobile-web-design.md`](../specs/2026-08-08-responsive-mobile-web-design.md). This document is retained as historical context and must not be executed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the native iPhone client with mobile-adapted Atrium, Folio, Journal, Gazetteer, and Constellation views while preserving stable page identity, online-only operation, and revision-safe writes.

**Architecture:** Keep the Mac-hosted Axum server authoritative and extend domain APIs only for stable IDs, bounded activity, filtered content-index pages, graph neighborhoods, and UUID assignment. Split the growing Swift API into capability protocols, keep feature state and derivations in `ClepsydraCore`, and compose native SwiftUI views in `ClepsydraUI` behind a three-tab shell. Folio remains the shared UUID-addressed destination; Journal specializes Folio rather than duplicating it.

**Tech Stack:** Rust 2024, Axum 0.8, SQLite/rusqlite, utoipa/OpenAPI, Swift 6.2, SwiftUI/Observation, URLSession, SwiftUI Canvas, SunCalc 1.0.0, Xcode 26.2, XcodeGen 2.46.0, iOS 18.0+

## Global Constraints

- Implement the approved design in `docs/superpowers/specs/2026-08-07-ios-main-views-design.md`.
- Target iPhone only (`TARGETED_DEVICE_FAMILY = 1`) on iOS 18.0 or later.
- Keep the app online-only; do not add a vault replica, local search index, or background sync.
- Keep the Mac-hosted server authoritative and route every write through existing mutation coordination.
- Navigate pages by stable UUID. Paths are display and endpoint metadata, never mobile identity.
- Preserve required revision checks and never add force-save or automatic conflict retry.
- Keep Tasking, iPad-specific layouts, attachments, academic-library screens, notifications, and deep links out of scope.
- Use native SwiftUI; do not embed desktop views in `WKWebView`.
- Preserve the existing raw-Markdown editor and full-screen editor presentation.
- Keep XcodeGen 2.46.0 as project-file source of truth; do not hand-edit generated project state.
- Add no dependency except the exact `SunCalc` 1.0.0 package required by the approved Sky card.
- Each task is a clean vertical cutover: update every caller and test double, remove replaced symbols, and leave no aliases or placeholder screens.
- Run focused checks during each task; run all repository typecheck, lint, test, build, simulator, and physical-phone gates in Task 13.

---

## Planned File Structure

### Backend

- `src/vault/index.rs` — stable IDs in similar-page domain rows.
- `src/api/index_routes.rs` — content-index, activity, and bounded graph contracts and handlers.
- `src/api/openapi.rs` — OpenAPI registration and required-field/query assertions.
- `src/api/pages.rs` — UUID bulk assignment contract and handler.
- `src/api/mod.rs` — UUID assignment route registration.
- `tests/api_test.rs` — observable index, activity, graph, and assignment API contracts.

### ClepsydraCore

- `API/VaultAPI.swift` — capability protocols and composed `VaultAPI`.
- `API/APIClient.swift` — all typed request implementations.
- `Models/PageReference.swift` — shared stable navigation value.
- `Models/IndexModels.swift` — stats, tags, content, activity, links, and related pages.
- `Models/JournalModels.swift` — journal detail/summary and ensure results.
- `Models/GraphModels.swift` — graph query, nodes, edges, and response.
- `Models/AtriumModels.swift` — BCL, location, base rows, and property patch wire types.
- `Folio/FolioModel.swift` — page plus independently loaded apparatus state.
- `Folio/FolioDerivations.swift` — outline and word-count derivation.
- `Atrium/AtriumModel.swift` — independent card loading and refresh.
- `Atrium/AtriumDerivations.swift` — greeting, aphorism, inventory, and activity grid.
- `Atrium/SkyCalculator.swift` — SunCalc-backed sky presentation data.
- `Journal/JournalModel.swift` — written/unwritten today and recent-entry transitions.
- `Gazetteer/GazetteerModel.swift` — filter state, debouncing, pagination, and selection.
- `Constellation/ConstellationModel.swift` — graph fetch/filter state.
- `Constellation/ConstellationLayout.swift` — deterministic graph coordinates.

### ClepsydraUI

- `Shell/ConnectedVaultView.swift` — tab shell, independent stacks, global sheets.
- `Shell/AppRoute.swift` — typed page and Journal destinations; root sections are added as their real views ship.
- `Shared/LoadStateView.swift` — common read loading/error/empty presentation.
- `Folio/FolioView.swift` — shared page destination.
- `Folio/FolioMetadataView.swift` — document metadata and contents sheet.
- `Folio/FolioRelationsView.swift` — backlinks/outlinks/similar/tags sheet.
- `Atrium/AtriumView.swift` and focused card files under `Atrium/`.
- `Journal/JournalNavigationView.swift` and `Journal/QuickCaptureView.swift`.
- `Gazetteer/GazetteerView.swift` and `Gazetteer/GazetteerFiltersView.swift`.
- `Constellation/ConstellationView.swift`, `ConstellationCanvas.swift`, and `ConstellationDetailsView.swift`.
- `Reader/NoteReaderView.swift` is removed after its clean rename to Folio.

### Tests

- Extend `APIClientTests.swift`, `WireModelTests.swift`, and existing search/editor tests.
- Rename `ReaderModelTests.swift` to `FolioModelTests.swift`.
- Add focused core tests for Atrium, Journal, Gazetteer, and Constellation.
- Extend UI construction/wiring tests without adding a view-inspection dependency.

---

## Phase A — Server Read Contracts

### Task 1: Stable Index Identity and Activity Feed

**Files:**
- Modify: `src/vault/index.rs:89-96,1189-1293`
- Modify: `src/api/index_routes.rs:110-175,178-201,627-676,834-976`
- Modify: `src/api/openapi.rs:7-214,222-321`
- Modify: `tests/api_test.rs:1761-1838,2697-2875,4025-4075`

**Interfaces:**
- Produces: `ContentEntry.id: String`, `SimilarEntry.id: String`.
- Produces: `GET /api/vault/index/activity?days=182` returning `ActivityResponse`.
- `ActivityEntry`: `page_id`, `path`, `title`, `activity_at`.
- `activity_at`: `updated_at` when present, otherwise `created_at`.
- `days`: default `182`, accepted range `1...366`; invalid values return `400`.
- Extends `VaultStats` with `pages_created_today`, `pages_updated_today`, `pages_created_last_7_days`, and `untagged_pages`, computed against the server clock in UTC.

- [ ] **Step 1: Write failing stable-identity API tests**

Add assertions to `content_index_returns_page_details` and `similar_returns_pages_sharing_tags`:

```rust
assert_eq!(body["items"][0]["id"], expected_page_id);
assert_eq!(items[0]["id"], similar_page_id);
```

Create the fixture IDs explicitly so the assertion proves identity rather than merely checking for a string.

- [ ] **Step 2: Write failing activity and inventory-stat API tests**

Add `activity_returns_latest_page_activity_inside_requested_window` using a fixed fixture clock with one recent updated page, one recent created-only page, and one page older than the window. Add `activity_prefers_updated_at_and_rejects_invalid_days` using a page with both timestamps plus requests for `days=0` and `days=367`. Add `stats_returns_mobile_inventory_counts` with created-today, updated-today, seven-day, old, tagged, and untagged pages around the fixed UTC boundary.

Assert stable ID, canonical path, title, RFC3339 activity timestamp, exclusion of older pages, `400` for both invalid bounds, and all four inventory counts.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```bash
cargo test --test api_test content_index_returns_page_details
cargo test --test api_test similar_returns_pages_sharing_tags
cargo test --test api_test activity_
cargo test --test api_test stats_returns_mobile_inventory_counts
```

Expected: missing `id` and stats assertions fail and `/index/activity` returns `404`.

- [ ] **Step 4: Carry IDs through the similar-page domain row**

Change the domain row and SQL mapping to include the selected `p.id`:

```rust
pub struct SimilarRow {
    pub id: String,
    pub path: String,
    pub title: Option<String>,
    pub shared_tags: Vec<String>,
    pub score: f64,
}
```

Read columns as `(id, path, title, tags)`, propagate `id` into `SimilarEntry`, and retain the existing score/shared-tag/path ordering.

- [ ] **Step 5: Add IDs to content-index entries**

Add `id: String` to `ContentEntry` and populate it from the already loaded page/index row. Do not derive it from path and do not perform an extra query per page.

- [ ] **Step 6: Implement the activity route**

Add:

```rust
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ActivityQuery {
    #[serde(default = "default_activity_days")]
    days: u16,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ActivityEntry {
    page_id: String,
    path: String,
    title: Option<String>,
    activity_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ActivityResponse {
    items: Vec<ActivityEntry>,
}
```

Query pages where `COALESCE(updated_at, created_at)` is within the inclusive UTC window, order by activity descending then path ascending, and register `.route("/activity", get(activity))`.

- [ ] **Step 7: Extend stats with bounded SQL counts**

Compute the four inventory counts in the existing `stats` handler with SQL aggregate queries against UTC day/week boundaries from `state.clock`. Count untagged pages with `NOT EXISTS` over `tags`; do not load page rows to count in Rust.

- [ ] **Step 8: Register and pin the OpenAPI contract**

Register the path and schemas in `src/api/openapi.rs`. Add a unit test asserting required identity/activity/stats fields and the `days` query parameter.

- [ ] **Step 9: Run focused backend verification**

Run:

```bash
cargo test --test api_test content_index_returns_page_details
cargo test --test api_test similar_returns_pages_sharing_tags
cargo test --test api_test activity_
cargo test --test api_test stats_returns_mobile_inventory_counts
cargo test api::openapi::tests
```

Expected: all pass.

- [ ] **Step 10: Commit the stable read contract**

```bash
git add src/vault/index.rs src/api/index_routes.rs src/api/openapi.rs tests/api_test.rs
git commit -m "feat(api): expose stable index identities and activity"
```

### Task 2: Filtered and Sorted Content Index

**Files:**
- Modify: `src/api/index_routes.rs:130-136,834-976`
- Modify: `src/api/openapi.rs:222-321`
- Modify: `tests/api_test.rs:2803-2875,4025-4075`

**Interfaces:**
- Produces: `ContentIndexQuery { limit, offset, q, tag, sort }`.
- `ContentSort`: `updated | created | path | title | words`.
- Repeated `tag` values use AND semantics.
- Filter fields: title, path, description, and tags, case-insensitive.
- Sort occurs before pagination with path as deterministic final tiebreaker.

- [ ] **Step 1: Write failing API tests for query, tags, sorting, and pagination order**

Add tests named:

```rust
content_index_query_matches_title_path_description_and_tags
content_index_repeated_tags_use_and_semantics
content_index_sorts_before_paginating_with_deterministic_nulls
content_index_rejects_unknown_sort
```

Use `?q=...`, `?tag=a&tag=b`, and every sort token. Assert `updated`, `created`, and `words` descending; `path` and `title` ascending; null dates/word counts last; path breaks ties.

- [ ] **Step 2: Run the new tests and confirm failure**

```bash
cargo test --test api_test content_index_query_
cargo test --test api_test content_index_repeated_
cargo test --test api_test content_index_sorts_
cargo test --test api_test content_index_rejects_
```

Expected: parameters are ignored or rejected and result order is wrong.

- [ ] **Step 3: Replace the pagination-only query with the complete contract**

Add:

```rust
#[derive(Debug, Clone, Copy, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContentSort { Updated, Created, Path, Title, Words }

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ContentIndexQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub q: Option<String>,
    #[serde(default, rename = "tag")]
    pub tags: Vec<String>,
    pub sort: Option<ContentSort>,
}
```

Normalize the query once. Match all selected tags, then match the text query against the four declared fields. Sort the filtered entries before applying `offset` and `limit`.

- [ ] **Step 4: Preserve the response wrapper without a second convention**

Add a constructor accepting already filtered/sorted entries, or generalize `PaginatedResponse::from_vec`; do not introduce a second pagination response type. `total` must be the filtered count before slicing.

- [ ] **Step 5: Update OpenAPI and generated desktop types**

Register `ContentSort`, pin the query parameters in an OpenAPI unit test, start a temporary Clepsydra server, and run:

```bash
bun run --cwd ui openapi
```

Confirm `ui/src/api/schema.d.ts` gains `ContentEntry.id` and the query fields without changing current desktop call sites.

- [ ] **Step 6: Run focused verification**

```bash
cargo test --test api_test content_index
cargo test api::openapi::tests
bun run --cwd ui typecheck
bun run --cwd ui test -- src/components/codex/gazetteer-filter.test.ts
```

Expected: all pass and desktop Gazetteer semantics remain unchanged.

- [ ] **Step 7: Commit the content-index query contract**

```bash
git add src/api/index_routes.rs src/api/openapi.rs tests/api_test.rs ui/src/api/schema.d.ts
git commit -m "feat(api): filter and sort content index"
```

### Task 3: Bounded Graph Queries

**Files:**
- Modify: `src/api/index_routes.rs:110-128,618-676`
- Modify: `src/api/openapi.rs:222-321`
- Modify: `tests/api_test.rs:2697-2802`

**Interfaces:**
- Produces: `GraphQuery { anchor_id, depth, include_journals, include_orphans }`.
- `depth`: only `1` or `2`, and requires `anchor_id`.
- Unknown anchor: `404`.
- Invalid depth or depth without anchor: `400`.
- Filtering always removes edges whose source or target was removed.

- [ ] **Step 1: Write failing graph-neighborhood tests**

Create a graph fixture containing a chain, a branch, a journal node, and an orphan. Add tests:

```rust
graph_depth_one_returns_anchor_and_direct_neighbors
graph_depth_two_returns_exact_reachable_subgraph
graph_filters_journals_and_unanchored_orphans
graph_rejects_invalid_depth_and_unknown_anchor
graph_without_query_preserves_existing_response
```

- [ ] **Step 2: Run the graph tests and confirm failure**

```bash
cargo test --test api_test graph_
```

Expected: query parameters have no effect and invalid combinations do not return declared errors.

- [ ] **Step 3: Add validated query types**

```rust
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct GraphQuery {
    anchor_id: Option<String>,
    depth: Option<u8>,
    #[serde(default = "default_true")]
    include_journals: bool,
    #[serde(default = "default_true")]
    include_orphans: bool,
}
```

Validate before loading/filtering. Parse `anchor_id` as UUID so malformed IDs return `400` and a valid absent UUID returns `404`.

- [ ] **Step 4: Implement one pure graph filter**

Add a private pure function used by the handler:

```rust
fn filter_graph(
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    query: &GraphQuery,
) -> Result<GraphResponse, ApiError>
```

Apply journal filtering first, build adjacency once, perform breadth-first traversal for anchored depth, remove unanchored degree-zero nodes when requested, then retain only edges with both endpoints present. Avoid repeated `nodes.iter().any(...)` scans inside edge loops; use `HashSet<String>`.

- [ ] **Step 5: Update OpenAPI and desktop generated types**

Register query parameters, regenerate `ui/src/api/schema.d.ts`, and keep the existing no-query `useGraph()` call valid.

- [ ] **Step 6: Run focused verification**

```bash
cargo test --test api_test graph_
cargo test api::openapi::tests
bun run --cwd ui typecheck
bun run --cwd ui test -- src/components/codex/constellation-filters.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit bounded graph reads**

```bash
git add src/api/index_routes.rs src/api/openapi.rs tests/api_test.rs ui/src/api/schema.d.ts
git commit -m "feat(api): support bounded graph neighborhoods"
```

---

## Phase B — Mobile Contracts and Shell

### Task 4: Swift Capability Protocols and Wire Models

**Files:**
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/VaultAPI.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/APIClient.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/PageReference.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/IndexModels.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/JournalModels.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/GraphModels.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/AtriumModels.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Search/SearchModel.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Reader/ReaderModel.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Editor/EditorModel.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/SearchModelTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/ReaderModelTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/EditorModelTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/WireModelTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/APIClientTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/AppRootViewTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/VaultSessionTests.swift`

**Interfaces:**

```swift
public protocol ConnectionAPI: Sendable { func uptime() async throws }
public protocol SearchAPI: Sendable { func search(query: String, limit: Int) async throws -> [SearchResult] }
public protocol PageAPI: Sendable {
    func page(id: UUID) async throws -> PageDetail
    func createPage(_ request: CreatePageRequest) async throws -> PageDetail
    func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail
}
public protocol IndexAPI: Sendable {
    func stats() async throws -> VaultStats
    func tags() async throws -> [TagCount]
    func contentIndex(_ query: ContentIndexQuery) async throws -> ContentIndexPage
    func activity(days: Int) async throws -> ActivityResponse
    func backlinks(path: String) async throws -> [Backlink]
    func outlinks(path: String) async throws -> [Outlink]
    func similar(path: String) async throws -> SimilarResponse
    func graph(_ query: GraphQuery) async throws -> GraphResponse
}
public protocol JournalAPI: Sendable {
    func journalToday() async throws -> JournalToday?
    func ensureJournalToday() async throws -> JournalEnsureResult
    func recentJournals(days: Int) async throws -> [JournalSummary]
    func quickCapture(_ content: String) async throws -> PageDetail
}
public protocol AuxiliaryAPI: Sendable {
    func bcl() async throws -> BCLStatus
    func location() async throws -> VaultLocation
    func updateLocation(_ request: UpdateLocationRequest) async throws -> VaultLocation
    func geocode(_ query: String, limit: Int) async throws -> [GeocodeCandidate]
}
public protocol JournalEditingAPI: PageAPI, JournalAPI {}
public protocol BasesAPI: Sendable {
    func baseView(slug: String, view: String) async throws -> BaseQueryOutput
    func patchProperties(pageID: UUID, request: PropertyPatchRequest) async throws -> PropertyPatchResponse
}
public protocol VaultAPI:
    ConnectionAPI, SearchAPI, JournalEditingAPI, IndexAPI, AuxiliaryAPI, BasesAPI {}
```

Feature models consume the narrowest protocol; only `VaultSession` stores `any VaultAPI`.

- [ ] **Step 1: Write failing wire-decoding tests**

Add JSON fixtures for `VaultStats`, `TagCount`, paginated `ContentEntry`, `ActivityResponse`, backlinks, outlinks, similar pages, journal today/summary, graph, BCL, location, flat base view, and property patch response. Assert every navigable model's `pageReference` contains UUID, path, and title.

- [ ] **Step 2: Write failing API request tests**

Extend the transport recorder to assert paths and query items for every method, including repeated `tag`, graph booleans, journal `404 -> nil`, journal ensure `200/201`, and activity `days`.

- [ ] **Step 3: Run Swift tests and confirm compile failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter WireModelTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter APIClientTests
```

Expected: new models and protocol methods do not exist.

- [ ] **Step 4: Split `VaultAPI` into capability protocols**

Keep `VaultAPI` as the composed session contract. Change `SearchViewModel` to `any SearchAPI`, `ReaderViewModel` to `any PageAPI`, and `EditorViewModel` to `any PageAPI`. Update test doubles to implement only the capability under test instead of stubbing every operation.

- [ ] **Step 5: Implement exact wire models and reference mapping**

Use `Codable`, `Equatable`, and `Sendable` throughout. Define:

```swift
public struct PageReference: Hashable, Sendable, Identifiable {
    public let id: UUID
    public let path: String
    public let title: String?
}

public struct ContentIndexQuery: Equatable, Sendable {
    public enum Sort: String, Sendable { case updated, created, path, title, words }
    public let limit: Int?
    public let offset: Int
    public let query: String?
    public let tags: [String]
    public let sort: Sort?
}
```

Represent graph depth with a `GraphDepth` enum. Before transport, `APIClient` rejects activity days outside `1...366`, non-positive content limits, negative offsets, empty geocode queries, and geocode limits outside `1...10` with `VaultAPIError.other`.

- [ ] **Step 6: Refactor `APIClient.send` to preserve response status**

Introduce one checked response helper:

```swift
private func sendResponse(
    _ request: URLRequest,
    operation: String,
    accepting statuses: Set<Int> = [200]
) async throws -> (Data, HTTPURLResponse)
```

Build `send` on top of it. Journal today accepts `200` and `404`; ensure today accepts `200` and `201`. Continue mapping `409` through existing revision-conflict handling.

- [ ] **Step 7: Implement typed client operations**

Use `URLComponents`/`URLQueryItem`; emit one `tag` item per selected tag. Never hand-concatenate user input into URLs. Keep operation names stable and user-readable for decoding errors.

- [ ] **Step 8: Run Swift contract verification**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter WireModelTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter APIClientTests
swift test --package-path ios/Packages/ClepsydraMobileKit
```

Expected: all pass.

- [ ] **Step 9: Commit mobile contracts**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add main-view API contracts"
```

### Task 5: Typed Connected Shell and Navigation

**Files:**
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Shell/AppRoute.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Shell/ConnectedVaultView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Shared/LoadStateView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/AppRootView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/AppRootViewTests.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/ConnectedVaultViewTests.swift`

**Interfaces:**

```swift
public enum AppRoute: Hashable, Sendable { case folio(PageReference), journalToday }
```

`SearchView.openPage` changes from `(UUID) -> Void` to `(PageReference) -> Void`.

- [ ] **Step 1: Write failing navigation construction tests**

Assert `AppRoute.folio` is hashable, the connected shell accepts one injected session/API, and `SearchResult.pageReference` is forwarded unchanged.

- [ ] **Step 2: Run the UI tests and confirm compile failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter ConnectedVaultViewTests
```

- [ ] **Step 3: Move connected composition out of `AppRootView.swift`**

Keep `AppRootView` responsible only for setup-vs-connected state. Move the existing functional Search root into `ConnectedVaultView` with one `NavigationStack` and typed Folio destinations. Root tabs are introduced only when Gazetteer ships in Task 9, so this task leaves no empty future screens.

- [ ] **Step 4: Centralize global sheets**

Store search and create-note presentation once in `ConnectedVaultView`. Successful creation appends `.folio(createdPage.pageReference)` to the connected navigation path.

- [ ] **Step 5: Clear navigation on server identity change**

Key connected shell state by the normalized `ServerURL` exposed by `VaultSession`; disconnect or replacement resets the navigation path and presented sheets before new data appears.

- [ ] **Step 6: Build and smoke-test the shell**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Launch a simulator, connect to a test server, open search, create a note, and verify the returned Folio route is pushed.

- [ ] **Step 7: Commit the shell**

```bash
git add ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests
git commit -m "feat(ios): add connected main-view shell"
```

---

## Phase C — Shared Folio and Daily Flow

### Task 6: Rename Reader to Folio and Add Apparatus

**Files:**
- Rename: `Sources/ClepsydraCore/Reader/ReaderModel.swift` to `Sources/ClepsydraCore/Folio/FolioModel.swift`
- Create: `Sources/ClepsydraCore/Folio/FolioDerivations.swift`
- Rename: `Sources/ClepsydraUI/Reader/NoteReaderView.swift` to `Sources/ClepsydraUI/Folio/FolioView.swift`
- Create: `Sources/ClepsydraUI/Folio/FolioMetadataView.swift`
- Create: `Sources/ClepsydraUI/Folio/FolioRelationsView.swift`
- Modify: `Sources/ClepsydraUI/Markdown/MarkdownPreview.swift`
- Rename: `Tests/ClepsydraCoreTests/ReaderModelTests.swift` to `Tests/ClepsydraCoreTests/FolioModelTests.swift`
- Create: `Tests/ClepsydraCoreTests/FolioDerivationsTests.swift`
- Create: `Tests/ClepsydraUITests/FolioViewTests.swift`
- Modify: `Sources/ClepsydraUI/Shell/ConnectedVaultView.swift`
- Modify: `Sources/ClepsydraUI/Search/SearchView.swift`

**Interfaces:**

```swift
public struct FolioOutlineEntry: Equatable, Sendable, Identifiable {
    public let id: Int
    public let level: Int
    public let title: String
}

public enum RelatedResource<Value: Equatable & Sendable>: Equatable, Sendable {
    case idle, loading, loaded(Value), failed(String)
}
```

`FolioViewModel` loads the page by UUID first, then loads backlinks, outlinks, and similar pages concurrently using the returned canonical path. A related-resource failure does not replace the page.

- [ ] **Step 1: Use LSP references before renaming exported symbols**

Run LSP references for `ReaderViewModel` and `NoteReaderView`. Record every source and test call site, then use LSP rename and file rename so no compatibility alias remains.

- [ ] **Step 2: Write failing derivation tests**

Cover heading order/levels, duplicate heading text with distinct integer IDs, empty outlines, Unicode word counting, and page/reference mapping for backlinks, resolved outlinks, and similar results.

- [ ] **Step 3: Write failing Folio state tests**

Cover page-first loading, concurrent apparatus loading, stale related responses after page reload, canonical path adoption, independent related failures, retry of one resource, and accepting an edited page with a new revision/path.

- [ ] **Step 4: Run focused tests and confirm failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Folio
```

- [ ] **Step 5: Implement Folio derivations and state**

Derive outline from `MarkdownDocument.blocks(from:)`. Keep word count and outline pure. On page reload, increment one generation token, cancel all relation tasks, and reload against the new canonical path.

- [ ] **Step 6: Build mobile Folio composition**

Use `ScrollViewReader` with stable block indices for contents jumps. Present:

- primary article and title;
- edit toolbar action;
- metadata/contents sheet with kind, project, path, created/updated timestamps, word count, tags, aliases, and outline;
- relations sheet with backlinks, resolved outlinks, visibly unresolved outlinks, similar pages, and tags;
- inline independent error/retry states inside the affected sheet section.

Keep the existing editor sheet callback and `model.accept(savedPage)` behavior.

- [ ] **Step 7: Update navigation call sites by clean cutover**

Every shell, search, and editor callback now constructs `FolioView(reference:api:)`. Remove `NoteReaderView`, `ReaderViewModel`, `ReaderModel`, and their old directories after all references are migrated.

- [ ] **Step 8: Verify Folio behavior**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Folio
swift test --package-path ios/Packages/ClepsydraMobileKit --filter EditorModelTests
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Simulator smoke: search → Folio → contents jump → backlink Folio → edit/save → returned updated Folio.

- [ ] **Step 9: Commit Folio**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): expand reader into mobile Folio"
```

### Task 7: Core Atrium

**Files:**
- Create: `Sources/ClepsydraCore/Atrium/AtriumModel.swift`
- Create: `Sources/ClepsydraCore/Atrium/AtriumDerivations.swift`
- Create: `Sources/ClepsydraUI/Atrium/AtriumView.swift`
- Create: `Sources/ClepsydraUI/Atrium/AtriumHeroView.swift`
- Create: `Sources/ClepsydraUI/Atrium/AtriumInventoryView.swift`
- Create: `Sources/ClepsydraUI/Atrium/ActivityHeatmapView.swift`
- Create: `Sources/ClepsydraUI/Atrium/AtriumRecentsView.swift`
- Create: `Tests/ClepsydraCoreTests/AtriumDerivationsTests.swift`
- Create: `Tests/ClepsydraCoreTests/AtriumModelTests.swift`
- Create: `Tests/ClepsydraUITests/AtriumViewTests.swift`
- Modify: `Sources/ClepsydraUI/Shell/ConnectedVaultView.swift`

**Interfaces:**

```swift
public enum CardState<Value: Equatable & Sendable>: Equatable, Sendable {
    case idle, loading, loaded(Value), failed(String)
}

@MainActor @Observable
public final class AtriumViewModel {
    public private(set) var stats: CardState<VaultStats>
    public private(set) var tags: CardState<[TagCount]>
    public private(set) var updated: CardState<[ContentEntry]>
    public private(set) var created: CardState<[ContentEntry]>
    public private(set) var activity: CardState<ActivityGrid>
    public func load()
    public func refresh() async
    public func retry(_ card: AtriumCard)
}
```

- [ ] **Step 1: Write failing pure derivation tests**

Port and pin desktop semantics for local greeting, dot-date/daystamp, daily aphorism, inventory cells, UTC 26-week activity grid, activity levels, longest/current streaks, and deterministic recent ordering. Include leap year and UTC/local-boundary fixtures.

- [ ] **Step 2: Write failing independent-card state tests**

Use a controlled `IndexAPI` to prove concurrent starts, independent success/failure, per-card retry, stale-response rejection, and refresh retaining loaded data until its replacement succeeds.

- [ ] **Step 3: Run Atrium tests and confirm failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Atrium
```

- [ ] **Step 4: Implement bounded Atrium loads**

Issue concurrently:

```swift
api.stats()
api.tags()
api.contentIndex(.init(limit: 8, offset: 0, query: nil, tags: [], sort: .updated))
api.contentIndex(.init(limit: 8, offset: 0, query: nil, tags: [], sort: .created))
api.activity(days: 182)
```

Transform only the activity response into `ActivityGrid`; do not fetch the full content index.

- [ ] **Step 5: Implement the vertical card UI**

Build a single `ScrollView` with search/new-note hero actions, aphorism, inventory, activity, tags, and edited/created recents. Each card renders its own progress/error/empty state. Use `.refreshable` for coordinated refresh. Replace the connected Search root with this real Atrium root; search remains available through the shell presentation.

- [ ] **Step 6: Wire available page actions and global sheets**

Recent/activity page taps push `.folio(entry.pageReference)`; Search and New Note use shell presentations. Render top tags as informative chips in this task; Task 9 makes them navigable when the Gazetteer destination exists. Do not render Journal controls until Task 8 supplies their complete behavior.

- [ ] **Step 7: Run focused verification**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Atrium
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

- [ ] **Step 8: Commit core Atrium**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add core Atrium dashboard"
```

### Task 8: Journal Today, Navigation, and Quick Capture

**Files:**
- Create: `Sources/ClepsydraCore/Journal/JournalModel.swift`
- Create: `Sources/ClepsydraUI/Journal/JournalNavigationView.swift`
- Create: `Sources/ClepsydraUI/Journal/QuickCaptureView.swift`
- Modify: `Sources/ClepsydraUI/Folio/FolioView.swift`
- Modify: `Sources/ClepsydraUI/Atrium/AtriumView.swift`
- Modify: `Sources/ClepsydraUI/Editor/NoteEditorView.swift`
- Modify: `Sources/ClepsydraCore/Editor/EditorModel.swift`
- Modify: `Tests/ClepsydraCoreTests/EditorModelTests.swift`
- Create: `Tests/ClepsydraCoreTests/JournalModelTests.swift`
- Create: `Tests/ClepsydraUITests/JournalViewTests.swift`

**Interfaces:**

```swift
public enum TodayJournalState: Equatable, Sendable {
    case idle, loading, unwritten, written(JournalToday), failed(String)
}
```

Only `EditorViewModel.Mode.journalToday(title:)` may call `ensureJournalToday()`. Past entries always open their existing UUID Folio and use normal `.edit(PageDetail)` mode.

- [ ] **Step 1: Write failing Journal model tests**

Cover `404 -> unwritten`, transport failure distinction, `200/201` ensure result, recent ordering, previous/next written entry, no historical creation, quick-capture success, quick-capture failure retention, and stale-response rejection. Extend `EditorModelTests` to prove journal save calls ensure then UUID update, never collection create; uses the ensured revision; retains the typed draft if ensure/update fails; and surfaces a conflict if another writer changes the ensured page.

- [ ] **Step 2: Run Journal tests and confirm failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Journal
```

- [ ] **Step 3: Implement Journal state and editor persistence**

Load today and recent journals concurrently. Add `EditorViewModel.Mode.journalToday(title:)` and change the editor dependency to `any JournalEditingAPI`. On first save, call `ensureJournalToday()`, retain the user's in-memory title/body, then call `updatePage(id:request:)` with the ensured page ID and revision. Adopt the update response as the source page. Never call collection create for a Journal and never replace the draft with the server template before update succeeds.

- [ ] **Step 4: Add Journal specialization to Folio**

When a page is a Journal, show date, day-of-year, relative-day label, previous/next written entries, and recent timeline in metadata. Navigation uses journal summary UUIDs and updates the current stack destination rather than creating desktop tabs.

- [ ] **Step 5: Implement quick capture**

Present a compact sheet retaining input until `quickCapture` succeeds. Disable duplicate submission while in flight. On success, dismiss and refresh today/Atrium; on failure, keep text and show retry.

- [ ] **Step 6: Add complete Atrium Journal controls**

Add Open Today and Quick Capture to the Atrium hero only after their state, sheets, and error paths are implemented. Open Today handles written and unwritten states; Quick Capture invokes the real sheet.

- [ ] **Step 7: Verify Journal end to end**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Journal
swift test --package-path ios/Packages/ClepsydraMobileKit --filter EditorModelTests
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Simulator smoke with fixed server clock: unwritten today → edit/save → recent navigation → quick capture → reload.

- [ ] **Step 8: Commit Journal**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add Journal daily workflow"
```

---

## Phase D — Vault Browsing and Graph

### Task 9: Gazetteer Browse, Filter, and Pagination

**Files:**
- Create: `Sources/ClepsydraCore/Gazetteer/GazetteerModel.swift`
- Create: `Sources/ClepsydraUI/Gazetteer/GazetteerView.swift`
- Create: `Sources/ClepsydraUI/Gazetteer/GazetteerFiltersView.swift`
- Create: `Tests/ClepsydraCoreTests/GazetteerModelTests.swift`
- Create: `Tests/ClepsydraUITests/GazetteerViewTests.swift`
- Modify: `Sources/ClepsydraUI/Shell/ConnectedVaultView.swift`
- Create: `Sources/ClepsydraUI/Shell/AppSection.swift`
- Modify: `Sources/ClepsydraUI/Atrium/AtriumView.swift`

**Interfaces:**

```swift
public struct GazetteerFilter: Equatable, Sendable {
    public var query: String
    public var tags: Set<String>
    public var sort: ContentIndexQuery.Sort
}

@MainActor @Observable
public final class GazetteerViewModel {
    public private(set) var entries: [ContentEntry]
    public private(set) var total: Int
    public private(set) var isLoadingFirstPage: Bool
    public private(set) var isLoadingNextPage: Bool
    public private(set) var errorMessage: String?
    public func updateFilter(_ filter: GazetteerFilter)
    public func loadNextPage()
    public func retry()
}
```

Page size is 50. Gazetteer exposes `.updated`, `.path`, `.title`, and `.words`; `.created` remains Atrium-only.

`AppSection` is introduced here with `.atrium` and `.gazetteer`. `ConnectedVaultView` becomes a two-tab `TabView`, each tab owning an independent `NavigationStack`; Task 10 adds the third real tab.

- [ ] **Step 1: Write failing state-transition tests**

Cover 300 ms injected debounce, filter reset, repeated-tag serialization, append order, duplicate-page rejection by UUID, stale old-query page rejection, end-of-list detection, first-page vs next-page errors, retry, and retained filter state after navigation.

- [ ] **Step 2: Run tests and confirm failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Gazetteer
```

- [ ] **Step 3: Implement Gazetteer model**

Use the same injected sleeper/request-generation pattern as `SearchViewModel`. Reset offset to zero on any filter change. Accept a response only when both generation and requested offset still match. Deduplicate by stable UUID without reordering accepted entries.

- [ ] **Step 4: Implement mobile list and filters**

Use `.searchable`, a filter sheet with AND-selected tags, and a sort picker. Each row shows kind marker, title fallback, path, excerpt, tags, word count, and modified time using progressive disclosure. Trigger `loadNextPage()` from the final visible row.

- [ ] **Step 5: Introduce the two-tab shell and preserve state**

Own one `AtriumViewModel` and one `GazetteerViewModel` at their tab roots. Add independent navigation paths and tests proving tab switches preserve path, Gazetteer filters, and scroll identity. Make Atrium tag taps select Gazetteer and apply the chosen tag without recreating either model.

- [ ] **Step 6: Verify Gazetteer**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Gazetteer
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Simulator smoke: Atrium tag → Gazetteer, multi-tag filter → sort → paginate → Folio → tab switch/back with filter, position, and both navigation paths retained.

- [ ] **Step 7: Commit Gazetteer**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add mobile Gazetteer"
```

### Task 10: Constellation Graph and Accessible Node List

**Files:**
- Create: `Sources/ClepsydraCore/Constellation/ConstellationModel.swift`
- Create: `Sources/ClepsydraCore/Constellation/ConstellationLayout.swift`
- Create: `Sources/ClepsydraUI/Constellation/ConstellationView.swift`
- Create: `Sources/ClepsydraUI/Constellation/ConstellationCanvas.swift`
- Create: `Sources/ClepsydraUI/Constellation/ConstellationDetailsView.swift`
- Create: `Tests/ClepsydraCoreTests/ConstellationModelTests.swift`
- Create: `Tests/ClepsydraCoreTests/ConstellationLayoutTests.swift`
- Create: `Tests/ClepsydraUITests/ConstellationViewTests.swift`
- Modify: `Sources/ClepsydraUI/Shell/ConnectedVaultView.swift`
- Modify: `Sources/ClepsydraUI/Shell/AppSection.swift`

**Interfaces:**

```swift
public struct GraphPoint: Equatable, Sendable { public let x: Double; public let y: Double }
public struct PositionedGraph: Equatable, Sendable {
    public let graph: GraphResponse
    public let positions: [UUID: GraphPoint]
}

public enum GraphDepth: Int, CaseIterable, Sendable { case one = 1, two = 2 }
```

The default screen requires anchor selection through existing search. “All” is an explicit unbounded request. Anchored layout uses breadth-first concentric rings: anchor at center, each graph distance on the next ring, nodes sorted by degree descending then UUID for deterministic angular placement. Unreachable unanchored components and orphans occupy an outer band sorted by UUID.

- [ ] **Step 1: Write failing layout invariant tests**

Pin anchor-at-center, ring assignment by BFS distance, stable output independent of input ordering, viewport clamping, orphan outer-band placement, empty/single-node graphs, hub degree counts, and no NaN/infinite coordinates.

- [ ] **Step 2: Write failing Constellation state tests**

Cover anchor search/reference selection, depth requests, journal/orphan toggles, cancellation after filter change, unknown-anchor error, explicit all request, selected-node clearing after graph replacement, and layout cancellation when inactive.

- [ ] **Step 3: Run tests and confirm failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Constellation
```

- [ ] **Step 4: Implement deterministic linear-time layout**

Build adjacency and degree maps once. BFS is `O(V + E)`. Compute ring positions without iterative simulation, avoiding frame-by-frame CPU work and nondeterministic tests. Run layout in a cancellable task off the main actor; publish one `PositionedGraph` on completion.

- [ ] **Step 5: Implement Canvas rendering and gestures**

Draw edges first, then kind-coded node glyphs. Maintain zoom/pan transform in UI state. Convert tap coordinates through the inverse transform, select the nearest node within a Dynamic-Type-independent 44-point hit target, and expose Open Folio.

- [ ] **Step 6: Implement controls and accessible alternative**

Provide anchor search, depth 1/2, explicit All, journal/orphan toggles, hubs, orphan summary, legend, and a `List` of visible nodes sorted by title/path. VoiceOver exposes the list rather than requiring Canvas hit testing. Reduce Motion disables animated transform/layout transitions.

- [ ] **Step 7: Complete the three-tab shell**

Add `.constellation` to `AppSection`, add the real Constellation root with its own `NavigationStack`, and extend shell tests to prove all three paths survive tab switching. The shell reports selected section to the model. Leaving Constellation cancels pending fetch/layout tasks; returning reuses loaded graph unless filters changed.

- [ ] **Step 8: Verify Constellation**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Constellation
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Simulator smoke: select anchor → depth 1/2 → pan/zoom → node Folio → VoiceOver node list.

- [ ] **Step 9: Commit Constellation**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add mobile Constellation"
```

---

## Phase E — Peripheral Parity and Mutations

### Task 11: Atrium BCL, Sky, Reading Continues, and Open History

**Files:**
- Modify: `ios/Packages/ClepsydraMobileKit/Package.swift`
- Create: `Sources/ClepsydraCore/Atrium/SkyCalculator.swift`
- Modify: `Sources/ClepsydraCore/Atrium/AtriumModel.swift`
- Create: `Sources/ClepsydraUI/Atrium/SkyCardView.swift`
- Create: `Sources/ClepsydraUI/Atrium/BCLCardView.swift`
- Create: `Sources/ClepsydraUI/Atrium/ReadingContinuesView.swift`
- Create: `Sources/ClepsydraCore/Atrium/OpenHistory.swift`
- Create: `Sources/ClepsydraUI/Atrium/LocationEditorView.swift`
- Modify: `Sources/ClepsydraUI/Shell/ConnectedVaultView.swift`
- Create: `Tests/ClepsydraCoreTests/SkyCalculatorTests.swift`
- Modify: `Tests/ClepsydraCoreTests/AtriumModelTests.swift`
- Modify: `Tests/ClepsydraUITests/AtriumViewTests.swift`

**Interfaces:**
- Exact dependency: `https://github.com/Timac/SunCalc.git`, version `1.0.0`.
- `OpenHistory` is session-memory-only, deduplicated by UUID, newest first, maximum 50 entries.
- Reading base: `GET /api/vault/bases/reading/views/continues`.
- Progress mutation: `PATCH /api/vault/pages/by-id/{uuid}/properties` with current revision.
- Location search: `GET /api/vault/geocode?q={query}&limit=5`; save: `PUT /api/vault/location`.

- [ ] **Step 1: Write failing BCL, Sky, and history tests**

Pin BCL formatting before/after crossing; sunrise/sunset and moon phase against fixed London/date fixtures; no-location fallback; polar missing-rise/set handling; open-history deduplication/order/cap; server-change reset; geocode stale-response rejection; coordinate validation; and location update reconciliation.

- [ ] **Step 2: Write failing Reading Continues tests**

Decode flat `QueryOutput`, ignore grouped shapes, map `author/progress/pages`, hide `404` as unavailable, clamp progress to `0...pages`, patch with current revision, and adopt refreshed revision/projection.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SkyCalculatorTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter AtriumModelTests
```

- [ ] **Step 4: Pin SunCalc 1.0.0**

Add:

```swift
.package(url: "https://github.com/Timac/SunCalc.git", exact: "1.0.0")
```

and the `SunCalc` product only to `ClepsydraCore`. `ios/Packages/ClepsydraMobileKit` currently has no tracked `Package.resolved`; keep generated SwiftPM/Xcode resolution state ignored and commit only `Package.swift`.

- [ ] **Step 5: Implement pure Sky presentation data**

Wrap `SunCalc.getTimes`, `getSunPosition`, and `getMoonIllumination`. Match desktop moon phase buckets and fallback sun times. Keep formatting outside the third-party model so UI code never imports SunCalc.

- [ ] **Step 6: Add optional Atrium card loads**

Load BCL, location, and reading base independently. A `404` reading base hides that card; other failures show only that card's retry. Add Opened as the third recents mode backed by `OpenHistory`.

- [ ] **Step 7: Implement supporting cards and location editing**

Sky includes location label, sunrise/sunset, daylight progress, and moon phase. Its Edit action presents `LocationEditorView`, which performs explicit geocode search, lets the user select one candidate, and persists that candidate's coordinates/label. BCL renders only when configured. Reading Continues opens Folio by row UUID, fetches that page's current revision, and advances progress through the property patch contract. Record open history centrally whenever the shell pushes a Folio route.

- [ ] **Step 8: Verify optional cards**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Atrium
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SkyCalculator
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

- [ ] **Step 9: Commit Atrium parity**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): complete Atrium supporting cards"
```

### Task 12: UUID Assignment and Gazetteer Selection Mode

**Files:**
- Modify: `src/api/pages.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_test.rs`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/VaultAPI.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/APIClient.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/IndexModels.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Gazetteer/GazetteerModel.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Gazetteer/GazetteerView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Folio/FolioMetadataView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/APIClientTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/GazetteerModelTests.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/FolioViewTests.swift`

**Interfaces:**

`POST /api/vault/pages/assign`:

```json
{
  "page_ids": ["uuid"],
  "kind": "NOTE",
  "project": "project-slug",
  "clear_project": false
}
```

At least one of `kind`, `project`, or `clear_project=true` is required. `project` and `clear_project=true` are mutually exclusive; `kind` may be combined with either project operation so the UUID contract retains the existing assignment semantics. Response:

```json
{
  "updated": [{ "id": "uuid", "path": "notes/new-path.md" }],
  "failed": [{ "id": "uuid", "message": "reason" }]
}
```

- [ ] **Step 1: Write failing UUID assignment API tests**

Cover single and multiple IDs, moved canonical paths, combined kind/project mutation, mixed success/failure, missing UUID, empty mutation, invalid `project` plus `clear_project=true`, and preservation of the existing path-based desktop endpoint.

- [ ] **Step 2: Run backend tests and confirm route failure**

```bash
cargo test --test api_test assign_by_id
```

Expected: route returns `404` or `405`.

- [ ] **Step 3: Implement UUID resolution and reuse existing assignment logic**

Resolve each ID to its current indexed path immediately before mutation. Call the same lower-level assignment/move operation used by `assign_page`; do not duplicate projection or move rules. Serialize per-page mutation results so successful canonical paths are returned.

- [ ] **Step 4: Register OpenAPI and regenerate desktop types**

Add the path and schemas, pin them in `openapi.rs`, and run `bun run --cwd ui openapi`. Existing desktop clients remain on their current endpoints.

- [ ] **Step 5: Write failing Swift assignment tests**

Cover request encoding, response decoding, selection toggling, select-visible, clear selection, in-flight disablement, partial failures, successful path reconciliation, and keeping failed IDs selected.

- [ ] **Step 6: Implement Swift assignment contracts and selection mode**

Add `assignPages(_:)` to a narrow `PageAssignmentAPI`. Gazetteer enters explicit Edit/Select mode; normal row taps never toggle selection. After success, update affected in-memory entries by UUID and clear only successful IDs.

- [ ] **Step 7: Add Folio kind/project assignment**

Metadata controls call the same UUID assignment endpoint with one ID. On success, reload/accept the page by UUID so Folio adopts its canonical moved path.

- [ ] **Step 8: Verify assignment paths**

```bash
cargo test --test api_test assign_
cargo test api::openapi::tests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter Gazetteer
swift test --package-path ios/Packages/ClepsydraMobileKit --filter APIClientTests
bun run --cwd ui typecheck
```

- [ ] **Step 9: Commit UUID assignment**

```bash
git add src/api tests/api_test.rs ui/src/api/schema.d.ts ios/Packages/ClepsydraMobileKit
git commit -m "feat: add stable mobile page assignment"
```

---

## Phase F — Verification, Documentation, and Integration

### Task 13: Accessibility, Full Gates, Physical-Phone Smoke, and Merge

**Files:**
- Create: `docs/ios.md`
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: focused SwiftUI files only when the audit finds a reproducible accessibility defect
- Modify: focused tests only when required to defend the corrected observable contract

**Interfaces:**
- Documentation covers the complete mobile information architecture, server setup, Tailscale/HTTPS requirements, certificate renewal, XcodeGen, signing, view behavior, online-only limitation, and conflict recovery.

- [ ] **Step 1: Audit accessibility in the simulator**

Exercise every screen with XXXL Dynamic Type, VoiceOver, Reduce Motion, light/dark appearance, portrait, and landscape. Verify minimum touch targets, reading order, chart list alternative, non-color kind labels, sheet dismissal, keyboard focus, and error announcements. Fix only observed defects and rerun their exact flow.

- [ ] **Step 2: Run backend lint and tests**

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

Expected: all pass.

- [ ] **Step 3: Run desktop UI typecheck, lint, and tests**

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
```

Expected: all pass.

- [ ] **Step 4: Run extension typecheck, lint, and tests**

```bash
bun run --cwd extension typecheck
bun run --cwd extension lint
bun run --cwd extension test
```

Expected: all pass. Record any pre-existing failure separately; do not modify unrelated extension code to hide it.

- [ ] **Step 5: Run mobile tests and generic build**

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Expected: all pass with no Swift warnings introduced by this feature. The repository has no separate Swift lint configuration; Swift compilation plus repository linters are the available lint gates.

- [ ] **Step 6: Smoke-test the complete simulator path**

Run a Clepsydra server against a temporary representative vault and exercise:

1. Setup → Atrium.
2. Search → Folio → edit/save.
3. Atrium → unwritten today → first save.
4. Quick capture → refreshed Journal.
5. Gazetteer filters/sort/pagination → Folio → back.
6. Constellation anchor/depth → node Folio.
7. Gazetteer selection → partial assignment result.
8. Desktop edit after mobile open → mobile `409` with draft retained.

Capture exact observed failures; fix at source and repeat the failing flow.

- [ ] **Step 7: Smoke-test on a physical iPhone over Tailscale**

Use a valid MagicDNS HTTPS certificate and cellular data. Repeat the design's end-to-end flow and confirm the Mac vault reflects Journal capture, Folio edit, and assignment without stale overwrite.

- [ ] **Step 8: Write and link mobile documentation**

Create `docs/ios.md` with prerequisites, XcodeGen generation, signing/team selection, server URL setup, tailnet binding, certificate creation and 90-day renewal, reconnect behavior, the five mobile views, online-only behavior, assignment semantics, and conflict recovery. Link it from `README.md` and the TLS/mobile sections of `docs/configuration.md`.

- [ ] **Step 9: Re-run documentation-sensitive gates**

Run full Rust tests, full UI tests, full Swift tests, and generic iOS build again after final OpenAPI generation and documentation links.

- [ ] **Step 10: Request final code review**

Use the requesting-code-review skill. Reject findings that are speculative or outside the approved scope; fix every evidence-backed correctness, security, accessibility, or maintainability issue and rerun its affected gate.

- [ ] **Step 11: Commit release hardening and documentation**

```bash
git add docs/ios.md README.md docs/configuration.md
git commit -m "docs: complete iOS main views rollout"
```

If the accessibility or review steps changed code, commit each explicitly named source/test pair before the documentation commit. Never stage a source directory wholesale.

- [ ] **Step 12: Finish the development branch**

Use the finishing-a-development-branch skill. Merge the reviewed feature branch into `develop` only after all gates and physical-phone smoke checks pass.
