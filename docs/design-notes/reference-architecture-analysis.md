# Reference Architecture Analysis

> Cross-codebase synthesis from Logseq, gwern.net, markdown-oxide, and Quartz — informing Clepsydra's feature roadmap.

---

## 1. Derivation Pipeline Abstraction

**What the references do:**

| System | Pipeline Shape | Incrementality |
|--------|---------------|----------------|
| **Logseq** | mldoc AST → extract (refs, tags, properties) → normalize → transact to DataScript. Each file produces a transaction; pipeline hooks in `outliner/pipeline.cljs` run post-transact (backlink rebuild, orphan cleanup). | Transaction-based. Single-file re-parse triggers `db/transact!()`, which fires reactive subscriptions. No full rebuild. |
| **gwern.net** | Multi-pass Haskell: parse MD → extract links → lookup/fetch annotation metadata → generate backlink fragments → generate link-bibliographies → compute embeddings → emit similarity artifacts → render HTML. Each pass writes to `metadata/annotation/` on disk. | Full rebuild per deploy, but annotation metadata is cached (GTX binary format). Embedding recomputation only for changed/new pages. |
| **markdown-oxide** | Single-pass: `MDFile::new()` regex-extracts references, headings, tags, footnotes, indexed blocks simultaneously. No separate "derive" phase — the parse IS the index. | Single-file. `update_vault()` replaces one `MDFile` entry; no dependency propagation. |
| **Quartz** | Unified.js pipeline: text transform → remark-parse (MDAST) → remark-rehype (HAST) → HTML plugins → filter → emit. Plugins hook into each stage. Emitters produce HTML pages, contentIndex.json, RSS, sitemaps, tag/folder pages. | Full rebuild for <128 files; worker-pool parallel for larger. `partialEmit()` supports watch-mode incremental emission. |

**Synthesis for Clepsydra:**

The pipeline should be explicit and staged, not implicit in parsing. The right shape:

```
Parse → Normalize → Resolve → Derive → Persist
```

- **Parse**: pulldown-cmark AST + frontmatter YAML. Already implemented in `vault::link` and `vault::page`.
- **Normalize**: Canonical name derivation, NFC normalization, slug generation. Already implemented in `vault::canonical`.
- **Resolve**: Link target resolution (wikilink text → page ID). Already implemented in `vault::index`. Needs extension for ambiguity tracking (see §3).
- **Derive**: New layer. Pluggable "derivers" that consume resolved links and produce artifacts:
  - `BacklinkDeriver` — reverse link index (already implicit in `links` table)
  - `TagDeriver` — tag → page_id mapping (already implicit)
  - `PropertyRefDeriver` — frontmatter cross-references (implemented)
  - Future: `SimilarityDeriver` (embedding-based, like gwern.net), `PublishIndexDeriver` (contentIndex equivalent, like Quartz)
- **Persist**: Write derived artifacts to SQLite tables or emit to files. Currently the index builder does this monolithically.

**Concrete recommendation:** Extract the derivation logic from `VaultIndex::build()` into a `DerivationPipeline` that takes a parsed `Page` + resolved links and dispatches to registered derivers. Each deriver writes to its own table/artifact. This keeps the index builder thin (just orchestrates parse → resolve → derive → persist) and makes adding new derivations trivial.

Logseq's DataScript rules system is instructive: each "rule" (`:has-ref`, `:page-ref`, `:parent`, `:class-extends`) is a self-contained derivation. We don't need Datalog, but the *pattern* of declaring derivations as composable units is worth adopting.

---

## 2. Incremental Sync Engine

**What the references do:**

| System | File Watching | Dirty Set | Consistency |
|--------|--------------|-----------|-------------|
| **Logseq** | Electron `fs.watch` (desktop only). Mobile/web: manual sync. DB graphs use RTC (CRDT-like WebSocket sync). | `:file/last-modified-at` tracked per file. Only re-parses modified files. Transaction metadata tags source (`:rtc-download-graph?`, `:import-db?`). | DataScript enforces schema; `db-validate/validate-tx-report()` runs before commit. Reactive queries auto-refresh via tx-id keys. |
| **gwern.net** | None (static build). Full rebuild on deploy. | Annotation cache keyed by URL; embedding cache keyed by content hash. Only re-fetches/re-embeds changed items. | No runtime consistency concern (static output). |
| **markdown-oxide** | LSP `textDocument/didChange` + `didOpen`. No filesystem watcher. | Single-file: `update_vault()` replaces one MDFile. **No dependency propagation**: if File A renames and File B links to A, File B is NOT re-indexed. | `Arc<RwLock<Option<Vault>>>` for async safety. Full vault reconstruction on workspace init only. |
| **Quartz** | Chokidar-based file watcher in dev mode. Detects add/change/unlink events. | `partialEmit()` receives `ChangeEvent[]` with affected slugs. Emitters can choose to rebuild only affected outputs. | Single-threaded for small vaults; worker-pool for large. No runtime database. |

