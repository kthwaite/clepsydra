# iPhone Vault Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native iPhone client that searches, reads, creates, previews, and conflict-safely edits the Mac-hosted Clepsydra vault over Tailscale.

**Architecture:** Clepsydra remains authoritative for the Markdown vault and SQLite search index. The backend adds exact-content revisions, UUID-addressed updates, and server-generated note creation; the existing React editor adopts the same revision contract. A native SwiftUI shell consumes a focused Swift package containing the HTTP client, feature models, and SwiftUI views, with HTTPS transport over Tailscale.

**Tech Stack:** Rust 2024, Axum 0.8, BLAKE3, React 19, TanStack Query, Swift 6.2, SwiftUI/Observation, URLSession, Textual 0.5.0, Xcode 26.2, XcodeGen 2.46.0, iOS 18.0+

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-03-ios-vault-client-design.md` as the acceptance contract.
- Keep the Mac-hosted server authoritative; do not add an offline vault replica or background sync.
- Route every file write through `MutationCoordinator`; the iOS app never touches vault files or SQLite.
- Use stable page UUIDs for mobile read/update identity and retain paths only as returned metadata.
- Require optimistic-concurrency revisions for every path-based and UUID-based page update; never provide force-save or automatic merge.
- Use HTTPS with normal certificate validation. Do not add an App Transport Security exception.
- Treat Tailscale membership plus a restrictive tailnet policy as the MVP access boundary; do not add application credentials.
- Pin Textual to 0.5.0 and set the mobile deployment target to iOS 18.0.
- Use XcodeGen 2.46.0 as the project-file source of truth; do not commit generated `.xcodeproj` state.
- Preserve the user's unrelated working-tree changes; stage and commit only files named by each task.

---

### Task 1: Exact Page Revisions

**Files:**
- Modify: `src/vault/page.rs:235-345`
- Modify: `src/vault/mutation_coordinator.rs:43-79,246-323,395-571`
- Modify: `src/api/pages.rs:31-110,200-226,313-515,690-824`
- Modify: `src/api/index_routes.rs:783-831`
- Modify: `src/api/journal.rs:130-180,250-280,390-421`
- Modify: `src/api/openapi.rs:90-112,190-225`
- Test: `src/vault/page.rs`
- Test: `tests/api_test.rs:128-235`

**Interfaces:**
- Produces: `pub fn page_revision(serialized: &str) -> String`.
- Produces: page-detail JSON field `revision: String`, defined as lowercase BLAKE3 hex of exact serialized file bytes.
- Produces: `MutationCoordinator::create_page` and `update_page` return `vault::page::Page`, including the exact `raw_content` written.
- Consumes: existing `Page::raw_content` and `write_page_content`.

- [ ] **Step 1: Add failing revision unit tests**

Add to `src/vault/page.rs`:

```rust
#[cfg(test)]
mod revision_tests {
    use super::page_revision;

    #[test]
    fn revision_is_stable_for_identical_serialized_content() {
        let content = "---\nid: 01900000-0000-7000-8000-000000000001\n---\nBody";
        assert_eq!(page_revision(content), page_revision(content));
        assert_eq!(page_revision(content).len(), 64);
    }

    #[test]
    fn revision_changes_when_any_serialized_byte_changes() {
        assert_ne!(page_revision("body\n"), page_revision("body"));
    }
}
```

- [ ] **Step 2: Run the unit tests and confirm the missing symbol failure**

Run: `cargo test revision_tests`

Expected: compilation fails because `page_revision` does not exist.

- [ ] **Step 3: Implement the revision primitive**

Add next to `write_page_content`:

```rust
/// Return the lowercase BLAKE3 digest of the exact serialized page bytes.
pub fn page_revision(serialized: &str) -> String {
    blake3::hash(serialized.as_bytes()).to_hex().to_string()
}
```

Run: `cargo test revision_tests`

Expected: both tests pass.

- [ ] **Step 4: Add a failing API response test**

Extend `page_detail_mapping_matches_get_for_every_page_endpoint` in `tests/api_test.rs`:

```rust
let revision = fetched["revision"].as_str().expect("page detail revision");
assert_eq!(revision.len(), 64);
assert_eq!(created["revision"], fetched["revision"]);
```

Run: `cargo test --test api_test page_detail_mapping_matches_get_for_every_page_endpoint`

Expected: failure because `revision` is absent.

- [ ] **Step 5: Return exact written content from mutations**

Replace `PageMutationResult` with the existing `Page` type. In each create/update closure, retain the `content` string after the atomic write and return:

```rust
Ok(Page {
    path: final_path,
    meta: command.meta,
    body: command.body,
    raw_content: content,
})
```

For create, use `path: command.path`. Delete the now-unused `PageMutationResult` declaration and import `Page` beside `PageMeta` and `write_page_content`.

- [ ] **Step 6: Make page detail consume a complete page**

Change the DTO and constructor in `src/api/pages.rs`:

```rust
pub struct PageDetail {
    pub path: String,
    pub canonical_name: String,
    pub meta: PageMeta,
    pub body: String,
    pub revision: String,
    pub kind: String,
    pub inferred: bool,
    pub project: Option<String>,
}

pub struct PageDetailResponse {
    pub path: String,
    pub canonical_name: String,
    pub meta: PageMetaResponse,
    pub body: String,
    pub revision: String,
    pub kind: String,
    pub inferred: bool,
    pub project: Option<String>,
}

