# Clepsydra PKM Feature Comparison

**Date:** 2026-08-11

**Compared systems:** Clepsydra, Logseq, markdown-oxide, Quartz, and gwern.net.

## Executive verdict

Clepsydra is no longer an early vault-core prototype. The prior comparison in `docs/design-notes/reference-architecture-analysis.md` is materially stale.

Several items it described as future work are now shipped:

- Composable index derivation: `src/vault/derivation.rs:12-65`, `src/vault/index.rs:318-334`
- Hash-gated incremental indexing and reverse-dependency re-resolution: `src/vault/sync/mod.rs:39-123`, `src/vault/index.rs:427-480`
- First-class unresolved and ambiguous references, candidate ranking, create-from-link, mutation previews, contextual backlinks, graph, search, and content-index APIs: `src/vault/index.rs:939-1278`, `src/api/index_routes.rs:349-933`
- Structured tasks, journals, Bases, academic records/importers, feeds, encryption, browser capture, and MCP
- A full standalone LSP—not merely a planned integration: `ui/src/docs/content/lsp.mdx:7-19,74-88`
- A substantial Slate authoring environment and domain-specific workspaces

Clepsydra’s distinctive position is now:

> **Markdown/TOML remains authoritative, while SQLite supplies typed/queryable read models and the web UI, LSP, CLI, browser extension, and MCP share mutation-safe domain behavior.**

None of the four primary references combines that exact set.

The largest remaining gap is not general PKM functionality. It is the **read/publish layer**:

- Quartz has the strongest general static publication pipeline.
- gwern.net has the strongest long-form reading and contextual-link experience.
- Logseq remains stronger in block-native outlining, plugins, collaboration, and cross-platform packaging.
- markdown-oxide remains a useful reference for editor-neutral, lightweight Markdown intelligence, though Clepsydra now exceeds it in several core indexing and mutation areas.

## Comparative matrix

Legend:

- **Strong** — broad, integrated implementation
- **Present** — shipped but narrower
- **Partial** — meaningful implementation with an important missing layer
- **None** — outside current implementation

