# RSS reader & start page — design plan

> Source: vault TODO — *"Add an RSS reader and landing/start page. The desired
> outcome is a single home surface containing useful incoming information.
> Inference: this spans feed subscription storage, fetching, parsing, read
> state, refresh/error behavior, and a new UI surface, so it should be designed
> as a subsystem rather than embedded ad hoc in the existing folio."*

## Framing

Two deliverables hide in this TODO, and they should be kept distinct:

1. **A feeds subsystem** — subscriptions, fetching, parsing, entry storage,
   read state. Backend-owned, with its own module boundary, schema namespace,
   and API namespace.
2. **A start page** — the home surface at `/`. RSS is its first tenant, not
   its definition. "A single home surface containing useful incoming
   information" implies the start page is a composition of panels (today: the
   feed river; later: vault activity, reminders, whatever else produces
   "incoming information"). Designing the page as a panel host from day one is
   cheap; retrofitting it later is not.

The current state of the repo makes this greenfield: `src/main.rs` is a
hello-world with zero dependencies, and the UI is a scaffold. So the plan
includes a thin "backend foundations" phase that the feeds subsystem sits on
top of — the subsystem should not smuggle in ad-hoc infrastructure decisions.

## Phase 0 — backend foundations

Decisions the feeds subsystem needs but that belong to clepsydra as a whole:

- **HTTP server**: `axum` on `tokio`. Serves `/api/*` as JSON; in production
  also serves the built UI as static files so the whole system is one binary.
- **Storage**: SQLite via `sqlx` (compile-time-checked queries, built-in
  migrations). A bespoke single-user PKM wants an embedded store; SQLite's
  FTS5 is also a likely future win for vault search.
- **Layout**: `src/main.rs` stays thin (config, pool, router assembly).
  Subsystems live in `src/<name>/` modules — `src/feeds/` is the first.
- **Dev loop**: vite proxy from `ui` to the backend port for `/api`.

## The feeds subsystem (`src/feeds/`)

### Data model

```sql
CREATE TABLE feed (
    id            INTEGER PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,     -- the feed XML/JSON URL
    site_url      TEXT,
    title         TEXT NOT NULL,            -- user-overridable
    description   TEXT,
    added_at      TEXT NOT NULL,
    -- fetch bookkeeping
    etag          TEXT,
    last_modified TEXT,
    last_fetch_at TEXT,
    next_fetch_at TEXT NOT NULL,
    error_count   INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT
);

CREATE TABLE entry (
    id           INTEGER PRIMARY KEY,
    feed_id      INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,             -- dedup key, see below
    url          TEXT,
    title        TEXT NOT NULL,
    author       TEXT,
    content_html TEXT,                      -- sanitized before storage
    published_at TEXT,
    fetched_at   TEXT NOT NULL,
    read_at      TEXT,                      -- NULL = unread
    starred_at   TEXT,                      -- NULL = not starred
    UNIQUE (feed_id, guid)
);
```

Notes:

- **Read state lives on the entry row.** Single-user system; a separate
  read-state table buys nothing.
- **`guid`**: feed-provided id when present, else the entry link, else a hash
  of `title + published_at`. The `UNIQUE(feed_id, guid)` constraint makes
  ingestion idempotent — re-fetching a feed upserts.
