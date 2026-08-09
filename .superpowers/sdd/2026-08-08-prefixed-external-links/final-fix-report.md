# Final fix report

## Finding coverage

1. **Registry totality for ill-formed UTF-16**
   - `ui/src/editor/prefixedExternalLinks.ts` rejects unpaired high and low UTF-16 surrogates before provider expansion, so Wikipedia percent-encoding cannot throw.
   - `ui/src/editor/prefixedExternalLinks.test.ts` directly covers both surrogate directions and asserts that the registry returns `null` without throwing.
   - `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts` types both invalid shorthand forms through the real autoformat plugin and proves Space falls back to literal text without creating a link.

2. **Heading/list Enter expansion with semantic structure and one undo batch**
   - `ui/src/editor/plugins/autoformat/withAutoformat.ts` resolves a prefixed link before dispatching the existing semantic Enter transforms. The semantic completion callback runs inside the prefixed-link history batch.
   - `ui/src/editor/plugins/autoformat/listContinuation.ts` accepts an optional history-batch boundary, recognizes inline link content with `Node.string`, and determines paragraph-end position structurally rather than from the current text leaf.
   - `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts` covers heading expansion followed by paragraph exit and list-item expansion followed by canonical sibling continuation. Each test asserts the generated link, resulting semantic structure, caret, and exact restoration after one Undo.

3. **ASCII-only case-insensitive prefix matching**
   - `ui/src/editor/prefixedExternalLinks.ts` validates prefixes against ASCII letters before lowercasing.
   - `ui/src/editor/prefixedExternalLinks.test.ts` retains mixed ASCII casing (`WiKi`) and rejects the Kelvin-sign lookalike in `wiKi`.

4. **C1 control rejection**
   - `ui/src/editor/prefixedExternalLinks.ts` extends the shared control range through U+009F.
   - `ui/src/editor/prefixedExternalLinks.test.ts` includes U+0085 as a direct C1 regression.

5. **Accepted arXiv forms in documentation**
   - `ui/src/docs/content/getting-started.mdx` documents modern `NNNN.NNNN` and `NNNN.NNNNN`, legacy `archive/NNNNNNN`, optional positive `vN`, and identifier-only input rather than full arXiv URLs.
   - `ui/src/docs/mdx-smoke.test.tsx` asserts all four documentation facts against the raw guide source.

6. **Direct Enter caret coverage**
   - `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts` directly asserts collapsed selections at offset `0` in the new ordinary paragraph, heading-exit paragraph, and continued list item.

## TDD evidence

Expected RED runs before implementation:

- `bun run test -- src/editor/prefixedExternalLinks.test.ts`
  - Result: 1 file failed; 4 failures directly covering the non-ASCII prefix, C1 control, lone high surrogate, and lone low surrogate.
- `bun run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`
  - Result: 1 file failed; 4 failures directly covering heading expansion, list expansion, and both editor surrogate fallbacks.
- `bun run test -- src/docs/mdx-smoke.test.tsx`
  - Result: 1 file failed; 1 failure for the missing arXiv-form documentation.

Final focused verification from `ui/`:

- `bun run test -- src/editor/prefixedExternalLinks.test.ts`
  - Result: 1 file passed; 39 tests passed.
- `bun run test -- src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts src/editor/plugins/autoformat/__tests__/prefixedLinkTransform.test.ts src/editor/plugins/autoformat/__tests__/listContinuation.test.ts`
  - Result: 3 files passed; 98 tests passed. This includes the standard-Markdown serializer assertions in the prefixed-link integration suite.
- `bun run test -- src/docs/mdx-smoke.test.tsx src/routes/__tests__/-docs.test.ts`
  - Result: 2 files passed; 21 tests passed.

Per assignment, formatter, lint, typecheck, build, browser smoke, and full suites were not run.

## Changed files

- `ui/src/editor/prefixedExternalLinks.ts`
- `ui/src/editor/prefixedExternalLinks.test.ts`
- `ui/src/editor/plugins/autoformat/withAutoformat.ts`
- `ui/src/editor/plugins/autoformat/listContinuation.ts`
- `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts`
- `ui/src/docs/content/getting-started.mdx`
- `ui/src/docs/mdx-smoke.test.tsx`
- `.superpowers/sdd/2026-08-08-prefixed-external-links/final-fix-report.md`

The plan and approved design were not modified.

## Self-review

- Provider validation is centralized before registry dispatch, remains local and deterministic, allocates no intermediate copy for UTF-16 validation, and preserves valid mixed-case ASCII prefixes.
- Enter handling composes the existing heading/list transforms rather than duplicating their structure rules. Prefixed replacement owns the outer history batch; semantic completion suppresses only the redundant inner heading/list batch.
- List continuation now treats standard Slate inline content as paragraph content and detects the end of the paragraph structurally, preserving plain-text, task-item, and split behavior covered by the focused list suite.
- Generated nodes remain the existing standard Slate `link` element, and existing serializer tests still prove portable Markdown output.
- No dependency, backend, network, Slate type, plan, or design changes were introduced.

## Commit

- Implementation: `63f3f1f` (`fix(editor): complete prefixed link edge cases`)
- This report is committed separately so it can record the implementation commit.

## Concerns

None.
