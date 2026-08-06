# Journal Create-on-First-Write Design

## Goal

Visiting the default `/` route currently creates today's journal file even when the user does nothing: the Atrium eagerly calls `GET /api/vault/journal/today`, whose handler is get-or-create. After this change, today's journal file comes into existence only on the first actual write — an editor edit or a quick capture — never as a side effect of rendering a view.

## Decisions

- **Creation moment:** only on first write. Viewing `/` or `/journal` never creates a file. A journal viewed but never written stays absent from the vault.
- **Mechanism:** `GET /journal/today` becomes a pure read; a new `POST /journal/today` carries the ensure semantics; the editor gains a draft mode whose first save calls ensure before its normal update.
- **Endpoint fate:** `GET /journal/today` is retained (read-only, including `carried_forward`) rather than deleted. The Atrium remains its consumer.
- **Template ownership:** the journal template (title = date, `tags: ["journal"]`) stays defined in exactly one place, server-side in `ensure_journal`, shared by the ensure endpoint and capture.

## Behavior contract

- Rendering the Atrium performs no writes. Its journal CTA subtitle shows the journal UUID when today's journal exists, and the plain `JOURNAL / <date>` fallback when it does not.
- Opening `/journal` on an unwritten day shows an editable empty journal for today without creating a file. The marginalia state reads "unwritten".
- The first content or metadata edit in that editor (after the existing 1.5 s save debounce, or the unmount/visibility flush) creates the journal with the server-side template, then saves the edit. Subsequent saves follow the existing update path unchanged.
- Quick capture on an unwritten day creates the journal and appends, exactly as today.
- Past dates are unchanged: read-only lookup, "no entry" message when absent.
- `GET /journal/today` returns 404 when today's journal does not exist, mirroring `GET /journal/{date}`. When it exists, the response shape is unchanged (`PageDetail` flattened + `carried_forward`).
- `POST /journal/today` returns 201 + `PageDetail` when it creates the page, 200 + `PageDetail` when the page already existed. It takes no request body.

## Backend changes (`src/api/journal.rs`)

- `get_today` drops its `ensure_journal` call. It computes today from the server clock and returns `ApiError::not_found` when `journals/<date>.md` is absent. The `carried_forward` query and response shape are untouched.
- New `ensure_today` handler on `POST /journal/today` wrapping the existing `ensure_journal`; the `(VaultPath, bool created)` return distinguishes 201 from 200. Route becomes `.route("/today", get(get_today).post(ensure_today))`.
- `capture_today` is untouched — a capture is a first write, so its ensure call is consistent by design.
- Journal routes carry no utoipa annotations today; the new route follows suit. No OpenAPI regeneration needed.

## Frontend changes

### API layer (`ui/src/api/journal.ts`)

- `useJournalToday()` returns `JournalDetail | null`: a 404 resolves to `null` instead of throwing. Other failures still throw.
- New `useEnsureJournalToday()` mutation POSTing `/journal/today`. On success it invalidates `journal.today`, `journal.recent`, and the page-content keys for the returned path (mirroring capture's invalidation).
- `JournalDetail` gains `revision: string` — the server already sends it; the interface just hasn't declared it. The ensure mutation must also expose whether the response was 201 or 200 and the response body, for the draft-save handoff below.

### `usePageEditor` draft mode (`ui/src/editor/usePageEditor.ts`)

- New optional options argument: `usePageEditor(path, { ensure })` where `ensure` resolves to the created-or-existing page (`PageDetail` shape + created flag).
- When `usePage` fails with status 404 and `ensure` is provided, the hook enters **draft state** instead of surfacing an error: empty document, empty metadata, no revision, `saveStatus: "saved"`, and an exposed `isDraft: boolean`.
- The first `doSave` in draft state awaits `ensure()` before the normal update logic:
  - **201, or 200 with an empty body:** adopt the response as the save baseline (`revisionRef`, `savedRef`). Template-provided metadata is adopted into visible editor state for fields the user did not touch while drafting; user-edited fields are kept and diff against the new baseline so the subsequent PUT carries them. The PUT proceeds within the same `doSave` invocation.
  - **200 with a non-empty body while the draft has edits:** another client wrote today's journal between load and save. Surface the existing revision-conflict banner (reload path) rather than silently overwriting; the conflict is detected client-side but reuses the same `revisionConflict` state and `reloadAfterConflict` flow.
  - **Ensure failure:** `saveStatus: "error"` with the message, retried on the next save trigger, identical to update-failure handling.
- Draft state ends when either the first save completes or an external refetch finds the page (e.g. capture created it; the existing dirty-guarded sync effect adopts it).

### Diurnal (`ui/src/components/codex/Diurnal.tsx`)

- Drops `useJournalToday` entirely. For today, `journalPath` is computed directly as `journals/<today>.md`. This duplicates the journal path layout client-side — an accepted coupling to the stable, documented vault layout, necessary because the editor must bind to a path before the file exists.
- Today's editor renders unconditionally, wired with `ensure` from `useEnsureJournalToday()`. Loading/error gating for today uses the editor's own state; `editor.isDraft` drives the "State: written/unwritten" marginalia.
- Past dates keep the current `useJournalByDate` behavior unchanged.

### Atrium (`ui/src/components/codex/Atrium.tsx`)

- No component change beyond the hook's new nullability: the subtitle already falls back to `JOURNAL / <date>` when `meta.id` is absent.

## Error handling summary

- Read of a missing today: 404 → `null` (Atrium) or draft state (editor); never an error surface.
- Ensure race (two clients create simultaneously): handled server-side by `ensure_journal`'s existing conflict arm — the loser receives the existing page with 200.
- Ensure returning an already-written page against local draft edits: client-side conflict banner, reload to adopt.
- Mid-session concurrent edits after creation: unchanged `expected_revision` machinery.

## Tests

Backend (`tests/api_journal_test.rs`, plus `e2e_tasks_journal_test.rs` / `api_test.rs` where they lean on the old auto-create):

- Replace `get_today_creates_journal_if_missing` with `get_today_returns_404_when_missing` and a get-reads-existing-without-creating test.
- New: `post_today_creates_with_template` (201; file exists; title = date; `tags: ["journal"]`; empty body) and `post_today_returns_existing` (200; no overwrite of existing content).
- Capture-creates behavior keeps its existing coverage.
- Tests that previously relied on `GET /journal/today` to materialize the page are switched to seed the file or call the POST first. `carried_forward` assertions are otherwise unchanged.

Frontend (vitest):

- `usePageEditor` draft mode: 404 + `ensure` → draft, no error; first save calls ensure then PUT in order; ensure failure → error status with retry; 200-with-body against draft edits → conflict path.
- Diurnal: unwritten today renders an editable editor and "unwritten" marginalia; written today behaves as before.
- Atrium: null journal renders the subtitle without a UUID.
- `EditorConflictWiring.test.tsx` reworked: Diurnal no longer consumes `useJournalToday`, so the wiring mock moves to `usePage`/editor level.

## Out of scope

- Removing `carried_forward` or `GET /journal/today` (explicitly retained).
- Any change to capture, `GET /journal/{date}`, `range`, or `recent` semantics.
- Diurnal's memoized client-side "today" not rolling over at midnight (pre-existing behavior).
- Journal day-boundary semantics (server clock remains authoritative for writes).
