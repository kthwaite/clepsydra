# Docs heading navigation + editor-affordances documentation

Date: 2026-08-14 · Branch: `feature/docs-heading-nav` (off `develop`)

## Scope

Two deliverables, frontend-only:

**A. Editor-affordances documentation** — new sections in
`ui/src/docs/content/editor-workflows.mdx` covering the Folio editor's input
affordances, which are currently undocumented (autoformat, marks/shortcuts,
outliner keys, task/checkbox behavior, inline-property reality, vim mode,
limitations).

**B. Per-document heading navigation** — an "On this page" TOC in the docs
viewer so users can view and browse between headings in each document.

Out of scope (surfaced as follow-ups, not built here): an editor input
affordance for `[key:: value]` inline properties; table support in the editor.

## Established facts (from exploration)

- Headings in compiled docs already carry GitHub-style ids (`rehype-slug` in
  `ui/mdx-plugin.ts`, identical in `ui/vitest.config.ts`). h2–h6 get
  hover-revealed `#` anchors via `createHeading` in
  `ui/src/components/docs/DocsMdxComponents.tsx:26-56`; h1 is the page title
  rendered by `DocsArticle`.
- Docs scroll in an overflow `<main ref={articleRef}>` in
  `ui/src/components/docs/DocsLayout.tsx:60-65`; the ref is currently private.
- `ui/src/docs/search.ts:70-128` (`buildDocsIndex`) already walks top-level
  mdast headings (depth ≥ 2, indented-code false positives skipped) and slugs
  them with `GithubSlugger` — the same algorithm as rehype-slug — but drops
  heading depth.
- `ui/src/components/codex/useScrollSpy.ts` + `scrollTriggers.ts` provide a
  tested container-scoped scrollspy with end-of-document trigger uplift, but
  hardcode `[data-folio-heading-root]` and `h1,…,h6`.
- Guard tests: `ui/src/docs/mdx-smoke.test.tsx` (fragment resolution across all
  docs), `ui/src/docs/registry.test.ts:62` (`DOC_PAGES` length 21 — we add no
  page), `ui/src/routes/__tests__/routeViews.test.ts` (no new routes → no
  change; `/docs/$slug` must NOT gain a `codexView`).

## Decisions

1. **TOC data**: new `ui/src/docs/toc.ts` exporting
   `extractDocToc(source: string): readonly DocTocEntry[]` with
   `DocTocEntry = { depth: number; text: string; id: string }`, reusing the
   exact walk rules of `buildDocsIndex` (top-level nodes only, skip depth-1,
   skip column>4 pseudo-paragraphs, GithubSlugger reset per document). Keep
   `search.ts` untouched; a DOM-agreement test prevents drift.
2. **Scrollspy reuse**: add an optional options argument to `useScrollSpy`
   (`{ rootSelector?, headingSelector? }`) defaulting to the current Folio
   constants so existing call sites are byte-compatible. Docs usage:
   `rootSelector: "article"`, `headingSelector: "h2,h3,h4,h5,h6"` (must
   exclude the h1 title to keep DOM order aligned with `extractDocToc`).
3. **Interaction model**: follow the Folio Contents precedent — `<nav
   aria-label="On this page">` with a button per entry, `aria-current=
   "location"` on the active entry, click → `scrollTo(index)` (trigger-aligned
   smooth scroll; guarantees the clicked entry becomes the highlighted one).
   No hash writes from the TOC; shareable URLs remain the headings' own hover
   anchors.
4. **Placement**: desktop — right rail `<aside>` sibling after `<main>` in
   `DocsLayout`, `hidden xl:flex w-64 shrink-0 flex-col overflow-y-auto
   border-l border-rule bg-paper-2` (mirrors the left rail at
   `DocsLayout.tsx:39-44`). Mobile — the same `DocsToc` rendered in the
   existing drawer beneath `DocsSidebar`; choosing an entry closes the drawer,
   then scrolls.
5. **Wiring**: `DocsScreen` computes entries with `extractDocToc(page.source)`
   (memoized on slug) and passes `toc` to `DocsLayout`; `DocsLayout` owns
   `articleRef` already and hands it to `DocsToc`. `recount` = active slug.
   Known cosmetic limit: with lazily-resolved MDX the highlight may sit on
   entry 0 until the first scroll or click (`scrollTo` remaps itself); accept.
6. **Styling**: Vessel idiom from `DocsSidebar` / Folio Contents — mono,
   `text-[11px]`/xs, active `border-l-2 border-accent bg-highlight text-ink`,
   inactive `border-transparent text-ink-mute hover:text-ink`, depth indent
   `paddingLeft: (depth - 2) * 8 + 8`, zero radius, focus-visible ring tokens.

