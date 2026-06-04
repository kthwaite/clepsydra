# Shared Block Conversions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated paragraph→block conversion logic (heading, lists, task, blockquote, code-block, thematic-break) shared by the autoformat plugin and the slash menu into one tested helper.

**Architecture:** A new pure-Slate module `ui/src/editor/transforms/blockConversions.ts` exposes `applyBlockConversion(editor, { at, deleteRange, conversion })`, which deletes the trigger/query text and converts the paragraph at `at` inside a single undo batch, always merging adjacent same-type lists. The autoformat `blockTransforms.ts` arms and the slash menu's `executeSlashCommand` switch collapse to thin dispatchers that build a `BlockConversion` and call the helper.

**Tech Stack:** TypeScript, Slate (`slate`, `slate-history`), Vitest, Bun. Run commands from `ui/`.

---

## File Structure

- **Create** `ui/src/editor/transforms/blockConversions.ts` — the `BlockConversion` type + `applyBlockConversion` helper + relocated `mergeWithAdjacentList`.
- **Create** `ui/src/editor/transforms/__tests__/blockConversions.test.ts` — direct unit tests for the helper.
- **Create** `ui/src/editor/__tests__/slashCommandToConversion.test.ts` — unit test for the id→conversion mapper.
- **Modify** `ui/src/editor/plugins/autoformat/blockTransforms.ts` — delegate to the helper; delete `applyListTransform`, `applyTaskListTransform`, `mergeWithAdjacentList`, `applyWithBatch`.
- **Modify** `ui/src/editor/SlateEditor.tsx` — add exported `slashCommandToConversion`; collapse `executeSlashCommand` to one helper call.

Existing tests (`blockTransforms.test.ts`, `withAutoformat.test.ts`, `inlineTransforms.test.ts`, slash tests) are the behavioral safety net and must stay green.

---

## Task 1: Create the `blockConversions` helper

**Files:**
- Create: `ui/src/editor/transforms/blockConversions.ts`
- Test: `ui/src/editor/transforms/__tests__/blockConversions.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `ui/src/editor/transforms/__tests__/blockConversions.test.ts`:

```ts
import { createEditor } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { applyBlockConversion } from "../blockConversions";

function editorWithParagraph(text: string) {
  const editor = withOutliner(withHistory(createEditor()));
  editor.children = [{ type: "paragraph", children: [{ text }] }];
  return editor;
}

function triggerRange(len: number) {
  return {
    anchor: { path: [0, 0], offset: 0 },
    focus: { path: [0, 0], offset: len },
  };
}

