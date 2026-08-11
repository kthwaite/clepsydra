# Stray Thoughts P2 Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add journal-time navigation, a compact Gazetteer tag picker, and a sheaf-tab page-creation action without changing backend persistence contracts.

**Architecture:** Extend the existing Folio TOC model to recognize `journal-time` blocks, extend the shared `TagInput` with a known-values-only mode and use it on both Gazetteer layouts, and connect the sheaf action directly to the globally mounted `InscribeModal`. Route search, workspace tabs, page creation, and tag-index queries remain authoritative.

**Tech Stack:** React 19, TypeScript, Slate, Zustand, TanStack Router, TanStack Query, React Aria Components, Vitest, Testing Library, Bun, Vite.

## Global Constraints

- This wave changes UI code only; do not add or modify Rust API routes or generated OpenAPI types.
- Markdown pages remain canonical; `journal-time` stays a frozen Slate void block serialized as a level-two Markdown heading.
- Gazetteer route search remains authoritative for text, tags, Kind, Project, sort, and page.
- Gazetteer may select only tags returned by the indexed tag vocabulary; an unknown tag already present in a bookmarked URL stays visible and removable but cannot be newly entered.
- The sheaf action must reuse `useUiStore.openInscribe`; do not introduce a second create-page modal or mutation path.
- Every control must be keyboard operable, accessibly named, and usable at mobile breakpoints.
- Follow TDD: observe every named failing test before implementation, then run it green before committing.
- Preserve unrelated working-tree changes. Execute this plan in an isolated worktree created at execution time.

## File structure

- Create `ui/src/components/codex/folioToc.ts` — pure Folio navigation-entry extraction from top-level Slate blocks.
- Create `ui/src/components/codex/folioToc.test.ts` — heading and journal-time extraction/numbering contracts.
- Modify `ui/src/components/codex/Folio.tsx` — import the pure TOC builder and remove the local duplicate.
- Modify `ui/src/components/ui/tag-input.tsx` — add a known-suggestions-only commit policy while preserving authoring callers' default free entry.
- Modify `ui/src/components/ui/__tests__/tag-input.test.tsx` — prove rejection, canonical matching, and existing free-entry behavior.
- Modify `ui/src/components/codex/Gazetteer.tsx` — replace the desktop tag rail with `TagInput`, clear action, and tag-query state wiring.
- Modify `ui/src/components/codex/MobileGazetteer.tsx` — replace the mobile tag-button array with the same picker contract.
- Modify `ui/src/components/codex/Gazetteer.test.ts` — prove compact known-tag selection, query states, and controlled filter updates.
- Modify `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx` — prove the mobile filter sheet uses the picker and retains current selections.
- Modify `ui/src/components/codex/Sheaf.tsx` — add **+ New** and dispatch `openInscribe`.
- Modify `ui/src/components/codex/__tests__/Sheaf.test.tsx` — prove one global dialog state transition and unchanged tab semantics.

---

### Task 1: Journal-time Contents and reading ticks

**Files:**
- Create: `ui/src/components/codex/folioToc.ts`
- Create: `ui/src/components/codex/folioToc.test.ts`
- Modify: `ui/src/components/codex/Folio.tsx:436,1546-1582`

**Interfaces:**
- Consumes: top-level Slate-compatible `unknown` values containing ordinary `{ type: "heading", level, children }` and frozen `{ type: "journal-time", time, children }` blocks.
- Produces: `export type TocEntry = { number: string; depth: number; text: string }` and `export function buildToc(value: unknown): TocEntry[]`.
- Invariant: output order exactly matches DOM heading order. `JournalTimeHeading` already renders an `h2`, so `useScrollSpy`'s `h1,h2,h3,h4,h5,h6` selector requires no second selector.

- [ ] **Step 1: Write failing pure extraction tests**

Create `folioToc.test.ts` with these observable cases:

```ts
import { describe, expect, it } from "vitest";
import { buildToc } from "./folioToc";

describe("buildToc", () => {
  it("includes frozen journal times as level-two navigation entries", () => {
    expect(
      buildToc([
        { type: "heading", level: 1, children: [{ text: "Day" }] },
        { type: "journal-time", time: "09:07", children: [{ text: "" }] },
        { type: "heading", level: 2, children: [{ text: "Notes" }] },
      ]),
    ).toEqual([
      { number: "1", depth: 1, text: "Day" },
      { number: "1.1", depth: 2, text: "09:07" },
      { number: "1.2", depth: 2, text: "Notes" },
    ]);
  });

  it("ignores malformed journal-time blocks and non-heading content", () => {
    expect(
      buildToc([
        { type: "paragraph", children: [{ text: "Body" }] },
        { type: "journal-time", children: [{ text: "" }] },
        { type: "journal-time", time: "", children: [{ text: "" }] },
      ]),
    ).toEqual([]);
  });
});
```