pub(crate) fn page_detail(page: Page) -> PageDetail {
    let revision = crate::vault::page::page_revision(&page.raw_content);
    let canonical = page
        .meta
        .title
        .as_deref()
        .map(CanonicalName::from_title)
        .unwrap_or_else(|| CanonicalName::from_filename(page.path.filename()));
    let (kind, inferred) = crate::vault::kind::resolve(page.path.as_str(), page.meta.kind);
    let project = page.meta.project.clone();
    PageDetail {
        path: page.path.as_str().to_string(),
        canonical_name: canonical.as_str().to_string(),
        meta: page.meta,
        body: page.body,
        revision,
        kind: kind.as_str().to_string(),
        inferred,
        project,
    }
}
```

Retain the repository's exact `Kind` wire formatting when replacing the constructor body; do not change casing as part of this task.

- [ ] **Step 7: Migrate every page-detail producer**

Pass complete `Page` values in `pages.rs`, `journal.rs`, and `index_routes.rs`. For coordinator mutations, pass the returned `Page` directly. For `create_from_link`, stop cloning `vault_path`, `meta`, and `page_body`; retain the coordinator result and call `page_detail(result)`.

Run: `cargo test --test api_test page_detail_mapping_matches_get_for_every_page_endpoint`

Expected: pass, with equal revisions across create/get/update/move/assign responses.

- [ ] **Step 8: Pin the OpenAPI revision field**

Extend the OpenAPI test in `src/api/openapi.rs` to assert that `PageDetailResponse.required` contains `revision` and the property is a string. Run:

`cargo test api::openapi::tests`

Expected: pass.

- [ ] **Step 9: Run the focused backend suite**

Run:

```bash
cargo test revision_tests
cargo test --test api_test page_detail_mapping_matches_get_for_every_page_endpoint
cargo test api::openapi::tests
```

Expected: all focused tests pass.

- [ ] **Step 10: Commit exact revisions**

```bash
git add src/vault/page.rs src/vault/mutation_coordinator.rs src/api/pages.rs src/api/index_routes.rs src/api/journal.rs src/api/openapi.rs tests/api_test.rs
git commit -m "feat(api): expose exact page revisions"
```

---

### Task 2: Conflict-Safe Updates and Desktop Cutover

**Files:**
- Modify: `src/api/pages.rs:96-110,173-184,313-515`
- Modify: `src/api/error.rs:9-18,43-69`
- Modify: `src/api/openapi.rs:24-112,190-225`
- Modify: `tests/api_test.rs:156-235,1660-1700`
- Modify: `ui/src/api/schema.d.ts`
- Modify: `ui/src/editor/usePageEditor.ts:33-282`
- Modify: `ui/src/editor/__tests__/usePageEditor.test.tsx`

**Interfaces:**
- Produces: required `UpdatePageRequest.expected_revision: String` serialized as `expected_revision`.
- Produces: conflict detail `{ "code": "revision_conflict", "current_revision": "<64 hex>" }` with HTTP 409.
- Produces: serialized desktop autosaves; a later save waits for the current save and uses the returned revision.
- Consumes: `page_revision`, `Page.raw_content`, and coordinator stale-content protection from Task 1.

- [ ] **Step 1: Write stale-update integration tests**

Add to `tests/api_test.rs`:

```rust
#[tokio::test]
async fn page_update_rejects_stale_revision_without_changing_file() {
    let (server, _tmp) = setup_server();
    let created = server
        .post("/api/vault/pages/conflict.md")
        .json(&serde_json::json!({ "title": "Conflict", "body": "one" }))
        .await;
    created.assert_status(StatusCode::CREATED);
    let first: serde_json::Value = created.json();
    let revision = first["revision"].as_str().unwrap();

    let updated = server
        .put("/api/vault/pages/conflict.md")
        .json(&serde_json::json!({
            "body": "two",
            "expected_revision": revision
        }))
        .await;
    updated.assert_status_ok();

    let stale = server
        .put("/api/vault/pages/conflict.md")
        .json(&serde_json::json!({
            "body": "stale overwrite",
            "expected_revision": revision
        }))
        .await;
    stale.assert_status(StatusCode::CONFLICT);
    let error: serde_json::Value = stale.json();
    assert_eq!(error["detail"]["code"], "revision_conflict");
    assert_eq!(error["detail"]["current_revision"], updated.json::<serde_json::Value>()["revision"]);

    let current: serde_json::Value = server
        .get("/api/vault/pages/conflict.md")
        .await
        .json();
    assert_eq!(current["body"], "two");
}
```

Also add a test that omitting `expected_revision` yields `422 Unprocessable Entity`.

- [ ] **Step 2: Run the stale-update tests and confirm failure**

Run: `cargo test --test api_test page_update_rejects_stale_revision_without_changing_file`

Expected: stale update returns 200 because the request has no enforced revision yet.

- [ ] **Step 3: Require and validate revisions in the path update handler**

Add the required request field:

```rust
pub struct UpdatePageRequest {
    pub expected_revision: String,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub body: Option<String>,
}
```

After reading `Page`, compare `page_revision(&page.raw_content)` with `body.expected_revision`. Return:

```rust
fn revision_conflict(current_revision: String) -> ApiError {
    ApiError::conflict_with_detail(
        "page changed since it was loaded",
        serde_json::json!({
            "code": "revision_conflict",
            "current_revision": current_revision,
        }),
    )
}
```

Pass `page.raw_content` as `UpdatePageCommand.expected_content`. If the coordinator returns `MutationError::Stale`, re-read the current file, calculate its revision, and return the same structured conflict. Map all other mutation errors through `super::mutation_error`.

- [ ] **Step 4: Update existing API tests to send revisions**

Every existing `PUT /api/vault/pages/{path}` test must first use the revision returned by create/get and add `expected_revision` to its JSON. Do not weaken the required-field contract to preserve old tests.

Run:

```bash
cargo test --test api_test page_update_rejects_stale_revision_without_changing_file
cargo test --test api_test page_detail_mapping_matches_get_for_every_page_endpoint
```

Expected: both pass.

- [ ] **Step 5: Add failing desktop save-serialization tests**

Update `makePage` in `ui/src/editor/__tests__/usePageEditor.test.tsx` to include `revision: "rev-a"`. Add a test where:

```typescript
it("serializes overlapping saves and advances the expected revision", async () => {
  const pending: Array<{
    request: { body: Record<string, unknown> };
    resolve: (page: ReturnType<typeof makePage>) => void;
  }> = [];

  const mutateAsync = vi.fn((request) =>
    new Promise<ReturnType<typeof makePage>>((resolve) => {
      pending.push({ request, resolve });
    }),
  );
  useUpdatePageMock.mockReturnValue({ mutateAsync });

  const { result } = renderHook(() => usePageEditor("notes/page.md"));
  act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
  act(() => vi.advanceTimersByTime(1500));
  expect(pending).toHaveLength(1);
  expect(pending[0].request.body.expected_revision).toBe("rev-a");

  act(() => result.current.onSlateChange(paragraph("C"), astChangeEditor()));
  act(() => result.current.saveNow());
  expect(pending).toHaveLength(1);

  await act(async () => {
    pending[0].resolve({ ...makePage("B"), revision: "rev-b" });
    await Promise.resolve();
  });

  expect(pending).toHaveLength(2);
  expect(pending[1].request.body.expected_revision).toBe("rev-b");
});
```

Add a second test where `mutateAsync` rejects with a 409-shaped error and assert that no automatic retry occurs and `saveStatus` becomes `error`.

- [ ] **Step 6: Run the desktop tests and confirm failure**

Run: `bun run test -- src/editor/__tests__/usePageEditor.test.tsx` from `ui/`.

Expected: failure because saves still use callback `mutate`, omit revisions, and may overlap.

- [ ] **Step 7: Serialize desktop saves**

Refactor `usePageEditor` to use stable `mutateAsync`, a `revisionRef`, `savingRef`, and `saveRequestedRef`:

```typescript
const revisionRef = useRef("");
const savingRef = useRef(false);
const saveRequestedRef = useRef(false);
```

When clean server data is accepted, set `revisionRef.current = page.revision`. A save request while `savingRef.current` is true sets `saveRequestedRef.current = true` and returns. Each request sends:

```typescript
body: {
  expected_revision: revisionRef.current,
  ...(titleChanged ? { title: currentTitle || null } : {}),
  ...(tagsChanged ? { tags: currentTags } : {}),
  ...(aliasesChanged ? { aliases: currentAliases } : {}),
  ...(bodyChanged ? { body } : {}),
}
```

On success, adopt `response.revision`, advance only the generation watermarks captured by that save, then drain one queued save against the new revision. On error, stop the queue, preserve dirty generations and editor content, and expose the error. Keep the existing debounce, no-op reconciliation, visibility flush, and unmount flush behavior.

- [ ] **Step 8: Regenerate the TypeScript OpenAPI client**

Start Clepsydra against a temporary initialized vault on port 3000, then run `bun run openapi` from `ui/`. Confirm `PageDetailResponse.revision` and `UpdatePageRequest.expected_revision` are required in `ui/src/api/schema.d.ts`.

Run:

```bash
bun run typecheck
bun run test -- src/editor/__tests__/usePageEditor.test.tsx
```

Expected: typecheck and focused tests pass.

- [ ] **Step 9: Run backend and desktop focused verification**

Run:

```bash
cargo test --test api_test page_update
cargo test api::openapi::tests
```

From `ui/` run:

```bash
bun run typecheck
bun run lint
bun run test -- src/editor/__tests__/usePageEditor.test.tsx
```

Expected: all commands exit 0; the UI lint may continue to print the existing Biome schema-version informational notice.

- [ ] **Step 10: Commit conflict-safe updates**

```bash
git add src/api/pages.rs src/api/error.rs src/api/openapi.rs tests/api_test.rs ui/src/api/schema.d.ts ui/src/editor/usePageEditor.ts ui/src/editor/__tests__/usePageEditor.test.tsx
git commit -m "feat(api): reject stale page updates"
```

---

### Task 3: UUID Update and Server-Generated Creation

**Files:**
- Modify: `src/api/pages.rs:96-184,300-515`
- Modify: `src/api/openapi.rs:24-112,190-225`
- Modify: `src/vault/new_note.rs:106-190`
- Modify: `tests/api_test.rs:128-360`
- Modify: `ui/src/api/schema.d.ts`

**Interfaces:**
- Produces: `PUT /api/vault/pages/by-id/{uuid}` with `UpdatePageRequest` and the same revision contract as path updates.
- Produces: `POST /api/vault/pages` with `{ title: String, body?: String }` and a `201 PageDetailResponse`.
- Produces: `pub(crate) fn build_note_path(&Vault, &str, DateTime<Utc>) -> Result<VaultPath, NewNoteError>` for shared canonical path generation.
- Consumes: `state.clock.now()`, `MutationCoordinator`, `page_detail(Page)`, and Task 2's update helper.

- [ ] **Step 1: Add failing API tests for UUID updates**

Create a note, capture its UUID and revision, move it, then call:

```rust
let response = server
    .put(&format!("/api/vault/pages/by-id/{id}"))
    .json(&serde_json::json!({
        "body": "updated after move",
        "expected_revision": revision
    }))
    .await;
