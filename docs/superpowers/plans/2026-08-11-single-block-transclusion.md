# Single-Block Transclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `((block-id))` as the current referenced block content in both Slate and read-only Markdown while preserving a read-only, non-recursive, privacy-safe source reference.

**Architecture:** A remark transformer represents block references as a private `clepsydra-block:` link in `MarkdownRenderer`. One shared `BlockTransclusion` component owns lookup, rendering, retry, and navigation states; Slate’s inline void and the Markdown link renderer both delegate to it. Workspace tabs gain a transient block-focus request so activation opens and scrolls to the source block without copying source content into the referring page.

**Tech Stack:** React 19, TypeScript, Slate, react-markdown/unified/mdast, TanStack Query, Zustand workspace store, React Aria-compatible controls, Vitest/Testing Library, existing Rust block API.

## Global Constraints

- Render exactly one referenced block; never render descendants.
- Nested block-reference tokens remain inert and do not trigger nested fetches.
- Transclusion is read-only in Slate and read-only Markdown views.
- Serialization remains exactly `((block-id))`.
- Protected block identity/content remains undisclosed; missing and protected IDs share the unavailable state.
- Do not add server-side HTML expansion or duplicate source content into the referencing Markdown.
- Source changes refresh through existing index/SSE invalidation.
- Follow TDD and observe the intended failure before implementation.

---

### Task 1: Parse block references in read-only Markdown

**Files:**
- Create: `ui/src/lib/markdown/blockReferences.ts`
- Create: `ui/src/lib/markdown/blockReferences.test.ts`
- Modify: `ui/src/components/MarkdownRenderer.tsx:45-70`

**Interfaces:**
- Produces:

```ts
export const BLOCK_REFERENCE_SCHEME = "clepsydra-block:";
export function remarkBlockReferences(): (tree: Root) => void;
export function blockIdFromHref(href: string): string | null;
```

- The transformer splits text nodes on `/\(\(([A-Za-z0-9]{10,12})\)\)/g` and replaces matches with mdast `link` nodes whose URL is `clepsydra-block:<id>` and whose text is the original token.
- It does not transform code, inline code, existing links, HTML, or MDX expressions.

- [ ] **Step 1: Write failing AST tests**

```ts
it("turns standalone text references into private links", () => {
  const tree = parseAndTransform("Before ((abc123DEF0)) after");
  expect(tree.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { type: "text", value: "Before " },
      { type: "link", url: "clepsydra-block:abc123DEF0" },
      { type: "text", value: " after" },
    ],
  });
});

it("leaves code and existing link labels untouched", () => {
  const tree = parseAndTransform("`((abc123DEF0))` [((abc123DEF0))](x.md)");
  expect(findPrivateBlockLinks(tree)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the parser tests**

Run: `bun run --cwd ui test src/lib/markdown/blockReferences.test.ts`  
Expected: FAIL because the transformer does not exist.

- [ ] **Step 3: Implement the transformer without a new runtime dependency**

Walk mdast children recursively, but stop at `code`, `inlineCode`, `link`, `linkReference`, `html`, and MDX node types. Split only `text` nodes. Add the plugin to `remarkPlugins`. Preserve the private scheme in `transformMarkdownUrl`; do not allow arbitrary unknown schemes.

- [ ] **Step 4: Run parser and existing renderer tests**

Run: `bun run --cwd ui test src/lib/markdown/blockReferences.test.ts src/components/MarkdownRenderer.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/markdown/blockReferences.ts ui/src/lib/markdown/blockReferences.test.ts ui/src/components/MarkdownRenderer.tsx
git commit -m "feat(ui): parse block references in rendered Markdown"
```

### Task 2: Build the shared BlockTransclusion component

**Files:**
- Create: `ui/src/components/blocks/BlockTransclusion.tsx`
- Create: `ui/src/components/blocks/BlockTransclusion.test.tsx`
- Modify: `ui/src/api/blocks.ts:12-26`

**Interfaces:**
- Produces:

```ts
interface BlockTransclusionProps {
  blockId: string;
  onOpenSource: (block: BlockResponse) => void;
  className?: string;
}