| Capability | Clepsydra | Logseq | markdown-oxide | Quartz | gwern.net |
|---|---|---|---|---|---|
| Markdown/files remain authoritative | **Strong** | Partial: legacy file graphs plus DB graphs | **Strong** | **Strong** | **Strong** |
| Stable page identity independent of path | **Strong: UUIDv7** | **Strong: DB entities/UUIDs** | Weak: primarily paths/refnames | Weak: slugs/paths | Weak: URLs/paths |
| Stable block identity | **Present** | **Strong** | Present | Present for rendered OFM refs | Primarily HTML anchors |
| Rich in-app editor | **Strong: Slate** | **Strong: block outliner** | Delegated to host editor | None | None |
| Editor-neutral LSP | **Strong** | Limited/not central | **Strong/core product** | None | None |
| Typed properties and database-like views | **Strong: Bases** | **Strong: properties+Datalog** | Minimal aliases/tags | Frontmatter/index only | Rich build metadata, no view editor |
| Saved query views/grouping/aggregates | **Strong** | **Strong, more expressive DSL** | None | None | None |
| Wikilinks and resolution | **Strong** | **Strong** | **Strong** | **Strong for publishing** | Conventional/internal URLs |
| Unresolved/ambiguous-link intelligence | **Strong** | Present, implicit creation | **Strong but some rough edges** | Partial/dead links | Not applicable in the same form |
| Contextual backlinks | **Strong** | **Strong** | Editor reference locations | Basic published list | **Strongest reading presentation** |
| Create page from dangling link | **Strong, explicit** | **Strong, implicit** | Present via code action | None | None |
| Safe rename/move with link rewrites | **Strong, planned/previewed mutations** | Strong DB transaction semantics | Present via client `WorkspaceEdit` | Alias redirects only | Mostly manual/static |
| Block-reference authoring | **Present** | **Strong** | **Strong LSP support** | Present in OFM | Anchors/transclusion machinery |
| Block content transclusion | **Partial** | **Strong** | Host/editor-dependent | **Strong for static embeds** | **Strongest and most configurable** |
| Full-text search | **Strong: SQLite FTS5** | **Strong** | Symbol/reference lookup, not equivalent FTS | **Strong client-side** | Weak: Google-backed |
| Query language | **Strong typed SQL-backed Bases** | **Strongest general-purpose DSL/Datalog** | None | None | None |
| Knowledge graph UI | **Present** | **Strong** | None | **Strong local/global graph** | None |
| Semantic similarity | Partial: tag Jaccard | Optional vector-search paths | None | None | **Strong build-time embeddings** |
| Tasks and journals | **Strong, domain-specific** | **Strong/core workflow** | Daily-note helpers only | Static pages only | Static pages only |
| Academic library/importers | **Strong domain model** | Strong Zotero/PDF ecosystem | None | None | **Strong metadata enrichment** |
| PDF reading/highlights | Gap | **Strongest here** | None | Browser embed only | PDF tooling/metadata, not Logseq-style UX |
| Inbound RSS/Atom reader | **Strong and unusual** | None/core-adjacent at most | None | None | None |
| Outbound RSS/sitemap publishing | None | Export-oriented, not its main strength | None | **Strong** | Present through static publication |
| Static public publishing | None | Present/export path, less focused | None | **Strongest general solution** | **Strongest bespoke scholarly site** |
| Long-form typography/reader mode | Basic renderer | App/editor focused | Delegated to editor | Good static themes/layout | **Exceptional** |
| Sidenotes/popovers/image focus | Partial previews/basic media | PDF/editor affordances | Hover delegated to editor | Popovers/graph/search | **Exceptional** |
| Plugin ecosystem | No general external plugin API | **Strongest** | LSP itself is the seam | **Strong typed build plugins** | Bespoke build/client modules |
| Agent automation | **Strongest: safety-aware MCP** | Plugin/API automation | LSP commands/actions | Build plugins | Build scripts |
| Incremental dependency-aware indexing | **Strong** | **Strong/reactive transactions** | Partial: per-file, weak propagation | **Strong watch/partial emit** | Mostly full build with caches |
| Multi-user collaboration | None | **RTC implementation, still risky/alpha** | None | Static deployment | Static deployment |
| Mobile/native packaging | Responsive web | **Electron + Capacitor mobile** | Host-editor dependent | Responsive static site | Responsive static site |
| Encryption/privacy controls | **Strong note-body model; attachment gap** | Some crypto/sync mechanisms | Local-process model | Publication-oriented | Publication-oriented |
| Accessibility-first component layer | **Strong direction via React Aria** | Mixed mature app UI | Host editor | Reasonable static UI | Deep custom UI, desktop-heavy |
| Internationalization | Minimal/none evident | Present across app surfaces | Host editor | **Strong: many locales** | Primarily English |

## Clepsydra versus each primary inspiration

### 1. Logseq

#### Where Logseq remains ahead

##### Block-native authoring

Logseq’s core model is hierarchical blocks transacted into DataScript/logseq.db, with UUID identity, parent/sibling traversal, reactive queries, and block-first editing:

- `../logseq/CODEBASE_OVERVIEW.md:1-75`
- `../logseq/src/main/frontend/db/model.cljs:35-177`

Clepsydra parses hierarchy, task state, inline properties, block IDs, parents, order, and source spans, but Markdown documents remain the primary editing unit:

- `src/vault/block.rs:6-103`
- `src/api/blocks.rs:18-223`

This is mostly an intentional divergence. Replacing Clepsydra with a DB-native outliner would undermine its strongest invariant: ordinary files remain independently useful.

##### Query expressiveness

Logseq’s DSL supports boolean composition, page references, properties, tasks, priorities, journal ranges, and full-text predicates:

- `../logseq/src/main/frontend/db/query_dsl.cljs:1-91`

Clepsydra’s Bases are already sophisticated—typed fields, nested `all`/`any`/`not`, relations, grouping, ordered sorts, and aggregates—but are oriented toward structured saved views rather than ad hoc Datalog-style exploration:

- `ui/src/docs/content/bases.mdx:81-189`
- `src/vault/query.rs:1-294`

Potential enhancement: add a discoverable ad hoc query surface over the existing evaluator rather than importing Datalog.

##### Plugins and collaboration

Logseq exposes a broad API for editor, graph, UI, search, commands, storage, and external plugins:

- `../logseq/src/main/logseq/api.cljs:1-183`

It also has RTC graph synchronization, desktop packaging, and Capacitor mobile support:

- `../logseq/src/main/frontend/handler/db_based/rtc.cljs:17-190`
- `../logseq/package.json:42-67,120-160`

Clepsydra has no equivalent multi-user or plugin ecosystem.

Caveat: Logseq’s current repository explicitly describes DB graphs as beta and mobile/RTC paths as alpha, with backup/data-loss warnings:

- `../logseq/README.md:68-77`

That makes it a useful architectural reference, not a safe blueprint to copy wholesale.

#### Where Clepsydra is ahead

- A cleaner file-first/derived-index boundary
- Explicit mutation plans and previews
- Revision-checked writes across UI and MCP
- Typed non-owning Bases that never capture page ownership
- Stronger agent-facing automation
- Dedicated academic, feed-reader, archive/CAS, encryption, and conversation-capture domains
- No long-lived legacy/new graph split

#### Best Logseq-derived enhancements

1. Ad hoc composable query UI over the existing typed evaluator
2. Virtualized journal/time navigation
3. Plugin contracts for commands, query providers, and UI panels—sandboxed and narrower than Logseq’s full API
4. Optional synchronization only after defining conflict, encryption, and recovery semantics
5. More structural block operations without making the DB authoritative

#### Avoid copying

- Parallel legacy-file and DB-native graph architectures
- Global reactive state as the external API
- Broad plugin privileges without a permission model
- RTC/cloud sync before conflict recovery and backups are proven
- Outliner semantics forced onto every document

### 2. markdown-oxide

#### Where markdown-oxide remains ahead

markdown-oxide is unusually focused: an editor-neutral PKM implemented as an LSP. It supports:

- Wiki and Markdown link completion
- Files, headings, blocks, tags, footnotes, and callouts
- References, go-to-definition, hover, rename, code actions
- Unresolved-link diagnostics
- Daily-note completion and navigation
- Document/workspace symbols, code lenses, and semantic tokens

Core evidence:

- `../markdown-oxide/src/main.rs:297-425,476-689`
- `../markdown-oxide/src/completion/mod.rs:21-75`
- `../markdown-oxide/src/codeactions.rs:18-155`
- `../markdown-oxide/src/vault/mod.rs:1193-1371`

Its most useful contribution is not its exact implementation; it is the idea that PKM intelligence should remain usable from Neovim, Helix, VS Code, or another standard editor.

#### Where Clepsydra is now ahead

Clepsydra’s LSP already provides completion, hover, definitions, unresolved and ambiguous diagnostics, create/disambiguate actions, rename, references, symbols, and code lenses:

- `ui/src/docs/content/lsp.mdx:74-88`
- `src/lsp/mod.rs:100-116,335-855,1141-1348`

Beyond LSP parity, Clepsydra has:

- A persisted SQLite read model
- Content-hash gating
- Filesystem watching
- Reverse-dependency invalidation and re-resolution
- Structured metadata and Base-aware diagnostics/completions
- Integrated web mutation workflows
- A mutation planner rather than only client-applied edits

markdown-oxide reconstructs or reparses aggressively and has weaker dependency propagation:

- `../markdown-oxide/src/vault/mod.rs:25-84`
- `../markdown-oxide/src/main.rs:476-539`

Its frontmatter model is also largely aliases-only:

- `../markdown-oxide/src/vault/metadata.rs:5-29`

#### Best markdown-oxide-derived enhancements

1. Block-reference-specific LSP completion, definition, references, and code lenses
2. Footnote/callout completion parity
3. Natural-language daily-note commands
4. Obsidian configuration import for migration ease
5. Thin editor packages that bootstrap the `clep lsp` binary and expose references/search cleanly

#### Avoid copying