response.assert_status_ok();
let updated: serde_json::Value = response.json();
assert_eq!(updated["path"], "moved/by-id.md");
assert_eq!(updated["body"], "updated after move");
```

Add a missing UUID case expecting 404 and a stale revision case expecting the same structured 409 as the path endpoint.

- [ ] **Step 2: Add failing server-generated creation tests**

Use `ApiFixture`'s fixed clock and call:

```rust
let response = server
    .post("/api/vault/pages")
    .json(&serde_json::json!({
        "title": "Mobile Note",
        "body": "Created on iPhone"
    }))
    .await;
response.assert_status(StatusCode::CREATED);
let created: serde_json::Value = response.json();
assert_eq!(created["meta"]["title"], "Mobile Note");
assert_eq!(created["body"], "Created on iPhone");
assert_eq!(created["revision"].as_str().unwrap().len(), 64);
assert!(created["path"].as_str().unwrap().starts_with("notes/"));
assert!(clepsydra::vault::path::is_canonical_page_filename(
    created["path"].as_str().unwrap().rsplit('/').next().unwrap()
));
```

Add blank and whitespace-only title cases expecting 400 and no new Markdown file.

- [ ] **Step 3: Run new endpoint tests and confirm route failures**

Run:

```bash
cargo test --test api_test page_update_by_id
cargo test --test api_test create_default_page
```

Expected: 405 or 404 because neither operation exists.

- [ ] **Step 4: Extract canonical path generation without duplicating policy**

Change `build_note_path` in `src/vault/new_note.rs` to `pub(crate)` and keep `create_new_note_in_vault` as its caller. Do not reproduce filename or default-folder logic in `pages.rs`.

- [ ] **Step 5: Factor one shared update implementation**

Extract the current path update body into:

```rust
async fn update_page_at_path(
    state: Arc<AppState>,
    vault_path: VaultPath,
    body: UpdatePageRequest,
) -> Result<Json<PageDetail>, ApiError>
```

The path handler validates its request path and delegates. The UUID handler resolves the indexed path with the existing by-ID query, parses it as an internal path, and delegates. Both endpoints therefore share revision comparison, mutation, race handling, and response mapping.

Register:

```rust
.route(
    "/by-id/{uuid}",
    get(get_page_by_id).put(update_page_by_id),
)
```

- [ ] **Step 6: Implement collection creation**

Add:

```rust
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateDefaultPageRequest {
    pub title: String,
    pub body: Option<String>,
}
```

Trim and reject an empty title. Capture one `created = state.clock.now()`, set both page timestamps to it, generate the path with `build_note_path`, then call `MutationCoordinator::create_page`. Register it with `.route("/", get(list_pages).post(create_default_page))`.

- [ ] **Step 7: Add OpenAPI operations and regenerate schema**

Add both handlers and `CreateDefaultPageRequest` to `ApiDoc`. Assert that `/api/vault/pages` contains GET and POST and `/api/vault/pages/by-id/{uuid}` contains GET and PUT. Regenerate `ui/src/api/schema.d.ts` from the running server.

- [ ] **Step 8: Run focused endpoint verification**

Run:

```bash
cargo test --test api_test page_update_by_id
cargo test --test api_test create_default_page
cargo test api::openapi::tests
cargo test vault::new_note::tests
```

Expected: all pass.

- [ ] **Step 9: Commit mobile API operations**

```bash
git add src/api/pages.rs src/api/openapi.rs src/vault/new_note.rs tests/api_test.rs ui/src/api/schema.d.ts
git commit -m "feat(api): add mobile page operations"
```

---

### Task 4: iOS Project and Core Wire Models

**Files:**
- Modify: `.gitignore`
- Create: `ios/project.yml`
- Create: `ios/ClepsydraMobile/ClepsydraMobileApp.swift`
- Create: `ios/ClepsydraMobile/Assets.xcassets/Contents.json`
- Create: `ios/ClepsydraMobile/Assets.xcassets/AccentColor.colorset/Contents.json`
- Create: `ios/Packages/ClepsydraMobileKit/Package.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/PageDetail.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Models/SearchResult.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/VaultAPI.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/AppRootView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/WireModelTests.swift`

**Interfaces:**
- Produces: Swift package products `ClepsydraCore` and `ClepsydraUI`.
- Produces: `PageDetail`, `PageMeta`, `SearchResult`, `CreatePageRequest`, and `UpdatePageRequest` as `Codable`, `Equatable`, and `Sendable` values.
- Produces: async `VaultAPI` protocol used by all feature models.
- Consumes: Task 3's OpenAPI wire names.

- [ ] **Step 1: Install and verify the pinned project generator**

Install XcodeGen 2.46.0 through Homebrew if it is absent, then run `xcodegen --version` and require output `Version: 2.46.0`.

- [ ] **Step 2: Write the package manifest and failing decode test**

Use this package shape:

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "ClepsydraMobileKit",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "ClepsydraCore", targets: ["ClepsydraCore"]),
    .library(name: "ClepsydraUI", targets: ["ClepsydraUI"]),
  ],
  dependencies: [
    .package(url: "https://github.com/gonzalezreal/textual", exact: "0.5.0"),
  ],
  targets: [
    .target(name: "ClepsydraCore"),
    .target(
      name: "ClepsydraUI",
      dependencies: [
        "ClepsydraCore",
        .product(name: "Textual", package: "textual"),
      ]
    ),
    .testTarget(name: "ClepsydraCoreTests", dependencies: ["ClepsydraCore"]),
    .testTarget(name: "ClepsydraUITests", dependencies: ["ClepsydraUI"]),
  ]
)
```