export function blockDisplayContent(block: BlockResponse): string;
export function BlockTransclusion(props: BlockTransclusionProps): JSX.Element;
```

- `useBlock` exposes `data`, `isPending`, `isError`, and `refetch`; it does not retry 404 indefinitely.
- `blockDisplayContent` removes only the structural prefix/suffix represented by `block_type` and the exact terminal `^blockId`; it does not interpret nested Markdown or HTML.

- [ ] **Step 1: Write component-state tests**

```tsx
it("renders one block as read-only source content", () => {
  mockBlock({
    block_id: "abc123DEF0",
    block_type: "listitem",
    content: "- Important note ((nested1234)) ^abc123DEF0",
    page_path: "source.md",
    page_title: "Source",
    span_start: 10,
    span_end: 64,
    properties: {},
  });
  render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={onOpen} />);
  expect(screen.getByText("Important note ((nested1234))")).toBeVisible();
  expect(screen.queryByTestId("block-transclusion-nested")).toBeNull();
});

it("uses the same unavailable state for a 404", () => {
  mockBlockError(404);
  render(<BlockTransclusion blockId="unknown1234" onOpenSource={vi.fn()} />);
  expect(screen.getByText("Referenced block unavailable")).toBeVisible();
});
```

Also test loading, transient-error retry, accessible source button name, and no `dangerouslySetInnerHTML` path.

- [ ] **Step 2: Run focused tests**

Run: `bun run --cwd ui test src/components/blocks/BlockTransclusion.test.tsx`  
Expected: FAIL because the component is absent.

- [ ] **Step 3: Implement safe textual presentation**

Render source content as React text, not as a nested `MarkdownRenderer`. Use a `<span role="group">` with a button whose accessible name is `Open referenced block in <title/path>`. Render nested `((...))` text unchanged, guaranteeing no recursive query.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun run --cwd ui test src/components/blocks/BlockTransclusion.test.tsx`  
Run: `bun run --cwd ui typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/blocks/BlockTransclusion.tsx ui/src/components/blocks/BlockTransclusion.test.tsx ui/src/api/blocks.ts
git commit -m "feat(ui): render safe single-block transclusions"
```

### Task 3: Replace Slate’s ID token with the shared transclusion

**Files:**
- Modify: `ui/src/editor/elements/BlockRefElement.tsx`
- Create: `ui/src/editor/elements/BlockRefElement.test.tsx`
- Modify: `ui/src/editor/convert/mdast-to-slate.ts`
- Modify: `ui/src/editor/convert/slate-to-mdast.ts`
- Test: `ui/src/editor/__tests__/SlateEditor.embedded-readonly.test.tsx`

**Interfaces:**
- `BlockRefElement` delegates to `BlockTransclusion` and retains Slate’s required empty child.
- The outer inline void and every interactive descendant set `contentEditable={false}`.
- Round-trip remains `((blockId))`.

- [ ] **Step 1: Write the failing Slate rendering and round-trip tests**

```tsx
it("renders referenced content inside a non-editable inline void", () => {
  mockBlockContent("Referenced sentence");
  const { container } = renderBlockRef("abc123DEF0");
  expect(screen.getByText("Referenced sentence")).toBeVisible();
  expect(container.querySelector('[contenteditable="false"]')).not.toBeNull();
});

it("serializes rendered transclusion as the original reference", () => {
  const slate = markdownToSlate("See ((abc123DEF0)).");
  expect(slateToMarkdown(slate)).toContain("((abc123DEF0))");
  expect(slateToMarkdown(slate)).not.toContain("Referenced sentence");
});
```

- [ ] **Step 2: Run focused Slate tests**

