# In-App Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Clepsydra’s six user guides as a searchable, read-only MDX documentation view inside the existing Vessel application shell.

**Architecture:** TanStack Router exposes `/docs` and `/docs/$slug`; a typed explicit registry imports six compiled MDX modules plus their raw source. A pure indexer turns the raw source into deterministic page/section search results, while focused React components own the sidebar, responsive drawer, article rendering, and MDX element map. Swagger relocates to `/api/docs` so `/docs/*` belongs to the SPA.

**Tech Stack:** React 19, TypeScript 5.9, TanStack Router, React Aria Components, Vite 8, `@mdx-js/rollup`, `rehype-slug`, Vitest, Testing Library, Rust/Axum, utoipa Swagger UI.

## Global Constraints

- The documentation is bundled, release-owned, read-only, and independent of the user’s vault.
- Migrate exactly Getting Started, Configuration, CLI, Bases, LSP, and MCP; leave engineering documents and `docs/affordances.md` outside the app.
- Use the approved two-column desktop layout; do not add a right-hand “On this page” rail.
- Docs search is client-only, requires all normalized query tokens, and ranks title before heading, description, then body.
- The Docs field does not replace or intercept global `⌘K` vault search.
- `/docs` redirects to `/docs/getting-started`; Swagger moves to `/api/docs`; OpenAPI JSON stays at `/api/openapi.json`.
- Follow Vessel tokens: no rounded corners, no new literal palette, mono chrome, Inter prose, existing border/rule/accent variables.
- Do not edit `ui/src/routeTree.gen.ts`; TanStack Router regenerates it.
- Each task uses TDD and ends with its focused tests passing before commit.

---

## Planned File Structure

### Content and pure domain code

- `ui/src/docs/types.ts` — public documentation metadata, registry, and search result types.
- `ui/src/docs/registry.ts` — explicit groups/order, six compiled MDX imports, six raw-source imports, lookup and adjacency helpers.
- `ui/src/docs/search.ts` — Markdown-aware section extraction, normalization, ranking, and excerpt generation; no React/router imports.
- `ui/src/docs/content/*.mdx` — canonical six product guides with typed metadata exports and `/docs/...` internal links.
- `ui/src/docs/registry.test.ts`, `ui/src/docs/search.test.ts` — pure registry and search contracts.

### React presentation

- `ui/src/components/docs/DocsMdxComponents.tsx` — Vessel MDX element map, stable anchored headings, internal router links, external links, tables, callouts, and copyable code blocks.
- `ui/src/components/docs/DocsArticle.tsx` — metadata header, compiled article, previous/next guide navigation.
- `ui/src/components/docs/DocsSidebar.tsx` — grouped navigation, local search mode, no-results state, active markers.
- `ui/src/components/docs/DocsLayout.tsx` — fixed desktop rail, article scroll region, React Aria narrow-screen drawer.
- `ui/src/components/docs/DocsScreen.tsx` — slug lookup and Docs-specific not-found state.
- Co-located `__tests__` files — observable rendering, navigation, search-mode, and drawer behavior.

### Routing and shell

- `ui/src/routes/docs.tsx` — redirect `/docs` to the default guide.
- `ui/src/routes/docs.$slug.tsx` — render `DocsScreen` from the route slug.
- `ui/src/components/codex/CodexFrame.tsx` — Docs view detection/navbar action, Sheaf suppression, footer code, Status index `06`.
- `ui/src/components/codex/__tests__/CodexFrame.test.tsx` — navbar active state and Docs shell behavior.

### Build/backend/repository docs

- `ui/package.json`, `ui/bun.lock` — MDX compiler and heading-slug dependencies.
- `ui/vite.config.ts`, `ui/vitest.config.ts`, `ui/src/vite-env.d.ts` — MDX compilation and module typing.
- `src/api/openapi.rs`, `src/api/frontend.rs` — Swagger relocation and SPA-fallback tests.
- Repository documents that link to migrated `docs/*.md` — update to `/docs/...` when user-facing, or the new MDX source path when an engineering source reference is intended.

---

### Task 1: Relocate Swagger and reserve `/docs` for the SPA

**Files:**
- Modify: `src/api/openapi.rs:226-232`
- Modify: `src/api/frontend.rs:75-149`
- Modify: `docs/getting-started.md:72-78` (temporary source; the file is moved in Task 3)

**Interfaces:**
- Consumes: existing `api::openapi::router()` and `api::frontend::frontend_router()`.
- Produces: Swagger HTML at `/api/docs`, unchanged JSON at `/api/openapi.json`, and SPA fallback behavior for `/docs/*`.

