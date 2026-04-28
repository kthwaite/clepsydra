# Academic Library (Books, Papers, Citations)

A domain feature on top of Vault Core that models academic works (papers/books), bibliographic metadata, reading status, and PDF annotations using page identities + typed frontmatter.

## Should this be a separate feature file?

Yes.

This should be a **new feature file** (this one) because it is:
- domain/model-layer scope (not core vault CRUD/indexing)
- optional for users who do not need bibliography workflows
- likely to introduce new APIs, templates, and import flows (DOI/ISBN/BibTeX)

`001-vault-core.md` should remain focused on filesystem + indexing + link integrity.

---

## Goals

- Represent `Paper` and `Book` as first-class pages with stable UUIDs.
- Support structured citation metadata in frontmatter.
- Link works to local/remote assets (PDF, EPUB, URL).
- Capture highlights/notes tied to a work and optional source location.
- Keep everything as portable Markdown + frontmatter.

## Non-Goals (phase 1)

- Full CSL rendering engine
- Native Zotero sync
- OCR/PDF text extraction pipeline
- Automatic citation formatting in editor body text

---

## Layering on Vault Core

The academic module is a **domain view** over vault core's generic `PageMeta`. It does not modify the core frontmatter parser.

**Composition strategy**: Vault core's `PageMeta` stores all frontmatter. The `extra` field (via `#[serde(flatten)]`) captures any keys beyond the core set (`id`, `title`, `tags`, `aliases`, `created_at`, `updated_at`). The academic module deserializes domain-specific fields from `PageMeta::extra` (or equivalently from `pages.meta_json` in SQLite) using its own typed structs. This keeps vault core ignorant of domain concerns.

**Consequence**: No changes to vault core's `PageMeta` struct. The academic layer is a second-pass deserializer that reads `meta_json` and interprets `kind`, `work_type`, `authors`, etc.

---

## Data Model

### Work Page Frontmatter

```yaml
id: 0194e5be-c8f0-7cc3-a2a9-f5c8ee5c2a44
kind: work
work_type: paper # paper | book | thesis | report
title: "Attention Is All You Need"
authors:
  - "Ashish Vaswani"
  - "Noam Shazeer"
year: 2017
venue: "NeurIPS"
tags: ["ml", "transformers"]
aliases: ["Transformer paper"]
status: unread # unread | reading | done
rating: 5
external_ids:
  doi: "10.48550/arXiv.1706.03762"
  isbn: null
  arxiv: "1706.03762"
urls:
  landing: "https://arxiv.org/abs/1706.03762"
  pdf: "https://arxiv.org/pdf/1706.03762.pdf"
assets:
  - "_attachments/papers/attention-is-all-you-need.pdf"
cite_key: "vaswani2017attention"
created_at: 2026-02-06T14:00:00Z
updated_at: 2026-02-06T14:00:00Z
```

**Note on `cite_key`**: The `cite_key` is registered as a `source = 'cite_key'` entry in vault core's `canonical_names` table. This means `[[vaswani2017attention]]` in body text resolves to the work page automatically via the existing link resolution mechanism. No separate resolution logic needed. Future `[@key]` citation syntax can build on this.

### Annotation Page Frontmatter

```yaml
id: 0194e5bf-4f95-7f95-8b13-ea8f71a04f0a
kind: annotation
work_id: 0194e5be-c8f0-7cc3-a2a9-f5c8ee5c2a44
work_path: "library/papers/attention-is-all-you-need.md"
source_asset: "_attachments/papers/attention-is-all-you-need.pdf"
source_location:
  page: 4
  quote: "Scaled dot-product attention"
  rect: [120.1, 430.3, 402.8, 472.6]  # PDF user space coordinates (72 DPI, origin bottom-left)
annotation_type: highlight # highlight | note
tags: ["attention", "core-idea"]
created_at: 2026-02-06T14:02:00Z
updated_at: 2026-02-06T14:02:00Z
```

