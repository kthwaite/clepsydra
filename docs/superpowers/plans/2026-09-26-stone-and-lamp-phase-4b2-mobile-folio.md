# Stone & Lamp phase 4b-2 — mobile Folio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Folio its Stone & Lamp phone layout: one reading bar (Back, group label, save state, details), the details bottom sheet with Outline / Properties / Linked tabs, a 3px reading-progress bar above the bottom bar, and a 38px page title.

**Architecture:** `MobileFolioLayout` is rewritten on the 4b-1 `BottomSheet` and the `ui/tabs` primitives. `Folio` passes it the active tab's quire (group label), its `SaveIndicator` (moved out of the header on mobile), and the Linked-from count. The layout reads `useReadingProgress()` for the bar. `MobileCodexFrame` drops its own top bar on the Folio view so the page bar is the only one. `PageEditorHeader` steps the title down to 38px below md.

**Tech Stack:** React 19, react-aria-components, zustand, Tailwind v4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` §9 Q3 ("Folio reading: back button, the page's group label, save state, and a details button. The details bottom sheet holds Outline, Properties and Linked. A 3px reading-progress bar sits above the bottom bar." "Type steps down: page title 38px … prose 17px."). Mockups: MobileFolio, MobileFolioSheet.

## Global Constraints

- User rulings: 4b = 4b-1 shell (merged 8fba1490) / 4b-2 Folio / 4b-3 screens.
- Guard test bans caps+tracking, mono, hard borders, 9–11px type in guarded files; tokens only. Touch targets ≥ 44px.
- Editing stays available on mobile (the existing Folio mobile tests keep passing: editable body, raw Markdown, scroll restoration, Back).

## Review Focus

1. A page tab with no quire, or whose quire was deleted: no group label, no crash.
2. Save error / revision conflict on mobile: the "Reload from disk" control must stay reachable in the bar.
3. Outline tap: jumps to the heading and closes the sheet (the sheet must not keep covering the target).
4. Properties tab must still reach Manage paths / archival (FolioNavigation "routes mobile home after archival").
5. Launcher (no page open) on mobile keeps the frame top bar (status, New note, Settings).

## Rulings made while planning

- The sheet opens on **Outline** by default (the mock shows Linked selected only to illustrate it).
- `SaveIndicator` is restyled to tokens (`text-mute`, `text-hot`) with a 6px dot; desktop keeps using it in the header, so both change together.
- The group label shows only for quire members; loose pages show nothing (the mock's "Research" is a quire).
- Properties tab = the existing `details` + `supplementalDetails` nodes, unchanged; Linked tab = the existing `relationships` node (Linked from, Unlinked mentions, Links out, Similar).
- Outline rows close the sheet after jumping.

---

### Task 1: SaveIndicator in tokens

**Files:** Modify `ui/src/editor/SaveIndicator.tsx`; Test `ui/src/editor/SaveIndicator.test.tsx` (create if absent — check first with `ls`).

- [ ] **Step 1:** Tests: status `saved` renders "Saved" with a dot (`[data-dot]`) `bg-accent`; `saving` "Saving…" (ellipsis char) with `animate-pulse`; `unsaved` "Unsaved changes" dot `bg-faint`; `error` "Save failed" `text-hot`. Also assert no `text-muted-foreground`/`text-destructive` class anywhere in the output.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement: wrapper `flex items-center gap-1.5 text-[12.5px] text-mute`; each state = `<span data-dot aria-hidden className="h-1.5 w-1.5 rounded-full …"/>` + word; conflict/error words `text-hot`; the Reload button keeps its behaviour with `text-hot underline underline-offset-2` + `FOCUS_RING_NATIVE`. Update any test asserting "Saving..." (`rg -l "Saving\.\.\." src --glob '*test*'`).
- [ ] **Step 4:** run SaveIndicator + Folio tests → PASS. Add `"../../editor/SaveIndicator.tsx"` to the guard's `MOBILE_FILES`; guard → PASS. **Step 5:** commit `feat(ui): SaveIndicator in Stone & Lamp tokens`.

### Task 2: MobileFolioLayout rewrite

**Files:** Modify `ui/src/components/codex/MobileFolioLayout.tsx`; rewrite `ui/src/components/codex/__tests__/MobileFolioLayout.test.tsx`.

**Interfaces:**
- Produces: `MobileFolioLayoutProps = { header, document, details, relationships, contents: ReactNode; onBack(): void; group: { name: string; color: string } | null; status: ReactNode; linkedCount: number }`.
- Consumes: `BottomSheet` (`components/ui/sheet`), `Tabs/TabList/Tab/TabPanel` (`components/ui/tabs`), `IconButton`, `useReadingProgress`.

Layout: root `flex h-full min-h-0 min-w-0 flex-col bg-ground` + the existing `[&_button]:min-h-11 [&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [&_select]:min-h-11` classes. `<nav aria-label="Page controls" className="cl-mobile-top flex h-14 shrink-0 items-center gap-1 pr-2.5 pl-2">`: `IconButton aria-label="Back"` (lucide `ChevronLeft`, `h-11 w-11`); group label when `group` (`<span className="flex min-w-0 items-center gap-1.5 font-serif text-[16px] italic" style={{ color }}>` + 6px dot `bg-current` + truncated name); `flex-1`; `status` in `<span className="shrink-0">`; `IconButton aria-label="Page details"` (lucide `AlignLeft`), `aria-haspopup="dialog"`. `<main aria-label="Page document">` as today (header `px-6 pt-4`, document). Progress: `<div aria-hidden data-testid="reading-progress" className="mx-6 mb-2.5 h-[3px] shrink-0 overflow-hidden rounded-full bg-rule"><span className="block h-full bg-accent" style={{ width: `${Math.round(clamp(progress)*100)}%` }} /></div>`.
Sheet: `BottomSheet aria-label="Page details"` with Modal className carrying the same min-h-11 selectors plus `[&_[role=option]]:min-h-11`; inside, `Tabs defaultSelectedKey="outline"`: `TabList aria-label="Details" className="grid grid-cols-3 gap-0.5 rounded-full bg-sink p-[3px]"`; three `Tab`s (`id` outline/properties/linked) styled as segments (`flex h-[34px] items-center justify-center rounded-full text-[14px] text-mute data-[selected]:bg-raise data-[selected]:font-medium data-[selected]:text-ink data-[selected]:no-underline data-[selected]:shadow-[0_1px_2px_rgb(14_26_58/0.08)] pb-0`), labels "Outline", "Properties", `Linked · {linkedCount}`; `TabPanel`s `pt-5` holding `contents`, `details`, `relationships`. The layout passes `onOutlinePicked` down? The Outline panel wraps `contents` in a `div` whose `onClick` closes the sheet when the click target is inside a `button` (`(e.target as Element).closest("button")`).

- [ ] **Step 1: Tests** (replace the file):
  - renders header + document in `main "Page document"`, details not rendered; Back calls `onBack`.
  - group label: `group={{ name: "Research", color: "var(--quire-ochre)" }}` → text "Research" in `navigation "Page controls"`; `group={null}` → absent.
  - `status={<span>Saved</span>}` appears in the bar.
  - "Page details" opens `dialog "Page details"`; tabs `Outline` (selected), `Properties`, `Linked · 3`; Outline panel shows contents; clicking `Properties` shows details; clicking `Linked · 3` shows relationships.
  - Outline: `contents={<button type="button">Heading one</button>}` → clicking it closes the dialog.
  - progress: mock `#/components/codex/ReadingProgressContext` → `{ progress: 0.38 }`; `getByTestId("reading-progress").firstElementChild` has `style.width === "38%"`.
  - keep the "sizes text fields without stretching checkbox and radio controls" test, opening via "Page details" and asserting on the dialog's Modal (`dialog.closest('[class*="min-h-11"]')` or assert on `document.querySelector('[data-rac][class*="rounded-t-3xl"]')`) — assert the selector classes exist on the sheet's modal element and not `[&_input]:min-h-11`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; add `"../codex/MobileFolioLayout.tsx"` to guard `MOBILE_FILES`, guard → PASS. **Step 5:** commit `feat(ui): mobile Folio reading bar and details sheet`.

### Task 3: Folio wiring, 38px title, frame top bar off on Folio

**Files:** Modify `ui/src/components/codex/Folio.tsx` (mobile branch + header save indicator), `ui/src/editor/PageEditorHeader.tsx`, `ui/src/components/codex/MobileCodexFrame.tsx`; tests `ui/src/components/codex/__tests__/Folio.test.tsx` ("Folio mobile presentation"), `FolioNavigation.test.tsx:1113`, `ui/src/components/codex/__tests__/CodexFrame.test.tsx`, PageEditorHeader test file (`rg -l PageEditorHeader src --glob '*test*'`).

- Folio: `const quire = useWorkspaceStore((s) => { const q = s.tabs.find((t) => t.id === tabId)?.quireId; return q ? s.quires[q] : undefined; })`; pass `group={quire ? { name: quire.name, color: quireColorVar(quire.color) } : null}`, `status={saveState}` where `saveState` is the existing conflict/SaveIndicator JSX extracted from `dossierHeader`; `linkedCount={linkedFrom.length}`. `dossierHeader` renders `saveState` only when `!mobile`.
- PageEditorHeader: both title classes get `max-md:text-[38px] max-md:leading-[1.04]`.
- MobileCodexFrame: render the `<header>` only when `view !== "folio"`.

- [ ] **Step 1: Tests:**
  - Folio.test mobile: replace "Document details"/"Page relationships" flows with "Page details" → `dialog "Page details"`, tab `Properties` shows the properties content previously asserted, tab `Linked · N` shows "Linked from"; the bar (`navigation "Page controls"`) contains "Saved" after load; the header (`main`) does not contain the save text.
  - FolioNavigation: `"Document details"` → click "Page details", then tab "Properties", then "Manage paths".
  - CodexFrame.test: at `/workspace` with an active page tab (`selectWorkspaceMode` → folio) mobile → no `banner`; at `/workspace` with no tabs (launcher) → banner present.
  - PageEditorHeader: title textbox has class `max-md:text-[38px]`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run those files + `src/components/codex` + `src/editor` → PASS; typecheck 0. **Step 5:** commit `feat(ui): wire the mobile Folio bar; 38px title`.

### Task 4: Docs and gates

- [ ] Update the "On a phone" section in `ui/src/docs/content/getting-started.mdx`: reading a page — Back, group, save state, details (Outline, Properties, Linked), progress bar. Fix any doc that names "Document details" / "Page relationships" (`rg -n "Document details|Page relationships" src/docs`).
- [ ] `bun run typecheck && bun run lint && bun run test` → 0 / clean / all pass. Commit `docs(ui): mobile Folio`.
