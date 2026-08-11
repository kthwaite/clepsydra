# Task 5 report

## Status

Complete. Cycle closure with carryover and bulk page assignment now prepare every affected page's final bytes before publication and execute one durable batch. Publication failure or a stale/missing indexed page leaves every page unchanged and emits no partial notification.

## RED evidence

- `cargo test --test api_board_test closing_cycle_rolls_back_cycle_and_every_carried_task_on_failure -- --exact --nocapture`
  - First failed to compile because the required deterministic integration setter did not exist: `no method named set_batch_publication_fail_after`.
  - After adding the minimal hidden setter, failed behaviorally as intended: the independent-update handler returned `200 OK` instead of the injected batch publication failure's expected `500 Internal Server Error`.
- `cargo test --test api_test bulk_assign_rolls_back -- --exact --nocapture`
  - Failed as intended: the handler returned `200 OK`, moved `notes/first.md` to `quotes/first.md`, and embedded the stale second path in a per-item `failed` array instead of returning one `409 Conflict` with the first page unchanged.

## GREEN evidence

- `cargo test --test api_board_test closing_cycle_rolls_back_cycle_and_every_carried_task_on_failure -- --exact --nocapture`: 1 passed, 32 filtered out.
- `cargo test --test api_test bulk_assign_rolls_back -- --exact --nocapture`: 1 passed, 119 filtered out.
- `cargo test --test api_board_test -- --nocapture`: 33 passed.
- `cargo test --test api_test -- --nocapture`: 120 passed.
- `cargo test --lib api::pages::tests::bulk_assign -- --nocapture`: 3 passed, 859 filtered out.
- `cargo test --lib api::openapi::tests::bulk_assignment_documents_atomic_success_or_typed_error -- --exact --nocapture`: 1 passed, 861 filtered out.
- `git diff --check`: clean.

The focused integration suites reported six existing library dead-code warnings in the batch recovery/test-failpoint code; no failures were present. No formatter, linter, build, or broad test suite was run, per the task constraint.

## Files changed

- `src/api/board/cycles.rs`
- `src/api/pages.rs`
- `src/api/openapi.rs`
- `src/mcp/server.rs`
- `src/vault/batch_mutation.rs`
- `src/vault/mutation_coordinator.rs`
- `tests/api_board_test.rs`
- `tests/api_test.rs`
- `.superpowers/sdd/2026-08-11-atomic-batch-mutations/task-5-report.md`

The two vault files are the approved minimal prerequisite for the brief's integration-level publication injection: a doc-hidden, one-shot coordinator setter and a const-generic publication path whose normal `None` path compiles without injected-failure work.

## API change

`POST /api/vault/pages-assign-bulk` is now atomic. A successful `200` response contains only `moved` and `unchanged`; the former per-path `failed` array is removed. Invalid requests, missing pages, stale/destination conflicts, and internal failures return one typed `ApiError` using documented `400`, `404`, `409`, or `500` responses. The OpenAPI schema and response table pin this success-or-error contract.

## Atomic planning and publication

- Each affected cycle, task, or assignment page is read once into an owned exact-content snapshot used both to compute final frontmatter/body bytes and as the batch precondition.
- Each logical operation obtains one clock value and applies that timestamp to every changed page.
- Cycle/task writes and bulk assignment writes/moves are represented by one `BatchMutationCommand`; no page is published during planning.
- Indexed files missing during planning are stale `409` conflicts rather than skipped carryover work or partial bulk failures.
- Successful batches emit one notification. Upserted and removed paths are deduplicated and sorted; cycle carryover now emits one sorted notification for the cycle and all carried tasks.

## Commit

This report is part of commit `fix(api): commit cycle and bulk page changes atomically`; the final commit hash is reported in the task handoff because a commit cannot contain its own hash.

## Concerns

No known functional concerns. The deterministic publication setter is intentionally `#[doc(hidden)]`, defaults to no injection, consumes its pending value once, and is used only by integration coverage. Existing batch-module dead-code warnings remain unchanged in scope.

## Review fix: canonical bulk-assignment paths

### RED evidence

- `cargo test --test api_test bulk_assign_rolls_back -- --exact --nocapture` failed with `404 Not Found` instead of the required stale `409 Conflict` when the deleted indexed second page was requested as the normalizing alias `notes//second.md`.
- `cargo test --test api_test bulk_assign_reports_canonical_paths_for_normalizing_aliases -- --exact --nocapture` failed because a successful aliased relocation returned `notes//aliased.md` in `unchanged` while also returning the canonical source in `moved`.

### Fix

- `assign_bulk` now parses every requested path exactly once before index lookup or planning.
- Canonical duplicates are rejected at that normalization boundary.
- Indexed stale detection, batch planning, moved/unchanged partitioning, and response paths all consume the same canonical `VaultPath` values.

### GREEN evidence

- `cargo test --test api_test bulk_assign_rolls_back -- --exact --nocapture`: 1 passed, 120 filtered out.
- `cargo test --test api_test bulk_assign_reports_canonical_paths_for_normalizing_aliases -- --exact --nocapture`: 1 passed, 120 filtered out.
- `cargo test --lib api::pages::tests::bulk_assign -- --nocapture`: 3 passed, 859 filtered out.
- `cargo test --test api_test -- --nocapture`: 121 passed.

## Full-gate fix: MCP bulk-assignment result

### RED evidence

- `cargo test --lib mcp::server::tests::assign_bulk_reports_moves_per_path -- --nocapture` reproduced the full-gate failure: the MCP behavioral test unwrapped the removed per-path `failed` field and panicked at `src/mcp/server.rs:1885`.

### Fix

- The `vault_assign` tool description now states that multi-page assignment commits every path together and returns one error without changing any page.
- The MCP behavioral contract consumes the atomic success shape directly: `moved` plus `unchanged`, with no `failed` field or compatibility shim.

### GREEN evidence

- `cargo test --lib mcp::server::tests::assign_bulk_returns_one_atomic_success -- --exact --nocapture`: 1 passed, 870 filtered out.
- `cargo test --lib mcp::server::tests::assign_ -- --nocapture`: 4 passed, 867 filtered out.
- `cargo test --test api_test bulk_assign -- --nocapture`: 2 passed, 123 filtered out.
