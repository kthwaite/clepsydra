# Task 3 Report: UUID Update and Server-Generated Creation

## Status

DONE

## Commit

`47b728a3197a0ef5aad981fab10433e1d910fa28` — `feat(api): add mobile page operations`

## Files changed

- `src/api/pages.rs`
- `src/api/openapi.rs`
- `src/vault/new_note.rs`
- `tests/api_test.rs`
- `ui/src/api/schema.d.ts`

## TDD evidence

### RED: UUID update route absent

Command:

```text
cargo test --test api_test page_update_by_id
```

Observed:

```text
running 3 tests
page_update_by_id_follows_indexed_identity_after_move ... FAILED (expected 200, received 405)
page_update_by_id_returns_not_found_for_missing_uuid ... FAILED (expected 404, received 405)
page_update_by_id_rejects_stale_revision_without_changing_file ... FAILED (expected 409, received 405)
test result: FAILED. 0 passed; 3 failed; 102 filtered out
```

### RED: collection creation route absent

Command:

```text
cargo test --test api_test create_default_page
```

Observed:

```text
running 2 tests
create_default_page_uses_server_path_trimmed_title_and_one_clock_read ... FAILED (expected 201, received 405)
create_default_page_rejects_blank_titles_without_creating_markdown ... FAILED (expected 400, received 405)
test result: FAILED. 0 passed; 2 failed; 103 filtered out
```

### RED: OpenAPI operations absent

Command:

```text
cargo test api::openapi::tests::openapi_documents_mobile_page_operations
```

Observed:

```text
running 1 test
api::openapi::tests::openapi_documents_mobile_page_operations ... FAILED
assertion failed: collection.get("post").is_some()
test result: FAILED. 0 passed; 1 failed; 331 filtered out
```

### GREEN: focused endpoint and OpenAPI cycles

Commands and observed results:

```text
cargo test --test api_test page_update_by_id
cargo test: 3 passed (1 suite, 102 filtered, 0.10s)

cargo test --test api_test create_default_page
cargo test: 2 passed (1 suite, 103 filtered, 0.06s)

cargo test api::openapi::tests::openapi_documents_mobile_page_operations
cargo test: 1 passed (37 suites, 841 filtered, 0.00s)
```

The first post-implementation collection run exposed a test-fixture assumption rather than an endpoint defect: `init_vault` defaults `default_page_folder` to the vault root, while the requirement's canonical example expects `notes/`. The focused test was corrected to configure `default_page_folder = "notes"`; the endpoint continued to consume the real vault configuration through `new_note::build_note_path`.

## Implementation and self-review

- The path handler now performs request-path validation and delegates to one `update_page_at_path` implementation.
- GET and PUT by UUID share an indexed UUID-to-path resolver. The resolver uses the `pages.id` stable identity and validates the stored value with `parse_internal_path` before filesystem access.
- UUID updates therefore share revision comparison, `MutationCoordinator::update_page`, race handling, notification mapping, and exact `page_detail(Page)` response mapping with path updates.
- `build_note_path` is `pub(crate)` and remains the sole default-folder, timestamped-filename, slug, short-ID, and canonical `VaultPath` policy used by CLI and API creation.
- Collection creation trims the title and rejects empty/whitespace-only titles before reading the clock or mutating the vault.
- A counting fixed clock test confirms exactly one `state.clock.now()` call; that timestamp is assigned to both `created_at` and `updated_at` and drives the canonical filename date.
- Collection creation uses `MutationCoordinator::create_page`, emits the established index-change notification, and returns `201` with `page_detail(result)`. The test compares the response with a subsequent path GET, including the exact revision.
- Blank-title tests cover both empty and whitespace-only strings and assert the vault Markdown file count does not change.
- OpenAPI tests assert GET+POST on `/api/vault/pages`, GET+PUT on `/api/vault/pages/by-id/{uuid}`, and registration of `CreateDefaultPageRequest`.
- No duplicate update implementation or canonical path policy was introduced.

## Generated schema procedure

1. Created `/tmp/clepsydra-task3-openapi.1ehv42`.
2. Initialized a real vault:

   ```text
   cargo run --bin clep -- init /tmp/clepsydra-task3-openapi.1ehv42
   Initialized vault at /tmp/clepsydra-task3-openapi.1ehv42
   ```

3. Wrote a temporary root `config.toml` pointing `[vault].root` to that vault and binding `[server]` to `127.0.0.1:3000`.
4. Started the feature-worktree `target/debug/clep serve` and observed readiness on `127.0.0.1:3000`.
5. From `ui/`, ran:

   ```text
   NODE_OPTIONS=--dns-result-order=ipv4first bun run openapi
   $ openapi-typescript http://localhost:3000/api/openapi.json -o src/api/schema.d.ts
   ✨ openapi-typescript 7.13.0
   🚀 http://localhost:3000/api/openapi.json → src/api/schema.d.ts [90.4ms]
   ```

