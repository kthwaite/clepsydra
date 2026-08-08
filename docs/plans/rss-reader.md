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

## Subscriptions live in the vault: `feeds.md`

**Decision:** the subscription list is a note in the vault, not a database
table the user can't see. `feeds.md` is the single source of truth for *what*
is subscribed and how it's organized; SQLite holds only machine state — the
entry cache, read state, and fetch bookkeeping.

### Format

Markdown sections are groups (mirroring Reeder-style groups: news, tech news,
subreddits, blogs…). Tags attach to sections inline on the heading, and to
individual feeds on the list item; a feed inherits its section's tags and may
add its own.

```markdown
## News #news

- https://www.theguardian.com/world/rss
- [FT](https://www.ft.com/rss/home) #finance

## Tech News #news #tech

- https://arstechnica.com/feed/
- [Hacker News](https://news.ycombinator.com/rss) #hn

## Blogs #reading

- https://danluu.com/atom.xml
```

Rules, kept deliberately few:

- A list item is either a bare URL or a `[Title](url)` link; the link title is
  a display-name override, otherwise the feed's self-reported title is used.
- `#tag` tokens after the heading text or list item are tags. Nothing else on
  the line is interpreted.
- Unrecognized lines (prose between sections, etc.) are preserved and ignored
  — the note remains a note; the parser takes what it understands.

### Reconciliation

A `feeds.md` parser + differ in the subsystem:

- **File → DB**: on startup, on file change (watcher), and before each
  scheduler sweep, parse `feeds.md` and diff against the `feed` table: insert
  new URLs, update group/tags/title-override, and mark removed URLs
  unsubscribed. Unsubscription drops unread entries but respects retention
  for bookmarked ones (below).
- **UI → file**: subscribe/rename/regroup actions in the UI *edit `feeds.md`*
  (append to a section, rewrite a line) and then reconcile. The file is the
  only write path for subscription data, so there is exactly one source of
  truth and hand-edits and UI edits can't diverge.
- Parse errors never brick the reader: the last good subscription set stays
  active and the UI surfaces a "feeds.md has a problem on line N" notice.

### Schema

```sql
CREATE TABLE feed (
    id            INTEGER PRIMARY KEY,
    url           TEXT NOT NULL UNIQUE,     -- the feed XML/JSON URL
    site_url      TEXT,
    title         TEXT NOT NULL,            -- from feed; feeds.md may override
    title_override TEXT,
    group_name    TEXT,                     -- section heading from feeds.md
    tags          TEXT NOT NULL DEFAULT '[]', -- JSON array, synced from feeds.md
    subscribed    INTEGER NOT NULL DEFAULT 1,
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
    id            INTEGER PRIMARY KEY,
    feed_id       INTEGER NOT NULL REFERENCES feed(id) ON DELETE CASCADE,
    guid          TEXT NOT NULL,            -- dedup key, see below
    url           TEXT,
    title         TEXT NOT NULL,
    author        TEXT,
    content_html  TEXT,                     -- sanitized before storage
    published_at  TEXT,
    fetched_at    TEXT NOT NULL,
    read_at       TEXT,                     -- NULL = unread
    bookmarked_at TEXT,                     -- NULL = not bookmarked
    UNIQUE (feed_id, guid)
);

CREATE TABLE entry_tag (
    entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
);
```

Notes:

- **Read state lives on the entry row.** Single-user system; a separate
  read-state table buys nothing.
- **`guid`**: feed-provided id when present, else the entry link, else a hash
  of `title + published_at`. The `UNIQUE(feed_id, guid)` constraint makes
  ingestion idempotent — re-fetching a feed upserts.
- Feed tags are denormalized JSON because `feeds.md` is their source of truth
  — the DB copy is a synced cache, not something to maintain relationally.
  Entry tags get a real table because the user authors them in the UI.

## Retention & bookmarking

**Decision:** entries are ephemeral by default; bookmarking makes them
permanent and note-like.

