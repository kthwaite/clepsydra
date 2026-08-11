# Reference Repair Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one repair workspace that inventories link/reference integrity issues, navigates to source context, and applies safe individual fixes through previewed, stale-protected mutations.

**Architecture:** A vault-level `reference_issues` projection classifies existing `links`, `pages`, block, and relation data into stable typed issues. Axum exposes paginated/filterable issue reads plus preview/apply endpoints. The React workspace uses generated API types, a list/detail responsive layout, and P1 atomic mutation execution; automatic actions never bypass preview or source revision checks.

**Tech Stack:** Rust, rusqlite, blake3, Axum/utoipa/OpenAPI, existing `MutationPlanner`/P1 batch coordinator, React 19, TanStack Router/Query, React Aria components, Vitest/Testing Library, Axum integration tests.

## Global Constraints

- Issue kinds: unresolved page link, ambiguous page link, broken block reference, invalid relation target, orphan page, isolated page.
- Encrypted source bodies expose no snippet and no automatic body-edit action.
- Stable fingerprints bind issue kind, source identity/span, target, and source revision.
- Every automatic action is previewed and applied one issue at a time.
- A stale fingerprint/revision returns HTTP 409 and does not edit moved text.
- Orphan and isolated pages are navigation/explanation only.
- No bulk selection, bulk apply, or optimistic issue removal.
- Existing focused index APIs remain available for external clients.
- P1 atomic batch mutations must land before the apply endpoint.
- Follow TDD and observe intended failures before implementation.

---

### Task 1: Project typed reference issues from the vault index

**Files:**
- Create: `src/vault/reference_issues.rs`
- Modify: `src/vault/mod.rs`
- Modify: `src/vault/index.rs`
- Test: `src/vault/reference_issues.rs`
- Test: `tests/block_ref_resolution_test.rs`
- Test: `tests/property_patch.rs`

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceIssueKind {
    UnresolvedPageLink,
    AmbiguousPageLink,
    BrokenBlockRef,
    InvalidRelationTarget,
    OrphanPage,
    IsolatedPage,
}

pub enum ReferenceIssueAction { Create, Replace, OpenSource, None }

pub struct ReferenceIssue {
    pub fingerprint: String,
    pub kind: ReferenceIssueKind,
    pub source_id: String,
    pub source_path: String,
    pub source_title: Option<String>,
    pub source_revision: String,
    pub span_start: Option<i64>,
    pub span_end: Option<i64>,
    pub source_field: Option<String>,
    pub snippet: Option<String>,
    pub target_raw: Option<String>,
    pub candidates: Vec<ReferenceCandidate>,
    pub actions: Vec<ReferenceIssueAction>,
}

pub struct ReferenceIssueFilter {
    pub kinds: Vec<ReferenceIssueKind>,
    pub project: Option<String>,
    pub page_kind: Option<Kind>,
    pub actionable: Option<bool>,
    pub limit: u32,
    pub offset: u32,
}

pub struct ReferenceIssuePage { pub items: Vec<ReferenceIssue>, pub total: u64 }
```

- `VaultIndex::reference_issues(filter) -> Result<ReferenceIssuePage, IndexError>` delegates to the new module.

**Classification:**

- unresolved `kind='wiki'`, reason no match → unresolved page link,
- unresolved `kind='wiki'`, multiple candidates → ambiguous page link,
- unresolved `kind='block_ref'` → broken block ref,
- unresolved `kind='property_ref'` → invalid relation target,
- no resolved inbound links → orphan,
- no resolved inbound or outbound links → isolated.

- [ ] **Step 1: Write classification and privacy tests**

```rust
#[test]
fn classifies_unresolved_rows_by_indexed_link_kind() {
    let index = fixture_with_wiki_block_and_relation_misses();
    let issues = index.reference_issues(ReferenceIssueFilter::default()).unwrap();
    assert_eq!(
        issues.items.iter().map(|issue| issue.kind).collect::<Vec<_>>(),
        vec![
            ReferenceIssueKind::BrokenBlockRef,
            ReferenceIssueKind::InvalidRelationTarget,
            ReferenceIssueKind::UnresolvedPageLink,
        ]
    );
}

