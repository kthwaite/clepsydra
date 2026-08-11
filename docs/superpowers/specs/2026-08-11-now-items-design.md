# Clepsydra “Now” Program Design

**Date:** 2026-08-11  
**Status:** Approved design, pending written-spec review  
**Source:** `docs/design-notes/2026-08-11-pkm-feature-comparison.md`, “Now” recommendations

## Objective

Deliver the five immediate improvements identified by the PKM comparison without weakening Clepsydra’s file-first ownership, end-to-end encryption boundary, or mutation-safety guarantees:

1. Close cross-file atomicity holes.
2. Require explicit acknowledgement that attachments remain plaintext.
3. Render single-block references as read-only transclusions.
4. Add a unified reference-repair center with individual previewed fixes.
5. Document the complete current user-facing feature surface.

Each initiative receives a separate TDD implementation plan. The program uses a trust-first sequence so later repair actions and documentation depend on stabilized behavior.

## Program sequence

```text
P1 Atomic batch mutations
 ├─ P2 Protected attachment acknowledgement
 ├─ P3 Single-block transclusion
 └─ P4 Reference repair center
      └─ P5 Full feature documentation inventory
```

P2 and P3 are behaviorally independent of P1 but follow it to avoid concurrent mutation and protected-content contract changes. P4 depends on P1 because every automatic repair must use the stabilized preview/commit contract. P5 follows the behavioral initiatives so the new documentation describes final behavior.

## Shared constraints

- Markdown and TOML files remain authoritative.
- `MutationCoordinator` remains the single mutation authority; the program does not create a competing executor.
- Encrypted page bodies remain opaque to the server.
- Protected pages do not expose body-derived block structure through the index.
- Attachments remain plaintext in this program.
- Transclusion is read-only and limited to one referenced block.
- Repairs apply one issue at a time.
- Documentation covers shipped behavior only.

## P1 — Atomic batch mutations

### Problem

Clepsydra has strong single-path coordination and mutation planning, but some multi-file operations can publish a subset before a later write fails. Board-cycle seal-with-carryover explicitly has this risk. `MutationPlan::execute` also performs file operations before staged backlink writes and relies on rebuild/reconciliation rather than an all-or-none filesystem contract.

Relevant current surfaces include:

- `src/vault/mutation.rs`
- `src/vault/mutation_coordinator.rs`
- `src/vault/rewriter.rs`
- `src/api/board/cycles.rs`

### Scope

Audit every multi-file mutation. Each is classified as:

1. already satisfying the new batch contract,
2. migrated to the batch coordinator, or
3. outside the contract with an explicit reason and test proving its isolation.

Known starting points are mutation-plan backlink rewrites, board-cycle carryover, bulk page assignment, folder moves, archive/CAS compensation, and academic import/provenance updates. The audit is not limited to this initial list.

### Batch command

Extend `MutationCoordinator` with a transport-independent batch command. Each path mutation declares:

- normalized affected path,
- expected pre-state or revision,
- final bytes or move/delete intent,
- rollback state,
- corresponding index event.

The serializable `MutationPlan` remains the user-facing preview representation. Planning and execution must use the same normalized intents so the committed operation cannot diverge from its preview.

### Execution flow

1. Plan all affected paths and final bytes.
2. Acquire normalized vault-path locks in deterministic lexical order.
3. Re-read and validate every expected revision and path precondition while holding the locks.
4. Create `.clepsydra/transactions/<transaction-id>/`.
5. Persist the transaction manifest, staged outputs, and exact rollback bytes/path state.
6. Flush the prepared transaction state durably.
7. Mark the transaction `committing` and publish the filesystem changes.
8. On runtime failure, restore every published path to its exact pre-mutation state.
9. After successful filesystem publication, mark the transaction `filesystem_committed`.
10. Reconcile the index once and emit one logical change notification.
11. Remove the transaction artifacts after durable completion.

### Recovery

Vault startup runs transaction recovery before indexing or serving requests:

- `prepared`: remove unpublished staged state and restore any unexpectedly changed path.
- `committing`: use the manifest and observed path states to complete rollback to the declared pre-state.
- `filesystem_committed`: reconcile the index to the committed files, then remove transaction artifacts. Startup recovery does not emit SSE because no pre-restart client remains connected.