Retain the existing heading numbering and `(untitled)` tests when moving the helper; add them if no direct tests currently exist.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun run test src/components/codex/folioToc.test.ts
```

Expected: FAIL because `./folioToc` does not exist.

- [ ] **Step 3: Extract and extend the pure TOC builder**

Create `folioToc.ts` with the exact public shape:

```ts
export type TocEntry = { number: string; depth: number; text: string };

type SlateNode = {
  type?: string;
  level?: number;
  time?: string;
  children?: Array<SlateNode | { text?: string }>;
};

export function buildToc(value: unknown): TocEntry[] {
  if (!Array.isArray(value)) return [];
  const counters = [0, 0, 0, 0, 0, 0];
  const entries: TocEntry[] = [];

  for (const node of value as SlateNode[]) {
    const ordinaryDepth =
      node?.type === "heading" && typeof node.level === "number"
        ? Math.max(1, Math.min(node.level, 6))
        : null;
    const journalTime =
      node?.type === "journal-time" &&
      typeof node.time === "string" &&
      node.time.length > 0
        ? node.time
        : null;
    const depth = journalTime === null ? ordinaryDepth : 2;
    if (depth === null) continue;

    counters[depth - 1] += 1;
    for (let index = depth; index < counters.length; index += 1) {
      counters[index] = 0;
    }
    const number = counters
      .slice(0, depth)
      .filter((count) => count > 0)
      .join(".");
    const text = journalTime ?? nodeText(node).trim() || "(untitled)";
    entries.push({ number, depth, text });
  }

  return entries;
}
```

Parenthesize the nullish-coalescing expression as required by TypeScript:

```ts
const text = journalTime ?? (nodeText(node).trim() || "(untitled)");
```

Move `nodeText` unchanged into this module. In `Folio.tsx`, import `buildToc` and `TocEntry`, then delete the local `TocEntry`, `SlateNode`, `buildToc`, and `nodeText` declarations. Do not alter `ReadingTicks`, Contents rendering, or `useScrollSpy`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun run test src/components/codex/folioToc.test.ts src/components/codex/__tests__/Folio.test.tsx src/components/codex/useScrollSpy.test.tsx src/editor/schema/elements/journalTime.test.tsx
```

Expected: PASS. Existing heading and scroll-spy behavior remains green.

- [ ] **Step 5: Commit the navigation slice**

```bash
git add ui/src/components/codex/folioToc.ts ui/src/components/codex/folioToc.test.ts ui/src/components/codex/Folio.tsx
git commit -m "fix(folio): navigate journal time headings"
```

---

### Task 2: Known-values-only TagInput policy

**Files:**
- Modify: `ui/src/components/ui/tag-input.tsx:16-35,40-165,239-264`
- Modify: `ui/src/components/ui/__tests__/tag-input.test.tsx`

**Interfaces:**
- Consumes: existing `suggestions?: string[]` and all current TagInput props.
- Produces: optional `allowCreate?: boolean`, defaulting to `true` so Folio, Intake, and other metadata editors retain arbitrary tag creation.
- When `allowCreate` is `false`, a draft commits only if it matches a suggestion under existing trim/case-insensitive equality; the emitted value uses the suggestion's canonical spelling.

- [ ] **Step 1: Add failing commit-policy tests**

Append focused tests:

```tsx
it("rejects a non-vocabulary draft when creation is disabled", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <TagInput
      label="Tags"
      values={[]}
      suggestions={["research", "rust"]}
      allowCreate={false}
      onChange={onChange}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "unknown{Enter}");
  expect(onChange).not.toHaveBeenCalled();
});

it("commits canonical vocabulary spelling when creation is disabled", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <TagInput
      label="Tags"
      values={[]}
      suggestions={["Research"]}
      allowCreate={false}
      onChange={onChange}
    />,
  );

  await user.type(screen.getByRole("combobox", { name: "Add tags" }), " research {Enter}");
  expect(onChange).toHaveBeenCalledWith(["Research"]);
});

it("keeps free tag creation enabled by default", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<TagInput label="Tags" values={[]} suggestions={[]} onChange={onChange} />);
  await user.type(screen.getByRole("combobox", { name: "Add tags" }), "new-tag{Enter}");
  expect(onChange).toHaveBeenCalledWith(["new-tag"]);
});
```