In `WireModelTests`, decode a complete page-detail fixture containing `canonical_name`, `page_id`, ISO-8601 timestamps, optional project, and a 64-character revision. Assert every field, including `UUID` and revision.

- [ ] **Step 3: Run the package test and confirm missing model failures**

Run: `swift test --package-path ios/Packages/ClepsydraMobileKit --filter WireModelTests`

Expected: compilation fails because the wire models do not exist.

- [ ] **Step 4: Implement exact wire models**

Define:

```swift
public struct PageMeta: Codable, Equatable, Sendable {
  public let id: UUID
  public let title: String?
  public let tags: [String]
  public let aliases: [String]
  public let createdAt: Date?
  public let updatedAt: Date?
}

public struct PageDetail: Codable, Equatable, Sendable, Identifiable {
  public var id: UUID { meta.id }
  public let path: String
  public let canonicalName: String
  public let meta: PageMeta
  public let body: String
  public let revision: String
  public let kind: String
  public let inferred: Bool
  public let project: String?
}

public struct SearchResult: Codable, Equatable, Sendable, Identifiable {
  public var id: UUID { pageID }
  public let pageID: UUID
  public let path: String
  public let title: String?
  public let snippet: String
}

public struct CreatePageRequest: Codable, Equatable, Sendable {
  public let title: String
  public let body: String?
}

public struct UpdatePageRequest: Codable, Equatable, Sendable {
  public let expectedRevision: String
  public let title: String?
  public let body: String?
}
```