Notes:
- `work_id` is the canonical identity link (UUID, survives renames).
- `work_path` is denormalized convenience for filesystem navigation.
- On move/rename of a work page, a **move hook** rewrites `work_path` in all annotation frontmatter referencing that work (see Move Hook section below).
- `source_location.rect` uses PDF user space coordinates: 72 DPI, origin at bottom-left of the page, `[x1, y1, x2, y2]` defining the bounding box. This matches the PDF spec (ISO 32000) and is the coordinate system returned by most PDF extraction libraries.

### Author Name Convention

Author names are stored in **given-first format**: `"Given Family"` (e.g., `"Ashish Vaswani"`, not `"Vaswani, Ashish"`).

- **Storage**: verbatim as provided by the user or importer. No automatic normalization.
- **Query**: case-insensitive substring match (e.g., querying `author=vaswani` matches `"Ashish Vaswani"`).
- **Display**: as-stored. The API does not reformat names.
- **Deduplication**: not attempted in phase 1. Author identity is a hard problem (name variants, transliterations, shared names). Future work may introduce an optional `author_ids` field mapping to ORCID or similar.

### Why One File Per Annotation

Each annotation is a **separate `.md` file** rather than a section within the work page or a consolidated annotations file. Rationale:

1. **First-class page identity**: Every annotation gets its own UUID and participates in the vault's link graph. You can link *to* a specific highlight from anywhere (`[[annotation-title]]`), and the annotation can link *out* to related concepts.
2. **Independent tagging and querying**: Annotations have their own `tags`, enabling queries like "all highlights tagged `core-idea` across all papers" — without parsing within-file structure.
3. **Composability with vault core**: Annotations are just pages. They work with backlinks, move/rename, delete-with-rewrite, and every other vault core operation with zero special-casing.
4. **External editor compatibility**: Each file is independently editable in Neovim, Obsidian, etc.

**Tradeoff acknowledged**: A heavily annotated paper (50+ highlights) produces many small files. This is mitigated by:
- Annotations live in a dedicated folder (`library/annotations/`), not alongside work pages.
- Listing annotations for a work is a fast index query (`work_id` filter), not a directory scan.
- Future: a "consolidated view" API endpoint could render all annotations for a work into a single response without changing the storage model.

---

## Move Hook: Frontmatter Reference Rewriting

`work_id` / `work_path` in annotation frontmatter is a **structural reference** — a link that lives in YAML, not in body text. Vault core's `LinkRewriter` only handles body links (wikilinks, markdown links). Rewriting frontmatter references requires a hook mechanism.

### Prerequisite: Vault Core Move Hook

Vault core (001) needs a **post-move hook** extension point:

```rust
/// Called after a page has been successfully moved/renamed.
/// Receives the old path, new path, and the page's UUID.
pub trait PostMoveHook: Send + Sync {
    fn on_page_moved(&self, old_path: &VaultPath, new_path: &VaultPath, page_id: Uuid) -> Result<()>;
}
```

The server registers hook implementations at startup. Vault core's move operation calls all registered hooks after the file move and body-link rewriting are complete.

### Academic Move Hook

The academic module registers a `PostMoveHook` that:

1. Queries the index for all pages where `meta_json` contains `"work_id": "<moved-page-uuid>"`.
2. For each matching annotation file, reads the file, updates `work_path` in frontmatter to the new path, and writes it back.
3. Updates the index (`meta_json`) for the affected annotation pages.

This keeps vault core unaware of `work_path` semantics.

---

## File/Folder Conventions (default)

```toml
# .clepsydra/config.toml
[vault.academic]
library_folder = "library"
papers_folder = "library/papers"
books_folder = "library/books"
annotations_folder = "library/annotations"
```

Attachments continue to use vault-level `attachment_folder` unless overridden later.

### Template Location

Templates live in **`.clepsydra/templates/`** — with vault config, outside the content tree. They are not indexed as pages.

- `.clepsydra/templates/paper.md`
- `.clepsydra/templates/book.md`
- `.clepsydra/templates/annotation.md`

