# P4 Task 1 Report

## Status

Complete. `VaultIndex::reference_issues` now projects the six specified issue kinds from current page/link/block index truth with deterministic ordering, filtering-before-pagination, stable versioned fingerprints, candidate evidence, source revisions, and encrypted-body privacy.

## RED evidence

Command:

```text
cargo test --lib vault::reference_issues::tests -- --nocapture
```

Observed failure before implementation (exit 101): Rust could not find `ReferenceIssueFilter`, `ReferenceIssueKind`, `ReferenceIssueAction`, or `VaultIndex::reference_issues`. This was the expected missing-projection failure.

## GREEN evidence

All requested focused commands passed:

```text
cargo test --lib vault::reference_issues::tests -- --nocapture
8 passed; 0 failed

cargo test --test block_ref_resolution_test -- --nocapture
1 passed; 0 failed

cargo test --test property_patch -- --nocapture
8 passed; 0 failed
```

No formatter, lint, build-only command, broad gate, or full suite was run, per task scope.

## Files

- `src/vault/reference_issues.rs` — public model/filter/page types, single SQL projection, fingerprint/evidence/action derivation, and focused RED/GREEN tests.
- `src/vault/index.rs` — `VaultIndex::reference_issues` delegation.
- `src/vault/mod.rs` — module export.
- `.superpowers/sdd/2026-08-11-reference-repair-center/task-1-report.md` — this evidence report.
- `tests/block_ref_resolution_test.rs` and `tests/property_patch.rs` were exercised unchanged.

## Commit

Implementation: `fb6cfcf` (`feat(index): project typed reference repair issues`).

## Concerns

- Candidate ranking is deterministic by canonical candidate path and page ID; the Task 1 filter has no disambiguation-strategy input, so strategy-specific ranking is intentionally not introduced.
- `ReferenceIssueAction::None` is part of the required model but is not emitted: every projected issue has an indexed source and therefore supports `OpenSource`; non-automatic issues use that navigation-only action.
