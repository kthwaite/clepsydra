# Zotero SQLite Import — Design Document

> **Status:** Approved design, pending implementation plan
> **Date:** 2026-02-15
> **Depends on:** `_features/002-academic-library.md` (implemented), `_features/003-academic-importers.md` (supersedes the Zotero Web API approach)

## Summary

Add a one-shot, user-triggered import from Zotero's local SQLite database (`zotero.sqlite`) into Clepsydra's academic library. Reads the database directly (read-only), maps Zotero's EAV schema to `WorkMeta` pages, derives citation keys, and feeds into the existing `create_work_internal()` pipeline. No runtime dependency on Zotero running or any plugins.

## Goals

- Import bibliographic metadata from a local Zotero library into Clepsydra work pages.
- Derive stable citation keys (prefer BBT keys from `extra` field, fall back to `author+year+title`).
- Record Zotero provenance in frontmatter for idempotent re-import.
- Reference PDF attachments by path (Zotero remains the SSOT for files).
- Reuse the existing import pipeline (`BibImportEntry`, `create_work_internal()`, dedup).

## Non-Goals (v1)

- Continuous/background sync — this is manual, one-shot import.
- Bidirectional sync (pushing edits back to Zotero).
- Copying PDF attachments into the vault — Zotero owns the files.
- Non-PDF attachment handling (EPUB, snapshots, HTML).
- Updating existing works on re-import (skip-only dedup).
- Zotero Web API or BBT JSON-RPC integration (separate future adapters).

---

## Discovery and Configuration

### Auto-detection

Default `zotero.sqlite` path by platform:
- macOS: `~/Zotero/zotero.sqlite`
- Linux: `~/Zotero/zotero.sqlite`

### Config override

```toml
# .clepsydra/config.toml
[academic.zotero]
database_path = "~/Zotero/zotero.sqlite"  # optional, auto-detected if absent
```

### Connection mode