- [ ] **Step 1: Add failing backend route tests**

In `src/api/openapi.rs`, add a Tokio test that sends requests through `router::<()>()`:

```rust
use axum::{body::Body, http::Request};
use tower::ServiceExt;

#[tokio::test]
async fn swagger_is_scoped_under_api_docs() {
    let response = router::<()>()
        .oneshot(Request::builder().uri("/api/docs/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert!(response.status().is_success() || response.status().is_redirection());

    let old = router::<()>()
        .oneshot(Request::builder().uri("/docs/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(old.status(), axum::http::StatusCode::NOT_FOUND);
}
```

In `src/api/frontend.rs`, add:

```rust
#[tokio::test]
async fn docs_paths_use_the_spa_fallback() {
    for uri in ["/docs", "/docs/getting-started", "/docs/bases"] {
        let response = static_handler(Uri::from_static(uri)).await.into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
    }
}
```

- [ ] **Step 2: Run the focused Rust tests and confirm the old contract fails**

Run: `cargo test api::openapi::tests::swagger_is_scoped_under_api_docs`

Run: `cargo test api::frontend::tests::docs_paths_use_the_spa_fallback`

Expected: the Swagger test fails because the current UI is mounted at `/docs`; the fallback test may already pass and pins that behavior.

- [ ] **Step 3: Move the Swagger mount**

Change the router construction to:

```rust
Router::new().merge(
    SwaggerUi::new("/api/docs").url("/api/openapi.json", ApiDoc::openapi()),
)
```

Change the Getting Started URL from `http://localhost:3000/docs` to `http://localhost:3000/api/docs`.

- [ ] **Step 4: Run focused tests and formatting**

Run: `cargo test api::openapi::tests::swagger_is_scoped_under_api_docs`

Run: `cargo test api::frontend::tests::docs_paths_use_the_spa_fallback`

Expected: PASS.

Run: `cargo fmt --check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/openapi.rs src/api/frontend.rs docs/getting-started.md
git commit -m "feat: move Swagger under api docs"
```

---

### Task 2: Add the MDX toolchain and module contract

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Modify: `ui/vite.config.ts`
- Modify: `ui/vitest.config.ts`
- Modify: `ui/src/vite-env.d.ts`
- Create: `ui/src/docs/types.ts`
- Create: `ui/src/docs/content/getting-started.mdx`
- Create: `ui/src/docs/mdx-smoke.test.tsx`

**Interfaces:**
- Produces:
  - `DocMeta = { slug: string; title: string; description: string }`
  - `.mdx` default export typed as `ComponentType<{ components?: MDXComponents }>`
  - named `.mdx` export `meta: DocMeta`
  - raw imports through `*.mdx?raw`
- Later tasks consume the configured MDX compiler and these exact types.

- [ ] **Step 1: Install direct MDX dependencies**

Run:

```bash
bun --cwd ui add @mdx-js/rollup rehype-slug github-slugger
bun --cwd ui add --dev @types/mdx
```

Expected: `package.json` and `bun.lock` record the dependencies without unrelated upgrades.

- [ ] **Step 2: Define the metadata and module types**

Create `ui/src/docs/types.ts`:

```ts
import type { ComponentType } from "react";
import type { MDXComponents } from "mdx/types";

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
}

export interface DocPage extends DocMeta {
  groupId: string;
  source: string;
  Component: ComponentType<{ components?: MDXComponents }>;
}

export interface DocGroup {
  id: string;
  label: string;
  pages: readonly DocPage[];
}
```

Extend `ui/src/vite-env.d.ts`:

```ts
declare module "*.mdx" {
  import type { ComponentType } from "react";
  import type { MDXComponents } from "mdx/types";
  import type { DocMeta } from "#/docs/types";

  export const meta: DocMeta;
  const Component: ComponentType<{ components?: MDXComponents }>;
  export default Component;
}
```

Vite already types `?raw` imports through `vite/client`.

- [ ] **Step 3: Add a failing MDX smoke fixture/test**

Create `ui/src/docs/content/getting-started.mdx` as a temporary minimal fixture:

```mdx
import type { DocMeta } from "#/docs/types"

export const meta = {
  slug: "getting-started",
  title: "Getting Started",
  description: "Run Clepsydra with an initialized vault."
} satisfies DocMeta

# Getting Started

Create your first Clepsydra vault.
```

