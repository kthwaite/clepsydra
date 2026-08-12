# Stray Thoughts Follow-up P1 Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct Folio outbound-link presentation, remove tab pinning completely, and make desktop and mobile Gazetteer result tags apply the existing URL-backed filter.

**Architecture:** Keep the relation index complete and add one Folio-specific visible-outlink projection. Remove the tab-pin contract from workspace state and every tab UI while leaving the unrelated link-preview pin feature intact. Route every Gazetteer result-tag activation through the existing `onSelectedTagsChange` callback so route state remains authoritative.

**Tech Stack:** TypeScript, React 19, React Aria Components, Zustand, TanStack Router, Vitest, Testing Library, Bun, Vite.

## Global Constraints

- This plan implements Wave 1 only; Wave 2 starts from the merged Wave 1 result.
- `property_ref` edges remain available to index and relation-diagnostics APIs.
- Remove tab pinning as a clean cutover: no aliases, deprecated actions, migration UI, or compatibility controls.
- Link-preview windows retain their separate pinning feature under `ui/src/store/preview.ts`.
- Gazetteer URL search remains authoritative for text, tags, Kind, Project, sort, and page.
- Every interactive result tag is keyboard operable, visibly focusable, and accessibly named.
- Tests must assert observable behavior, not source text, except the existing documentation inventory test.
- Do not edit generated API schema files.

---

### Task 1: Folio-visible outbound-link projection

**Files:**
- Modify: `ui/src/api/types.ts`
- Modify: `ui/src/components/codex/folio-utils.ts`
- Modify: `ui/src/components/codex/folio-utils.test.ts`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`

**Interfaces:**
- Consumes: generated `components["schemas"]["OutlinkEntry"]` with `kind`, `target_path`, and `target_raw`.
- Produces: `OutlinkEntry` alias in `ui/src/api/types.ts` and `visibleFolioOutlinks(outlinks: readonly OutlinkEntry[] | undefined): ResolvedFolioOutlink[]` in `folio-utils.ts`.
- `ResolvedFolioOutlink` is `OutlinkEntry & { target_path: string }`.
- Visibility contract: only resolved `kind === "wiki"` or `kind === "block_ref"` entries are Folio-visible.

- [ ] **Step 1: Add failing pure projection tests**

Add fixtures to `folio-utils.test.ts` that exercise the complete kind/resolution boundary:

```ts
import type { OutlinkEntry } from "#/api/types";
import { visibleFolioOutlinks } from "./folio-utils";

const outlink = (
  kind: string,
  target_path: string | null,
): OutlinkEntry => ({
  kind,
  source_field: kind === "property_ref" ? "tags" : null,
  target_id: target_path ? "019ff000-0000-7000-8000-000000000000" : null,
  target_path,
  target_raw: target_path ?? "missing",
});

it("keeps only resolved page and block links visible in Folio", () => {
  const visible = visibleFolioOutlinks([
    outlink("property_ref", "notes/tag.md"),
    outlink("property_ref", null),
    outlink("wiki", "notes/page.md"),
    outlink("wiki", null),
    outlink("block_ref", "notes/page.md"),
  ]);

  expect(visible.map(({ kind, target_path }) => [kind, target_path])).toEqual([
    ["wiki", "notes/page.md"],
    ["block_ref", "notes/page.md"],
  ]);
});

