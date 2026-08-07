# In-App Documentation Design

**Date:** 2026-08-07
**Status:** Approved for implementation planning

## Summary

Clepsydra will ship its user documentation inside the application as a distinct `DOCS` view. The view uses a conventional static-documentation layout adapted to the existing Vessel shell: persistent hierarchical navigation on the left, a focused article column, bundled MDX content, stable article URLs, and client-side full-text search.

The documentation is release-owned and read-only. It compiles into the frontend and therefore always describes the running Clepsydra version. It does not read from or write to the user's vault.

## Goals

- Add `DOCS` to the global navbar and render it as a distinct main-body view.
- Provide a persistent hierarchical left rail and a readable article column.
- Author the product guides in MDX without runtime evaluation.
- Search titles, headings, and article bodies entirely in the browser.
- Preserve direct links to guides and headings across reloads.
- Migrate the existing polished user guides to one canonical in-app corpus.
- Retain Clepsydra's Vessel visual language and application shell.

## Non-goals

- Editing documentation from Clepsydra or the vault.
- Searching vault content from the Docs search field.
- A hosted documentation site, server-side search, analytics, version switcher, localization, or community-authored plugins.
- Moving ADRs, implementation plans, code reviews, design notes, PKM redesign material, or `docs/affordances.md` into the product corpus.
- A right-hand “On this page” rail in the initial implementation.

## Content Scope and Migration

The following six user guides move from `docs/*.md` into a frontend-owned MDX content directory and become the canonical copies:

- Getting Started
- Configuration
- CLI
- Bases
- LSP
- MCP

The old Markdown copies are removed after links to them are migrated. Engineering documentation remains under the repository's `docs/` tree.

The initial sidebar hierarchy is:

1. **Start Here**
   - Getting Started
   - Configuration
2. **Reference**
   - CLI
3. **Features**
   - Bases
4. **Integrations**
   - LSP
   - MCP

## Routes and Application Shell

### Product documentation

- `/docs` redirects to `/docs/getting-started`.
- `/docs/$slug` renders the selected guide.
- Heading links use URL fragments, for example `/docs/bases#field-types`.

The root `CodexFrame` adds a `docs` view and a `DOCS` navbar item after `TASKING`. Existing diegetic navbar indices remain ordered: Docs becomes `05`, and the hard-coded Status index moves from `05` to `06`.

Docs retains the global Clepsydra header, theme controls, status controls, and footer. It hides the workspace `Sheaf`, as Atrium and Constellation already do for their distinct bodies. The footer reports `VIEW DOCS` and a documentation-specific file code rather than treating the route as Atrium or Folio.

### API documentation

Swagger UI moves from `/docs` to `/api/docs`. OpenAPI JSON remains at `/api/openapi.json`. Existing references and backend route tests are updated. The backend's SPA fallback owns `/docs` and `/docs/*` so direct product-documentation URLs load the frontend.

## MDX Architecture

Vite compiles `.mdx` files with `@mdx-js/rollup`. The MDX plugin runs in the `pre` phase before the React plugin, and the React plugin includes MDX input. There is no browser-side MDX compiler and no evaluation of vault content.

Each MDX module exports typed metadata:

- `slug`: stable route segment
- `title`: display and search title
- `description`: article summary

A single TypeScript registry is the source of truth for:

- group hierarchy and labels
- page order
- route slugs
- imports of compiled MDX modules
- raw-source imports used to construct the search index
- previous/next guide relationships

The registry is explicit rather than generated. Adding a guide requires adding its MDX file and one registry entry. This is deliberate: the initial corpus is small, navigation semantics remain visible in code review, and no custom Vite manifest generator is needed.

The Docs renderer supplies a shared MDX component map for headings, internal and external links, paragraphs, lists, code blocks, tables, notes, and callouts. These components enforce the Vessel presentation while keeping guide source primarily Markdown. Existing reusable UI behavior, such as code-copy affordances, should be reused rather than reimplemented.

## Layout and Interaction

### Desktop

The Docs body is a two-column layout that fills the available space beneath the global rails:

- a fixed-width left navigation rail
- a flexible article region with a capped prose width

The Docs body owns overflow. The left rail remains visible while the article region scrolls. It contains:

1. a labeled “Search documentation” field
2. grouped, hierarchical navigation
3. an active-page marker
4. collapsible group controls

The article begins with its group breadcrumb, title, and description. The MDX body follows. Previous and next guide links appear after the article.

Headings receive deterministic slug IDs and visible link affordances. Internal guide links use TanStack Router navigation. Same-page heading links update the URL fragment and preserve browser back/forward behavior. External links use normal external-link semantics and are visually distinguishable.