- Regex-only Markdown modelling
- Full-vault scans for routine diagnostics
- First-match ambiguity behavior
- Client-applied `WorkspaceEdit` treated as transactionally safe
- Raw paths as identity

### 3. Quartz

#### Where Quartz remains ahead

Quartz is the clearest model for turning an interconnected Markdown corpus into a deployable public garden.

Its pipeline is explicit:

> text/Markdown/HTML transformers → filters → emitters

- `../quartz/quartz/plugins/types.ts:7-64`

Its default stack includes:

- Frontmatter normalization
- Obsidian/GFM syntax
- Wikilinks and embeds
- Syntax highlighting, math, TOC
- Draft filtering
- Alias pages
- Static HTML
- `contentIndex.json`
- RSS and sitemap
- Folder/tag pages
- Static assets, favicon, 404, and OpenGraph images

Evidence:

- `../quartz/quartz.config.ts:84-127`
- `../quartz/quartz/plugins/emitters/contentIndex.tsx:10-158`
- `../quartz/quartz/plugins/transformers/ofm.ts:20-100,180-263`

Its browser affordances are also more complete:

- Local and global graph modes with depth controls
- Tag nodes and visited-state handling
- FlexSearch over title/content/tags
- Explorer state
- Hierarchical tag pages
- SPA navigation
- Themes and numerous locales

Evidence:

- `../quartz/quartz/components/Graph.tsx:8-75`
- `../quartz/quartz/components/scripts/graph.inline.ts:67-154`
- `../quartz/quartz/components/scripts/search.inline.ts:1-90,218-280`
- `../quartz/quartz/components/Explorer.tsx:8-70`

#### Where Clepsydra is ahead

Quartz has no editing/mutation system. Its database is effectively its build artifacts.

Clepsydra already has a richer runtime `content-index` contract and mutable domain model, including:

- Stable UUID identity
- Typed properties
- Search and contextual backlinks
- Unresolved-link repair
- Tasks, journals, academic works, feeds, encryption
- Safe writes through UI/API/MCP
- Dependency-aware incremental indexing
- A full LSP

The key gap is that Clepsydra’s content index is an HTTP read model, not an emitted deployable artifact.

#### Best Quartz-derived enhancement

An **opt-in publishing pipeline**, not a Quartz fork:

```text
Publish profile
    → select explicitly public pages
    → parse and sanitize
    → apply public link/redaction policy
    → derive backlinks/context/similarity
    → emit HTML, contentIndex.json, RSS, sitemap, assets
```

This should reuse Clepsydra page identity and derivation contracts while maintaining a strict public/private boundary.

#### Avoid copying

- Publishing every non-Markdown asset by default
- Shipping the entire private-vault content index to the browser
- Treating meta-refresh alias pages as sufficient for every redirect
- Making SPA body morphing the only navigation path
- Running arbitrary third-party build code inside the primary server process

### 4. gwern.net

#### Where gwern.net remains ahead

gwern.net is not a general PKM editor. It is a highly developed scholarly reading and publication system.

Its major differentiators are:

##### Rich link metadata

The build derives:

- URL annotations
- Local archives
- Backlinks
- Forward link bibliographies
- Similar links
- File-size and source metadata

Evidence:

- `../gwern.net/build/LinkMetadata.hs:11-15,63-95`
- `../gwern.net/build/generateBacklinks.hs:40-79`
- `../gwern.net/build/generateSimilarLinks.hs:14-103`
- `../gwern.net/template/default.html:104-151`

##### Deep transclusion

The transclusion runtime supports:

- Whole documents and fragments
- Range syntax
- Include/exclude selectors
- Block context
- Lazy or strict loading
- Collapsed-section interaction
- Footnote and TOC localization
- Backlink redistribution into inserted content

Evidence:

- `../gwern.net/js/transclude.js:1-190,206-263,1021-1145,1841-2050,2111-2170`

##### Reading affordances

- Draggable/resizable/minimizable popups
- Mobile pop-ins
- Dynamic collision-aware sidenotes
- Reader mode
- Collapsible sections
- Typography normalization
- Image focus/gallery
- No-flash dark mode
- Copyable section links

