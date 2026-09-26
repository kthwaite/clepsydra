# Stone & Lamp Phase 6 (Guard and Cleanup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Vessel guard covers the whole UI source tree, and the dead Vessel CSS, tokens and components are gone.

**Architecture:** The guard test walks `ui/src` instead of listing files. `main.css` defines the Stone & Lamp role tokens directly and drops every Vessel alias. A new CSS test fails when `main.css` defines a class no source file uses.

**Tech Stack:** Vitest source scans, Tailwind v4 `@theme`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` §6 phase 6, §3.1, §4.

## Global Constraints

- Token values stay as in spec §3.1. No colour changes on screen.
- The `.paper` class stays the bone switch (spec §4). Renaming to `data-theme` is out of scope.
- Hot text only on raise or ground (contrast rule from 5.4).
- Mono only for code (spec §3.2).
- Gates: `bun run typecheck`, `bun run lint`, `bun run test` from `ui/`.

## Review Focus

1. A token rename that misses a `var(--…)` inside `main.css` leaves a property unset. The page falls back to inherited or transparent colours with no test failure.
2. Stories and MDX are in the guard now. A story that still needs a dark frame must use `bg-ground` in `.paper`-free Storybook, not a Vessel colour.
3. Mermaid diagrams read tokens by name at render time. A stale name falls back silently to the fallback table.
4. The dead-class test must count uses in `.ts`, `.tsx`, `.mdx` and `index.html`, or it deletes live CSS.
5. Table cell editors change from a bordered mono input to a ring. The cell must not grow in height.

---

### Task 1: Guard walks the whole tree

**Files:** Modify `ui/src/__tests__/primitivesGuard.test.ts`.

- [ ] Replace the per-screen file lists with a recursive walk of `ui/src` over `.ts`, `.tsx` and `.mdx`. Exclude tests, `__tests__`, `routeTree.gen.ts` and `api/schema.d.ts`. Include stories.
- [ ] Keep an `ALLOW` map (file → rule names) for sanctioned mono uses. It starts empty.
- [ ] Add rules: legacy colour classes (`paper*`, `ink-mute`, `ink-faint`, `highlight`, `accent-deep`, `rule-soft`, `cool`, shadcn `background/foreground/card/popover/primary/secondary/muted/destructive/input`), Vessel `var()` names, and the font aliases `font-heading/body/slab/serif-sc`.
- [ ] Put today's offenders in `PENDING` and watch the suite pass with `it.fails` on them (RED for the tree).
- [ ] Commit.

### Task 2: Clean the offenders

**Files:** `components/ui/page-link.tsx`, `codex/Gazetteer.tsx`, `bases/CreateBaseDialog.tsx`, `bases/ArchiveRowDialog.tsx`, `bases/cells/types.ts`, `lib/kind.ts`, `lib/mermaid.ts`, `MarkdownRenderer.tsx`, stories; delete `TagCloud.tsx`, `BacklinksPanel.tsx` and their stories.

- [ ] Remove each file from `PENDING` first, watch it fail, then fix it.
- [ ] `text-destructive` → `text-hot`. `text-foreground` → `text-ink`. `decoration-border` → `decoration-rule`.
- [ ] `CELL_INPUT_CLASS`: sans, `ring-1 ring-inset ring-accent`, `bg-raise`, `rounded-[4px]`. Same padding, so the same height.
- [ ] `KIND_META` NOTE and ARCHIVE colours → `var(--mute)`.
- [ ] Mermaid reads the role names and the sans font. Its fallbacks become the charcoal values.
- [ ] `PENDING` is empty. Commit.

### Task 3: Role tokens are the source

**Files:** `ui/src/main.css`, `ui/src/__tests__/themeTokens.test.ts`.

- [ ] Test first: `:root` and `.paper` define `--ground/--raise/--sink/--mute/--faint/--accent-tint` as colours, and define none of `--paper*`, `--cool`, `--bar-*`, `--bg*`, `--ink-3/4`, `--ink-mute`, `--ink-faint`, `--highlight`, `--grid`, `--accent-deep`, `--rule-soft`, density vars. `@theme` has no Vessel or shadcn aliases.
- [ ] Rewrite the token blocks and every `var()` inside `main.css`.
- [ ] Commit.

### Task 4: Dead CSS

**Files:** `ui/src/main.css`, new `ui/src/__tests__/deadCss.test.ts`, `codex/CodexFrame.tsx`, tests that assert the stopgaps.

- [ ] Test first: every class selector in `main.css` appears in some `.ts/.tsx/.mdx` source file or `index.html`.
- [ ] Delete the unused `.cl-*` utilities and dead `.ai-conversation-turn*` rules. `CodexFrame` uses `bg-ground` instead of `.cl-paper`.
- [ ] Commit.

### Task 5: Docs

- [ ] `ui/CLAUDE.md` design section: phase 6 done; the guard covers the tree.
- [ ] Commit.
