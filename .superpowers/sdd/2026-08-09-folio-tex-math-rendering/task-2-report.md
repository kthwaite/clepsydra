# Task 2 Report: Shared Safe KaTeX Renderer

## Status

Complete. Task 2 is implemented in the isolated `folio-tex-math` worktree on top of reviewed commit `3fa071cefdcda9f70532e62520ae6001756843ee`.

## Implemented contract

- Added exported `MathRenderResult`, pure `renderMathToHtml(tex, display)`, `MathExpressionProps`, and shared `MathExpression`.
- KaTeX rendering is guarded and fixed to `displayMode`, combined HTML+MathML output, `trust: false`, and `throwOnError: true`.
- `dangerouslySetInnerHTML` exists only in the local `KatexOutput` component and receives only the successful KaTeX result.
- Successful inline/display expressions render through semantic `span`/`div` wrappers; interactive wrappers expose button semantics, focusability, click activation, and keyboard activation.
- Invalid expressions render `formatMathSource(tex, delimiter)` verbatim, with `aria-invalid`, an accessible invalid-expression label, and a visible non-color-only `!` marker. KaTeX error prose is not exposed.
- Added coverage for visual KaTeX HTML, accessible MathML, inline/display wrappers, exact invalid authored source, click activation, and rejected `\\href` / `\\includegraphics` commands producing no active link, image, or URL-bearing element.
- Imported `katex/dist/katex.min.css` once at the UI entry point. Added token-based inline baseline, restrained preview scale, display overflow, invalid source, and focus styles. Display math has `min-width: 0`, `max-width: 100%`, and `overflow-x: auto` so wide expressions scroll within the prose column.

## Red/green evidence

Commands below were run with `ui/` as the working directory because Bun 1.3.14 does not accept the brief's `bun --cwd ui x ...` form.

1. `bun x vitest run src/components/MathExpression.test.tsx`
   - RED as required: Vitest failed to resolve missing `#/components/MathExpression`; 1 failed suite, 0 tests.
2. After the initial renderer implementation, the same focused command.
   - Intermediate RED: 7 passed, 1 failed because the brief's broad `.katex *` text selector matched both visual HTML and MathML. The assertion was narrowed to `.katex-html *` without weakening the accessible MathML assertion.
3. After correcting the test query, the same focused command.
   - GREEN: 1 file, 8/8 tests passed.
4. `bun run typecheck`
   - RED: one test-only TypeScript error because `String.raw` widened the `delimiter` prop to `string` instead of `MathDelimiter`.
5. After preserving the `"\\("` delimiter literal type, `bun x vitest run src/components/MathExpression.test.tsx`.
   - GREEN: 1 file, 8/8 tests passed.
6. `bun run typecheck`
   - GREEN: `tsc --noEmit --project tsconfig.app.json` exited 0.
7. Fresh final `bun x vitest run src/components/MathExpression.test.tsx` after the CSS review.
   - GREEN: 1 file, 8/8 tests passed; no warning/error output attributable to Task 2.
8. Fresh final `bun run typecheck`.
   - GREEN: `tsc --noEmit --project tsconfig.app.json` exited 0.

## Self-review

Reviewed every Task 2 checkbox and all changed files. The component has one KaTeX rendering path, one isolated HTML injection point, a discriminated failure result, exact authored invalid fallback, no KaTeX error disclosure, and no configurable trust surface. CSS uses existing Folio tokens, contains no remote asset URL or fixed width, overrides KaTeX's default preview scale locally, and constrains display math at the wrapper rather than widening its containing column. The KaTeX stylesheet has exactly one source import. Only the four Task 2 implementation/test files and this requested report changed.

KaTeX preserves authored TeX in an inert MathML `<annotation>`, including URL text supplied to rejected commands. With `trust: false`, no active `<a>`, `<img>`, `href`, or `src` is emitted; the security tests assert that active-resource boundary.

## Skipped by instruction

Formatter, lint, build, and project-wide/full test suites were not run.

## Concerns

None blocking. The inert MathML annotation behavior noted above is intrinsic to combined HTML+MathML output and does not initiate navigation or resource loading.
