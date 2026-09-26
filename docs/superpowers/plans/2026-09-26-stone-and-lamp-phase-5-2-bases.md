# Stone & Lamp Phase 5.2 — Bases definition workspace + embed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Bases definition workspace (`/bases/$slug/edit`) and the editor's base embed (block chrome, generated region, inspector) to Stone & Lamp, per the approved phase 5 mockups.

**Architecture:** Presentation work in `ui/src/components/bases/*` and `ui/src/editor/elements/{BaseEmbedElement,GeneratedRegionElement}.tsx`, plus two approved behaviour changes: (1) the workspace's validation column renders only when there are diagnostics; (2) the embed inspector opens as a docked right-side panel instead of a centred modal. The source-scan guard is the gate: 28 files join `BASES_FILES`; the 22 that offend sit in `PENDING` until their task cleans them.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components, Slate, Vitest + Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2, §3, §5.5, §5.6).

**Mockups (visual authority):** canvas https://claude.ai/artifact/WAmCEdwj8osAmkLkRxGkQd row p5r2; local copies `scratchpad/canvas5/project/{BasesDefinition,BasesDefinitionViews,BaseEmbed}.dc.html`.

## Global Constraints

- Tokens only (`ground sink raise ink ink-2 mute faint rule accent accent-tint hot scrim`); `faint` never for informational text; `rule` only for the Sheaf.
- Geist UI 14–15px, meta 12.5–13px; Instrument Serif titles/italic eyebrows with `Tick`; mono only for code (YAML/markdown source editors keep mono).
- Sentence case; no `uppercase`, positive `tracking-*`, `text-[9–11px]`, `border*` separators, `cl-mono`/`cl-serif`/`font-mono` outside code, `paper-2`, `ink-mute`, Vessel CSS vars (`--ink-3 --bg --paper* --cool --warn --bar-*`), `cl-btn`.
- Buttons via `components/ui/button`; surfaces 12–16px radius; overlays 18px on `raise` with shadow.
- Vessel-copy assertions are rewritten, never dropped without replacement. Behaviour, payloads, aria, keyboard unchanged unless named below.
- Approved rulings: validation column hidden when clean; embed inspector docked right panel.

## Review Focus

1. Validation column must reappear the moment a diagnostic exists (and vanish when fixed) without layout jump losing editor focus.
2. Docked inspector: Escape closes, focus returns to the embed, editor stays scrollable/editable beside it; two embeds — opening the second replaces the first.
3. Docked inspector on narrow widths (768–1024px) must not cover the embed it edits entirely; falls back sensibly.
4. Mono stays on genuine source editors (YAML, template markdown) only.
5. Long property names / view names don't overflow the 12–16px-radius rows.

---

### Task 1: Guard entries — DONE in setup (28 files added, 22 PENDING).

### Task 2: Workspace shell
Files: `BaseDefinitionWorkspace.tsx`, `DefinitionHeader.tsx`, `ValidationSummary.tsx`, `GeneralEditor.tsx`, `BasePreview.tsx`, `BaseRenderedMarkdown.tsx`, `BaseMemberIntake.tsx` + tests. Mockup `BasesDefinition.dc.html`.
- [ ] Failing test: no validation column/region when diagnostics are empty; present with diagnostics.
- [ ] Restyle per mockup; remove files from the agent's vessel-check list; tests green.

### Task 3: Views
Files: `ViewsEditor.tsx`, `ViewDefinitionEditor.tsx`, `OrderedSortEditor.tsx`, `ordered-list.tsx`, `DisplayLabelsEditor.tsx` + tests. Mockup `BasesDefinitionViews.dc.html`.

### Task 4: Properties and filters
Files: `PropertiesEditor.tsx`, `PropertyDefinitionEditor.tsx`, `PreviewPropertiesEditor.tsx`, `BaseFilterEditor.tsx`, `FilterComparisonEditor.tsx`, `TagConditionEditor.tsx`, `TemplateSourceEditor.tsx` + tests. Mockups `BasesDefinition*.dc.html`.

### Task 5: Embed
Files: `BaseEmbedInspector.tsx`, `GeneratedPreviewDialog.tsx`, `editor/elements/BaseEmbedElement.tsx`, `editor/elements/GeneratedRegionElement.tsx` (+ `editor/baseEmbedEditing.tsx` if the dock needs it) + tests. Mockup `BaseEmbed.dc.html`.
- [ ] Failing tests: inspector renders as a non-modal docked panel (`role=dialog` without `aria-modal`, or `complementary` region) beside the editor; Escape closes and returns focus to the embed's edit control; editor content remains interactive while open.
- [ ] Restyle embed chrome ("Edit embed"/"Remove" sentence case) and generated region.

### Task 6: Integrate
- [ ] Empty `PENDING`; full gates (typecheck, lint, test, knip diff vs develop); docs for any changed label (`ui/src/docs/content` bases pages).
