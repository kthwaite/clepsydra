# Browser Extension: Web Archive & Knowledge Graph Integration

**Date:** 2026-02-14
**Status:** Design approved

## Overview

A cross-browser WebExtension that one-click captures web pages using SingleFile (faithful HTML archive) and Readability + Turndown (reader-mode markdown). All resources are content-hashed and stored in an external content-addressed store (CAS). The vault receives a clean markdown page with auto-tags and `cas:` image URIs. A new `/api/vault/archive` endpoint handles ingest, dedup, and page creation.

## Architecture: Hybrid Extension/Server

The extension uses mature JS libraries (SingleFile, Mozilla Readability, Turndown) for DOM capture and conversion — what JavaScript does best. The server handles persistent storage, deduplication, and indexing — what Rust does best. A structured archive manifest is the API boundary between the two.

### Alternatives Considered

**Thick Extension, Thin Server:** Extension does everything, calls existing page/attachment endpoints individually. Rejected: many sequential HTTP calls per capture, CAS logic trapped in extension, not reusable from CLI.

**Thin Extension, Thick Server:** Extension sends raw DOM HTML, server does all processing. Rejected: Rust readability libraries immature vs. Mozilla's JS version, server can't access auth-gated resources, loses DOM context SingleFile exploits.

## Data Model

### Content-Addressed Store (CAS)

Every captured resource is a blob stored by its SHA-256 hash. The CAS lives outside the vault in a configurable directory (default: `~/.clepsydra/cas/`).

Blob layout uses two-level fan-out (like git objects):

```
~/.clepsydra/cas/
  ab/
    ab3f7c9e...
  d4/
    d41d8cd9...
```

Blob metadata is tracked in SQLite:

```sql
CREATE TABLE blobs (
  hash         TEXT PRIMARY KEY,   -- "sha256:<hex>"
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at   TEXT NOT NULL,      -- ISO 8601
  ref_count    INTEGER NOT NULL DEFAULT 1
);
```

`ref_count` tracks how many archive pages reference a blob. Decremented on page delete. Blobs with ref_count 0 are eligible for garbage collection via a CLI subcommand, subject to a configurable minimum age.

### Archive Page (Vault)

An archived web page is a normal vault markdown page with extended frontmatter:

```yaml
---
id: 0194e5be-c8f0-7cc3-a2a9-f5c8ee5c2a44
title: "The Architecture of Open Source Applications"
tags: [archive, aosabook.org, 2026-02]
aliases: []
created_at: 2026-02-14T10:30:00Z
updated_at: 2026-02-14T10:30:00Z
archive:
  url: "https://aosabook.org/en/v1/intro.html"
  domain: "aosabook.org"
  captured_at: "2026-02-14T10:30:00Z"
  snapshot_hash: "sha256:ab3f7c9e..."
  resource_hashes:
    - "sha256:d41d8cd9..."
    - "sha256:7f83b165..."
  content_hash: "sha256:9a4c2e..."
---

# The Architecture of Open Source Applications

[Reader-mode markdown content...]
```

- `archive` namespace keeps web-specific metadata separate from standard vault fields
- `snapshot_hash` points to the faithful SingleFile HTML capture in the CAS
- `resource_hashes` lists all blobs this page depends on (for ref_count management)
- `content_hash` is the hash of the markdown body (for re-capture change detection)
- Tags auto-include `archive`, the domain, and a `YYYY-MM` date facet

### Vault Path Structure

Archive pages get deterministic, readable vault paths grouped by domain:

```
archive/
  aosabook.org/
    the-architecture-of-open-source-applications.md
  arxiv.org/
    attention-is-all-you-need.md
  lobste.rs/
    interesting-discussion-about-rust.md
```

Slug derived from title, truncated to 80 chars, numeric suffix on collision.

### Re-capture Behavior

When archiving a URL that already exists in the vault:

- Compare `content_hash` of new markdown with existing page's `content_hash`
- **Identical:** skip, return 200 "already archived"
- **Different:** return 409 with existing page info; extension behavior is configurable (`update`, `new_version`, or `ask`)

## Extension Architecture

### Component Structure

```
extension/
  manifest.json             # WebExtension manifest (V3 Chrome, V2 Firefox compat)
  background/
    service-worker.ts       # Orchestrator: receives capture requests, coordinates pipeline
  content/
    capture.ts              # Injected into page: runs SingleFile + Readability
  lib/
    singlefile.ts           # SingleFile library (vendored or bundled)
    readability.ts          # Mozilla Readability (npm)
    turndown.ts             # HTML-to-Markdown conversion
    hasher.ts               # SHA-256 hashing via Web Crypto API
    resource-extractor.ts   # Parses SingleFile HTML, extracts inlined resources
    api-client.ts           # Typed client for /api/vault/archive
  popup/
    popup.html              # Minimal: capture status, link to settings
    popup.ts
  options/
    options.html            # Server URL, default tags, auto-rules, hotkey
    options.ts
```