6. Stopped the temporary server.
7. Confirmed the generated schema contains `post: operations["create_default_page"]`, `put: operations["update_page_by_id"]`, and `CreateDefaultPageRequest` with required `title` and optional `body`.

## Final focused verification

```text
cargo test --test api_test page_update_by_id
cargo test: 3 passed (1 suite, 102 filtered, 0.06s)

cargo test --test api_test create_default_page
cargo test: 2 passed (1 suite, 103 filtered, 0.03s)

cargo test api::openapi::tests
cargo test: 6 passed (37 suites, 836 filtered, 0.00s)

cargo test vault::new_note::tests
cargo test: 7 passed (37 suites, 835 filtered, 0.00s)

cd ui && bun run typecheck
$ tsc --noEmit --project tsconfig.app.json
(exit 0)
```

No project-wide suite or lint command was run, per the Task 3 brief.

## Concerns

None.

## Review fix round 1

### Finding addressed

UUID GET/PUT previously released the index lookup before touching or locking the resolved path. A move in that interval could make the candidate disappear or point at a different page, producing a spurious 404 or risking wrong-identity access.

### RED evidence

Deterministic GET interleaving:

```text
cargo test --test api_test page_by_id_get_retries_relocation_between_lookup_and_access
running 1 test
page_by_id_get_retries_relocation_between_lookup_and_access ... FAILED
request completed instead of waiting for the held candidate-path lock
test result: FAILED. 0 passed; 1 failed; 106 filtered out
```

Deterministic PUT interleaving:

```text
cargo test --test api_test page_update_by_id_retries_relocation_between_lookup_and_update
running 1 test
page_update_by_id_retries_relocation_between_lookup_and_update ... FAILED
assertion `left == right` failed
  left: 404
 right: 200
test result: FAILED. 0 passed; 1 failed; 106 filtered out
```

Both tests acquire the old candidate's coordinator path guard, manually poll the in-process router request, and use a serialized index-thread sentinel to prove the UUID lookup completed. They then move the page before releasing the guard. No sleep, scheduling guess, or unbounded wait controls the interleaving.

### Fix and self-review

- GET-by-ID performs bounded UUID-to-path resolution (maximum eight attempts), acquires the candidate coordinator path guard, and rechecks the indexed identity/path before reading.
- Missing files and page-ID mismatches are re-resolved. A changed indexed path retries; a stable missing path remains 404; a stable identity mismatch is an internal invariant error.
- PUT-by-ID retains the one shared `update_page_at_path` implementation. Its UUID wrapper retries only relocation-shaped 404 attempts after proving the indexed UUID now points elsewhere.
- The shared update attempt validates the file's page UUID before mutation. If the coordinator CAS finds replacement content, it distinguishes a true same-UUID stale revision (structured 409) from a different-UUID relocation/replacement (retry).
- Retries are bounded; repeated relocation churn returns a documented 500-class internal error rather than looping indefinitely.
- Path-based update behavior remains on the same shared helper with UUID validation disabled, preserving its existing revision contract.

### GREEN evidence

```text
cargo test --test api_test page_by_id_get_retries_relocation_between_lookup_and_access
cargo test: 1 passed (1 suite, 106 filtered, 0.07s)

cargo test --test api_test page_update_by_id_retries_relocation_between_lookup_and_update
cargo test: 1 passed (1 suite, 106 filtered, 0.06s)

cargo test --test api_test page_update_by_id
cargo test: 4 passed (1 suite, 103 filtered, 0.07s)

cargo test --test api_test page_by_id
cargo test: 2 passed (1 suite, 105 filtered, 0.03s)
```

OpenAPI was not touched, so its generation and tests were not rerun in this review round.

### Fix commit

`bd734c24c0395d64a651f774d75803dcbd391cdc` — `fix(api): stabilize page operations by UUID`

### Concerns

None.

## Review fix round 2

### Finding addressed

`move_page` now participates in the same source/destination `MutationCoordinator` locks as UUID updates. Validation, planner execution, index publication, notification, and moved-page response read remain inside the lock scope, preventing a move from interleaving with update publication.

### RED evidence

Before the lock change, the deterministic publish seam allowed the move to complete while UUID update publication was paused:

```text
cargo test --test api_test page_move_waits_for_uuid_update_publish_and_preserves_single_identity -- --exact --nocapture
running 1 test
page_move_waits_for_uuid_update_publish_and_preserves_single_identity ... FAILED
assertion failed: move completed while UUID update was paused before publication
```

### GREEN evidence