Run: `bun run --cwd ui test src/editor/elements/BlockRefElement.test.tsx src/editor/__tests__/SlateEditor.embedded-readonly.test.tsx`  
Expected: FAIL because Slate still renders the block ID token.

- [ ] **Step 3: Integrate the shared component**

Keep `attributes` on the outer span and `children` as the final Slate child. Do not change the schema descriptor, `makeBlockRef`, or serialized node shape.

- [ ] **Step 4: Run editor tests**

Run: `bun run --cwd ui test src/editor/elements/BlockRefElement.test.tsx src/editor/__tests__/SlateEditor.embedded-readonly.test.tsx src/editor/__tests__/SlateEditor.selection-replacement.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/elements/BlockRefElement.tsx ui/src/editor/elements/BlockRefElement.test.tsx ui/src/editor/convert/mdast-to-slate.ts ui/src/editor/convert/slate-to-mdast.ts ui/src/editor/__tests__/SlateEditor.embedded-readonly.test.tsx
git commit -m "feat(editor): show block content for inline references"
```

### Task 4: Render shared transclusions in MarkdownRenderer

**Files:**
- Modify: `ui/src/components/MarkdownRenderer.tsx`
- Modify: `ui/src/components/MarkdownRenderer.test.tsx`

**Interfaces:**
- The custom `a` renderer detects only `clepsydra-block:<10-12 alphanumeric>` through `blockIdFromHref` and returns `BlockTransclusion`.
- Ordinary internal/external link behavior remains unchanged.

- [ ] **Step 1: Add failing renderer parity tests**

```tsx
it("renders block content for a block reference", async () => {
  mockBlock("abc123DEF0", "Rendered from source");
  render(<MarkdownRenderer content="Before ((abc123DEF0)) after" />);
  expect(await screen.findByText("Rendered from source")).toBeVisible();
});

it("does not recursively resolve a nested reference in source content", async () => {
  mockBlock("abc123DEF0", "Outer ((nested1234))");
  render(<MarkdownRenderer content="((abc123DEF0))" />);
  expect(await screen.findByText(/Outer \(\(nested1234\)\)/)).toBeVisible();
  expect(blockFetches()).toEqual(["abc123DEF0"]);
});
```

- [ ] **Step 2: Run renderer tests**

Run: `bun run --cwd ui test src/components/MarkdownRenderer.test.tsx`  
Expected: FAIL because private block links are still rendered as anchors.

- [ ] **Step 3: Delegate private block links to BlockTransclusion**

Call the same source-opening callback used by Slate. Reject malformed private URLs as ordinary inert text; never pass them to external anchors.

- [ ] **Step 4: Run renderer tests**

Run: `bun run --cwd ui test src/components/MarkdownRenderer.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/MarkdownRenderer.tsx ui/src/components/MarkdownRenderer.test.tsx
git commit -m "feat(ui): transclude blocks in read-only Markdown"
```

### Task 5: Navigate to and focus the source block

