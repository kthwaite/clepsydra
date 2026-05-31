# Editor Superscript / Subscript Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `superscript` and `subscript` as boolean leaf marks to the Slate editor, serialised as inline HTML `<sup>`/`<sub>` — mirroring the existing `underline` (`<u>`) mark end-to-end, including round-trip and toggle.

**Architecture:** Two new boolean leaf props. Render wraps text in `<sup>`/`<sub>`. `slate→mdast` emits inline `html` nodes (like `<u>`); `mdast→slate` strips inline `<sup>`/`<sub>` and recognises block-level `<sup>…</sup>` (the two underline inbound paths). Keyboard toggles mirror the bold handler. Avoids the `~`-syntax collision (single `~` is strikethrough here) by using HTML, not a markdown shortcut. `abbr` is **out of scope** (it carries a title — a data-bearing inline element, not a cheap mark).

**Tech Stack:** Slate + slate-react, mdast (remark), TypeScript, Vitest.

**Reference:** the `underline` mark is the template — every change below mirrors it. Touch points: `ui/src/editor/schema/types.ts:113-117`, `ui/src/editor/convert/slate-to-mdast.ts:104-106`, `ui/src/editor/convert/mdast-to-slate.ts:25,141-150`, `ui/src/editor/elements/renderLeaf.tsx`, `ui/src/editor/SlateEditor.tsx:441`.

**Depends on:** nothing.

---

## Task 1: Add the marks to the leaf schema

**Files:**
- Modify: `ui/src/editor/schema/types.ts` (the leaf text type, ~:113-117)
- Modify: `ui/src/editor/convert/mdast-to-slate.ts` (the local `LeafText` type, ~:25)
- Test: covered by Task 5's round-trip; no standalone test

- [ ] **Step 1: Add the props in `types.ts`**

After `strikethrough?: true;` (`types.ts:117`):

```ts
  superscript?: true;
  subscript?: true;
```

- [ ] **Step 2: Add to the converter's leaf type in `mdast-to-slate.ts`**

After `underline?: true;` (`mdast-to-slate.ts:25`):

```ts
  superscript?: true;
  subscript?: true;
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: clean (new optional props don't break anything yet).

- [ ] **Step 4: Commit**

```bash
git add ui/src/editor/schema/types.ts ui/src/editor/convert/mdast-to-slate.ts
git commit -m "feat(editor): superscript/subscript leaf mark types"
```

---

## Task 2: Render the marks

**Files:**
- Modify: `ui/src/editor/elements/renderLeaf.tsx`
- Test: `ui/src/editor/elements/renderLeaf.test.tsx` (extend if it exists; else covered manually)

- [ ] **Step 1: Write/extend the failing test**

If `renderLeaf` has a test, add:

```tsx
it("wraps superscript and subscript leaves", () => {
  // mirror existing leaf-render assertions in this file
  const sup = renderLeafFor({ text: "2", superscript: true });
  expect(sup).toContain("sup"); // rendered as <sup>
  const sub = renderLeafFor({ text: "2", subscript: true });
  expect(sub).toContain("sub");
});
```

> `renderLeafFor` stands for whatever harness the existing leaf tests use. If `renderLeaf` is untested, skip this step and verify visually in Storybook.

- [ ] **Step 2: Wrap in `<sup>`/`<sub>`**

In `renderLeaf.tsx`, where `underline` wraps children (mirror that exact spot), add wrapping for the new marks:

```tsx
if (leaf.superscript) children = <sup>{children}</sup>;
if (leaf.subscript) children = <sub>{children}</sub>;
```

> Match the existing children-wrapping idiom in this file (it may reassign `children` or compose spans). Place these alongside the `underline`/`strikethrough` wrapping.

- [ ] **Step 3: Verify + commit**

Run: `cd ui && bun run test renderLeaf && bun run typecheck`
Expected: pass / clean.

```bash
git add ui/src/editor/elements/renderLeaf.tsx
git commit -m "feat(editor): render superscript/subscript leaves"
```

---

## Task 3: Serialise to inline HTML (`slate → mdast`)

**Files:**
- Modify: `ui/src/editor/convert/slate-to-mdast.ts` (~:96-106, where `underline` emits `<u>`)
- Test: `ui/src/editor/convert/slate-to-mdast.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it("serialises superscript and subscript as inline html", () => {
  const sup = leafToMdast({ text: "2", superscript: true }); // match the real fn name
  // mirror how the underline test asserts the <u>/<\/u> html wrapping
  expect(JSON.stringify(sup)).toContain("<sup>");
  const sub = leafToMdast({ text: "2", subscript: true });
  expect(JSON.stringify(sub)).toContain("<sub>");
});
```

> Use the actual leaf-conversion function name from this file (the one that handles `underline` at :104). If marks are applied inline within a larger function, write the test at that function's boundary as the underline test does.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test slate-to-mdast`
Expected: FAIL.

