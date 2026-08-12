# Task 1 Report: Grouped Compact Property Presentation

## Changed files

- `ui/src/components/codex/FolioProperties.tsx`
- `ui/src/components/codex/__tests__/FolioProperties.test.tsx`
- `.superpowers/sdd/2026-08-12-folio-properties-grouped-layout/task-1-report.md`

## RED

Command:

```bash
bun run --cwd ui test -- src/components/codex/__tests__/FolioProperties.test.tsx
```

Result: failed as intended with 6 assertion failures and no setup errors. The failures specifically showed missing `Reading`, `Shared`, and `Archive` labelled regions; missing compact `text`/`select` type spans; and provenance lacking the `sr-only` class. Test summary: 1 failed file, 6 failed and 9 passed tests.

## GREEN

Command:

```bash
bun run --cwd ui test -- src/components/codex/__tests__/FolioProperties.test.tsx
```

Result: passed. Test summary: 1 passed file, 15 passed tests. Vitest emitted only the pre-existing Vite native-config compatibility warning.

## Implementation

- Added local, unexported `PropertyGroup`, `groupProperties`, and `propertyTypeLabel` presentation helpers.
- Groups uniquely declared properties in authoritative `matching_bases` order and appends non-empty `Shared` last.
- Renders labelled Base/Shared regions, compact property rows, and adjacent compatible/conflict type labels with stable conflict-type deduplication.
- Keeps declaration provenance connected through `aria-describedby` while visually hiding it with `sr-only`.
- Preserved the component API, commit/refetch mutation lifecycle, reserved-body privacy, read-only behavior, editor behavior, failure recovery, and focus restoration.

## Self-review

- Confirmed no helper/API exports or response types changed.
- Confirmed properties render in exactly one group and Shared is appended only when non-empty.
- Confirmed no fallback group was added for impossible unmatched server declarations.
- Confirmed group sections use `aria-labelledby` without redundant `aria-label`.
- Confirmed value, save, error, retry/discard, and editor callbacks retain their existing behavior.
- Confirmed the focused contract test covers Base ordering, Shared uniqueness, compact compatible/conflict types, hidden provenance, body protection, locked/read-only behavior, membership refetch, editing, recovery, and focus.

## Commit

`HEAD` — `refactor(codex): group Folio properties by Base`

## Concerns

- Vitest reports an existing Vite config native-loader compatibility warning unrelated to this task.
