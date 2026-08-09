# Clepsydra UI

React frontend for browsing and editing the vault.

## Prerequisites

- Bun
- Clepsydra API server running at `http://127.0.0.1:3000`

From repo root, start the backend in another terminal:

```bash
cargo run -- serve
```

## Run locally

```bash
cd ui
bun install
bun run dev
```

Open the Vite URL (usually `http://127.0.0.1:5173`).

The dev server proxies `/api/*` requests to `http://127.0.0.1:3000`.

## Scripts

```bash
bun run dev              # start local dev server
bun run build            # typecheck + production build
bun run typecheck        # TypeScript checks only
bun run lint             # Biome lint
bun run format           # Biome autofix
bun run test             # Vitest
bun run test:watch       # Vitest watch
bun run storybook        # Storybook on :6006
bun run build-storybook  # static Storybook build
bun run openapi          # regenerate src/api/schema.d.ts from backend
```

## What’s currently implemented

- Dashboard with vault stats, tags, and recent/all pages
- Sidebar file tree + create note/folder dialogs
- Tabbed workspace (page tabs + graph tab)
- Page editor (Slate-based) with:
  - title/tags/aliases editing
  - wikilink suggestions after typing `[[`
  - autosave with status indicator
  - inline and display TeX math using `$...$`, `\(...\)`, `$$...$$`, or `\[...\]`
  - click rendered math, or focus it and press `Enter`, to edit the exact source; invalid source remains visible unchanged
  - Folio supports KaTeX-compatible TeX, not complete LaTeX documents or every MathJax extension.
- Backlinks panel on page tabs
- Graph view (`/graph` → graph tab)
- Search palette
- Theme toggle (light/dark)
- Live sync indicator via SSE (`/api/vault/events`)

## Keyboard shortcuts

- `⌘K` / `Ctrl+K`: open search palette
- `⌘S` / `Ctrl+S` (in editor): save now
- `⌘W` / `Ctrl+W`: close active workspace tab
- `Ctrl+Tab`: next tab
- `Ctrl+Shift+Tab`: previous tab
- `Esc`: close search/settings overlays

## Tab interactions

- Drag tab to reorder
- Middle-click tab to close
- Right-click tab for context menu (`Close`, `Close Others`)

## Regenerating API types

When backend OpenAPI changes:

1. Ensure backend is running (`cargo run -- serve`)
2. Run:

```bash
cd ui
bun run openapi
```

This updates `ui/src/api/schema.d.ts`.

## Architecture notes

- UI component audit: [../docs/design-notes/react-aria-component-audit.md](../docs/design-notes/react-aria-component-audit.md)
- UI migration plan: [../docs/plans/2026-04-09-react-aria-ui-migration.md](../docs/plans/2026-04-09-react-aria-ui-migration.md)

## Troubleshooting

- **UI shows API errors / no data**
  - Confirm backend is running on `127.0.0.1:3000`
  - Check `http://127.0.0.1:3000/docs`
- **`bun run openapi` fails**
  - Backend probably not running, or OpenAPI endpoint unavailable
- **Realtime indicator stays disconnected**
  - Verify SSE endpoint `GET /api/vault/events` is reachable