Evidence:

- `../gwern.net/js/popups.js:11-126`
- `../gwern.net/js/sidenotes.js:1-137`
- `../gwern.net/js/reader-mode.js:1-104`
- `../gwern.net/js/image-focus.js:1-108`
- `../gwern.net/js/typography.js:18-132`

#### Clepsydra’s current gap

Clepsydra has contextual backlinks and link-hover infrastructure, but its generic renderer does not approach gwern.net’s reading system:

- `ui/src/components/MarkdownRenderer.tsx:1-198`

Block references are indexed and represented in Slate, but the current element renders a navigable block-ID token rather than the referenced block’s content:

- `ui/src/editor/elements/BlockRefElement.tsx:8-33`

Thus “block references shipped” is correct, but “gwern-like transclusion shipped” is not.

Clepsydra’s similarity endpoint currently uses tag Jaccard rather than embeddings.

#### Best gwern-derived enhancements

1. Actual block-content transclusion with cycle/depth/error policy
2. Rendered link previews with mobile-safe pop-in behavior
3. Source-span-aware backlink navigation
4. Forward link bibliographies for academic works
5. Optional local semantic similarity
6. Reader mode, image focus, and wide-screen footnote presentation
7. Copy-section links and URL repair suggestions

#### Avoid copying

- The full bespoke global popup/transclusion framework
- Hover-first assumptions as the primary mobile interaction
- Hard-coded display breakpoints
- Google-backed search
- Thousands of lines of generated global CSS/DOM lifecycle machinery
- Embedding jobs before a clear user-facing recommendation workflow exists

## Clepsydra’s strongest current differentiators

### 1. File ownership plus typed database semantics

Bases provide database-like filtering, grouping, aggregates, relation fields, and inline editing without turning pages into owned records:

- `ui/src/docs/content/bases.mdx:7-22,81-103,119-218`

This is a better fit for Clepsydra than Logseq’s DB-first path or Notion/Airtable record ownership.

### 2. Mutation safety

Clepsydra combines:

- Revision checks
- Path locks
- Staged writes
- Mutation previews
- Link rewriting
- Rollback/index compensation
- Backlink-aware deletion behavior

This exceeds markdown-oxide’s client-applied rename and the static systems’ lack of runtime mutation.

The remaining exception is real: board-cycle carryover explicitly lacks a cross-file transaction and may leave the cycle page updated before a later task rewrite fails:

- `src/api/board/cycles.rs:270-278`

### 3. Agent-facing PKM

The MCP surface is deeper and safer than anything in the four references:

- Search/get/list/tree/links/tags
- Revision-checked create/update/edit/append
- Journal and conversation capture
- Metadata-based assignment
- Mutation preview
- Backlink-aware deletion
- Folder operations

Evidence: `ui/src/docs/content/mcp.mdx:44-78`.

### 4. Integrated editor plus external-editor intelligence

Clepsydra does not force a choice between:

- Rich structured in-app editing, and
- Standard Markdown editor use through LSP.

That is a meaningful advantage over Logseq, Quartz, gwern.net, and markdown-oxide individually.

### 5. Domain breadth without abandoning Markdown

Tasks, journals, Bases, feeds, academic works, annotations, imports, browser archive, encrypted notes, and AI conversations all remain projected from or represented by human-readable files.

## Ranked gaps and enhancement opportunities

Complexity estimates are relative to the current architecture.

### Now

#### 1. Close known cross-file atomicity holes — High, S–M

Unify board-cycle carryover and any similar batch mutations under the existing planner/coordinator.

Acceptance target:

- Plan all writes first
- Validate every expected revision
- Publish all or none
- Update/reconcile the index only after filesystem publication
- Surface a dry-run plan where the operation is user-visible

Evidence of the current hole: `src/api/board/cycles.rs:270-278`.

#### 2. Define true block-transclusion semantics — High, M

Current block refs are clickable tokens, not content transclusion.

Required decisions:

