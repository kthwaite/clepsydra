# Codex Reading Log · stub

**Status:** deferred (placed behind `VITE_ENABLE_PROSPECTIVE_PANELS` flag in Atrium/Diurnal)
**Why deferred:** requires a domain model that does not yet exist in the vault layer.

## What's needed
- A `books` table with title, author, total_pages, current_page, started_at, finished_at
- An endpoint to list active books and update progress
- The "Reading Continues" panel (currently hardcoded Calvino/Borges/Murray entries) consumes this

## Open questions
- Are books a kind of vault page (with frontmatter), or a separate model?
- How is progress recorded — a journal entry, a quick UI control, or import from Goodreads/Kavita?
- Should the panel show only active reads or also queued/finished?

## Touchpoints when this lands
- ui/src/components/codex/Atrium.tsx · the gated "Reading Continues" panel
- ui/src/api/books.ts · new hook
- src/api/books_routes.rs · new endpoints
- src/vault/books.rs · domain logic
