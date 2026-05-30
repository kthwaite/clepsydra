# P1 — Wikilink Hover-Preview + `⟦ id · label ⟧` Vocabulary (WU-3 remainder)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route inline wikilinks through the existing `CLink` preview window manager (hover → preview, click → open) and render them in the `⟦ id · label ⟧` tactical vocabulary.

**Architecture:** `CLink` already implements the full hover→preview behavior: given a `path` prop, it schedules a 220ms hover that calls `openHover(path, rect)` into the preview window manager, and its default click opens the page tab. So `WikilinkElement` just needs to wrap its display in `<CLink path={element.target}>` and render the bracket-dot form as `CLink`'s children — replacing its current bare `onClick` span.

**Tech Stack:** React 19, Slate (`RenderElementProps`), the existing `CLink` (`#/components/codex/CLink`) + `store/preview` window manager (already mounted via `LinkPreviewLayer` in `__root.tsx`).

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-3** (#12 previews build on `CLink`; #132 wikilink vocabulary). The third WU-3 item — inline markdown links clickable — is already done (`LinkElement.tsx`).

## ⚠️ WIP + git rules

`WikilinkElement.tsx` is NOT currently in the user's WIP set, but `renderElement.tsx` (which renders it) IS. This plan edits ONLY `ui/src/editor/elements/WikilinkElement.tsx` — it does **not** need to touch `renderElement.tsx` (the wikilink element type is already wired there). Do NOT execute until the user's WIP is committed (stable base). When executing, touch + stage ONLY `WikilinkElement.tsx`; NEVER `git add -A`/`.`/`ui/`. Run `bun` from `ui/`. String anchors match the current `WikilinkElement.tsx`.

## Decisions (resolved)

- **`id` = `element.target`** (the wikilink target — the same value the current code passes to `openTab`), **`label` = `element.alias`** when present and different from target. Render `⟦ <id> · <label> ⟧`, or `⟦ <id> ⟧` when there's no distinct alias. (We don't have the resolved page UUID/short-id at render time; `CLink` fetches metadata lazily on hover. `target` is the stable, available identifier and matches existing open semantics.)
- **Preview = the window manager** (not the inline card): passing `path` to `CLink` triggers `openHover` (the pin/drag/minimize window), which is what #12 specifies. The inline `note` card only renders for payload-only `CLink`s.

## File structure

**Modify:** `ui/src/editor/elements/WikilinkElement.tsx` — wrap display in `CLink`, render bracket vocabulary, drop the manual `onClick`/`openTab` (CLink handles both).

No unit test: `WikilinkElement` is a Slate render component whose deps (`CLink` → `useOpenTab` → `useNavigate`) require a router context, making an isolated RTL test brittle; the `id`/`label` derivation is a trivial ternary. Verified via typecheck/build + manual smoke, per the project's pattern for render components.

---

## Task 1: Route `WikilinkElement` through `CLink` with bracket vocabulary

**Files:**
- Modify: `ui/src/editor/elements/WikilinkElement.tsx`

- [ ] **Step 1: Replace the component body**

Replace the entire current file:
```tsx
import type { RenderElementProps } from "slate-react";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const openTab = useOpenTab();
  const displayText = element.alias ?? element.target;

  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="inline cursor-pointer border border-border bg-muted px-1.5 text-sm hover:bg-accent"
        onClick={(e) => {
          e.preventDefault();
          openTab("page", element.target);
        }}
      >
        {displayText}
      </span>
      {children}
    </span>
  );
}
```
with:
```tsx
import type { RenderElementProps } from "slate-react";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const id = element.target;
  const label =
    element.alias && element.alias !== element.target ? element.alias : null;

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CLink
          path={element.target}
          className="cl-mono align-baseline text-[0.95em] text-ink hover:text-accent"
        >
          <span aria-hidden className="text-accent">
            ⟦
          </span>
          <span className="px-[2px]">{id}</span>
          {label && (
            <>
              <span aria-hidden className="text-ink-mute">
                ·
              </span>
              <span className="px-[2px] not-italic">{label}</span>
            </>
          )}
          <span aria-hidden className="text-accent">
            ⟧
          </span>
        </CLink>
      </span>
      {children}
    </span>
  );
}
```

Notes:
- `CLink` with `path={element.target}` provides the 220ms hover → preview window and the default click → `openTab("page", element.target)` — identical open semantics to the old code, plus the preview. No manual `useOpenTab`/`onClick` needed.
- The `contentEditable={false}` wrapper and trailing `{children}` preserve Slate's inline-void structure.
- The brackets `⟦`/`⟧` and `·` are `aria-hidden` decoration; the id/label carry the accessible text.

- [ ] **Step 2: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass; no unused imports (the old `useOpenTab` import is gone). Errors referencing OTHER files are unrelated WIP — do not touch.

- [ ] **Step 3: Commit (stage ONLY WikilinkElement.tsx)**

```bash
git add ui/src/editor/elements/WikilinkElement.tsx
git commit -m "feat(editor): wikilinks render ⟦id·label⟧ and summon CLink preview"
```

---

## Task 2: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green (test count unchanged).

- [ ] **Step 2: Manual smoke (dev server)**

Run `cd ui && bun run dev`, open a folio that contains a `[[wikilink]]` (and one with an alias, `[[target|Alias]]`), then confirm:
- The wikilink renders as `⟦ target ⟧` (no alias) or `⟦ target · Alias ⟧` (with alias), brackets in accent.
- Hovering the wikilink for ~220ms summons a **preview window** (the pin/drag/minimize card from the window manager), not just an inline tooltip.
- Clicking the wikilink opens the target page in a tab (unchanged behavior).

- [ ] **Step 3: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-3 requirement | Task |
|---|---|
| Wikilink hover (220ms) → preview window via `CLink`/preview store | Task 1 (`<CLink path=…>`) |
| `⟦ id · label ⟧` vocabulary | Task 1 (bracket render) |
| Click still opens the tab | Task 1 (`CLink` default click) |
| Inline markdown links clickable | Already done (`LinkElement.tsx`) |