Use JSON encoder/decoder key strategies `.convertToSnakeCase` and `.convertFromSnakeCase` and ISO-8601 dates in the API layer rather than handwritten coding keys.

- [ ] **Step 5: Define the API boundary**

```swift
public protocol VaultAPI: Sendable {
  func uptime() async throws
  func search(query: String, limit: Int) async throws -> [SearchResult]
  func page(id: UUID) async throws -> PageDetail
  func createPage(_ request: CreatePageRequest) async throws -> PageDetail
  func updatePage(id: UUID, request: UpdatePageRequest) async throws -> PageDetail
}
```

No view imports URLSession or concrete transport types.

- [ ] **Step 6: Create the generated Xcode project definition**

`ios/project.yml` defines one iPhone application target, deployment target 18.0, Swift 6.0 language mode, automatic Info.plist generation, portrait and landscape phone support, and a local `ClepsydraMobileKit` package dependency whose product is `ClepsydraUI`. The app entry point imports `ClepsydraUI` and presents `AppRootView()`.

Add `ios/ClepsydraMobile.xcodeproj/` to `.gitignore`, then run:

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Expected: the package resolves and the minimal root view builds.

- [ ] **Step 7: Run package tests**

Run: `swift test --package-path ios/Packages/ClepsydraMobileKit`

Expected: `WireModelTests` passes.

- [ ] **Step 8: Commit the iOS foundation**

```bash
git add .gitignore ios/project.yml ios/ClepsydraMobile ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add mobile project foundation"
```

---

### Task 5: HTTPS API Client and Error Mapping

**Files:**
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/ServerURL.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/APIClient.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/API/VaultAPIError.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/ServerURLTests.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/APIClientTests.swift`

**Interfaces:**
- Produces: `ServerURL`, which accepts only absolute HTTPS URLs without credentials, query, or fragment and removes only trailing path slashes.
- Produces: `APIClient: VaultAPI` with injected async `HTTPTransport` for deterministic tests.
- Produces: typed `VaultAPIError.revisionConflict(currentRevision:)` and transport categories for unreachable host, TLS trust/handshake failure, and timeout.
- Consumes: Task 4 wire models.

- [ ] **Step 1: Write server URL tests**

Cover these exact inputs:

```swift
XCTAssertEqual(
  try ServerURL(" https://clepsydra.tail-example.ts.net:16667/ ").url.absoluteString,
  "https://clepsydra.tail-example.ts.net:16667"
)
XCTAssertThrowsError(try ServerURL("http://clepsydra.tail-example.ts.net:16667"))
XCTAssertThrowsError(try ServerURL("https://user:pass@clepsydra.tail-example.ts.net"))
XCTAssertThrowsError(try ServerURL("https://clepsydra.tail-example.ts.net?x=1"))
```

The initializer must preserve the caller's HTTPS host and port rather than rewriting them.

- [ ] **Step 2: Write transport-level API client tests**

Use an injected closure:

```swift
public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
```

Assert:

1. search percent-encodes the query and sends limit 20;
2. page read uses `/api/vault/pages/by-id/{uuid}`;
3. create uses POST `/api/vault/pages` with snake-case JSON;
4. update uses PUT `/api/vault/pages/by-id/{uuid}` and encodes `expected_revision`;
5. uptime accepts any 2xx response;
6. a 409 payload with revision detail maps to `.revisionConflict(currentRevision:)`;
7. 404 and 500 map to `.server(status:message:)`;
8. malformed success JSON maps to `.decoding` without losing the underlying operation name;
9. `URLError.cannotConnectToHost`, `.secureConnectionFailed`, `.serverCertificateUntrusted`, and `.timedOut` map to distinct user-presentable transport cases.

- [ ] **Step 3: Run tests and confirm missing client failures**

Run:

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter ServerURLTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter APIClientTests
```

Expected: compilation fails because `ServerURL` and `APIClient` do not exist.

- [ ] **Step 4: Implement ServerURL**

