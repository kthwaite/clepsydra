# Tasks + Journals + Agenda v1 & Block/Outliner Core v1 — Design

**Date:** 2026-02-17
**Status:** Approved

## Foundational Decisions

- **Source of truth:** Markdown files on disk. The DB caches a derived block tree, rebuildable from files (same pattern as current `links` table).
- **Block granularity:** List items, paragraphs, headings, code blocks, blockquotes — matches the existing Slate element model.
- **Block IDs:** Obsidian-style `^id` at end of line. Lazy assignment (only when a block is referenced). Short randflake format (~10-12 chars base62, time-sorted + random suffix).
- **Block properties:** Dataview-style `[key:: value]` inline syntax.
- **Task model:** A task is a block with checkbox status (`- [ ]` / `- [x]`) plus optional properties. No separate task entity.
- **Journal model:** Convention path `journals/YYYY-MM-DD.md`. Recognized by path pattern, not frontmatter type field.

## 1. Block Data Model

### Schema: `blocks` table (derived, rebuildable)

```sql
CREATE TABLE blocks (
    block_id    TEXT,                   -- randflake ID (NULL for blocks without one)
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_type  TEXT NOT NULL,          -- 'paragraph', 'list-item', 'heading', 'code', 'blockquote'
    parent_id   TEXT,                   -- parent block_id (NULL for top-level)
    order_index INTEGER NOT NULL,       -- sibling ordering within parent
    content     TEXT NOT NULL,          -- raw text content (no markup)
    depth       INTEGER NOT NULL,       -- nesting depth (0 = top-level)
    span_start  INTEGER NOT NULL,       -- byte offset in source markdown
    span_end    INTEGER NOT NULL,       -- byte offset end
    PRIMARY KEY (page_id, span_start)
);

CREATE INDEX idx_blocks_block_id ON blocks(block_id) WHERE block_id IS NOT NULL;
```

### Schema: `block_properties` table (derived)

```sql
CREATE TABLE block_properties (
    page_id     TEXT NOT NULL,
    span_start  INTEGER NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    FOREIGN KEY (page_id, span_start) REFERENCES blocks(page_id, span_start) ON DELETE CASCADE,
    PRIMARY KEY (page_id, span_start, key)
);

CREATE INDEX idx_block_props_key_value ON block_properties(key, value);
```

### Task properties (stored as block_properties)

- `status` — `todo`, `doing`, `done`, `cancelled` (derived from `- [ ]`, `- [x]`, `- [-]`, etc.)
- `due` — ISO date
- `scheduled` — ISO date
- `priority` — `A`, `B`, `C`
- Any user-defined `[key:: value]`

### Indexing flow

1. Indexer parses markdown, builds block tree from structure (list nesting = parent/child).
2. Blocks with `^id` get their `block_id` populated; others have NULL.
3. `[key:: value]` patterns parsed and stored in `block_properties`.
4. `- [ ]` / `- [x]` patterns set `status` property automatically.
5. Entire block tree re-derived on page save (same as link re-indexing today).

### Example markdown

```markdown
- [ ] Write proposal [due:: 2026-03-01] [priority:: A] ^7QSYHps6GRs
  - [ ] Draft outline
  - [ ] Review with team
- [x] Buy groceries
```

## 2. Journals + Daily Notes

### Path convention

Journal pages live at `journals/YYYY-MM-DD.md`. The indexer detects pages matching `journals/\d{4}-\d{2}-\d{2}\.md` and populates a derived `journal_date` column:

```sql
ALTER TABLE pages ADD COLUMN journal_date TEXT;
CREATE INDEX idx_pages_journal_date ON pages(journal_date) WHERE journal_date IS NOT NULL;
```

### Auto-creation

When the API receives a request for today's journal and it doesn't exist, it creates the page with a minimal template:

```markdown
---
id: <uuid>
title: "2026-02-17"
tags: [journal]
---

```

### Carry-forward

When today's journal is created, the server scans recent journal pages for incomplete tasks. These are surfaced in the API response, *not* copied into today's file. The UI renders them as "carried forward" items the user can explicitly pull in or reschedule. No silent mutation of files.

### API endpoints

```
GET  /api/vault/journal/today              -- Get or create today's journal page
GET  /api/vault/journal/:date              -- Get journal for specific date
GET  /api/vault/journal/range?from=&to=    -- Journal pages in date range
GET  /api/vault/journal/recent?days=7      -- Last N days of journals
```

Thin wrappers over existing page API — resolve date to `journals/YYYY-MM-DD.md` and delegate. Only `today` auto-creates.

### Quick capture

```
POST /api/vault/journal/today/capture
Body: { "content": "- [ ] Call dentist [due:: 2026-02-20]" }
```

Appends to today's journal file and re-indexes. Avoids editor conflicts when capturing from extension/widget.

## 3. Agenda + Task Queries

### Task query endpoint

```
GET /api/vault/tasks?status=todo&due_before=2026-02-24&sort=due
```

