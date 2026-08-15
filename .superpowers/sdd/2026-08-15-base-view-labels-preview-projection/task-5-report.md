# Task 5 Report: Shared link and tab preview projection rendering

## Status

DONE

## RED evidence

```text
bun run test -- src/api/bases.test.ts src/components/codex/__tests__/PreviewBody.test.tsx src/components/codex/__tests__/LinkPreviewLayer.test.tsx src/components/codex/__tests__/TabPreviewCard.test.tsx
# exit 1; 3 files failed, 1 passed; 8 tests failed
# PreviewBody lacked projected rows, conflicts, remainder, and passive failure copy.
# LinkPreviewLayer and TabPreviewCard did not call the property projection hook.
```

The failures were observed before production implementation. The API cache/disabled-query contract already passed through the existing generated TanStack query behavior and now has permanent coverage.

## Implementation

- Exported only the generated `PagePreviewField` and `PagePreviewProjection` types needed by rendering.
- Added the existing `usePageBaseProperties(page?.meta.id ?? "")` query at both preview container boundaries. Both pass data, pending, and error state to the presentation component; neither adds a query, merge, toast, or custom request state.
- Added deterministic bounded read-only formatting for generated JSON values. Missing and explicit null remain distinct, arrays preserve order with compact separators, and object keys are stabilized before bounded rendering.
- Rendered a semantic definition list after Markdown and before tags. Body spans the row with a two-line clamp; conflict indicators expose distinct accessible descriptions; authoritative remainder and passive unavailable states are visible without delaying preview chrome.
- Suppressed the complete projection region for protected pages, including stale values, remainder, and error copy.
- Added Storybook states for success, conflict/missing, loading, failure, and protected rendering.
- Migrated the four Task 3 required-preview fixtures identified by Task 4: three in `bases.test.ts` and one in `FolioProperties.test.tsx`.

## GREEN evidence

```text
bun run test -- src/api/bases.test.ts src/components/codex/__tests__/PreviewBody.test.tsx src/components/codex/__tests__/LinkPreviewLayer.test.tsx src/components/codex/__tests__/TabPreviewCard.test.tsx
# 4 files passed; 24 tests passed; 0 failed

bun run typecheck
# exit 0

git diff --check
# exit 0
```

## Self-review

- Confirmed both consumers use the same generated hook/query key and remain disabled until the UUID exists; the focused API test observes one request/cache entry for two consumers and no empty-UUID request.
- Confirmed existing title, excerpt, word/backlink counts, tags, link navigation/hover cancellation, drag persistence, 340px container behavior, and tab `pointer-events: none` remain covered.
- Confirmed projected labels and values come only from the authoritative response; there is no frontend Base lookup, merge, write path, or passive-failure toast.
- Confirmed definition-list semantics, conflict names, wrapping, body clamp, and protected suppression in component tests.
- A live Storybook server indexed all five new states. The browser device timed out opening even the Storybook shell, so no screenshot-based visual inspection was obtainable; focused DOM/layout/accessibility tests are the behavioral UI evidence.
- Per brief, no formatter, linter, build, broad suite, or unrelated gate was run.

## Remaining concerns

No implementation concern found. Visual inspection remains unobserved because the browser device could not open the locally reachable Storybook server.

## Review correction: page mutation projection invalidation

Review found that scoped page-content invalidation excluded the new UUID-keyed property projection, leaving active generic previews stale after ordinary updates and page protection transitions.

Correction RED:

```text
bun run test -- src/api/pages.test.ts src/api/encryption.test.tsx
# exit 1; 2 files failed; 2 new cache-level tests failed
# active projection observers retained the pre-update/pre-protection response
```

Correction:

- Extended the existing central `invalidatePageContent` convention rather than adding a parallel invalidator. Scoped mutations now invalidate the exact generated property-projection key when a reliable UUID is supplied and the projection path prefix otherwise; existing page-detail/list scoping and aggregate invalidation remain unchanged.
- `useUpdatePage` supplies the successful response UUID. Protect and unprotect supply the request UUID while retaining block-plaintext clearing and folder invalidation.
- Because journal and block mutations already use `invalidatePageContent(path)` without a reliable UUID at their boundary, they automatically receive safe property-projection prefix invalidation.
- Added active `QueryObserver` regressions proving body update refetches current projected body data and protect/unprotect refetch empty protected state followed by restored authoritative values.

Correction GREEN:

```text
bun run test -- src/api/pages.test.ts src/api/encryption.test.tsx
# 2 files passed; 5 tests passed; 0 failed

bun run typecheck
# exit 0
```

Final combined focused verification:

```text
bun run test -- src/api/bases.test.ts src/api/pages.test.ts src/api/encryption.test.tsx src/components/codex/__tests__/PreviewBody.test.tsx src/components/codex/__tests__/LinkPreviewLayer.test.tsx src/components/codex/__tests__/TabPreviewCard.test.tsx
# 6 files passed; 29 tests passed; 0 failed

bun run typecheck
# exit 0
```
