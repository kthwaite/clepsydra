# Full Feature Documentation Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every current user-facing Clepsydra workflow discoverable through a complete, tested in-app documentation architecture without documenting unshipped roadmap work.

**Architecture:** A checked feature-inventory manifest maps every route, command entry, integration, and major workflow to either a canonical guide, generated reference, or an explicit internal-only rationale. The registry groups those guides by user intent. Behavioral coverage tests compare the running app/OpenAPI/CLI surfaces against the manifest and verify guide structure, internal links, search indexing, and route reachability.

**Tech Stack:** React/TypeScript, MDX, TanStack Router, existing docs registry/search/sidebar, Vitest/Testing Library, Rust/Axum OpenAPI tests, Clap binary integration tests.

## Global Constraints

- Document shipped current behavior only; no “Next”, “Later”, or speculative roadmap content.
- Every current route, command palette entry, CLI command, MCP/LSP/browser-extension surface, settings/security workflow, and major domain workflow receives exactly one disposition.
- Each workflow guide contains: purpose/prerequisites, canonical UI path and command entry, primary workflow, failure/conflict behavior, privacy/encryption boundary where relevant, and related guides/reference links.
- Generated API and CLI reference coverage is validated against live/OpenAPI behavior, not source-text heuristics.
- Registry slugs, groups, route loading, search, and internal links are test-enforced.
- P1-P4 guides land after those features; until then this plan may create registry entries only in the same task that creates complete guide content.
- Preserve the existing MDX lazy-loading architecture and `/docs/$slug` URLs.
- Follow TDD and observe intended failures before content/implementation changes.

---

### Task 1: Define and enforce the current feature inventory

**Files:**
- Create: `ui/src/docs/featureInventory.ts`
- Create: `ui/src/docs/featureInventory.test.ts`
- Create: `ui/src/components/codex/commandRegistry.ts`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`

**Interfaces:**
- Produces:

```ts
export type DocumentationDisposition =
  | { kind: "guide"; slug: DocSlug }
  | { kind: "reference"; slug: DocSlug }
  | { kind: "internal"; rationale: string };

export interface FeatureInventoryEntry {
  id: string;
  label: string;
  surface: "route" | "command" | "workflow" | "integration" | "settings";
  disposition: DocumentationDisposition;
}

export const FEATURE_INVENTORY: readonly FeatureInventoryEntry[];
```

- Initial workflow IDs include pages/editor, folders/moves/deletes, search, wikilinks/backlinks, graph, block refs/transclusion, Bases, tasks/agenda/journals/board cycles, academic import/library/reading, feeds, browser capture, archive/CAS, attachments, encryption, Codex/conversation capture, LSP, MCP, browser extension, configuration, diagnostics, and backup.

- [ ] **Step 1: Write failing inventory coverage tests**

```ts
it("gives every navigable route one documentation disposition", () => {
  const publicRoutes = routePaths().filter(isUserFeatureRoute);
  expect(uncovered(publicRoutes, FEATURE_INVENTORY)).toEqual([]);
});

it("gives every static command one documentation disposition", () => {
  expect(uncovered(STATIC_COMMANDS.map((command) => command.id), FEATURE_INVENTORY)).toEqual([]);
});
```

Also assert unique IDs, known registry slugs, non-empty internal rationales, and no entry points at a “Next”/“Later” guide.

- [ ] **Step 2: Run the inventory tests**

Run: `bun run --cwd ui test src/docs/featureInventory.test.ts`  
Expected: FAIL because the manifest is absent.

- [ ] **Step 3: Extract command metadata and populate the manifest**

Export static command descriptors from one side-effect-free module so both palette and tests consume the same runtime data. Mark application shells, auth redirects, and generated callback routes internal only with concrete rationale; do not hide real workflows behind “internal”.

- [ ] **Step 4: Run inventory and command tests**

Run: `bun run --cwd ui test src/docs/featureInventory.test.ts src/components/codex/__tests__/CommandPalette.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/featureInventory.ts ui/src/docs/featureInventory.test.ts ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/commandRegistry.ts ui/src/components/codex/__tests__/CommandPalette.test.tsx
git commit -m "test(docs): inventory every user-facing feature"
```

### Task 2: Restructure the docs registry around user intent

**Files:**
- Modify: `ui/src/docs/types.ts`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/registry.test.ts`
- Modify: `ui/src/components/docs/DocsSidebar.tsx`
- Modify: `ui/src/components/docs/__tests__/DocsSidebar.test.tsx`

