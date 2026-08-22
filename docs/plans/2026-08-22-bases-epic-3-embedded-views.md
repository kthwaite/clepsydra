# Bases Epic 3 (TSK-0067) — Embedded Base views

Status: in progress, branch `feature/bases-embedded-views`.

## What already holds

Four of the epic's eleven checks rest on machinery that exists:

- The engine returns an **authoritative total** independent of the row window:
  `QueryOutput::Flat { total }` counts the whole predicate
  (`src/vault/query.rs:880`), and each `GroupResult.total` counts the whole
  group with its aggregates computed over the group, not the window
  (`src/vault/query.rs:1017`). Bounded windows therefore cannot lie.
- `QuerySpec.offset` is already compiled into the SQL
  (`src/vault/query.rs:1267`); only the *embed* evaluate request lacks the key.
- Typed property editing and Add member already run through the shared
  `BaseTableView`, so an embed inherits both (Epic 2).
- `BaseTableView` already renders a cap notice from `total` vs rendered rows.

The live remainder is compact chrome, per-embed width, and replacing the
uncapped render with a scroller.

## Decisions

| Question | Decision |
| --- | --- |
| Getting past the cap | Virtualized scroll: a bounded viewport that fetches the next window as the reader approaches the end |
| Per-embed width | A `width` key in the fence TOML — Slate nodes have no stable id, so a device-local store has nothing to key on |
| Compact mode | Default for embeds; `display = "full"` opts out |
| Grouped views | A bounded window per group with its authoritative total; no per-group paging |

### `limit` keeps its meaning

`limit` today is the author's cap: "show at most N". Reinterpreting it as a
page size would turn a deliberate `limit = 10` into an infinite scroller. So:

- `limit` set → a hard ceiling. The scroller stops there and says so.
- `limit` absent → previously **uncapped** (the failure mode this epic exists
  to remove). Now windows of 50 fetched on scroll, up to the true total.

The window size is an internal constant, never authored.

### The fence

```toml
base = "reading"
view = "unread"
display = "full"   # optional; compact is the default
width = 1100       # optional; integer px, 480–1600
```

Both keys are presentation, not query inputs. They live on the element node but
**outside** `BaseEmbedConfig`, so `queryIdentity` ignores them and resizing an
embed never refetches. Neither key is written unless the author set it — the
Epic 1 rule that saving must not rewrite what the user did not touch.

### Width against the reading column

An embed may exceed the reading column — that is the point of a width — but
never the pane. Pure CSS, no JS layout:

```css
width: var(--embed-w);
max-width: var(--folio-pane-w, 100%);
margin-left: calc((100% - min(var(--embed-w), var(--folio-pane-w, 100%))) / 2);
```

`100%` is the reading column; the negative margin bleeds symmetrically.
`useReadingColumn` already measures the pane (TSK-0082), so the Folio publishes
`--folio-pane-w` from the value it has. Anywhere else the variable is unset and
the embed simply fills its container.

### Virtualization shape

RAC 1.20 exports `Virtualizer` and `TableLayout`. Virtualized, RAC renders
`role="grid"` **divs** instead of `<table>` — the ARIA roles are unchanged, so
role-based tests keep working, but the layout must be CSS grid rather than
table layout. Therefore:

- **compact** — always virtualized, fixed 32px rows, single-line cells,
  horizontal overflow inside the viewport.
- **full** — today's native table, unchanged.

A threshold that switched layouts mid-scroll would restyle the table under the
reader, so the mode decides, not the row count.

In jsdom the viewport measures 0 and the virtualizer renders every row. Tests
can prove the markup, the fetch windows and the row content; they cannot prove
that off-screen rows are skipped. That needs a browser.

## Tasks

Each is red-first: the failing test, then the implementation.

1. **Server window** — `offset` on `BaseViewEvaluateRequest`, plumbed to
   `QuerySpec`; an absent `limit` becomes the 50-row window instead of
   uncapped, so grouped output can no longer be `GroupRowLimit::Unlimited`.
   Then regenerate `schema.d.ts`.
2. **Fence keys** — `display` and `width` parsed, validated, serialized and
   round-tripped in `baseEmbedMarkdown.ts`; unknown-key rejection intact.
3. **Element and inspector** — `BaseEmbedPresentation` on the node; inspector
   controls with diagnostics; `queryIdentity` provably unaffected.
4. **Compact chrome** — `chrome` and `toolbarActions` on `BaseTableView`; the
   embed's separate header disappears into the table toolbar; focus guards and
   Escape behaviour unchanged.
5. **Width** — `embed-width.ts` (clamp, style) and a `WidthResizer` extracted
   from `ReadingColumnResizer`, so both splitters are one implementation.
   Pointer drags commit once, on release, not per frame.
6. **Row windows** — `useEmbedRows`: successive offsets, rows deduped by id
   (a concurrent insert shifts every later window), the author's cap honoured,
   `total`/`hasMore`/`isLoadingMore` exposed.
7. **Controller** — the single evaluation query becomes the windowed one
   without disturbing the member-creation lifecycle.
8. **The scroller** — virtualized compact grid, bounded viewport, fetch on
   approach, sticky header, and the five states: loading, empty, missing
   reference, stale, query error.
9. **Grouped** — a bounded window per group, each with its authoritative total
   and aggregates.
10. **Docs and gates** — `bases.mdx`; typecheck, lint against baseline, both
    suites; then a browser pass, which is the only thing that can check the
    virtualized layout.
