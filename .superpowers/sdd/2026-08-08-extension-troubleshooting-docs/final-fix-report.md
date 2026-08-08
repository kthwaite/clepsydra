# Final Documentation Coverage Fix Report

## Status

DONE

## Fix commit

- `7ee4f2a3c82bbb78f79955d69090d331c6d28259` — `test(docs): cover dedicated guides`

## Changed files

- `ui/src/docs/registry.test.ts` — adds direct, literal `getDocPage` expectations for `troubleshooting` and `browser-extension`, including their titles.
- `ui/src/docs/mdx-smoke.test.tsx` — renders every component in `DOC_PAGES` through an eight-case table-driven smoke test, rejects an empty render, and asserts the two Getting Started links resolve to `/docs/troubleshooting` and `/docs/browser-extension`.
- `ui/src/docs/search.test.ts` — builds the real documentation index and uses fixed queries plus hand-written expected slug/heading/heading-ID values for distinctive Troubleshooting and Browser Extension source content.
- `.superpowers/sdd/2026-08-08-extension-troubleshooting-docs/final-fix-report.md` — records the final-review fix and evidence.

No production documentation, registry, or search behavior is changed by the fix commit.

## RED

The final tests were mutation-checked against controlled, temporary regressions after the test commit:

- both dedicated `getDocPage` lookups temporarily returned `undefined`;
- the Troubleshooting and Browser Extension registered raw sources were temporarily emptied;
- the registered Browser Extension component temporarily rendered `null`;
- both Getting Started dedicated-guide hrefs were temporarily changed to `/docs`.

Command, run from `ui/`:

```bash
bun run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/docs/search.test.ts
```

Observed result: expected failure — 3 test files failed, with 6 failing tests. The failures explicitly covered dedicated slug resolution, both distinctive source-search cases, the empty registered Browser Extension render, and the wrong Getting Started Browser Extension href. The pre-existing metadata/source-alignment assertion also failed because of the controlled empty Troubleshooting source. The temporary regressions were fully reverted before GREEN.

## GREEN

Command, run from `ui/` after restoring the production files exactly:

```bash
bun run test -- src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/docs/search.test.ts
```

Observed result: PASS — 3 test files passed, 33 tests passed, 0 failed.

Patch hygiene command:

```bash
git diff --check
```

Observed result before commit: PASS — no whitespace errors.

A post-mutation `git status --short` produced no output, confirming that all temporary production mutations were restored and the committed fix contains only the three requested test files.

## Self-review

- Confirmed the registry assertions call `getDocPage("troubleshooting")` and `getDocPage("browser-extension")` directly and compare against literal slug/title values.
- Confirmed the render smoke is table-driven from `DOC_PAGES`; the current fixed hierarchy independently asserts all eight slugs, while each registered component must produce a non-empty DOM render.
- Confirmed the search coverage indexes the actual registered raw MDX sources rather than synthetic fixtures.
- Confirmed search expectations are literal and hand-written; neither expected slug nor expected heading data is derived by calling `searchDocs` or reusing its ranking/indexing logic.
- Confirmed the Troubleshooting query `attaches then stops` resolves first to the literal Neovim troubleshooting section and fails when that raw source is removed.
- Confirmed the Browser Extension query `notification only conflict behavior` resolves to the literal Content Changed conflict section and fails when that raw source is removed.
- Confirmed the existing Testing Library harness cleanly exposes rendered MDX anchors, so the Getting Started test asserts both accessible link names and exact internal hrefs.
- Confirmed the controlled render mutation demonstrates that a registered component returning no content is caught, rather than merely asserting that the registry contains a component reference.
- Reviewed scope after mutation restoration: no production docs, registry implementation, search implementation, or unrelated tests differ from the branch baseline.

## Concerns

None.