The `clepsydra init` command (from 001) should create this directory. The academic module's setup adds its templates there.

---

## API Endpoints

Base: `/api/vault/academic`

**Works**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/works` | Create a work page. Body: `WorkCreateRequest`. Auto-generates UUID, timestamps, slug. 409 if `cite_key` conflicts. |
| `GET` | `/works` | List works. Query params: `work_type`, `status`, `tag`, `author` (case-insensitive substring), `year`, `q` (future). Returns `WorkSummary[]`. |
| `GET` | `/works/by-id/:uuid` | Get a work by UUID. Returns `WorkDetail`. |
| `PUT` | `/works/by-id/:uuid` | Update work metadata. Body: `WorkUpdateRequest`. |
| `POST` | `/works/by-id/:uuid/attach` | Attach local or remote asset metadata to a work. |

**Annotations**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/annotations` | Create an annotation linked to `work_id`. Body: `AnnotationCreateRequest`. |
| `GET` | `/works/by-id/:uuid/annotations` | List all annotations for a work. |

**Batch Import**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/import/bibtex` | Batch import from BibTeX. Body: raw BibTeX string. Returns per-item results (created/skipped/error). |
| `POST` | `/import/doi` | Single DOI lookup (Crossref/OpenAlex). Body: `{ "doi": "..." }`. |
| `POST` | `/import/isbn` | Single ISBN lookup. Body: `{ "isbn": "..." }`. |

All operations read/write markdown files and update the vault index.

---

## Query/Index Considerations

The academic module queries vault core's `pages.meta_json` for domain fields. No changes to vault core's schema are required for phase 1.

**`cite_key` integration with `canonical_names`**: When the academic module indexes a work page, it inserts the `cite_key` (if present) into vault core's `canonical_names` table with `source = 'cite_key'`. This enables wikilink resolution (`[[vaswani2017attention]]`) through the standard link resolution path.

**Optional normalized table** (phase 2, for performance if `meta_json` queries become slow):

```sql
CREATE TABLE works (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  work_type TEXT NOT NULL,
  year INTEGER,
  status TEXT,
  cite_key TEXT,
  doi TEXT,
  isbn TEXT,
  arxiv TEXT
);
CREATE INDEX idx_works_type ON works(work_type);
CREATE INDEX idx_works_year ON works(year);
CREATE INDEX idx_works_status ON works(status);
CREATE UNIQUE INDEX idx_works_cite_key ON works(cite_key);
```

---

## Templates

### Paper template (`.clepsydra/templates/paper.md`)

```md
---
kind: work
work_type: paper
title: ""
authors: []
year:
venue: ""
status: unread
rating:
external_ids: {doi: null, arxiv: null, isbn: null}
urls: {landing: "", pdf: ""}
assets: []
cite_key: ""
tags: []
aliases: []
---

# Summary

# Key ideas

# Notes

# Open questions
```

### Book template (`.clepsydra/templates/book.md`)

```md
---
kind: work
work_type: book
title: ""
authors: []
year:
publisher: ""
status: unread
rating:
external_ids: {isbn: null, doi: null}
urls: {landing: ""}
assets: []
cite_key: ""
tags: []
aliases: []
---

# Summary

# Chapters

