# Folio Browser History Design

**Task:** TSK-0061 — Persist Folio navigation in browser history  
**Status:** Approved design, pending written-spec approval  
**Date:** 2026-08-13

## Problem

The workspace keeps the active Folio tab in Zustand state, while `/workspace` browser-history entries do not identify their destination Folio or reading location. Opening another Folio mutates the workspace store and navigates to the same URL. Browser Back and Forward therefore cannot reliably restore the prior active Folio, scroll position, or Slate selection.

The existing `folioRestoration` store preserves only the latest location for each tab. That supports remount restoration but cannot represent two historical visits to the same Folio at different locations.

## Product contract

1. Opening a Folio or activating an existing Folio tab creates a browser-history destination.
2. Immediately before any approved transition away from a Folio history entry—including Back, Forward, page/tab activation, and navigation to a non-workspace route—the outgoing entry records the current scroll position and Slate selection.
3. Back and Forward restore the active Folio and the location recorded for that particular visit.
4. Ordinary scrolling does not push browser-history entries. A location is checkpointed only when navigating away.
5. A transition rejected by the raw-Markdown draft guard changes neither browser history nor restoration records.
6. Direct `/workspace` loads without Folio history state retain the current workspace fallback behavior.
7. Invalid, unavailable, closed, or replaced destinations fail safely without resurrecting deleted tabs or corrupting the current workspace state.
8. History and location records are session-local. Exact scroll and selection restoration after a full browser reload is outside this task.

## Chosen architecture

Use a stable history-location ID per browser entry plus a session-local restoration registry whose value is refreshed on every approved departure from that entry.

Each relevant `/workspace` history entry carries a complete Folio destination tuple:

```ts
interface HistoryState {
  folioTabId?: string | null;
  folioPath?: string | null;
  folioLocationId?: string | null;
  folioOriginTabId?: string | null;
}
```

`folioOriginTabId` remains for returning from non-workspace surfaces. The tuple `{ folioTabId, folioPath, folioLocationId }` identifies one Folio visit. All three fields must be present before an entry is treated as a Folio destination. `folioPath` prevents an old history entry from activating unrelated content after replace-mode navigation reuses a tab ID. A rename or path update makes the old entry stale; this task does not redirect historical entries across renames.

A location snapshot contains the existing restoration fields:

```ts
interface FolioHistoryLocation {
  tabId: string;
  path: string;
  revision: string | null;
  scrollTop: number;
  anchor: TextPointSnapshot | null;
  focus: TextPointSnapshot | null;
}
```

The registry is in memory and keyed by `folioLocationId`. It is separate from the existing latest-per-tab restoration map because the two stores have different identity and lifetime rules:

- latest-per-tab restoration is mutable and supports component remounts;
- a history-location ID is stable for one browser entry, while its snapshot is replaced whenever the user revisits and then departs from that entry.

## Transition lifecycle

### Initial workspace entry

When `/workspace` is active with a page tab but the current entry lacks a complete Folio destination tuple, replace that entry's state with:

- the current active page tab ID;
- the current page path;
- a newly generated location ID.

Replacement avoids adding a synthetic navigation step. The coordinator distinguishes this initialization because the previous router entry lacked the complete tuple; initialization does not capture, activate a tab, or dispatch a transition.

### Programmatic opening or activation

Before invoking the guard, resolve the requested destination and detect no-ops. If the requested destination is already the active tab and does not request a distinct block focus, return without prompting, capturing, mutating, or navigating.

Otherwise, programmatic Folio navigation uses one `runWorkspaceTransition` call. After the raw-draft guard permits its deferred callback, that single callback:

1. synchronously captures the tracked outgoing Folio under the current entry's `folioLocationId`;
2. mutates the workspace store to open or activate the destination tab;
3. pushes `/workspace` with fresh `{ folioTabId, folioPath, folioLocationId }` destination state.

The three operations remain in one approved callback. Guard cancellation therefore happens before capture and leaves the registry, active tab, and router history unchanged.

Page targets set a complete fresh Folio destination tuple. Graph targets explicitly clear `folioTabId`, `folioPath`, and `folioLocationId` while preserving existing `folioOriginTabId` semantics. This prevents stale Folio reactivation; restoring graph activation through Forward is outside this Folio task.

### Programmatic departure from workspace

Any programmatic route change that can unmount a tracked Folio uses a coordinator departure operation. This includes the mobile Back fallback that calls `navigate({ to: \"/\" })` when browser history cannot go back. One `runWorkspaceTransition` callback performs:

1. raw-draft guard approval;
2. synchronous checkpoint of the tracked outgoing Folio under the current entry's `folioLocationId`;
3. route navigation with no workspace-store mutation.

Cancellation occurs before checkpointing. The destination route receives no Folio destination tuple. General workspace navigation controls that leave the route must use this operation rather than calling `navigate` directly while a Folio is mounted.

### Back and Forward

A workspace route observer retains the previously current Folio entry descriptor and reacts to router history-state changes. Native traversal is admitted or rejected by the existing router blocker; it does not call `runWorkspaceTransition` a second time.

After the router blocker approves traversal, a dedicated `applyHistoryEntry` mode:

1. synchronously captures the tracked outgoing Folio under the outgoing entry's stable `folioLocationId`, including when the destination is a non-workspace route;
2. reads the destination's complete `{ folioTabId, folioPath, folioLocationId }` tuple;
3. requires the current workspace store to contain that exact page tab ID and path;
4. activates the destination through an internal restoration mode that does not re-enter the workspace guard;
5. publishes a restoration request using the history entry's tab ID, path, and location ID;
6. restores after the matching Folio's Slate/content tree and owned scroll container are mounted, including read-only presentation.

Applying history may perform the one outgoing checkpoint. “No recursion” means it must not push or replace browser history, re-dispatch router traversal, or enter the workspace guard again.

Entries without a complete Folio destination tuple—including graph entries—are ignored by the Folio observer. Their existing route/store behavior remains authoritative; the Folio coordinator neither activates a page nor promises graph-state restoration for those entries.

### Leaving workspace

The meaning of `folioOriginTabId` remains unchanged, but the current mobile Back ordering must change. `Folio` must not pre-activate the origin tab before `history.back()`, because that can unmount the outgoing editor before capture. Instead, the approved traversal coordinator checkpoints the outgoing Folio first, then applies the destination tuple when present or uses `folioOriginTabId` as the existing fallback. This task does not add Folio destination tuples to non-workspace routes. A return to workspace may restore the origin tab through that fallback; once workspace is active, an entry without a complete tuple is initialized by replacement as described above.

## Capture and restoration ownership

`Folio` owns the DOM scroll container and Slate editor, so it remains the only component that reads or writes exact location data.

Expose a narrow coordinator interface with three explicit transition operations:

- programmatic Folio destination creation: preflight/no-op detection, then one guarded callback containing capture, store mutation, and push;
- programmatic workspace departure: one guarded callback containing capture and route navigation, with no store mutation;
- history application: router-blocker-approved outgoing capture, unguarded internal store activation, and restoration request without push or replace.

Supporting primitives:

- register the mounted Folio's synchronous snapshot function;
- track the currently applied Folio entry descriptor;
- capture the active mounted Folio for a specified location ID;
- publish a pending restoration request `{ tabId, path, locationId }`;
- let the matching mounted Folio consume that request once restoration prerequisites are satisfied.

The coordinator must not import the router into the workspace Zustand store. Router history and editor snapshots remain an integration concern in a hook/component mounted on the workspace route. The store may expose a narrowly scoped internal activation operation for history application so that approved native traversal does not re-enter `runWorkspaceTransition`.

## Validation and fallback

Selection restoration reuses `validateTextPointSnapshot`:

- same revision: validate Slate paths and offsets;
- changed revision: additionally require matching text nodes;
- invalid selection: omit selection restoration;
- valid page and snapshot: restore scroll independently of selection validity.
- restoration precedence: a matching pending history request wins for that mount and suppresses latest-per-tab restoration; latest-per-tab restoration runs only when no matching history request exists.

Failure and lifetime rules:

- missing history snapshot: activate the exact valid destination tab without changing its current location;
- missing/closed tab or tab/path mismatch: ignore the stale history destination and retain the current valid active tab;
- loading, locked encryption, or retryable non-404 error: retain the pending request through load, unlock, or retry;
- mounted matching content, including read-only presentation: consume the request after applying the available scroll and valid selection;
- settled `pageNotFound`, tab close, destination/path mismatch, or a superseding request: discard the pending request;
- raw-draft guard cancellation, for either native traversal or programmatic activation: perform no capture, store mutation, restoration request, or router navigation.

## State bounds and cleanup

