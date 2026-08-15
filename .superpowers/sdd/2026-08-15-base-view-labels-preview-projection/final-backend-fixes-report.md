# Final backend fixes report

## Status

DONE

## Review source

Addressed the three backend Important findings from `agent://FinalBasePreviewReview`:

1. blank preview field references were warnings rather than save-blocking errors;
2. custom properties beginning with `sys.` emitted ambiguous projection wire keys;
3. empty body excerpts were serialized as present empty strings.

## Files changed

- `src/vault/base.rs`
- `src/vault/query.rs`
- `src/api/properties.rs`
- `tests/property_patch.rs`
- `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/final-backend-fixes-report.md`

No UI files, generated schema, or user-facing documentation were changed.

## Decisions

### Blank preview fields

`validate` now checks `definition.field.trim().is_empty()` at each preview row before calling the canonical resolver. A blank reference emits an `Error` at the exact `preview[i].field` path and does not fall through to the undeclared-property warning path. Nonblank unavailable property and unknown-system references retain their existing addressed `Warning` behavior.

### Injective projection wire keys

System identities retain their bare canonical key. Custom identities are now `prop.`-qualified when the custom key shadows a system field or begins with either reserved grammar prefix, `prop.` or `sys.`. Thus each emitted custom key can be parsed by `resolve_projection_field` back to the original `ProjectionFieldIdentity::Property` without colliding with system grammar.

### Empty body excerpts

Body projection computes the excerpt once. Protected pages remain absent. For unlocked pages, an empty normalized excerpt now returns `(false, None)`; a nonempty excerpt remains present and uses the existing Unicode-scalar bound and Markdown normalization.

## Focused regression tests added

- `vault::base::tests::preview_fields_reject_blank_references_before_resolution`
  - covers an empty field and a whitespace-only field;
  - asserts exact Error paths and the absence of warning fallback for those rows;
  - confirms a nonblank unavailable property remains a Warning.
- `vault::query::tests::page_field_projection_treats_an_empty_body_excerpt_as_missing`
  - asserts the domain result `(false, None)` for an empty body;
  - existing bounded Unicode excerpt coverage continues to defend the nonempty path.
- `get_projects_empty_body_excerpt_is_missing`
  - asserts the API emits `present: false` and `value: null` for an empty body;
  - existing API coverage continues to assert a normalized nonempty excerpt is present.
- `get_projection_wire_keys_round_trip_every_custom_identity_class`
  - exercises ordinary, system-shadowing, `prop.`-prefixed, and `sys.`-prefixed custom keys through the endpoint;
  - feeds every emitted response key back through `resolve_projection_field` and compares it with the configured canonical property identity.

## Self-review

- The blank-field guard is preview-specific, precedes resolution, reports the exact row path, and does not alter validation severity for any nonblank reference.
- The wire-key rule extends the existing encoder rather than introducing a second field registry or parser.
- The four wire-key classes fit within the production four-field cap, so every asserted response key is returned rather than hidden in `remaining_count`.
- Body excerpt generation occurs exactly once on the unlocked body path and does not add a body clone.
- Existing protected-page suppression, missing custom-property handling, schema-conflict behavior, canonical merge order, provenance, and response schema remain unchanged.
- No compatibility shims, aliases, generated artifacts, UI edits, or unrelated cleanup were introduced.

## Verification and concerns

Per the assignment constraint, no tests, formatters, linters, builds, or typechecks were run; the only shell commands were the required exact-path staging and commit operations. The focused regressions were written but not executed. This deferred execution is the only known concern; no source-level correctness concern was identified during focused self-review.