it("returns an empty array for absent data", () => {
  expect(visibleFolioOutlinks(undefined)).toEqual([]);
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```bash
bun test --cwd ui components/codex/folio-utils.test.ts
```

Expected: FAIL because `OutlinkEntry` and `visibleFolioOutlinks` are not exported.

- [ ] **Step 3: Add the alias and minimal projection**

In `ui/src/api/types.ts`:

```ts
export type OutlinkEntry = components["schemas"]["OutlinkEntry"];
```

In `folio-utils.ts`:

```ts
import type { OutlinkEntry } from "#/api/types";

export type ResolvedFolioOutlink = OutlinkEntry & { target_path: string };

export function visibleFolioOutlinks(
  outlinks: readonly OutlinkEntry[] | undefined,
): ResolvedFolioOutlink[] {
  return (outlinks ?? []).filter(
    (link): link is ResolvedFolioOutlink =>
      (link.kind === "wiki" || link.kind === "block_ref") &&
      typeof link.target_path === "string",
  );
}
```

Do not change the backend outlinks response.

- [ ] **Step 4: Make Folio consume one projection**

In `Folio.tsx`, compute once beside the existing outlinks query result:

```ts
const visibleOutlinks = useMemo(
  () => visibleFolioOutlinks(outlinks),
  [outlinks],
);
```

Replace all three raw outbound projections:

```tsx
<KV k="Links" v={visibleOutlinks.length} />
<RTabBtn label="Links" n={visibleOutlinks.length} ... />
<LinkList
  empty="No outbound links yet."
  items={visibleOutlinks.map((link) => ({
    path: link.target_path,
    title: link.target_raw,
  }))}
/>
```

Preserve the existing title mapping if it already derives a better display title; only replace the source collection and remove the duplicated `target_path` filter.

- [ ] **Step 5: Add a Folio integration regression**

Make `useOutlinks` use a hoisted mutable query state in `Folio.test.tsx`, reset it in `beforeEach`, and add a test with five resolved `property_ref` entries plus one resolved wiki entry:

```ts
outlinksState.data = [
  ...Array.from({ length: 5 }, (_, index) => ({
    kind: "property_ref",
    source_field: "tags",
    target_id: `tag-${index}`,
    target_path: `notes/tag-${index}.md`,
    target_raw: `tag-${index}`,
  })),
  {
    kind: "wiki",
    source_field: null,
    target_id: "page-1",
    target_path: "notes/real.md",
    target_raw: "Real",
  },
];

renderFolio();
expect(screen.getByText("Links").closest("div")).toHaveTextContent("1");
await user.click(screen.getByRole("button", { name: /^Links/ }));
expect(screen.getByText("Real")).toBeVisible();
expect(screen.queryByText("tag-0")).toBeNull();
```

Use the test file's existing render helper and tab-query convention rather than introducing a second harness.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun test --cwd ui components/codex/folio-utils.test.ts components/codex/__tests__/Folio.test.tsx
```

Expected: both files PASS; the integration test proves count, badge/list source, and metadata-edge exclusion.

- [ ] **Step 7: Commit Task 1**

```bash
git add ui/src/api/types.ts ui/src/components/codex/folio-utils.ts ui/src/components/codex/folio-utils.test.ts ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.test.tsx
git commit -m "fix(folio): exclude metadata edges from Links"
```

---

### Task 2: Remove the tab-pin contract

**Files:**
- Modify: `ui/src/store/workspace.ts`
- Modify: `ui/src/store/workspace.test.ts`
- Modify: `ui/src/store/quires.ts`
- Modify: `ui/src/store/quires.test.ts`
- Modify: `ui/src/components/codex/Sheaf.tsx`
- Modify: `ui/src/components/codex/__tests__/Sheaf.test.tsx`
- Modify: `ui/src/components/codex/SheafContextMenu.tsx`
- Modify: `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/Folio.test.tsx`
- Modify: `ui/src/docs/content/codex-and-conversation-capture.mdx`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`

**Interfaces:**
- Removes: `TabDescriptor.pinned`, `WorkspaceState.togglePin`, and `orderSheafTabs`.
- Preserves: `TabDescriptor.lastActiveAt`, tab/quire array order, `closeTab`, `closeOtherTabs`, `closeQuireTabs`, `sheafSegments`, active-tab restoration, and link-preview pinning.
- New close semantics: **Close other tabs** closes every page tab except the active tab; **Close quire** closes every member and dissolves the empty quire.

- [ ] **Step 1: Replace pin-preservation tests with clean-cutover regressions**

Before implementation, update tests to state the new contract and produce type/runtime failures against current code.

In `workspace.test.ts`, test migration separately from close behavior:

```ts
it("v4 migration strips obsolete persisted pin fields", () => {
  const migrated = migrateWorkspace(
    {
      tabs: [
        {
          ...pageTab("old"),
          pinned: true,
        },
      ],
      quires: {},
      openHistory: [],
    },
    3,
  );

  expect(migrated.tabs).toHaveLength(1);
  expect(migrated.tabs?.[0]).not.toHaveProperty("pinned");
});

it("closeOtherTabs closes every tab except the requested survivor", () => {
  useWorkspaceStore.setState({
    tabs: [pageTab("old"), pageTab("active")],
    activeTabId: "active",
  });

  useWorkspaceStore.getState().closeOtherTabs("active");

  expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
    "active",
  ]);
});

it("closeQuireTabs closes every member and dissolves the quire", () => {
  useWorkspaceStore.setState({
    tabs: [pageTab("q1-a", "q1"), pageTab("q1-b", "q1"), pageTab("other")],
    activeTabId: "q1-a",
    quires: { q1: quire("q1") },
  });

  useWorkspaceStore.getState().closeQuireTabs("q1");

  expect(useWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual([
    "other",
  ]);
  expect(useWorkspaceStore.getState().quires.q1).toBeUndefined();
});
```

Replace `quires.test.ts` pin-order tests with one assertion that `sheafSegments` preserves normalized tab order within and outside quires. Remove `pinned` from test builders.

In Sheaf, context-menu, and Folio tests, assert there are no tab `pin`/`unpin` controls while activation and close controls remain.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test --cwd ui store/workspace.test.ts store/quires.test.ts components/codex/__tests__/Sheaf.test.tsx components/codex/__tests__/SheafContextMenu.test.tsx components/codex/__tests__/Folio.test.tsx
```

Expected: FAIL because pin actions/controls and pin-preserving close behavior still exist.

- [ ] **Step 3: Remove pinning from workspace state**

Before deleting the exported members, run LSP references for `TabDescriptor.pinned`, `togglePin`, and `orderSheafTabs`; migrate every tab callsite returned. Do not alter `PreviewWindow.pinned` or preview-store callsites.

In `workspace.ts`:

- remove `pinned?: boolean` from `TabDescriptor`;
- remove `togglePin` from the state interface and implementation;
- make focus-retention logic retain only the target tab;
- make `closeOtherTabs(tabId)` retain only `tabId`;
- make `closeQuireTabs(quireId)` remove every matching member, dissolve the quire, and activate the nearest remaining visible tab through the existing helper;
- bump the persisted workspace version from 3 to 4; and
- extend `migrateWorkspace` so version 3 and older tabs are reconstructed from the known `TabDescriptor` fields, dropping obsolete `pinned` data before `normalizeQuires` runs.

`partialize` must continue to omit one-shot focus fields. New persistence writes therefore contain neither focus requests nor pin state.

- [ ] **Step 4: Remove pin ordering and controls**

In `quires.ts`, delete `orderSheafTabs`; `sheafSegments` receives normalized page tabs in their existing array order.

In `Sheaf.tsx`:

```ts
const pageTabs = tabs.filter((tab) => tab.type === "page");
```

Remove the tab `Pin` import, `togglePin` selector, pin handlers, and conditional close suppression. Every tab receives the ordinary close control.

In `SheafContextMenu.tsx`, remove PIN/UNPIN and always expose CLOSE where the existing context permits it.

In Folio's open-tabs accordion, replace pinned/recent partitioning with one recency-sorted list:

```ts
const recent = tabs
  .filter((tab) => tab.type === "page")
  .sort((left, right) =>
    (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0),
  );
```

Delete `OpenRow.onTogglePin` and its button.

- [ ] **Step 5: Update user documentation and inventory assertions**

Rewrite `codex-and-conversation-capture.mdx` to describe:

- quire grouping/collapse without pinned-member exceptions;
- **Close quire** closing all members;
- Sheaf order following workspace/quire order; and
- recent Folios ordered by activation.

Update `mdx-smoke.test.tsx` to assert the revised close/order contract and remove all tab-pinning assertions. Do not change documentation for link-preview windows if it mentions their separate pin capability.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun test --cwd ui store/workspace.test.ts store/quires.test.ts components/codex/__tests__/Sheaf.test.tsx components/codex/__tests__/SheafContextMenu.test.tsx components/codex/__tests__/Folio.test.tsx docs/mdx-smoke.test.tsx
```

Expected: PASS. Then search `ui/src` for tab-only `togglePin` and `TabDescriptor` pin access; only link-preview/feed-domain uses of the word “pinned” may remain.

- [ ] **Step 7: Commit Task 2**

```bash
git add ui/src/store/workspace.ts ui/src/store/workspace.test.ts ui/src/store/quires.ts ui/src/store/quires.test.ts ui/src/components/codex/Sheaf.tsx ui/src/components/codex/__tests__/Sheaf.test.tsx ui/src/components/codex/SheafContextMenu.tsx ui/src/components/codex/__tests__/SheafContextMenu.test.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.test.tsx ui/src/docs/content/codex-and-conversation-capture.mdx ui/src/docs/mdx-smoke.test.tsx
git commit -m "refactor(tabs): remove pinning"
```

---

### Task 3: Clickable Gazetteer result tags

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx`
- Modify: `ui/src/components/codex/MobileGazetteer.tsx`
- Modify: `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx`
- Modify: `ui/src/routes/-gazetteer.test.tsx`

**Interfaces:**
- Consumes: `GazetteerFilters.onSelectedTagsChange(tags: string[])` and `MobileGazetteerProps.onSelectedTagsChange(tags: string[])`.
- Produces: `appendUniqueTag(selectedTags: string[], tag: string): string[]` in `Gazetteer.tsx` or the existing Gazetteer filter utility.
- Behavior: preserve input order, append only absent exact normalized indexed tags, and return the same array reference when already selected.

- [ ] **Step 1: Add failing route and mobile interaction tests**

In `-gazetteer.test.tsx`, render a result containing `tags: ["research"]`, establish route search with text, Kind, Project, sort, page, and another selected tag, then activate the desktop result-tag button:

```ts
await user.click(
  await screen.findByRole("button", { name: "Filter by tag research" }),
);

expect(navigateMock).toHaveBeenCalledWith(
  expect.objectContaining({
    to: "/gazetteer",
    search: expect.any(Function),
  }),
);
const update = navigateMock.mock.calls.at(-1)?.[0].search;
expect(
  update({
    q: "clep",
    tags: ["pkm"],
    kind: "NOTE",
    project: "clepsydra",
    sort: "title",
    page: 4,
  }),
).toMatchObject({
  q: "clep",
  tags: ["pkm", "research"],
  kind: "NOTE",
  project: "clepsydra",
  sort: "title",
  page: 1,
});
```

Add a second activation assertion proving `research` is not duplicated.

In `MobileGazetteer.test.tsx`, click `Filter by tag research` and assert `onSelectedTagsChange(["pkm", "research"])`. Assert the tag button is keyboard reachable and already-active tags expose `aria-pressed="true"` or are disabled with equivalent accessible state.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
bun test --cwd ui routes/-gazetteer.test.tsx components/codex/__tests__/MobileGazetteer.test.tsx
```

Expected: FAIL because result tags are plain spans.

- [ ] **Step 3: Add one deduplicating activation helper**

Implement and unit-cover the pure operation:

```ts
export function appendUniqueTag(
  selectedTags: string[],
  tag: string,
): string[] {
  return selectedTags.includes(tag) ? selectedTags : [...selectedTags, tag];
}
```

In the result component, call `onSelectedTagsChange`/`setSelectedTags` only when `nextTags !== selectedTags`, avoiding duplicate route navigation for an active tag.

- [ ] **Step 4: Replace desktop and mobile spans with accessible buttons**

Desktop row tags must stop the row's open-Folio click before applying the filter:

```tsx
<button
  type="button"
  aria-label={`Filter by tag ${tag}`}
  aria-pressed={selectedTags.includes(tag)}
  onClick={(event) => {
    event.stopPropagation();
    applyResultTag(tag);
  }}
  className="cl-mono cursor-pointer ... focus-visible:outline ..."
>
  #{tag}
</button>
```

Do not wrap all tags into one text span. Preserve truncation by allowing the cell container to clip or wrap according to the current desktop layout.

In `MobileGazetteer.tsx`, use the already imported React Aria `Button`:

```tsx
<Button
  aria-label={`Filter by tag ${tag}`}
  aria-pressed={selectedTags.includes(tag)}
  onPress={() => applyResultTag(tag)}
>
  #{tag}
</Button>
```

Use one callback contract on both breakpoints. Active-tag activation must be inert.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test --cwd ui routes/-gazetteer.test.tsx components/codex/__tests__/MobileGazetteer.test.tsx
```

Expected: PASS, including composition, page reset, deduplication, row-click isolation, and accessibility.

- [ ] **Step 6: Commit Task 3**

```bash
git add ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/MobileGazetteer.tsx ui/src/components/codex/__tests__/MobileGazetteer.test.tsx ui/src/routes/-gazetteer.test.tsx
git commit -m "feat(gazetteer): filter from result tags"
```

---

## Wave 1 integration, review, and verification

After all task commits:

1. Dispatch a specification reviewer against this plan and `docs/superpowers/specs/2026-08-12-stray-thoughts-followup-p1-design.md`.
2. Fix every confirmed scope or contract gap with a failing regression first.
3. Dispatch a code-quality reviewer against the complete Wave 1 diff.
4. Fix every confirmed correctness, accessibility, or maintainability issue with focused proof.
5. Run formatting only once after all parallel task edits have settled.

Run the repository gates from `ui/` through Bun's working-directory support:

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
bun run --cwd ui build
```

Expected: all commands exit 0. Existing warnings must be reported exactly; new warnings are failures.

Run browser smoke against a disposable vault at desktop and mobile widths:

1. Open a page with metadata relation edges and one real wikilink; verify the same outbound count appears in metadata and the Links tab, and only the real link is listed.
2. Load workspace state containing obsolete tab `pinned` fields; verify tabs restore, activate, close, and order by current workspace/quire order with no pin controls.
3. Close a quire and verify every member closes.
4. In Gazetteer, apply text, Kind, Project, sort, and an existing tag; click a result tag and verify composition, page reset, row isolation, and browser back/forward at desktop and mobile widths.
5. Verify link-preview windows still expose their separate pin control.

Commit review corrections separately, merge the Wave 1 branch to `develop`, rerun the four UI gates on merged `develop`, and remove the feature worktree. Only then mark these three vault checkboxes complete:

- incorrect Folio Links count;
- remove tab pinning; and
- click Gazetteer result tags to filter.
