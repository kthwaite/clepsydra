# Backend Refactor Design

## Objective

Remove the backend's highest-risk concurrency defects, eliminate repeated storage/index mutation choreography, and consolidate proven duplication without changing public API contracts.

The rollout uses staged commits on one feature branch. Correctness barriers land before structural refactoring so later abstractions preserve tested behavior rather than existing races.

## Scope

Included:

- block-ID read/modify/write safety;
- attachment exclusive creation and asynchronous I/O;
- task and cycle code allocation;
- board checkbox aggregation;
- blocking filesystem work in asynchronous handlers;
- vault mutation and index-policy orchestration;
- project assignment/refiling;
- archive CAS rollback reporting;
- request/internal path handling;
- integration-test fixture setup;
- typed cycle-state parsing;
- dead backend helper removal;
- page response mapping and folder authority only where behavior can be preserved explicitly.

Excluded:

- public request or response schema changes;
- unrelated frontend work;
- storage-engine replacement;
- distributed locking across multiple server processes;
- retries that conceal conflicts or stale client state.

## Invariants

1. Concurrent mutations of the same vault path cannot silently overwrite each other.
2. Creating an attachment, task, cycle, or page never replaces an existing destination.
3. A stale indexed span cannot be applied to changed page content as if it were current.
4. Notifications are published only after the intended filesystem and index state has been reached.
5. Existing HTTP statuses and response DTOs remain stable unless a currently silent race is converted to an explicit `409 Conflict`.
6. Link invalidation and reverse-dependency refresh follow one documented policy per mutation intent.
7. Cleanup failures never replace the primary failure, but they are never silently discarded.
8. Async handlers do not perform unbounded blocking filesystem work on Tokio worker threads.

## Architecture

### Existing mutation machinery

`src/vault/mutation.rs` remains the canonical planning and rewriting implementation. The refactor extends the existing concept with an asynchronous coordinator instead of creating a competing mutation framework.

### Mutation coordinator

A narrow coordinator owns cross-cutting execution concerns:

- per-vault-path serialization;
- validation immediately before mutation;
- exclusive creation or atomic replacement;
- index invalidation and reindexing;
- outgoing-link and reverse-dependency resolution;
- reconciliation hooks;
- change notification ordering;
- compensation and drift reporting.

HTTP handlers retain transport DTO parsing, request-level validation, and mapping typed mutation errors to existing API responses.

The path lock is keyed by normalized `VaultPath`. Operations touching two paths acquire keys in deterministic lexical order to avoid deadlock. The lock provides in-process serialization; exclusive filesystem primitives remain the final uniqueness barrier.

### Filesystem/index boundary

The filesystem and SQLite cannot share a transaction. Every mutation therefore follows:

1. Parse and validate the command.
2. Acquire the relevant path lock or locks.
3. Reload and validate current filesystem/index state.
4. Plan the operation.
5. Execute an exclusive creation or atomic filesystem replacement.
6. Apply the intent-specific index policy.
7. Run reconciliation hooks where required.
8. Publish change notification.
9. Release locks.

If step 6 or 7 fails after the filesystem succeeds, the coordinator reports the primary failure and records recoverable drift for startup reconciliation. It does not claim transactional rollback. Operations with safe compensation may attempt it and must report compensation failures.

## Stages

### Stage 1: correctness barriers

#### Block-ID assignment

- Serialize mutations by page path.
- Reload the file after acquiring the lock.
- Re-resolve or validate the requested block against current content rather than trusting an earlier span blindly.
- Reject changed/stale targets with `409 Conflict`.
- Atomically replace the page and reindex it before releasing the mutation boundary.
- Cover two concurrent assignments and an external-edit race.

#### Attachment creation

- Replace `exists` followed by `write` with exclusive creation.
- Stream multipart content to a unique temporary file.
- Install it without replacing an existing destination.
- Remove incomplete temporary files on failure.
- Map destination collisions to the existing conflict response.

#### Board codes

Use a durable SQLite reservation mechanism shared by tasks and cycles. Allocation is monotonic per code family and transactional. Failed creates may leave gaps; uniqueness is more important than gap-free presentation. Filesystem exclusive creation remains a second barrier against a stale index or external file.

