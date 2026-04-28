# Vault Core

Filesystem-backed vault with CRUD operations on pages, folders, and attachments — including a persistent link index with automatic backlink updates on rename/move.

## Overview

Clepsydra's vault is a directory of Markdown files that constitutes a user's digital garden. The filesystem is the source of truth: `.md` files on disk are canonical, and the server builds an in-memory index (backed by SQLite) to support fast queries and link integrity.

Every page has a triple identity:
- A **stable UUID** persisted in YAML frontmatter (survives renames).
- A **vault-relative path** (human-readable, used in the filesystem).
- A **canonical name** — a normalized, lowercase, Unicode-folded key derived from the page title or filename. Used for case-insensitive link resolution and alias matching (inspired by Logseq's `:block/name`).

The API accepts UUID or path for lookups. When a file is renamed or moved, the server uses the link index to rewrite all references across the vault, preserving graph integrity.

The vault stores its configuration and cache in a `.clepsydra/` directory at the vault root, separate from the server-level `config.toml` that tells the server *where* the vault lives.

## User Stories

### Primary Story

As a knowledge worker,
I want to create, organize, rename, and delete pages and folders in my vault through an API,
so that I can manage my digital garden programmatically and through the Clepsydra UI.

### Supporting Stories

- As a writer, I want to rename or move a page and have all links to it update automatically, so that my internal references never break.
- As a user, I want every page to carry a stable UUID in its frontmatter, so that external tools and future features can reference pages by identity rather than path.
- As a user, I want to attach images and files to my vault in a dedicated folder, so that assets are organized separately from prose.
- As a user, I want the server to index my vault on startup and keep the index current, so that queries against the link graph, tags, and metadata are fast.
- As a user who edits files externally (Neovim, Obsidian, etc.), I want the server to detect changes and re-index affected files, so that the index stays consistent without requiring a restart.

## Proposal

### Approach

Build a layered architecture in the Rust backend:

1. **Vault layer** — owns the vault root path, resolves files, enforces path safety (no traversal outside root).
2. **Page layer** — reads/writes Markdown files, parses and writes YAML frontmatter, assigns UUIDs.
3. **Index layer** — maintains an in-memory link graph, tag set, and metadata cache, backed by SQLite for persistence across restarts.
4. **API layer** — Axum routes that expose CRUD operations and queries over the vault.

The frontend is out of scope for this spec (it will consume the API in a later feature).

### Key Components

1. **`Vault`** — Resolves the vault root, provides path utilities (`resolve`, `relative`, `exists`, `is_page`, `is_attachment`), and owns the `.clepsydra/` config directory. Guards against path traversal.
2. **`Page`** — Represents a Markdown file: its vault-relative path, raw content, parsed frontmatter (`PageMeta`), and body text.
3. **`PageMeta`** (frontmatter) — Structured YAML frontmatter: `id` (UUID), `title`, `tags`, `aliases`, `created_at`, `updated_at`, plus an escape hatch for arbitrary keys.
4. **`CanonicalName`** — Normalized lookup key derived from title (or filename stem if no title). Lowercase, Unicode NFC-normalized, whitespace-collapsed. Stored in the index alongside path and title. Used for case-insensitive link resolution.
5. **`VaultIndex`** — In-memory graph of pages, links (outgoing references parsed from each file), and reverse links (computed). Backed by SQLite tables for persistence. Maintains a `canonical_name → page_id` lookup map for fast resolution.
6. **`LinkRewriter`** — Given a rename/move operation and the index, rewrites wikilinks (`[[old]]` → `[[new]]`) and Markdown links (`[text](old.md)` → `[text](new.md)`) in all affected files.
7. **`VaultConfig`** — Reads `.clepsydra/config.toml` for vault-level settings (attachment folder, excluded patterns, default new-page location).
8. **API router** — Axum subrouter mounted at `/api/vault/` exposing page, folder, and attachment endpoints.

### Technical Details

#### Data Model (Rust)

```rust
/// Parsed YAML frontmatter for a page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageMeta {
    pub id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    /// Arbitrary additional frontmatter keys.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

/// A parsed page in memory.
pub struct Page {
    /// Vault-relative path (e.g. "projects/clepsydra/design.md").
    pub path: VaultPath,
    /// Normalized lookup key (lowercase, NFC, whitespace-collapsed).
    /// Always derived — never stored in frontmatter or user-editable.
    /// Re-derived from title (if present) or filename stem on every index build.
    pub canonical_name: CanonicalName,
    pub meta: PageMeta,
    /// Markdown body (everything after the frontmatter fence).
    pub body: String,
    /// Outgoing references parsed from body.
    pub links: Vec<Link>,
}

/// Normalized, case-insensitive lookup key.
/// Invariants: lowercase, Unicode NFC, runs of whitespace collapsed to single space, trimmed.
/// Constructed via `CanonicalName::from_title()` or `CanonicalName::from_filename()`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalName(String);

/// A reference from one page to another.
pub struct Link {
    /// The raw reference text (e.g. "design" from [[design]], or "design.md" from [text](design.md)).
    pub target_raw: String,
    /// Resolved target path (if resolvable).
    pub target_path: Option<VaultPath>,
    /// Byte range of the link syntax in the source file, for rewriting.
    pub span: Range<usize>,
    pub kind: LinkKind,
}

pub enum LinkKind {
    /// [[target]] or [[target|display]]
    Wiki,
    /// [display](target.md)
    Markdown,
    /// Reference from a frontmatter property (tags, aliases, or other linkable fields).
    /// source_field records which property produced the edge (e.g. "tags", "aliases").
    PropertyRef { source_field: String },
}

/// Newtype for vault-relative paths. Always forward-slash separated, no leading slash.
/// Normalized to Unicode NFC at construction time to avoid composed/decomposed
/// duplicates (e.g. macOS NFD filenames). All comparisons and index keys use the
/// NFC-normalized form.
pub struct VaultPath(String);
```

#### Canonical Name Derivation

The `canonical_name` is the primary lookup key for case-insensitive link resolution. It is **always derived**, never stored in frontmatter or user-editable. The raw `title` field is preserved untouched for display fidelity; `canonical_name` is a computed index artifact re-derived on every index build.

**Invariant**: `canonical_name` is never persisted in the Markdown file itself — it exists only in the SQLite index and in-memory graph. If the derivation algorithm changes, a full re-index produces correct results with no file migration.

**Algorithm** (`CanonicalName::new(input: &str) -> Self`):
1. Unicode NFC normalization (compose decomposed characters).
2. Lowercase (Unicode-aware, not just ASCII).
3. Collapse runs of whitespace to a single space.
4. Trim leading/trailing whitespace.
5. Strip `.md` extension if present.

**Derivation priority**: `title` frontmatter field → filename stem (path's final component without `.md`).

**Alias handling**: Each alias in `PageMeta::aliases` also produces a `CanonicalName` entry in the index lookup map, pointing to the same page ID.

**Collision semantics**: If two pages produce the same `canonical_name` (e.g., `Design Notes` and `design-notes`), the index marks both as **ambiguous** for that name. Link resolution against an ambiguous name returns an `Ambiguous` result with the list of candidates rather than silently picking one.

#### Filename & Slug Escaping Policy

When the API creates a file from a title (e.g., `POST /pages` with `title` but no explicit path), the title must be converted to a safe filename.

**Slug rules** (`VaultPath::from_title(title: &str) -> Self`):
1. Unicode NFC normalization.
2. Percent-encode `%` → `%25` (must come first to avoid double-encoding).
3. Percent-encode `/` → `%2F` (preserves namespace separators reversibly).
4. Replace characters illegal on Windows/macOS/Linux (`<>:"\|?*`, control chars, leading/trailing dots/spaces) with `-`.
5. Collapse runs of `-` to a single `-`.
6. Trim leading/trailing `-`.
7. Truncate to 200 bytes (UTF-8 safe, split on character boundary; never split a `%XX` sequence).
8. Append `.md`.

**Round-trip**: The encoding is *reversible* for `/` and `%` (via percent-encoding); other illegal characters are lossy-replaced with `-`. The canonical title lives in frontmatter, not the filename — the filename is a convenience for filesystem browsing. `VaultPath::decode_slug()` reverses percent-encoding to recover the original title's `/` structure.

**Cross-platform safety**: Filenames are validated on write to reject names that are invalid on any of Windows/macOS/Linux (NUL, CON, PRN, etc.). This is enforced in `VaultPath` validation, not just slug generation.

#### Link Extraction Strategy

Links are extracted using **AST-based parsing** via `pulldown-cmark`, not regex. This ensures correctness in the presence of code blocks, HTML blocks, and nested Markdown constructs.

**Parsing approach**:
1. Parse the Markdown body into a `pulldown-cmark` event stream.
2. Track whether the current position is inside a code block (fenced or indented) or inline code span — skip link extraction in these contexts.
3. Extract **standard Markdown links** directly from `Event::Start(Tag::Link)` events, recording the byte offset from the source map.
4. For **wikilinks** (`[[target]]`, `[[target|display]]`): these are not part of the CommonMark spec, so `pulldown-cmark` emits them as raw text. Apply a targeted regex *only* on text events that are *not* inside code spans/blocks to find wikilink syntax and record byte spans.

This hybrid approach (AST for structure-awareness + regex for wikilink syntax within safe regions) gives correctness without requiring a custom Markdown parser.

**Explicitly skipped contexts**:
- Fenced code blocks (``` and ~~~)
- Indented code blocks
- Inline code spans (`` ` ``)
- HTML blocks and inline HTML

**Explicitly included contexts** (links are extracted from these):
- Regular paragraph text
- List items
- Block quotes
- Headings

#### Frontmatter Property References

Frontmatter fields are not just metadata rows — they produce **graph edges** stored in the `links` table with `kind = 'property_ref'`:

- **`tags`**: Each tag value creates a `PropertyRef` edge from the page to a virtual tag node. This enables tag-based graph queries (e.g., "all pages tagged X") via the same link infrastructure used for body links. Tags that match a page's canonical name also resolve as page-to-page edges.
- **`aliases`**: Each alias creates a `CanonicalName` entry (as before for resolution) and also a `PropertyRef` self-edge, making the alias relationship visible in the graph.
- **Other linkable properties**: Arbitrary frontmatter values that look like page references (matching `[[...]]` syntax or bare names that resolve to existing pages) are extracted as `PropertyRef` edges. This is opt-in: only fields explicitly configured as "linkable" in vault config are scanned (default: `tags`, `aliases`).

This mirrors Logseq's treatment of property values as first-class refs, ensuring the graph captures the full reference topology — not just body links.

#### SQLite Schema (`.clepsydra/cache.db`)

```sql
CREATE TABLE pages (
    id              TEXT PRIMARY KEY,   -- UUID
    path            TEXT NOT NULL UNIQUE,
    title           TEXT,
    canonical_name  TEXT NOT NULL,      -- Normalized lookup key (lowercase, NFC)
    created_at      TEXT,               -- ISO 8601
    updated_at      TEXT,
    meta_json       TEXT NOT NULL,      -- Full frontmatter as JSON for flexible queries
    content_hash    TEXT NOT NULL       -- Blake3 hash of file content, for staleness detection
);

-- Maps canonical names (including aliases) to page IDs.
-- Multiple rows per page (one for the primary name, one per alias).
-- If two pages share a canonical_name, both appear here → ambiguous.
CREATE TABLE canonical_names (
    canonical_name  TEXT NOT NULL,
    page_id         TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,      -- 'title' | 'filename' | 'alias'
    PRIMARY KEY (canonical_name, page_id)
);

CREATE TABLE links (
    source_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_raw      TEXT NOT NULL,      -- Raw reference string as written
    target_canonical TEXT,              -- Normalized form of target_raw for resolution
    target_id       TEXT REFERENCES pages(id),  -- NULL if unresolved
    target_path     TEXT,               -- Resolved vault-relative path
    kind            TEXT NOT NULL,      -- 'wiki' | 'markdown' | 'property_ref'
    source_field    TEXT,               -- For property_ref: which frontmatter field (e.g. 'tags', 'aliases')
    span_start      INTEGER NOT NULL,
    span_end        INTEGER NOT NULL,
    PRIMARY KEY (source_id, span_start)
);

CREATE TABLE tags (
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (page_id, tag)
);

CREATE INDEX idx_pages_path ON pages(path);
CREATE INDEX idx_pages_canonical ON pages(canonical_name);
CREATE INDEX idx_canonical_names_name ON canonical_names(canonical_name);
CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_target_path ON links(target_path);
CREATE INDEX idx_links_target_canonical ON links(target_canonical);
CREATE INDEX idx_tags_tag ON tags(tag);
```

#### API Endpoints

All paths are under `/api/vault`. Path parameters use URL-encoded vault-relative paths.

**Pages**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pages` | List all pages. Query params: `tag`, `folder` (prefix filter), `q` (full-text search — future). Returns `PageSummary[]`. |
| `GET` | `/pages/*path` | Get a single page by vault-relative path. Returns full `Page` (meta + body). |
| `GET` | `/pages/by-id/:uuid` | Get a single page by UUID. Returns full `Page`. |
| `POST` | `/pages/*path` | Create a new page at the given path. Body: `{ title?, tags?, body? }`. Auto-generates UUID and timestamps. 409 if exists. |
| `PUT` | `/pages/*path` | Update page content. Body: `{ meta?, body? }`. Updates `updated_at`. |
| `DELETE` | `/pages/*path` | Delete a page. Query params: `force=true` to delete even if backlinked; `rewrite=plain_text\|unlink\|none` controls how references in other files are handled (see Delete Behavior below). Without `force`, returns 409 with list of referencing pages. |
| `POST` | `/pages/*path/move` | Rename or move a page. Body: `{ destination: "new/path.md" }`. Rewrites backlinks across vault. |

**Folders**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders` | List top-level folders. |
| `GET` | `/folders/*path` | List contents of a folder (pages + subfolders). Returns `FolderListing`. |
| `POST` | `/folders/*path` | Create a folder (and intermediate parents). |
| `DELETE` | `/folders/*path` | Delete an empty folder. Query param: `recursive=true` to delete with contents. |
| `POST` | `/folders/*path/move` | Rename or move a folder. Body: `{ destination: "new/path" }`. Rewrites backlinks for all contained pages. |

**Attachments**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/attachments` | List all attachments. |
| `GET` | `/attachments/*path` | Serve an attachment file (binary). |
| `POST` | `/attachments` | Upload an attachment. Multipart form data. Returns the vault-relative path in the attachments folder. |
| `DELETE` | `/attachments/*path` | Delete an attachment. |

**Index / Graph**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/index/backlinks/*path` | Get all pages that link to the given page. |
| `GET` | `/index/outlinks/*path` | Get all pages that the given page links to. |
| `GET` | `/index/unresolved` | List all unresolved links across the vault (includes ambiguous with candidate lists). |
| `GET` | `/index/ambiguous` | List canonical names that resolve to 2+ pages. |
| `GET` | `/index/warnings` | Diagnostics: duplicate UUID repairs, malformed frontmatter, excluded-but-linked files. |
| `GET` | `/index/tags` | List all tags with page counts. |
| `GET` | `/index/stats` | Vault statistics: pages, links (resolved/unresolved/ambiguous), tags, attachments. |
| `POST` | `/index/rebuild` | Force a full re-index of the vault. |

#### Vault Config (`.clepsydra/config.toml`)

```toml
[vault]
# Folder for attachments, relative to vault root.
attachment_folder = "_attachments"

# Patterns to exclude from indexing and listings.
# Supports prefix paths and glob patterns (evaluated by the `glob` crate).
# Prefix paths are relative to vault root. Leading "/" is optional and ignored.
excluded_patterns = [
    ".clepsydra",
    ".clepsydra/**",
    "_attachments",
    "_attachments/**",
    ".git",
    ".git/**",
    "node_modules",
    "node_modules/**",
]

# Default location for new pages when no path is specified.
default_page_folder = ""

# Frontmatter fields whose values produce graph edges (PropertyRef links).
# Default: tags and aliases. Add custom fields to extend.
linkable_properties = ["tags", "aliases"]
```

#### Server Config Addition (`config.toml`)

```toml
[server]
host = "127.0.0.1"
port = 3000

[vault]
# Absolute or relative path to the vault root directory.
root = "./vault"
```

#### Link Rewriting Strategy

When a page at path `A` is moved to path `B`:

1. Query the index for all pages whose `links` table has `target_path = A`.
2. For each referencing page, read the file content.
3. For each matching link span:
   - **Wikilinks** `[[A]]` → `[[B]]` (using the shortest unambiguous path, like Obsidian).
   - **Wikilinks with display** `[[A|text]]` → `[[B|text]]`.
   - **Markdown links** `[text](A.md)` → `[text](B.md)` (relative path recalculated from the referencing file's location).
4. Write updated files back to disk.
5. Update the index (source files' link spans + moved file's path).

Rewriting operates on byte spans from the index, applied in reverse order (highest offset first) to avoid invalidating earlier spans.

**Ambiguity during rewrite**: If a move causes the new path's filename to collide with an existing page (making wikilinks ambiguous), the move endpoint returns **409** with the list of conflicting pages. The client must either choose a different destination or supply a `disambiguation: "use_full_path"` option in the request body, which forces all rewritten wikilinks to use the full vault-relative path rather than the shortest unambiguous form.

#### Duplicate UUID Conflict Handling

When two files share the same frontmatter `id` (e.g., a copied file), the index builder resolves the conflict deterministically:

1. **Detect**: During index build/sync, if a UUID from a file already exists in the `pages` table with a different path, flag a conflict.
2. **Resolve**: The file with the **older `created_at`** timestamp (or earlier filesystem `mtime` if no `created_at`) keeps the UUID. The other file gets a new UUID generated and written back to its frontmatter.
3. **Emit**: A structured warning event is logged (and surfaced via `GET /index/warnings` — a lightweight diagnostics endpoint) so the user knows a regeneration occurred.
4. **Idempotent**: Re-indexing the same vault produces the same outcome. The "loser" file's new UUID is persisted to disk immediately, so subsequent runs see no conflict.

#### Link Resolution & Ambiguity Policy

Link resolution is case-insensitive and alias-aware, using the `canonical_names` table.

**Resolution algorithm** for a raw link target (e.g., `design notes` from `[[Design Notes]]`):
1. Normalize the target to a `CanonicalName`.
2. Query `canonical_names` for all `page_id`s matching that name.
3. **0 matches** → link is **unresolved**. Stored in `links` with `target_id = NULL`.
4. **1 match** → link is **resolved**. Store the target `page_id` and `path`.
5. **2+ matches** → link is **ambiguous**. Stored with `target_id = NULL` and a separate `ambiguous` flag. Surfaced in `GET /index/unresolved` with the list of candidates.

**Disambiguation by path prefix**: If the raw target includes a path component (e.g., `[[projects/design notes]]`), the resolver filters candidates by path prefix before canonical matching. This narrows to at most one result in most cases.

**Deterministic fallback**: The API never silently picks a "first match." Ambiguous links are explicitly unresolved until the user disambiguates (by editing the link to include a path prefix, or by renaming one of the conflicting pages).

#### Delete Behavior & Reference Rewriting

When `DELETE /pages/*path?force=true` is used, the `rewrite` query param controls how references in other files are handled:

| `rewrite` value | Behavior |
|-----------------|----------|
| `plain_text` (default) | Replace `[[deleted page]]` with `deleted page` (plain text, no link syntax). Replace `[display](deleted.md)` with `display`. Graceful degradation — the text remains readable. |
| `unlink` | Replace link syntax with a visible marker: `[[deleted page]]` → `~~deleted page~~` (strikethrough). Makes deletions visible in rendered output. |
| `none` | Leave references untouched. Links become unresolved (broken). The index marks them accordingly. |

**Transactional safety**: Delete-with-rewrite is a multi-file operation that must not leave the vault in a mixed state. The implementation uses a staged-write approach:
1. Compute all rewrites in memory (new file contents for each affected file).
2. Write each rewritten file to a temporary sibling (e.g., `page.md.clepsydra-tmp`).
3. Delete the target page file.
4. Atomically rename each `.clepsydra-tmp` file to its final name (on POSIX, `rename(2)` is atomic within a filesystem).
5. Update the SQLite index within a single transaction.
6. On failure at any step, remove `.clepsydra-tmp` files and leave originals untouched.

The same staged-write pattern applies to rename/move backlink rewriting.

When `force` is not set and backlinks exist, the 409 response includes:
```json
{
  "error": "page_has_backlinks",
  "backlinks": [
    { "path": "projects/log.md", "link_count": 2 },
    { "path": "index.md", "link_count": 1 }
  ],
  "hint": "Use ?force=true&rewrite=plain_text to delete and rewrite references."
}
```

#### Startup / Index Lifecycle

1. Server reads `config.toml` → resolves vault root.
2. Opens (or creates) `.clepsydra/cache.db`.
3. Walks the vault directory, computing content hashes for each `.md` file.
4. Compares hashes against the `pages` table:
   - **Match** → skip (already indexed).
   - **Mismatch or missing** → re-parse file, update/insert rows.
   - **In DB but missing on disk** → delete rows.
5. Detects and resolves duplicate UUID conflicts (see Duplicate UUID Conflict Handling).
6. Rebuilds `canonical_names` table from current page titles, filenames, and aliases.
7. Resolves all unresolved links via canonical name matching (see Link Resolution & Ambiguity Policy).
8. Builds the in-memory graph from the now-current DB.

This makes startup fast for unchanged vaults (hash comparison only) and self-healing for external edits.

### Scope Boundaries

**In scope:**
- CRUD for pages (.md files), folders, and attachments
- YAML frontmatter parsing/writing with UUID auto-assignment
- Persistent SQLite-backed link index
- Automatic backlink rewriting on rename/move
- Canonical name derivation and case-insensitive link resolution
- Duplicate UUID detection and auto-repair
- Deterministic ambiguity handling (never silent first-match)
- Configurable delete-with-rewrite behavior
- Glob-based exclusion patterns
- Filename slug generation from titles (cross-platform safe)
- Post-move hook extension point (`PostMoveHook` trait) for domain modules to react to page renames/moves
- `.clepsydra/templates/` directory for page templates (created by `init`)
- Vault-level config in `.clepsydra/config.toml`
- Server-level vault root config in `config.toml`
- API endpoints (JSON over HTTP, no auth)
- Path safety (no traversal outside vault root)

**Path hierarchy semantics** (explicit decision):

Clepsydra treats folder paths as **filesystem organization only**, not as semantic namespaces. A page at `projects/clepsydra/design.md` does not imply the existence of a `projects/clepsydra` page or a `projects` page. Folders are inert containers — they have no metadata, no frontmatter, and no graph identity. This is the Obsidian model, not the Logseq/Dendron namespace model.

Rationale: Semantic namespace pages (where `a/b` auto-creates parent `a`) add significant complexity (implicit page creation, namespace page deletion semantics, parent-child link generation) with unclear benefit for Clepsydra's use case. If namespace semantics are desired later, they can be layered as an opt-in convention (e.g., a page named `projects.md` that serves as a folder index) without requiring structural changes to the vault model.

**Out of scope:**
- Document editor / rich text editing (separate feature)
- Real-time collaboration or WebSocket push
- Authentication / authorization
- Full-text search (future; the index schema supports it but the API defers it)
- File watching / live re-index on external changes (future; will use `notify` crate)
- Multi-vault support
- Semantic namespace pages (path hierarchy implies page existence) — see above
- Frontend UI components
- LSP integration (separate feature, will consume the index)
- Block-level references (`^block-id` syntax — future extension of the link model)

## Alternatives Considered

### Alternative A: Database-First (content in SQLite)

- **Approach**: Store page content in the database as the source of truth. Export to .md files on demand.
- **Pros**: Simpler consistency model; atomic operations; easy full-text search via FTS5.
- **Cons**: Files are no longer portable or git-friendly. External editors (Neovim, Obsidian) can't edit directly. Defeats the "plain Markdown" philosophy.
- **Why not chosen**: Clepsydra's identity is as a tool that works *with* the filesystem, not *instead of* it. Portability and external-editor compatibility are non-negotiable.

### Alternative B: No Persistent Index (scan on demand)

- **Approach**: Parse all vault files on every query or mutation. No SQLite cache.
- **Pros**: Zero infrastructure — no DB, no cache invalidation concerns.
- **Cons**: O(n) on every operation. A vault with 10,000 pages would make rename/backlink-update painfully slow. Startup would be instant but every query would be slow.
- **Why not chosen**: The backlink-update-on-rename requirement makes this impractical at scale.

### Alternative C: Path-Only Identity (no UUIDs)

- **Approach**: Address pages solely by vault-relative path. No frontmatter UUIDs.
- **Pros**: Simpler — no need to inject metadata into files. Works for basic CRUD.
- **Cons**: Rename breaks any external reference. Future features (cross-vault links, sync, export) have no stable anchor. Logseq demonstrated the value of content-addressing.
- **Why not chosen**: UUIDs are cheap to add now and expensive to retrofit later. They also enable the "get by ID" API pattern cleanly.

## Implementation Plan

### Prerequisites

- [ ] Add Rust dependencies: `uuid` (v7 feature), `chrono`, `serde_yaml`, `rusqlite` (with `bundled` feature), `blake3`, `walkdir`, `pulldown-cmark`, `regex` (for wikilink extraction within safe AST regions), `unicode-normalization`, `glob`
- [ ] Add `[vault]` section to `config.toml` and `Settings` struct

### Phase 1: Vault Foundation

Core vault abstraction, path safety, naming, and configuration.

- [ ] Implement `VaultPath` newtype with validation (no `..`, no absolute, normalized separators, cross-platform filename safety, NFC-normalized at construction)
- [ ] Implement `VaultPath::from_title()` slug generation (NFC, percent-encode `/` → `%2F` and `%` → `%25`, strip illegal chars, truncate)
- [ ] Implement `VaultPath::decode_slug()` to reverse percent-encoding for display
- [ ] Implement `CanonicalName` newtype with `from_title()` and `from_filename()` constructors (NFC, lowercase, whitespace collapse)
- [ ] Implement `Vault` struct: owns root path, resolves `VaultPath` → absolute `PathBuf`, guards traversal
- [ ] Implement `VaultConfig`: reads `.clepsydra/config.toml`, provides defaults, parses `excluded_patterns` as glob patterns
- [ ] Implement `clepsydra init` CLI command: creates `.clepsydra/` dir, `.clepsydra/templates/` dir, default `config.toml`, attachment folder
- [ ] Update `Settings` to include `vault.root`, wire into server startup
- [ ] Unit tests for path resolution, traversal prevention, slug generation (including `%2F` round-trip), canonical name derivation, glob-based exclusion matching
- [ ] Unit tests for NFC path normalization: NFD input → NFC-normalized `VaultPath`, no duplicate entries from composed/decomposed variants
- [ ] Unit tests for canonical name edge collisions: `"A  B"` vs `"A B"` (whitespace collapse), `"design-notes"` vs `"Design Notes"` (case + punctuation), trailing dots, em-dashes vs hyphens — verify each pair either collapses (intentional) or stays distinct (with ambiguity flagged)

### Phase 2: Page Model and Frontmatter

Read/write pages with structured frontmatter.

- [ ] Implement `PageMeta` serde model (YAML frontmatter)
- [ ] Implement frontmatter parser: split `---` fences, deserialize YAML, return `(PageMeta, body)`
- [ ] Implement frontmatter writer: serialize `PageMeta` to YAML, prepend fences to body
- [ ] Implement `Page` struct with `from_file()` and `to_file()` methods
- [ ] UUID auto-assignment: generate `Uuid::new_v7()` on page creation, preserve existing on read
- [ ] Handle files with no frontmatter (add it), malformed frontmatter (preserve as raw string, warn)
- [ ] Duplicate UUID detection: on parse, if UUID collides with another file, regenerate for the newer file and write back
- [ ] Unit tests for round-trip frontmatter parsing/writing, UUID assignment, duplicate UUID resolution

### Phase 3: SQLite Index

Persistent index with content-hash-based staleness detection and canonical name resolution.

- [ ] Create SQLite schema (pages, canonical_names, links, tags tables + indexes)
- [ ] Implement AST-based link extractor: `pulldown-cmark` event stream → skip code blocks/spans → extract Markdown links from `Tag::Link` events → regex for wikilinks in safe text regions → produce `Vec<Link>` with byte spans
- [ ] Implement frontmatter property ref extraction: scan configured linkable fields (`tags`, `aliases`, and vault-config-specified fields) → produce `PropertyRef` links in the `links` table
- [ ] Implement `canonical_names` table population: for each page, insert rows for title-derived name, filename-derived name, and each alias
- [ ] Implement index builder: walk vault → hash files → diff against DB → parse changed files → upsert → detect duplicate UUIDs → rebuild canonical_names
- [ ] Implement link resolution via canonical names: normalize `target_raw` → query `canonical_names` → 0/1/2+ match semantics (unresolved/resolved/ambiguous)
- [ ] Implement in-memory graph struct: adjacency lists for forward/reverse links, `canonical_name → Vec<page_id>` lookup map
- [ ] Startup lifecycle: open DB → incremental sync → resolve conflicts → rebuild canonical map → resolve links → build graph
- [ ] Unit tests for link parsing (wikilinks, markdown links, links inside code blocks skipped, nested constructs)
- [ ] Unit tests for canonical name resolution (case-insensitive, alias matching, ambiguity detection)
- [ ] Integration test: build index from test vault, verify graph, verify ambiguous links flagged

### Phase 4: CRUD API

Axum routes for pages, folders, and attachments.

- [ ] Shared `AppState` holding `Vault`, `VaultIndex`, and DB pool
- [ ] Page endpoints: list, get-by-path, get-by-id, create (with optional title-based slug generation), update, delete (with `force` + `rewrite` params)
- [ ] Folder endpoints: list, list-contents, create, delete
- [ ] Attachment endpoints: list, get (binary stream), upload (multipart), delete
- [ ] JSON response types: `PageSummary` (includes `canonical_name`), `PageDetail`, `FolderListing`, `AttachmentInfo`
- [ ] Error model: structured JSON errors with status codes (404, 409 with backlink detail, 422)
- [ ] Integration tests: create page → get → update → delete lifecycle
- [ ] Integration tests: delete with `rewrite=plain_text`, `rewrite=unlink`, `rewrite=none`

### Phase 5: Rename/Move with Backlink Rewriting

The most complex operation: move a page and update all references.

- [ ] Implement `LinkRewriter`: given old path, new path, and list of (file, links) → compute rewrites
- [ ] Wikilink rewriting: shortest unambiguous form (just filename if unique, else path prefix)
- [ ] Markdown link rewriting: recalculate relative paths from each referencing file
- [ ] Apply rewrites: reverse-offset-order byte-span replacement in each affected file, using staged-write (`.clepsydra-tmp` → atomic rename) for crash safety
- [ ] Define `PostMoveHook` trait: `fn on_page_moved(&self, old_path, new_path, page_id) -> Result<()>`
- [ ] Add hook registry to `AppState` (`Vec<Box<dyn PostMoveHook>>`), called after body-link rewriting completes
- [ ] POST `/pages/*/move` endpoint: validate destination, check for canonical name collisions (409 if ambiguous unless `disambiguation: "use_full_path"`), rewrite links, move file, call post-move hooks, update index
- [ ] POST `/folders/*/move` endpoint: same but for all pages within the folder
- [ ] Integration tests: rename page with backlinks → verify all links updated
- [ ] Integration tests: move that creates ambiguity → verify 409, then retry with `use_full_path`
- [ ] Edge case tests: circular links, self-links, links from the moved page itself, ambiguous names after move

### Phase 6: Index Query API

Expose graph queries and diagnostics.

- [ ] GET `/index/backlinks/*path` — reverse link lookup
- [ ] GET `/index/outlinks/*path` — forward link lookup
- [ ] GET `/index/unresolved` — all links where `target_id IS NULL`, including ambiguous links with candidate lists
- [ ] GET `/index/ambiguous` — all canonical names that map to 2+ pages (subset of unresolved, but focused on naming collisions)
- [ ] GET `/index/warnings` — diagnostics: duplicate UUID repairs, malformed frontmatter, excluded-but-linked files
- [ ] GET `/index/tags` — aggregate tag counts
- [ ] GET `/index/stats` — vault-wide counters (pages, links, resolved, unresolved, ambiguous, tags, attachments)
- [ ] POST `/index/rebuild` — drop and rebuild the index from scratch
- [ ] Integration tests for each endpoint

## Acceptance Criteria

### Core CRUD
- [ ] A new vault can be initialized with `clepsydra init <path>`, creating `.clepsydra/` with default config and attachment folder
- [ ] Pages created via the API have a `v7 UUID` auto-inserted into YAML frontmatter
- [ ] Pages can be retrieved by vault-relative path or by UUID
- [ ] Creating a page at a path that already exists returns 409
- [ ] Creating a page with `title` but no explicit path generates a safe slug filename
- [ ] Attachments uploaded via multipart are stored in the configured attachment folder
- [ ] Path traversal attempts (e.g. `../../etc/passwd`) are rejected with 400

### Canonical Names & Resolution
- [ ] `canonical_name` is always derived (from title or filename), never stored in frontmatter, never user-editable
- [ ] Each page has a `canonical_name` derived from its title (or filename if no title)
- [ ] Link resolution is case-insensitive: `[[Design Notes]]` resolves to a page titled "design notes"
- [ ] Aliases in frontmatter create additional canonical name entries that resolve to the same page
- [ ] When two pages share a canonical name, the index marks the name as ambiguous — no silent first-match
- [ ] `GET /index/ambiguous` lists all ambiguous canonical names with their candidate pages

### Link Extraction & Integrity
- [ ] Frontmatter `tags` and `aliases` produce `PropertyRef` graph edges in the `links` table, not just metadata rows
- [ ] Tags that match an existing page's canonical name resolve as page-to-page edges
- [ ] The link parser correctly handles: `[[page]]`, `[[page|display]]`, `[[folder/page]]`, `[text](page.md)`, `[text](folder/page.md)`, `[text](../sibling.md)`
- [ ] Links inside fenced code blocks, indented code blocks, and inline code spans are not extracted
- [ ] Renaming/moving a page updates all wikilinks and markdown links in other files that referenced it
- [ ] Renaming/moving a folder updates backlinks for all pages within it
- [ ] A move that creates an ambiguous canonical name returns 409 (unless `disambiguation: "use_full_path"` is set)

### Delete Behavior
- [ ] Deleting a page that has incoming backlinks returns 409 (unless `force=true`), listing the referencing pages with link counts
- [ ] `DELETE ?force=true&rewrite=plain_text` replaces link syntax with plain text in referencing files
- [ ] `DELETE ?force=true&rewrite=unlink` replaces link syntax with strikethrough text
- [ ] `DELETE ?force=true&rewrite=none` leaves references untouched (links become unresolved)
- [ ] Delete-with-rewrite uses staged writes (`.clepsydra-tmp` → atomic rename); a crash mid-operation leaves no partially rewritten files

### Duplicate UUID Handling
- [ ] When two files share a UUID, the older file keeps it and the newer file gets a regenerated UUID written to disk
- [ ] UUID conflict resolution is logged and surfaced via `GET /index/warnings`

### Index & Persistence
- [ ] The SQLite index survives server restart and only re-parses files whose content hash has changed
- [ ] Files added/modified/deleted externally are detected and reconciled on next startup (or manual rebuild)

### Path Normalization
- [ ] Vault-relative paths are NFC-normalized at ingestion; composed and decomposed Unicode variants of the same filename do not create duplicate index entries
- [ ] Slug percent-encoding round-trips correctly: `VaultPath::from_title("a/b")` → `a%2Fb.md` → `VaultPath::decode_slug()` → `"a/b"`

### Configuration
- [ ] Vault config in `.clepsydra/config.toml` is respected for attachment folder and exclusion patterns
- [ ] `excluded_patterns` supports glob patterns (e.g. `drafts/**`, `.git/**`)
- [ ] Excluded paths are not indexed and not returned in listings
- [ ] Slug generation produces cross-platform safe filenames (no illegal characters on Windows/macOS/Linux)

## Open Questions

- [ ] Should `DELETE /pages/*path` also delete the file's attachments (images only referenced by that page)? Requires reference-counting attachments — likely deferred.
- [ ] Should `updated_at` in frontmatter update on every save, or only when the user explicitly changes content (not on backlink rewrites)? Backlink rewrites arguably shouldn't change the page's "modified" semantics. **Leaning toward**: no update on backlink rewrites.
- [ ] File watching (`notify` crate) for live re-index: defer to a follow-up spec, or include a basic version here? **Leaning toward**: defer — startup sync + manual rebuild is sufficient for v1.
- [ ] Should the `CanonicalName` derivation strip punctuation (e.g., treat "What's New?" and "whats new" as equivalent)? Current spec preserves punctuation after lowercasing. Stripping would increase recall but reduce precision.
- [ ] For `pulldown-cmark` wikilink extraction: should we also extract `#heading` fragment references from links like `[[page#heading]]`? This touches block-level reference support (out of scope) but the parser could capture the fragment for future use.
- [ ] **UUID-based link form for future rewrite reduction**: Consider supporting an optional `[[id:<uuid>]]` link syntax (or a hidden mapping layer) that resolves to the page's current title at render time. This would eliminate mass backlink rewrites on rename for large vaults (Logseq DB mode uses this pattern). **Leaning toward**: defer — path/name-based links are human-readable in plain Markdown and interoperable with other tools. Document the extension point so it can be added without breaking existing links.
- [ ] **Linkable frontmatter fields config**: Which frontmatter fields beyond `tags` and `aliases` should produce graph edges by default? Should users be able to declare custom linkable properties in vault config (e.g., `linkable_properties = ["related", "parent", "project"]`)? **Leaning toward**: ship with `tags` and `aliases` only; add config later based on real usage.

## References

- [Markdown-oxide data model notes](../docs/design-notes/markdown-oxide-data-models.md) — inspiration for the in-memory vault model and two-sided link architecture
- [Obsidian vault structure](https://help.obsidian.md/Files+and+folders/How+Obsidian+stores+data)
- [Logseq graph management](https://deepwiki.com/logseq/logseq/4.3-repository-and-graph-management)
- [Dendron multi-vault](https://wiki.dendron.so/notes/6682fca0-65ed-402c-8634-94cd51463cc4/)

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-02-06 | Initial draft | Claude / kit |
| 2026-02-06 | v2: Added canonical names, AST-based link extraction, slug policy, duplicate UUID handling, ambiguity policy, glob exclusions, delete rewrite modes | Claude / kit |
| 2026-02-06 | v2.1: Added PostMoveHook trait, templates directory in init (driven by 002-academic-library) | Claude / kit |
| 2026-02-06 | v3: Fixed slug encoding (percent-encode instead of `--`), canonical_name is derived-only invariant, frontmatter property refs as graph edges, NFC path normalization, staged-write transactional safety, explicit namespace-is-filesystem-only decision, edge-collision test plan, UUID link form open question | Claude / kit |
