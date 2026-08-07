# Wikilink Click Resolution — Implementation Plan

**Date:** 2026-08-07
**Branch:** `feature/wikilink-resolution` (worktree, off `develop`)
**Bug:** Clicking a wikilink opens a workspace tab whose `path` is the raw
bracket text (e.g. `Clepsydra Design Notes`). `GET /api/vault/pages/{path}`
resolves only literal file paths, so every title-style wikilink click lands on
`FolioNotFound`. The hover preview fails the same way (silently). The server's
link index resolves these links correctly (`links.target_raw → target_path`);
the UI simply never consults it.

## Resolved decisions (interview 2026-08-07)

1. **Resolution in the UI at click/render time** via the outlinks data Folio
   already fetches — no backend changes.
2. **Dangling click ⇒ create page & open** (Obsidian convention): kind NOTE,
   title = link target, client-derived intake path.
3. **Dangling links render visually distinct** — muted/dashed, Vessel tokens.
4. **Hover preview fixed too** — resolved links hover as normal; dangling
   links show no card.
5. **Stale-index miss ⇒ refetch outlinks once**, re-check, then fall through
   to the dangling flow.
6. **Duplicate guard (planning addition):** a just-typed wikilink has *no*
   links row until the source page reindexes, so before creating, run an
   exact-title match against `/api/vault/index/search`; open the match if one
   exists. Prevents duplicate pages during the index-lag window.

## Architecture

New module `ui/src/editor/wikilinkResolution.tsx`:

- `WikilinkResolutionProvider({ path, children })` — calls `useOutlinks(path)`,
  builds `Map<target_raw, target_path>` from entries with `kind === "wiki"`
  and non-null `target_path`; exposes context value:
  - `lookup(targetRaw): string | null` — synchronous map hit.
  - `refetchAndLookup(targetRaw): Promise<string | null>` — one refetch of the
    outlinks query, then re-lookup.
- Default context (no provider — Storybook, tests, stray editors): `lookup`
  returns null, `refetchAndLookup` resolves null. Nothing throws.

`WikilinkElement` (`ui/src/editor/elements/WikilinkElement.tsx`):

- `resolved = lookup(element.target)`.
- **Resolved:** `<CLink path={resolved}>` — click and hover both work
  unchanged on the real path.
- **Dangling:** no `path` prop (no hover card), dangling styling
  (`text-ink-mute` + dashed underline, keep the ⟦ ⟧ affordance), `onClick`:
  1. `refetchAndLookup(target)` → hit ⇒ `openTab("page", path)`.
  2. search guard: exact case-insensitive NFC title match ⇒ open match.
  3. create via `useCreatePage` at
     `intakePath({kind: "NOTE", project: null, title: target, shortId, now})`
     with body `{ title: target }` ⇒ `openTab("page", path)`.

Provider wiring at both SlateEditor hosts:
- `Folio.tsx` — wraps its SlateEditor; it already has `useOutlinks(path)`
  (provider reuses the same query via TanStack Query cache — no double fetch).
- `Diurnal.tsx` — wraps its SlateEditor with the journal page's vault path.

No backend or OpenAPI changes. `element.target` semantics unchanged
(serialization round-trip untouched).

## Tasks (TDD — failing tests first, then implementation)

### T1 — Resolution module
Tests (`ui/src/editor/__tests__/wikilinkResolution.test.tsx`):
- builds lookup map from outlinks data; `kind: "wiki"` only (ignores
  `property_ref`/`block_ref`); null `target_path` ⇒ miss.
- `lookup` hit returns path; unknown target returns null.
- `refetchAndLookup` triggers exactly one refetch and sees refreshed data.
- Without a provider, both functions are safe no-ops.
Then implement the module.

### T2 — WikilinkElement resolution + dangling UX
Tests (`ui/src/editor/__tests__/WikilinkElement.test.tsx`):
- resolved: CLink receives the resolved vault path, NOT the raw title;
  no dangling class.
- dangling: dangling class present; CLink gets no `path`.
- alias display preserved in both states.
- dangling click: refetch-hit ⇒ opens tab at refreshed path, no create.
- dangling click: refetch-miss + search-guard hit ⇒ opens matched path, no
  create.
- dangling click: full miss ⇒ creates at intake-derived path with
  `{title: target}` body, opens tab.
(Per project memory: mock `useMutation` results with fresh objects — only
`.mutate` identity is stable; jsdom `isContentEditable` shim for slate-react.)
Then implement.

### T3 — Provider wiring (Folio, Diurnal)
Tests: light render-level assertions that both hosts mount the provider with
the page's vault path (or targeted unit tests if full mounts are impractical
— follow existing Folio/Diurnal test patterns if any; otherwise a focused
provider-presence test).
Then wire, and confirm Storybook stories (default context) still render.

### T4 — Verification gates
`bun run typecheck && bun run lint && bun run test` in `ui/`; fix fallout.
Backend untouched — `cargo` gates only if anything under `src/` changed
(expected: nothing).

## Post-merge follow-ups (out of scope)
- Persisted workspace tabs created before this fix still hold raw-title paths
  (user closes them manually).
- Block-ref clicks and ambiguous-canonical UX (2+ matches) — separate feature.