Create `ui/src/docs/mdx-smoke.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import Guide, { meta } from "#/docs/content/getting-started.mdx";
import source from "#/docs/content/getting-started.mdx?raw";

it("compiles MDX, preserves typed metadata, and exposes raw source", () => {
  render(<Guide />);
  expect(screen.getByRole("heading", { name: "Getting Started" })).toHaveAttribute(
    "id",
    "getting-started",
  );
  expect(meta.slug).toBe("getting-started");
  expect(source).toContain("Create your first Clepsydra vault.");
});
```

- [ ] **Step 4: Run the smoke test and confirm MDX is not configured**

Run: `bun --cwd ui run test -- src/docs/mdx-smoke.test.tsx`

Expected: FAIL because Vitest cannot transform `.mdx`.

- [ ] **Step 5: Configure Vite and Vitest**

In both configs, import `mdx` from `@mdx-js/rollup`, `rehypeSlug` from `rehype-slug`, and `react` from `@vitejs/plugin-react`. Use the same plugin order:

```ts
plugins: [
  { enforce: "pre", ...mdx({ rehypePlugins: [rehypeSlug] }) },
  // retain TanStack Router and Tailwind in vite.config.ts between MDX and React
  react({ include: /\.(jsx|js|mdx|md|tsx|ts)$/ }),
]
```

In `vite.config.ts`, retain `tanstackRouter(...)` and `tailwindcss()`; only replace the existing terminal `react()` with the configured call. In `vitest.config.ts`, add only MDX and React plugins.

- [ ] **Step 6: Run the smoke test, typecheck, and lint**

Run: `bun --cwd ui run test -- src/docs/mdx-smoke.test.tsx`

Expected: PASS.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

Run: `bun --cwd ui run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/bun.lock ui/vite.config.ts ui/vitest.config.ts ui/src/vite-env.d.ts ui/src/docs
git commit -m "feat: configure bundled MDX documentation"
```

---

### Task 3: Migrate the six guides into a typed registry

**Files:**
- Create: `ui/src/docs/content/configuration.mdx`
- Create: `ui/src/docs/content/cli.mdx`
- Create: `ui/src/docs/content/bases.mdx`
- Create: `ui/src/docs/content/lsp.mdx`
- Create: `ui/src/docs/content/mcp.mdx`
- Replace temporary content: `ui/src/docs/content/getting-started.mdx`
- Create: `ui/src/docs/registry.ts`
- Create: `ui/src/docs/registry.test.ts`
- Delete after migration: `docs/getting-started.md`, `docs/configuration.md`, `docs/cli.md`, `docs/bases.md`, `docs/lsp.md`, `docs/mcp.md`

**Interfaces:**
- Produces:
  - `DOC_GROUPS: readonly DocGroup[]`
  - `DOC_PAGES: readonly DocPage[]`
  - `DEFAULT_DOC_SLUG = "getting-started"`
  - `getDocPage(slug: string): DocPage | undefined`
  - `getDocNeighbors(slug: string): { previous?: DocPage; next?: DocPage }`
- Later search and React tasks consume only these exports, not individual MDX files.

- [ ] **Step 1: Write failing registry invariant tests**

Create `ui/src/docs/registry.test.ts`:

```ts
import {
  DEFAULT_DOC_SLUG,
  DOC_GROUPS,
  DOC_PAGES,
  getDocNeighbors,
  getDocPage,
} from "#/docs/registry";

it("declares the approved hierarchy and unique slugs", () => {
  expect(DOC_GROUPS.map((group) => [group.label, group.pages.map((p) => p.slug)])).toEqual([
    ["Start Here", ["getting-started", "configuration"]],
    ["Reference", ["cli"]],
    ["Features", ["bases"]],
    ["Integrations", ["lsp", "mcp"]],
  ]);
  expect(new Set(DOC_PAGES.map((page) => page.slug)).size).toBe(DOC_PAGES.length);
  expect(getDocPage(DEFAULT_DOC_SLUG)?.title).toBe("Getting Started");
});

it("derives previous and next guides from registry order", () => {
  expect(getDocNeighbors("getting-started").previous).toBeUndefined();
  expect(getDocNeighbors("getting-started").next?.slug).toBe("configuration");
  expect(getDocNeighbors("mcp").previous?.slug).toBe("lsp");
  expect(getDocNeighbors("mcp").next).toBeUndefined();
});

it("keeps MDX metadata and registry entries aligned", () => {
  for (const page of DOC_PAGES) {
    expect(page.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(page.title).not.toBe("");
    expect(page.description).not.toBe("");
    expect(page.source).toContain(`slug: "${page.slug}"`);
  }
});
```

- [ ] **Step 2: Run the test and confirm the registry is absent**