### Narrow screens

The sidebar is persistent where both columns fit. Below the application's established responsive breakpoint, it becomes a full-height dismissible drawer opened by a Docs-local navigation button. Selecting a page or search result closes the drawer. The article remains readable without the drawer open.

### Global search separation

The existing global `⌘K` command continues to search the vault. Docs search is local to the left rail, is explicitly labeled as documentation search, and does not intercept or replace the global shortcut.

## Search

Search is synchronous and entirely client-side. No API endpoint, worker, or fuzzy-search dependency is introduced for six guides.

At application build/load time, the registry exposes each page's raw MDX source. A deterministic indexer extracts:

- page title and description
- heading text and stable heading IDs
- normalized body text grouped under the nearest heading

Queries are trimmed, case-folded, and tokenized. A result must contain all query tokens across its indexed fields. Ranking weights exact title matches first, then title prefixes, heading matches, description matches, and body matches. Registry order is the final stable tie-breaker.

While the field contains a non-empty query, ranked results replace the navigation tree in the same left rail. Each result shows the page title, matching section when applicable, and a short excerpt around the first body match. Selecting a result navigates to its page and heading fragment. Clearing the field restores the hierarchy.

An empty query never shows a result mode. A non-empty query with no matches displays “No documentation matches” and a clear-search action. Search has no loading or network-error state.

## Failure Behavior

- An unknown `/docs/$slug` renders a Docs-specific not-found state inside the two-column Docs layout. The sidebar remains available, and the state links to Getting Started.
- An unexpected MDX render failure flows through the existing route error boundary.
- Invalid internal guide targets are implementation defects, not runtime fallbacks. Registry and link tests catch them.
- Duplicate slugs, invalid group references, or inconsistent registry order fail invariant tests.
- A missing URL fragment leaves the guide at its normal scroll position; it does not turn the valid guide into a not-found state.

## Component Boundaries

The implementation should preserve these responsibilities:

- **Docs route:** validates the slug, selects registry data, and owns the route-level not-found state.
- **Docs layout:** owns the two-column/drawer shell and article scroll region.
- **Docs sidebar:** renders hierarchy or search results and manages only local query/group/drawer UI state.
- **Docs article:** renders metadata, the compiled MDX component, heading links, and previous/next navigation.
- **Docs registry:** declares groups, pages, ordering, imports, and navigation relationships.
- **Search indexer:** converts raw MDX plus registry metadata into searchable sections and returns deterministic ranked results. It has no React or router dependency.
- **MDX component map:** owns product-documentation typography and element behavior.

These boundaries keep content registration, indexing, rendering, and UI state independently testable.

## Verification

### Frontend behavior tests

- registry slugs are unique, groups and page order are valid, and previous/next relationships are correct
- index extraction produces stable page/heading sections
- ranking prioritizes title, heading, description, and body matches as specified
- multi-token queries require every token and tie-breaking follows registry order
- result excerpts and heading fragments are correct
- empty, matching, and no-result sidebar states switch correctly
- `/docs` resolves to Getting Started and `/docs/$slug` renders the registered page
- unknown slugs render the Docs-specific not-found state
- internal guide and heading links preserve route/fragment state
- `DOCS` navbar activation, Sheaf suppression, footer view code, and Status renumbering are correct
- the narrow-screen drawer opens, navigates, and closes accessibly

### Backend behavior tests

- Swagger UI is served at `/api/docs`
- OpenAPI JSON remains at `/api/openapi.json`
- `/docs` and `/docs/*` are available to the SPA fallback rather than Swagger

### Repository gates

After implementation:

- frontend typecheck
- frontend lint
- full frontend Vitest suite
- frontend production build
- Rust formatting check
- Rust lint
- full Rust test suite

### Browser smoke test

Run the application and exercise the shipped behavior in a real browser:

1. open Docs from the global navbar
2. navigate between hierarchy entries
3. search for a body-only term
4. select a section result and confirm its heading fragment
5. reload the deep link and confirm the same guide/section remains selected
6. clear search and confirm the hierarchy returns
7. request an unknown slug and confirm the Docs-specific recovery state
8. repeat navigation at a narrow viewport through the drawer
9. open `/api/docs` and confirm Swagger UI still loads

## Acceptance Criteria

The feature is complete when Clepsydra ships the six canonical MDX guides, `DOCS` opens the approved two-column documentation view, hierarchy and deep links remain stable, sidebar full-text search reaches page sections without a server request, unknown routes recover inside the Docs layout, Swagger lives at `/api/docs`, and all verification gates and browser smoke steps pass.