- Render referenced content versus only an excerpt
- Recursive references
- Cycle detection
- Maximum depth
- Missing/private/encrypted targets
- Context expansion
- Editing boundaries
- Read-only renderer parity
- LSP preview/definition behavior

Start with one referenced block, read-only, explicit error states, and a hard recursion limit.

#### 3. Encrypt attachments or make protection boundaries impossible to miss — High, M

The UI currently states:

> “Attachments are not encrypted. Only the note body is protected.”

- `ui/src/components/attachments/AttachmentManager.tsx:68-73`

Options:

1. Encrypt CAS blobs and attachment metadata
2. Disallow attachments on protected notes
3. Require an explicit acknowledgement per unencrypted attachment

The first is the correct long-term model but requires a metadata-leakage policy and key-rotation/recovery design.

#### 4. Repair documentation discoverability — Medium, S

The implemented product has outgrown its guides. The in-app registry currently documents Bases and books as its only feature guides, despite tasks, journals, feeds, encryption, graph, archives, academic annotations, and other shipped domains:

- `ui/src/docs/registry.ts:130-146`
- `ui/README.md:43-59`

This is now a product gap: capabilities exist but are difficult to discover.

#### 5. Make unresolved/ambiguous-link repair a first-class UI — Medium, S–M

The backend and LSP are already strong. Add a consolidated repair center:

- Dangling links
- Ambiguous links and ranked candidates
- Orphan/isolated pages
- Broken block refs
- Unresolved relation properties
- Apply/preview resolution
- Bulk safe fixes

Most underlying mechanics already exist.

### Next

#### 6. Decide whether publishing is part of Clepsydra’s product boundary — Strategic decision, S

Do not accidentally grow a public server from the private SPA.

If publishing is desired, define first:

- Explicit opt-in publication profiles
- Visibility inheritance
- Encrypted/private target handling
- Asset policy
- Redaction report
- Broken/private link behavior
- Whether published IDs/paths reveal vault structure

This decision precedes implementation.

#### 7. Build an opt-in Quartz-style publisher — High if in scope, L

Emit:

- Static HTML
- `contentIndex.json`
- RSS/Atom
- Sitemap
- Hierarchical tag/folder pages
- Alias redirects
- Assets
- Backlink/context artifacts
- Deterministic artifact manifest

Reuse the current deriver and content-index models; do not run the live vault API as the public site.

#### 8. Add gwern-style previews without gwern-style complexity — High, M

A smaller design is sufficient:

- 300–500 ms hover intent
- Keyboard/focus activation
- Touch/click pop-in
- One pinned preview at most initially
- Cached rendered summary
- Clear navigation action
- Preview lifecycle independent of editor mutation state

#### 9. Improve discovery surfaces — Medium, M

Current graph/search infrastructure deserves richer UX:

- Local graph depth
- Kind/project/tag filters
- Unresolved and orphan visualization
- Search across pages, blocks, tags, and frontmatter
- Result-type facets
- Clickable backlink source spans
- Hierarchical tag explorer

Quartz provides the interaction reference; Clepsydra should keep server-side indexing.

#### 10. Complete the academic reading loop — Medium–High, M–L

Clepsydra has a stronger domain model than Quartz/markdown-oxide and a safer general system than gwern.net, but it lacks the complete reading experience of Logseq/gwern.

Enhancements:

- Zotero attachment synchronization
- PDF viewer and highlights
- DOI/arXiv/OpenReview source-specific refreshers
- Annotation-to-block links
- Citation-key insertion
- Forward bibliography generation
- Work-to-note and note-to-work navigation

#### 11. Introduce narrow extension contracts — Medium, M

Prefer typed extension points:

- Derivers
- Importers/fetchers
- Exporters
- Command-palette commands
- Search providers
- Renderer extensions
- MCP tool packages

Do not begin with arbitrary in-process plugins. MCP is already the safer external automation seam.

#### 12. Obsidian migration compatibility — Medium, S–M

Borrow markdown-oxide’s configuration import selectively:

- Daily-note location/format
- Link style
- New-note location
- Alias/frontmatter conventions
- Attachment directory

This lowers switching cost without importing Obsidian’s entire plugin/config model.