**Files:**
- Modify: `ui/src/hooks/useOpenTab.ts`
- Modify: `ui/src/store/workspace.ts`
- Modify: `ui/src/store/workspace.test.ts`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/components/codex/__tests__/FolioNavigation.test.tsx`
- Modify block element renderers under: `ui/src/editor/schema/elements/`

**Interfaces:**
- Produces:

```ts
export interface OpenTabTarget { blockId?: string }
openTab(type: TabType, path?: string, label?: string, target?: OpenTabTarget): void;
```

- `TabDescriptor` gains non-persisted `focusBlockId?: string`; workspace persistence strips it.
- Block-bearing editor elements render `data-block-id={element.blockId}`.
- Folio consumes the active tab’s focus request once, scrolls `[data-block-id="..."]` into view, focuses it when appropriate, then clears the request.

- [ ] **Step 1: Write store and Folio focus tests**

```ts
it("updates the focus request when reopening an existing page tab", () => {
  store.openTab("page", "source.md", "Source");
  store.openTab("page", "source.md", "Source", { blockId: "abc123DEF0" });
  expect(activeTab().focusBlockId).toBe("abc123DEF0");
});
```

In the Folio test, render an element with `data-block-id`, open the source target, assert `scrollIntoView` is called once, and assert the focus request is cleared.

- [ ] **Step 2: Run navigation tests**

Run: `bun run --cwd ui test src/store/workspace.test.ts src/components/codex/__tests__/FolioNavigation.test.tsx`  
Expected: FAIL because tabs cannot carry block focus.

- [ ] **Step 3: Implement transient focus targets**

Add a `clearTabFocus(tabId)` action. Exclude `focusBlockId` in the Zustand `partialize` persistence option so stale requests do not survive reload. Escape the ID before building a selector or locate elements by iterating `[data-block-id]` values.

- [ ] **Step 4: Run navigation and editor tests**

Run: `bun run --cwd ui test src/store/workspace.test.ts src/components/codex/__tests__/FolioNavigation.test.tsx src/editor/elements/BlockRefElement.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useOpenTab.ts ui/src/store/workspace.ts ui/src/store/workspace.test.ts ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/FolioNavigation.test.tsx ui/src/editor/schema/elements
git commit -m "feat(ui): focus source blocks from transclusions"
```

### Task 6: Refresh block queries and verify privacy end to end

**Files:**
- Modify: `ui/src/hooks/useVaultEvents.ts`
- Modify: `ui/src/hooks/useVaultEvents.test.tsx`
- Modify: `tests/e2e_block_refs_test.rs`

**Interfaces:**
- On `index_changed`, invalidate `queryKeys.blocks.all` in addition to page/index queries.
- The block API continues to return 404 for unknown and protected-body block IDs.

- [ ] **Step 1: Write failing invalidation and privacy tests**

```tsx
it("invalidates block details after an index change", () => {
  emitVaultEvent({ type: "index_changed", upserted: ["source.md"], removed: [] });
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.blocks.all });
});
```

Add a Rust E2E case with an encrypted page whose armored ciphertext contains a syntactically valid block ID and assert `/api/vault/blocks/<id>` returns 404.

- [ ] **Step 2: Run focused tests**

Run: `bun run --cwd ui test src/hooks/useVaultEvents.test.tsx`  
Run: `cargo test --test e2e_block_refs_test protected -- --nocapture`  
Expected: the invalidation test FAILS; the privacy test must PASS before UI work continues, or the indexing leak must be fixed at source.

- [ ] **Step 3: Add block-query invalidation**

Invalidate the exact `queryKeys.blocks.all` prefix on index changes. Do not poll block endpoints or add per-transclusion event listeners.

- [ ] **Step 4: Run smoke and repository gates**

Browser smoke:

1. Create a source block with an ID and a second page containing `((id))`.
2. Confirm identical content in Slate and read-only Markdown.
3. Edit the source and confirm the transclusion refreshes.
4. Activate it and confirm source block focus.
5. Delete the source and confirm `Referenced block unavailable` without changing the reference.

Then run:

- `cargo check --all-targets --all-features`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test --all-features`
- `bun run --cwd ui typecheck`
- `bun run --cwd ui lint`
- `bun run --cwd ui test`

Expected: all PASS; record unrelated baseline failures exactly if present.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useVaultEvents.ts ui/src/hooks/useVaultEvents.test.tsx tests/e2e_block_refs_test.rs
git commit -m "fix(ui): refresh transclusions after source changes"
```

## Acceptance

- Slate and read-only Markdown use the same transclusion states and source content.
- Only one block query occurs for a reference, even when its source text contains nested references.
- Referencing Markdown round-trips unchanged.
- Source activation opens and focuses the identified block.
- Source edits refresh; deletion becomes an unavailable state.
- Protected and unknown block IDs remain indistinguishable.
