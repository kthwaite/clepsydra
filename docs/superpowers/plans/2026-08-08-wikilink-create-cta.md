# Wikilink Create CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wikilink combobox’s zero-result message with a keyboard-accessible action that safely creates or reuses a blank note, inserts its wikilink, and keeps the source editor open.

**Architecture:** Extract the existing dangling-link refresh/search/create sequence into a shared editor hook returning a canonical target path. Model the create CTA as a synthetic combobox suggestion so existing mouse and keyboard selection behavior remains authoritative. `SlateEditor` owns pending/error state and guards async completion against a changed trigger before applying Slate transforms.

**Tech Stack:** React 19, TypeScript 5.9, Slate 0.123, TanStack Query/OpenAPI mutations, Vitest 4, Testing Library, Biome.

## Global Constraints

- Show `Create “<query>”` only when the trimmed query is non-empty and the filtered page list has zero matches.
- Create an empty `NOTE` with `title: <trimmed query>` using `intakePath`, `generateShortId`, and the existing `useCreatePage` mutation.
- Refresh wikilink resolution and perform an exact NFC-normalized, case-insensitive title search before creating.
- Insert the wikilink only after resolution or creation succeeds; never open the target from the combobox flow.
- Keep the chooser and query available after failure, with a retryable inline error.
- Ignore duplicate activation while pending and ignore stale async completion after the trigger changes or closes.
- Preserve existing page-suggestion and dangling-link-click behavior.
- Add no dependency and make no backend, LSP, relation-editor, or non-`NOTE` creation change.

---

## File Structure

- Create `ui/src/editor/useResolveOrCreateWikilinkTarget.ts`: shared refresh/search/create contract and normalized exact-title comparison.
- Create `ui/src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx`: resolver behavior, canonical request, failures, and in-flight de-duplication.
- Modify `ui/src/editor/elements/WikilinkElement.tsx`: consume the shared resolver and retain open-on-click behavior.
- Modify `ui/src/editor/__tests__/WikilinkElement.test.tsx`: mock the shared contract and retain caller-level behavior assertions.
- Modify `ui/src/editor/WikilinkCombobox.tsx`: synthetic create suggestion, pending copy, error copy, and callback dispatch.
- Modify `ui/src/editor/__tests__/WikilinkCombobox.test.tsx`: CTA visibility and mouse/keyboard activation contracts.
- Modify `ui/src/editor/SlateEditor.tsx`: create lifecycle, target-string insertion, and stale-trigger guard.
- Create `ui/src/editor/__tests__/SlateEditor.wikilink-create.test.tsx`: end-to-end editor insertion, failure preservation, and stale completion coverage.

---

### Task 1: Shared Resolve-or-Create Contract

**Files:**
- Create: `ui/src/editor/useResolveOrCreateWikilinkTarget.ts`
- Create: `ui/src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx`
- Modify: `ui/src/editor/elements/WikilinkElement.tsx:1-73`
- Modify: `ui/src/editor/__tests__/WikilinkElement.test.tsx:15-273`

**Interfaces:**
- Consumes: `useWikilinkResolution().refetchAndLookup(targetRaw)`, `fetchClient.GET("/api/vault/index/search", ...)`, `useCreatePage().mutateAsync(...)`, `intakePath`, and `generateShortId`.
- Produces:
  ```ts
  export interface ResolvedWikilinkTarget {
    path: string;
    title: string;
  }

  export interface ResolveOrCreateWikilinkTarget {
    resolveOrCreate(targetRaw: string): Promise<ResolvedWikilinkTarget>;
  }

  export function useResolveOrCreateWikilinkTarget(): ResolveOrCreateWikilinkTarget;
  ```
- Caller contract: the hook trims the target, rejects an empty value, reuses fresh/exact matches, creates only when unresolved, returns the requested trimmed title, and coalesces simultaneous calls for the same normalized target within one hook instance.

- [ ] **Step 1: Write failing resolver tests for refreshed and exact-title reuse**

Create `ui/src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx`. Hoist mocks for `refetchAndLookup`, `fetchClient.GET`, `useCreatePage().mutateAsync`, `generateShortId`, and the current clock input if the implementation accepts it as a seam. Use a `QueryClientProvider` only if the mocked hook still requires it.

