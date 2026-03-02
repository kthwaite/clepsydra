# Block References (Transclusion) — Design

**Date:** 2026-03-02
**Status:** Approved

## Overview

Block references allow embedding the content of one block inside another page using `((block-id))` syntax. The referenced block's text is rendered inline as a read-only transclusion — you see the content right there, not just a link.

## Foundational Decisions

- **Syntax:** `((block-id))` — double-parens wrapping an 11-char alphanumeric block ID. Logseq convention.
- **Behavior:** Transclusion (embed), not link. The referenced block's content is displayed inline, read-only.
- **ID assignment:** Auto-assign on reference. When a user creates a `((ref))` to a block that lacks a `^id`, the system generates one, writes it to the source file, and re-indexes.
- **Editability:** Read-only in v1. Click navigates to the source page to edit.
- **Autocomplete:** Search by block content text. Type `((` to trigger, search across all blocks.
- **Depth:** One level only — a block ref inside a transcluded block renders as literal `((id))` text, not a nested embed.

## 1. Data Model

### Link storage

Block references are stored in the existing `links` table as a new `LinkKind::BlockRef` variant:

- `kind = "block_ref"`
- `target_raw` = the block ID string (e.g., `abc123DEF0`)
- `target_id` = resolved to the page containing the block
- New column `target_block_id TEXT` on `links` — stores the block ID for efficient joins

No new tables. One column addition to `links`.

### Resolution

Block ref links resolve differently from wikilinks:

1. Query `SELECT page_id FROM blocks WHERE block_id = ?`
2. If found: set `links.target_id = page_id`, `links.target_block_id = block_id`
3. If not found: leave unresolved (block may not exist yet or was deleted)

Resolution is re-run on page index, same as wikilinks.

### Backlinks

Block references create backlinks. "Page X references this block" appears in the backlinks panel of the page containing the referenced block.

## 2. Backend — Parsing

### Link extraction (`src/vault/link.rs`)

New regex applied alongside the wikilink regex on merged text events:

```
\(\(([A-Za-z0-9]{10,12})\)\)
```

Emits `Link { target_raw: id, kind: LinkKind::BlockRef, span }`.

Skipped inside code blocks and inline code (same as wikilinks).

### Link derivation (`src/vault/derivers/links.rs`)

Block ref links stored with:
- `target_canonical = NULL` (they don't resolve by page name)
- `target_block_id` = the raw block ID

### Link resolution (`VaultIndex::resolve_links`)

New resolution path for `kind = "block_ref"` links, separate from the canonical name matching used for wikilinks.

## 3. Backend — API Endpoints

### `GET /api/vault/blocks/{block_id}`

Returns a single block by ID. Needed for frontend transclusion rendering.

**Response:**
```json
{
  "block_id": "abc123DEF0",
  "content": "Write proposal",
  "block_type": "listitem",
  "properties": { "due": "2026-03-01" },
  "page_path": "journals/2026-02-17",
  "page_title": "2026-02-17",
  "span_start": 42,
  "span_end": 98
}
```

Returns 404 if block ID not found.

### `GET /api/vault/blocks/search?q=&limit=`

Searches block content text for autocomplete. Returns blocks with page context.

- Searches `blocks.content` with `LIKE '%query%'` (case-insensitive)
- Only returns referenceable block types: list items, paragraphs, headings (not code blocks)
- Default limit: 8
- Response: array of block objects (same shape as above)

### `POST /api/vault/blocks/assign-id`

Assigns a `^id` to a block that doesn't have one.

**Request body:**
```json
{
  "page_path": "journals/2026-02-17",
  "span_start": 42
}
```

**Behavior:**
1. Generates a new `BlockId`
2. Reads the source markdown file
3. Inserts ` ^{id}` at the end of the block's text (before the newline at `span_end`)
4. Writes file back to disk
5. Re-indexes the page
6. Returns `{ "block_id": "abc123DEF0" }`

## 4. Frontend — Editor

### Slate element type

```typescript
interface BlockRefElement {
  type: "block-ref";
  blockId: string;
  children: CustomText[]; // Slate invariant: [{ text: "" }]
}
```

Inline void element — same pattern as `WikilinkElement`.

### Plugin (`withBlockRefs`)

Extends the editor to mark `block-ref` as inline + void. Can be added to the existing `withWikilinks` plugin or standalone.

### MDAST-to-Slate conversion

Regex post-processing on text nodes in `mdast-to-slate.ts`: detect `((id))` patterns, split text node, insert `BlockRefElement` inline node. Same approach used for wikilinks.

### Slate-to-MDAST conversion

Serialize `block-ref` elements back to `((blockId))` literal text in `slate-to-mdast.ts`.

### Rendering (`BlockRefElement.tsx`)

Non-editable inline element that:
1. Fetches block content via `useBlockById(blockId)` (TanStack Query hook calling `GET /blocks/{blockId}`)
2. Renders block text in a bordered container with muted background
3. Shows loading skeleton while fetching
4. Shows error state if block not found (red border, "block not found" text)
5. Click navigates to source page via `useOpenTab`

### Autocomplete (`BlockRefCombobox.tsx`)

Triggered by typing `((` in the editor:
1. Detects `((` trigger (same mechanism as `[[` for wikilinks)
2. Queries `GET /api/vault/blocks/search?q=...&limit=8`
3. Shows results with block content preview + source page path
4. On selection:
   - If block already has `^id`: inserts `((id))` directly
   - If block has no `^id`: calls `POST /blocks/assign-id`, waits for response, then inserts `((newId))`

## 5. Edge Cases

**Re-indexing stability:** References resolve by `block_id`, not by `span_start`. Edits to the source page may shift spans but the ID stays stable.

**Deleted blocks:** Block's `blocks` row disappears on re-index. Ref links become unresolved. Editor renders as "block not found" indicator.

**Moved blocks:** If a block (with its `^id` text) is moved to a different page via cut/paste, the `blocks` row points to the new page after re-index. References re-resolve to the new location automatically.

**Circular references:** Safe. Transclusions render one level of content text only — a `((ref))` inside a transcluded block shows as literal `((id))` text, not a nested embed.

## 6. Non-goals (v1)

- Nested/recursive transclusion (embeds within embeds)
- Drag-and-drop block references
- Block ref count display
- Inline editing of transcluded content
- `{{embed ((id))}}` alternative syntax
- Block-level backlinks panel (distinct from page-level)