```text
cargo test --test api_test page_move_waits_for_uuid_update_publish_and_preserves_single_identity -- --exact --nocapture
cargo test: 1 passed (1 suite, 107 filtered, 0.11s)

cargo test --test api_test move_page -- --nocapture
cargo test: 3 passed (1 suite, 105 filtered, 0.08s)

cargo test --test api_test page_by_id -- --nocapture
cargo test: 2 passed (1 suite, 106 filtered, 0.05s)

cargo test --test api_test page_update_by_id -- --nocapture
cargo test: 4 passed (1 suite, 104 filtered, 0.08s)
```

The page-by-ID tests now explicitly cover move-lock serialization (`page_by_id_waits_for_move_lock_before_access` and `page_update_by_id_waits_for_move_lock_before_update`): move remains pending while the candidate lock is held, then UUID access/update completes coherently. The earlier bounded relocation-retry tests passed before this fix; this round removes the race by serializing the move rather than relying on retry. No sleeps or scheduling assumptions are used.

### Fix and self-review

- Existence and destination collision checks, `MutationPlanner` execution, index publication, notification, and response read all occur while the guard is held.
- The regression pauses UUID update immediately before filesystem publication, starts a move, verifies the move remains pending, releases the update, and asserts exactly one Markdown file retains the UUID.
- Existing bounded UUID relocation handling and the shared update implementation remain unchanged.

### Fix commit

`db78150` — `fix(api): serialize page moves with updates`

### Concerns

None.

## Review fix round 2 follow-up: preserve relocation retries

### Finding addressed

The first move-serialization revision replaced the true move-between-lookup-and-use regressions with tests that serialized the move behind an already-held candidate lock and asserted the old path. Separate deterministic tests now preserve both contracts:

1. move waits while an update is between CAS read and publication; and
2. when a move wins after UUID lookup but before GET access or PUT update begins, bounded UUID resolution retries the moved path.

### RED evidence

The restored relocation tests were written against a post-index-lookup synchronization seam:

```text
cargo test --test api_test page_by_id_get_retries_relocation_between_lookup_and_access
error[E0599]: no method named `set_after_page_id_lookup_hook` found for struct `MutationCoordinator`
error: could not compile `clepsydra` (test "api_test") due to 4 previous errors
```

The initial observer implementation then exposed a lock-lifetime deadlock: the callback waited while still retaining the hook mutex. The focused GET test deterministically hung at:

```text
test page_by_id_get_retries_relocation_between_lookup_and_access has been running for over 60 seconds
```

The observer now clones the callback into a local before invoking it, releasing the configuration mutex before the synchronization callback blocks.

### Fix and self-review

- Added a per-coordinator post-UUID-lookup observer used only as a deterministic synchronization seam.
- GET and PUT invoke the observer immediately after each indexed UUID lookup and before candidate locking/use.
- New multi-threaded tests pause at that exact point, execute the source/destination-locked move through the in-process router and serialized index actor, clear the observer, then release the request.
- GET must return the moved path and same UUID/body.
- PUT must update the moved path, return its exact revision, match a subsequent GET-by-ID, and continue returning the structured revision conflict for the stale pre-move revision.
- The existing candidate-lock serialization tests and the pre-publication move-wait/single-identity regression remain separate and green.
- No sleeps or unbounded waits control the interleavings; channel events and one explicit router poll plus an index-actor sentinel establish ordering. Two-second channel timeouts are failure bounds only.

### GREEN evidence

```text
cargo test --test api_test page_by_id_get_retries_relocation_between_lookup_and_access
cargo test: 1 passed (1 suite, 109 filtered, 0.07s)

cargo test --test api_test page_update_by_id_retries_relocation_between_lookup_and_update
cargo test: 1 passed (1 suite, 109 filtered, 0.05s)

cargo test --test api_test page_by_id_get_waits_for_move_lock_before_access
cargo test: 1 passed (1 suite, 109 filtered, 0.03s)

cargo test --test api_test page_update_by_id_waits_for_move_lock_before_update
cargo test: 1 passed (1 suite, 109 filtered, 0.04s)

cargo test --test api_test page_move_waits_for_uuid_update_publish_and_preserves_single_identity
cargo test: 1 passed (1 suite, 109 filtered, 0.04s)

cargo test --test api_test page_update_by_id
cargo test: 5 passed (1 suite, 105 filtered, 0.09s)

cargo test --test api_test page_by_id
cargo test: 3 passed (1 suite, 107 filtered, 0.04s)

cargo test vault::mutation_coordinator::tests
cargo test: 3 passed (37 suites, 844 filtered, 0.00s)
```

### Fix commit

`40ff4e0` contains the backend relocation seam and tests. Because another worker committed its concurrently staged iOS completion in the shared worktree after the backend files were staged, the backend changes landed in that existing `fix(ios): complete connected vault shell` commit. The iOS commit was not rewritten or amended.

### Concerns

No behavioral concerns. Commit `40ff4e0` contains both the concurrent iOS completion and this backend follow-up due shared-index staging.