Run: `bun --cwd ui run test -- src/docs/registry.test.ts`

Expected: FAIL because `#/docs/registry` does not exist.

- [ ] **Step 3: Migrate guide content with exact metadata headers**

Move each old Markdown body into its corresponding `.mdx` file. Prepend this shape, with exact values:

```mdx
import type { DocMeta } from "#/docs/types"

export const meta = {
  slug: "configuration",
  title: "Configuration",
  description: "Configure Clepsydra’s server, vault, TLS, and runtime behavior."
} satisfies DocMeta
```

Use these metadata values:

```ts
[
  ["getting-started", "Getting Started", "Run Clepsydra with an initialized vault."],
  ["configuration", "Configuration", "Configure Clepsydra’s server, vault, TLS, and runtime behavior."],
  ["cli", "CLI", "Use Clepsydra’s command-line interface."],
  ["bases", "Bases", "Define typed fields and filtered table views."],
  ["lsp", "LSP", "Use Clepsydra’s language server in Markdown editors."],
  ["mcp", "MCP", "Connect agents to Clepsydra through the Model Context Protocol."],
]
```

Do not duplicate the document title: retain the body beginning at the first content after its original top-level `#` heading because `DocsArticle` owns the visible article title. Rewrite cross-guide links as absolute product routes such as `/docs/bases`, `/docs/lsp`, and `/docs/mcp`. Preserve code samples verbatim except the Swagger URL already changed in Task 1.

- [ ] **Step 4: Implement the explicit registry**

In `ui/src/docs/registry.ts`, statically import every compiled module, named `meta`, and `?raw` source. Construct entries with a helper that assigns `groupId`:

```ts
function page(
  groupId: string,
  meta: DocMeta,
  Component: DocPage["Component"],
  source: string,
): DocPage {
  return { ...meta, groupId, Component, source };
}

export const DEFAULT_DOC_SLUG = "getting-started";
export const DOC_GROUPS = [
  { id: "start", label: "Start Here", pages: [gettingStarted, configuration] },
  { id: "reference", label: "Reference", pages: [cli] },
  { id: "features", label: "Features", pages: [bases] },
  { id: "integrations", label: "Integrations", pages: [lsp, mcp] },
] as const satisfies readonly DocGroup[];

export const DOC_PAGES: readonly DocPage[] = DOC_GROUPS.flatMap((group) => group.pages);

export function getDocPage(slug: string): DocPage | undefined {
  return DOC_PAGES.find((entry) => entry.slug === slug);
}

export function getDocNeighbors(slug: string) {
  const index = DOC_PAGES.findIndex((entry) => entry.slug === slug);
  return index < 0
    ? {}
    : { previous: DOC_PAGES[index - 1], next: DOC_PAGES[index + 1] };
}
```

- [ ] **Step 5: Run registry and MDX smoke tests**

Run: `bun --cwd ui run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx`

Expected: PASS with all six sources imported.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

- [ ] **Step 6: Remove the six old Markdown files**

Delete only the migrated files listed under **Files**. Confirm no guide content remains duplicated; do not remove any engineering documentation.

- [ ] **Step 7: Commit**

```bash
git add ui/src/docs docs/getting-started.md docs/configuration.md docs/cli.md docs/bases.md docs/lsp.md docs/mcp.md
git commit -m "docs: migrate user guides into MDX registry"
```

---

### Task 4: Build deterministic section search

**Files:**
- Modify: `ui/src/docs/types.ts`
- Create: `ui/src/docs/search.ts`
- Create: `ui/src/docs/search.test.ts`

**Interfaces:**
- Consumes: `DocPage`, raw MDX source, and registry order.
- Produces:
  - `DocSearchSection = { page: DocPage; heading?: string; headingId?: string; text: string; order: number }`
  - `DocSearchResult = { page: DocPage; heading?: string; headingId?: string; excerpt: string; score: number }`
  - `buildDocsIndex(pages: readonly DocPage[]): readonly DocSearchSection[]`
  - `searchDocs(index: readonly DocSearchSection[], query: string): readonly DocSearchResult[]`

- [ ] **Step 1: Add failing extraction and ranking tests**

Use tiny `DocPage` fixtures with no-op components and raw source containing metadata, duplicate headings, fenced code, and body-only terms. Assert:

```ts
const index = buildDocsIndex([gettingStarted, bases]);
expect(index.map(({ page, heading, headingId }) => [page.slug, heading, headingId])).toEqual([
  ["getting-started", undefined, undefined],
  ["getting-started", "Initialize a vault", "initialize-a-vault"],
  ["bases", undefined, undefined],
  ["bases", "Fields", "fields"],
  ["bases", "Fields", "fields-1"],
]);

expect(searchDocs(index, "typed fields").map((r) => r.page.slug)).toEqual(["bases"]);
expect(searchDocs(index, "bases")[0].heading).toBeUndefined();
expect(searchDocs(index, "initialize")[0]).toMatchObject({
  page: gettingStarted,
  heading: "Initialize a vault",
  headingId: "initialize-a-vault",
});
expect(searchDocs(index, "missing token")).toEqual([]);
```

Also assert title > heading > description > body ranking, registry-order tie breaking, case folding, empty-query behavior, code-fence exclusion, and an excerpt containing the body-only match.

- [ ] **Step 2: Run the test and confirm the functions are absent**

Run: `bun --cwd ui run test -- src/docs/search.test.ts`

Expected: FAIL because `#/docs/search` does not exist.

- [ ] **Step 3: Implement extraction**

Use `GithubSlugger` from `github-slugger` so search fragment IDs exactly match `rehype-slug`. Scan source line-by-line:

- skip ESM import/export metadata blocks
- toggle and exclude fenced code blocks
- start a new section on ATX headings (`##` through `######`; the article owns `h1`)
- strip Markdown link/image markers and inline formatting from indexed body text
- emit one page-level section plus one section per heading
- preserve a monotonically increasing `order`

Reset the slugger for every page and call `slugger.slug(headingText)` for duplicate-safe IDs.

- [ ] **Step 4: Implement query and ranking**

Normalize with `value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()`. Require every query token somewhere in the combined title/description/heading/body haystack.

Use deterministic additive weights:

```ts
const SCORE = {
  exactTitle: 10_000,
  titlePrefix: 5_000,
  titleToken: 1_000,
  headingToken: 300,
  descriptionToken: 100,
  bodyToken: 10,
} as const;
```

Deduplicate a page-level result when a more specific matching heading section has the same score class. Sort by descending score, then ascending section `order`. Build an excerpt of at most 140 characters around the first normalized body match, preserving readable source text and adding `…` only when truncated.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Run: `bun --cwd ui run test -- src/docs/search.test.ts`

Expected: PASS.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

Run: `bun --cwd ui run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/docs/types.ts ui/src/docs/search.ts ui/src/docs/search.test.ts
git commit -m "feat: index and search bundled documentation"
```

---

### Task 5: Render MDX articles with Vessel components

**Files:**
- Create: `ui/src/components/docs/DocsMdxComponents.tsx`
- Create: `ui/src/components/docs/DocsArticle.tsx`
- Create: `ui/src/components/docs/__tests__/DocsArticle.test.tsx`

**Interfaces:**
- Consumes: `DocPage`, `getDocNeighbors`, TanStack Router `Link`, existing `CopyButton`, semantic Vessel tokens.
- Produces:
  - `docsMdxComponents: MDXComponents`
  - `DocsArticle({ page }: { page: DocPage }): JSX.Element`

- [ ] **Step 1: Write failing article behavior tests**

Render `DocsArticle` under a memory TanStack Router with a fixture component that emits `h2`, internal `/docs/bases#fields`, external `https://example.com`, code, and table elements. Assert:

```tsx
expect(screen.getByRole("heading", { level: 1, name: page.title })).toBeInTheDocument();
expect(screen.getByText(page.description)).toBeInTheDocument();
expect(screen.getByRole("heading", { level: 2, name: /Fields/ })).toHaveAttribute("id", "fields");
expect(screen.getByRole("link", { name: /Fields/ })).toHaveAttribute("href", "#fields");
expect(screen.getByRole("link", { name: "Bases" })).toHaveAttribute("href", "/docs/bases#fields");
expect(screen.getByRole("link", { name: "External" })).toHaveAttribute("rel", "noreferrer");
expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
expect(screen.getByRole("link", { name: /Next: Configuration/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run the test and confirm components are absent**

Run: `bun --cwd ui run test -- src/components/docs/__tests__/DocsArticle.test.tsx`

Expected: FAIL because `DocsArticle` does not exist.

- [ ] **Step 3: Implement the MDX component map**

Build focused semantic components:

- heading factory for `h2`–`h6` that preserves the `id` supplied by `rehype-slug` and adds a same-page anchor with an accessible label
- `a` that uses TanStack `Link` for absolute `/docs/...` targets, plain anchors for `#...`, and `<a target="_blank" rel="noreferrer">` for external targets
- `pre` wrapper with the existing `CopyButton`
- scrollable square-edged table wrapper
- token-based paragraph/list/blockquote/callout typography

