# Strikethrough Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require an explicitly typed closing tilde before single-tilde strikethrough is applied.

**Architecture:** Preserve the existing inline transform, selected-text wrapping, and overtype paths. Narrow only the collapsed-selection branch of `tryAutoPair` so `~` falls through to Slate's literal insertion path instead of generating a closer.

**Tech Stack:** TypeScript, Slate, slate-history, Vitest

**Spec:** `docs/superpowers/specs/2026-08-13-strikethrough-preview-design.md`

## Global Constraints

- Collapsed `~` insertion produces one literal tilde and no generated closer.
- Selected-text wrapping with `~` remains supported.
- Explicit `~text~` conversion remains supported.
- `*` and `_` auto-pairing remains unchanged.
- No parser, serializer, renderer, schema, dependency, or unrelated editor changes.

---

### Task 1: Require an explicit strikethrough closer

**Files:**
- Modify: `ui/src/editor/plugins/autoformat/autoPair.ts:27-78`
- Test: `ui/src/editor/plugins/autoformat/__tests__/autoPair.test.ts:75-138`
- Test: `ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts:546-565`

**Interfaces:**
- Consumes: `tryAutoPair(editor: Editor, ch: string): boolean` and `withAutoformat(editor: Editor): Editor`
- Produces: unchanged interfaces with a narrower collapsed-selection contract for `ch === "~"`

- [ ] **Step 1: Write the failing unit regression**

Replace the collapsed-tilde auto-pair expectation with:

```ts
it("does not auto-pair ~ at a collapsed selection", () => {
  const editor = editorWith("", 0);
  const result = tryAutoPair(editor, "~");
  expect(result).toBe(false);
  expect(getText(editor)).toBe("");
  expect(getCursorOffset(editor)).toBe(0);
});
```

Keep the existing selected-text `~` wrapping test unchanged.

- [ ] **Step 2: Write the failing integration regression**

Add beside the existing strikethrough integration test:

```ts
it("keeps strikethrough literal until the closing ~ is typed", () => {
  const editor = makeEditor();
  type(editor, "~hello");
  const para = editor.children[0] as any;
  expect(Node.string(para)).toBe("~hello");
  expect(para.children.some((leaf: any) => leaf.strikethrough)).toBe(false);
});
```

- [ ] **Step 3: Run RED tests**

Run:

```bash
bun run test -- src/editor/plugins/autoformat/__tests__/autoPair.test.ts src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
```

Expected: both new assertions fail because the opening tilde currently generates a closing tilde.

- [ ] **Step 4: Implement the minimal production correction**

At the start of the collapsed-selection branch in `tryAutoPair`, add:

```ts
if (ch === "~") return false;
```

Do not remove `~` from `AUTO_PAIR_CHARS`; selected-text wrapping relies on that set.

- [ ] **Step 5: Run GREEN tests**

Run the same focused Vitest command. Expected: both files pass, including existing selected-text wrapping and explicit `~hello~` conversion coverage.

- [ ] **Step 6: Review the diff**

Confirm only the two tests, the one collapsed-branch guard, this plan, and its design document changed. Confirm no compatibility shim, duplicate path, or unrelated refactor was added.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-08-13-strikethrough-preview-design.md docs/superpowers/plans/2026-08-13-strikethrough-preview.md ui/src/editor/plugins/autoformat/autoPair.ts ui/src/editor/plugins/autoformat/__tests__/autoPair.test.ts ui/src/editor/plugins/autoformat/__tests__/withAutoformat.test.ts
git commit -m "fix(editor): require explicit strikethrough closer"
```