# Notes
```

---

## Migration/Interoperability Notes

- Existing pages can be promoted to works by adding `kind: work` and `work_type: paper|book` to frontmatter. The academic module picks them up on next index scan.
- Importers (future): BibTeX/CSL-JSON/DOI metadata fetchers populate this schema.
- This model maps well to Logseq-style class/property usage while staying Markdown-native.

---

## Acceptance Criteria

### Works
- [ ] Can create Paper/Book pages with required metadata (`work_type`, `title`).
- [ ] Created works have UUID, timestamps, and a generated slug filename.
- [ ] `cite_key` is registered in vault core's `canonical_names` table — `[[cite_key]]` resolves to the work page.
- [ ] Duplicate `cite_key` returns 409 with clear error.
- [ ] Can query works by `work_type`, `status`, `year`, `tag`, `author` (case-insensitive substring).
- [ ] Can link one or more assets (local path or external URL metadata).

### Annotations
- [ ] Can create annotation pages tied to `work_id`.
- [ ] Each annotation is a separate `.md` file with its own UUID.
- [ ] Can list all annotations for a work via `GET /works/by-id/:uuid/annotations`.

### Move Integrity
- [ ] Renaming/moving a work page preserves annotation linkage via `work_id` (UUID, unchanged).
- [ ] Renaming/moving a work page updates `work_path` in all annotation frontmatter via post-move hook.
- [ ] The move hook is registered by the academic module, not hardcoded in vault core.

### Portability
- [ ] All data remains editable as plain Markdown + YAML frontmatter.
- [ ] Academic fields are parsed from `PageMeta::extra` / `meta_json` — no vault core `PageMeta` struct changes.

### Batch Import
- [ ] BibTeX batch import creates one work page per entry, reporting per-item success/skip/error.
- [ ] Dedup on import: existing works matched by DOI → ISBN → `cite_key` are skipped (not overwritten).

---

## Rust Types (proposed)

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Domain-specific frontmatter, deserialized from PageMeta::extra / meta_json.
/// Tagged enum: serde dispatches on the `kind` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcademicMeta {
    Work(WorkMeta),
    Annotation(AnnotationMeta),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkMeta {
    pub work_type: WorkType,
    pub title: String,  // required for works
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,  // given-first format: "Given Family"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venue: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ReadingStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<u8>,  // 1..=5, None means unrated
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_ids: Option<ExternalIds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<WorkUrls>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<String>,  // vault-relative attachment paths
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cite_key: Option<String>,
    /// Arbitrary additional domain fields.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationMeta {
    pub work_id: Uuid,  // required for annotations
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_path: Option<String>,  // denormalized, rewritten by move hook
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_location: Option<SourceLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotation_type: Option<AnnotationType>,
    /// Arbitrary additional domain fields.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkType {
    Paper,
    Book,
    Thesis,
    Report,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadingStatus {
    Unread,
    Reading,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExternalIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arxiv: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkUrls {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourceLocation {
    /// Page number (1-indexed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    /// Quoted text from the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    /// Bounding box in PDF user space: [x1, y1, x2, y2].
    /// Coordinate system: 72 DPI, origin at bottom-left of page (ISO 32000).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<[f32; 4]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationType {
    Highlight,
    Note,
}
```

Validation rules (enforced at the API layer, not serde):
- `WorkMeta` requires `work_type` and `title` (enforced by struct — these are non-optional).
- `AnnotationMeta` requires `work_id` (enforced by struct — non-optional).
- `rating`, if present, must be `1..=5`.
- `cite_key`, if present, must be unique across all works (checked via `canonical_names` table).

---

## Implementation Plan (aligned with 001)

### Phase 0 — Vault Core Prerequisite

Add the **post-move hook** extension point to vault core. This is a small, focused addition:

- [ ] Define `PostMoveHook` trait in vault core.
- [ ] Add hook registry to `AppState` (a `Vec<Box<dyn PostMoveHook>>`).
- [ ] Call registered hooks after successful move in `POST /pages/*/move` and `POST /folders/*/move`.
- [ ] Unit test: hook is called with correct old/new path and page UUID.

This is the **only** change to vault core required by the academic module.

### Phase 1 — Domain Model + CRUD