**Filter params:**
- `status` — `todo`, `doing`, `done`, `cancelled` (comma-separated)
- `due_before`, `due_after` — ISO date range
- `scheduled_before`, `scheduled_after` — ISO date range
- `priority` — `A`, `B`, `C`
- `tag` — page tag filter (join through `pages`)
- `page` — page path prefix (e.g., `projects/`)
- `has_no_date` — `true` for unscheduled tasks (inbox)
- `sort` — `due`, `priority`, `scheduled`, `page` (default: `due`)
- `limit`, `offset` — pagination

**Response shape:**

```json
{
  "tasks": [
    {
      "block_id": "7QSYHps6GRs",
      "content": "Call dentist",
      "status": "todo",
      "properties": { "due": "2026-02-20", "priority": "A" },
      "page_path": "journals/2026-02-17",
      "page_title": "2026-02-17",
      "span_start": 142,
      "span_end": 198
    }
  ],
  "total": 47
}
```

### Agenda endpoints (convenience wrappers)

```
GET /api/vault/agenda/today      -- due today + overdue + scheduled today
GET /api/vault/agenda/week       -- next 7 days, grouped by date
GET /api/vault/agenda/overdue    -- past due, status != done/cancelled
```

The `today` endpoint unions:
1. Tasks with `due = today`
2. Tasks with `scheduled = today`
3. Tasks with `due < today` and `status = todo` (overdue)
4. Incomplete tasks from today's journal page

### Task status mutation

```
PUT /api/vault/tasks/:page_path/:span_start/status
Body: { "status": "done" }
```

Reads the markdown file, finds the checkbox at the given span, rewrites `- [ ]` to `- [x]` (or `- [-]` for cancelled), writes file back, re-indexes. Mutation operates on markdown source; DB is re-derived afterward.

### UI views

1. **Today** — agenda/today + today's journal inline editor
2. **Upcoming** — agenda/week grouped by date, collapsible
3. **Inbox** — tasks with `has_no_date=true`, for triage

## 4. Block/Outliner Core

### Block operations

| Operation | Key binding | Slate effect | Markdown effect |
|-----------|------------|-------------|----------------|
| Split block | `Enter` on list item | Split node at cursor into two siblings | New `- ` line at same indent |
| Indent | `Tab` | Move item to be child of previous sibling | +2 spaces indent |
| Outdent | `Shift+Tab` | Move item to be sibling of parent | -2 spaces indent |
| Move up | `Alt+Up` | Swap with previous sibling (keep children) | Swap line groups |
| Move down | `Alt+Down` | Swap with next sibling (keep children) | Swap line groups |
| Toggle done | `Cmd+Enter` | Toggle `- [ ]` ↔ `- [x]` | Rewrite checkbox |
| Delete/merge | `Backspace` at start | Merge with previous sibling | Join lines |

### Collapse/expand

- Blocks with children get a collapse toggle.
- Collapsed state persisted as `[collapsed:: true]` inline property.
- Slate hides children from rendering but keeps them in document model.
- Content always present in markdown file.

### Outliner-aware block types

- **List items** — full outliner behavior (indent/outdent/move/split/merge)
- **Headings** — move reorders sections; indent/outdent changes heading level
- **Paragraphs** — split creates new paragraph; can enter list context
- **Code blocks, blockquotes** — move works; indent/outdent not applicable

### Slate model additions

Fields added to element types in `ui/src/editor/types.ts`:

- `block_id?: string` — optional, populated when block has `^id` marker
- `properties?: Record<string, string>` — inline `[key:: value]` pairs
- `collapsed?: boolean` — drives child visibility
- `checked?: boolean | null` — `null` = not a task, `false` = `[ ]`, `true` = `[x]`

### Converter changes

- **mdast-to-slate:** Parse `^id` from end of text → `block_id`. Parse `[key:: value]` → `properties`. Parse checkboxes → `checked`.
- **slate-to-mdast:** Serialize back: append `^id`, append `[key:: value]`, write `[ ]`/`[x]`.

## 5. Implementation Scope

### What changes where

| Layer | Changes |
|-------|---------|
| Schema | `journal_date` on `pages`; `blocks` + `block_properties` tables |
| Indexer (`src/vault/index.rs`) | Block tree extraction, property parsing, checkbox detection, `^id` parsing |
| Parser (new `src/vault/block.rs`) | Markdown → block tree with properties; randflake ID generation |
| API (`src/api/`) | Journal endpoints, task query, agenda, task status mutation, quick capture |
| Slate types (`ui/src/editor/types.ts`) | `block_id`, `properties`, `collapsed`, `checked` fields |
| Converters (`ui/src/editor/convert/`) | Round-trip `^id`, `[key:: value]`, checkbox state |
| Editor plugins (`ui/src/editor/plugins/`) | Outliner keybindings |
| UI routes | `/agenda`, `/journal/:date` routes + components |

### Non-goals for v1

- Block references / embeds (`((block-id))`)
- Drag-and-drop reordering
- Multi-block selection + batch operations
- Block-level backlinks panel
- Query DSL / saved queries
- Recurring tasks
- Weekly review auto-generation