```tsx
it("returns a refreshed resolution without search or creation", async () => {
  refetchAndLookupMock.mockResolvedValue("notes/existing.md");
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  await expect(result.current.resolveOrCreate(" Existing ")).resolves.toEqual({
    path: "notes/existing.md",
    title: "Existing",
  });
  expect(searchGetMock).not.toHaveBeenCalled();
  expect(createMutateAsyncMock).not.toHaveBeenCalled();
});

it("reuses an NFC-normalized case-insensitive exact title", async () => {
  searchGetMock.mockResolvedValue({
    data: [
      { path: "notes/decoy.md", title: "Something Else" },
      { path: "notes/cafe.md", title: "Cafe\u{301} Notes" },
    ],
  });
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  await expect(result.current.resolveOrCreate("Caf\u{e9} Notes")).resolves.toEqual({
    path: "notes/cafe.md",
    title: "Caf\u{e9} Notes",
  });
  expect(createMutateAsyncMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the resolver tests and verify RED**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx
```

Expected: FAIL because `useResolveOrCreateWikilinkTarget` does not exist.

- [ ] **Step 3: Add failing tests for canonical creation, validation, failure, and coalescing**

Define this deterministic deferred helper in the test file before the cases:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

```tsx
it("creates one blank canonical note when the target is unresolved", async () => {
  generateShortIdMock.mockReturnValue("a1B2c3D4");
  createMutateAsyncMock.mockResolvedValue({});
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  const target = await result.current.resolveOrCreate(" New Topic ");

  expect(target.title).toBe("New Topic");
  expect(target.path).toMatch(/^notes\/\d{8}\.new-topic\.a1B2c3D4\.md$/);
  expect(createMutateAsyncMock).toHaveBeenCalledWith({
    params: { path: { path: target.path } },
    body: { title: "New Topic" },
  });
});

it("rejects a blank target before I/O", async () => {
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());
  await expect(result.current.resolveOrCreate("   ")).rejects.toThrow(
    "Page title is required",
  );
  expect(refetchAndLookupMock).not.toHaveBeenCalled();
});

it("propagates creation failure", async () => {
  createMutateAsyncMock.mockRejectedValue(new Error("create failed"));
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());
  await expect(result.current.resolveOrCreate("New Topic")).rejects.toThrow(
    "create failed",
  );
});

it("coalesces simultaneous requests for the same normalized target", async () => {
  const pending = deferred<unknown>();
  createMutateAsyncMock.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  const first = result.current.resolveOrCreate("New Topic");
  const second = result.current.resolveOrCreate(" new topic ");
  expect(createMutateAsyncMock).toHaveBeenCalledTimes(1);

  pending.resolve({});
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
});
```

- [ ] **Step 4: Implement the minimal shared hook**

Create `ui/src/editor/useResolveOrCreateWikilinkTarget.ts` with a `Map<string, Promise<ResolvedWikilinkTarget>>` in a ref. Use the normalized title as the map key, but preserve the first caller’s trimmed spelling as `title`.

```ts
import { useCallback, useRef } from "react";
import { fetchClient } from "#/api/client";
import { useCreatePage } from "#/api/pages";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { generateShortId, intakePath } from "#/lib/intake";

export interface ResolvedWikilinkTarget {
  path: string;
  title: string;
}

export interface ResolveOrCreateWikilinkTarget {
  resolveOrCreate(targetRaw: string): Promise<ResolvedWikilinkTarget>;
}

function titleKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function useResolveOrCreateWikilinkTarget(): ResolveOrCreateWikilinkTarget {
  const { refetchAndLookup } = useWikilinkResolution();
  const createPage = useCreatePage();
  const createMutateAsync = createPage.mutateAsync;
  const inFlightRef = useRef(
    new Map<string, Promise<ResolvedWikilinkTarget>>(),
  );

  const resolveOrCreate = useCallback(
    (targetRaw: string) => {
      const title = targetRaw.trim();
      if (!title) return Promise.reject(new Error("Page title is required"));
      const key = titleKey(title);
      const existingRequest = inFlightRef.current.get(key);
      if (existingRequest) return existingRequest;

      const request = (async () => {
        const refreshedPath = await refetchAndLookup(title);
        if (refreshedPath) return { path: refreshedPath, title };

        const { data } = await fetchClient.GET("/api/vault/index/search", {
          params: { query: { q: title } },
        });
        const exact = (data ?? []).find(
          (entry) => entry.title != null && titleKey(entry.title) === key,
        );
        if (exact) return { path: exact.path, title };

        const path = intakePath({
          kind: "NOTE",
          project: null,
          title,
          shortId: generateShortId(),
          now: new Date(),
        });
        await createMutateAsync({
          params: { path: { path } },
          body: { title },
        });
        return { path, title };
      })().finally(() => inFlightRef.current.delete(key));

      inFlightRef.current.set(key, request);
      return request;
    },
    [createMutateAsync, refetchAndLookup],
  );

  return { resolveOrCreate };
}
```