**Synthesis for Clepsydra:**

markdown-oxide's "no dependency propagation" is a known weakness. Logseq's transaction-based approach is ideal but heavyweight. The right middle ground:

1. **File watcher**: Use `notify` crate (already in open items). Debounce events, produce a dirty set of changed paths.
2. **Dependency graph**: Maintain a lightweight reverse-dependency map in SQLite: "page X is referenced by pages Y, Z." When X changes, mark Y and Z as needing re-resolution (but not full re-parse — only re-resolve their links to X).
3. **Deterministic re-derivation**: For each dirty page:
   - Re-parse (if content changed)
   - Re-resolve all outgoing links (picks up renames)
   - Re-derive artifacts (backlinks, tags, etc.)
   - For pages in the reverse-dependency set: only re-resolve their links to the changed page (not full re-parse)
4. **Content hash gating**: Store blake3 hash per page (already in schema). Skip re-parse if hash unchanged (handles watcher false positives).

This is more sophisticated than markdown-oxide (which ignores dependencies) but simpler than Logseq's full reactive system. The key insight from Quartz is `partialEmit()` — derivers should accept a set of changed pages and only recompute affected artifacts.

---

## 3. Reference Intelligence UX Primitives

**What the references do:**

| System | Unresolved Links | Ambiguity | "Create from Link" |
|--------|-----------------|-----------|-------------------|
| **Logseq** | Implicit page creation: `[[Nonexistent]]` auto-creates on click. Red styling for unresolved. | Aliases resolve bidirectionally via `:block/alias`. First match wins for ambiguous queries. | Yes — core UX. Clicking any `[[link]]` creates the page if it doesn't exist. |
| **gwern.net** | Three-tier annotation system: fully annotated, partially annotated, unannotated. CSS classes distinguish them. | N/A (static site, links are URLs). | N/A |
| **markdown-oxide** | `Referenceable::UnresolvedFile` / `UnresolvedHeading` / `UnresolvedIndexedBlock` variants. Diagnostics report them as INFORMATION severity. Code actions offer "create file" for unresolved. | First resolved match wins. No tie-breaking, no user-facing ambiguity. | Yes — via LSP code actions. Creates `.md` file at `new_file_folder_path`. |
| **Quartz** | Wikilinks to nonexistent pages render as dead links (no special styling by default). CrawlLinks transformer checks `ctx.allSlugs` during resolution. | Three strategies: `shortest` (prefer files without folder context), `absolute`, `relative`. Configurable per-vault. | No (static build, no creation). |

**Synthesis for Clepsydra:**

Clepsydra should model unresolved/ambiguous references as first-class objects, not just error states:

1. **Unresolved reference object**: When a wikilink `[[Foo]]` doesn't resolve, store it in a `unresolved_links` table with: source page, link text, candidates (pages with similar canonical names), and resolution status.
2. **Ambiguity with candidates**: When multiple pages match (e.g., `notes/Foo` and `archive/Foo` both match `[[Foo]]`), store all candidates. The API returns them ranked by a configurable strategy:
   - **Shortest path** (Quartz-style): prefer `Foo` over `notes/Foo`
   - **Most recent**: prefer the most recently modified candidate
   - **Closest**: prefer pages in the same directory subtree as the source
3. **"Create from unresolved link" action**: API endpoint that takes an unresolved link and creates a new page, then re-resolves. Like Logseq's implicit creation but explicit (user chooses).
4. **Rewrite planner with dry-run**: Before applying link rewrites (rename/move), generate a preview of all changes. Return the plan as JSON (affected files, old text, new text) for UI confirmation. gwern.net's metadata-first approach is relevant: store the plan as a transient artifact before applying.

markdown-oxide's `Referenceable` enum pattern (union type for all linkable items, including unresolved variants) is directly applicable to our Rust codebase.

---

## 4. Unified Mutation Planning