describe("applyBlockConversion", () => {
  it("BC-01: heading sets type + level and deletes trigger", () => {
    const editor = editorWithParagraph("##");
    applyBlockConversion(editor, {
      at: [0],
      deleteRange: triggerRange(2),
      conversion: { type: "heading", level: 2 },
    });
    const node = editor.children[0] as any;
    expect(node.type).toBe("heading");
    expect(node.level).toBe(2);
    expect(node.children[0].text).toBe("");
  });

  it("BC-02: bulleted-list wraps paragraph in list-item > paragraph", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, { at: [0], conversion: { type: "bulleted-list" } });
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].type).toBe("list-item");
    expect(list.children[0].children[0].type).toBe("paragraph");
  });

  it("BC-03: numbered-list produces an ordered list", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, { at: [0], conversion: { type: "numbered-list" } });
    expect((editor.children[0] as any).type).toBe("numbered-list");
  });

  it("BC-04: task produces a bulleted list-item with checked: false", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, { at: [0], conversion: { type: "task" } });
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children[0].checked).toBe(false);
  });

  it("BC-05: blockquote wraps the paragraph", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, { at: [0], conversion: { type: "blockquote" } });
    const bq = editor.children[0] as any;
    expect(bq.type).toBe("blockquote");
    expect(bq.children[0].type).toBe("paragraph");
  });

  it("BC-06: code-block sets type and language", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, {
      at: [0],
      conversion: { type: "code-block", language: "rust" },
    });
    const cb = editor.children[0] as any;
    expect(cb.type).toBe("code-block");
    expect(cb.language).toBe("rust");
  });

  it("BC-07: thematic-break sets type and inserts a trailing paragraph", () => {
    const editor = editorWithParagraph("");
    applyBlockConversion(editor, { at: [0], conversion: { type: "thematic-break" } });
    expect((editor.children[0] as any).type).toBe("thematic-break");
    expect((editor.children[1] as any).type).toBe("paragraph");
  });

  it("BC-08: a new bulleted-list merges with the adjacent list above", () => {
    const editor = withOutliner(withHistory(createEditor()));
    editor.children = [
      {
        type: "bulleted-list",
        children: [
          { type: "list-item", children: [{ type: "paragraph", children: [{ text: "a" }] }] },
        ],
      },
      { type: "paragraph", children: [{ text: "" }] },
    ];
    applyBlockConversion(editor, { at: [1], conversion: { type: "bulleted-list" } });
    expect(editor.children).toHaveLength(1);
    const list = editor.children[0] as any;
    expect(list.type).toBe("bulleted-list");
    expect(list.children).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && bun run vitest run src/editor/transforms/__tests__/blockConversions.test.ts`
Expected: FAIL — cannot resolve `../blockConversions` (module does not exist yet).

- [ ] **Step 3: Implement the helper**

Create `ui/src/editor/transforms/blockConversions.ts`:

```ts
import {
  type Editor,
  Node,
  Path,
  type Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import type { ListType } from "#/editor/plugins/listUtils";
import { makeBlockquote } from "#/editor/schema/elements/blockquote";
import {
  makeBulletedList,
  makeListItem,
  makeNumberedList,
} from "#/editor/schema/elements/list";
import { makeParagraph } from "#/editor/schema/elements/paragraph";

export type BlockConversion =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "bulleted-list" }
  | { type: "numbered-list" }
  | { type: "task" }
  | { type: "blockquote" }
  | { type: "code-block"; language?: string }
  | { type: "thematic-break" };

export interface ApplyBlockConversionOptions {
  /** Path of the paragraph block to convert. */
  at: Path;
  /** Trigger marker or `/query` text to remove before converting. */
  deleteRange?: Range;
  conversion: BlockConversion;
}

/**
 * Convert the paragraph at `opts.at` into the target block, deleting the
 * trigger/query text first. Runs as a single undo batch. Lists always merge
 * with an adjacent same-type sibling list.
 */
export function applyBlockConversion(
  editor: Editor,
  { at, deleteRange, conversion }: ApplyBlockConversionOptions,
): void {
  withBatch(editor, () => {
    if (deleteRange) {
      Transforms.delete(editor, { at: deleteRange });
    }

    switch (conversion.type) {
      case "heading":
        Transforms.setNodes(
          editor,
          { type: "heading", level: conversion.level } as any,
          { at },
        );
        break;
      case "bulleted-list":
        wrapInList(editor, at, "bulleted-list");
        break;
      case "numbered-list":
        wrapInList(editor, at, "numbered-list");
        break;
      case "task":
        wrapInList(editor, at, "bulleted-list", false);
        break;
      case "blockquote":
        Transforms.wrapNodes(editor, makeBlockquote({}), { at });
        break;
      case "code-block": {
        const props: Record<string, unknown> = { type: "code-block" };
        if (conversion.language) props.language = conversion.language;
        Transforms.setNodes(editor, props as any, { at });
        break;
      }
      case "thematic-break": {
        Transforms.setNodes(editor, { type: "thematic-break" } as any, { at });
        const nextPath = Path.next(at);
        Transforms.insertNodes(editor, makeParagraph({}), { at: nextPath });
        Transforms.select(editor, {
          anchor: { path: [...nextPath, 0], offset: 0 },
          focus: { path: [...nextPath, 0], offset: 0 },
        });
        break;
      }
    }
  });
}

function wrapInList(
  editor: Editor,
  at: Path,
  listType: ListType,
  checked?: boolean,
): void {
  const listPath = [...at];
  Transforms.wrapNodes(
    editor,
    makeListItem(checked === undefined ? { children: [] } : { children: [], checked }),
    { at },
  );
  Transforms.wrapNodes(
    editor,
    listType === "bulleted-list" ? makeBulletedList({}) : makeNumberedList({}),
    { at },
  );
  mergeWithAdjacentList(editor, listPath, listType);
}

/** Merge the list at `listPath` into an immediately-preceding same-type list. */
function mergeWithAdjacentList(
  editor: Editor,
  listPath: Path,
  listType: ListType,
): void {
  const index = listPath[listPath.length - 1];
  if (index > 0) {
    const prevPath = Path.previous(listPath);
    try {
      const prevNode = Node.get(editor, prevPath);
      if (
        SlateElement.isElement(prevNode) &&
        (prevNode as any).type === listType
      ) {
        const ourNode = Node.get(editor, listPath);
        if (!SlateElement.isElement(ourNode)) return;
        const count = ourNode.children.length;
        for (let i = count - 1; i >= 0; i--) {
          Transforms.moveNodes(editor, {
            at: [...listPath, i],
            to: [...prevPath, (prevNode as any).children.length],
          });
        }
        Transforms.removeNodes(editor, { at: listPath });
        return;
      }
    } catch {
      // no previous sibling
    }
  }
}

function withBatch(editor: Editor, fn: () => void): void {
  const histEditor = editor as unknown as HistoryEditor;
  if (typeof HistoryEditor.withNewBatch === "function") {
    HistoryEditor.withNewBatch(histEditor, () => {
      Editor.withoutNormalizing(editor, fn);
    });
  } else {
    Editor.withoutNormalizing(editor, fn);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && bun run vitest run src/editor/transforms/__tests__/blockConversions.test.ts`
Expected: PASS — all 8 cases (BC-01 … BC-08) green.

- [ ] **Step 5: Typecheck and format**

Run: `cd ui && bun run typecheck && bun run format`
Expected: no type errors; Biome reports clean (organized imports).

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/transforms/blockConversions.ts ui/src/editor/transforms/__tests__/blockConversions.test.ts
git commit -m "feat(editor): add shared applyBlockConversion helper"
```

---

## Task 2: Delegate autoformat block transforms to the helper

**Files:**
- Modify: `ui/src/editor/plugins/autoformat/blockTransforms.ts`
- Test (existing, must stay green): `ui/src/editor/plugins/autoformat/__tests__/blockTransforms.test.ts`

- [ ] **Step 1: Run the existing tests to establish a green baseline**

Run: `cd ui && bun run vitest run src/editor/plugins/autoformat/__tests__/blockTransforms.test.ts`
Expected: PASS (records current behavior before refactor).

- [ ] **Step 2: Add the helper import and a trigger-range helper**

In `ui/src/editor/plugins/autoformat/blockTransforms.ts`, add to the imports at the top:

```ts
import {
  applyBlockConversion,
  type BlockConversion,
} from "#/editor/transforms/blockConversions";
```

Add this local helper just below the `getBlockTriggerText` function:

```ts
/** Range spanning the leading trigger text in a block's first text node. */
function triggerRange(blockPath: Path, len: number) {
  return {
    anchor: { path: [...blockPath, 0], offset: 0 },
    focus: { path: [...blockPath, 0], offset: len },
  };
}
```

- [ ] **Step 3: Replace the conversion arms in `tryBlockTransform`**

In `tryBlockTransform`, replace the heading / numbered / bulleted / task / blockquote arms (everything from `// Heading: # through ######` down to the final `return false;`) with:

```ts
  // Heading: # through ######
  const headingMatch = text.match(HEADING_RE);
  if (headingMatch) {
    const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "heading", level },
    });
    return true;
  }

  // Numbered list: 1.
  if (NUMBERED_LIST_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "numbered-list" },
    });
    return true;
  }

  // Bulleted list: - or *
  if (BULLETED_LIST_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "bulleted-list" },
    });
    return true;
  }

  // Task list: [], [ ], [x], [X]
  if (TASK_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "task" },
    });
    return true;
  }

  // Blockquote: >
  if (BLOCKQUOTE_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "blockquote" },
    });
    return true;
  }

  return false;
```

Note: the old task arm read `taskMatch[1]` to set `checked`. The space-triggered task transform always created an unchecked item (`applyTaskListTransform` was only reached for a fresh paragraph), so `{ type: "task" }` (checked: false) preserves behavior. The checked case (`[x]`) is handled by `tryTaskPromotion` on an existing list-item, which is left untouched.

- [ ] **Step 4: Replace the body of `tryThematicBreak`**

Replace the `applyWithBatch(editor, () => { ... });` block inside `tryThematicBreak` with:

```ts
  applyBlockConversion(editor, {
    at: blockPath,
    deleteRange: triggerRange(blockPath, 2),
    conversion: { type: "thematic-break" },
  });
```

- [ ] **Step 5: Replace the body of `tryCodeFence`**

Replace the `applyWithBatch(editor, () => { ... });` block inside `tryCodeFence` with:

```ts
  applyBlockConversion(editor, {
    at: blockPath,
    deleteRange: triggerRange(blockPath, text.length),
    conversion: { type: "code-block", language },
  });
```

- [ ] **Step 6: Delete the now-dead helpers**

Remove these functions entirely from `blockTransforms.ts`: `applyListTransform`, `applyTaskListTransform`, `mergeWithAdjacentList`, and `applyWithBatch`. (`getCurrentBlock`, `getBlockTriggerText`, `tryTaskPromotion`, and the regex constants stay.)

- [ ] **Step 7: Run typecheck and remove unused imports**

Run: `cd ui && bun run typecheck`
Expected: TypeScript flags imports that are now unused (e.g. `Node`, `HistoryEditor`, `ListType` may no longer be referenced). Remove exactly the symbols TypeScript reports as unused. Keep any still referenced by `tryTaskPromotion` / `getCurrentBlock`.
Re-run until clean: `cd ui && bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Run the autoformat test suite**

Run: `cd ui && bun run vitest run src/editor/plugins/autoformat`
Expected: PASS — `blockTransforms.test.ts`, `withAutoformat.test.ts`, `inlineTransforms.test.ts`, `autoPair.test.ts`, `listContinuation.test.ts` all green.

- [ ] **Step 9: Format and commit**

```bash
cd ui && bun run format
git add ui/src/editor/plugins/autoformat/blockTransforms.ts
git commit -m "refactor(editor): delegate autoformat block transforms to shared helper"
```

---

## Task 3: Delegate the slash menu to the helper

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx`
- Test: `ui/src/editor/__tests__/slashCommandToConversion.test.ts`

- [ ] **Step 1: Write the failing mapper test**

Create `ui/src/editor/__tests__/slashCommandToConversion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { slashCommandToConversion } from "../SlateEditor";

describe("slashCommandToConversion", () => {
  it("SC-01: maps h1..h6 to heading levels", () => {
    expect(slashCommandToConversion("h1")).toEqual({ type: "heading", level: 1 });
    expect(slashCommandToConversion("h6")).toEqual({ type: "heading", level: 6 });
  });

  it("SC-02: maps list commands", () => {
    expect(slashCommandToConversion("bullet")).toEqual({ type: "bulleted-list" });
    expect(slashCommandToConversion("number")).toEqual({ type: "numbered-list" });
    expect(slashCommandToConversion("task")).toEqual({ type: "task" });
  });

  it("SC-03: maps quote, code, divider", () => {
    expect(slashCommandToConversion("quote")).toEqual({ type: "blockquote" });
    expect(slashCommandToConversion("code")).toEqual({ type: "code-block" });
    expect(slashCommandToConversion("divider")).toEqual({ type: "thematic-break" });
  });

  it("SC-04: returns null for an unknown id", () => {
    expect(slashCommandToConversion("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && bun run vitest run src/editor/__tests__/slashCommandToConversion.test.ts`
Expected: FAIL — `slashCommandToConversion` is not exported from `../SlateEditor`.

- [ ] **Step 3: Add the exported mapper to `SlateEditor.tsx`**

Add the import near the other `#/editor` imports in `ui/src/editor/SlateEditor.tsx`:

```ts
import {
  applyBlockConversion,
  type BlockConversion,
} from "#/editor/transforms/blockConversions";
```

Add this module-level function (outside the component, e.g. just above the component definition):

```ts
export function slashCommandToConversion(id: string): BlockConversion | null {
  switch (id) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return { type: "heading", level: Number.parseInt(id.slice(1), 10) as 1 | 2 | 3 | 4 | 5 | 6 };
    case "bullet":
      return { type: "bulleted-list" };
    case "number":
      return { type: "numbered-list" };
    case "task":
      return { type: "task" };
    case "quote":
      return { type: "blockquote" };
    case "code":
      return { type: "code-block" };
    case "divider":
      return { type: "thematic-break" };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the mapper test to verify it passes**

Run: `cd ui && bun run vitest run src/editor/__tests__/slashCommandToConversion.test.ts`
Expected: PASS — SC-01 … SC-04 green.

- [ ] **Step 5: Collapse `executeSlashCommand` to one helper call**

Replace the body of the `executeSlashCommand` `useCallback` (from the `if (!slashTrigger) return;` line through the closing of the `switch`/`setSlashTrigger(null);`) with:

```ts
    (cmd: SlashCommand) => {
      if (!slashTrigger) return;
      const { selection } = editor;
      if (!selection) return;

      const conversion = slashCommandToConversion(cmd.id);
      if (!conversion) {
        setSlashTrigger(null);
        return;
      }

      const entry = Editor.above(editor, {
        match: (n) => SlateElement.isElement(n) && n.type === "paragraph",
      });
      if (!entry) {
        setSlashTrigger(null);
        return;
      }

      applyBlockConversion(editor, {
        at: entry[1],
        deleteRange: { anchor: slashTrigger.anchor, focus: selection.focus },
        conversion,
      });
      setSlashTrigger(null);
    },
    [slashTrigger, editor],
```

This computes the paragraph path before mutating (deleting trigger text leaves the block path unchanged), then the helper performs delete + convert + merge in one batch. The slash menu now merges adjacent lists (intended behavior change) and gets single-step undo.

- [ ] **Step 6: Run typecheck and remove unused imports**

Run: `cd ui && bun run typecheck`
Expected: TypeScript flags symbols only used by the deleted switch (likely `makeBlockquote`, `makeCodeBlock`, `makeBulletedList`, `makeNumberedList`, `makeThematicBreak`, `makeParagraph`, `Path`, `Text`, `HeadingElement`, `ListItemElement`). Remove exactly those that TypeScript reports as unused; keep any still referenced elsewhere in the file (e.g. `makeWikilink`, `makeBlockRef` stay).
Re-run until clean: `cd ui && bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full editor test suite**

Run: `cd ui && bun run vitest run src/editor`
Expected: PASS — all editor tests, including the slash combobox tests and the new mapper test.

- [ ] **Step 8: Format and commit**

```bash
cd ui && bun run format
git add ui/src/editor/SlateEditor.tsx ui/src/editor/__tests__/slashCommandToConversion.test.ts
git commit -m "refactor(editor): route slash menu through shared block conversion helper"
```

---

## Task 4: Final verification

- [ ] **Step 1: Run the full UI test suite**

Run: `cd ui && bun run vitest run`
Expected: PASS — no regressions across the whole UI suite.

- [ ] **Step 2: Typecheck and lint the whole UI**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run: `cd ui && bun run dev`, open a page, and confirm in the editor:
- Markdown autoformat: `# ` → heading, `- ` → bullet, `1. ` → numbered, `[] ` → task, `> ` → quote, `---` → divider, ` ```rust ` + Enter → code block.
- Slash menu: `/` opens the menu; each command converts the paragraph; `/bullet` typed directly under an existing bullet list now joins it.
```
```

---

## Notes for the implementer

- **Why compute `entry[1]` before deleting in the slash path:** deleting text within a block's first text node does not change the block's path, so capturing it before the helper's internal delete is safe and avoids re-resolving after mutation.
- **`tryTaskPromotion` is intentionally not refactored:** it sets `checked` on an *existing* `list-item` (promotion within a list), which is not a paragraph→block conversion and has no duplicate in the slash menu.
- **List shape:** the helper produces the canonical `list > list-item > paragraph > text`. The existing `blockTransforms.test.ts` assertions (`list.children[0].children[0].type === "paragraph"`) confirm this shape survives the refactor.
