# Stone & Lamp Phase 4.4a — Folio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the desktop Folio screen to the Stone & Lamp mockup: meta line and serif title, tick-and-eyebrow rails with no rules, a consolidated left rail, stacked right-rail sections, and serif prose headings and pull quotes.

**Architecture:** Presentation-only changes in `components/codex/Folio.tsx` (layout, rails, header), `editor/PageEditorHeader.tsx`, `components/codex/FolioProperties.tsx`, the Folio error/empty screens, the `heading` and `blockquote` Slate element descriptors, and a `compact` variant of the `Section` primitive. No API changes. Unlinked mentions is out of scope (phase 4.4b, which needs a backend endpoint).

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components, Slate element descriptors, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§5.6 Folio; decisions 5, 6, 10; type scale table).

**Mockup:** canvas artboard `project/Main.dc.html` (Folio, 1440×960).

## User rulings (2026-09-25)

- Unlinked mentions: split out. 4.4a ships the restyle without it; 4.4b adds the endpoint and section.
- Right rail: no tabs. "Linked from" first (serif title + backlink context snippet), then "Links out" and "Similar" as `faint`-tick sections. The Tags tab goes; tags show in Properties.
- Left rail: consolidate. "On this page" first; "Properties" is a `dl` merging Document, Chronology and Vitals (Kind and Project stay editable); Attachments and Organization become `faint`-tick collapsible sections. The Open files accordion is removed (the Sheaf lists open pages).

## Global Constraints

- Tokens only: `ground`, `raise`, `sink`, `ink`, `ink-2`, `mute`, `faint`, `accent`, `accent-tint`, `hot`. No `uppercase`, positive `tracking-*`, `cl-mono`, `cl-serif`, `font-mono` (outside code), `border-rule`, `border-[…]`, bare `border`, `text-[9|10|11px]`, `ink-mute`, `paper-2` in guarded files.
- Instrument Serif regular/italic only, never bold. Geist for UI and prose.
- Every interactive control carries `FOCUS_RING` or `FOCUS_RING_NATIVE`.
- Keep every existing behaviour: rail collapse/resize (`useCollapsibleRail`, `FOLIO_LEFT_RAIL`/`FOLIO_RIGHT_RAIL`), ⌘[ / ⌘] chords, reading-column resizer, scroll-spy + `ReadingTicks`, KindSelect/ProjectCombo assignment, attachments, folder actions, raw markdown, encryption lock, archive tag editor, recipe/conversation bodies, mobile layout (it consumes the same `details`/`relationships`/`contents` nodes; mobile styling is phase 4b).
- Type scale: title Instrument Serif 56–60 / 1.02; prose Geist 17 / 1.7; rail eyebrows italic serif 18px `mute`.
- Columns 232 / fluid / 296 with 64px gaps, no column rules.

## Review Focus

1. Collapsing and expanding each rail (button and ⌘[ / ⌘]) still works and the stubs have accessible names.
2. KindSelect and ProjectCombo still assign from the Properties `dl`; attachments and folder actions still open.
3. Backlink snippet highlighting escapes nothing unsafely (render text nodes, never `dangerouslySetInnerHTML`) and handles a context without the match.
4. Headings and blockquotes restyle everywhere Slate renders (journal, bases previews), not just Folio — check they stay legible there.
5. Read-only, encrypted, archived and offline pages keep their notices and headers.

---

### Task 1: `Section` compact variant

**Files:** Modify `ui/src/components/codex/Section.tsx`; Test `ui/src/components/codex/__tests__/Section.test.tsx`.

**Produces:** `Section` prop `compact?: boolean` — eyebrow `font-serif text-[18px] italic text-mute`, header gap 2.5, section gap 3.5, body indent `pl-[17px]`.

- [ ] RED: test that `compact` renders the eyebrow with `text-[18px]`, `text-mute` and the body with `pl-[17px]`; default stays 22px `text-ink`.
- [ ] Implement; run `bun run test src/components/codex/__tests__/Section.test.tsx`.
- [ ] Commit `feat(ui): compact Section for rails`.