Existing prefixes, padding, case behavior, and explicit code validation remain unchanged.

### Stage 2: query and runtime behavior

#### Board checkbox counts

Replace one `count_checks` query per task with one grouped aggregate joined or mapped by `page_id`. Preserve:

- `[0, 0]` for pages without status properties;
- `done` only for `value = 'done'`;
- total count for every `key = 'status'`, including cancelled values.

#### Async filesystem operations

Use `tokio::fs` for direct operations and `spawn_blocking` only around synchronous domain parsing that cannot be made async. Attachment bodies are streamed where supported instead of being fully buffered.

Atomicity and exclusive-create semantics take precedence over mechanical conversion to asynchronous APIs.

### Stage 3: mutation-service cutover

Migrate handlers incrementally:

1. page create and update;
2. block-ID assignment;
3. project assignment and board-task refiling;
4. task and cycle creation;
5. journal and archive mutations;
6. remaining direct route-level index choreography.

Each cutover is independently tested and committed. No compatibility wrappers remain after all callers migrate.

### Stage 4: explicit index policies

Intent-level policies replace route-authored `with_index` recipes:

- `Created` indexes and resolves outgoing links;
- `ContentChanged` invalidates affected links, indexes the page, resolves outgoing links, and refreshes reverse dependencies;
- `Moved` removes stale path state, indexes the destination, rewrites/resolves affected links, and invokes move hooks;
- `Deleted` removes indexed state and refreshes affected inbound-link resolution.

Expected unresolved content links are distinct from database/index failures. Archive ingestion may tolerate the former but not silently discard the latter.

### Stage 5: duplication cleanup

After mutation behavior passes smoke tests:

- normalize project assignment internally as `Unchanged`, `Set`, or `Clear` while retaining current wire formats;
- add separate request-path and internal-path parsers so trust-boundary error statuses do not drift;
- extract an explicit integration-test fixture builder with configurable pre-index seeding, config, hooks, and state access;
- parse cycle states through a typed enum and apply operation-specific allowed-state rules;
- remove the unused LSP location helper;
- consolidate page response mapping only when one canonical projection preserves all fields;
- make folder listing authority explicit rather than silently mixing filesystem and index records.

## Error handling

Typed mutation errors distinguish:

- invalid input;
- not found;
- destination conflict;
- stale revision/conflict;
- filesystem failure;
- index failure;
- hook failure;
- compensation failure attached to a primary error.

Handlers map these to current response statuses. New stale-revision detection maps to `409 Conflict` because retrying against fresh state is required.

Archive CAS rollback attempts every decrement, collects every failure, and preserves the original request failure as primary.

## Testing

Tests defend observable contracts rather than source structure.

Required focused coverage:

- simultaneous block-ID assignments preserve both successful mutations or return a conflict without lost updates;
- editing a page between index lookup and mutation cannot place an ID at a stale span;
- simultaneous attachment uploads yield one creation and one conflict without replacement;
- simultaneous task/cycle allocations remain unique;
- board checkbox aggregation preserves empty, todo, done, and cancelled semantics;
- mutation-policy tests cover create, content change, move, delete, reverse dependencies, hooks, and notification ordering;
- index failure after filesystem success is reported and remains recoverable by reconciliation;
- archive rollback reports cleanup failure while retaining the primary error;
- project set, clear, unchanged, and collision paths preserve endpoint behavior;
- request and internal path failures retain their respective status classes.

Every stage runs focused tests. Before merge, run the complete Rust test suite, build/typecheck gate, lint with warnings denied, and affected API smoke tests.

## Commit and merge strategy

One isolated feature branch, with commits ordered by dependency:

1. failing concurrency/query tests;
2. correctness barriers;
3. query and async-I/O improvements;
4. mutation coordinator;
5. incremental handler cutovers;
6. explicit index policies;
7. cleanup and shared test fixtures;
8. final verification fixes.

After review and all verification gates pass, merge the branch into `develop` with no deprecated paths or compatibility shims.
