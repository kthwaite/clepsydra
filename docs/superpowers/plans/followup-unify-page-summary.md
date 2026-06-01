# Follow-up: Unify page-summary endpoints (precompute body fields into the index)

**Status:** backlog (logged 2026-06-01 during §7 Plan 1 execution). Not §7-blocking.

## Problem

Two overlapping page-summary types exist for one reason — cost:

- `PageSummary` (`GET /api/vault/pages`) — pure SQLite index columns; cheap. Now carries `id, path, title, canonical_name, kind, inferred, project, tags`.
- `ContentEntry` (`GET /api/vault/index/content-index`) — additionally `description` (200-char excerpt), `word_count`, `links`. Computes excerpt/word_count by reading **every page file from disk** (`Page::from_file` per page) on **every request**. GAZETTEER + Atrium consume this.

Two near-duplicate types + a per-request N-file disk read is both a DRY smell and a latent perf problem on large vaults.

## Proposed direction (the "good" collapse)

1. **Precompute `excerpt` + `word_count` into the index at index time.** The indexer already reads every body (it populates `pages_fts`), so deriving a 200-char excerpt + word count and storing them as `pages` columns (or a `page_content` table) is nearly free — mirrors how `kind`/`kind_inferred`/`project` were added (ADR-less, derived-only, re-derived each build). Add an idempotent migration like `migrate_pages_add_kind_columns`.
2. **content-index stops reading files per request** — it becomes a pure index query (perf win). `links` already come from the `links` table.
3. **Collapse to one summary type + one endpoint.** Make `PageSummary` the superset (add `excerpt`, `word_count`, `links`); retire `ContentEntry` (or keep a thin alias during migration). Reuse the `page_summary_from_row` helper.
4. **Migrate consumers** — GAZETTEER, Atrium, PageList, pickers/WikilinkCombobox — to the unified type; regenerate `ui/src/api/schema.d.ts`; delete the dead type.

## Why not now

It's a real refactor (new index columns + indexer work + endpoint consolidation + multi-consumer frontend migration + OpenAPI/type regen), larger than §7's Task 8. §7 closes the immediate gap by adding `kind`/`inferred`/`project` to `ContentEntry` (Task 8); this unification is the cleaner end-state to do as its own plan afterward.

## Acceptance

- One page-summary type; `content-index`'s per-request disk reads gone (excerpt/word_count served from the index); all current consumers unchanged in behaviour; full `cargo test` + frontend checks green.