- **Starring** is included up front because it's one column and it's the
  natural bridge from "incoming information" to the vault: a starred entry is
  a candidate for capture as a note. (The capture flow itself is out of scope
  here, but the schema shouldn't preclude it.)

### Fetch pipeline

A background task inside the server process — no external cron:

- One `tokio` scheduler loop, ticking ~every minute, selecting feeds where
  `next_fetch_at <= now`, fetching with bounded concurrency (~4).
- **Conditional GET**: send `If-None-Match` / `If-Modified-Since` from stored
  `etag` / `last_modified`; a 304 costs nothing and resets the schedule.
- **Scheduling**: default interval ~30 min. On error, exponential backoff
  (30m → 1h → 2h → … capped at 24h) driven by `error_count`; any success
  resets it. `last_error` stores a human-readable reason for the UI.
- **Parsing**: `feed-rs` (RSS 0.9x/1.0/2.0, Atom, JSON Feed behind one API).
  Entry HTML is sanitized with `ammonia` *at ingestion time*, so everything
  in the DB is safe to render and the UI never handles raw feed HTML.
- **Manual refresh** endpoint sets `next_fetch_at = now` (per-feed or all)
  and pokes the scheduler — refresh reuses the one pipeline rather than
  having a second code path.

### Subscription flow

`POST /api/feeds { url }` accepts either a feed URL or a plain page URL:
fetch, and if the response is HTML, discover the feed via
`<link rel="alternate" type="application/rss+xml|atom+xml">`, then validate by
parsing before inserting. First fetch happens inline so the subscribe
response can include the resolved title and the UI updates immediately.

OPML import/export (`POST /api/feeds/import`, `GET /api/feeds/export`) rides
on the same flow and is the escape hatch that makes the system trustworthy —
subscriptions are never held hostage.

### API surface

```
POST   /api/feeds                     subscribe (feed URL or page URL)
GET    /api/feeds                     list feeds + unread counts + fetch status
PATCH  /api/feeds/:id                 rename, edit
DELETE /api/feeds/:id                 unsubscribe (cascades entries)
POST   /api/feeds/refresh             refresh all (or :id for one)
GET    /api/entries                   cursor-paginated; filters: unread, feed_id, starred
PATCH  /api/entries/:id               { read: bool } / { starred: bool }
POST   /api/entries/mark-read         bulk: by feed, or "everything before cursor X"
POST   /api/feeds/import              OPML in
GET    /api/feeds/export              OPML out
```

Mark-all-read takes a cursor boundary so entries arriving mid-gesture aren't
silently swallowed.

## UI

### Routes

- `/` — **the start page.** A grid/stack of panels. First panel: the feed
  river. The panel contract is deliberately minimal (a title, a body
  component, a data hook) — enough structure that the second panel type slots
  in without redesign, no speculative plugin machinery.
- `/feeds` — subscription management: add (paste URL), rename, unsubscribe,
  OPML import/export, and per-feed health (last fetch, error state, backoff).

### The river

- Unread-first, newest-first, grouped by day; infinite scroll on the entry
  cursor. Compact rows (feed name · title · age) expanding in place to the
  sanitized content — reading happens on the home surface, no navigation away.
- **Read state**: explicit toggle plus mark-on-expand. Optimistic updates via
  TanStack Query mutation + rollback; unread counts invalidate alongside.
- **Error visibility**: a feed in backoff shows a subdued badge in the
  sidebar/management view with `last_error` on hover — errors are visible but
  never block the river; other feeds' entries flow regardless.
- Polling via TanStack Query `refetchInterval` (~2 min) keeps the surface
  live-ish; SSE can replace polling later without UI restructuring.
- `react-aria-components` for interactive pieces (buttons, dialogs, toggles)
  keeps keyboard support mostly free; j/k navigation is a cheap later add.

## Phasing

| Phase | Scope | Outcome |
|---|---|---|
| 0 | axum + sqlx + migrations + static serving + vite proxy | backend skeleton the subsystem sits on |
| 1 | schema, subscribe (incl. discovery), fetch/parse/sanitize pipeline, scheduler, entries API | working subsystem, testable via curl |
| 2 | start page with river panel, `/feeds` management, read state | the TODO's desired outcome, end to end |
| 3 | OPML import/export, mark-all-read, starring UI, keyboard nav, per-feed health polish | daily-drivable |

Each phase leaves the repo in a coherent, shippable state.

## Open questions

1. **Should subscriptions live in the vault instead of SQLite?** A
   `feeds.md`-style note (or frontmatter) as the source of truth would make
   the subscription list human-editable and sync with the vault, with SQLite
   holding only the entry cache and read state. Philosophically appealing for
   a PKM; adds a reconciliation loop. The schema above doesn't preclude
   flipping to this later, but deciding early is cheaper.
2. **Retention** — keep entries forever, or prune read+unstarred entries
   older than N days? Forever is simplest and SQLite won't care for years;
   flagging so it's a decision rather than an accident.
3. **Does "folio" have planned routes/layout conventions** the start page
   should anticipate (e.g. a persistent sidebar shell)? The panel design is
   agnostic, but the `/` route composition should match whatever shell the
   folio ends up with.
