# Base Member Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Concentrate Base member source selection, request construction, conflict recovery, error formatting, and diagnostics behind one member-creation session module.

**Architecture:** `member-creation.ts` resolves definition-backed or evaluation-backed sessions and exposes one `submit` operation with typed outcomes. `useBaseTableController` retains stale/query/placement behavior around the session. `BaseMemberIntake` retains modal/page placement and gains shared conflict refresh.

**Tech Stack:** TypeScript, React 19, TanStack Query, generated OpenAPI types, Vitest, Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-08-26-base-member-creation-design.md`

## Global Constraints

- Preserve generated API schemas, endpoints, and mutation cache invalidation.
- Preserve exact standalone and embedded placement, stale-operation, query refresh, notice, and focus behavior.
- Preserve authored draft text and title-template behavior; trim title only when building the request.
- Omit only `null` and `undefined` fields; retain empty arrays, empty strings, `false`, and `0`.
- Embedded sessions use evaluator-owned revision/capability and include the embed filter.
- Definition sessions use detail-owned revision/capability and omit the embed filter.
- Global conflict handling refreshes detail, preserves the draft, and resubmits with the refreshed revision.
- Global success still closes the modal and opens the created page; it gains no table placement behavior.
- No public hook, compatibility wrapper, or competing embedded creation seam.
- Follow strict RED-GREEN TDD. Every production edit follows an observed test failure caused by missing behavior.

---

## File structure

- Create `ui/src/components/bases/member-creation.ts`: private session resolver, request policy, submission outcomes, conflict recovery.
- Create `ui/src/components/bases/__tests__/member-creation.test.ts`: exhaustive pure session contract.
- Modify `ui/src/components/bases/useBaseTableController.ts`: consume sessions; retain placement and lifecycle implementation.
- Modify `ui/src/components/bases/__tests__/useBaseTableController.test.tsx`: session-source and lifecycle adapter contracts.
- Modify `ui/src/components/bases/__tests__/BaseTable.test.tsx`: retained standalone user behavior and request boundary.
- Modify `ui/src/components/bases/BaseMemberIntake.tsx`: consume definition session and conflict refresh.
- Create `ui/src/components/bases/__tests__/BaseMemberIntake.test.tsx`: dedicated global intake behavior.
- Modify `ui/src/components/codex/__tests__/InscribeModal.test.tsx` only if the real test path requires explicit close/open integration coverage.

---

### Task 1: Deep member-creation session module

**Files:**
- Create: `ui/src/components/bases/member-creation.ts`
- Create: `ui/src/components/bases/__tests__/member-creation.test.ts`

**Interfaces:**
- Consumes: `BaseDetailResponse`, `BaseViewEvaluateResponse`, `BaseFilter`, `BaseMemberCapability`, `BaseMemberCreateRequest`, `BaseMemberCreateResponse`, `BaseMemberDiagnostic`, `decodeBaseMemberDiagnostics`, `formatApiError`, `isApiError`, and `BaseMemberDraftValue`.
- Produces:

```ts
export type MemberCreationSource =
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
      evaluation: BaseViewEvaluateResponse;
      embedFilter?: BaseFilter;
    };

export interface MemberCreationDependencies {
  create(
    baseSlug: string,
    request: BaseMemberCreateRequest,
  ): Promise<BaseMemberCreateResponse>;
  refreshAfterConflict(): Promise<void>;
}

export type MemberCreationOutcome =
  | { kind: "created"; member: BaseMemberCreateResponse }
  | { kind: "conflict"; message: string; diagnostics: BaseMemberDiagnostic[] }
  | { kind: "failed"; message: string; diagnostics: BaseMemberDiagnostic[] };

export interface MemberCreationSession {
  view: string;
  capability: BaseMemberCapability;
  submit(
    draft: BaseMemberDraftValue,
    dependencies: MemberCreationDependencies,
  ): Promise<MemberCreationOutcome>;
}

