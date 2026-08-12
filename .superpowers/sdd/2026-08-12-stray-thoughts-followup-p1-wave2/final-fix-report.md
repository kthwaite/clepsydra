# Wave 2 Task 1/2 review-fix report

## Status

Complete. All Task 1/2 review findings were addressed in one focused fix commit.

## Fixes

- Marked always-serialized nullable `BoardTask.body_excerpt` as required in Utoipa and strengthened its OpenAPI test to assert both required membership and `string | null`.
- Marked always-serialized nullable `PageBaseProperty.value` and `definition` as required in Utoipa. The OpenAPI contract now asserts required membership, nullable `PropertyDefinition` alternatives, and the unconstrained value schema that permits JSON null.
- Strengthened the property projection fixture so false, zero, and an empty array each assert `present = true`.
- Added a valid `non_finite = nan` TOML value and number declaration; the projection contract asserts it is present while its JSON value is null, distinct from the absent `note` property.
- Left `ui/src/api/schema.d.ts` unchanged for parent-owned regeneration.

## Validation

Per assignment, no tests, formatter, linter, build, schema regeneration, or other validation command was run. The focused contracts were updated for parent validation.

## Commit

`HEAD` — `fix(api): close Wave 2 projection review findings`