### Task 2: Prose headings and pull quotes

**Files:** Modify `ui/src/editor/schema/elements/heading.tsx`, `blockquote.tsx`; Test their existing tests (or `ui/src/editor/schema/elements/__tests__/proseStyle.test.tsx`, created — check none exists first); guard: add both files to `primitivesGuard.test.ts` (`PROSE_FILES`).

- [ ] RED: h1 `font-serif text-[40px]` no `font-black`; h2 `font-serif text-[30px] leading-[1.15]` with a child `[data-tick]` cobalt 8px square hung in the margin (`-ml-[22px]`, `aria-hidden`); h3 sans 19px semibold; h5/h6 no `uppercase`/`tracking`. Blockquote: no `border-l`, no fill; `relative pl-7 font-serif text-[25px] italic leading-[1.35] text-ink`, with an `aria-hidden` cobalt serif “ at `absolute -left-1.5 -top-3.5 text-[64px]`, `contentEditable={false}` and `select-none`. Guard lists the two files.
- [ ] Implement. The h2 tick is `contentEditable={false}` so Slate ignores it.
- [ ] Run `bun run test src/editor src/__tests__/primitivesGuard.test.ts`; fix any test asserting old heading classes.
- [ ] Commit `feat(ui): serif prose headings and pull quotes`.

### Task 3: Page header

**Files:** Modify `ui/src/components/codex/Folio.tsx` (`dossierHeader`, `ReadOnlyPageHeader`, `document` separators and END OF FILE footer), `ui/src/editor/PageEditorHeader.tsx`; Tests `Folio.test.tsx`, `PageEditorHeader.test.tsx`.

- [ ] RED: meta line reads `{kindLabel} · edited {relative time}` in 13px `mute` (no `/ {folioCode}`, no `uppercase`); SaveIndicator stays at the meta line's right; title textarea and read-only h1 are `font-serif text-[clamp(44px,4.2vw,60px)] leading-[1.02] tracking-[-0.015em]` and not `font-bold`; no `hr.cl-rule-dash` in the page; no "END OF FILE"; encrypted label sentence case "Encrypted" with a secondary `Button` "Lock"; lock error without "⁂"; ReadOnlyPageHeader tags/aliases as `bg-sink rounded-full` pills with sentence-case labels.
- [ ] Implement. Tags/aliases `TagInput`s stay under the title (editing lives there; Properties shows a read-only Tags row).
- [ ] Run `bun run test src/components/codex src/editor`; update tests that asserted "END OF FILE" absence/presence or "lock" text.
- [ ] Commit `feat(ui): Folio meta line and serif title`.

### Task 4: Rail frame

**Files:** Modify `Folio.tsx` (`DesktopFolioLayout`, `RailHeader`, `RailStub`, `Resizer`, `ReadingTicks`); Test `Folio.test.tsx`.

- [ ] RED: grid `gap-16` with `px-10 pt-16`, default rail widths 232 / 296; asides have no `border-r`/`border-l`; the left rail's first section header holds an `IconButton` "Hide left sidebar" (⌘[); collapsed stub is a 32px round `bg-sink` button "Show left sidebar"; same for right ("Hide/Show right sidebar", ⌘]); `ReadingTicks` inactive ticks `bg-faint`, rounded.
- [ ] Implement: remove `RailHeader`; pass `onCollapse` into the first rail section via props (`leftAction`/`rightAction` nodes). Resizer handles stay (restyled `rounded-full`).
- [ ] Run `bun run test src/components/codex`; update tests that queried "collapse META"/"expand META"/"collapse panel".
- [ ] Commit `feat(ui): Folio rail frame`.

### Task 5: Left rail — On this page, Properties, Attachments, Organization