#[test]
fn encrypted_pages_never_expose_snippets_or_body_actions() {
    let issue = encrypted_source_issue();
    assert_eq!(issue.snippet, None);
    assert_eq!(issue.actions, vec![ReferenceIssueAction::OpenSource]);
}
```

Add an orphan/isolated distinction test using one page with outbound-only, one with inbound-only, and one with neither.

- [ ] **Step 2: Run focused tests**

Run: `cargo test --lib vault::reference_issues::tests -- --nocapture`  
Expected: FAIL because the projection does not exist.

- [ ] **Step 3: Implement one deterministic SQL projection**

Select page `content_hash` as `source_revision`, `encrypted`, kind/project, link spans, `source_field`, and ranked candidates. Read snippets only for unencrypted positive body spans; relation issues use `frontmatter field: <source_field>` rather than body text. Fingerprint the versioned tuple:

```text
v1\0kind\0source_id\0source_revision\0span_start\0span_end\0target_raw
```

using blake3 hex. Order by issue severity, source path, span, and target before pagination. Apply filters before `LIMIT/OFFSET`; compute `total` from the same filtered relation.

- [ ] **Step 4: Run reference-index tests**

Run: `cargo test --lib vault::reference_issues::tests -- --nocapture`  
Run: `cargo test --test block_ref_resolution_test -- --nocapture`  
Run: `cargo test --test property_patch -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/reference_issues.rs src/vault/mod.rs src/vault/index.rs tests/block_ref_resolution_test.rs tests/property_patch.rs
git commit -m "feat(index): project typed reference repair issues"
```

### Task 2: Expose paginated issue inventory through OpenAPI

**Files:**
- Modify: `src/api/index_routes.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_test.rs`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Adds `GET /api/vault/index/issues`.
- Query parameters: repeated/comma-normalized `kind`, `project`, `page_kind`, `actionable`, `limit` (default 50, max 200), `offset` (default 0).
- Response:

```rust
pub struct ReferenceIssuesResponse {
    pub items: Vec<ReferenceIssueDto>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
}
```

- DTO enums use `snake_case` and expose candidate `page_id`, `path`, `title`, and ranking rationale.

- [ ] **Step 1: Write failing API filter/pagination tests**

```rust
#[tokio::test]
async fn reference_issues_filter_before_paginating() {
    let server = seeded_reference_issue_server();
    let response: Value = server
        .get("/api/vault/index/issues?kind=broken_block_ref&limit=1&offset=0")
        .await
        .json();
    assert_eq!(response["total"], 2);
    assert_eq!(response["items"].as_array().unwrap().len(), 1);
    assert_eq!(response["items"][0]["kind"], "broken_block_ref");
}
```

Also test encrypted snippets are `null`, invalid limits return 400, and repeated requests return identical ordering/fingerprints.

- [ ] **Step 2: Run API tests**

Run: `cargo test --test api_test reference_issues_ -- --nocapture`  
Expected: FAIL with route not found.

- [ ] **Step 3: Implement the route and schema registration**

Map query tokens through explicit enum parsing; do not accept silently misspelled issue kinds. Use the existing `IndexHandle::with_index` boundary. Register all request/response schemas and the handler in `openapi.rs`.

- [ ] **Step 4: Regenerate and verify the contract**

Run: `cargo test --test api_test reference_issues_ -- --nocapture`  
Run: `cargo test --test openapi_contract -- --nocapture`  
Regenerate: `bun run --cwd ui openapi`  
Expected: PASS and `schema.d.ts` contains the issue DTOs and route.

- [ ] **Step 5: Commit**

```bash
git add src/api/index_routes.rs src/api/openapi.rs tests/api_test.rs ui/src/api/schema.d.ts
git commit -m "feat(api): expose reference repair inventory"
```

### Task 3: Preview and apply one stale-protected repair

**Files:**
- Create: `src/vault/reference_repair.rs`
- Modify: `src/vault/mod.rs`
- Modify: `src/api/index_routes.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_test.rs`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Adds:
  - `POST /api/vault/index/issues/preview`
  - `POST /api/vault/index/issues/apply`
- Request:

```rust
pub struct ReferenceRepairRequest {
    pub fingerprint: String,
    pub source_revision: String,
    pub action: ReferenceRepairActionDto,
}