**Interfaces:**
- Registry groups, in order:
  1. Start
  2. Pages and authoring
  3. Links and structured knowledge
  4. Work and reading
  5. Capture, feeds, and archives
  6. AI and integrations
  7. Operations and reference
- Every `DocPage` gains `description` and `keywords` for predictable search/discovery.

- [ ] **Step 1: Write failing registry-order and uniqueness tests**

Assert exact group order, unique slug/title, non-empty description/keywords, no duplicate canonical workflow across groups, and previous/next navigation spanning group boundaries.

- [ ] **Step 2: Run registry/sidebar tests**

Run: `bun run --cwd ui test src/docs/registry.test.ts src/components/docs/__tests__/DocsSidebar.test.tsx`  
Expected: FAIL against the old registry shape/groups.

- [ ] **Step 3: Implement the new metadata model and group skeleton**

Move existing accurate guides into the new groups without duplicating content. Do not register a planned guide until its complete MDX file lands in Tasks 3-6.

- [ ] **Step 4: Run registry/sidebar tests and typecheck**

Run: `bun run --cwd ui test src/docs/registry.test.ts src/components/docs/__tests__/DocsSidebar.test.tsx`  
Run: `bun run --cwd ui typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/types.ts ui/src/docs/registry.ts ui/src/docs/registry.test.ts ui/src/components/docs/DocsSidebar.tsx ui/src/components/docs/__tests__/DocsSidebar.test.tsx
git commit -m "refactor(docs): organize guides by user intent"
```

### Task 3: Document pages, authoring, attachments, and encryption

**Files:**
- Create: `ui/src/docs/content/pages-and-authoring.mdx`
- Create: `ui/src/docs/content/editor-workflows.mdx`
- Create: `ui/src/docs/content/attachments-and-media.mdx`
- Create: `ui/src/docs/content/encryption-and-protected-pages.mdx`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/featureInventory.ts`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`

**Required coverage:**

- Page creation, filenames/identity, frontmatter/kind/project projection, folders, moves, force-delete/backlink consequences, stale edits, editor autosave/manual save, slash commands, Markdown paste, embedded Bases, block IDs/references, P3 single-block transclusion, attachment upload/insertion/list/delete, P2 protected-note attachment disclosure, encryption unlock/edit/save limits, and plaintext metadata boundaries.

- [ ] **Step 1: Add failing registry and structural guide tests**

Register the four slugs in a test fixture first. Extend MDX smoke assertions so each workflow guide must contain headings matching `Prerequisites`, `Workflow`, `Failures and conflicts`, `Privacy`, and `Related` (allow `Privacy` to explicitly state “not applicable”).

- [ ] **Step 2: Run MDX and registry tests**

Run: `bun run --cwd ui test src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx`  
Expected: FAIL because the pages are missing.

- [ ] **Step 3: Write guides from current UI/API behavior**

Use canonical route and command names exactly. Distinguish page-body encryption from plaintext filenames/frontmatter/indexability. State P2’s disclosure limitation precisely: acknowledgment covers new upload/insertion; existing attachment references remain auditable; a custom client can construct ciphertext the server cannot inspect.

- [ ] **Step 4: Render all four MDX pages in tests**

Run: `bun run --cwd ui test src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/content/pages-and-authoring.mdx ui/src/docs/content/editor-workflows.mdx ui/src/docs/content/attachments-and-media.mdx ui/src/docs/content/encryption-and-protected-pages.mdx ui/src/docs/registry.ts ui/src/docs/featureInventory.ts ui/src/docs/mdx-smoke.test.tsx
git commit -m "docs: cover pages authoring attachments and encryption"
```

### Task 4: Document links, search, graph, repair, and Bases

**Files:**
- Create: `ui/src/docs/content/links-search-graph-and-repair.mdx`
- Create: `ui/src/docs/content/block-references-and-transclusion.mdx`
- Modify: `ui/src/docs/content/bases.mdx`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/featureInventory.ts`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`

**Required coverage:**

- Wikilink resolution, aliases/paths/canonical names, unresolved/ambiguous states, backlinks/outlinks, ranked candidates, create-from-link, FTS scopes, graph semantics, P4 issue classes/preview/stale conflicts/one-at-a-time fixes, block-ID assignment, single-block non-recursive transclusion and unavailable state, Base definitions/properties/relations/views/filters/sorts/grouping/embedded views, format-preserving property mutation, and relation warnings.

- [ ] **Step 1: Add failing cross-link and content-contract tests**

Assert the links guide links to block references, repair, Bases, and LSP; the Bases guide links back to relation repair; and all documented routes/commands exist in runtime registries.

- [ ] **Step 2: Run docs tests**

