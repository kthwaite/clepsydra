# Final fix report

## Scope

Added focused regression coverage for every final-review contract without changing production behavior:

- plain Enter commits the raw draft while matching suggestions are visible;
- mouse-down selection commits only the selected suggestion before blur can commit the draft;
- matching suggestions are capped at five;
- the combobox `aria-controls` identifies the rendered listbox, and `aria-activedescendant` identifies the selected option both initially and after ArrowDown navigation;
- an unavailable/erroring tag index still permits raw tag entry and blur-triggered save, with no listbox rendered.

## Mutation RED evidence

Commands below were run from `ui/`. Each temporary production mutation was restored immediately after its targeted RED run.

1. **Raw Enter** — mutated Enter to accept the initially selected match whenever the popup was open.

   ```text
   bun run test -- src/components/ui/__tests__/tag-input.test.tsx -t "commits the raw draft on Enter while suggestions are open"
   Test Files  1 failed (1)
   Tests       1 failed | 31 skipped (32)
   expected ["re"], received ["research"]
   ```

2. **Mouse selection/blur ordering** — moved suggestion selection from `onMouseDown` to `onClick`.

   ```text
   bun run test -- src/components/ui/__tests__/tag-input.test.tsx -t "commits only the mouse-selected suggestion before blur"
   Test Files  1 failed (1)
   Tests       1 failed | 31 skipped (32)
   expected ["research"], received ["re"]
   ```

3. **Five-result cap** — removed the `slice(0, MAX_SUGGESTIONS)` limit.

   ```text
   bun run test -- src/components/ui/__tests__/tag-input.test.tsx -t "renders at most five matching suggestions"
   Test Files  1 failed (1)
   Tests       1 failed | 31 skipped (32)
   expected length 5, received 6
   ```

4. **ARIA controls relationship** — removed `aria-controls` from the combobox.

   ```text
   bun run test -- src/components/ui/__tests__/tag-input.test.tsx -t "links the combobox to its listbox and active option across navigation"
   Test Files  1 failed (1)
   Tests       1 failed | 31 skipped (32)
   expected aria-controls="_r_0_", received null
   ```

5. **ARIA active-descendant navigation** — fixed `aria-activedescendant` to option zero instead of the selected option.

   ```text
   bun run test -- src/components/ui/__tests__/tag-input.test.tsx -t "links the combobox to its listbox and active option across navigation"
   Test Files  1 failed (1)
   Tests       1 failed | 31 skipped (32)
   expected aria-activedescendant="_r_0_-1", received "_r_0_-0"
   ```

6. **Unavailable/erroring tag index** — removed the `tagIndex ?? []` fallback before mapping indexed tags.

   ```text
   bun run test -- src/components/codex/__tests__/Folio.test.tsx -t "keeps raw tag editing and blur-save operational without a tag index"
   Test Files  1 failed (1)
   Tests       1 failed | 7 skipped (8)
   TypeError: Cannot read properties of undefined (reading 'map')
   ```

## Final GREEN evidence

Command run from `ui/` after restoring all production mutations:

```text
bun run test -- src/components/ui/__tests__/tag-input.test.tsx src/components/codex/__tests__/Folio.test.tsx
Test Files  2 passed (2)
Tests       40 passed (40)
Duration    1.30s
```

Per assignment, no formatter, lint, build, Rust checks, or project-wide UI suite was run.

## Changed files

- `ui/src/components/ui/__tests__/tag-input.test.tsx`
- `ui/src/components/codex/__tests__/Folio.test.tsx`
- `.superpowers/sdd/2026-08-09-folio-tag-suggestions/final-fix-report.md`

No production files remain changed; the new tests confirmed the existing implementation already satisfies the contracts.

## Follow-up type-safety correction

The unavailable-index fixture initially exposed that `useTagsMock` had inferred
`data` as a populated array only. The mock now declares its real test contract
as `TagCount[] | undefined`, preserving both populated and unavailable/error
fixtures.

Initial RED:

```text
bun run --cwd ui typecheck
src/components/codex/__tests__/Folio.test.tsx(228,7): error TS2322:
Type 'undefined' is not assignable to type '{ tag: string; count: number; }[]'.
Command exited with code 2
```

Final GREEN:

```text
bun run --cwd ui typecheck
$ tsc --noEmit --project tsconfig.app.json
Exit code 0

bun run --cwd ui test -- src/components/codex/__tests__/Folio.test.tsx
Test Files  1 passed (1)
Tests       8 passed (8)
Duration    1.21s
```
