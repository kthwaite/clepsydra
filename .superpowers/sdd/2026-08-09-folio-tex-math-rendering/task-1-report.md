# Task 1 Report: Source-Preserving Markdown Math

## Status

Complete. Task 1 is implemented in the isolated `folio-tex-math` worktree. The parser, positioned-source transformer, source-preserving serializer, Markdown↔Slate conversion, direct dependencies, lockfile, typed Slate elements, and focused regression coverage are in place.

## Implemented contract

- Added direct runtime dependencies `micromark-extension-math-extended`, `mdast-util-math`, and `katex`, plus dev dependency `@types/katex`; `ui/bun.lock` was updated by Bun.
- Added `MathDelimiter`, `FolioMathData`, `remarkFolioMath`, `folioMathToMarkdown()`, and `formatMathSource()` in `ui/src/lib/markdown/folioMath.ts`.
- The local remark plugin installs both lower-level parser extensions and its transformer. The transformer uses mdast position offsets to slice exact authored source, restores the exact body and delimiter metadata, and projects `span`/`div` HAST metadata with `data-folio-math`, `data-tex`, and `data-delimiter`.
- Inline double-dollar tokens and malformed/unclosed display-dollar tokens are downgraded structurally to text rather than preprocessed with regexes. Inline code, fenced code, escaped openers, unmatched delimiters, nested `\[` displays, and display closers with trailing content remain non-math.
- The serializer branches on the preserved delimiter, preserves authored bodies byte-for-byte, emits canonical multiline dollar display syntax for bare programmatic TeX, falls back to supported `\(...\)` / `\[...\]` forms instead of unsupported longer dollar fences when programmatic bodies collide, and does not register upstream `mathToMarkdown()` beside the Folio handlers.
- Added `InlineMathElement` and `MathBlockElement` to `schema/types.ts` and `CustomElement`; descriptor registration was intentionally not changed.
- Markdown→Slate now installs `remarkFolioMath` and runs `runSync(processor.parse(markdown), { value: markdown })`. Inline and display math map to distinct typed Slate elements with one empty child.
- Slate→Markdown routes inline math through `convertInlineChildren`, handles display math before descriptor fallback, and installs only `folioMathToMarkdown()` for math serialization.

## Red/green evidence

Commands below were run in order. Unless noted otherwise, the working directory was `ui/` inside the isolated worktree.

### Dependencies

1. `bun add --cwd ui micromark-extension-math-extended mdast-util-math katex`
   - PASS. Installed `micromark-extension-math-extended@3.2.2`, `mdast-util-math@3.0.0`, and `katex@0.18.3`; lockfile saved.
2. `bun add --cwd ui --dev @types/katex`
   - PASS. Installed `@types/katex@0.16.8`; lockfile saved.

### Parser and serializer TDD

1. Prescribed command from the worktree root: `bun --cwd ui x vitest run src/lib/markdown/folioMath.test.ts`
   - Command compatibility failure before Vitest: Bun 1.3.14 reported `Script not found "x"`.
2. Equivalent command from `ui/`: `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - RED as required: suite could not resolve missing `./folioMath`; 1 failed suite, 0 tests.
3. After initial implementation: `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - Intermediate RED: 29 passed, 3 failed. One inline-code fixture accidentally contained escaped backticks; two expected strings did not yet match the copied upstream rule that increases the fence before padding a leading/trailing dollar. The fixture/expectations were corrected without weakening behavior.
4. `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - GREEN: 1 file, 32/32 tests passed.
5. Self-review added explicit unclosed `$$` and `$$\nx` exclusions, then ran `bun x vitest run src/lib/markdown/folioMath.test.ts`.
   - RED: 32 passed, 2 failed; upstream flow tokenization had produced math nodes for both unclosed forms.
6. After structurally downgrading malformed positioned flow nodes: `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - GREEN: 1 file, 34/34 tests passed.

### Conversion and round-trip TDD

1. `bun x vitest run src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts`
   - RED as required: 5 new math assertions failed and 99 tests passed. Failures showed missing inline/display Slate mapping, missing source-aware backslash round-trip, and descriptor-free Slate math serialization.