- [ ] **Step 3: Emit `<sup>`/`<sub>` mirroring `<u>`**

In `slate-to-mdast.ts`, just after the `underline` wrapping (`:104-106`), add the same pattern for the two new marks:

```ts
if (leaf.superscript) {
  node = {
    type: "html",
    value: "<sup>",
  } as unknown as PhrasingContent;
  // ...mirror the exact 3-part wrap the underline branch uses:
  // [ {html:"<sup>"}, innerNode, {html:"</sup>"} ]
}
```

> Reproduce the **exact** structure the `underline` branch uses (it wraps the current `node` between `{type:"html", value:"<u>"}` and `{type:"html", value:"</u>"}`). Do the same with `<sup>`/`</sup>` and `<sub>`/`</sub>`. Keep the mark application order consistent with underline so nested marks serialise predictably.

- [ ] **Step 4: Run + commit**

Run: `cd ui && bun run test slate-to-mdast`
Expected: PASS.

```bash
git add ui/src/editor/convert/slate-to-mdast.ts ui/src/editor/convert/slate-to-mdast.test.ts
git commit -m "feat(editor): serialise sup/sub leaves to inline <sup>/<sub> html"
```

---

## Task 4: Parse back (`mdast → slate`) — inline + block paths

**Files:**
- Modify: `ui/src/editor/convert/mdast-to-slate.ts` (the inline-html `<u>` strip path; the block-html regex at ~:141-150)
- Test: `ui/src/editor/convert/mdast-to-slate.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it("parses inline <sup>/<sub> back into marks", () => {
  const nodes = mdToSlate("H<sub>2</sub>O and x<sup>2</sup>"); // match real fn name
  // expect a leaf with subscript:true containing "2", and one with superscript:true
  const leaves = flattenLeaves(nodes);
  expect(leaves.some((l) => l.subscript && l.text === "2")).toBe(true);
  expect(leaves.some((l) => l.superscript && l.text === "2")).toBe(true);
});
```

> `mdToSlate`/`flattenLeaves` stand for the file's real conversion entry + a test helper; mirror the existing underline inbound test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test mdast-to-slate`
Expected: FAIL.

- [ ] **Step 3: Mirror BOTH underline inbound paths**

There are two, per the comments at `:141-150`:

1. **Inline path** — wherever inline `html` nodes `<u>`/`</u>` are stripped and turned into the `underline` mark, add the same handling for `<sup>`/`</sup>` (→ `superscript`) and `<sub>`/`</sub>` (→ `subscript`). Grep this file for where it matches `<u` / `</u` inline and extend the same matcher.

2. **Block path** — at `:149`, beside the underline block regex:

```ts
const underlineMatch = value.match(/^<u\s*>([\s\S]*?)<\/u\s*>$/i);
```

add:

```ts
const supMatch = value.match(/^<sup\s*>([\s\S]*?)<\/sup\s*>$/i);
const subMatch = value.match(/^<sub\s*>([\s\S]*?)<\/sub\s*>$/i);
```