### Capture Pipeline

```
1. background receives browserAction.onClicked or keyboard shortcut
       |
2. Inject content/capture.ts into the active tab
       |
3. Content script runs (in page context):
   +-- SingleFile.serialize()  -> full HTML string (faithful archive)
   +-- Readability.parse()     -> article HTML (cleaned, on cloned DOM)
   +-- Extract page metadata (title, URL, canonical URL, description)
       |
4. Content script messages results back to background
       |
5. Background pipeline:
   +-- Turndown(article HTML)  -> markdown body
   +-- SHA-256 hash the full HTML snapshot -> snapshot_hash
   +-- SHA-256 hash the markdown body -> content_hash
   +-- resource-extractor parses SingleFile HTML:
   |   +-- Extracts inlined data URIs (images, fonts, CSS)
   |   +-- For each: decode, hash, yield { hash, content_type, data }
   +-- Deduplicate blobs by hash (local, before sending)
   +-- Build archive manifest
       |
6. api-client POSTs manifest to Clepsydra server
       |
7. Browser notification: "Archived: <title>" (or error)
```

**SingleFile and Readability run in the content script** — they need live DOM access. Hashing and resource extraction happen in the background worker using `crypto.subtle.digest`.

### Archive Manifest (API Payload)

```typescript
interface ArchiveManifest {
  url: string;
  canonical_url?: string;
  domain: string;
  title: string;
  description?: string;
  captured_at: string;
  content_hash: string;
  snapshot_hash: string;
  markdown_body: string;
  tags: string[];
  blobs: BlobUpload[];
}

interface BlobUpload {
  hash: string;          // "sha256:<hex>"
  content_type: string;
  data: string;          // base64-encoded
}
```

## Markdown Conversion

### Conversion Chain

```
Live DOM -> SingleFile -> Faithful HTML -> Readability -> Article HTML -> Turndown -> Markdown
```

Each representation serves a distinct purpose: faithful HTML is the archival record in the CAS; article HTML is content-only; markdown is what lives in the vault.

### Image Handling

Turndown uses a custom rule to replace image URLs with CAS references:

```typescript
turndown.addRule('cas-images', {
  filter: 'img',
  replacement: (content, node) => {
    const src = node.getAttribute('src');
    const alt = node.getAttribute('alt') || '';
    const hash = resourceMap.get(src);
    if (hash) {
      return `![${alt}](cas:${hash})`;
    }
    return `![${alt}](${src} "unarchived")`;
  }
});
```

Resulting markdown uses `cas:<hash>` URIs for archived images. The Clepsydra server resolves these via `GET /api/vault/cas/{hash}`. The frontend's markdown renderer rewrites `cas:sha256:abc...` to `/api/vault/cas/sha256:abc...` before rendering.

### Additional Turndown Rules

| Element | Conversion | Rationale |
|---------|-----------|-----------|
| `<pre><code>` | Fenced code blocks with language hint | Preserve code samples |
| `<table>` | GFM table syntax | Preserve data tables |
| `<math>` / MathJax | `$...$` / `$$...$$` passthrough | Preserve equations |
| `<a href>` | Standard markdown links, original URL | External links stay as URLs |
| `<h1>`-`<h6>` | ATX headings, demoted one level | Page title is already H1 |
| `<iframe>` | `[embedded content: <src>]` placeholder | Not archivable |
| `<video>`, `<audio>` | Link to original `src` | Not captured in v1 |

### Quality Floor

When Readability fails (SPAs, heavy JS, paywalled content), the extension detects short/empty output and creates a stub page:

```markdown
> Automated reader-mode extraction failed for this page.
> [View the archived HTML snapshot](cas:<snapshot_hash>)

**URL:** <url>
**Captured:** <timestamp>
```

The faithful SingleFile HTML is still in the CAS. The markdown can be manually edited later.

## Server-Side Archive Endpoint

### Route

```
POST /api/vault/archive
Content-Type: application/json

-> 201 Created        (new page created)
-> 200 OK             (same URL, content unchanged, skipped)
-> 409 Conflict       (same URL, content changed, action needed)
```

### Processing Pipeline