### Later

#### 13. Local semantic similarity — Medium, L

Use optional local embeddings with:

- Content-hash keyed cache
- Encrypted-page exclusion
- Tag-Jaccard fallback
- Explainable “why related” metadata
- Background throttling
- No remote upload by default

Do this only when there is a clear surface: “related reading,” research discovery, or duplicate-note detection.

#### 14. Long-form reader mode — Medium, M–L

Borrow selectively from gwern.net:

- Read/edit mode separation
- Better footnotes on wide screens
- Image focus
- Copy-section links
- Collapsible appendices
- Print stylesheet
- Stable reading progress

Avoid implementing draggable popup desktops or collision-heavy sidenotes first.

#### 15. Mobile/PWA and i18n — Medium, L

Quartz demonstrates broad static localization; Logseq demonstrates native packaging complexity.

The conservative sequence:

1. Responsive/web installability
2. Offline cache and explicit synchronization state
3. Touch-specific editor testing
4. Localization seams
5. Native packaging only if hardware integration justifies it

#### 16. Collaboration — Low until explicitly required, XL

SSE currently means cache invalidation, not collaborative editing:

- `src/api/events.rs:1-49`

Do not equate the two. Collaboration requires identity, authorization, encryption, merge/conflict semantics, offline queues, recovery, and audit history.

## Secondary inspirations already visible in Clepsydra

The codebase also explicitly borrows from:

- **Obsidian** — file-first Markdown, dangling-link creation, URI compatibility, Bases-style non-owning views
- **Notion** — always-edit interaction and discoverable database controls
- **Airtable** — field configuration clarity
- **Roam** — bidirectional links and block references
- **Andy Matuschak’s notes** — contextual backlinks and low-friction navigation
- **Project Xanadu** — transclusion and bidirectional hypermedia
- **Wikipedia/gwern** — link previews and annotation-oriented navigation

Evidence:

- `docs/affordances.md:55-69`
- `docs/plans/archive/2026-02-13-slatejs-editor-design.md:5-13`
- `docs/superpowers/specs/2026-08-08-bases-frontend-authoring-design.md:31-56`
- `docs/superpowers/plans/2026-08-07-wikilink-resolution.md:15-19`

The existing adaptation choices are generally sound:

- Obsidian/Notion/Airtable affordances without adopting owned records
- Logseq block semantics without making every page an outliner
- markdown-oxide editor neutrality without accepting an ephemeral regex-only index
- Quartz read models without making the application static
- gwern contextual reading without yet importing its bespoke frontend machinery

## Recommended sequence

```text
1. Correctness and trust
   ├─ Cross-file transaction completion
   ├─ Attachment-encryption boundary
   └─ Reference repair center

2. Knowledge-reading loop
   ├─ Real block transclusion
   ├─ Link previews
   ├─ Better backlink/source navigation
   └─ Academic PDF/annotation integration

3. Public/read-only projection
   ├─ Publication visibility model
   ├─ Static emitters
   ├─ RSS/sitemap/content index
   └─ Reader typography and media

4. Ecosystem
   ├─ Narrow extension contracts
   ├─ Obsidian migration
   ├─ Optional semantic similarity
   └─ Mobile/i18n

5. Only with demonstrated demand
   └─ Collaboration/CRDT
```

## Bottom line

Clepsydra should not chase “Logseq parity” or “Quartz parity.”

Its best direction is the intersection:

- **Logseq:** composable knowledge workflows
- **markdown-oxide:** editor-neutral intelligence
- **Quartz:** deterministic public projections
- **gwern.net:** exceptional contextual reading
- **Clepsydra:** file ownership, typed read models, safe mutation, domain depth, and agent-native operation

The immediate work is not another foundational rewrite. The foundation has largely shipped. The next gains come from closing trust gaps, exposing the intelligence already present, and building a deliberate read/publish projection over it.

## Verification note

This report is based on read-only source inspection across all five checked-out repositories, with representative current implementation and test evidence. No files besides this report were changed; builds, lint, and tests were not run because the task was analytical rather than an implementation change.