and handle them by re-emitting the inner content as a paragraph/leaf with `superscript`/`subscript` set — mirroring exactly how `underlineMatch` is handled immediately below it.

- [ ] **Step 4: Run + commit**

Run: `cd ui && bun run test mdast-to-slate`
Expected: PASS.

```bash
git add ui/src/editor/convert/mdast-to-slate.ts ui/src/editor/convert/mdast-to-slate.test.ts
git commit -m "feat(editor): parse inline + block <sup>/<sub> into marks"
```

---

## Task 5: Round-trip lock

**Files:**
- Test only: add a round-trip test next to the converter tests

- [ ] **Step 1: Write the round-trip test**

```ts
it("round-trips sup/sub through slate and back", () => {
  const md = "x<sup>2</sup> and H<sub>2</sub>O";
  const out = slateToMd(mdToSlate(md)); // match the real fn names
  expect(out).toContain("<sup>2</sup>");
  expect(out).toContain("<sub>2</sub>");
});
```

- [ ] **Step 2: Run**

Run: `cd ui && bun run test`
Expected: PASS (depends on Tasks 3 + 4).

- [ ] **Step 3: Commit**

```bash
git add ui/src/editor/convert
git commit -m "test(editor): lock sup/sub markdown round-trip"
```

---

## Task 6: Keyboard toggles

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx` (~:441, the bold toggle handler)
- Test: covered by the existing key-handling tests if present; else manual

- [ ] **Step 1: Add toggle handling mirroring bold**

At the key handler that toggles `bold` (`SlateEditor.tsx:441`), add cases for superscript and subscript on chosen chords (e.g. `Mod+.` → superscript, `Mod+,` → subscript — common in editors, and free here):

```tsx
// inside the same onKeyDown / hotkey block as bold:
if ((e.metaKey || e.ctrlKey) && e.key === ".") {
  e.preventDefault();
  const marks = Editor.marks(editor);
  if (marks?.superscript) Editor.removeMark(editor, "superscript");
  else Editor.addMark(editor, "superscript", true);
}
if ((e.metaKey || e.ctrlKey) && e.key === ",") {
  e.preventDefault();
  const marks = Editor.marks(editor);
  if (marks?.subscript) Editor.removeMark(editor, "subscript");
  else Editor.addMark(editor, "subscript", true);
}
```

> Match the exact structure the bold handler uses at :441 (it reads `marks` then `Editor.removeMark`/`Editor.addMark`). Place these in the same block. If sup and sub should be mutually exclusive, removing the opposite mark when adding one is a reasonable nicety — optional.

- [ ] **Step 2: Verify + commit**

Run: `cd ui && bun run typecheck && bun run lint && bun run test`
Expected: all pass.
Manual: select text, `⌘.` → superscript; `⌘,` → subscript; toggling off restores plain text; save → reload shows `<sup>`/`<sub>` preserved.

```bash
git add ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): Mod+. / Mod+, toggle superscript / subscript"
```

---

## Final verification

- [ ] `cd ui && bun run typecheck && bun run lint && bun run test` — all pass.
- [ ] Manual: type `E = mc` then `⌘.` `2` → `E = mc²`-style superscript; `H` `2` (`⌘,`) `O` → subscript; save and reopen — marks survive (round-trip via `<sup>`/`<sub>`).

---

## Notes for the executor

- **Mirror `underline` exactly** at all four sites (schema, render, `slate→mdast`, `mdast→slate` ×2 paths). If you find yourself inventing a new serialisation shape, stop and copy the underline branch.
- **`abbr` is deliberately excluded.** It carries an expansion title, so it's a data-bearing inline element (like footnotes/wikilinks), not a boolean mark. If wanted later, build it on the inline-element pattern, not here.
- No markdown shortcut uses `~` — single `~` is strikethrough in this editor. Superscript/subscript are HTML-only by design; that's why there's no `^…^`/`~…~` input rule.
