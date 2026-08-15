# Task 3 Report: Authoritative page preview projection and generated wire contract

## Status

DONE

## RED evidence

### Current-page field projection helper

Command:

```text
cargo test page_field_projection -- --nocapture
```

Observed exit 101 before production implementation:

```text
error[E0425]: cannot find function `project_page_field_value` in this scope
  --> src/vault/query.rs:1365:17
error[E0425]: cannot find function `project_page_field_value` in this scope
  --> src/vault/query.rs:1383:17
error[E0425]: cannot find function `project_page_field_value` in this scope
  --> src/vault/query.rs:1392:13
error[E0425]: cannot find function `project_page_field_value` in this scope
  --> src/vault/query.rs:1407:13
error: could not compile `clepsydra` (lib test) due to 4 previous errors
```

This was the intended missing-helper failure. The tests already covered every system shape, effective inferred kind/tags, custom scalar/array/false/zero/non-finite values, missing custom values, and the Unicode-safe body excerpt.

### Required page preview response

Command:

```text
cargo test --test property_patch get_projects_authoritative_membership_values_provenance_and_privacy -- --nocapture
```

Observed exit 101 before DTO/merge implementation:

```text
running 1 test
thread 'get_projects_authoritative_membership_values_provenance_and_privacy' panicked at tests/property_patch.rs:454:5:
assertion `left == right` failed
  left: Null
 right: 3
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 13 filtered out
```

The missing `preview` object made the expected exact remainder count unavailable, proving the new wire contract was absent.

## Implementation

- Added one read-only `project_page_field_value` domain helper. It projects canonical system, custom, and body identities from one already-read `Page`, uses effective kind/tags and the indexed journal-date/word-count semantics, converts TOML through `toml_value_to_json`, and borrows the body until `body_excerpt` is requested. It performs no SQL.
- Added `PagePreviewSource`, `PagePreviewField`, and `PagePreviewProjection`; `PageBasePropertiesResponse.preview` is required.
- Matching Bases are sorted by slug. Their configured lists merge in order through a canonical-identity position map; later occurrences add provenance without moving the field. Effective-label disagreement falls back to the canonical key. Values resolve once per returned merged identity.
- Existing declaration compatibility is indexed by custom key. Schema-conflicted values remain conservatively readable and marked. Undeclared/reserved custom references remain absent, preserving the endpoint's existing metadata-privacy boundary.
- Protected pages return `{ fields: [], remaining_count: 0 }` while existing matching Base/property projection and encrypted response behavior remain unchanged.
- Responses retain the first four canonical fields and count every remaining merged field exactly.
- Registered all new schemas and added a focused nested required-field OpenAPI contract test.

## GREEN evidence

Final focused backend commands:

```text
cargo test --test property_patch get_ -- --nocapture
# 6 passed; 0 failed; 8 filtered out

cargo test api::openapi::tests -- --nocapture
# 13 passed; 0 failed; 1949 filtered out

cargo test vault::query::tests -- --nocapture
# 41 passed; 0 failed; 1921 filtered out
```

The integration coverage includes empty projections for no matches/no configuration, slug/list order, canonical de-duplication, agreed canonical and conflicting labels, provenance, schema-conflicted raw arrays, false, zero, non-finite-to-null, missing values, Markdown body excerpts, protected-page suppression, four-field cap, exact remainder, and unchanged existing properties/blockers/compatibility/read-after-PATCH assertions.

## Generated TypeScript contract

A disposable vault was initialized under `/tmp/clepsydra-task3.1BBYg9` with a temporary `XDG_CONFIG_HOME`; `ui/dist` already existed. Port 3000 was occupied by unrelated managed and user servers, so the first managed launch correctly exited with `Address already in use`. The coordinator ruled that unrelated processes must remain untouched and authorized port 3001 plus the pinned generator command.

Managed server `task3-openapi-3001` reached both the `listening (HTTP)` log and `127.0.0.1:3001` readiness. From `ui/`:

```text
bunx openapi-typescript http://127.0.0.1:3001/api/openapi.json -o src/api/schema.d.ts
✨ openapi-typescript 7.13.0
🚀 http://127.0.0.1:3001/api/openapi.json → src/api/schema.d.ts [100.5ms]
```

The server was then stopped through the process manager. Generated inspection confirmed:

- `BaseFilePayload.preview?: PreviewFieldDefinition[]`;
- `ViewDefinition.labels?: { [key: string]: string }`;
- required `PageBasePropertiesResponse.preview`;
- required `PagePreviewField.present`, `value`, `schema_conflict`, and `label_conflict`;
- named projection/field/source schemas.

`bun run typecheck` exited 2 with exactly four expected generated-contract consumer failures, all for missing required `preview` and intentionally left for Tasks 4/5:

```text
src/api/bases.test.ts(372,7): TS1360
src/api/bases.test.ts(520,7): TS1360
src/api/bases.test.ts(526,7): TS1360
src/components/codex/__tests__/FolioProperties.test.tsx(77,3): TS2741
```

## Self-review

- Confirmed no per-field SQL, no page-body clone, no schema/property declaration rescan per preview row, and no value resolution per source occurrence.
- Confirmed canonical system/property/body identities, first-position retention, deterministic source order, total handling of invalid presentation references, and exact cap arithmetic.
- Confirmed reserved metadata and protected content cannot enter preview serialization; existing property projection and PATCH code were not changed.
- Confirmed OpenAPI requiredness matches serialization and the generated file was changed only by generation.
- `git diff --check` passed. No formatter, linter, build, or project-wide suite was run, per the task constraint.

## Remaining concerns

The four TypeScript consumer fixtures must add the required projection in Tasks 4/5. No backend concern remains from the focused scope.