Add one blur case proving an unknown draft is also rejected when `allowCreate={false}`; Enter-only enforcement is insufficient because `onBlur` currently calls `addValue`.

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
bun run test src/components/ui/__tests__/tag-input.test.tsx
```

Expected: FAIL because `allowCreate` is not a TagInput prop and unknown values still commit.

- [ ] **Step 3: Implement one canonical candidate resolver**

Add the prop and default:

```ts
allowCreate?: boolean;
// ...
allowCreate = true,
```

Inside `TagInput`, derive the commit candidate in one place:

```ts
const resolveCandidate = useCallback(
  (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (allowCreate) return trimmed;
    return (
      suggestions?.find((suggestion) => tagsEqual(suggestion, trimmed)) ?? null
    );
  },
  [allowCreate, suggestions],
);
```

Change `addValue` to call `resolveCandidate(val)`. If it returns `null`, clear the draft/highlight/dismissed state exactly as a completed invalid attempt but do not call `onChange`. Use the resolved canonical value for duplicate/read-only checks and emission. Because Enter, Tab, comma, mouse selection, and blur already converge on `addValue`, do not add per-key special cases.

Keep `allowCreate=true` as the default and run the complete TagInput suite to prove no authoring regression.

- [ ] **Step 4: Run the focused test file**

Run:

```bash
bun run test src/components/ui/__tests__/tag-input.test.tsx
```

Expected: PASS, including existing raw-entry, derived-tag, loading/error/retry, keyboard, mouse, blur, and suggestion tests.

- [ ] **Step 5: Commit the reusable policy**

```bash
git add ui/src/components/ui/tag-input.tsx ui/src/components/ui/__tests__/tag-input.test.tsx
git commit -m "feat(tags): support vocabulary-only selection"
```

---

### Task 3: Gazetteer desktop and mobile tag picker

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx:84-111,201-229,313-331`
- Modify: `ui/src/components/codex/MobileGazetteer.tsx:28-89,303-336`
- Modify: `ui/src/components/codex/Gazetteer.test.ts`
- Modify: `ui/src/components/codex/__tests__/MobileGazetteer.test.tsx`
- Test: `ui/src/routes/-gazetteer.test.tsx`

**Interfaces:**
- Consumes: Task 2's `TagInput allowCreate={false}` contract and `useTags()` query state.
- Produces: one controlled picker on each layout whose `values` are `selectedTags` and whose `onChange` is the existing `onSelectedTagsChange`/`setSelectedTags` callback.
- Mobile props add `tagsLoading: boolean`, `tagsError: unknown`, and `onRetryTags: () => void`; `tags` remains `TagCount[]`.

- [ ] **Step 1: Replace old tag-array expectations with failing picker tests**

In `Gazetteer.test.ts`, make the hoisted tag query mutable:

```ts
const tagQueryState = {
  data: [
    { tag: "research", count: 4, computed_count: 0 },
    { tag: "rust", count: 2, computed_count: 0 },
  ],
  isFetching: false,
  error: null as Error | null,
  refetch: vi.fn(),
};
```

Return it from `useTags`. Add desktop tests that:

1. assert there is one combobox named **Filter by tags** and no always-visible `Filter by research` button;
2. type `res`, choose `research`, and expect `onSelectedTagsChange(["research"])` for controlled filters;
3. begin with `selectedTags: ["legacy-url-tag"]`, verify the selected value remains visible/removable even though it is absent from suggestions, and verify typing `unknown{Enter}` does not call the change callback;
4. set `error`, type a query, click **Retry tag suggestions**, and expect `refetch` while the selected route tags remain rendered;
5. set `isFetching`, type a query, and expect the existing loading status without clearing selected values.

Update mobile tests to open **Gazetteer filters**, use the same **Filter by tags** combobox, select a known suggestion, clear all selected tags, and verify the sheet no longer renders the complete vocabulary as one button per tag.

- [ ] **Step 2: Run Gazetteer tests to verify failure**

Run:

```bash
bun run test src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx src/routes/-gazetteer.test.tsx
```

Expected: FAIL because both layouts still render the complete tag rail/button array and do not expose query state to the picker.

- [ ] **Step 3: Wire query state and replace the desktop rail**

In `Gazetteer.tsx`, replace `const { data: tagsData } = useTags()` with:

```ts
const tagsQuery = useTags();
const tags = tagsQuery.data ?? [];
const tagSuggestions = tags.map((tag) => tag.tag);
```

Delete the local `toggleTag`; it becomes obsolete after controlled picker integration.

Replace the desktop tag rail with a compact labelled region:

```tsx
<div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-soft px-5 py-2">
  <TagInput
    label="Tags"
    ariaLabel="Filter by tags"
    values={selectedTags}
    suggestions={tagSuggestions}
    suggestionsLoading={tagsQuery.isFetching}
    suggestionsError={tagsQuery.error}
    onRetrySuggestions={() => void tagsQuery.refetch()}
    allowCreate={false}
    onChange={setSelectedTags}
    placeholder="filter tags…"
    variant="codex"
    valuePrefix="#"
    maxSuggestions={8}
    className="min-w-0 flex-1"
  />
  {selectedTags.length > 0 ? (
    <button type="button" className="cl-btn" onClick={() => setSelectedTags([])}>
      clear
    </button>
  ) : null}
  <span className="cl-mono text-[9px] text-ink-mute">all must match · {totalCount}</span>
</div>
```

Keep tag summary/count behavior in the Gazetteer heading. Do not copy query state into local component state.

Pass `tags`, `tagsLoading`, `tagsError`, and `onRetryTags` to `MobileGazetteer`.

- [ ] **Step 4: Replace the mobile tag array with the same contract**

Add `TagInput` to `MobileGazetteer`. Remove `toggleTag`. In the tag section render:

```tsx
<TagInput
  label="Tags"
  ariaLabel="Filter by tags"
  values={selectedTags}
  suggestions={tags.map((tag) => tag.tag)}
  suggestionsLoading={tagsLoading}
  suggestionsError={tagsError}
  onRetrySuggestions={onRetryTags}
  allowCreate={false}
  onChange={onSelectedTagsChange}
  placeholder="filter tags…"
  variant="codex"
  valuePrefix="#"
  maxSuggestions={8}
/>
{selectedTags.length > 0 ? (
  <Button onPress={() => onSelectedTagsChange([])}>Clear tags</Button>
) : null}
```

Retain the explanatory **all selected tags must match** copy. Do not retain the full map of tag buttons.

- [ ] **Step 5: Run focused and route tests**

Run:

```bash
bun run test src/components/ui/__tests__/tag-input.test.tsx src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx src/routes/-gazetteer.test.tsx
```

Expected: PASS. Route tests still prove tags serialize through `GazetteerSearch` and filter changes reset page to 1.

- [ ] **Step 6: Commit Gazetteer integration**

```bash
git add ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/MobileGazetteer.tsx ui/src/components/codex/Gazetteer.test.ts ui/src/components/codex/__tests__/MobileGazetteer.test.tsx
git commit -m "feat(gazetteer): replace tag rail with picker"
```

---

### Task 4: Sheaf **+ New** action

**Files:**
- Modify: `ui/src/components/codex/Sheaf.tsx:1-36,176-185`
- Modify: `ui/src/components/codex/__tests__/Sheaf.test.tsx`
- Test: `ui/src/components/codex/__tests__/InscribeModal.test.tsx`

**Interfaces:**
- Consumes: `useUiStore((state) => state.openInscribe)` and the already globally mounted `InscribeModal`.
- Produces: a sheaf-strip button named **New page**. It opens the existing modal; `InscribeModal.finish` remains responsible for opening and activating the successfully created page.

- [ ] **Step 1: Write the failing sheaf action tests**

Reset the relevant UI state in the test setup, then add:

```tsx
it("opens the existing Intake page-creation dialog state", async () => {
  const user = userEvent.setup();
  seed(false);
  useUiStore.setState({ isInscribeOpen: false });
  render(<Sheaf activeTabId="t3" />);

  await user.click(screen.getByRole("button", { name: "New page" }));

  expect(useUiStore.getState().isInscribeOpen).toBe(true);
  expect(useWorkspaceStore.getState().tabs).toHaveLength(3);
});

it("does not represent the creation action as a sheaf tab", () => {
  seed(false);
  render(<Sheaf activeTabId="t3" />);
  expect(screen.getByText("3")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New page" })).not.toHaveAttribute(
    "aria-selected",
  );
});
```

Import `useUiStore`. Existing `InscribeModal.test.tsx` already proves successful creation calls `openTab`, cancellation closes without mutation, and failures remain open; do not duplicate those mutation tests in Sheaf.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun run test src/components/codex/__tests__/Sheaf.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
```

Expected: Sheaf test FAIL because **New page** does not exist; Inscribe tests remain PASS.

- [ ] **Step 3: Add the action without a new modal path**

Import `Plus` from `lucide-react` and `useUiStore`. Select `openInscribe` in `Sheaf`:

```ts
const openInscribe = useUiStore((state) => state.openInscribe);
```

Insert the action after the mapped tab/quire segments and before the flexible spacer:

```tsx
<button
  type="button"
  aria-label="New page"
  title="New page"
  onClick={openInscribe}
  className="flex flex-shrink-0 cursor-pointer items-center gap-1 border-r border-rule-soft px-2.5 py-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
