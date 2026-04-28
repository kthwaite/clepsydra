# Academic Importers (Zotero-first)

Importer/sync layer for the Academic Library feature, with Zotero as the first-class source.

## Why separate from 002?

- `002-academic-library.md` defines domain model + CRUD.
- This file defines external ingestion/sync semantics, conflict policy, and source adapters.

---

## Scope

## In scope (v1)
- Pull metadata from Zotero Web API (user/group library)
- Map Zotero items to `kind=work` pages
- Map Zotero attachments to `assets`/`urls`
- Persist source linkage for re-sync
- Idempotent upsert + conflict-safe updates

## Out of scope (v1)
- Push edits back to Zotero
- Full-text PDF ingestion/OCR
- CSL bibliography rendering
- Non-Zotero adapters (BibTeX/Crossref/ISBN) beyond interface stubs

---

## Source Linkage Model

Add importer metadata to work frontmatter:

```yaml
import:
  source: zotero
  library_type: user # user | group
  library_id: "8234867"
  item_key: "JAHCZRNB"
  item_version: 42
  last_synced_at: 2026-02-06T14:30:00Z
  etag: "W/\"123abc\""
```

This enables deterministic re-sync and conflict detection.

---

## Mapping (Zotero -> AcademicMeta)

- Zotero `title` -> `title`
- creators -> `authors[]`
- year/date -> `year`
- publication/journal/book title -> `venue` / `publisher`
- DOI -> `external_ids.doi`
- ISBN -> `external_ids.isbn`
- arXiv (from extra) -> `external_ids.arxiv`
- citation key (from extra) -> `cite_key`
- URL -> `urls.landing`
- PDF attachment:
  - local-managed/linked: optional local asset path if available
  - otherwise `urls.pdf` or source attachment URL metadata

Type mapping:
- `journalArticle` -> `work_type: paper`
- `conferencePaper` -> `work_type: paper`
- `book` -> `work_type: book`
- `thesis` -> `work_type: thesis`
- fallback -> `work_type: other`

---

## Dedup Identity Rules

Dedup precedence for incoming items:
1. `import.zotero.item_key` match
2. `external_ids.doi` exact match
3. `external_ids.isbn` exact match
4. `cite_key` exact match
5. Fallback heuristic: normalized `(title, first_author, year)`

If multiple candidates match at same precedence: mark as conflict, skip update, return actionable error payload.

---

## Conflict Policy

Default strategy: **source-wins for mapped fields**, local-wins for non-mapped fields.

Mapped fields (source-wins):
- `title`, `authors`, `year`, `venue`, `publisher`, `external_ids.*`, `urls.*`, `cite_key`

Local-preserved:
- `tags`, `aliases`, note body content, local-only extra metadata

Optional per-request policy:
- `merge_mode: source_wins | local_wins | dry_run`

---

## API Endpoints

Base: `/api/vault/academic/import`

- `POST /zotero/sync`
  - Body: `{ profile, library_type, library_id, since_version?, merge_mode? }`
  - Returns: `{ created, updated, skipped, conflicts, checkpoint }`

- `POST /zotero/link`
  - Link existing work page to Zotero item
  - Body: `{ work_id, library_type, library_id, item_key }`

- `GET /zotero/status`
  - Returns sync health + last checkpoint/version

- `POST /zotero/dry-run`
  - Same as sync, no writes

---

## Checkpointing

Persist sync state in `.clepsydra/importers/zotero.toml`:

```toml
[zotero.default]
library_type = "user"
library_id = "8234867"
last_version = 12345
last_synced_at = "2026-02-06T14:30:00Z"
```

Use Zotero library version/checkpoint to support incremental sync.

---

## Security

- Store API keys outside vault content:
  - OS keychain or server secrets config
- Never write secrets to frontmatter/index DB logs
- Redact keys in API error payloads

---

## Implementation Plan

### Phase 1
- [ ] Zotero client (auth, paging, retries)
- [ ] Item -> `AcademicMeta` mapper
- [ ] Upsert + dedup pipeline
- [ ] `/zotero/dry-run` + `/zotero/sync`

### Phase 2
- [ ] Attachment resolution (local linked vs remote)
- [ ] Incremental sync via checkpoint/version
- [ ] Conflict payload improvements + manual resolve endpoint

### Phase 3
- [ ] Background sync job
- [ ] Webhook/polling support (if available)
- [ ] Adapter interface for BibTeX/Crossref/ISBN importers

---

## Acceptance Criteria

- Re-running sync is idempotent (no duplicate work pages).
- Existing linked works update metadata correctly.
- Local notes/body remain untouched after sync.
- Conflicts are reported with enough detail for manual resolution.
- API keys are never persisted in vault markdown or exposed in logs.