Run: `bun run --cwd ui test src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/docs/search.test.ts`  
Expected: FAIL for missing pages/links.

- [ ] **Step 3: Write and revise the guides**

Keep block semantics precise: P3 renders one read-only block; nested tokens stay inert; protected and missing IDs are indistinguishable. Keep repair semantics precise: no bulk apply and no optimistic removal. Describe Bases as saved non-owning views, not databases that own pages.

- [ ] **Step 4: Run docs tests**

Run the command from Step 2.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/content/links-search-graph-and-repair.mdx ui/src/docs/content/block-references-and-transclusion.mdx ui/src/docs/content/bases.mdx ui/src/docs/registry.ts ui/src/docs/featureInventory.ts ui/src/docs/mdx-smoke.test.tsx
git commit -m "docs: cover knowledge links repair and Bases"
```

### Task 5: Document work, academic reading, capture, feeds, and archives

**Files:**
- Create: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`
- Create: `ui/src/docs/content/academic-library-and-reading.mdx`
- Create: `ui/src/docs/content/capture-feeds-and-archives.mdx`
- Modify: `ui/src/docs/content/books-and-reading.mdx`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/featureInventory.ts`

**Required coverage:**

- Tasks, statuses, agenda day/week/overdue, journal opening/natural dates, board cycles/carryover and P1 all-or-none guarantees; Zotero/DOI/arXiv/ISBN import, cite keys, dedup/conflicts, reading workspace/PDF-highlights only where shipped; browser capture, feeds/private-reader semantics, archive/CAS retention, attachment distinction, and backup/recovery boundaries.

- [ ] **Step 1: Add failing workflow coverage tests**

Assert each workflow manifest entry maps to one of the new guides and every guide meets the structural heading contract.

- [ ] **Step 2: Run focused docs tests**

Run: `bun run --cwd ui test src/docs/featureInventory.test.ts src/docs/mdx-smoke.test.tsx`  
Expected: FAIL because guide coverage is incomplete.

- [ ] **Step 3: Write guides using shipped routes and failure behavior**

Do not claim publishing/export, CRDT collaboration, encrypted attachments, or unimplemented academic PDF annotation. Clearly distinguish archive CAS blobs from editable note attachments and feeds from public publishing.

- [ ] **Step 4: Run docs tests**

Run the command from Step 2.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/content/tasks-agenda-journals-and-board.mdx ui/src/docs/content/academic-library-and-reading.mdx ui/src/docs/content/capture-feeds-and-archives.mdx ui/src/docs/content/books-and-reading.mdx ui/src/docs/registry.ts ui/src/docs/featureInventory.ts
git commit -m "docs: cover work reading capture feeds and archives"
```

### Task 6: Document Codex, conversation capture, and integrations

**Files:**
- Create: `ui/src/docs/content/codex-and-conversation-capture.mdx`
- Modify: `ui/src/docs/content/lsp.mdx`
- Modify: `ui/src/docs/content/mcp.mdx`
- Modify: `ui/src/docs/content/browser-extension.mdx`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/featureInventory.ts`

**Required coverage:**

- Codex workspace/tabs/quires/preview, AI conversation Folios, capture/import and protection boundaries, LSP setup/capabilities/stale external edits, MCP running-server dependency/tool families/errors, browser extension install/capture permissions/HTTPS and failure recovery.

- [ ] **Step 1: Add failing integration coverage and link tests**

Assert all integration manifest entries map to registered slugs and each integration guide links to configuration/troubleshooting.

- [ ] **Step 2: Run docs tests**

Run: `bun run --cwd ui test src/docs/featureInventory.test.ts src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx`  
Expected: FAIL until the Codex guide and missing sections land.

- [ ] **Step 3: Write and update integration guides**

State local-server trust and plaintext/encrypted boundaries exactly. Do not describe plugin APIs, collaboration, or publication as current capabilities.

- [ ] **Step 4: Run docs tests**

Run the command from Step 2.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/content/codex-and-conversation-capture.mdx ui/src/docs/content/lsp.mdx ui/src/docs/content/mcp.mdx ui/src/docs/content/browser-extension.mdx ui/src/docs/registry.ts ui/src/docs/featureInventory.ts
git commit -m "docs: cover Codex capture and integrations"
```

### Task 7: Make API and CLI references behavior-checked

**Files:**
- Modify: `ui/src/docs/content/cli.mdx`
- Create: `ui/src/docs/content/api-reference.mdx`
- Modify: `ui/src/docs/content/configuration.mdx`
- Modify: `ui/src/docs/content/troubleshooting.mdx`
- Modify: `ui/src/docs/registry.ts`
- Create: `tests/docs_cli_coverage_test.rs`
- Create: `tests/docs_api_coverage_test.rs`

