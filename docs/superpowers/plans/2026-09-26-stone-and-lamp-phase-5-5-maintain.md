# Stone & Lamp Phase 5.5 — Maintain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Maintain surfaces — Settings, the Rubbish bin, Reference repair, Conflict copies (list + compare/resolve), Stats and the keyboard-shortcut help — to Stone & Lamp per the approved phase 5 mockups.

**Architecture:** Presentation work in `components/SettingsModal.tsx` + `components/settings/*` + `codex/LocationForm.tsx`, `components/rubbish/*`, `components/repairs/*`, `components/conflicts/*`, `codex/Stats.tsx`, `StatCard.tsx`, `codex/ShortcutHelpModal.tsx`. The guard gets `MAINTAIN_FILES` (20 files; 15 offenders in `PENDING`). `.cl-btn` uses become `ui/button`.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2, §3, §5.5, §5.6 "Everything else").

**Mockups:** canvas rows p5r5 (v20) — `Settings`, `Rubbish`, `Repairs`, `Conflicts`, `Stats`, `ShortcutHelp` (.dc.html in the session scratchpad `canvas5/project/`).

## Global Constraints
- Tokens only; `faint` decoration only; `rule` Sheaf only; no hex literals; no Vessel vars (`--cool`, `--bar-*`, `--paper*` via Tailwind `bg-cool` etc.).
- Geist UI/meta; Instrument Serif titles/italic eyebrows with `Tick`; JetBrains Mono ONLY for code, inline code, diff line bodies and `data-code-editor` textareas.
- Sentence case; no uppercase/positive tracking/9–11px type/border separators/cl-mono/cl-serif/font-mono/paper-2/ink-mute/muted-foreground/cl-btn.
- Kinds display via `kindDisplayLabel` (lib/kind) — sentence case ("Note"), never KIND_META caps.
- Dates with fixed month names (lib/time `formatDayMonth` / `formatDayMonthYear` / `formatCapturedAt`).
- Buttons via `ui/button`; overlays raise, 16–18px radius, shadow.
- Alert text in `hot` sits on at most a 5% hot tint (`bg-hot/5`) or raise — never on sink (bone AA).
- Vessel-copy test assertions rewritten, not dropped. Behaviour, payloads, API values, aria, keyboard unchanged unless named.
- Restyle only: mockup features the app lacks are NOT added.
- Approved copy changes: Settings Mode labels "Bone" / "Night" (ids unchanged); Conflicts "Other" → "Remote" everywhere in UI copy ("Remote (conflict copy)", "All remote", keep-choice label "Remote"); choice id `"other"` and API payloads unchanged.

## Review Focus
1. Settings: theme mode/density switching, ⇧⌘\ shortcut hint, location form save/validation, index health and offline panels keep behaviour.
2. Rubbish: restore / delete permanently / empty bin confirmations, unreadable-item state, filter by kind.
3. Repairs: filters, pagination, preview → apply flow, create-page option, before/after rendering.
4. Conflicts: per-hunk keep choice, All local / All remote, result column, resolve payload unchanged, empty and error states.
5. Stats / shortcut help: numbers tabular, shortcut registry groups all listed, Esc closes.

---
### Task 1: Guard — DONE in setup.
### Task 2 (A): Settings — `SettingsModal.tsx`, `settings/{IndexHealthPanel,OfflinePanel}.tsx`, `codex/LocationForm.tsx` (moved up from 5.6 because Settings renders it). Mockup Settings.
### Task 3 (B): Rubbish — `rubbish/RubbishBin.tsx`. Mockup Rubbish.
### Task 4 (C): Repairs — `repairs/{RepairFilters,RepairIssueDetail,RepairIssueList,RepairWorkspace}.tsx`. Mockup Repairs.
### Task 5 (D): Conflicts — `conflicts/{ConflictDiffView,ConflictsPanel,DiffRows}.tsx`, `docs/content/sync.mdx`. Mockup Conflicts + "Remote" ruling.
### Task 6 (E): Stats + shortcuts — `codex/Stats.tsx`, `StatCard.tsx`, `codex/ShortcutHelpModal.tsx`. Mockups Stats, ShortcutHelp.
### Task 7: Integrate — empty PENDING, gates, knip diff, docs for changed labels, smoke, Opus review.