Export a stable `docsMdxComponents` object; do not allocate it during article renders.

- [ ] **Step 4: Implement `DocsArticle`**

Render group breadcrumb, `h1`, description, `page.Component` with the shared map, then previous/next links from `getDocNeighbors(page.slug)`. Use a capped prose width and Inter for body copy; keep breadcrumb/navigation chrome mono.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Run: `bun --cwd ui run test -- src/components/docs/__tests__/DocsArticle.test.tsx`

Expected: PASS.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

Run: `bun --cwd ui run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/docs
git commit -m "feat: render Vessel documentation articles"
```

---

### Task 6: Add hierarchical sidebar search and responsive layout

**Files:**
- Create: `ui/src/components/docs/DocsSidebar.tsx`
- Create: `ui/src/components/docs/DocsLayout.tsx`
- Create: `ui/src/components/docs/__tests__/DocsSidebar.test.tsx`
- Create: `ui/src/components/docs/__tests__/DocsLayout.test.tsx`

**Interfaces:**
- Consumes: `DOC_GROUPS`, `buildDocsIndex(DOC_PAGES)`, `searchDocs`, React Aria `SearchField`, `ModalOverlay`, `Modal`, and `Dialog`.
- Produces:
  - `DocsSidebar({ activeSlug, onNavigate? }: { activeSlug?: string; onNavigate?: () => void })`
  - `DocsLayout({ activeSlug, children }: { activeSlug?: string; children: ReactNode })`

- [ ] **Step 1: Write failing sidebar behavior tests**

Test the real six-page registry. Assert initial grouped navigation and active state, then type a body-only term:

```tsx
render(<DocsSidebar activeSlug="getting-started" />);
expect(screen.getByRole("navigation", { name: "Documentation" })).toBeInTheDocument();
expect(screen.getByRole("link", { name: "Getting Started" })).toHaveAttribute("aria-current", "page");

await user.type(screen.getByRole("searchbox", { name: "Search documentation" }), "typed fields");
expect(screen.queryByText("Start Here")).not.toBeInTheDocument();
expect(screen.getByRole("link", { name: /Bases/ })).toBeInTheDocument();
expect(screen.getByText(/typed fields/i)).toBeInTheDocument();

await user.clear(screen.getByRole("searchbox", { name: "Search documentation" }));
expect(screen.getByText("Start Here")).toBeInTheDocument();
```

Also test no-results copy/clear action, heading-result hashes, collapsible group buttons with `aria-expanded`, stable result order, and `onNavigate` after result/page selection.

- [ ] **Step 2: Write failing layout/drawer tests**

Render `DocsLayout`, assert the desktop navigation and article region exist, open the Docs-local menu button, then assert the dialog is labeled “Documentation navigation”, Escape dismisses it, and selecting a mocked sidebar link calls the close path. The desktop rail must be marked hidden only at the narrow breakpoint; the article remains mounted in both states.

- [ ] **Step 3: Run focused tests and confirm the components are absent**

Run: `bun --cwd ui run test -- src/components/docs/__tests__/DocsSidebar.test.tsx src/components/docs/__tests__/DocsLayout.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement `DocsSidebar`**

Use local controlled query and collapsed-group state. Compute the six-page index once at module scope. Empty query renders groups; non-empty query renders ranked results or the exact no-results message `No documentation matches` plus a clear button. Every link uses `/docs/$slug` and an optional `hash`; invoke `onNavigate` after selection.

Use the existing `#/components/ui/search-field` with `aria-label="Search documentation"`. Do not register a hotkey.

- [ ] **Step 5: Implement `DocsLayout`**

Use an `h-full min-h-0 overflow-hidden` flex/grid shell. Desktop rail: fixed width, border-right, independent overflow. Article: `min-w-0 overflow-y-auto`. Narrow-screen button: visible below `md`, square Vessel treatment. Drawer: React Aria `ModalOverlay` + dismissible `Modal` + `Dialog`, full height at the left edge, and the same `DocsSidebar` with `onNavigate` closing it.

- [ ] **Step 6: Run focused tests, typecheck, and lint**

Run: `bun --cwd ui run test -- src/components/docs/__tests__/DocsSidebar.test.tsx src/components/docs/__tests__/DocsLayout.test.tsx`

Expected: PASS.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

Run: `bun --cwd ui run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/docs
git commit -m "feat: add documentation navigation and search"
```

---

### Task 7: Add Docs routes and not-found recovery

