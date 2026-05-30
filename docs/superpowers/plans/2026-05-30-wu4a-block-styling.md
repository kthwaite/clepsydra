# P2 — FOLIO Tactical Block Styling (WU-4a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Slate editor's block elements the Vessel dossier treatment — tactical **h2/h3 section rules**, **`▸` list bullets**, and **callout-styled blockquotes** — using the Vessel design tokens.

**Architecture:** All three changes live in the element render switch (`renderElement.tsx`). Pure presentational class changes against Vessel tokens (`text-ink`, `border-rule`, `bg-paper-2`, `text-accent`); no new modules, no CSS file changes (the `▸` bullet uses a Tailwind arbitrary list-style; the prose vertical rhythm is already handled by the WIP `:where(.codex-prose …)` rules in `main.css`).

**Tech Stack:** React 19, Slate (`RenderElementProps`), Tailwind v4 (tokens in `main.css`).

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-4** styling items (#132): tactical h2/h3 rules, `▸` bullets, callouts.

## Scope notes

- This plan covers **only** the heading / list / callout styling. The other WU-4 items are separate plans: code-block header + highlighting = **P3**; footnotes = **P4**. The editor bug-fixes (tag-Tab, ⌘S/autosave, pre-code spacing) are already done in the WIP.
- **Path-dedup (TODO #3) is treated as resolved**: the WIP removed the duplicated inline `<p>{path}</p>` and added a greyed filename placeholder; the path remaining in the left META area is intentional per spec #10 ("Document metadata: id/path"). Not in scope here.

## ⚠️ WIP + git rules

`renderElement.tsx` IS part of the user's in-flight WIP. Do NOT execute until that WIP is committed (stable base). When executing, touch + stage ONLY `ui/src/editor/elements/renderElement.tsx`; NEVER `git add -A`/`.`/`ui/`. Run `bun` from `ui/`. The string anchors match the current WIP snapshot of `renderElement.tsx`; if drifted, re-read and adapt — the target classes are what matter.

No unit test: `renderElement` is a Slate render switch with no pure-logic seam; RTL would require a Slate editor context (`ListItem` uses `useSlateStatic`). Verified via typecheck/build + manual smoke, per the project's pattern for render components.

## File structure

**Modify:** `ui/src/editor/elements/renderElement.tsx` — heading classes (h1–h6, section rules on h2/h3), `bulleted-list` (`▸`), `blockquote` (callout).

---

## Task 1: Restyle headings, bullets, and callouts

**Files:**
- Modify: `ui/src/editor/elements/renderElement.tsx`

- [ ] **Step 1: Tactical headings with h2/h3 section rules**

Replace:
```tsx
    case "heading": {
      const Tag = `h${element.level}` as const;
      const sizeClasses: Record<number, string> = {
        1: "mb-4 mt-8 font-heading text-2xl font-bold",
        2: "mb-3 mt-6 font-heading text-xl font-bold",
        3: "mb-2 mt-4 font-heading text-lg font-semibold",
        4: "mb-2 mt-4 font-heading text-base font-semibold",
        5: "mb-1 mt-3 font-heading text-sm font-semibold",
        6: "mb-1 mt-3 font-heading text-xs font-semibold",
      };
      return (
        <Tag {...attributes} className={sizeClasses[element.level]}>
          {children}
        </Tag>
      );
    }
```
with:
```tsx
    case "heading": {
      const Tag = `h${element.level}` as const;
      // Vessel tactical headings: Satoshi display; h2/h3 carry section rules.
      const headingClasses: Record<number, string> = {
        1: "mb-4 mt-8 font-sans text-[28px] font-black tracking-[-0.01em] text-ink",
        2: "mb-3 mt-8 border-t border-rule pt-3 font-sans text-[20px] font-bold text-ink",
        3: "mb-2 mt-6 border-t border-rule-soft pt-2 font-sans text-[16px] font-semibold text-ink",
        4: "mb-2 mt-4 font-sans text-[14px] font-semibold text-ink",
        5: "mb-1 mt-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2",
        6: "mb-1 mt-3 font-sans text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-mute",
      };
      return (
        <Tag {...attributes} className={headingClasses[element.level]}>
          {children}
        </Tag>
      );
    }
```

- [ ] **Step 2: Callout-styled blockquote**

Replace:
```tsx
    case "blockquote":
      return (
        <blockquote
          {...attributes}
          className="border-l-4 border-border pl-4 italic text-muted-foreground"
        >
          {children}
        </blockquote>
      );
```
with:
```tsx
    case "blockquote":
      return (
        <blockquote
          {...attributes}
          className="my-4 border-l-2 border-accent bg-paper-2 py-2 pl-4 pr-3 text-[0.97em] italic text-ink-2"
        >
          {children}
        </blockquote>
      );
```

- [ ] **Step 3: `▸` bullets for bulleted lists**

Replace:
```tsx
    case "bulleted-list":
      return (
        <ul {...attributes} className="list-disc pl-6">
          {children}
        </ul>
      );
```
with:
```tsx
    case "bulleted-list":
      return (
        <ul {...attributes} className="list-['▸'] pl-5 marker:text-accent">
          {children}
        </ul>
      );
```
(`list-['▸']` sets `list-style-type: '▸'`; `marker:text-accent` colors the glyph. This is a like-for-like swap of the previous `list-disc` — same list mechanics, new tactical bullet. Leave the `numbered-list` case as-is.)

- [ ] **Step 4: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass. (`build` compiles the CSS via Tailwind v4; confirm `list-['▸']` is accepted — it generates `list-style-type: '▸'`. If the toolchain ever rejects the arbitrary glyph, fall back to `list-none pl-5` plus a `main.css` rule `.cl-doc-ul > li::marker { content: "▸ "; color: var(--accent); }` applied via a `cl-doc-ul` class — but the Tailwind form is preferred and expected to work.) Errors referencing OTHER files are unrelated WIP — do not touch.

- [ ] **Step 5: Commit (stage ONLY renderElement.tsx)**

```bash
git add ui/src/editor/elements/renderElement.tsx
git commit -m "feat(editor): tactical heading rules, ▸ bullets, callout blockquotes"
```

---

## Task 2: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green (test count unchanged).

- [ ] **Step 2: Manual smoke (dev server)**

Run `cd ui && bun run dev`, open a folio containing headings, a bulleted list, and a blockquote, and confirm:
- `##`/`###` headings show a hairline **section rule** above them (full `--rule` for h2, lighter `--rule-soft` for h3); heading text is Satoshi.
- Bulleted lists use an accent-colored **`▸`** marker instead of a disc.
- Blockquotes render as a **callout**: left accent rule + `bg-paper-2` panel.
- Task-list checkboxes and numbered lists still render correctly.

- [ ] **Step 3: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-4 styling item | Task |
|---|---|
| Tactical h2/h3 section rules | Task 1 Step 1 |
| `▸` list bullets (replace `list-disc`) | Task 1 Step 3 |
| Callout-styled blockquote | Task 1 Step 2 |
| (Code header + highlighting → P3; footnotes → P4; path-dedup → resolved in WIP) | — |
