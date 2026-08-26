# Task 1 report — deep member-creation session

## Status

Implemented the private `member-creation.ts` session module and its focused contract tests. No barrel export added. No caller migration included; that belongs to later tasks.

## Requirements delivered

- Definition sessions select `requestedView`, then the first declared view.
- Capability matching uses the repository ASCII case-fold helper.
- Missing view, revision, or matching capability returns `undefined`.
- Evaluation sessions own their capability, revision, and embedded filter.
- Submission trims the title once.
- Submission copies own draft fields into one output object.
- `null` and `undefined` fields are omitted.
- Empty arrays, empty strings, `false`, and `0` are preserved.
- Definition requests omit `embed_filter`.
- Evaluation requests include `embed_filter`.
- `create` runs exactly once.
- Successful creation returns the exact response.
- Only HTTP 409 errors with `base_revision_conflict` or `revision_conflict` refresh.
- Recognized conflicts decode diagnostics before one refresh attempt.
- Successful refresh returns the original conflict message and diagnostics.
- Failed refresh returns a failed outcome using the refresh error formatter and preserves original diagnostics.
- Other failures use the member-creation formatter and decoded diagnostics.
- Malformed diagnostics decode to `[]`.

## RED evidence

Command:

```text
bun run test -- src/components/bases/__tests__/member-creation.test.ts
```

Observed before production code existed:

```text
FAIL  src/components/bases/__tests__/member-creation.test.ts
Error: Failed to resolve import "#/components/bases/member-creation"
Test Files  1 failed (1)
```

The failure was the intended missing-module failure.

## GREEN evidence

Command after implementation and allocation cleanup:

```text
bun run test -- src/components/bases/__tests__/member-creation.test.ts
```

Observed:

```text
Test Files  1 passed (1)
Tests       18 passed (18)
Duration    670ms
```

The suite covers source resolution, exact standalone and embedded requests, falsey-value preservation, omission policy, success, both approved conflict codes, ordinary 409 handling, refresh rejection, API failures, valid diagnostics, and malformed diagnostics.

## Verification gates

Typecheck:

```text
$ bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

Scoped lint:

```text
$ bun run lint -- src/components/bases/member-creation.ts src/components/bases/__tests__/member-creation.test.ts
Checked 2 files in 7ms. No fixes applied.
exit 0
```

## Concerns

Vitest emitted existing Vite native-config migration warnings for `__dirname` and an extensionless `./mdx-plugin` import. They do not affect this task or test result.

## Round 1/5 quality fix

Strengthened the focused contract suite without changing production code:

- captured definition and evaluation requests and pinned `embed_filter` own-property presence;
- covered evaluation requests with `embedFilter` undefined and retained populated-filter identity;
- covered inherited enumerable field omission and retained array/object identity;
- pinned exactly one create call on every failure and zero refreshes on non-conflicts;
- covered the non-ASCII negative capability match `"ä"` versus `"Ä"`;
- removed source diagnostics inside resolving and rejecting conflict refreshes, then asserted the original decoded diagnostics with literals.

The strengthened tests passed immediately against the existing implementation. No RED production failure was expected or observed.

Focused test:

```text
$ bun run test -- src/components/bases/__tests__/member-creation.test.ts
Test Files  1 passed (1)
Tests       20 passed (20)
Duration    946ms
exit 0
```

Typecheck:

```text
$ bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

Scoped lint:

```text
$ bun run lint -- src/components/bases/member-creation.ts src/components/bases/__tests__/member-creation.test.ts
$ biome lint src/components/bases/member-creation.ts src/components/bases/__tests__/member-creation.test.ts
Checked 2 files in 25ms. No fixes applied.
exit 0
```

## Round 2/5 quality fix

Restored exact create-call tuple assertions for definition, populated-filter
evaluation, and undefined-filter evaluation requests. Each assertion now pins
the `"books"` base slug, exact two-argument arity, and full request body.
The own-property and retained-reference assertions remain in place.

Focused test:

```text
$ bun run test -- src/components/bases/__tests__/member-creation.test.ts
Test Files  1 passed (1)
Tests       20 passed (20)
Duration    977ms
exit 0
```

Typecheck:

```text
$ bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
exit 0
```

Scoped lint:

```text
$ bun run lint -- src/components/bases/member-creation.ts src/components/bases/__tests__/member-creation.test.ts
$ biome lint src/components/bases/member-creation.ts src/components/bases/__tests__/member-creation.test.ts
Checked 2 files in 24ms. No fixes applied.
exit 0
```

Concern: Vitest emitted the existing Vite native-config migration warnings
for `__dirname` and the extensionless `./mdx-plugin` import.