>
  <Plus aria-hidden="true" size={11} />
  New
</button>
```

Do not alter page-tab counts, quire ordering, tab preview behavior, or the existing `⌘N intake` hint. Zustand's boolean state makes repeated clicks idempotent; do not add a second local `isDialogOpen` flag.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun run test src/components/codex/__tests__/Sheaf.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx src/components/codex/__tests__/CodexFrame.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the creation action**

```bash
git add ui/src/components/codex/Sheaf.tsx ui/src/components/codex/__tests__/Sheaf.test.tsx
git commit -m "feat(sheaf): add page creation action"
```

---

### Task 5: Wave 1 review, browser proof, and repository gates

**Files:**
- Modify only files required by evidence-backed review findings.
- Do not update the source vault note until the merged result passes every gate.

**Interfaces:**
- Consumes: the three committed slices above.
- Produces: a reviewed, browser-smoked, gate-clean feature branch ready to merge into `develop`.

- [ ] **Step 1: Run focused Wave 1 tests together**

```bash
bun run test src/components/codex/folioToc.test.ts src/components/codex/useScrollSpy.test.tsx src/editor/schema/elements/journalTime.test.tsx src/components/ui/__tests__/tag-input.test.tsx src/components/codex/Gazetteer.test.ts src/components/codex/__tests__/MobileGazetteer.test.tsx src/routes/-gazetteer.test.tsx src/components/codex/__tests__/Sheaf.test.tsx src/components/codex/__tests__/InscribeModal.test.tsx
```

Expected: all files pass.

- [ ] **Step 2: Request focused code review**

Review the branch against the program design and report only Critical/Important findings. Specifically inspect:

- TOC/DOM order parity for mixed headings and journal times;
- unknown bookmarked Gazetteer tags remaining removable but not newly creatable;
- Enter, Tab, comma, blur, mouse, loading, error, retry, and canonical case behavior in `TagInput`;
- desktop/mobile controlled filter parity and route page reset;
- Sheaf action idempotence and reuse of `InscribeModal`.

Implement each accepted finding through a failing behavioral test, run focused tests, and commit the correction separately.

- [ ] **Step 3: Run UI verification gates**

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Expected:

- TypeScript exits 0.
- Biome exits 0; existing configuration notices may remain informational.
- Full Vitest suite exits 0.
- Production Vite build exits 0.

No Rust gate is required because this wave changes no Rust, OpenAPI source, or generated client schema.

- [ ] **Step 4: Browser-smoke desktop behavior against a disposable vault**

Launch the built application with a disposable vault containing:

```markdown
# Journal navigation fixture

## 09:07

Morning note.

## Ordinary section

Body.
```

and at least two pages tagged `research` and `rust`.

At desktop width:

1. Open the journal fixture in Folio.
2. Verify Contents includes `09:07` and `Ordinary section` in document order and the reading rail has matching controls.
3. Activate the time entry from Contents and its rail tick; observe the body scrolls to the time block and the active state follows.
4. Open Gazetteer, type `res` in **Filter by tags**, select `research`, and verify only matching rows remain.
5. Combine the tag with text, Kind, and Project; use browser back/forward and verify picker chips and results restore from route search.
6. Enter an unknown tag and verify it is not added. Force or seed an unknown URL tag and verify it remains visible and removable.
7. Activate **New page** in the sheaf, cancel once, reopen, create a NOTE, and verify exactly one new active page tab appears.

- [ ] **Step 5: Browser-smoke mobile behavior**

At the project's mobile breakpoint:

1. Open Gazetteer filters and select/remove a known tag through **Filter by tags**.
2. Verify loading/error/retry feedback remains accessible and selected route tags do not disappear.
3. Verify the sheaf action remains keyboard/touch reachable wherever the sheaf is rendered; no horizontal overflow hides existing tabs.

- [ ] **Step 6: Commit review corrections and merge**

After all checks are green:

```bash
git status --short
git log --oneline --decorate -10
git diff --check develop...HEAD
```

Commit only verified review corrections. Follow the repository feature workflow to merge the named feature branch to `develop`, rerun the full UI test suite on the merged result, remove the worktree, and delete the merged branch.

- [ ] **Step 7: Update the source vault note through MCP**

Only after merged-result verification, mark these exact items complete in `Clepsydra: Stray Thoughts`:

- `Time headers don't seem to generate contents/navigation ticks, which they should`
- `Amend Gazetteer tag interface - tag picker, rather than huge array of tags`
- `Add '+ New' to the sheaf tab bar for quick page creation`
