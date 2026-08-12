# Task 3 report — dedicated Folio property panel

## Status

DONE

## Commit

This review-fix commit — `fix(codex): close Wave 2 property review findings`

## Files changed

- `ui/src/api/bases.ts` — exported generated projection aliases, added the bounded-retry GET hook, and made `usePropertyCommit` return/reject its mutation promise while accepting an authoritative projection revision.
- `ui/src/api/bases.test.ts` — added generated projection, bounded retry, projection-revision PATCH, rejected mutation, and page-property cache invalidation contracts.
- `ui/src/components/bases/EditableCell.tsx` — added the minimal controlled focus-return signal needed when an external retry/discard action closes an editor.
- `ui/src/components/bases/useBaseTableController.ts` — consumed rejected property commits without changing the table's fire-and-forget behavior.
- `ui/src/components/bases/__tests__/BaseTable.test.tsx` — migrated the property commit mock to the promise contract.
- `ui/src/components/bases/__tests__/useBaseTableController.test.tsx` — migrated the property commit fixture to the promise contract.
- `ui/src/components/codex/ReadingContinues.tsx` — consumed rejected property commits without changing the panel's fire-and-forget behavior.
- `ui/src/components/codex/__tests__/ReadingContinues.test.tsx` — migrated the property commit mock to the promise contract.
- `ui/src/components/codex/FolioProperties.tsx` — added the focused backend-authoritative panel using `EditableCell`, grouped projection provenance, controlled retained drafts, revision-guarded set/clear saves, explicit projection refetch, membership reconciliation, conflict reload/discard, network retry/discard, lock/read-only gates, both empty states, and contained projection errors.
- `ui/src/components/codex/__tests__/FolioProperties.test.tsx` — added focused observable panel contracts.
- `ui/src/components/codex/Folio.tsx` — placed the panel in the normal metadata rail/mobile details sheet and supplied page identity, path, local lock state, and declarative read-only authority.
- `ui/src/components/codex/LockedFolio.tsx` — added the metadata slot that keeps projected values/provenance visible while the body is locally locked.
- `ui/src/components/codex/MobileFolioLayout.tsx` — applied the existing mobile touch-target rule to the shared native select editors.
- `ui/src/components/codex/__tests__/Folio.test.tsx` — covered desktop/mobile placement, locked authority, and normal Folio usability when projection UI reports failure.

## Behavior

The panel treats `present` as authoritative, so absent declarations start from an empty editor even if a stale transport value exists, while a present JSON `null` remains distinct in display state. Compatible declarations share the generated normalized definition and therefore one existing typed editor; every original declaration is still listed with Base identity and editor semantics. Conflicts, reserved keys, backend-nonpatchable keys, locally locked pages, and declaratively read-only Folios expose formatted values/status/provenance without edit controls.

A panel save sends `set` or `clear`, shared date/datetime hints, and the projection revision through the existing property PATCH. `usePropertyCommit` now rejects failures after preserving its existing toast/cache-refresh behavior. Legacy table and Reading Continues consumers deliberately absorb that rejection; the panel awaits it, retains the mounted editor draft on failure, and only closes after PATCH success plus projection refetch. The backend 409 body does not carry an HTTP status through `openapi-react-query`, so the panel recognizes both an attached status and the property endpoint's typed `{ revision }` conflict detail before exposing reload/discard.

The projection hook opts out of render-time throwing and limits automatic retry to two retries. Its inline error/retry state cannot replace or disable Folio body/title rendering. Successful mutation invalidation already covers the GET because it is under the existing page path prefix; the explicit active-query refetch then reconciles Base membership entry/exit before the controlled editor closes.

## Focused contracts

The slice covers these focused contracts:

Focused contracts added or extended:

- generated `PageBasePropertiesResponse`/`PageBaseProperty` hook response and exact GET path;
- exactly two automatic retries before a projection error settles;
- property projection cache invalidation with existing Base/query/page scopes;
- projection revision bypassing page-detail GET, exact date hint wire body, and rejected PATCH propagation;
- no matching Bases versus matching Bases with no declared properties;
- one editor for compatible duplicate declarations with every Base/type provenance entry;
- raw conflicting values and reserved values/provenance with no editors;
- all nine shared `CELL_EDITORS` property types through `EditableCell` semantics;
- absent add with authoritative `present`, clear as key removal, and date type hints;
- PATCH success followed by projection refetch and membership disappearance/appearance;
- 409 draft retention with reload/discard and network failure retention with exact-value retry;
- locked and declaratively read-only values/provenance without controls;
- contained projection failure with named retry;
- named/described controls, keyboard editing/cancel, and focus restoration;
- desktop metadata-rail, mobile details-sheet, and locked-Folio placement;
- normal Folio body/title usability alongside a failed property projection.

## Resolved review concerns