History-location records are bounded. Keep at most 64 snapshots, evicting the oldest last-captured record. Replacing a snapshot under an existing location ID does not allocate another record and refreshes that record's capture-order position. A pending, not-yet-captured location ID does not allocate a snapshot. Closing or replacing a tab removes history snapshots for that tab where practical; stale browser entries still fail safely if already evicted.

The bound exceeds the workspace open-history cap and prevents an unbounded session allocation without coupling correctness to browser-history introspection.

## Files and responsibilities

Expected change points:

- `ui/src/store/folioRestoration.ts`
  - history-location registry, last-captured eviction, capture registration, and pending restore request;
- `ui/src/components/codex/Folio.tsx`
  - register synchronous snapshot capture, route both mobile Back forms through checkpoint-before-navigation/origin activation, consume matching history restore requests, and enforce history-over-latest restoration precedence;
- `ui/src/hooks/useOpenTab.ts`
  - preflight programmatic targets and create or clear destination state by tab type;
- `ui/src/components/codex/Sheaf.tsx`
  - route explicit existing-tab activation through the same programmatic transition API;
- `ui/src/routes/workspace.tsx` or a focused workspace hook
  - initialize missing entry state and apply router-blocker-approved Back/Forward state without recursive navigation;
- `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`
  - programmatic and native traversal, stale/replaced destinations, graph-field clearing, both mobile Back paths, cancellation, recursion, and history-over-latest precedence;
- `ui/src/components/codex/__tests__/Folio.test.tsx`
  - update the existing revision-drift contract so valid scroll restores independently of invalid selection, plus read-only and retry/unlock lifetimes;
- focused restoration-store tests
  - repeated checkpoint replacement, pending-request lifetime, and deterministic bounded eviction.

Exact ownership may consolidate into a focused hook if existing route composition makes that smaller, but there must be one history coordinator rather than parallel navigation conventions.

## TDD acceptance scenarios

1. **Folio traversal:** open A, open B, move within B, Back restores A, and Forward restores B at B's captured departure location.
2. **Distinct visits:** view A at location 1, navigate to B, return to A in a new entry at location 2, navigate away, then traverse history; each A entry restores its own location.
3. **Repeated departure:** A → B → Back to A, move A, Forward to B, Back to A; the second Back restores A's newly checkpointed location for the same entry.
4. **Existing-tab activation:** clicking an already-open Folio tab creates a destination entry and Back restores the prior Folio.
5. **Programmatic guard cancellation:** dirty raw Markdown rejects existing-tab activation and leaves history state, active tab, and location registry byte-for-byte unchanged.
6. **Native guard cancellation:** dirty raw Markdown rejects Back and leaves history state, active tab, and location registry byte-for-byte unchanged.
7. **Missing snapshot:** Back activates the exact referenced tab/path without throwing or changing its current location.
8. **Stale tab:** Back to an entry for a closed tab or a replaced tab with the same reused ID and no snapshot leaves the current valid tab active.
9. **Revision drift:** invalid selection is discarded while valid scroll restoration still occurs.
10. **Direct load:** `/workspace` with no Folio state initializes by replacement and does not create an extra Back step.
11. **No recursion:** applying a Back/Forward entry checkpoints once but does not push, replace, or dispatch another transition.
12. **Graph boundary:** page → graph clears Folio destination state; later traversal of that graph entry does not spuriously reactivate its former Folio. Graph destination restoration is not asserted.
13. **Mobile Back ordering:** Back from a Folio with `folioOriginTabId` checkpoints the outgoing editor before any origin activation can unmount it.
14. **Mobile fallback departure:** a direct `/workspace` entry with no usable Back entry checkpoints before navigating to `/`; browser Back then returns to and restores that Folio visit.
15. **Restoration precedence:** a distinct-visit history snapshot overrides a conflicting latest-per-tab snapshot for the same tab; latest-per-tab remains the fallback when no history request exists.
16. **Availability:** a pending request survives retryable error or locked encryption, and valid read-only Folio content can consume it.
17. **Bounded registry:** capture 65 IDs, refresh an older retained ID, and verify deterministic eviction by oldest last-captured order.

## Out of scope

- Shareable or bookmarkable Folio URLs.
- Restoration across full browser reloads or separate sessions.
- A browser-history entry for every scroll event, selection change, or heading crossing.
- Reopening closed tabs from historical state.
- Stable public block/offset identifiers.
- New graph-tab history semantics beyond explicitly clearing stale Folio destination fields.
