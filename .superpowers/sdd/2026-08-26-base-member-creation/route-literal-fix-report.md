# Route literal fix report

## Status

Fixed the blocking TanStack route-generation regression.

## Root cause

The URL-filter refactor passed route path constants to `createFileRoute` in four route files. TanStack route generation extracts route IDs from source ASTs. It does not evaluate constants. Every affected declaration therefore failed with `expected route id to be a string literal or plain template literal`.

## Change

Changed only the four route declarations:

- `academic.tsx`: `createFileRoute("/academic")`
- `agenda.tsx`: `createFileRoute("/agenda")`
- `rubbish.tsx`: `createFileRoute("/rubbish")`
- `tasking.tsx`: `createFileRoute("/tasking")`

Kept each route path constant unchanged for its navigation adapter. Added no source-text test. Route generation through the production build remains the regression gate.

## Verification

Run from `ui/` on 2026-08-27:

- `bun run test src/routes/-academic.test.tsx src/routes/-agenda.test.tsx src/routes/-rubbish.test.tsx src/routes/-tasking.test.tsx` — passed: 4 files, 39 tests.
- `bun run typecheck` — passed.
- `bun run build` — passed: 4,559 modules transformed; production bundle built. None of the four route-ID literal errors appeared.

## Concerns

No blocking concerns. Existing non-blocking output remains:

- Vitest warns that native Vite config loading will not support `__dirname` or an extensionless `./mdx-plugin` import.
- Route generation warns that `src/routes/__tests__/routeViews.test.ts` does not export a route.
- Vite warns about chunks larger than 500 kB after minification.