- The required generated `BoardTask.body_excerpt` contract is preserved and every direct typed UI fixture now supplies it.
- The final Wave 2 cache, SSE refresh, and keyboard-recovery findings are covered by focused red/green integration tests and the UI typecheck.

## Focused debugging correction — 2026-08-12

The exact five-file command initially reproduced five failures:

`bun run --cwd ui test -- components/codex/__tests__/FolioProperties.test.tsx api/bases.test.ts components/codex/__tests__/Folio.test.tsx components/bases/__tests__/useBaseTableController.test.tsx components/codex/__tests__/ReadingContinues.test.tsx`

Root causes and corrections:

- **Projection hook data remained undefined — test fixture changed.** The success mock returned `{ data }` without the `response` required by `openapi-react-query`; its query function dereferenced `response.status`, rejected, and exhausted the hook's retries. The fixture now returns a complete successful generated-client response. Production `usePageBaseProperties` was already correct.
- **Post-save Archive provenance was missing — test fixture changed.** The refreshed property used the helper's default `Library (library)` declaration while the assertion expected `Archive (archive)`. The fixture now supplies the Archive declaration represented by the expected provenance. The external projection mutation already rerendered through the save's state transition, so production reconciliation was unchanged.
- **Conflict reload did not refetch — production changed.** Pointer focus transfer blurred the retained `TextCell`; its intentional cancel-on-blur behavior discarded the draft and unmounted the reload button before the click event. Failure action buttons now prevent the mouse-down focus transfer so their clicks run while the retained editor remains mounted.
- **Network retry did not issue a second commit — production changed.** It had the same blur-before-click event ordering as conflict reload. The same blur-safe action treatment preserves the exact failed value until retry invokes the second commit.
- **Keyboard-cancel focus assertion failed — test assertion changed.** `EditableCell` correctly focused the newly rendered display button after Escape, but the test asserted against the old button node that edit mode had unmounted. The assertion now re-queries the live display button, matching the existing `BaseTableView` focus contract. Production `EditableCell` was unchanged.

Fresh verification of the exact command passed: **5 test files passed, 80 tests passed, 0 failed**. Vitest completed in 10.71 seconds (11.29 seconds wall time). It emitted only the existing Vite native-config migration warning.

## Final Wave 2 review corrections — 2026-08-12

The final review's four Important findings were reproduced and corrected:

- **Required task excerpts:** the initial UI typecheck reported 27 diagnostics in 11 files. Every direct `BoardTask` fixture now supplies `body_excerpt` without weakening the generated required field.
- **Failed property commits:** a real `QueryClient` integration test reproduced a 409 followed by a winning projection with no matching Base. Failed PATCHes now invalidate Base, generic-query, and non-projection page caches while leaving the active property projection and retained draft intact. Successful PATCHes still invalidate/refetch the projection.
- **Base-registry SSE:** an active `QueryObserver` test reproduced the stale projection. `base_registry_changed` now invalidates the exact page-property projection path and causes an active projection to refetch.
- **Keyboard recovery:** conflict and network tests now move from the retained text editor with `user.tab()`, activate reload/retry/discard with Enter, and verify focus and retained draft behavior without pointer events. `EditableCell` suppresses its editor's cancel/commit-on-Tab handlers only while sibling failure actions are present.

TDD evidence:

- The three-file red run observed four expected failures: membership-drop projection refetched, registry SSE did not refetch, and both failure action groups disappeared on Tab.
- After the source changes, the same three files passed: **3 files, 28 tests, 0 failures**.

Fresh focused verification:

- `npm run typecheck` — passed with zero diagnostics.
- Focused Vitest command covering every changed test file plus both vault-event files — **15 files, 390 tests, 0 failures**.
- Formatter, linter, build, and broad suites were intentionally skipped per the focused-fix assignment.

## Full UI suite regression correction — 2026-08-12

The full UI suite exposed 29 regressions in six Folio-oriented files after the property panel was integrated. Those suites render `Folio` or `CodexFrame` below component-specific mocks rather than the production application root, so they do not install the production `QueryClientProvider`. The new real `FolioProperties` boundary consequently reached `usePageBaseProperties` without a query client before the prior Folio behavior could be exercised.

The existing authoritative `Folio.test.tsx` convention already isolates the property-panel boundary, while `FolioProperties.test.tsx` covers the real panel against deterministic projection states. A shared `FolioProperties.mock.tsx` now applies that same projected-properties boundary to the six unrelated Folio suites instead of adding a fake query provider or issuing unmocked API requests. No production behavior changed and no broad fixtures were rewritten.

Verification:

- The pre-fix focused run reproduced **6 failed files, 29 failed tests**.
- The post-fix focused run passed **6 files, 60 tests, 0 failures**.
- `bun run --cwd ui test` passed **265 files, 3,450 tests, 0 failures**.
- `bun run --cwd ui typecheck` passed with zero diagnostics.
