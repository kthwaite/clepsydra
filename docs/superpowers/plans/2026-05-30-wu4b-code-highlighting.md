# P3 — Code-Block `CODE / LANG` Header + Syntax Highlighting (WU-4b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Slate code blocks a `CODE / LANG` header bar and **syntax highlighting** via Prism grammars (`refractor`), mapped onto Slate leaf decorations and colored with Vessel tokens.

**Architecture:** A pure `decorateCode([node, path])` function tokenizes a `code-block` element's text with `refractor` and returns Slate `Range`s carrying a `token` type. That function is passed to `<Editable decorate=…>` in `SlateEditor.tsx`. `renderLeaf` colors any leaf carrying a `token` via a token→CSS-var map (no stylesheet changes). `CodeBlockElement` gains the header bar.

**Tech Stack:** React 19, Slate (`decorate`, `RenderLeafProps`), **`refractor`** (Prism grammars → hast), Tailwind v4, Vitest.

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-4** code items (#132) + the syntax-highlighting decision (refractor/Prism).

## Verified facts (current code)

- `CodeBlockElement` (`types.ts:22`) is `{ type, language?, children: CustomText[] }`; `mdast-to-slate.ts:120` builds it as `children: [{ text: node.value }]` — **a single text child** holding the whole code (newlines included). So decoration ranges target child path `[...path, 0]` with offsets into that one text node.
- `<Editable renderElement renderLeaf onKeyDown …>` is mounted at `SlateEditor.tsx:518`; the `editor` is in scope. SlateEditor.tsx, types.ts, renderLeaf.tsx are **clean** (not in the user's WIP). `CodeBlockElement.tsx` **is** in the WIP (minor).
- `CustomText` (`types.ts:95`) has `bold/italic/underline/code/strikethrough`; renderLeaf wraps those. We add a `token` leaf prop.

## ⚠️ WIP + git rules

Do NOT execute until the user's WIP is committed (stable base). Files touched: `package.json` + lockfile, `ui/src/editor/types.ts`, new `ui/src/editor/decorate-code.ts` (+ test), `ui/src/editor/elements/renderLeaf.tsx`, `ui/src/editor/SlateEditor.tsx`, and `ui/src/editor/elements/CodeBlockElement.tsx` (the only one overlapping the WIP). Each task stages ONLY its own files; NEVER `git add -A`/`.`/`ui/`. Run `bun` from `ui/`.

## File structure

- **Create:** `ui/src/editor/decorate-code.ts` (`decorateCode`, `TOKEN_COLOR`) + `decorate-code.test.ts`.
- **Modify:** `ui/src/editor/types.ts` (add `token` to `CustomText` + `BaseRange`); `ui/src/editor/elements/renderLeaf.tsx` (color token leaves); `ui/src/editor/SlateEditor.tsx` (pass `decorate`); `ui/src/editor/elements/CodeBlockElement.tsx` (header bar); `ui/package.json` (+`refractor`).

---

## Task 1: Add `refractor`, type augmentation, and the `decorateCode` helper (TDD)

**Files:**
- Modify: `ui/package.json` (+ lockfile), `ui/src/editor/types.ts`
- Create: `ui/src/editor/decorate-code.ts`, `ui/src/editor/decorate-code.test.ts`

- [ ] **Step 1: Install refractor**

Run: `cd ui && bun add refractor`
Expected: `refractor` added to `package.json` dependencies (full bundle registers the common Prism languages, incl. javascript/json/python/etc.). Note: this is a deliberately broad grammar bundle — acceptable for the editor; a `refractor/core` + per-language registration could slim it later if bundle size matters.

- [ ] **Step 2: Augment types — `token` on `CustomText` and `BaseRange`**

In `ui/src/editor/types.ts`, add `token?: string;` to `CustomText`:
```tsx
export interface CustomText {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  code?: true;
  strikethrough?: true;
  /** Prism token type applied by code-block decorations (e.g. "keyword"). */
  token?: string;
}
```
And augment `BaseRange` so `decorate` may return ranges carrying `token`. In the `declare module "slate"` block, add a `BaseRange` interface alongside the existing `CustomTypes`:
```tsx
declare module "slate" {
  interface CustomTypes {
    Editor: CustomEditor;
    Element: CustomElement;
    Text: CustomText;
  }
  interface BaseRange {
    token?: string;
  }
}
```

- [ ] **Step 3: Write the failing tests**

Create `ui/src/editor/decorate-code.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decorateCode } from "./decorate-code";

const codeBlock = (language: string, text: string) => ({
  type: "code-block" as const,
  language,
  children: [{ text }],
});

describe("decorateCode", () => {
  it("returns [] for non-code-block nodes", () => {
    const para = { type: "paragraph", children: [{ text: "hi" }] };
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    expect(decorateCode([para as any, [0]])).toEqual([]);
  });

  it("returns [] for an unknown/unregistered language (no throw)", () => {
    const node = codeBlock("not-a-real-lang", "const x = 1;");
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    expect(decorateCode([node as any, [0]])).toEqual([]);
  });

  it("emits token ranges into child text 0 with correct offsets", () => {
    const node = codeBlock("javascript", "const x = 1;");
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const ranges = decorateCode([node as any, [3]]);
    expect(ranges.length).toBeGreaterThan(0);
    // every range points into [...path, 0]
    for (const r of ranges) {
      expect(r.anchor.path).toEqual([3, 0]);
      expect(r.focus.path).toEqual([3, 0]);
      expect(r.focus.offset).toBeGreaterThan(r.anchor.offset);
      expect(typeof r.token).toBe("string");
    }
    // "const" is a keyword at offset 0..5
    const kw = ranges.find((r) => r.anchor.offset === 0);
    expect(kw?.token).toBe("keyword");
    expect(kw?.focus.offset).toBe(5);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ui && bun run test src/editor/decorate-code.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `decorate-code.ts`**

Create `ui/src/editor/decorate-code.ts`:
```ts
import { refractor } from "refractor";
import { type NodeEntry, type Range, Element as SlateElement } from "slate";

/** Prism token type → Vessel colour CSS var, applied by renderLeaf. */
export const TOKEN_COLOR: Record<string, string> = {
  keyword: "var(--cool)",
  string: "var(--warn)",
  comment: "var(--ink-mute)",
  function: "var(--accent)",
  "class-name": "var(--accent)",
  number: "var(--accent-deep)",
  boolean: "var(--accent-deep)",
  constant: "var(--accent-deep)",
  operator: "var(--ink-2)",
  punctuation: "var(--ink-mute)",
  property: "var(--cool)",
  tag: "var(--cool)",
  "attr-name": "var(--accent-deep)",
  "attr-value": "var(--warn)",
  regex: "var(--warn)",
  builtin: "var(--accent)",
};

// Minimal hast shapes we read (avoid pulling @types/hast).
type HastNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      properties?: { className?: string[] };
      children: HastNode[];
    }
  | { type: "root"; children: HastNode[] };

/**
 * Slate `decorate` for code blocks: tokenize the block's text with refractor
 * and return ranges (anchored to child text 0) carrying a `token` type.
 */
export function decorateCode([node, path]: NodeEntry): Range[] {
  if (!SlateElement.isElement(node) || node.type !== "code-block") return [];
  const lang = node.language;
  if (!lang) return [];

  const text = node.children.map((c) => ("text" in c ? c.text : "")).join("");

  let root: HastNode;
  try {
    root = refractor.highlight(text, lang) as unknown as HastNode;
  } catch {
    return []; // unknown/unregistered language → plain (no highlighting)
  }

  const ranges: Range[] = [];
  let offset = 0;
  const textPath = [...path, 0];

  const visit = (n: HastNode, types: string[]) => {
    if (n.type === "text") {
      const len = n.value.length;
      if (len > 0 && types.length > 0) {
        ranges.push({
          anchor: { path: textPath, offset },
          focus: { path: textPath, offset: offset + len },
          token: types[types.length - 1],
        });
      }
      offset += len;
      return;
    }
    if (n.type === "element") {
      const classes = n.properties?.className ?? [];
      const tokenTypes = classes.filter((c) => c !== "token");
      const next = tokenTypes.length ? [...types, ...tokenTypes] : types;
      for (const child of n.children) visit(child, next);
      return;
    }
    if (n.type === "root") {
      for (const child of n.children) visit(child, types);
    }
  };

  visit(root, []);
  return ranges;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ui && bun run test src/editor/decorate-code.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck + commit (stage decorate-code, its test, types.ts, package.json, lockfile)**

Run: `cd ui && bun run typecheck` → clean.
```bash
git add ui/src/editor/decorate-code.ts ui/src/editor/decorate-code.test.ts ui/src/editor/types.ts ui/package.json ui/bun.lock
git commit -m "feat(editor): refractor code-decoration helper + token types"
```
(If the lockfile is named `bun.lockb`, stage that instead. Verify with `git status --porcelain ui/` that ONLY these files are staged — not other WIP.)

---

## Task 2: `CODE / LANG` header + token leaf rendering

**Files:**
- Modify: `ui/src/editor/elements/CodeBlockElement.tsx`, `ui/src/editor/elements/renderLeaf.tsx`

- [ ] **Step 1: Code-block header bar**

Replace the body of `ui/src/editor/elements/CodeBlockElement.tsx`:
```tsx
export function CodeBlockElement({ attributes, children, element }: Props) {
  return (
    <div {...attributes} className="cl-codeblock">
      <pre className="overflow-x-auto border border-border bg-muted p-4 font-mono text-sm">
        {element.language && (
          <span
            contentEditable={false}
            className="mb-2 block text-xs text-muted-foreground select-none"
          >
            {element.language}
          </span>
        )}
        <code>{children}</code>
      </pre>
    </div>
  );
}
```
with:
```tsx
export function CodeBlockElement({ attributes, children, element }: Props) {
  const lang = (element.language || "txt").toUpperCase();
  return (
    <div {...attributes} className="cl-codeblock border border-rule bg-paper-2">
      <div
        contentEditable={false}
        className="cl-mono flex select-none items-center justify-between border-b border-rule bg-paper px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute"
      >
        <span>Code</span>
        <span className="text-accent">{lang}</span>
      </div>
      <pre className="cl-noscroll overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.5] text-ink">
        <code>{children}</code>
      </pre>
    </div>
  );
}
```
(Keeps the `cl-codeblock` class — the WIP `main.css` rule gives it vertical breathing room. The header is `CODE` left, the language right in accent. The inline language span is removed in favor of the header.)

- [ ] **Step 2: Color token leaves in renderLeaf**

In `ui/src/editor/elements/renderLeaf.tsx`, add the import:
```tsx
import type { RenderLeafProps } from "slate-react";
import { TOKEN_COLOR } from "../decorate-code";
```
and add a `token` branch inside `renderLeaf`, before the final `return` (after the existing mark branches):
```tsx
  if (leaf.token) {
    children = (
      <span style={{ color: TOKEN_COLOR[leaf.token] ?? "inherit" }}>
        {children}
      </span>
    );
  }
  return <span {...attributes}>{children}</span>;
```
(Replace the existing final `return <span {...attributes}>{children}</span>;` with the block above so the `token` wrap is applied.)

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass. Errors referencing OTHER files are unrelated WIP — do not touch.

- [ ] **Step 4: Commit (stage ONLY the two element files)**

```bash
git add ui/src/editor/elements/CodeBlockElement.tsx ui/src/editor/elements/renderLeaf.tsx
git commit -m "feat(editor): code-block CODE/LANG header + token leaf colours"
```

---

## Task 3: Wire `decorate` into the editor

**Files:**
- Modify: `ui/src/editor/SlateEditor.tsx`

- [ ] **Step 1: Import `decorateCode`**

Add to the imports near the other `./elements/*` imports in `ui/src/editor/SlateEditor.tsx`:
```tsx
import { decorateCode } from "./decorate-code";
```

- [ ] **Step 2: Pass `decorate` to `<Editable>`**

Find:
```tsx
        <Editable
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          onKeyDown={handleKeyDown}
          placeholder="Start writing..."
          className="min-h-[200px] outline-none"
          spellCheck
        />
```
replace with:
```tsx
        <Editable
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          decorate={decorateCode}
          onKeyDown={handleKeyDown}
          placeholder="Start writing..."
          className="min-h-[200px] outline-none"
          spellCheck
        />
```
(`decorateCode` is a pure top-level function — no need to memoize. Slate calls it per node on each render; it early-returns `[]` for everything except code blocks with a language.)

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass.

- [ ] **Step 4: Commit (stage ONLY SlateEditor.tsx)**

```bash
git add ui/src/editor/SlateEditor.tsx
git commit -m "feat(editor): wire code-block syntax-highlight decoration"
```

---

## Task 4: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green (the new `decorate-code.test.ts` adds 3 tests).

- [ ] **Step 2: Manual smoke (dev server)**

Run `cd ui && bun run dev`, open a folio with a fenced code block (e.g. ```` ```js ````), and confirm:
- The block shows a header bar: `CODE` left, the language (e.g. `JS`) right in accent.
- Keywords/strings/comments/numbers are colored (keyword cyan, string amber, comment muted, etc.); editing the code re-highlights live.
- A code block with no/unknown language still renders cleanly (header shows `TXT` or the raw lang; body un-highlighted, no crash).

- [ ] **Step 3: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-4 code item | Task |
|---|---|
| Code blocks with `CODE / LANG` header bar | Task 2 Step 1 |
| Syntax highlighting via refractor/Prism + Slate decorations | Tasks 1, 2 (leaf colors), 3 (wire) |
| (Token colors via CSS vars — no stylesheet change) | Task 1 `TOKEN_COLOR` + Task 2 Step 2 |