If the generated API mutation type rejects `{ title }` without explicit `body`, use the exact `CreatePageRequest` shape already accepted by `WikilinkElement`; do not cast through `unknown`.

- [ ] **Step 5: Run resolver tests and verify GREEN**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx
```

Expected: all resolver tests PASS with zero unhandled rejections.

- [ ] **Step 6: Refactor `WikilinkElement` to consume the shared contract**

Remove its direct `fetchClient`, `useCreatePage`, `generateShortId`, `intakePath`, `titleKey`, and local in-flight ref. Keep its caller policy:

```ts
const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();

const handleDanglingClick = async () => {
  try {
    const target = await resolveOrCreate(element.target);
    openTab("page", target.path);
  } catch {
    // Best effort: leave the link dangling.
  }
};
```

The hook coalesces repeated activation; do not add a second in-flight mechanism in the element.

- [ ] **Step 7: Update dangling-link caller tests**

Mock `useResolveOrCreateWikilinkTarget` in `WikilinkElement.test.tsx`. Preserve assertions that a resolved element passes its stored path directly and that a dangling click opens the returned path. Replace internal search/create assertions with shared-hook caller assertions:

```tsx
resolveOrCreateMock.mockResolvedValue({
  path: "notes/new-topic.md",
  title: "New Topic",
});
renderWikilink("New Topic");
await user.click(screen.getByRole("link"));
await waitFor(() =>
  expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
);
expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic");
```

Retain one failure test proving rejection does not open a tab.

- [ ] **Step 8: Run resolver and dangling-link tests**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx src/editor/__tests__/WikilinkElement.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add ui/src/editor/useResolveOrCreateWikilinkTarget.ts ui/src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx ui/src/editor/elements/WikilinkElement.tsx ui/src/editor/__tests__/WikilinkElement.test.tsx
git commit -m "refactor(editor): share wikilink target creation"
```

---

### Task 2: Keyboard-Selectable Create Suggestion

**Files:**
- Modify: `ui/src/editor/WikilinkCombobox.tsx:1-52`
- Modify: `ui/src/editor/__tests__/WikilinkCombobox.test.tsx:1-92`

**Interfaces:**
- Consumes: existing `EditorSuggestionPopover<T>` item selection behavior.
- Produces updated props:
  ```ts
  interface WikilinkComboboxProps {
    pages: PageSummary[];
    query: string;
    reference: VirtualElement | null;
    onSelect: (page: PageSummary) => void;
    onCreate: (title: string) => void;
    onClose: () => void;
    isCreating?: boolean;
    createError?: string | null;
  }
  ```
- Synthetic internal union:
  ```ts
  type WikilinkSuggestion =
    | { kind: "page"; page: PageSummary }
    | { kind: "create"; title: string };
  ```

- [ ] **Step 1: Write failing visibility tests**

Extend `WikilinkCombobox.test.tsx`. Define one render helper so every case supplies the complete component contract:

```tsx
function renderCombobox(
  overrides: Partial<React.ComponentProps<typeof WikilinkCombobox>> = {},
) {
  return render(
    <WikilinkCombobox
      pages={[]}
      query="New Topic"
      reference={makeVirtualReference(120, 80)}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

it("offers creation only for a non-empty zero-match query", () => {
  renderCombobox();
  expect(screen.getByText('Create “New Topic”')).toBeInTheDocument();
});

it("does not offer creation when a partial match exists", () => {
  renderCombobox({ pages, query: "design" });
  expect(screen.getByText("Design Notes")).toBeInTheDocument();
  expect(screen.queryByText(/Create/)).toBeNull();
});

it("does not offer creation for whitespace", () => {
  renderCombobox({ pages: [], query: "   " });
  expect(screen.queryByText(/Create/)).toBeNull();
});
```

Update existing renders to supply `onCreate={vi.fn()}`.