pub enum ReferenceRepairActionDto {
    Create { folder: String, body: Option<String> },
    Replace { candidate_page_id: String },
}
```

- Preview response contains `fingerprint`, human-readable before/after source context, and the exact P1 `MutationPlan` representation.
- Apply returns the committed issue fingerprint and `MutationNotification`.

- [ ] **Step 1: Write failing preview/apply and stale tests**

```rust
#[tokio::test]
async fn repair_apply_rejects_source_changed_after_preview() {
    let (server, root) = seeded_unresolved_server();
    let issue = first_issue(&server).await;
    preview_replace(&server, &issue, CANDIDATE_ID).await.assert_status_ok();
    fs::write(root.join(&issue.source_path), changed_source()).unwrap();
    apply_replace(&server, &issue, CANDIDATE_ID)
        .await
        .assert_status(axum::http::StatusCode::CONFLICT);
    assert_eq!(fs::read_to_string(root.join(&issue.source_path)).unwrap(), changed_source());
}
```

Add tests that preview and apply produce the same text edit, create resolves the original no-match after indexing, ambiguous replacement writes an explicit unambiguous target, and encrypted sources have no apply action.

- [ ] **Step 2: Run focused repair tests**

Run: `cargo test --test api_test reference_repair_ -- --nocapture`  
Expected: FAIL because endpoints and repair planner are absent.

- [ ] **Step 3: Implement source-aware repair planning**

Recompute the issue by fingerprint inside the current index. Re-read source bytes and compare content hash/revision. For positive body spans, parse the source link occupying that exact span and replace only its target segment while preserving alias/display syntax. For `property_ref`, use `source_field` and the existing format-preserving property mutation path; do not rewrite arbitrary TOML text. Broken block refs remain navigation-only unless the projection supplies exactly one valid block-ID candidate. Creating a page uses the same batch command as the source resolution event; replacement uses P1 `BatchMutationCommand`.

- [ ] **Step 4: Run repair and mutation suites**

Run: `cargo test --test api_test reference_repair_ -- --nocapture`  
Run: `cargo test --test mutation_test -- --nocapture`  
Run: `cargo test --test property_patch -- --nocapture`  
Expected: PASS.

- [ ] **Step 5: Regenerate schema and commit**

Run: `bun run --cwd ui openapi`

```bash
git add src/vault/reference_repair.rs src/vault/mod.rs src/api/index_routes.rs src/api/openapi.rs tests/api_test.rs ui/src/api/schema.d.ts
git commit -m "feat(api): preview and apply reference repairs"
```

### Task 4: Add typed React Query hooks for issues and repairs

**Files:**
- Modify: `ui/src/api/index.ts`
- Modify: `ui/src/api/keys.ts`
- Create: `ui/src/api/__tests__/reference-repairs.test.tsx`

**Interfaces:**
- Produces:

```ts
export type ReferenceIssue = components["schemas"]["ReferenceIssueDto"];
export interface ReferenceIssueFilters {
  kind?: ReferenceIssue["kind"][];
  project?: string;
  pageKind?: string;
  actionable?: boolean;
  limit?: number;
  offset?: number;
}
export function useReferenceIssues(filters: ReferenceIssueFilters): UseQueryResult<ReferenceIssuesResponse>;
export function usePreviewReferenceRepair(): UseMutationResult<ReferenceRepairPreview, Error, ReferenceRepairRequest>;
export function useApplyReferenceRepair(): UseMutationResult<ReferenceRepairResult, Error, ReferenceRepairRequest>;
```

- Successful apply invalidates index issues, pages, graph, and query/Bases paths; it does not optimistically remove a row.

- [ ] **Step 1: Write failing hook tests**

Assert filters serialize exactly, apply forwards fingerprint/revision/action, and invalidation occurs only in `onSuccess`.

- [ ] **Step 2: Run hook tests**

Run: `bun run --cwd ui test src/api/__tests__/reference-repairs.test.tsx`  
Expected: FAIL because hooks are absent.

- [ ] **Step 3: Implement hooks using generated paths**

Do not duplicate DTO shapes by hand. Normalize empty filters out of the query string and use a stable query key independent of object identity.

- [ ] **Step 4: Run hook tests and typecheck**

Run: `bun run --cwd ui test src/api/__tests__/reference-repairs.test.tsx`  
Run: `bun run --cwd ui typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/index.ts ui/src/api/keys.ts ui/src/api/__tests__/reference-repairs.test.tsx
git commit -m "feat(ui): add reference repair API hooks"
```

### Task 5: Build the responsive repair workspace

**Files:**
- Create: `ui/src/components/repairs/RepairFilters.tsx`
- Create: `ui/src/components/repairs/RepairIssueList.tsx`
- Create: `ui/src/components/repairs/RepairIssueDetail.tsx`
- Create: `ui/src/components/repairs/RepairWorkspace.tsx`
- Create: `ui/src/components/repairs/__tests__/RepairWorkspace.test.tsx`
- Create: `ui/src/routes/repairs.tsx`
- Create: `ui/src/routes/__tests__/-repairs.test.tsx`
- Remove: `ui/src/routes/link-miss.tsx`
- Remove: `ui/src/routes/__tests__/-link-miss.test.tsx`

**Interfaces:**
- Route search supports `target`, `kind`, `project`, `pageKind`, and `actionable`.
- `RepairWorkspace` owns selected fingerprint and filters.
- `RepairIssueDetail` previews before enabling apply and uses `useOpenTab` for source navigation.
- Mobile uses the existing `useMobileLayout` breakpoint and opens details in the shared `Dialog` primitive.

- [ ] **Step 1: Write failing workspace behavior tests**

```tsx
it("previews before applying and retains the row until invalidation", async () => {
  renderRepairWorkspace([unresolvedIssue]);
  await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
  await user.click(screen.getByRole("button", { name: "Replace with notes/target.md" }));
  expect(previewRepair).toHaveBeenCalledTimes(1);
  expect(applyRepair).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Apply previewed repair" }));
  expect(applyRepair).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Unresolved Target")).toBeVisible();
});
```

Also test filter URL state, encrypted/navigation-only issues, 409 refresh message, keyboard list/detail movement, focus restoration after apply, mobile dialog, and the deeplink `target` banner.

- [ ] **Step 2: Run workspace tests**

Run: `bun run --cwd ui test src/components/repairs/__tests__/RepairWorkspace.test.tsx src/routes/__tests__/-repairs.test.tsx`  
Expected: FAIL because route/components do not exist.

- [ ] **Step 3: Implement React Aria list/detail interactions**

Use semantic list/table patterns appropriate to viewport, live regions for preview/apply status, and explicit empty/loading/error states. Do not remove rows in mutation callbacks; wait for the issue query result. Preserve selected fingerprint after refresh only if it still exists.

- [ ] **Step 4: Regenerate the route tree and run UI tests**

Run: `bun run --cwd ui build` to regenerate TanStack route types.  
Run: `bun run --cwd ui test src/components/repairs/__tests__/RepairWorkspace.test.tsx src/routes/__tests__/-repairs.test.tsx`  
Expected: PASS and generated route types contain `/repairs`, not `/link-miss`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/repairs ui/src/routes/repairs.tsx ui/src/routes/__tests__/-repairs.test.tsx ui/src/routes/link-miss.tsx ui/src/routes/__tests__/-link-miss.test.tsx ui/src/routeTree.gen.ts
git commit -m "feat(ui): add reference repair workspace"
```

