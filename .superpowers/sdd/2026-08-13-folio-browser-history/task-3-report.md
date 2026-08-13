# Task 3 report — Folio capture and restoration precedence

## RED evidence

Command:

```text
bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx
```

Observed before production changes: exit 1; 2 test files failed; 10 tests failed. The failures were the expected missing behavior: stale-selection scroll stayed at `0` instead of `64`; latest-per-tab scroll won over history (`12` instead of `91`); a missing history snapshot applied latest state (`70` instead of preserving `23`); loading/retry, locked, and read-only requests never scheduled restoration; the superseded effect applied latest scroll (`5` instead of history `44`); settled not-found left its request pending; and both mobile Back paths had no captured history record (`undefined` instead of `137` / `149`).

## GREEN evidence

Command:

```text
bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx
```

Observed after implementation: exit 0; 2 test files passed; 66 tests passed.

## Typecheck evidence


```text
bun run typecheck
```

Observed: exit 0; `tsc --noEmit --project tsconfig.app.json` completed without diagnostics.


## Review round 1 evidence

RED command:

```text
bun run test -- src/store/folioRestoration.test.ts src/components/codex/__tests__/Folio.test.tsx -t "pending-request subscribers|superseding same-tab request"
```

Observed before the reactive request fix: exit 1; the store test failed because `subscribeFolioHistoryRestorationRequests` did not exist, and the Folio test restored the first request's `44` scroll position instead of the superseding request's `58`.

GREEN command:

```text
bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/store/folioRestoration.test.ts
```

Observed after the fix: exit 0; 3 test files passed; 86 tests passed.

Typecheck command:

```text
bun run typecheck
```

Observed after the fix: exit 0; `tsc --noEmit --project tsconfig.app.json` completed without diagnostics.

Review fix: the restoration registry now exposes a `useSyncExternalStore`-compatible pending-request subscription and matching location-ID snapshot. It notifies only on actual request-state changes. Folio subscribes to that identity, so same-tab/path supersession cancels the old RAF and schedules the exact newer snapshot without depending on unrelated editor or route changes.

## Review round 2 evidence

RED command:

```text
bun run test -- src/components/codex/__tests__/Folio.test.tsx -t \"prefers a matching history snapshot|matching missing snapshot\"
```

Observed before the precedence fix: exit 1; 2 tests failed. Draining the follow-up RAF changed history scroll `91` to latest-per-tab `12`, and changed the missing-snapshot location `23` to latest-per-tab `70`.

GREEN command:

```text
bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx src/store/folioRestoration.test.ts
```

Observed after the fix: exit 0; 3 test files passed; 86 tests passed.

Typecheck command:

```text
bun run typecheck
```

Observed after the fix: exit 0; `tsc --noEmit --project tsconfig.app.json` completed without diagnostics.

Review fix: Folio records exact history requests it consumes and suppresses the immediate reactive location-ID-to-null effect generation. This preserves authoritative history/missing-snapshot precedence while retaining reactive same-tab supersession.
## Implementation summary

- Added one synchronous `FolioRestoration` builder and registered it as the mounted Folio history capture; the latest-per-tab unmount save now uses the same builder.
- Made matching history requests authoritative, including missing snapshots; retained requests across loading, retryable errors, and encryption locks; discarded settled not-found or destination-mismatched requests; consumed exact location IDs only after an available Folio handled them.
- Restored scroll independently from selection validation and retained the existing validated-selection/focus behavior.
- Routed both mobile Back branches through `useLeaveFolioWorkspace`, so checkpoint capture precedes origin activation/history Back or fallback navigation to `/`.

## Self-review

- Capture validation is single-sourced and synchronous; no new store or hook API was introduced.
- Same-tab history activations participate in the restoration effect lifecycle, so a newly requested location is observed even when tab, path, and editor content are unchanged.
- History precedence cannot fall through to latest-per-tab state when a matching request exists, including a missing record.
- Exact-ID consumption preserves a superseding request; unavailable transient states do not consume it.
- Read-only conversation presentation still mounts the source editor and completes restoration.
- Focused tests cover every brief-listed regression and assert DOM/store outcomes rather than implementation call counts.
- No formatter, linter, build, project-wide test, unrelated cleanup, plan/spec/ledger, or earlier report was touched.

## Files

- `ui/src/components/codex/Folio.tsx`
- `ui/src/components/codex/__tests__/Folio.test.tsx`
- `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`
- `.superpowers/sdd/2026-08-13-folio-browser-history/task-3-report.md`
- `ui/src/store/folioRestoration.ts`
- `ui/src/store/folioRestoration.test.ts`

## Commit

`feat(ui): restore Folio locations from browser history`