**What the references do:**

| System | Rename/Move Strategy | Atomicity | Reference Update |
|--------|---------------------|-----------|-----------------|
| **Logseq** | `outliner-op` module. Block move → collect affected refs → update `:block/refs` → orphan cleanup. All via `db/transact!()`. | Atomic transaction (DataScript). Validated before commit. Rollback on failure. | Automatic within transaction. `remove-orphaned-page-refs!()` cleans dangling refs. |
| **gwern.net** | Manual (static site). Redirect rules in nginx. | N/A | Manual update of link text in source files. |
| **markdown-oxide** | `rename.rs`: collect all references to target → build `WorkspaceEdit` with text replacements + optional `RenameFile` op. ~260 lines. | **Not atomic**: relies on editor client (Neovim/VSCode) to apply `WorkspaceEdit`. Partial failure possible. | Format-preserving: wiki links stay wiki links, display text preserved. |
| **Quartz** | `AliasRedirects` emitter generates redirect HTML pages for frontmatter aliases. No runtime rename support (static build). | N/A | N/A |

**Synthesis for Clepsydra:**

Clepsydra's existing `LinkRewriter` is closest to markdown-oxide's approach but should evolve toward a unified planner:

1. **Single `MutationPlanner`** for rename, move, and delete. Inputs: operation type + target page(s). Output: a `WorkspacePlan` containing:
   - File operations (rename, move, delete)
   - Text edits (link rewrites in affected files)
   - Index updates (new canonical names, updated links)
2. **Staged application**:
   - Phase 1: Generate plan (pure computation, no side effects)
   - Phase 2: Dry-run preview (return plan as JSON to caller)
   - Phase 3: Apply atomically (write all files, then commit index — or rollback)