### Task 6: Wire all repair entry points and retire the link-miss route

**Files:**
- Modify: `src/api/deeplink.rs`
- Modify: `tests/api_deeplink_test.rs`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/components/settings/IndexHealthPanel.tsx`
- Modify: `ui/src/components/settings/__tests__/IndexHealthPanel.test.tsx`
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`

**Interfaces:**
- Unknown deep links redirect to `/repairs?target=<encoded-url>`.
- Command palette adds `{ id: "nav.repairs", title: "Open Reference Repairs" }`.
- Index health links to the workspace instead of duplicating create/repair controls; index rebuild remains in settings.
- Atrium exposes issue count and opens `/repairs`.

- [ ] **Step 1: Update tests first**

Change the deeplink expected location from `/link-miss` to `/repairs`. Add command-palette, settings, and dashboard navigation assertions.

- [ ] **Step 2: Run focused entry-point tests**

Run: `cargo test --test api_deeplink_test -- --nocapture`  
Run: `bun run --cwd ui test src/components/codex/__tests__/CommandPalette.test.tsx src/components/settings/__tests__/IndexHealthPanel.test.tsx src/components/codex/__tests__/CodexFrame.test.tsx`  
Expected: FAIL until callers are updated.

- [ ] **Step 3: Implement clean cutover**