Normalize whitespace and trailing slash with `URLComponents`. Require `scheme == "https"`, a non-empty host, no user/password/query/fragment, and either an empty path or `/`. Reject a base URL containing an API subpath so endpoint construction cannot duplicate `/api/vault`.

- [ ] **Step 5: Implement APIClient**

Use a value type:

```swift
public struct APIClient: VaultAPI, Sendable {
  private let server: ServerURL
  private let transport: HTTPTransport
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder
}
```

The production initializer captures `URLSession.shared.data(for:)`. Set a finite request timeout on each `URLRequest`. Build endpoints from the normalized base URL, set `Accept: application/json`, set `Content-Type` only for JSON bodies, and accept only 200-299 statuses. Map `URLError` codes into `.unreachable`, `.tls`, `.timedOut`, or `.other(String)` without exposing certificate bypass controls.

Decode errors through:

```swift
private struct ErrorEnvelope: Decodable {
  struct Detail: Decodable {
    let code: String?
    let currentRevision: String?
  }
  let error: String
  let detail: Detail?
}
```

Map only `code == "revision_conflict"` with a present revision to the typed conflict case. Preserve distinct unreachable, TLS, timeout, HTTP validation, not-found, conflict, and decoding cases for user-visible copy. Never disable trust evaluation or create a custom URLSession delegate.

- [ ] **Step 6: Run client tests**

Run: `swift test --package-path ios/Packages/ClepsydraMobileKit --filter APIClientTests`

Expected: all client tests pass.

- [ ] **Step 7: Build the iOS target**

Run:

```bash
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Expected: build succeeds with ordinary ATS defaults.

- [ ] **Step 8: Commit the API client**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add vault API client"
```

---

### Task 6: Server Setup and Vault Session

**Files:**
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Session/VaultSession.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Session/ServerAddressStore.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Setup/ServerSetupView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/AppRootView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/VaultSessionTests.swift`

**Interfaces:**
- Produces: `@MainActor @Observable public final class VaultSession` with disconnected, connecting, connected, and failed states.
- Produces: `ServerAddressStore` backed by a single `UserDefaults` string key.
- Produces: first-launch setup UI that validates uptime before persisting.
- Consumes: `ServerURL`, `APIClient`, and `VaultAPI.uptime()`.

- [ ] **Step 1: Write failing session-state tests**

Inject a store and API factory. Cover:

- valid saved URL starts a connection check;
- successful uptime transitions to connected and persists the normalized URL;
- failed uptime retains the entered value and exposes a retryable message;
- unreachable, TLS/certificate, timeout, and malformed-address failures produce distinct messages;
- changing servers clears the current API before reconnecting;
- invalid HTTP or malformed URLs never call the API factory.

Use an in-memory test store; do not touch process-global defaults in tests.

- [ ] **Step 2: Run the tests and confirm missing session failures**

Run: `swift test --package-path ios/Packages/ClepsydraMobileKit --filter VaultSessionTests`

Expected: compilation fails because `VaultSession` does not exist.

- [ ] **Step 3: Implement session and persistence boundaries**

Define:

```swift
@MainActor
public protocol ServerAddressStoring: AnyObject {
  var serverAddress: String? { get set }
}

@MainActor @Observable
public final class VaultSession {
  public enum State {
    case disconnected
    case connecting
    case connected(any VaultAPI)
    case failed(String)
  }

  public private(set) var state: State = .disconnected
  public var addressInput: String = ""
  public func connect() async
  public func disconnect()
}
```

`connect()` validates `ServerURL`, calls uptime, and only then persists the normalized URL. `disconnect()` clears in-memory vault state but retains the saved address so retry is immediate.

- [ ] **Step 4: Implement setup UI**

`ServerSetupView` contains one URL text field, Connect button, progress state, and concise category-specific errors for malformed address, unreachable server, TLS/certificate failure, and timeout. Configure URL keyboard/content traits and disable autocorrection/capitalization. Do not request credentials, a vault path, or Tailscale API access.

`AppRootView` owns one `VaultSession` and switches between setup and the connected search shell without duplicating session state in views.

- [ ] **Step 5: Run session and package tests**

Run: `swift test --package-path ios/Packages/ClepsydraMobileKit`

Expected: all tests pass.

- [ ] **Step 6: Build the app shell**

Run the XcodeGen and generic iOS build commands from Task 5.

Expected: build succeeds.

- [ ] **Step 7: Commit connection setup**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add vault connection setup"
```

---

### Task 7: Search Experience

**Files:**
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Search/SearchModel.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Search/SearchSnippet.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchResultRow.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/AppRootView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/SearchModelTests.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/SearchSnippetTests.swift`

**Interfaces:**
- Produces: `@MainActor @Observable SearchModel` with idle, loading, loaded, and failed phases.
- Produces: fixed-marker snippet parser returning literal/highlight segments.
- Produces: `SearchView` callbacks `openPage(UUID)` and `createPage()`.
- Consumes: connected `VaultAPI.search`.

- [ ] **Step 1: Write snippet parser tests**

Test:

```swift
XCTAssertEqual(
  SearchSnippet.parse("before <mark>match</mark> after"),
  [
    .init(text: "before ", highlighted: false),
    .init(text: "match", highlighted: true),
    .init(text: " after", highlighted: false),
  ]
)
XCTAssertEqual(
  SearchSnippet.parse("<script>alert(1)</script>"),
  [.init(text: "<script>alert(1)</script>", highlighted: false)]
)
```

Also cover unmatched `<mark>` and `</mark>` as literal text.

- [ ] **Step 2: Write search cancellation tests**

Use a controllable mock `VaultAPI`. Set query to `first`, advance the injected debounce clock by 250 ms, then set `second`. Complete `second` before `first` and assert only second results are displayed. Cover empty/whitespace query returning to idle without an API call and API failure preserving the current query with Retry available.

- [ ] **Step 3: Run tests and confirm failures**

Run:

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SearchSnippetTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SearchModelTests
```