Recovery is idempotent. A second interruption during recovery can be recovered again.

### Atomicity definition

A completed API operation and a completed startup recovery never leave a mixed logical mutation. Clepsydra does not claim operating-system-level simultaneous rename of multiple files. A process that bypasses Clepsydra and reads the vault during the short commit window may observe intermediate filesystem state.

Index events and SSE notifications are emitted only after all filesystem publications succeed. Failure and rollback do not emit a successful mutation event.

### Error behavior

Errors remain typed and identify:

- stale precondition,
- preparation failure,
- publication failure,
- rollback failure,
- recovery failure,
- index reconciliation failure after committed filesystem state.

A rollback or recovery failure retains the transaction directory and reports its path for deterministic retry. It is never silently converted to a successful response.

### Verification contract

Tests cover:

- stale revision after waiting for locks,
- failure injection at every publication boundary,
- rollback failure,
- cancellation during prepare and commit,
- restart with `prepared`, `committing`, and `committed` manifests,
- repeated recovery,
- concurrent overlapping batches requested in opposite path orders,
- absence of early index/SSE events,
- preview/commit intent equivalence,
- board-cycle carryover all-or-none behavior.

Smoke verification seals a cycle with multiple carried tasks, observes the cycle and every task updated, then exercises an injected failure and confirms that none of them changed.

## P2 — Protected attachment acknowledgement

### Problem

Attachment bytes, filenames, paths, MIME types, and sizes are plaintext even when referenced from an encrypted note. The current UI warns about this, but the warning is not tied to each risky action.

### Scope decision

This program does not encrypt attachments, migrate existing files, rotate attachment keys, or claim that acknowledgement creates a confidentiality boundary. It makes the plaintext boundary explicit at upload and protected-note insertion time.

### API contract

Every attachment upload requires a `plaintext_acknowledged: true` multipart field. The API rejects an absent or false acknowledgement with a typed client error. This is enforceable because all uploaded attachment bytes pass through the attachment endpoint.

Attachments are globally stored rather than owned by a page. The server therefore cannot prove which page will reference an upload. The API acknowledgement applies to plaintext storage generally, not only protected pages.

### Protected-editor contract

From a protected page editor:

- uploading files opens a per-action confirmation naming the files,
- inserting an existing attachment also opens a per-action confirmation,
- the disclosure states that attachment bytes and identifying metadata are not encrypted,
- cancelling leaves the document and attachment store unchanged,
- acknowledgement expires when the pending action completes or is cancelled,
- there is no persistent “never warn again” setting.

An unprotected context may present the same disclosure inline with the upload action rather than in a modal.

### Existing attachments

A protected page containing attachment references shows a persistent warning and an audit list of the references visible to the decrypted client. The client does not send that list to a new server-side audit service.

### Enforcement limitation

A custom client can construct arbitrary encrypted page ciphertext. The server cannot inspect that ciphertext to detect a newly inserted attachment link without breaking the end-to-end encryption model. Upload acknowledgement is server-enforced; linking already-uploaded content inside ciphertext is client-enforced and documented as such.

### Verification contract

Tests cover:

- upload rejection without acknowledgement,
- upload acceptance with acknowledgement,
- cancelled protected-editor confirmation,
- no acknowledgement reuse across actions,
- insertion of an existing attachment,
- existing-reference audit warnings,
- unprotected and protected upload flows,
- exact disclosure of the plaintext metadata boundary.

Smoke verification protects a note, cancels an attachment insertion and observes no change, then acknowledges the action, inserts the attachment, reloads the note, and observes the persistent warning.

## P3 — Single-block transclusion

### Problem

Clepsydra parses, indexes, completes, serializes, and navigates `((block-id))` references, but the Slate element currently renders a navigable identifier token rather than the referenced block content. Read-only Markdown rendering does not provide equivalent transclusion behavior.

Relevant current surfaces include:

- `ui/src/api/blocks.ts`
- `ui/src/editor/elements/BlockRefElement.tsx`
- `ui/src/editor/convert/mdast-to-slate.ts`
- `ui/src/editor/convert/slate-to-mdast.ts`
- `ui/src/components/MarkdownRenderer.tsx`
- `src/api/blocks.rs`

### Shared presentation