2. After wiring parser transforms, typed conversion branches, and the Folio serializer: the same three-file command.
   - GREEN: 3 files, 104/104 tests passed, including all pre-existing conversion cases.
3. Self-review changed the descriptor-free programmatic block fixture from positioned `"\ny\n"` to bare `"y"`, then ran `bun x vitest run src/editor/convert/__tests__/slate-to-mdast.test.ts`.
   - RED: 29 passed, 1 failed; output was invalid inline-looking `$$y$$` instead of canonical display fencing.
4. After distinguishing authored dollar-display bodies from bare programmatic TeX: the same one-file command.
   - GREEN: 1 file, 30/30 tests passed.
5. Pipeline smoke command: `bun x vitest run src/lib/markdown/folioMath.test.ts src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts`
   - GREEN: 4 files, 136/136 tests passed at that stage.

### Typecheck TDD/fixes

1. `bun run typecheck`
   - RED: 4 TypeScript errors in the new math module/test (literal delimiter inference, mdast data assignment, recursive child narrowing, and unified `toMarkdownExtensions` typing).
2. After the first type fixes: `bun run typecheck`
   - RED: 1 remaining excess-property error on the typed math data assignment.
3. After defining the projected metadata fields and assigning through `FolioMathData`: `bun run typecheck`
   - GREEN: `tsc --noEmit --project tsconfig.app.json` exited 0.

### Fresh final verification after cleanup

1. `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - GREEN: 1 file, 34/34 tests passed.
2. `bun x vitest run src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts`
   - GREEN: 3 files, 104/104 tests passed.
3. `bun run typecheck`
   - GREEN: `tsc --noEmit --project tsconfig.app.json` exited 0.

## Self-review

Completed against the Task 1 brief and changed-file scope. Review found and corrected four substantive edge cases with red/green evidence: bare programmatic display math was initially serialized as `$$y$$`; unclosed display-dollar fences initially remained upstream math nodes; collision-bearing programmatic math initially emitted unsupported longer dollar fences; and authored `$ x $` source initially gained safety padding. The final implementation preserves authored delimiter/body source and LF/CRLF line endings, emits valid parseable fallbacks and canonical programmatic display fences, performs no Markdown regex preprocessing, keeps code spans/fences untouched, installs no duplicate upstream math serializer, and changes only Task 1 files plus this report.

## Skipped by instruction

Formatter, lint, build, and project-wide/full test suites were not run.

## Concern

The brief's `bun --cwd ui x ...` command form is not accepted by the installed Bun 1.3.14 (`Script not found "x"`). Running the equivalent `bun x ...` with `ui/` as the command working directory produced all red/green and final verification evidence above.

## Review fix round 1: supported collision fallback and exact authored bodies

The review identified that longer dollar fences are outside Folio's supported syntax and therefore did not survive serializer→parser→Slate round trips. It also identified that applying programmatic padding rules to positioned `$ x $` source changed the authored body.

1. Added serializer and serializer→parser→Slate tests for collision-bearing programmatic inline/display nodes, exact authored `$ x $`, authored LF and CRLF inline bodies, and authored display bodies containing dollar streaks.
2. RED: `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - 1 file; 30 passed, 8 failed exactly on the new fallback/source-preservation assertions.
3. RED: `bun x vitest run src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts`
   - 3 files; 104 passed, 2 failed exactly on the new programmatic inline/display serializer→parser→Slate round trips.
4. Implemented supported-delimiter selection: isolated-dollar inline collisions now emit `\(...\)`; display `$$` streak collisions now emit `\[...\]`; safe programmatic dollar forms retain `$`/`$$`; positioned/stored safe inline bodies emit verbatim; positioned or source-shaped authored display bodies emit verbatim.
5. GREEN: `bun x vitest run src/lib/markdown/folioMath.test.ts`
   - 1 file, 38/38 tests passed.
6. GREEN: `bun x vitest run src/editor/convert/__tests__/mdast-to-slate.test.ts src/editor/convert/__tests__/slate-to-mdast.test.ts src/editor/convert/__tests__/round-trip.test.ts`
   - 3 files, 106/106 tests passed.