Remove repair duplication from `IndexHealthPanel` while retaining warnings/rebuild. Update every internal `/link-miss` reference. Do not leave a deprecated route alias; server-generated deep links and generated route types change together.

- [ ] **Step 4: Run entry-point tests**

Run the same Rust and UI commands from Step 2.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/deeplink.rs tests/api_deeplink_test.rs ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/__tests__/CommandPalette.test.tsx ui/src/components/settings/IndexHealthPanel.tsx ui/src/components/settings/__tests__/IndexHealthPanel.test.tsx ui/src/components/codex/Atrium.tsx ui/src/components/codex/__tests__/CodexFrame.test.tsx
git commit -m "feat(ui): route reference diagnostics through repairs"
```

### Task 7: Verify repair behavior end to end

**Files:**
- Create: `tests/reference_repair_test.rs`

**Interfaces:**
- E2E coverage creates unresolved and ambiguous body links, repairs them individually, and verifies both issue projection and resulting links.

- [ ] **Step 1: Write the failing E2E workflow**

Seed two pages sharing an ambiguous canonical name and one no-match link. Fetch issues, preview and apply the no-match create action, preview and apply the explicit ambiguous replacement, then assert `/index/issues` no longer returns either fingerprint and `/index/outlinks/<source>` resolves both links.

- [ ] **Step 2: Run the E2E test**

Run: `cargo test --test reference_repair_test -- --nocapture`  
Expected: FAIL until every backend contract is wired.

- [ ] **Step 3: Fix only integration defects exposed by the E2E test**

Do not add fallback resolution, optimistic UI removal, or bulk repair. Preserve exact stale checks and one-action semantics.

- [ ] **Step 4: Run browser smoke and repository gates**

Browser smoke:

1. Open `/repairs` with unresolved, ambiguous, broken block, relation, orphan, and isolated fixtures.
2. Filter each class and open its source.
3. Preview/apply one unresolved create and one ambiguous replacement.
4. Modify a source after preview and confirm the 409 refresh path.
5. Repeat the detail flow on a mobile viewport with keyboard/focus checks.

Then run:

- `cargo check --all-targets --all-features`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test --all-features`
- `bun run --cwd ui typecheck`
- `bun run --cwd ui lint`
- `bun run --cwd ui test`

Expected: all PASS; record unrelated baseline failures exactly if present.

- [ ] **Step 5: Commit**

```bash
git add tests/reference_repair_test.rs
git commit -m "test: verify reference repairs end to end"
```

## Acceptance

- All six issue kinds appear in one deterministic paginated projection.
- Encrypted pages disclose neither snippets nor automatic body-edit actions.
- Every automatic repair is previewed and stale-protected.
- Successful apply removes the issue only after post-commit index invalidation.
- `/repairs` replaces `/link-miss` across server redirects, route types, settings, dashboard, and command palette.
- No bulk apply or optimistic row removal exists.