**Files:** Modify `Folio.tsx` (`details`, `supplementalDetails`, `contents`; delete `Block`, `KV`, `OpenFilesAccordion`, `Section`(local), `OpenRow`); Test `Folio.test.tsx`, `FolioMeeting.test.tsx`, `FolioJournalDraft.test.tsx`.

- [ ] RED: left rail order is "On this page", "Properties", kind extras (label from `presentation.metaExtrasLabel ?? "Details"`), "Attachments", "Organization". "On this page" lists TOC entries as 14px buttons (active `text-ink`, others `text-mute`, depth indent 14px) with "No headings yet." empty text. "Properties" is a `dl` (`grid-cols-[64px_minmax(0,1fr)]`) with rows Kind (KindSelect), Project (ProjectCombo), ID, Created, Modified, Words, Tags (joined with " · ", "—" when none). Attachments and Organization use `faint` ticks and keep their toggles. No "Open files", "Vitals", "Chronology" or "Document" text.
- [ ] Implement with `Section compact`.
- [ ] Run `bun run test src/components/codex`; migrate the Vitals/Chronology test assertions to the Properties rows.
- [ ] Commit `feat(ui): Folio left rail consolidated`.

### Task 6: Right rail — Linked from, Links out, Similar

**Files:** Modify `Folio.tsx` (`relationships`, `LinkList`; delete `RTabBtn`, `RTab`, `R_TAB_KEY` state); Create `ui/src/components/codex/highlightMatch.tsx` (+ test).

**Produces:** `highlightMatch(text: string, needles: string[]): ReactNode` — splits `text` on the first case-insensitive occurrence of any non-empty needle, wrapping matches in `<mark className="rounded-[3px] bg-accent-tint px-0.5 text-ink-2">`; returns the text unchanged when none match.

- [ ] RED (`highlightMatch.test.tsx`): wraps a case-insensitive match; wraps multiple occurrences; ignores empty needles; returns plain text when nothing matches; treats regex metacharacters literally.
- [ ] RED (`Folio.test.tsx`): right rail shows "Linked from" with a count, each backlink as a serif 21px title link plus its `context` snippet with `target_raw`/page title highlighted; "No pages link here yet." when empty; "Links out" (`faint` tick) lists outlinks; "Similar" (`faint` tick) only when items exist; no tab buttons; `localStorage` key `clp.folio.r.tab` no longer read.
- [ ] Implement.
- [ ] Run `bun run test src/components/codex`.
- [ ] Commit `feat(ui): Folio right rail sections`.

### Task 7: FolioProperties and Folio states

**Files:** Modify `FolioProperties.tsx`, `FolioError.tsx`, `FolioNotFound.tsx`, `FolioLauncher.tsx`, `Folio.tsx` (`OfflineBodyNotice`, `ProtectedBodyNotice`); guard: add these five plus `Folio.tsx` and `editor/PageEditorHeader.tsx` to `FOLIO_FILES` in `primitivesGuard.test.ts`.

- [ ] RED: guard lists the files (they fail until restyled); notices are `rounded-xl bg-sink` with no border; ProtectedBodyNotice uses a secondary `Button`.
- [ ] Implement: sentence case, tokens, pills, `Section compact` where FolioProperties has a labelled block.
- [ ] Run `bun run test src/components/codex src/editor src/__tests__`.
- [ ] Commit `feat(ui): Folio properties and states`.

### Task 8: Gates, smoke, docs, review, merge

- [ ] Full UI suite, typecheck, lint.
- [ ] Smoke in bone and charcoal on the scratch vault: a page with h1–h3, a blockquote, backlinks with context, tags, attachments; collapse/expand both rails by button and chord; KindSelect assign; read-only (archived) page; journal page; mobile width renders.
- [ ] Docs: update Folio wording in `ui/src/docs/content/` (rail names: "On this page", "Properties", "Linked from"; no Backlinks/Links/Tags tabs).
- [ ] Final Opus review, fix pass, merge to develop, clean up, memory.
