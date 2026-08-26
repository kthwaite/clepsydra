# Base Member Creation Design

## Goal

Concentrate Base member-creation policy in one deep module. Standalone tables, embedded tables, and global intake use the same view/capability/revision selection, request construction, conflict recovery, and diagnostic decoding. Each entry point remains a small placement adapter.

The table path retains its query identity, stale-operation protection, refresh loops, placement notices, and created-row focus. Global intake retains modal close and created-page navigation.

## Scope

This feature will:

- add one shared member-creation session module;
- resolve active view, capability, revision, and embedded-filter request context once;
- trim titles at request construction;
- omit `null` and `undefined` fields while retaining other falsey values;
- centralize request construction and embedded request differences;
- centralize revision-conflict classification, definition refresh, API error formatting, and diagnostic decoding;
- migrate `useBaseTableController` and `BaseMemberIntake`;
- add dedicated global-intake tests;
- remove duplicated submission code after every caller migrates.

This feature will not:

- change `BaseMemberDraft` authoring or title-template behavior;
- change the generated API schema or server endpoints;
- change mutation cache invalidation;
- move table query identities, stale-operation generations, refresh loops, placement, notices, or focus into the shared module;
- add table placement behavior to global intake;
- add a competing creation path for embedded views;
- change read-only Base previews.

## Entry points

| Entry point | Session source | Placement after creation |
| --- | --- | --- |
| Standalone `BaseTable` | Base definition detail | Refresh saved view, classify inclusion, show notice, focus created row when present |
| `EmbeddedBaseTable` | Authoritative evaluator response | Refresh current evaluator query, classify inclusion, show query-scoped notice, focus created row when present |
| Global `BaseMemberIntake` | Base definition detail | Close modal and open the created page |

`BasePreview` remains read-only and does not consume member-creation state.

## Module seam

Create `ui/src/components/bases/member-creation.ts`. It is private to the Base authoring implementation and imported directly by its two production consumers.

The module consumes one source:

```ts
type MemberCreationSource =
  | {
      kind: "definition";
      baseSlug: string;
      requestedView: string;
      detail: BaseDetailResponse;
    }
  | {
      kind: "evaluation";
      baseSlug: string;
      requestedView: string;
      evaluation: BaseViewWindowResponse;
      embedFilter?: BaseFilter;
    };
```

A resolver returns a session only when the source is authoritative and supplies a non-empty active view, revision, and matching capability:

```ts
interface MemberCreationSession {
  view: string;
  capability: BaseMemberCreationCapability;
  submit(
    draft: MemberDraftSubmission,
    dependencies: MemberCreationDependencies,
  ): Promise<MemberCreationOutcome>;
}

function resolveMemberCreationSession(
  source: MemberCreationSource,
): MemberCreationSession | undefined;
```

Callers only learn the selected view, capability, and one submit operation. Revision and request-shape mechanics remain implementation knowledge.

The exact local aliases for generated response and capability types may follow current imports. There is no public hook and no compatibility wrapper around old submission code.

## Source resolution

### Definition source

The session resolves:

- active view as `requestedView`, then the first declared view name, then `""`;
- capability by case-insensitive match against the active view;
- revision from `detail.revision`;
- no embedded filter.

### Evaluation source

The caller supplies a source only when the evaluation is present, not loading, not fetching, and not failed. The session resolves:

- active view from the requested/evaluated view;
- capability from the current evaluation response;
- revision from the evaluation response;
- embedded filter from the embed configuration.

The table controller continues deciding whether an evaluation is authoritative. Missing evaluation state does not produce a session, preserving the disabled creation state during evaluator transitions.

## Draft and request policy

`MemberDraftSubmission` carries the authored title and complete field map emitted by `BaseMemberDraft`.

The session builds one `BaseMemberCreateRequest`:

- `title` is trimmed exactly once;
- `view` is the resolved active view;
- `base_revision` is the source-owned revision;
- `embed_filter` is included for evaluation-backed sessions and absent for definition-backed sessions;
- fields whose values are `null` or `undefined` are omitted;
- empty arrays, empty strings, `false`, and `0` remain explicit;
- all other values retain their identity and shape.

Draft title text is not rewritten. Local empty-title validation remains in `BaseMemberDraft` before submission.

## Submission dependencies

The session receives side-effect adapters per submission:

```ts
interface MemberCreationDependencies {
  create(
    baseSlug: string,
    request: BaseMemberCreateRequest,
  ): Promise<BaseMemberCreateResponse>;
  refreshAfterConflict(): Promise<void>;
}
```

The existing API mutation hook remains the `create` adapter. Its cache invalidation behavior is unchanged.