**Files:**
- Create: `ui/src/components/docs/DocsScreen.tsx`
- Create: `ui/src/components/docs/__tests__/DocsScreen.test.tsx`
- Create: `ui/src/routes/docs.tsx`
- Create: `ui/src/routes/docs.$slug.tsx`
- Generated by dev/build command: `ui/src/routeTree.gen.ts` (never hand-edit)

**Interfaces:**
- Consumes: `DEFAULT_DOC_SLUG`, `getDocPage`, `DocsLayout`, and `DocsArticle`.
- Produces:
  - `DocsScreen({ slug }: { slug: string }): JSX.Element`
  - `/docs` redirect
  - `/docs/$slug` rendering and direct-link support

- [ ] **Step 1: Write failing `DocsScreen` tests**

Under a memory router, assert:

```tsx
render(<DocsScreen slug="bases" />);
expect(screen.getByRole("heading", { level: 1, name: "Bases" })).toBeInTheDocument();
expect(screen.getByRole("link", { name: "Bases" })).toHaveAttribute("aria-current", "page");

render(<DocsScreen slug="unknown-guide" />);
expect(screen.getByRole("heading", { name: "Documentation not found" })).toBeInTheDocument();
expect(screen.getByRole("link", { name: "Open Getting Started" })).toHaveAttribute(
  "href",
  "/docs/getting-started",
);
expect(screen.getByRole("navigation", { name: "Documentation" })).toBeInTheDocument();
```

- [ ] **Step 2: Run the test and confirm the screen is absent**

Run: `bun --cwd ui run test -- src/components/docs/__tests__/DocsScreen.test.tsx`

Expected: FAIL because `DocsScreen` does not exist.

- [ ] **Step 3: Implement screen and route files**

`DocsScreen` always renders `DocsLayout`. For a valid page it renders `DocsArticle`; for an unknown slug it renders the Docs-specific recovery state while passing no active slug.

Use:

```tsx
// routes/docs.tsx
export const Route = createFileRoute("/docs")({
  beforeLoad: () => {
    throw redirect({ to: "/docs/$slug", params: { slug: DEFAULT_DOC_SLUG } });
  },
});

// routes/docs.$slug.tsx
function DocsRoute() {
  const { slug } = Route.useParams();
  return <DocsScreen slug={slug} />;
}

export const Route = createFileRoute("/docs/$slug")({ component: DocsRoute });
```

- [ ] **Step 4: Regenerate the route tree through the supported command**

Run: `bun --cwd ui run build`

Expected: TanStack Router regenerates `routeTree.gen.ts`, TypeScript compiles, and Vite emits MDX chunks/assets without route conflicts.

- [ ] **Step 5: Run focused tests and route build**

Run: `bun --cwd ui run test -- src/components/docs/__tests__/DocsScreen.test.tsx`

Expected: PASS.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/docs/DocsScreen.tsx ui/src/components/docs/__tests__/DocsScreen.test.tsx ui/src/routes/docs.tsx 'ui/src/routes/docs.$slug.tsx' ui/src/routeTree.gen.ts
git commit -m "feat: route bundled documentation"
```

---

### Task 8: Integrate Docs into `CodexFrame`

**Files:**
- Modify: `ui/src/components/codex/CodexFrame.tsx:16-25,46-75,175-178,210-217`
- Create: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`

**Interfaces:**
- Consumes: existing `CodexFrame` view detection/navigation and `/docs/$slug` route.
- Produces: navbar `DOCS` item/index `05`, Status index `06`, Docs active state, Sheaf suppression, `VIEW DOCS`, and a documentation file code.

- [ ] **Step 1: Add failing frame tests with existing dependencies mocked**

Mock `useLocation` as `{ pathname: "/docs/getting-started" }`, `useNavigate`, stats, vault events, uptime, theme, reading progress, stores, and `Sheaf`. Render `CodexFrame` and assert:

```tsx
expect(screen.getByRole("button", { name: /05.*DOCS/i })).toHaveClass(
  "shadow-[inset_0_-2px_0_0_var(--accent)]",
);
expect(screen.getByRole("button", { name: /06.*STATUS/i })).toBeInTheDocument();
expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
expect(screen.getByText(/VIEW DOCS/)).toBeInTheDocument();
```

Click Docs from a non-Docs pathname and assert `navigate({ to: "/docs/$slug", params: { slug: "getting-started" } })` (or the equivalent `/docs` redirect target selected by the implementation).

- [ ] **Step 2: Run the focused test and confirm Docs is treated as Atrium**

Run: `bun --cwd ui run test -- src/components/codex/__tests__/CodexFrame.test.tsx`