## Task 1 — TOC extractor + DocsToc + layout wiring (TDD)

Tests first, in `ui/src/docs/__tests__/toc.test.ts` (or beside existing test
conventions):

1. `extractDocToc` unit tests: depth/text/id for a fixture; skips depth-1;
   skips indented-code pseudo-headings; duplicate heading text yields `-1`
   suffixed ids; per-call slugger reset.
2. **DOM agreement (the load-bearing test)**: for every entry in `DOC_PAGES`,
   render the doc (mdx-smoke pattern) and assert
   `article.querySelectorAll("h2,h3,h4,h5,h6")` id sequence exactly equals
   `extractDocToc(page.source).map(e => e.id)` — order, count, and values.
3. `DocsToc.test.tsx`: renders entries with depth indentation; nav labeled
   "On this page"; active entry carries `aria-current="location"`; click calls
   scroll-to (jsdom: stub `Element.prototype.scrollTo` — check how Folio's
   tests already handle this and reuse that shim).
4. `DocsLayout.test.tsx` additions: TOC rail renders when `toc` provided and
   not for the not-found branch; drawer contains the TOC and selecting an
   entry closes it. Existing focus-restore behavior must keep passing.
5. `useScrollSpy`: no behavior change for Folio (existing tests must pass
   untouched); the options default path is covered by them.

Then implement: `ui/src/docs/toc.ts`, `ui/src/components/docs/DocsToc.tsx`,
edits to `DocsLayout.tsx`, `DocsScreen.tsx`, `useScrollSpy.ts`.

## Task 2 — editor-affordances sections in editor-workflows.mdx

New `###` subsections under **Workflow** (keeping the doc's factual,
limitation-honest voice), sourced from the affordances survey:

- **Format with Markdown shortcuts** — the autoformat table: `# `–`###### `,
  `1. `, `- `/`* `, `[] ` task trigger (document the `[] ` form; explain the
  non-empty-bracket link-scaffold caveat), `> `, `---`, ``` fences with
  language + Enter, inline `*`/`_`/`**`/`__`/`` ` ``, single-tilde `~text~`
  strikethrough, `[text](url)`, `[^id]` footnotes (auto-created definition),
  `$tex$`/`$$tex$$` math, `wiki:`/`arxiv:`/`youtube:` prefixed links,
  auto-pairing and overtype behavior of `*`/`_`.
- **Use keyboard shortcuts and marks** — ⌘/Ctrl B, I, U, E, D (strikethrough),
  `.` (superscript), `,` (subscript); underline/super/subscript are
  keyboard-only and serialize as inline HTML; ⌘/Ctrl+Shift+Enter time heading;
  ⌘/Ctrl+Enter checkbox cycle; note that ⌘D/⌘, inside the editor shadow the
  global journal/preferences shortcuts; ⌘/Ctrl+S save.
- **Work in lists and outlines** — Tab / Shift+Tab indent/outdent, Alt+↑/↓
  block moves, Enter semantics (sibling task inheritance, split, empty-nested
  outdent, empty-top-level exit), Backspace-at-start unwrap; no folding.
- **Edit tasks and their properties** — checkbox click / ⌘Enter cycle / `[] `;
  editor knows only checked/unchecked (`[-]` cancelled is index-level, not an
  editor affordance); **inline properties (`[due:: …]`, `[scheduled:: …]`,
  `[priority:: …]`) and `^blockId` markers are Markdown-level: parsed on load,
  invisible in Folio, re-emitted on save; they cannot be viewed, added, or
  edited in the web editor, and typing one is broken by the link scaffold —
  set them via an external editor (LSP), the CLI, API, or MCP.** Cross-link
  the Tasks doc for syntax and semantics.
- **Use vim mode** — ⌘/Ctrl+Shift+V per-editor toggle, off by default, not
  persisted; status bar; supported subset (motions, operators, text objects,
  counts, visual, `jk` escape); unsupported (registers, macros, marks,
  search, `:` commands).
- Extend **Failures and conflicts** with the table data-loss warning: markdown
  tables are dropped on load and removed from the file by the next body edit.
- Add Tasks doc to **Related**.

MDX care: keep every trigger string inside backticks (brackets, `{`, `<`, and
`[^id]` are otherwise MDX/GFM syntax). Do not change `meta` or the registry.

## Task 3 — gates and merge

- `bun --cwd ui run typecheck`; scoped lint on changed files only (develop is
  NOT repo-wide lint clean — never `biome check --write` broadly);
  `bun --cwd ui run test` (full UI suite). Rust untouched → cargo gates not
  triggered by this change (note in report).
- Review both task diffs, commit on `feature/docs-heading-nav`, merge to
  `develop`, delete the branch.