- [ ] Implement `AcademicMeta` tagged enum (Work/Annotation) with serde deserialization from `meta_json`.
- [ ] Implement academic move hook: query index for annotations by `work_id`, rewrite `work_path` in frontmatter.
- [ ] Register academic move hook at server startup.
- [ ] Add `cite_key` insertion into `canonical_names` table (source = `'cite_key'`) during academic indexing pass.
- [ ] Add `/api/vault/academic/works` create/list/get/update endpoints.
- [ ] Add filters: `work_type`, `status`, `author` (case-insensitive substring), `year`, `tag`.
- [ ] Add `/api/vault/academic/annotations` create endpoint.
- [ ] Add `GET /works/by-id/:uuid/annotations` list endpoint.
- [ ] Add `cite_key` uniqueness checks via `canonical_names` — 409 on conflict.
- [ ] Add `rating` range validation (1..=5).
- [ ] Integration tests: create work → get → update → delete lifecycle.
- [ ] Integration tests: create annotation → verify `work_id` link → move work → verify `work_path` updated.

### Phase 2 — Asset and Annotation UX APIs

- [ ] Add endpoint to attach asset path/URL metadata to work.
- [ ] Add endpoint to create annotation with source location payload.
- [ ] Add backlink-style endpoint: from annotation → work summary.

### Phase 3 — Importers

- [ ] `POST /api/vault/academic/import/bibtex` — batch import from BibTeX string. Accepts raw BibTeX in request body. Returns array of per-item results: `{ "cite_key": "...", "status": "created" | "skipped" | "error", "page_path": "...", "error"?: "..." }`.
- [ ] `POST /api/vault/academic/import/doi` — single DOI lookup (Crossref/OpenAlex).
- [ ] `POST /api/vault/academic/import/isbn` — single ISBN lookup.
- [ ] Dedup strategy on import: match existing works by DOI → ISBN → `cite_key`. Skip (do not overwrite) if found.
- [ ] Author name normalization on import: extract given-first format from BibTeX's `{Family, Given}` convention.

### Phase 4 — Formatting and citations (future)

- [ ] Optional cite rendering utility (`[@cite_key]` preview).
- [ ] CSL style support as a plugin/extension layer.
- [ ] Export helper for bibliography section generation.

---

## API Shapes (example)

Create work:

```json
POST /api/vault/academic/works
{
  "work_type": "paper",
  "title": "Attention Is All You Need",
  "authors": ["Ashish Vaswani", "Noam Shazeer"],
  "year": 2017,
  "external_ids": {"doi": "10.48550/arXiv.1706.03762"},
  "urls": {"landing": "https://arxiv.org/abs/1706.03762"}
}
```

Create annotation:

```json
POST /api/vault/academic/annotations
{
  "work_id": "0194e5be-c8f0-7cc3-a2a9-f5c8ee5c2a44",
  "annotation_type": "highlight",
  "source_asset": "_attachments/papers/attention-is-all-you-need.pdf",
  "source_location": {"page": 4, "quote": "Scaled dot-product attention"},
  "body": "Core claim: attention scales better than recurrence."
}
```

Batch import (BibTeX):

```json
POST /api/vault/academic/import/bibtex
Content-Type: text/plain

@article{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam and ...},
  journal={NeurIPS},
  year={2017}
}
@book{bishop2006pattern,
  title={Pattern Recognition and Machine Learning},
  author={Bishop, Christopher M},
  year={2006},
  publisher={Springer}
}
```

Response:

```json
{
  "results": [
    {"cite_key": "vaswani2017attention", "status": "created", "page_path": "library/papers/attention-is-all-you-need.md"},
    {"cite_key": "bishop2006pattern", "status": "created", "page_path": "library/books/pattern-recognition-and-machine-learning.md"}
  ]
}
```

---

## Open Questions

- [ ] Should annotations support linking to non-academic pages (e.g., annotating a blog post or personal note)? If so, `work_id` should be generalized to `source_id`.
- [ ] Should the academic module support a "reading list" concept (ordered collection of works)?
- [ ] For BibTeX import: should conflicting entries (same DOI, different metadata) update or skip? Current spec says skip — is that always right?

---

## Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-02-06 | Initial draft | kit |
| 2026-02-06 | v2: Split AcademicMeta into tagged enum, composition over extension for PageMeta, move hook mechanism, cite_key in canonical_names, one-file-per-annotation rationale, template location, author name convention, batch import, PDF coordinate spec | Claude / kit |