- [ ] **Step 2: Run the combobox tests and verify RED**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/WikilinkCombobox.test.tsx
```

Expected: FAIL because `onCreate` and the create suggestion are not implemented.

- [ ] **Step 3: Add failing mouse and keyboard activation tests**

```tsx
it("activates creation by mouse", async () => {
  const onCreate = vi.fn();
  const user = userEvent.setup();
  renderCombobox({ onCreate });
  await user.click(screen.getByText('Create “New Topic”'));
  expect(onCreate).toHaveBeenCalledOnce();
  expect(onCreate).toHaveBeenCalledWith("New Topic");
});

it.each(["Enter", "Tab"])("activates creation with %s", (key) => {
  const onCreate = vi.fn();
  renderCombobox({ onCreate });
  fireEvent.keyDown(document, { key });
  expect(onCreate).toHaveBeenCalledWith("New Topic");
});
```

Add pending/error assertions:

```tsx
expect(screen.getByText("Creating…")).toBeInTheDocument();
expect(screen.getByText("Creation failed — press Enter to retry")).toBeInTheDocument();
```

- [ ] **Step 4: Implement the synthetic suggestion union**

Build `filteredPages`, then derive `suggestions`:

```ts
const trimmedQuery = query.trim();
const suggestions: WikilinkSuggestion[] =
  filteredPages.length > 0
    ? filteredPages.map((page) => ({ kind: "page", page }))
    : trimmedQuery
      ? [{ kind: "create", title: trimmedQuery }]
      : [];
```

Dispatch selection without placing API behavior in the component:

```ts
const selectSuggestion = (suggestion: WikilinkSuggestion) => {
  if (suggestion.kind === "page") onSelect(suggestion.page);
  else if (!isCreating) onCreate(suggestion.title);
};
```

Use stable keys (`page:${page.id}`, `create:${title}`), render existing page rows unchanged, and render create copy according to state. Keep `emptyMessage="Type a page name"` only for the empty-query case.

- [ ] **Step 5: Run combobox tests and verify GREEN**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/WikilinkCombobox.test.tsx
```

Expected: PASS for visibility, mouse, Enter, Tab, pending, error, positioning, and null-reference behavior.

- [ ] **Step 6: Commit Task 2**

```bash
git add ui/src/editor/WikilinkCombobox.tsx ui/src/editor/__tests__/WikilinkCombobox.test.tsx
git commit -m "feat(editor): add wikilink create suggestion"
```

---

### Task 3: Background Creation and Slate Insertion

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx:1-250,504-511`
- Create: `ui/src/editor/__tests__/SlateEditor.wikilink-create.test.tsx`

**Interfaces:**
- Consumes: `useResolveOrCreateWikilinkTarget().resolveOrCreate(target)` from Task 1 and `WikilinkCombobox` props from Task 2.
- Produces no new public API. `SlateEditor` continues to accept `initialValue`, `onChange`, and `onSaveNow`.
- Invariant: only the trigger object that initiated the request may receive the resulting Slate transform.

- [ ] **Step 1: Write a failing successful-creation editor test**

Create `SlateEditor.wikilink-create.test.tsx`. Mock `usePages` to return zero pages and mock the resolver hook. Render through a `QueryClientProvider` and `WikilinkResolutionProvider` only where the non-mocked child hooks require them. Use real `SlateEditor`, `Editable`, and combobox behavior.

Use these concrete helpers in the test file:

```tsx
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function findWikilinks(value: Descendant[]) {
  const links: Array<{ type: string; target: string }> = [];
  const visit = (node: Descendant) => {
    if ("type" in node && node.type === "wikilink") {
      links.push(node as { type: string; target: string });
    }
    if ("children" in node) {
      for (const child of node.children) visit(child as Descendant);
    }
  };
  for (const node of value) visit(node);
  return links;
}