Expected: compilation fails because search types do not exist.

- [ ] **Step 4: Implement deterministic search state**

`SearchModel.updateQuery(_:)` cancels the previous `Task`, trims only for the empty check, sleeps 250 ms through an injected async sleeper, calls `api.search(query:limit: 20)`, and checks cancellation before assigning results. `retry()` repeats the current non-empty query immediately.

- [ ] **Step 5: Implement safe snippet rendering**

Parse only exact `<mark>` and `</mark>` tokens. Build a SwiftUI `Text` by concatenating segments and applying accent/background styling to highlighted segments. Do not pass snippets to an HTML or Markdown renderer.

- [ ] **Step 6: Build SearchView**

Use `.searchable`, explicit loading/error/empty states, title fallback to path, and a toolbar New Note action. Selecting a result invokes `openPage(result.pageID)`. An empty query displays a short search instruction and does not fetch the vault listing.

- [ ] **Step 7: Run tests and generic app build**

Run:

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Expected: tests and build pass.

- [ ] **Step 8: Commit search**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add vault search"
```

---

### Task 8: Note Reader and Markdown Preview

**Files:**
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Reader/ReaderModel.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Reader/NoteReaderView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Markdown/MarkdownPreview.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/ReaderModelTests.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraUITests/MarkdownPreviewTests.swift`

**Interfaces:**
- Produces: `ReaderModel(pageID:api:)` with retryable loading and `accept(_:)` for editor responses.
- Produces: `MarkdownPreview(markdown:)` backed by Textual `StructuredText`.
- Consumes: `VaultAPI.page(id:)`, `PageDetail`, and search navigation.

- [ ] **Step 1: Write reader model tests**

Assert initial idle state, successful load retaining UUID/path/body/revision, retry after failure, and `accept(updatedPage)` replacing the entire loaded value including a changed path and revision.

- [ ] **Step 2: Write the representative Markdown render test**

Create a fixture containing headings, emphasis, strong text, unordered and ordered lists, task markers, block quote, fenced and inline code, link, rule, table, strikethrough, and `[[Wiki Target]]`. On `@MainActor`, construct `MarkdownPreview`, render it with `ImageRenderer` at a fixed 390-point width, and assert a non-nil image with non-zero size. This is a wrapper integration test, not a test of Textual internals.

- [ ] **Step 3: Run tests and confirm missing reader failures**

Run:

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit --filter ReaderModelTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter MarkdownPreviewTests
```

Expected: compilation fails because reader and preview types do not exist.

- [ ] **Step 4: Implement ReaderModel**

Use explicit idle/loading/loaded/failed state. Guard against duplicate loads, keep page identity fixed, and assign results only when the loading task is not cancelled.

- [ ] **Step 5: Implement MarkdownPreview**

Use:

```swift
import Textual

public struct MarkdownPreview: View {
  public let markdown: String

  public var body: some View {
    StructuredText(markdown: markdown)
      .textual.structuredTextStyle(.default)
      .textual.textSelection(.enabled)
  }
}
```

Wrap in a vertical scroll view in `NoteReaderView`, not inside the reusable preview. Allow Textual/system handling for ordinary HTTPS links. Wikilinks remain literal rendered text because the current page-detail API does not provide an unambiguous target.

- [ ] **Step 6: Implement NoteReaderView and navigation**

Show title fallback, path, loading/error states, rendered body, and an Edit toolbar action. Search navigation creates one reader model for the selected UUID. Do not fetch by path.

- [ ] **Step 7: Run package tests and app build**

Use the full Swift package test and generic iOS build commands from Task 7.

Expected: pass.

- [ ] **Step 8: Commit reading and preview**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add note reading and preview"
```

---

### Task 9: Create, Edit, Save, and Resolve Conflicts

