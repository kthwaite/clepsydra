# clepsydra

a bespoke personal knowledge management system.

## structure

- `src/` — Rust backend: axum + SQLite, one binary serving `/api` and the
  built UI. Subsystems live in `src/<name>/`; `src/feeds/` (RSS reader) is
  the first. Design notes in `docs/plans/`.
- `ui/` — React UI (Vite, TanStack Router/Query, Tailwind). The start page
  at `/` is a panel host; the feed river is its first panel.

## feeds

Subscriptions are a note: `feeds.md` in the vault is the source of truth.
`##` sections are groups; trailing `#tags` on a heading tag the section, on a
list item that feed. Edit the file or use the UI — both converge. SQLite
holds only the entry cache, read state, and fetch bookkeeping. Entries are
pruned after `CLEPSYDRA_RETENTION_DAYS` (default 30); saved (bookmarked)
entries are kept forever.

## running

```sh
# backend (creates vault/feeds.md and clepsydra.db on first run)
cargo run

# ui dev server, proxies /api to the backend
cd ui && bun install && bun run dev

# production: build the ui, then the single binary serves everything
cd ui && bun run build && cd .. && cargo run
```

Configuration via environment: `CLEPSYDRA_PORT` (8640), `CLEPSYDRA_VAULT`
(`vault/`), `CLEPSYDRA_DB` (`clepsydra.db`), `CLEPSYDRA_UI_DIST` (`ui/dist`),
`CLEPSYDRA_FETCH_INTERVAL_MINS` (30), `CLEPSYDRA_RETENTION_DAYS` (30),
`CLEPSYDRA_UNREAD_RETENTION_DAYS` (90).