function renderEditor() {
  const changes: Descendant[][] = [];
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={[
          { type: "paragraph", children: [{ text: "" }] } as Descendant,
        ]}
        onChange={(value) => changes.push(structuredClone(value))}
        onSaveNow={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return {
    user,
    editable: screen.getByRole("textbox"),
    latestChanges: () => changes.at(-1) ?? [],
  };
}
```

```tsx
it("creates in the background and inserts the requested wikilink", async () => {
  resolveOrCreateMock.mockResolvedValue({
    path: "notes/20260808.new-topic.a1B2c3D4.md",
    title: "New Topic",
  });
  const { user, editable, latestChanges } = renderEditor();

  await user.click(editable);
  await user.type(editable, "[[New Topic");
  await user.click(screen.getByText('Create “New Topic”'));

  await waitFor(() =>
    expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic"),
  );
  expect(screen.queryByText('Create “New Topic”')).toBeNull();
  expect(findWikilinks(latestChanges())).toContainEqual({
    type: "wikilink",
    target: "New Topic",
  });
});
```

- [ ] **Step 2: Run the editor test and verify RED**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/SlateEditor.wikilink-create.test.tsx
```

Expected: FAIL because `SlateEditor` does not pass or handle `onCreate`.

- [ ] **Step 3: Add failing failure, duplicate, and stale-completion tests**

```tsx
it("keeps the chooser and inserts nothing when creation fails", async () => {
  resolveOrCreateMock.mockRejectedValue(new Error("create failed"));
  const { user, editable, latestChanges } = renderEditor();
  await user.click(editable);
  await user.type(editable, "[[New Topic");
  await user.click(screen.getByText('Create “New Topic”'));

  await screen.findByText("Creation failed — press Enter to retry");
  expect(findWikilinks(latestChanges())).toEqual([]);
  expect(screen.getByText('Create “New Topic”')).toBeInTheDocument();
});

it("ignores repeat activation while creation is pending", async () => {
  const pending = deferred<ResolvedWikilinkTarget>();
  resolveOrCreateMock.mockReturnValue(pending.promise);
  const { user, editable } = renderEditor();
  await user.click(editable);
  await user.type(editable, "[[New Topic");
  await user.keyboard("{Enter}{Enter}");

  expect(resolveOrCreateMock).toHaveBeenCalledTimes(1);
  pending.resolve({ path: "notes/new-topic.md", title: "New Topic" });
});

it("does not insert into a trigger that changed while creation was pending", async () => {
  const pending = deferred<ResolvedWikilinkTarget>();
  resolveOrCreateMock.mockReturnValue(pending.promise);
  const { user, editable, latestChanges } = renderEditor();
  await user.click(editable);
  await user.type(editable, "[[First");
  await user.keyboard("{Enter}{Escape}");

  pending.resolve({ path: "notes/first.md", title: "First" });
  await act(async () => pending.promise);
  expect(findWikilinks(latestChanges())).toEqual([]);
});
```

- [ ] **Step 4: Generalize insertion to a target string and captured trigger**

Replace the page-shaped insertion closure with one primitive:

```ts
const insertWikilinkTarget = (
  target: string,
  trigger: ComboboxTrigger | null = wikilinkTrigger,
) => {
  if (!trigger || !editor.selection) return;
  const deleteRange = {
    anchor: trigger.anchor,
    focus: editor.selection.focus,
  };
  Transforms.select(editor, deleteRange);
  Transforms.delete(editor);
  Transforms.insertNodes(editor, makeWikilink({ target }));
  Transforms.move(editor);
  setWikilinkTrigger(null);
};

const insertWikilink = (page: PageSummary) =>
  insertWikilinkTarget(page.title ?? page.canonical_name);
```

Use the existing `PageSummary` import or the narrow existing type consistently; do not duplicate the transform.

- [ ] **Step 5: Implement pending/error state and stale-trigger protection**

Add:

```ts
const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();
const wikilinkTriggerRef = useRef<ComboboxTrigger | null>(null);
const wikilinkCreatePendingRef = useRef(false);
const [wikilinkCreatePending, setWikilinkCreatePending] = useState(false);
const [wikilinkCreateError, setWikilinkCreateError] = useState<string | null>(null);
```

Synchronize the trigger ref in an effect and clear an error when the query/anchor changes. The activation captures the current trigger object:

```ts
const createWikilinkTarget = async (title: string) => {
  if (wikilinkCreatePendingRef.current) return;
  const trigger = wikilinkTriggerRef.current;
  if (!trigger) return;
  wikilinkCreatePendingRef.current = true;
  setWikilinkCreatePending(true);
  setWikilinkCreateError(null);
  try {
    const result = await resolveOrCreate(title);
    if (wikilinkTriggerRef.current !== trigger) return;
    insertWikilinkTarget(result.title, trigger);
  } catch {
    if (wikilinkTriggerRef.current === trigger) {
      setWikilinkCreateError("Creation failed — press Enter to retry");
    }
  } finally {
    wikilinkCreatePendingRef.current = false;
    setWikilinkCreatePending(false);
  }
};
```

Before committing, verify React’s effect timing does not replace the captured trigger between click and request. If tests expose an ordering issue, store the active trigger ref at the same point `setWikilinkTrigger` receives a new trigger rather than weakening the stale-completion check.

Wire the combobox:

```tsx
<WikilinkCombobox
  pages={pages}
  query={wikilinkTrigger.query}
  reference={createSelectionReference(editor)}
  onSelect={insertWikilink}
  onCreate={(title) => void createWikilinkTarget(title)}
  onClose={() => setWikilinkTrigger(null)}
  isCreating={wikilinkCreatePending}
  createError={wikilinkCreateError}
/>
```

- [ ] **Step 6: Run editor integration tests and verify GREEN**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/SlateEditor.wikilink-create.test.tsx src/editor/__tests__/WikilinkCombobox.test.tsx src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx src/editor/__tests__/WikilinkElement.test.tsx
```

Expected: PASS with no act warnings, unhandled promise rejections, duplicate create calls, or target-tab opens.

- [ ] **Step 7: Run focused editor regression tests**

Run:

```bash
bun run --cwd ui test -- src/editor/__tests__/SlateEditor.vim-toggle.test.tsx src/editor/__tests__/WikilinkCombobox.test.tsx src/editor/__tests__/WikilinkElement.test.tsx src/components/codex/__tests__/WikilinkResolutionWiring.test.tsx
```

Expected: PASS; existing page selection, popover key handling, vim interception, Folio provider wiring, and dangling-link navigation remain intact.

- [ ] **Step 8: Commit Task 3**

```bash
git add ui/src/editor/SlateEditor.tsx ui/src/editor/__tests__/SlateEditor.wikilink-create.test.tsx
git commit -m "feat(editor): create pages from wikilinks"
```

---

### Task 4: Feature Verification and Documentation Check

**Files:**
- Modify only if behavior differs from the approved contract: `docs/superpowers/specs/2026-08-08-wikilink-create-cta-design.md`
- Verify: all Task 1–3 files.

**Interfaces:**
- Consumes the complete feature from Tasks 1–3.
- Produces a verified branch ready to merge into `develop`.

- [ ] **Step 1: Run the focused feature suite**

```bash
bun run --cwd ui test -- src/editor/__tests__/useResolveOrCreateWikilinkTarget.test.tsx src/editor/__tests__/WikilinkCombobox.test.tsx src/editor/__tests__/WikilinkElement.test.tsx src/editor/__tests__/SlateEditor.wikilink-create.test.tsx
```

Expected: every feature and retained dangling-link test passes.

- [ ] **Step 2: Run UI typecheck, lint, and complete tests**

```bash
bun run --cwd ui typecheck
bun run --cwd ui lint
bun run --cwd ui test
```

Expected: TypeScript exits 0; Biome exits 0; all Vitest files pass. Existing jsdom `scrollTo`/navigation notices are allowed only if the suite still exits 0.

- [ ] **Step 3: Run Rust repository gates**

```bash
cargo check --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

Expected: all commands exit 0. This feature changes no Rust code, but repository policy requires these gates.

- [ ] **Step 4: Build and smoke-test the production UI**

```bash
bun run --cwd ui build
```

Launch the application through the project’s normal development command, open an editable Folio, type a unique `[[<title>` that has zero matches, activate `Create “<title>”`, and verify:

1. the chooser closes after success;
2. the source Folio stays active;
3. the wikilink remains in the source editor;
4. the new blank note appears at a canonical `notes/<yyyymmdd>.<slug>.<shortid>.md` path;
5. clicking the resulting link resolves to that note;
6. repeating with an induced API failure leaves the chooser/query intact and inserts no link.

- [ ] **Step 5: Review spec and docs impact**

Compare the delivered behavior against `docs/superpowers/specs/2026-08-08-wikilink-create-cta-design.md`. No user documentation change is required: the feature is an in-context editor affordance and the existing docs already describe wikilink completion. Update the spec only if an approved behavior changed; do not add a second explanatory document.

- [ ] **Step 6: Commit any verification-driven corrections**

If verification required code or spec corrections, stage only those files and commit with a message describing the actual correction. If no files changed, do not create an empty commit.

- [ ] **Step 7: Merge and clean up**

After all reviews and gates pass, use the `finishing-a-development-branch` workflow to merge the feature branch into `develop`, preserving the Task 1–3 commits and the committed design specification. Remove the isolated worktree only after the merge is verified.
