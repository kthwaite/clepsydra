# Task 1 Report: Base presentation model and canonical projection identity

## Status

DONE

## RED

### Additive serde model

Command:

```text
cargo test vault::base::tests -- --nocapture
```

Relevant output (exit 101):

```text
error[E0609]: no field `preview` on type `base::BaseFile`
error[E0609]: no field `labels` on type `base::ViewDefinition`
error: could not compile `clepsydra` (lib test) due to 10 previous errors
```

### Canonical projection resolver

Command:

```text
cargo test vault::query::tests -- --nocapture
```

Relevant output (exit 101):

```text
error[E0425]: cannot find function `resolve_projection_field` in this scope
error[E0433]: cannot find type `ProjectionFieldIdentity` in this scope
error: could not compile `clepsydra` (lib test) due to 21 previous errors
```

### Presentation validation

After the additive serde model and resolver made the tests runnable, command:

```text
cargo test vault::base::tests -- --nocapture
```

Relevant output (exit 101):

```text
running 38 tests
vault::base::tests::duplicate_preview_canonical_identities_are_errors_at_later_rows ... FAILED
vault::base::tests::presentation_labels_reject_whitespace_only_values_at_addressed_paths ... FAILED
vault::base::tests::unknown_presentation_references_are_addressed_warnings ... FAILED
test result: FAILED. 35 passed; 3 failed; 0 ignored; 0 measured; 1034 filtered out
```

The failures were the intended missing duplicate, empty-label, and unknown-reference diagnostics.

## GREEN

Commands:

```text
cargo test vault::base::tests -- --nocapture
cargo test vault::query::tests -- --nocapture
```

Relevant output:

```text
vault::base::tests: test result: ok. 38 passed; 0 failed; 0 ignored; 0 measured; 1034 filtered out
vault::query::tests: test result: ok. 38 passed; 0 failed; 0 ignored; 0 measured; 1034 filtered out
```

No formatter, linter, build, or project-wide test suite was run, as required by the task brief.

## Files changed

- `src/vault/base.rs`
  - Added `PreviewFieldDefinition`, `BaseFile.preview`, deterministic `ViewDefinition.labels`, serde defaults/empty omission, parsing, addressed validation, and focused tests.
- `src/vault/query.rs`
  - Added the hashable `ProjectionFieldIdentity` and reusable `resolve_projection_field`; retained `resolve_field` rejection of all `body` spellings; added focused identity tests.
- `src/api/bases.rs`
  - Clean-cutover migration: added `preview` to the public wire payload and both conversions; supplied empty defaults to existing literals.
- `src/vault/base_document.rs`
  - Supplied an empty `preview` default to the existing test literal.
- `src/vault/base_embed.rs`
  - Supplied empty `preview`/`labels` defaults to existing test literals.
- `.superpowers/sdd/2026-08-15-base-view-labels-preview-projection/task-1-report.md`
  - Recorded the required evidence and review.

The three additional Rust paths were authorized by the parent scope ruling because adding required public struct fields otherwise breaks direct literals and the API wire conversion. Persistence behavior in `base_document.rs` remains outside Task 1.

## Self-review

- Confirmed canonical identity is spelling-independent: bare/system-qualified system fields coalesce; property-qualified shadow fields remain distinct; all accepted `body` spellings coalesce.
- Confirmed the resolver reuses the existing `SysField` grammar rather than introducing another field registry.
- Confirmed `resolve_field` delegates identity parsing but still returns `ProjectionOnlyBody`, preserving filter/sort/group/aggregate behavior.
- Confirmed missing properties and unknown explicit system fields are warnings only for presentation references, with addressed paths; whitespace labels and later canonical preview duplicates are errors.
- Confirmed `body` remains valid for presentation while the existing reserved writable property diagnostic remains active.
- Confirmed ordered preview storage and exact reference strings survive TOML round-trip; empty presentation collections are omitted.
- Reviewed the clean-cutover callsites and found no compatibility shim, obsolete path, or unresolved issue.