- **Pruning**: a daily job deletes entries that are read, not bookmarked, and
  older than N days (`retention_days`, default 30; unread entries also expire
  at a longer horizon, e.g. 90 days, so a dormant feed can't hoard forever).
- **Bookmarking** (`bookmarked_at`) exempts an entry from pruning
  indefinitely — including surviving unsubscription of its feed (the prune
  job skips bookmarked entries; feed deletion switches from CASCADE to a
  soft-unsubscribe when bookmarks exist).
- **Note affordances for bookmarked entries**, added where they make sense
  rather than wholesale:
  - **tags** (`entry_tag`) — first-class, filterable in the UI, same tag
    vocabulary as feed tags;
  - a short **annotation** field (a "why I kept this" line) is a cheap,
    likely follow-on — column reserved but UI deferred to phase 3;
  - full **capture into the vault** (materialize a bookmarked entry as a
    note) is the eventual bridge and explicitly out of scope here; the
    schema above is sufficient for it later.

## Fetch pipeline

A background task inside the server process — no external cron:

- One `tokio` scheduler loop, ticking ~every minute: reconcile `feeds.md` if
  changed, select feeds where `next_fetch_at <= now`, fetch with bounded
  concurrency (~4), then run the daily prune when due.
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

## Subscription flow

`POST /api/feeds { url, group }` accepts either a feed URL or a plain page
URL: fetch, and if the response is HTML, discover the feed via
`<link rel="alternate" type="application/rss+xml|atom+xml">`, validate by
parsing, then **append to the named section of `feeds.md`** and reconcile.
First fetch happens inline so the subscribe response includes the resolved
title and the UI updates immediately.

OPML import/export (`POST /api/feeds/import`, `GET /api/feeds/export`) maps
OPML `<outline>` folders to `feeds.md` sections in both directions — the
escape hatch that makes the system trustworthy, and the migration path from
Reeder (which exports OPML with groups intact).

## API surface

```
POST   /api/feeds                     subscribe { url, group } → edits feeds.md
GET    /api/feeds                     list feeds grouped, + unread counts + fetch status
PATCH  /api/feeds/:id                 rename / regroup → edits feeds.md
DELETE /api/feeds/:id                 unsubscribe → edits feeds.md
POST   /api/feeds/refresh             refresh all (or :id for one)
GET    /api/entries                   cursor-paginated; filters: unread, feed_id,
                                      group, tag, bookmarked
PATCH  /api/entries/:id               { read } / { bookmarked } / { tags }
POST   /api/entries/mark-read         bulk: by feed or group, bounded by cursor
POST   /api/feeds/import              OPML in (folders → sections)
GET    /api/feeds/export              OPML out (sections → folders)
```

Mark-all-read takes a cursor boundary so entries arriving mid-gesture aren't
silently swallowed.

## UI

### Shell

**Decision:** clepsydra has a persistent frame. Today's `__root.tsx` is only
an empty full-viewport `<main>` wrapper, so the frame is built as part of this
work, not retrofitted: `__root.tsx` owns an app shell — a persistent sidebar
with top-level navigation (Home, the future note-browsing surface, Feeds) —
and every route renders inside it. Feed groups and their unread counts live
in this shared sidebar, not privately inside the river panel, so they remain
visible from any surface.

### Routes

- `/` — **the start page**, rendered inside the shell. A grid/stack of
  panels. First panel: the feed river. The panel contract is deliberately
  minimal (a title, a body component, a data hook) — enough structure that
  the second panel type slots in without redesign, no speculative plugin
  machinery.
- `/feeds` — subscription management: add (paste URL, pick group), rename,
  regroup, unsubscribe, OPML import/export, and per-feed health (last fetch,
  error state, backoff). All subscription edits route through `feeds.md`.

### The river

- Unread-first, newest-first, grouped by day; infinite scroll on the entry
  cursor. Compact rows (feed name · title · age) expanding in place to the
  sanitized content — reading happens on the home surface, no navigation away.
- **Groups as the primary filter**, Reeder-style: the shell sidebar lists
  groups (from `feeds.md` sections) with per-group unread counts, then feeds
  within; selecting scopes the river. Tag filtering rides the same control.
- **Bookmarks view**: a filter of the river (`bookmarked=true`) showing kept
  entries with their tags; tag-editing inline.
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
| 1 | `feeds.md` parser + reconciler, schema, subscribe (incl. discovery), fetch/parse/sanitize pipeline, scheduler, prune job, entries API | working subsystem, testable via curl and by hand-editing `feeds.md` |
| 2 | app shell in `__root.tsx` (persistent sidebar/nav), start page with river panel, `/feeds` management, read state, bookmarking | the TODO's desired outcome, end to end |
| 3 | OPML import/export, mark-all-read, entry tags UI, annotations, keyboard nav, per-feed health polish | daily-drivable; Reeder migration possible |

Each phase leaves the repo in a coherent, shippable state.

## Resolved questions

1. ~~Should subscriptions live in the vault?~~ **Yes** — `feeds.md` with
   sections-as-groups and inline `#tags`; see above.
2. ~~Retention?~~ **Prune after N days; bookmarking retains indefinitely**
   and brings note affordances (tags now, annotations soon, vault capture
   eventually); see above.
3. ~~What shell should the start page assume?~~ **A persistent frame.** The
   current `__root.tsx` is an empty wrapper, so the shell is built here
   (phase 2) rather than retrofitted; see *Shell* above.
