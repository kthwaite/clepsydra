# Stone & Lamp Phase 5.6 — The rest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle every remaining Vessel surface — Docs, Constellation (desktop + mobile), the mobile Gazetteer, error/offline/boot states, Folio page/folder menus + attachments + mutation preview, agenda list — migrate the last `.cl-btn` call sites and Vessel variables, then delete the `.cl-btn` stopgap CSS.

**Architecture:** Presentation work across the files in the guard's `REST_FILES` plus five already-guarded files that still use `cl-btn` or Vessel variables. The guard now forbids `cl-btn`, `var(--cool|paper|bar-|ink-3|bg)` and `*-cool` utilities; all 34 offenders start in `PENDING`. Dead files (`Sidebar`, `PageList`, `PageHeader`) deleted in setup.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2, §3, §5.5, §5.6, §6 phase 5).

**Mockups:** canvas row p5r6 (v20) — `Constellation`, `Docs`, `ErrorStates`, `MobileConstellation`, `MobileGazetteer` (.dc.html in the session scratchpad `canvas5/project/`). Surfaces without a mockup follow the nearest restyled sibling (Folio rails, CodexModalShell dialogs, Gazetteer rows).

## Global Constraints
- Tokens only; `faint` decoration only; `rule` Sheaf only; no hex literals; no Vessel vars (`--cool` → `--accent`, `--paper` → `--ground`/`--raise` role names).
- Geist UI/meta; Instrument Serif titles/italic eyebrows with `Tick`; JetBrains Mono ONLY for code, inline code, `<kbd>`, and `data-code-editor` textareas.
- Sentence case; no uppercase/positive tracking/9–11px type/border separators/cl-mono/cl-serif/font-mono/paper-2/ink-mute/muted-foreground/cl-btn.
- Kinds display via `kindDisplayLabel` (sentence case).
- Dates with fixed month names (lib/time helpers).
- Buttons via `ui/button`; overlays raise, 16–18px radius, shadow; flex rows mixing button heights use `items-center`.
- Hot text only on raise/ground or ≤ `bg-hot/5`, never on sink.
- `<ul>` padding utilities now apply (base-layer `ul` indent) — set padding deliberately.
- Vessel-copy test assertions rewritten, not dropped. Behaviour, payloads, aria, keyboard unchanged unless named.
- Restyle only: mockup features the app lacks are NOT added.

## Review Focus
1. Docs: sidebar navigation, TOC scroll-spy, MDX components (code blocks, callouts/tables), search if any — behaviour unchanged.
2. Constellation: graph interactions (depth, filters, hubs, focus), canvas colours read from tokens in both themes.
3. Error states: RouteError details disclosure, retry/reload, offline page; boot sequence doesn't flash Vessel chrome.
4. Folio menus: page/folder actions (rename, move, delete with preview), attachments upload/delete, plaintext dialog.
5. `.cl-btn` removal: no remaining call site; FeedRiver/ReadingContinues buttons keep behaviour.

---
### Task 1: Guard + dead files — DONE in setup.
### Task 2 (A): Docs — `docs/{DocsArticle,DocsLayout,DocsMdxComponents,DocsScreen,DocsSidebar,DocsToc}.tsx`. Mockup Docs.
### Task 3 (B): Constellation — `codex/Constellation.tsx`, `codex/MobileConstellation.tsx`, `ForceGraph.tsx`, `routes/graph.tsx`. Mockups Constellation, MobileConstellation.
### Task 4 (C): Mobile Gazetteer + shell states — `codex/MobileGazetteer.tsx` (kinds sentence case), `codex/LocationModal.tsx`, `codex/BootSequence.tsx`, `routes/__root.tsx`, `FeatureFlagsProvider.tsx`, `FeatureGate.tsx`, `OfflineUnavailable.tsx`, `RouteError.tsx`, `routes/pages/$.tsx`. Mockups MobileGazetteer, ErrorStates.
### Task 5 (D): Folio menus + attachments — `page-tree/{FolderActionsMenu,PageActionsMenu,MutationPreviewDialog}.tsx`, `attachments/{AttachmentManager,PlaintextAttachmentDialog}.tsx`, `blocks/BlockTransclusion.tsx`, `FileTree.tsx`, `MarkdownRenderer.tsx`, and the recipe parse-failure banner in `codex/Folio.tsx`.
### Task 6 (E): Agenda + cl-btn/Vessel-var migration + CSS removal — `agenda/AgendaItemList.tsx`, `routes/agenda.tsx`, `codex/{FeedRiver,FeedRiverPanel,ReadingContinues}.tsx` (cl-btn → ui/button), `tasking/board-constants.tsx` + `ui/spark.tsx` (`--cool` → `--accent`), then delete `.cl-btn*` rules from `main.css` and their contract assertions (`buttonsCss.test.ts`, `themeFonts.test.ts`), plus `.ai-conversation-turn` `var(--cool)` → `var(--accent)`; `bases/ViewDefinitionEditor.tsx` warn list off sink.
### Task 7: Integrate — empty PENDING, gates, knip diff, docs, smoke, Opus review.
