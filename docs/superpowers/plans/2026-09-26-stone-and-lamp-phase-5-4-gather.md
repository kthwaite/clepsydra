# Stone & Lamp Phase 5.4 — Gather — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Gather surfaces — the feed reader, feed subscriptions, the archive viewer, the Academic library and book import — to Stone & Lamp per the approved phase 5 mockups.

**Architecture:** Presentation work in `components/codex/Feed*`, `ArchiveBanner`, `routes/{feeds,archive.$,academic}.tsx`, `components/academic/*` and `components/books/*`. The guard gets a `GATHER_FILES` list (13 files); the 12 offenders sit in `PENDING` until cleaned. `.cl-btn` uses in these files become `ui/button` / `ui/icon-button`.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2, §3, §5.5, §5.6 "Everything else").

**Mockups:** canvas row p5r4 (v20) — `Feeds`, `FeedsManage`, `ArchiveViewer`, `Academic`, `BookImport` (.dc.html in the session scratchpad `canvas5/project/`).

## Global Constraints
- Tokens only; `faint` decoration only; `rule` Sheaf only; no hex literals.
- Geist UI/meta; Instrument Serif titles/italic eyebrows with `Tick`; JetBrains Mono ONLY for code, inline code and source textareas marked `data-code-editor`.
- Sentence case; no uppercase/positive tracking/9–11px type/border separators/cl-mono/cl-serif/font-mono/paper-2/ink-mute/muted-foreground/Vessel vars/cl-btn.
- Buttons via `ui/button`; overlays raise, 16–18px radius, shadow.
- Dates use fixed month names (`formatDayMonth` style: "18 Sep"), never ICU short months ("Sept").
- Vessel-copy test assertions rewritten, not dropped. Behaviour, payloads, aria, keyboard unchanged unless named.
- Restyle only: mockup features the app lacks (e.g. "Saved", "Edit tags", annotations) are NOT added.
- User ruling: the archive viewer frame is minimal — the original ArchiveBanner structure (48px strip: "Captured record", collapsed title, chevron toggle, "Back to vault page"; collapsible small title + live URL + provenance `dl`), new styling, full-bleed snapshot, thin `hot` warning strip. No card, no big serif title.

## Review Focus
1. Feed reader: keyboard entry navigation (j/k etc.), mark read/all read, facet filters and the reader pane keep behaviour.
2. Feed management: subscribe, edit, delete, OPML import/export, diagnostics rendering, group combobox keyboard.
3. Archive viewer: collapse state persists (`clepsydra.archive-banner-collapsed`), invalid URL still shown in `hot`, iframe sandbox/CSP untouched, error states restyled.
4. Academic: import dialog (DOI/ISBN/Zotero) errors, work detail edits, library filters.
5. Book import: ISBN validation message, barcode scanner states (permission denied, unsupported).

---
### Task 1: Guard — DONE in setup (commit "test(ui): guard Gather files…").
### Task 2 (A): Feed reader — `routes/feeds.tsx`, `codex/FeedReaderPane.tsx`, `codex/FeedFacetSelect.tsx`. Mockup Feeds.
### Task 3 (B): Feed subscriptions — `codex/FeedManagement.tsx`, `codex/FeedGroupComboBox.tsx`. Mockup FeedsManage.
### Task 4 (C): Archive viewer — `codex/ArchiveBanner.tsx`, `routes/archive.$.tsx`, plus `lib/time.ts` `formatCapturedAt(iso)` → "18 Sep 2026, 14:02" (test first; invalid → input unchanged). Mockup ArchiveViewer + user ruling.
### Task 5 (D): Academic — `routes/academic.tsx`, `academic/{AcademicLibrary,ImportDialog,WorkDetail}.tsx`. Mockup Academic.
### Task 6 (E): Book import — `books/{BookImportModal,BookBarcodeScanner}.tsx`. Mockup BookImport.
### Task 7: Integrate — empty PENDING, gates, knip diff, docs for changed labels, smoke, Opus review.