Add one `BlockTransclusion` presentation component used by both Slate and read-only Markdown rendering. It accepts a block ID, retrieves the existing block projection, and renders equivalent states in both contexts.

### Rendering contract

- Render only the referenced block’s content.
- Do not include descendant blocks.
- Do not recursively expand nested block references.
- Nested `((...))` tokens render as inert reference tokens and may navigate when activated.
- Inside Slate, the transclusion is `contentEditable={false}` and cannot be edited as if it were local content.
- Activating the transclusion opens the source page at the referenced source span/block.
- Source edits refresh the transclusion through existing query invalidation and vault events.
- Serialization remains exactly `((block-id))`; rendered content is never copied into the referencing Markdown file.

### States and privacy

The component exposes accessible loading, resolved, and unavailable states. Protected pages suppress body-derived block indexing, so a protected target is not distinguishable from an unknown block ID. The user-facing state is “Referenced block unavailable”; it never confirms that a protected block exists.

No API or index change may expose protected block content or block identity solely to improve the error message.

### Error behavior

- Network/loading failure preserves the reference and offers retry.
- Missing or unavailable ID preserves the token and source document.
- A source page removed after resolution transitions to unavailable without modifying the reference.
- Unsupported block content falls back to safe textual rendering rather than raw HTML.

### Verification contract

Tests cover:

- resolved content rendering in Slate and `MarkdownRenderer`,
- single-block boundary,
- nested-reference non-expansion,
- source navigation,
- loading, retry, and unavailable states,
- Slate `contentEditable` boundary,
- Markdown-to-Slate-to-Markdown round-trip,
- source-update refresh,
- protected-content non-disclosure.

Smoke verification creates a source block, references it from another page, confirms rendering in edit and read-only contexts, edits the source, and observes refreshed content without changing the referencing file.

## P4 — Reference repair center

### Problem

The backend and LSP expose unresolved links, ambiguity candidates, create-from-link, mutation previews, graph isolation, and reference diagnostics, but the web application lacks a consolidated repair workflow.

### Issue projection

Add a paginated `/api/vault/index/issues` projection with these issue kinds:

- `unresolved_page_link`
- `ambiguous_page_link`
- `broken_block_ref`
- `invalid_relation_target`
- `orphan_page`
- `isolated_page`

Each issue includes:

- a stable fingerprint derived from issue kind, source identity/span, and target,
- source page/path/title,
- line and column span where available,
- a safe source snippet with encrypted bodies excluded,
- unresolved target or invalid value,
- ranked candidates and rationale where available,
- available actions: `create`, `replace`, `open_source`, or `none`,
- current source revision for stale-write protection.

The endpoint supports pagination and filtering by issue kind, project, page kind, and actionability. Ordering is deterministic.

Existing focused APIs remain available where they provide useful external contracts. The web repair workspace consumes the unified projection.

### Fix contract

1. The user selects one issue.
2. The detail view displays source context, candidate rationale, and available actions.
3. `Open source` is available whenever the source exists.
4. An automatic action requests a mutation preview.
5. Apply sends the issue fingerprint, selected action/replacement, and expected revisions.
6. P1 executes the resulting one-issue batch.
7. A stale issue fingerprint or revision returns `409` and refreshes the issue rather than editing moved text.
8. Index invalidation removes or updates the issue after commit.

Issue-specific actions:

- unresolved page link: create a target or replace it with a selected ranked candidate,
- ambiguous page link: replace with an explicit path- or alias-qualified target,
- broken block ref: navigate; replace only when the backend has one unambiguous candidate,
- invalid relation target: open the property editor; replace when a valid candidate is selected,
- orphan/isolated page: explain and navigate only.

Bulk selection and bulk apply are excluded.

### Workspace

Replace the narrow link-miss workspace with `/repairs` and update all internal callers. Add command-palette and dashboard entry points.

Desktop uses a filterable issue table with a detail panel. Mobile uses an issue list with a detail dialog. Controls use React Aria. Keyboard navigation, focus restoration after apply, and live status for refresh/apply are required. Rows are not optimistically removed before the index confirms the repair.

### Error behavior

- `409`: source or issue changed; retain selection where possible and refresh.
- unavailable candidate: disable apply and explain the reason.
- failed mutation: preserve the row and preview details.
- encrypted source: omit snippet and automatic body-edit actions.
- partial backend support for an issue class: show navigation-only behavior, never a fake repair action.