```
1. Deserialize ArchiveManifest
       |
2. Check for existing archive of this URL:
   +-- Query pages where archive.url matches
   +-- If found AND content_hash matches -> 200 "already archived"
   +-- If found AND content_hash differs -> 409 with existing page info
       |
3. Store blobs in CAS:
   +-- For each blob:
   |   +-- If hash exists: increment ref_count
   |   +-- If new: decode base64, write file, insert metadata row
   +-- Store snapshot HTML blob the same way
       |
4. Create vault page:
   +-- Generate path: archive/<domain>/<slugified-title>.md
   +-- Build frontmatter (id, title, tags, archive metadata)
   +-- Write .md file to vault
   +-- Trigger index update
       |
5. Return { page_id, vault_path, blobs_stored, blobs_deduped, status }
```

### Rust Types

```rust
#[derive(Deserialize)]
struct ArchiveRequest {
    url: String,
    canonical_url: Option<String>,
    domain: String,
    title: String,
    description: Option<String>,
    captured_at: String,
    content_hash: String,
    snapshot_hash: String,
    markdown_body: String,
    tags: Vec<String>,
    blobs: Vec<BlobUpload>,
}

#[derive(Deserialize)]
struct BlobUpload {
    hash: String,
    content_type: String,
    data: String,  // base64
}

#[derive(Serialize)]
struct ArchiveResponse {
    page_id: String,
    vault_path: String,
    blobs_stored: u32,
    blobs_deduped: u32,
    status: ArchiveStatus,  // Created | AlreadyExists | ContentChanged
}
```

### CAS Module

New module at `src/vault/cas.rs`:

```rust
impl ContentStore {
    fn store(&self, hash: &str, data: &[u8], content_type: &str) -> Result<StoreResult>;
    fn exists(&self, hash: &str) -> Result<bool>;
    fn retrieve(&self, hash: &str) -> Result<(Vec<u8>, String)>;
    fn increment_ref(&self, hash: &str) -> Result<()>;
    fn decrement_ref(&self, hash: &str) -> Result<()>;
    fn gc(&self, min_age: Duration) -> Result<u32>;
}
```

### CAS Blob Serving

```
GET /api/vault/cas/{hash}
-> 200 OK (Content-Type from blob metadata, raw bytes)
-> 404 Not Found
```

### Delete Cascade

When an archive page is deleted via `DELETE /pages/{path}`, a `PostDeleteHook` decrements `ref_count` for all blobs listed in `archive.resource_hashes` and `archive.snapshot_hash`.

## Configuration

### Extension Settings

Stored in `browser.storage.sync`:

```typescript
interface ExtensionSettings {
  server_url: string;                // default: "http://localhost:3000"
  api_key?: string;                  // future auth support
  default_tags: string[];            // always applied alongside auto-tags
  archive_path_prefix: string;       // default: "archive"
  capture_shortcut: string;          // default: "Ctrl+Shift+S"
  notify_on_success: boolean;        // default: true
  notify_on_duplicate: boolean;      // default: true
  on_content_changed: "update" | "new_version" | "ask";  // default: "ask"
  auto_rules: AutoRule[];            // v2, schema defined now
}
```

### Server Configuration

Extends `config.toml`:

```toml
[archive]
enabled = true
cas_path = "~/.clepsydra/cas"
default_path_prefix = "archive"
max_blob_size_mb = 50
max_request_size_mb = 100
gc_min_age_days = 30
```

Env var overrides: `CLEPSYDRA__ARCHIVE__CAS_PATH`, etc.

### Archive Status Endpoint

```
GET /api/vault/archive/status
-> { enabled, cas_path, blob_count, total_size_bytes, archive_page_count }
```

Extension options page shows connection status and basic stats from this endpoint.

## Out of Scope for v1

- Offline queue / IndexedDB buffering
- Negotiated upload (send hashes first, server responds with missing)
- Auto-capture rule execution (schema defined, logic deferred)
- CAS garbage collection UI (CLI subcommand only)
- Full-text search across archives
- PDF capture
- Screenshot capture
- Bulk import (Pocket, Instapaper, etc.)

## Knowledge Graph Integration

Archive pages integrate with the existing vault graph through:

- **Auto-tags:** `archive`, domain name, `YYYY-MM` date facet, plus user-configured defaults
- **Manual wikilinks:** user adds `[[wikilinks]]` to connect archives to notes at their discretion
- **Backlink tracking:** existing index automatically tracks all incoming/outgoing links
- **Tag queries:** `GET /index/tags` surfaces archive pages alongside regular notes
- **Canonical name resolution:** archive page titles participate in the existing alias/canonical resolution system