3. **Disambiguation modes** (from Quartz's crawl strategies):
   - When rewriting `[[Foo]]` after a move, the planner chooses the new link text based on configured strategy: shortest unambiguous name, absolute path, or relative path.
4. **Delete with reference cleanup**: On delete, the planner identifies all incoming links and offers choices: remove link, convert to unresolved, redirect to another page.

Logseq's transactional approach is the gold standard for consistency. We can approximate it: write all file changes to a tempdir, verify, then atomically swap (rename) into place. The index update happens after successful file writes.

---

## 5. Publish/Read-Model Emitters

**What the references do:**

| System | Output Artifacts | UI Data Contract |
|--------|-----------------|------------------|
| **Logseq** | DataScript DB is the read model. Reactive queries serve UI directly. Export: EDN, SQLite snapshot. | Components subscribe to DataScript entities. Rum reactive mixins auto-refresh. |
| **gwern.net** | Per-page: backlink fragment HTML, link-bibliography HTML, similar-links HTML. Global: metadata DB, embedding DB. All stored as static files in `metadata/annotation/`. | JS fetches annotation fragments lazily. Popups load `metadata/annotation/$URL.html` on hover. |
| **markdown-oxide** | None (LSP protocol IS the read model). | Editor consumes LSP responses directly. |
| **Quartz** | `static/contentIndex.json` — the universal data artifact. Contains: slug, title, links, tags, content (plain text), date, description for every page. Also: sitemap.xml, RSS feed. | Client-side JS loads contentIndex.json. Powers search (FlexSearch), graph (D3/Pixi), backlinks, explorer. |

**Synthesis for Clepsydra:**

Two read models are needed:

1. **API read model** (for the React frontend): Already partially implemented via Axum endpoints returning JSON. Needs enrichment:
   - `/api/vault/graph` — returns node/edge data for graph visualization
   - `/api/vault/backlinks/{path}` — returns backlinks with context snippets (gwern-style)
   - `/api/vault/search?q=...` — full-text search results
   - `/api/vault/tags` — tag hierarchy with page counts

2. **Static export / publish model** (for future static site generation): A Quartz-style `contentIndex.json` equivalent, generated by a `PublishIndexDeriver`:
   - Per-page: slug, title, links, tags, description, date
   - Global: tag hierarchy, folder tree
   - Backlink context fragments (gwern-style derived snippets)
   - Search index data (for client-side FlexSearch or similar)

The gwern.net pattern of per-page derived fragments (backlink HTML, bibliography HTML, similar-links HTML) stored separately is elegant. We can store these as rows in a `derived_artifacts` table with `(page_id, artifact_type, content)` — or emit them as files for static export.

Quartz's `ContentDetails` type is a good contract to target:
```typescript
{ slug, filePath, title, links[], tags[], content, richContent?, date?, description? }
```

---

## 6. Academic Library Domain

**What the references do:**

| System | Citation Model | PDF/Annotation | Import |
|--------|---------------|----------------|--------|
| **Logseq** | Zotero integration via API. Per-profile settings (API key, data dir, attachment handling). `prefer-citekey?` option. Page prefix `@` for citations. | PDF viewer with highlight/annotation. Linked to Zotero items. | Zotero DB import, EDN, SQLite. |
| **gwern.net** | Rich metadata tuple: `(Title, Author, Date, DateCreated, KVs, Tags, Abstract)`. Specialized extractors per source: arXiv, bioRxiv, OpenReview, PDF metadata. Author normalization + linkification. | PDF cleaning tools. Metadata extraction via pdfinfo/exiftool. | Per-source API integration (arXiv, bioRxiv, etc.). |
| **markdown-oxide** | None (not in scope for LSP). | None. | None. |
| **Quartz** | None (static rendering only). | None. | None. |

**Synthesis for Clepsydra:**

Our `002-academic-library.md` spec is well-positioned. Key insights from references:

- **gwern.net's metadata-first model**: Store citation metadata as structured data (not just frontmatter text). The `(Title, Author, Date, DateCreated, KVs, Tags, Abstract)` tuple maps well to our `PageMeta::extra` approach, but we should consider a dedicated `works` table for queryability.
- **Logseq's Zotero integration**: The `prefer-citekey?` pattern (use BibTeX cite key as canonical identifier) aligns with our `cite_key` design. Their per-profile settings model is worth copying.
- **gwern.net's source-specific extractors**: Build an `AnnotationFetcher` trait with implementations for DOI, arXiv, ISBN, etc. Each fetcher returns a normalized `WorkMetadata` struct.
- **Derivation hooks**: Academic features should plug into the derivation pipeline (§1) as a deriver that enriches pages tagged `type: paper` or `type: book` with resolved citation metadata.

---

## 7. Importers (BibTeX/Zotero)

**What the references do:**

- **Logseq**: Full Zotero integration (API key, data directory, attachment linking). Import flow: query Zotero API → create pages with `@prefix` → link attachments. Idempotent-ish (checks for existing pages by cite key).
- **gwern.net**: Per-source API fetchers. Annotation pipeline handles arXiv, bioRxiv, OpenReview, generic URLs. Caches metadata in GTX format. Not user-facing import — it's build-time enrichment.

**Synthesis for Clepsydra:**

Importers should be the *last* feature built (as your roadmap suggests). They depend on stable:
- Page creation API (vault core)
- Citation metadata schema (academic library)
- Derivation hooks (pipeline)

The import contract should be: `BibEntry → Page + WorkMetadata → derive`. Each importer (BibTeX parser, Zotero API client, DOI resolver) produces a normalized intermediate representation that feeds into the standard page creation + derivation flow.

---

## 8. UI Expansion

**What the references do:**

| System | Component Model | State Management | Editor | Graph |
|--------|----------------|-----------------|--------|-------|
| **Logseq** | Rum (ClojureScript React). 600+ components. Block-based outliner editor. | DataScript (in-memory Datalog) + Clojure atoms. Reactive subscriptions. | Block outliner with drag/drop, indentation, folding. Custom mldoc parser. | Built-in graph view (D3). |
| **gwern.net** | Vanilla JS, progressive enhancement. Popups, transclusion, sidenotes, image focus. | No framework state. DOM-driven. Lazy-load annotations on hover. | N/A (static site, no editing). | N/A |
| **Quartz** | Preact SSR → hydrated client components. Layout system (head, header, beforeBody, left, right, afterBody, footer). | Client-side: contentIndex.json loaded once, powers search/graph/backlinks. localStorage for theme/visited state. | N/A (static site). | D3 force simulation + Pixi.js GPU rendering. Local (depth=1) and global modes. |

**Synthesis for Clepsydra:**

Our React 19 + TanStack stack is well-suited. Priority order for UI features:

1. **Page viewer/editor**: Start with rendered markdown view (read-only), then add editing. TipTap or ProseMirror for block-based editing (not an outliner — Logseq's approach is too opinionated). Use react-aria-components for accessibility.

2. **Backlinks panel**: Simple list component consuming `/api/vault/backlinks/{path}`. Show title + context snippet (gwern-style). Quartz's `Backlinks.tsx` is a good minimal reference.

3. **Graph visualization**: D3 force simulation is the standard. Quartz uses Pixi.js for GPU rendering at scale — worth considering for large vaults. Start with local graph (depth=1), add global later. Data contract: `{ nodes: [{id, title, tags}], edges: [{source, target}] }`.

4. **Search**: FlexSearch client-side (like Quartz) for small vaults, server-side SQLite FTS5 for larger ones. The Quartz search component (CJK-aware tokenization, context window highlighting) is a good reference.

5. **Explorer/file tree**: Quartz's `FileTrieNode` structure (trie-based file tree with display names preferring title over filename) is a clean pattern.

6. **Link popups/previews**: gwern.net's popup system (hover delay, smart positioning, drag/resize, minimize/pin) is the gold standard. Start simpler — show rendered preview on hover with a 500ms delay.

7. **Sidenotes**: gwern.net's footnote → sidenote conversion (viewport-dependent, collision-aware) is aspirational. Defer to later.

---

## Roadmap Validation

Your proposed order holds up well against the reference analysis. Refinements:

### Phase 1: Derivation Pipeline (now)
**Validated.** All four references separate parsing from derivation in some form. The abstraction is the right next step after vault-core. Extract derivation from `VaultIndex::build()` into composable derivers.

### Phase 2: Incremental Sync (before more features)
**Validated.** markdown-oxide's lack of dependency propagation is its biggest weakness. Logseq's transaction-based approach is the model to approximate. The `notify` crate + content-hash gating + reverse-dependency map is the right approach.

### Phase 3: Reference Intelligence UX (before UI expansion)
**Validated and enriched.** markdown-oxide's `Referenceable` enum with unresolved variants is directly applicable. Quartz's disambiguation strategies (shortest/absolute/relative) should be configurable. gwern.net's three-tier annotation model (fully annotated → partial → unannotated) is worth adopting for link quality signals.

### Phase 4: Unified Mutation Planning
**Validated.** markdown-oxide's `rename.rs` is a good starting point but lacks atomicity. Logseq's transactional approach is the target. Staged application (plan → preview → apply) is the right UX.

### Phase 5: Publish/Read-Model Emitters
**Validated and clarified.** Two read models: API (for React frontend) and static export (Quartz-style contentIndex.json). gwern.net's per-page derived fragments pattern is worth adopting for backlink context.

### Phase 6: Academic Library
**Validated.** Should wait for stable derivation hooks. gwern.net's annotation pipeline and Logseq's Zotero integration inform the design.

### Phase 7: Importers
**Validated.** Last, as planned. Depends on everything above.

### Phase 8: UI Expansion
**Validated.** Build against stable API contracts. Priority: page viewer → backlinks → graph → search → explorer → popups.

---

## Cross-Cutting Concerns

### Path Normalization
- **Clepsydra** (VaultPath): NFC-normalized, percent-encodes `/` and `%` in slugs. Most sophisticated.
- **Quartz** (FullSlug/SimpleSlug): Nominal types via branding, NFC normalized. Good type safety.
- **markdown-oxide**: Raw `PathBuf`, URL decoding for comparison. Fragile.
- **Logseq**: Namespace encoding (`___` → `/`), multiple filename format versions (v0, v1, v2+). Complex.

**Recommendation:** Our VaultPath approach is sound. Consider adopting Quartz's nominal type branding for the TypeScript side (FullSlug vs SimpleSlug vs RelativeURL as branded string types).

### Configuration Layering
- **markdown-oxide**: `.moxide.toml` → `~/.config/moxide/settings.toml` → Obsidian config → defaults.
- **Quartz**: `quartz.config.ts` (TypeScript, single source of truth).
- **Logseq**: In-DB settings + localStorage preferences.

**Recommendation:** Our existing layering (defaults → `config.toml` → env vars) is fine. Consider adding `.clepsydra/config.toml` vault-level overrides (already designed) and Obsidian config compatibility reading (like markdown-oxide) for migration ease.

### Plugin/Extension Architecture
- **Logseq**: 170+ API functions. Plugin-scoped storage. Slash commands, UI items, search services.
- **Quartz**: Plugin = transformer | filter | emitter. Compose via config.

**Recommendation:** Defer formal plugin API. The derivation pipeline (§1) is the internal extension point. External plugins can wait until the core is stable.