**Interfaces:**
- CLI coverage test executes `clepsydra --help` plus each subcommand’s `--help`, extracts public command paths, and asserts each appears as a command heading in `cli.mdx`.
- API coverage test reads the generated OpenAPI document through the application’s OpenAPI builder, extracts every public operation’s method/path/tag, and asserts `api-reference.mdx` contains its canonical method/path or an explicit tag-level generated-reference section.

- [ ] **Step 1: Write failing behavioral coverage tests**

```rust
#[test]
fn every_public_cli_command_is_documented() {
    let commands = public_commands_from_help();
    let docs = include_str!("../ui/src/docs/content/cli.mdx");
    assert!(missing_command_headings(&commands, docs).is_empty());
}

#[test]
fn every_openapi_operation_is_documented() {
    let operations = public_openapi_operations();
    let docs = include_str!("../ui/src/docs/content/api-reference.mdx");
    assert!(missing_operations(&operations, docs).is_empty());
}
```

- [ ] **Step 2: Run coverage tests**

Run: `cargo test --test docs_cli_coverage_test -- --nocapture`  
Run: `cargo test --test docs_api_coverage_test -- --nocapture`  
Expected: FAIL with concrete missing command/operation lists.

- [ ] **Step 3: Complete reference and operations docs**

Document actual flags, defaults, exit/failure behavior, server prerequisites, auth/TLS/config lookup, and examples. Group API endpoints by OpenAPI tag but include canonical method/path strings so coverage is machine-checkable and user-readable.

- [ ] **Step 4: Run Rust and UI docs tests**

Run both commands from Step 2.  
Run: `bun run --cwd ui test src/docs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/docs/content/cli.mdx ui/src/docs/content/api-reference.mdx ui/src/docs/content/configuration.mdx ui/src/docs/content/troubleshooting.mdx ui/src/docs/registry.ts tests/docs_cli_coverage_test.rs tests/docs_api_coverage_test.rs
git commit -m "docs: enforce CLI and API reference coverage"
```

### Task 8: Verify documentation discovery and accessibility end to end

**Files:**
- Modify: `ui/src/docs/search.ts`
- Modify: `ui/src/docs/search.test.ts`
- Modify: `ui/src/routes/__tests__/-docs.test.ts`
- Modify: `ui/src/components/docs/__tests__/DocsSidebar.test.tsx`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`

**Interfaces:**
- Search indexes title, description, keywords, headings, and body once per page.
- Every guide supports direct route load, previous/next navigation, and mobile drawer navigation.

- [ ] **Step 1: Add failing discovery tests**

Test queries such as `stale repair`, `protected attachment`, `board carryover`, `zotero conflict`, `block transclusion`, `MCP server`, and `CAS archive`, asserting the intended canonical guide ranks first. Add internal-link resolution and route-load tests for every registry slug.

- [ ] **Step 2: Run discovery tests**

Run: `bun run --cwd ui test src/docs/search.test.ts src/routes/__tests__/-docs.test.ts src/components/docs/__tests__/DocsSidebar.test.tsx src/docs/mdx-smoke.test.tsx`  
Expected: FAIL until metadata/ranking/navigation cover all pages.

- [ ] **Step 3: Implement metadata-aware search and fix only discovered navigation defects**

Deduplicate matches by page, preserve heading deep links, and use deterministic tie-breaking by score then registry order. Do not add undocumented synonym hacks; put user vocabulary in page keywords.

- [ ] **Step 4: Browser smoke and repository gates**

Browser smoke at desktop and mobile widths:

1. Open `/docs/getting-started` directly.
2. Navigate every group through the sidebar/drawer.
3. Search each representative query from Step 1.
4. Follow every related-guide link on one page per group.
5. Confirm headings, focus order, current-page state, and previous/next links.

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
git add ui/src/docs/search.ts ui/src/docs/search.test.ts ui/src/routes/__tests__/-docs.test.ts ui/src/components/docs/__tests__/DocsSidebar.test.tsx ui/src/docs/mdx-smoke.test.tsx
git commit -m "test(docs): verify complete documentation discovery"
```

## Acceptance

- Every current user-facing feature has one guide/reference/internal disposition.
- Every workflow guide satisfies the shared content contract.
- Every public CLI command and OpenAPI operation is behavior-checked against documentation.
- All registered slugs load, links resolve, and representative searches rank the canonical guide first.
- No guide claims unshipped roadmap behavior.