export function resolveMemberCreationSession(
  source: MemberCreationSource,
): MemberCreationSession | undefined;
```

The file is internal by location and direct imports. No barrel re-export.

- [ ] **Step 1: Write failing source-resolution tests**

Use literal generated-type fixtures. Pin definition fallback and case-fold matching:

```ts
it("resolves a definition session from requested view then first-view fallback", () => {
  const detail = definition({
    revision: "detail-r1",
    views: [{ name: "Reading" }],
    member_creation: [capability({ view: "reading" })],
  });

  expect(
    resolveMemberCreationSession({
      kind: "definition",
      baseSlug: "books",
      requestedView: "",
      detail,
    }),
  ).toMatchObject({ view: "Reading", capability: { view: "reading" } });
});
```

Add literal cases for requested view precedence, missing view, missing revision, missing capability, evaluation-owned revision/capability, and embedded filter capture. Missing requirements return `undefined`.

- [ ] **Step 2: Write failing submission-policy tests**

Create a session and call `submit` with spies. Assert the exact request:

```ts
expect(create).toHaveBeenCalledWith("books", {
  base_revision: "detail-r1",
  view: "Reading",
  title: "Trim me",
  fields: {
    tags: [],
    subtitle: "",
    featured: false,
    rating: 0,
  },
});
```

The input contains title `"  Trim me  "` and also `null` and `undefined` fields that are absent from the expected body. Add a separate evaluation case whose exact request includes `embed_filter` and evaluator revision.

Add outcome tests:

- created returns the exact response and calls create once;
- recognized 409 codes `base_revision_conflict` and `revision_conflict` call refresh once and return conflict;
- ordinary 409 does not refresh;
- conflict refresh rejection returns failed with the refresh error message;
- ordinary API failure returns failed;
- valid diagnostics are preserved;
- malformed diagnostics become `[]`.

- [ ] **Step 3: Run session tests RED**

```bash
bun run test -- src/components/bases/__tests__/member-creation.test.ts
```

Expected: FAIL because `member-creation.ts` and its exports do not exist.

- [ ] **Step 4: Implement the resolver and submission closure**

Use the repository's ASCII/case-fold convention rather than locale-sensitive matching. Resolve the definition view from requested value or first view. Match capabilities case-insensitively. Evaluation sessions use the supplied requested view, evaluator revision, and evaluator `member_creation`.

Build fields without allocation beyond one output object:

```ts
const fields: BaseMemberDraftValue["fields"] = {};
for (const key in draft.fields) {
  if (!Object.hasOwn(draft.fields, key)) continue;
  const value = draft.fields[key];
  if (value !== null && value !== undefined) fields[key] = value;
}
```

Create exactly once. Recognize revision conflict only when status is 409 and detail code is one of the two approved values. Decode diagnostics before refresh. On conflict-refresh failure, format the refresh error with `"Base definition could not be refreshed."`; otherwise use `"Member could not be created."`.

- [ ] **Step 5: Run session tests GREEN**

```bash
bun run test -- src/components/bases/__tests__/member-creation.test.ts
```

Expected: one file passes with every source/request/outcome case.

- [ ] **Step 6: Run typecheck, lint, and commit**

```bash
bun run typecheck
bun run lint -- src/components/bases/member-creation.ts src/components/bases/__tests__/member-creation.test.ts
git add ui/src/components/bases/member-creation.ts ui/src/components/bases/__tests__/member-creation.test.ts
git commit -m "refactor(bases): add member creation session"
```

---

### Task 2: Table controller placement adapter

**Files:**
- Modify: `ui/src/components/bases/useBaseTableController.ts`
- Modify: `ui/src/components/bases/__tests__/useBaseTableController.test.tsx`
- Modify: `ui/src/components/bases/__tests__/BaseTable.test.tsx`

**Interfaces:**
- Consumes: `resolveMemberCreationSession`, `MemberCreationSource`, and `MemberCreationOutcome` from Task 1.
- Produces: unchanged `BaseTableControllerModel` and `BaseTableView` props.

The adapter passed to `session.submit` is:

```ts
{
  create: (baseSlug, body) =>
    createMemberAsync({ params: { path: { slug: baseSlug } }, body }),
  refreshAfterConflict: async () => {
    if (mode === "embedded") {
      await refetchCurrentEmbeddedQuery(operation, operationGeneration);
    } else {
      const refreshed = await detailRefetch();
      if (refreshed.error) throw refreshed.error;
    }
  },
}
```

The actual embedded callback must preserve the controller's current return/identity checks and must not refresh a stale query.

- [ ] **Step 1: Add failing controller adapter tests**

Extend `useBaseTableController.test.tsx` to pin:

- definition source uses detail revision and case-folded capability;
- evaluation source uses current authoritative response revision/capability and embed filter;
- no submission while evaluation is loading/fetching/failed;
- null and undefined fields are absent while other falsey values remain;
- conflict refresh occurs once and draft remains open;
- conflict refresh failure reports failed outcome and preserves the draft;
- A→B→A and unmount stale suppression still discard outcomes;
- old embedded query conflict refresh follows the current generation guard.

The request assertion uses a literal body, not the shared builder.

- [ ] **Step 2: Run controller tests RED**

```bash
bun run test -- src/components/bases/__tests__/useBaseTableController.test.tsx src/components/bases/__tests__/BaseTable.test.tsx
```

Expected: at least the undefined-field and conflict-refresh-failure contracts fail against duplicated controller code. If existing behavior covers one case, retain it as a characterization test; the missing shared-session adapter assertions must fail before migration.

- [ ] **Step 3: Resolve sessions in the controller**

Build one memoized source:

- standalone only when `detail.data` exists;
- embedded only when the current evaluation is authoritative;
- use current `slug`, `activeView`, and embed filter.

Resolve the session and derive `memberCapability` from it. Keep `activeViewDefinition` and draft field composition in the controller because they feed table presentation.

Replace request construction and catch decoding with `session.submit`. Keep operation creation and generation checks around the call. Handle outcomes:

- stale: return without state changes;
- conflict/failed: set returned message and diagnostics, keep draft open, finish operation;
- created: enter the existing refreshing/resolving placement flow unchanged.

Remove controller-local `isRevisionConflict`, request-field filtering, title trimming, revision selection, and diagnostic decoding imports that become unused.

- [ ] **Step 4: Run controller and table tests GREEN**

```bash
bun run test -- src/components/bases/__tests__/member-creation.test.ts src/components/bases/__tests__/useBaseTableController.test.tsx src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx
```

Expected: source/session tests and every stale, refresh, placement, notice, and focus contract pass.

- [ ] **Step 5: Run typecheck, scoped lint, and commit**

```bash
bun run typecheck
bun run lint -- src/components/bases/member-creation.ts src/components/bases/useBaseTableController.ts src/components/bases/__tests__/member-creation.test.ts src/components/bases/__tests__/useBaseTableController.test.tsx src/components/bases/__tests__/BaseTable.test.tsx
git add ui/src/components/bases/useBaseTableController.ts ui/src/components/bases/__tests__/useBaseTableController.test.tsx ui/src/components/bases/__tests__/BaseTable.test.tsx
git commit -m "refactor(bases): adapt table member creation"
```

---

### Task 3: Global intake placement adapter

**Files:**
- Modify: `ui/src/components/bases/BaseMemberIntake.tsx`
- Create: `ui/src/components/bases/__tests__/BaseMemberIntake.test.tsx`
- Modify: `ui/src/components/codex/__tests__/InscribeModal.test.tsx` only if its existing real integration surface needs an additional assertion.

**Interfaces:**
- Consumes: definition-backed `resolveMemberCreationSession` from Task 1.
- Produces: unchanged `BaseMemberIntakeProps` and `onCreated(path, title)` placement callback.

- [ ] **Step 1: Write failing dedicated intake tests**

Mock complete `useBase`, `useCreateBaseMember`, and project responses. Render the real `BaseMemberIntake` and cover:

```ts
it("refreshes a revision conflict, preserves the draft, and resubmits with the new revision", async () => {
  // First save rejects with base_revision_conflict at revision r1.
  // detail.refetch updates the complete mock detail to revision r2.
  // The authored title and fields remain visible.
  // Second save sends r2 and calls onCreated with the response path/title.
});
```

Add cases for:

- first-view fallback and case-insensitive capability;
- exact success request and `onCreated` callback;
- ordinary diagnostics with draft preservation;
- failed conflict refresh with draft preservation;
- changing view clears prior reports and uses that view's capability/revision;
- cancel clears reports without changing authored values;
- loading and missing-Base states.

Use user-visible controls and literal request bodies. Do not assert only that mocks exist.

- [ ] **Step 2: Run intake tests RED**

```bash
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx
```

Expected: FAIL because the dedicated test file targets conflict refresh/resubmission behavior absent from current intake.

- [ ] **Step 3: Migrate BaseMemberIntake**

Resolve a definition source from current detail data, slug, and selected view. Derive active view and capability from the session. Keep view options from the definition and `composeMemberDraftFields` unchanged.

On save:

1. clear prior reports;
2. call `session.submit` with the API mutation and detail refetch;
3. on `created`, call `onCreated`;
4. on `conflict` or `failed`, preserve the mounted draft and show returned message/diagnostics.

After conflict refresh, the hook's new detail data produces a new session. Resubmission uses its revision. Keep `isPending`, blocker copy, loading, missing-Base, view change, and cancel presentation unchanged.

Remove duplicate request construction, null filtering, title trimming, error formatting, and diagnostic decoding imports.

- [ ] **Step 4: Run intake and placement tests GREEN**

```bash
bun run test -- src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/bases/__tests__/member-creation.test.ts
```

Expected: global conflict recovery, success placement callback, and existing modal behavior pass.

- [ ] **Step 5: Run typecheck, scoped lint, and commit**

```bash
bun run typecheck
bun run lint -- src/components/bases/BaseMemberIntake.tsx src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
git add ui/src/components/bases/BaseMemberIntake.tsx ui/src/components/bases/__tests__/BaseMemberIntake.test.tsx ui/src/components/codex/__tests__/InscribeModal.test.tsx
git commit -m "refactor(bases): adapt global member intake"
```

---

## Final verification

After all three reviewed tasks:

1. Run focused member-creation tests:

```bash
bun run test -- src/components/bases/__tests__/member-creation.test.ts src/components/bases/__tests__/useBaseTableController.test.tsx src/components/bases/__tests__/BaseTable.test.tsx src/components/bases/__tests__/BaseTableView.test.tsx src/components/bases/__tests__/BaseMemberIntake.test.tsx src/components/bases/__tests__/BaseMemberDraft.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
```

2. Run UI typecheck and lint:

```bash
bun run typecheck
bun run lint
```

3. Run the controlled full UI suite:

```bash
bun run test -- --maxWorkers=4
```

4. Run the application against the configured backend. Open standalone, embedded, and global member drafts. Confirm capability gating, composed fields, view selection, cancel behavior, and unchanged placement surfaces without submitting or persisting test data.

5. Review the complete branch against `docs/superpowers/specs/2026-08-26-base-member-creation-design.md`. Resolve Critical and Important findings before merge.

6. Merge `feature/base-member-creation` into `develop`, rerun typecheck, lint, and the controlled full UI suite on the merged tree, remove the worktree and branch, complete all six TSK-0103 checklist items, and move TSK-0103 to Done.

7. Verify TSK-0102, TSK-0103, and TSK-0104 are Done with complete checklists. Complete the three TSK-0101 checklist items and move the architecture epic to Done.
