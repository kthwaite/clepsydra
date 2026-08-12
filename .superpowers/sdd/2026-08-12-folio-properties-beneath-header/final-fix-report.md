# Final contract-test fix report

## Status

Complete. Both requested Folio property contracts are covered without production changes.

## Changed files

- `ui/src/components/codex/__tests__/Folio.test.tsx`
  - Added a read-only Folio composition test proving the one visible `Page metadata` header precedes the one projected Properties section, which precedes the one body editor.
  - The test also verifies the projection receives `readOnly: true`.
- `ui/src/components/codex/__tests__/FolioProperties.test.tsx`
  - Added a successful commit/refetch test with a deferred refetch, proving focus stays in the editor while refetch is pending and returns to the edited property's display control only after refetch resolves.
- `.superpowers/sdd/2026-08-12-folio-properties-beneath-header/final-fix-report.md`
  - Records this evidence.

No production files changed.

## RED evidence

Read-only placement harness before enabling the editor's read-only state:

```text
Command: bun run test -- src/components/codex/__tests__/Folio.test.tsx -t "places projected properties between the read-only header and body"
Result: 1 failed, 37 skipped; 1 test file failed.
Expected failure: Unable to find role="region" and name "Page metadata".
```

Successful-refetch focus harness before releasing the deferred refetch:

```text
Command: bun run test -- src/components/codex/__tests__/FolioProperties.test.tsx -t "returns focus to the edited property after a successful refetch"
Result: 1 failed, 14 skipped; 1 test file failed.
Expected failure: Unable to find role="button" and name "Edit status property" while the refetch remained pending.
```

Neither RED check modified or broke production code.

## Focused verification

```text
Command: bun run test -- src/components/codex/__tests__/Folio.test.tsx src/components/codex/__tests__/FolioProperties.test.tsx
Test Files  2 passed (2)
Tests       53 passed (53)
Duration    6.87s
Wall time   7.49s
```

Vitest emitted the existing Vite native-config compatibility warning for `__dirname` and the extensionless `./mdx-plugin` import. There were no test failures or React warnings.

Per assignment, no formatter, lint, typecheck, build, full suite, or project-wide validation was run.

## Self-review

- The placement test asserts user-observable DOM visibility, uniqueness, and ordering rather than source structure or component internals. It would fail if the read-only header, property section, or editor were duplicated or reordered.
- The focus test controls refetch completion explicitly. It proves the editing control remains focused while refetch is pending and the same property's display control receives focus after the awaited refetch completes.
- Existing test helpers and Testing Library conventions are reused; no new abstraction or production seam was introduced.
- Mutation check: removing the read-only composition order, removing the post-save focus-return request, or moving it before the awaited refetch would fail the new assertions.

## Commit

This report and the two test changes are included in the commit with subject:

```text
test(codex): harden Folio property contracts
```

The final commit hash is reported in the handoff after the commit is created.

## Concerns

None in the changed behavior. The only observed warning is the pre-existing Vite config-loader compatibility warning described above.