Expected: FAIL because `docs` is not a view or navbar item.

- [ ] **Step 3: Implement frame integration**

- extend `View` with `"docs"`
- append `["docs", "DOCS"]` to `NAV`
- return `"docs"` for paths beginning `/docs`
- navigate Docs to `/docs/$slug` with `DEFAULT_DOC_SLUG`
- suppress `Sheaf` for Docs
- return a stable `DOC-001`-style code from `useFolioCode`
- update Status’s hard-coded index to `06`
- retain reading percentage only for Folio

- [ ] **Step 4: Run focused tests, typecheck, and lint**

Run: `bun --cwd ui run test -- src/components/codex/__tests__/CodexFrame.test.tsx`

Expected: PASS.

Run: `bun --cwd ui run typecheck`

Expected: PASS.

Run: `bun --cwd ui run lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/CodexFrame.tsx ui/src/components/codex/__tests__/CodexFrame.test.tsx
git commit -m "feat: add Docs to the Vessel navbar"
```

---

### Task 9: Repair repository links and verify the complete feature

**Files:**
- Modify: repository files that still reference the six deleted root `docs/*.md` paths
- Modify only if browser verification exposes a real defect: files introduced in Tasks 1–8

**Interfaces:**
- Consumes: complete Docs UI, migrated content, and relocated Swagger.
- Produces: no stale references, passing repository gates, and browser-observed acceptance behavior.

- [ ] **Step 1: Find and classify stale references**

Search for exact old paths:

```text
docs/getting-started.md
docs/configuration.md
docs/cli.md
docs/bases.md
docs/lsp.md
docs/mcp.md
```

For user-facing navigation/reference text, replace with `/docs/<slug>`. For engineering-source references that must resolve inside the repository, replace with `ui/src/docs/content/<slug>.mdx`. Do not rewrite historical plans or archived material merely because it mentions the former path; update only live instructions and links intended to resolve now.

- [ ] **Step 2: Run the focused feature tests together**

Run:

```bash
bun --cwd ui run test -- \
  src/docs/mdx-smoke.test.tsx \
  src/docs/registry.test.ts \
  src/docs/search.test.ts \
  src/components/docs/__tests__/DocsArticle.test.tsx \
  src/components/docs/__tests__/DocsSidebar.test.tsx \
  src/components/docs/__tests__/DocsLayout.test.tsx \
  src/components/docs/__tests__/DocsScreen.test.tsx \
  src/components/codex/__tests__/CodexFrame.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run all frontend gates**

Run: `bun --cwd ui run typecheck`

Run: `bun --cwd ui run lint`

Run: `bun --cwd ui run test`

Run: `bun --cwd ui run build`

Expected: every command exits successfully.

- [ ] **Step 4: Run all Rust gates**

Run: `cargo fmt --check`

Run: `cargo clippy --all-targets --all-features -- -D warnings`

Run: `cargo test`

Expected: every command exits successfully.

- [ ] **Step 5: Smoke-test the shipped application in a real browser**

Start the backend/application with the repository’s normal development configuration, then verify at desktop width:

1. `DOCS` appears as navbar item `05`; Status is `06`.
2. Clicking Docs reaches `/docs/getting-started` and no Sheaf is visible.
3. The left hierarchy remains fixed while the article scrolls.
4. Navigating to Bases updates active state and previous/next links.
5. Searching a body-only term replaces the hierarchy with results and an excerpt.
6. Selecting a heading result updates the URL fragment and scrolls to that heading.
7. Reloading the deep link restores the guide and section.
8. Clearing search restores the group hierarchy; an impossible query shows and clears the no-results state.
9. `/docs/not-a-guide` retains the sidebar and shows the recovery link.
10. At a narrow viewport, the Docs navigation button opens a dismissible full-height drawer; selection closes it.
11. `/api/docs` loads Swagger and `/api/openapi.json` still returns the schema.

Capture browser observations; do not substitute component tests for this smoke test.

- [ ] **Step 6: Commit live link repairs or smoke-test fixes**

If files changed during this task:

```bash
git add <only-the-live-reference-or-fix-files>
git commit -m "docs: repair in-app guide links"
```

If nothing changed, do not create an empty commit.

- [ ] **Step 7: Review final task commits and merge through the feature workflow**

Confirm each task’s commit contains only its reviewed slice. Then merge the isolated feature branch into `develop` and remove the worktree according to `superpowers:finishing-a-development-branch`. Do not leave compatibility aliases at `/docs` for Swagger; the cutover is intentionally clean.