Table controllers pass a generation-aware conflict refresh adapter:

- standalone refreshes the current Base definition;
- embedded refreshes the current evaluator response;
- stale operation/query identities suppress or redirect refresh using existing controller rules.

Global intake passes its Base-detail refetch operation.

## Outcomes

```ts
type MemberCreationOutcome =
  | { kind: "created"; member: BaseMemberCreateResponse }
  | { kind: "conflict"; message: string; diagnostics: BaseDiagnostic[] }
  | { kind: "failed"; message: string; diagnostics: BaseDiagnostic[] };
```

Submission behavior:

1. Build the normalized request.
2. Call `create` exactly once.
3. On success, return `created`.
4. On a recognized revision conflict, decode diagnostics and attempt `refreshAfterConflict` exactly once.
5. If conflict refresh succeeds, return `conflict` with the original formatted error and diagnostics.
6. If conflict refresh fails, return `failed` with the refresh failure message and original diagnostics when available.
7. On any other API failure, return `failed` with the formatted error and decoded diagnostics.

Malformed diagnostic payloads decode to an empty list.

The module does not set React state, place rows, focus controls, close modals, or navigate.

## Standalone and embedded adapter flow

`useBaseTableController` resolves the correct session from its current authoritative source and exposes its capability to `BaseTableView`.

When saving:

1. The controller opens an operation under its existing generation guard.
2. It calls `session.submit` with the API mutation and generation-aware conflict refresh.
3. It discards stale outcomes using the existing operation identity.
4. `created` enters the existing saved-view/evaluator refresh loop, inclusion check, notice, and focus flow.
5. `conflict` preserves the draft, reports the returned message/diagnostics, and completes the operation. Resubmission resolves a session from the refreshed revision.
6. `failed` preserves the draft, reports the returned message/diagnostics, and completes the operation.

View changes, sort/limit query identity, A→B→A stale suppression, unmount cancellation, title-column omission, grouped/flat placement, and generic versus query-scoped notices remain controller implementation.

## Global intake adapter flow

`BaseMemberIntake` resolves a definition-backed session and uses its view/capability to compose the same draft fields as today.

When saving:

- `created` calls `onCreated(path, title)`; `InscribeModal` resets, closes, and opens the created page;
- `conflict` preserves the draft and displays the returned message/diagnostics after the Base-detail refetch;
- `failed` preserves the draft and displays the returned message/diagnostics;
- resubmission uses the refreshed detail revision and capability.

Cancel and modal reset behavior remain unchanged. Global intake gains no table refresh, placement notice, or created-row focus.

## Testing

### Shared module

`member-creation.test.ts` covers:

- requested-view selection and first-view fallback;
- case-insensitive capability matching;
- definition-owned and evaluation-owned revisions;
- exact standalone and embedded request bodies;
- title trimming at submission;
- omission of `null` and `undefined` fields;
- preservation of empty arrays, empty strings, `false`, and `0`;
- exactly one create call;
- created outcome;
- recognized conflict with exactly one refresh;
- conflict-refresh failure;
- ordinary API failure;
- valid and malformed diagnostic payloads.

### Table controller

Existing controller and table tests remain the placement contract:

- authoritative evaluator gating;
- standalone and embedded revisions/capabilities;
- stale operation and A→B→A suppression;
- conflict refresh and resubmission;
- old-query refresh redirection;
- grouped/flat inclusion;
- query-scoped and generic notices;
- title-column focus and omitted-title behavior;
- draft preservation and diagnostic clearing on edit.

Assertions that duplicate request-building internals move to the shared module tests. Controller tests continue asserting the request at the adapter boundary where needed to prove correct session source.

### Global intake

Add `BaseMemberIntake.test.tsx` covering:

- view/capability selection;
- initial fields and implied values;
- successful callback;
- conflict refresh, draft preservation, and resubmission with the refreshed revision;
- failed conflict refresh;
- ordinary diagnostics;
- close/reset behavior through `InscribeModal` integration.

### Verification

Run focused member-creation tests, UI typecheck, lint, and the controlled full UI suite. Browser verification opens standalone, embedded, and global drafts without persisting test data. Deterministic tests verify successful submission, conflicts, placement, and focus.

## Completion criteria

TSK-0103 is complete when one member-creation session module owns source selection, request construction, conflict recovery, error formatting, and diagnostics; table and global callers use it; duplicate submission code is deleted; all placement and stale-operation behavior remains correct; global intake refreshes revision conflicts; focused and full verification gates pass; and all three draft entry points are exercised in the running application.

After TSK-0103 completes, all three children of [[Architecture Epic — Deepen active UI modules]] are complete and TSK-0101 can close.