**Files:**
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Editor/EditorModel.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Editor/NoteEditorView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Reader/NoteReaderView.swift`
- Modify: `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchView.swift`
- Create: `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/EditorModelTests.swift`

**Interfaces:**
- Produces: `EditorModel.Mode.create` and `.edit(PageDetail)`.
- Produces: explicit edit/preview presentation mode, explicit save, discard confirmation, and conflict state.
- Produces: callback carrying the server-returned `PageDetail` after create/update.
- Consumes: `VaultAPI.createPage`, `VaultAPI.updatePage`, `VaultAPI.page`, and `VaultAPIError.revisionConflict`.

- [ ] **Step 1: Write create-flow tests**

Assert:

1. blank/whitespace title fails locally without an API call;
2. create sends trimmed title and the exact Markdown body;
3. successful create emits the returned UUID/path/revision;
4. transport/server failure preserves title and body;
5. preview mode reads current in-memory body and makes no API call.

- [ ] **Step 2: Write update and conflict tests**

Assert:

1. update sends the original page UUID and original revision;
2. successful update adopts the returned revision/path/body;
3. 409 transitions to conflict while preserving the draft;
4. dismissing with Keep Draft makes no request and keeps content;
5. Reload fetches the current page and replaces draft only after the caller confirms discard;
6. no force-save or retry occurs automatically;
7. 404 preserves the draft and reports deletion.

- [ ] **Step 3: Run editor tests and confirm missing model failures**

Run: `swift test --package-path ios/Packages/ClepsydraMobileKit --filter EditorModelTests`

Expected: compilation fails because `EditorModel` does not exist.

- [ ] **Step 4: Implement EditorModel**

Use `@MainActor @Observable` state with title, body, edit/preview mode, idle/saving/failed/conflict phase, and immutable source UUID/revision for each attempted edit. Validate title before saving. Save create/update exactly once, disable concurrent saves, and replace source state only from successful server responses.

On `.revisionConflict(currentRevision:)`, retain all draft fields. `reloadFromServer()` fetches by UUID and replaces the draft; it never sends the stale draft. `keepDraft()` only dismisses conflict presentation.

- [ ] **Step 5: Implement NoteEditorView**

Use a segmented Edit/Preview picker. Edit presents a title field and plain multiline monospaced `TextEditor`; Preview presents `MarkdownPreview` with the in-memory body. Toolbar actions are Cancel and Save. Save is disabled while saving or when the title trims empty. Cancel with dirty fields presents a confirmation dialog before dismissal.

Conflict copy must provide exactly two actions:

- Reload Server Version
- Keep Draft

There is no overwrite button.

- [ ] **Step 6: Wire edit and create navigation**

Reader edit presents an editor initialized from the loaded `PageDetail`; successful save calls `ReaderModel.accept`. Search New Note presents create mode; successful creation dismisses the editor and navigates to the returned page UUID.

- [ ] **Step 7: Run all mobile tests and build**

Run:

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Expected: all tests and build pass.

- [ ] **Step 8: Commit mobile writes**

```bash
git add ios/Packages/ClepsydraMobileKit
git commit -m "feat(ios): add conflict-safe note editing"
```

---

### Task 10: End-to-End Tailscale Verification and Operational Setup

**Files:**
- Create: `docs/ios.md`
- Modify: `README.md:5-16`
- Modify: `docs/configuration.md`

**Interfaces:**
- Produces: reproducible Mac/Tailscale/iPhone setup and certificate-renewal instructions.
- Produces: physical-device evidence for search, read, update conflict, and creation.
- Consumes: completed backend and iOS application.

- [ ] **Step 1: Run all automated verification gates before operational documentation**

Run from repository root:

```bash
cargo check --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

Run from `ui/`:

```bash
bun run typecheck
bun run lint
bun run test
```

Run from `extension/`:

```bash
bun run typecheck
bun run lint
bun run test
```

Run mobile verification:

```bash
swift test --package-path ios/Packages/ClepsydraMobileKit
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Expected: all changed-project gates pass. If the extension lint still reports the pre-existing non-null assertions/import ordering seen before implementation, record it separately and do not modify unrelated extension files in this feature.

- [ ] **Step 2: Configure a tailnet-only HTTPS endpoint**

On the Mac, obtain the stable Tailscale IPv4 address and fully qualified DNS name, enable MagicDNS and HTTPS certificates in the tailnet, then generate explicit files:

```bash
tailscale ip -4
tailscale status --json
tailscale cert --cert-file=clepsydra.crt --key-file=clepsydra.key clepsydra.tail-example.ts.net
```

Configure Clepsydra's `server.host` to the address returned by `tailscale ip -4`, keep port 16667, enable TLS, and point `cert_path`/`key_path` at the generated files. Start `clep serve` and confirm the uptime endpoint succeeds through the fully qualified HTTPS URL from another tailnet node.

- [ ] **Step 3: Apply and verify a restrictive Tailscale policy**

Restrict TCP 16667 on the Clepsydra Mac to the intended user/device group. Confirm the iPhone can connect and a non-authorized tailnet identity cannot. Do not bind Clepsydra to `0.0.0.0` and do not add router authentication as a substitute for the tailnet restriction.

- [ ] **Step 4: Run the physical-iPhone smoke scenario**

With the iPhone on cellular data and Tailscale connected:

1. connect the app to the MagicDNS HTTPS URL;
2. search for a body token known to exist and open the result;
3. edit and save the note, then verify the exact Markdown change on the Mac;
4. open a note on the phone, edit that file on the Mac, then save on the phone and verify a conflict appears while the Mac edit remains unchanged;
5. keep the phone draft, reload the server version, reconcile manually, and save against the new revision;
6. create a note on the phone and verify its canonical filename, Markdown contents, and searchability on the Mac.

Record exact observed results in the implementation-session handoff; do not claim physical-device completion from simulator or unit-test evidence.

- [ ] **Step 5: Write the operational guide after the smoke scenario works**

`docs/ios.md` must document prerequisites, XcodeGen generation, signing/team selection, app setup, tailnet binding, certificate generation, the 90-day certificate lifetime, renewal with the same `--cert-file`/`--key-file` paths, server restart after renewal, ACL verification, and troubleshooting for unreachable server, expired certificate, and conflict responses. Link it from `README.md` and the TLS section of `docs/configuration.md`.

- [ ] **Step 6: Re-run documentation-sensitive checks**

Run `cargo test --all-features`, the full UI tests, the full Swift package tests, and the generic iOS build once more after documentation links and project generation are final.

Expected: the same results as Step 1.

- [ ] **Step 7: Commit operational setup**

```bash
git add docs/ios.md docs/configuration.md README.md
git commit -m "docs: add iPhone Tailscale setup"
```

- [ ] **Step 8: Review task-by-task commits and integrate**

Use the project's feature workflow: request code review for each task boundary, address only verified findings, re-run the full gates, then merge the feature worktree into the project's integration branch. Preserve the ten focused commits unless a reviewer identifies a concrete atomicity problem.