Open with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`. WAL mode supports concurrent reads while Zotero is running. We never write to the Zotero database.

---

## API Endpoint

```
POST /api/vault/academic/import/zotero
```

### Request

```json
{
  "database_path": null,
  "collection": null,
  "since": null,
  "dry_run": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `database_path` | `string?` | Override path to `zotero.sqlite`. `null` = auto-detect. |
| `collection` | `string?` | Zotero collection name to filter by. `null` = entire library. |
| `since` | `string?` | ISO 8601 timestamp. Only items modified after this date. `null` = all items. |
| `dry_run` | `bool` | If `true`, run the full pipeline but write nothing. Status values become `"would_create"` / `"would_skip"`. |

### Response

Same `ImportResponse` shape as existing importers:

```json
{
  "results": [
    {
      "cite_key": "vaswani2017attention",
      "status": "created",
      "page_path": "library/papers/attention-is-all-you-need.md",
      "error": null
    },
    {
      "cite_key": "bishop2006pattern",
      "status": "skipped",
      "page_path": "library/books/pattern-recognition-and-machine-learning.md",
      "error": null
    }
  ]
}
```

---

## Schema Mapping

### Core item query

Reconstructs full bibliographic records from Zotero's EAV tables. Joins through `fields` and `itemTypes` by name (not hardcoded IDs) for resilience across Zotero versions.

```sql
SELECT
  i.itemID,
  i.key AS zotero_key,
  i.dateModified,
  it.typeName AS item_type,
  MAX(CASE WHEN f.fieldName = 'title' THEN idv.value END) AS title,
  MAX(CASE WHEN f.fieldName = 'date' THEN idv.value END) AS date_raw,
  MAX(CASE WHEN f.fieldName = 'DOI' THEN idv.value END) AS doi,
  MAX(CASE WHEN f.fieldName = 'ISBN' THEN idv.value END) AS isbn,
  MAX(CASE WHEN f.fieldName = 'url' THEN idv.value END) AS url,
  MAX(CASE WHEN f.fieldName = 'publicationTitle' THEN idv.value END) AS venue,
  MAX(CASE WHEN f.fieldName = 'publisher' THEN idv.value END) AS publisher,
  MAX(CASE WHEN f.fieldName = 'extra' THEN idv.value END) AS extra_field
FROM items i
JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
LEFT JOIN itemData id ON id.itemID = i.itemID
LEFT JOIN itemDataValues idv ON idv.valueID = id.valueID
LEFT JOIN fields f ON f.fieldID = id.fieldID
WHERE it.typeName IN (
  'journalArticle', 'conferencePaper', 'book', 'bookSection',
  'thesis', 'report', 'preprint'
)
AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
GROUP BY i.itemID
```

### Creators query

```sql
SELECT ic.itemID, c.firstName, c.lastName, c.fieldMode, ct.creatorType
FROM itemCreators ic
JOIN creators c ON c.creatorID = ic.creatorID
JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
WHERE ct.creatorType = 'author'
ORDER BY ic.itemID, ic.orderIndex
```

`fieldMode = 0`: first/last split → format as `"firstName lastName"`.
`fieldMode = 1`: single-field (institutional) → use `lastName` as-is.

### Tags query

```sql
SELECT it.itemID, t.name
FROM itemTags it
JOIN tags t ON t.tagID = it.tagID
```

### Attachments query

```sql
SELECT ia.path, ia.contentType, ia.linkMode, i.key AS attachment_key
FROM itemAttachments ia
JOIN items i ON i.itemID = ia.itemID
WHERE ia.parentItemID = ?
  AND ia.contentType = 'application/pdf'
```

### Collection filter

When `collection` is provided, add to the core query:

```sql
AND i.itemID IN (
  SELECT ci.itemID FROM collectionItems ci
  JOIN collections c ON c.collectionID = ci.collectionID
  WHERE c.collectionName = ?
)
```

### Since filter

When `since` is provided:

```sql
AND i.dateModified > ?
```

---

## Type Mapping

| Zotero `typeName` | Clepsydra `WorkType` |
|---|---|
| `journalArticle` | `paper` |
| `conferencePaper` | `paper` |
| `preprint` | `paper` |
| `book` | `book` |
| `bookSection` | `book` |
| `thesis` | `thesis` |
| `report` | `report` |
| anything else | `other` |

---

## Citation Key Derivation

### Priority order

1. **Check Zotero `extra` field** for `Citation Key: <value>` (set by Better BibTeX). Regex: `/^Citation Key:\s*(.+)$/m`. If found, use that value.
2. **Derive from metadata:** `{first_author_last_name}{year}{first_significant_title_word}`, all lowercase.

### Derivation algorithm

1. First author's last name → lowercase, NFKD normalize, strip combining marks (e.g. `"Müller"` → `"muller"`, `"García"` → `"garcia"`).
2. Append 4-digit year. No year → omit.
3. Append first significant word of title (skip "a", "an", "the", "on"), lowercase.
4. No authors → use `"anon"`.

### Collision handling

If the generated key exists in `canonical_names`, append alphabetic suffix: `-b`, `-c`, ..., `-z`, `-aa`, etc.

### Examples

| Authors | Year | Title | Extra | Result |
|---|---|---|---|---|
| Vaswani, Ashish | 2017 | Attention Is All You Need | — | `vaswani2017attention` |
| Vaswani, Ashish | 2017 | Attention Is All You Need | `Citation Key: vaswani2017` | `vaswani2017` |
| Müller, Hans | 2023 | The Grand Unified Theory | — | `muller2023grand` |
| — | 2020 | Some Report | — | `anon2020some` |

---

## Dedup and Source Linkage

### Dedup precedence

On import, check for existing works in this order:

1. `import.zotero_key` match — have we imported this Zotero item before?
2. `external_ids.doi` exact match
3. `external_ids.isbn` exact match
4. `cite_key` exact match (via `canonical_names`)

If matched at any level → `status: "skipped"`. If no match → create.

### Source linkage SQL

```sql
SELECT path FROM pages
WHERE json_extract(meta_json, '$.import.source') = 'zotero'
  AND json_extract(meta_json, '$.import.zotero_key') = ?1
```

### Frontmatter provenance

Stored in `PageMeta::extra` alongside `WorkMeta` fields:

```yaml
import:
  source: zotero
  zotero_key: "JAHCZRNB"
  zotero_item_id: 4827
  imported_at: 2026-02-15T10:30:00Z
```

### Re-import behavior

Matched items are skipped (not updated). Idempotent by design. To refresh an item, delete the Clepsydra page and re-import.

---

## Attachment Handling

Zotero remains the single source of truth for files. Clepsydra records thin metadata references only.

### Link mode mapping

| `linkMode` | Meaning | What we store |
|---|---|---|
| `0` | Imported file (in Zotero storage) | `assets[]` = `<zotero_data_dir>/storage/<attachment_key>/<filename>` |
| `1` | Imported URL | `urls.pdf` = URL |
| `2` | Linked file (absolute path) | `assets[]` = absolute path as-is |
| `3` | Linked URL | `urls.pdf` = URL |

### Path resolution for `linkMode = 0`

Zotero stores `path` as `"storage:<filename>"`. We resolve:
```
<zotero_data_dir>/storage/<attachment_key>/<filename>
```

where `<zotero_data_dir>` is the parent directory of `zotero.sqlite` and `<attachment_key>` is the `items.key` of the attachment item.

### Scope

v1: PDF attachments only (`contentType = 'application/pdf'`). Non-PDF attachments are ignored.

---

## Module Structure

### New files

- `src/vault/import_zotero.rs` — Zotero SQLite reader, EAV→ZoteroItem mapper, cite_key derivation, orchestrator

### Modified files

- `src/api/academic.rs` — add `import_zotero` handler and route
- `src/vault/mod.rs` — add `pub mod import_zotero;`
- `src/vault/config.rs` — add optional `ZoteroSection` to `AcademicSection`

### No new crate dependencies

rusqlite (already bundled) handles both the vault index DB and the Zotero DB.

### Key types

```rust
/// Raw query result from Zotero's EAV tables.
struct ZoteroItem {
    item_id: i64,
    zotero_key: String,
    item_type: String,
    title: String,
    date_raw: Option<String>,
    doi: Option<String>,
    isbn: Option<String>,
    url: Option<String>,
    venue: Option<String>,
    publisher: Option<String>,
    extra_field: Option<String>,
    authors: Vec<ZoteroAuthor>,
    tags: Vec<String>,
    pdf_attachments: Vec<ZoteroPdf>,
}

struct ZoteroAuthor {
    first_name: String,
    last_name: String,
    field_mode: i32,  // 0 = first/last, 1 = single-field
}

struct ZoteroPdf {
    link_mode: i32,
    path: Option<String>,
    attachment_key: String,
}
```

### Function decomposition

```
detect_zotero_db() -> Option<PathBuf>
    // Check platform default path, return None if absent

open_zotero_db(path: &Path) -> Result<Connection>
    // Read-only rusqlite connection

query_items(conn, collection?, since?) -> Result<Vec<ZoteroItem>>
    // Core EAV join + creators + tags + attachments

derive_cite_key(extra_field, authors, year, title, existing_keys) -> String
    // Check extra for "Citation Key:", else generate, handle collisions

map_to_import_entry(item: &ZoteroItem) -> BibImportEntry
    // ZoteroItem → BibImportEntry (reuses existing struct)

find_existing_by_zotero_key(conn, zotero_key) -> Option<String>
    // New dedup check: json_extract on import.zotero_key

resolve_attachment_path(zotero_data_dir, pdf: &ZoteroPdf) -> Option<String>
    // linkMode dispatch → absolute path or URL

import_zotero(state, request) -> Result<ImportResponse>
    // Orchestrator: detect/open DB → query → dedup → create_work_internal() → patch provenance + assets
```

### Pipeline flow

```
Request
  → detect/open Zotero DB
  → query_items (filtered by collection/since)
  → for each ZoteroItem:
      → derive_cite_key (check extra field first)
      → find_existing_by_zotero_key OR find_existing_work (DOI/ISBN/cite_key)
      → if exists: skip
      → if dry_run: record "would_create"
      → else: map_to_import_entry → create_work_internal()
              → patch frontmatter with import.* provenance
              → patch assets[] / urls.pdf with attachment references
  → return ImportResponse
```

---

## Relation to Existing Spec (003)

`_features/003-academic-importers.md` describes a Zotero Web API integration with incremental sync, conflict resolution, and checkpointing. This design **supersedes the Zotero section** of that spec with a simpler, local-first approach. The non-Zotero parts of 003 (adapter interface for future BibTeX/Crossref/ISBN importers) remain valid.

Key differences from 003:
- **Data source:** Local SQLite instead of Zotero Web API.
- **Sync model:** One-shot import instead of incremental sync with checkpointing.
- **Conflict policy:** Skip-only (no source-wins/local-wins merge). Simpler, sufficient for v1.
- **Runtime deps:** None (no Zotero running, no BBT required).

---

## Open Questions

- Should the collection filter support nested collections (import a parent and all children)?
- Should we expose a `GET /api/vault/academic/import/zotero/collections` endpoint that lists available Zotero collections for UI picker support?
- Should the `since` filter use Zotero's `dateModified` or `dateAdded`? (Design uses `dateModified`.)
