# Wave 3 final-review correction report

Date: 2026-08-12

## Scope

Corrected the four Important findings from `ReviewWave3Final`. Browser-smoke warnings were intentionally left out of scope. No formatter, linter, typecheck, build, broad Rust suite, or broad UI suite was run.

## 1. Canonical `body` validation

### RED

- `cargo test noncanonical_body_column_aliases_are_blocking_diagnostics`
  - Failed because `sys.body` and `prop.body` produced no blocking diagnostic.
- `cargo test body_aliases_participate_in_duplicate_detection`
  - Failed because body-equivalent aliases were not counted by the per-view duplicate check.

### GREEN

- Added one shared `is_body_field_reference` classifier used by authoritative Base validation and runtime field resolution.
- `sys.body` and `prop.body` now produce blocking diagnostics at their exact `views[i].columns[j]` paths.
- Canonical and noncanonical spellings share the duplicate counter, so mixed aliases also report the later duplicate path.
- Added API coverage proving an update containing both aliases is rejected while the previously stored canonical `body` view still evaluates successfully.

Verification:

- `cargo test vault::base::tests::` — 29 passed.
- `cargo test --test bases_api` — 57 passed.

## 2. Exact excerpt boundary

### RED

- `cargo test body_excerpt_obeys_exact_scalar_boundary`
  - Failed at 241 normalized scalars: the old implementation returned 240 content scalars without U+2026.

### GREEN

- Normalization now observes one scalar beyond the limit before deciding whether truncation occurred.
- Inputs of 239 and 240 normalized Unicode scalars are returned unchanged.
- Longer inputs return the first 239 normalized Unicode scalars plus U+2026, for exactly 240 output scalars.
- Added explicit 239/240/241, multibyte Unicode, and normalized whitespace/word-boundary cases.

Verification:

- `cargo test vault::query::tests::body` — 8 passed.
- `cargo test protected_body_column_is_null_and_never_serializes_armored_content` — 1 passed.

## 3. Equality-indexed body projection

### RED

- `cargo test body_projection_plan_uses_a_page_id_index_lookup`
  - Failed because the body source was the FTS table and did not provide the required equality-indexed `page_id` access.

### GREEN

- Added `page_bodies(page_id TEXT PRIMARY KEY, body TEXT NOT NULL)` as the body-projection source.
- Both index upsert paths maintain the projection in the same transaction as `pages` and `pages_fts`; the foreign key cascades deletion.
- Existing indexes receive a one-time set-wise FTS-to-keyed-table migration/backfill.
- The Base row query now joins `page_bodies` by primary-key equality instead of joining `pages_fts.page_id` before pagination.
- The SQL `CASE WHEN p.encrypted = 1 THEN NULL` gate and Rust-side protected-body suppression remain intact.
- Query-plan coverage requires `SEARCH body_index ... page_id=? LEFT-JOIN` and rejects a body-source scan.

Verification:

- `cargo test body_projection_plan_uses_a_page_id_index_lookup` — 1 passed.
- `cargo test body_column_projects_bounded_normalized_plain_text` — 1 passed.
- `cargo test migrates_existing_fts_bodies_into_the_keyed_projection` — 1 passed.
- `cargo test protected_body_column_is_null_and_never_serializes_armored_content` — 1 passed.

## 4. Ordered property transport cutover

### RED

- `bun run test src/components/bases/__tests__/definition-model.test.ts` — the reverse integer-like-key test failed because JavaScript object enumeration reordered `"1"` and `"2"`.
- `cargo test --test bases_api ordered_property_entries_preserve_reverse_integer_like_keys_across_save_reload` — failed with HTTP 422 because the endpoint still expected a property map.

### GREEN

- Introduced API-only `BasePropertyEntry { key, definition }`, `BaseFilePayload`, and `BaseDefinitionPayload` DTOs.
- Create, update, preview, detail, and mutation endpoints convert explicitly between the ordered wire DTO and the existing canonical ordered domain vector.
- The removed JavaScript object/map representation is rejected; no alias or dual deserializer remains.
- Regenerated `ui/src/api/schema.d.ts` from the live OpenAPI endpoint. Generated schema now represents Base properties only as `BasePropertyEntry[]`.
- Updated `fromWire`/`toWire`, table, embed, semantic-validation, member-draft consumers, stories, and focused fixtures to consume the ordered entry array. Runtime lookup sites build local `Map` values where keyed access is useful without changing wire order.
- Added reverse integer-like mixed-order UI parse/serialize coverage and API create/save/reload coverage using `2`, `ordinary`, `1`.

OpenAPI regeneration:

- Started an isolated server against a disposable vault on port 3100.
- `bunx openapi-typescript 'http://[::1]:3100/api/openapi.json' -o src/api/schema.d.ts` — succeeded.
- Stopped the isolated server.

Verification:

- `cargo test --test bases_api` — 57 passed.
- `cargo test openapi` — 16 passed.
- `bun run test src/components/bases/__tests__/definition-model.test.ts src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx src/components/bases/__tests__/PropertiesEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx` — 4 files, 108 tests passed.
- `bun run test src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/bases/__tests__/member-draft.test.ts src/components/bases/__tests__/embed-semantic-validation.test.ts src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/editor/elements/BaseEmbedElement.test.tsx` — 7 files, 177 tests passed.
- `bun run test src/components/bases/__tests__/CreateBaseDialog.test.tsx src/components/bases/__tests__/useBaseTableController.test.tsx` — 2 files, 24 tests passed.

## Self-review

- Reviewed every changed Rust correction file and every changed Base UI/API file.
- Searched Base UI consumers for stale object enumeration/indexing and stale `properties: { ... }` fixtures; none remain in the changed Base surfaces.
- Confirmed generated TypeScript no longer exposes `BaseFile` or domain `BaseDefinition` schemas and that all Base authoring request schemas refer to `BaseFilePayload`.
- Confirmed empty property lists serialize as arrays on responses while remaining omittable on requests.

## Remaining concerns

- Focused Vitest runs emit existing Vite native-config warnings about `__dirname` and an extensionless `mdx-plugin` import. These are unrelated browser-smoke warnings and were not changed per scope.
- Real-browser smoke and repository-wide gates remain deliberately unrun for this correction wave.