### Verification contract

Tests cover:

- classification of every issue kind,
- encrypted-page exclusion/non-disclosure,
- stable fingerprints,
- pagination and filter precedence,
- candidate/action derivation,
- preview/apply equivalence,
- stale-source rejection,
- workspace rendering and keyboard flow,
- focus restoration,
- issue removal only after index invalidation.

End-to-end smoke creates unresolved and ambiguous links, repairs each individually, and confirms that both the index and workspace remove the repaired issues.

## P5 — Full feature documentation inventory

### Problem

The shipped product surface is broader than the in-app guide registry. Tasks, journals, board workflows, feeds, encryption, graph/repair, archive/attachments, academic annotation, and other user-visible domains are under-documented or undiscoverable.

### Inventory contract

The implementation plan begins with a checked inventory of:

- generated application routes,
- sidebar, dashboard, and workspace navigation,
- command-palette entries,
- OpenAPI tags and CLI commands,
- MCP, LSP, and browser-extension surfaces,
- settings and security workflows.

Every user-facing surface receives exactly one disposition:

1. documented by an in-app guide,
2. covered by generated API/CLI reference,
3. intentionally internal with a written rationale.

The inventory table is maintained in the implementation plan/design evidence, not encoded as brittle tests over prose.

### Information architecture

The guide registry is reorganized around:

1. Start
2. Pages and authoring
3. Links, search, graph, and repair
4. Tasks, agenda, journals, and board
5. Bases and structured views
6. Academic library and reading
7. Feeds, browser capture, archives, and attachments
8. Encryption and protected-data boundaries
9. AI/Codex and conversation capture
10. Integrations: LSP, MCP, and browser extension
11. Configuration, CLI/API reference, and troubleshooting

Existing guides remain where accurate. They are split only when task focus or navigation clarity requires it.

### Guide content contract

Every workflow guide includes:

- purpose and prerequisites,
- canonical UI and command entry points,
- primary workflow,
- failure and conflict behavior,
- data-on-disk effects,
- privacy/encryption boundary where relevant,
- related guides and reference links.

The attachment guide states the plaintext boundary and acknowledgement behavior. The transclusion guide states the single-block, non-recursive contract. Repair documentation describes individual previewed fixes only. The documentation does not promise “Next” or “Later” work.

### Verification contract

Automated checks defend behavior rather than prose text:

- registry slugs and group IDs are unique,
- every registered guide route loads,
- every guide participates in search,
- neighbor navigation remains valid,
- internal documentation links resolve,
- docs navigation, search, headings, and mobile drawer meet accessibility expectations.

Browser smoke follows one representative workflow from every information-architecture group.

## Cross-plan testing and release gates

Each plan follows test-driven development for new observable contracts. After each initiative:

- run its specific unit/integration tests,
- run a real smoke scenario for the changed workflow,
- run repository typecheck, lint, and full test suite,
- review the change before integration.

After P5, run one program-level regression pass covering:

1. cycle carryover batch commit,
2. protected attachment acknowledgement,
3. block transclusion refresh,
4. individual reference repair,
5. navigation to the corresponding guide.

## Explicit non-goals

- Encrypted attachment storage, attachment key rotation, or attachment migration
- Recursive, subtree, or editable transclusion
- Bulk repair application
- Plugin or publication systems
- Collaboration or CRDT behavior
- Replacing Markdown ownership, SQLite projections, or `MutationCoordinator`
- Documentation of speculative roadmap work

## Plan artifacts

After written-spec approval, create five plans:

- `docs/superpowers/plans/2026-08-11-atomic-batch-mutations.md`
- `docs/superpowers/plans/2026-08-11-protected-attachment-acknowledgement.md`
- `docs/superpowers/plans/2026-08-11-single-block-transclusion.md`
- `docs/superpowers/plans/2026-08-11-reference-repair-center.md`
- `docs/superpowers/plans/2026-08-11-feature-documentation-inventory.md`

Each plan must name exact files and symbols after a fresh implementation-time audit, define observable failing tests before production changes, include task-local smoke verification, and end with the repository typecheck, lint, and full-suite gates.
