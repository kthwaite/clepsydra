# Clepsydra "Vessel" Redesign — Implementation Plan

**Date:** 2026-05-29
**Branch:** `feat/clepsydra-vessel-redesign` (off `develop`)
**Source:** Claude Design handoff bundle `pkm/` (10 chat transcripts + HTML/CSS/JS prototype), design id `ZhWvR_3_G7CFNrOUwW1QDw`.
**Goal:** Replace the existing "Codex" design system wholesale with the prototype's **classified-technical-modernism** ("Vessel") aesthetic — on the existing app foundation.

This plan is the contract produced by a relentless decision-tree interview. Every section below is a *resolved* decision, not an open question.

---

## 0. The two systems (why this is a reskin, not a rebuild)

The existing app and the prototype are **structural twins with opposite surfaces**. Almost every prototype view has a 1:1 counterpart already built:

| Prototype | Existing | Role |
|---|---|---|
| Splash / Daystart | **Atrium** | Home dashboard |
| Dossier reader | **Folio** | Document reader/editor (PRIMARY) |
| Archive (all-notes table) | **Gazetteer** (tag grid) | Index |
| Graph (radar) | **Constellation** (D3-force) | Knowledge graph |
| Field-log register | **Diurnal** | Journal |
| Status | (Settings) | System/prefs |
| Recent tabs | **Sheaf** | Open-file tabs |
| Command palette | **CommandPalette** | ⌘K |

So we keep the architecture and swap the aesthetic + add the prototype's signature interaction surfaces.

---

## 1. Resolved decisions (the 20)

1. **Scope:** Full visual reskin on the existing foundation. Codex aesthetic entirely gone; data model, Slate editor, TanStack routes, React Aria primitives, API client all survive. Fidelity target ~90%.
2. **Diegesis:** Tactical chrome, **real data underneath**. Keep the terminal visual language; wire all telemetry to real corpus data. **Drop the pure fiction:** fake agent ID, clearance level, invented coordinates, custody mug-shot. **Keep as decoration:** vessel name, classification-style section headers, radar/sonar motifs (where applicable). Scanlines dropped (see #5).
3. **Typography:** Two families. **JetBrains Mono** = all chrome/UI/labels/telemetry. **Satoshi** (Fontshare, self-hosted) = everything proportional — prose (400/500) and display/headings/brand (700/900). **Drop** Space Grotesk and all serif (Cormorant/Spectral/EB Garamond). Reader prose defaults to **sans (Satoshi)**.
4. **Palette + mode:** Adopt the prototype's exact hex palette. **Dark is the base `:root` / default.** Keep a "paper" light mode via the existing `ThemeProvider`. Barbican orange accent in both modes.
5. **Overlays:** **Dropped entirely.** No scanlines, vignette, or grain. Flat dark terminal, maximal text clarity.
6. **Ticker:** Keep a slim, single-line **real-data telemetry strip** as its own rail (sync pip · notes · links · tags · orphans/unresolved · indexed-today · uptime · live UTC). Static row, clock ticks each second. Hidden when diegetic chrome is toggled off.
7. **Vocabulary:** **Keep the scholarly lexicon** (ATRIUM / FOLIO / GAZETTEER / CONSTELLATION / DIURNAL / SHEAF; system = CLEPSYDRA), rendered in tactical mono-uppercase, letter-tracked, with index numbers (`FOLIO / 01`) and an accent slash. Internal component filenames unchanged.
8. **FOLIO read/edit:** **One surface** — the styled Slate editor *is* the dossier reader, always editable in place. No reading/edit mode toggle, one rendering path. 900px centered measure, dossier header, tactical section rules.
9. **FOLIO references:** **Right-panel tabs only** (BACKLINKS / LINKS / TAGS) as the single reference surface (extends existing right rail + adds a Tags tab). **Drop** the below-article appendix and its "..." menu — no duplicated info.
10. **FOLIO left META sidebar:** all four blocks — **Document metadata** (id/path, kind, state, rev), **Contents/TOC scrollspy** (keep existing), **Chronology + Vitals** (created/modified from real `created_at`/`updated_at`; word/char count; **no fabricated edit sparkline**), **Open-files accordion** (vertical, PINNED/RECENT). Both sidebars collapsible + drag-resizable + persisted, with edge popout when collapsed.
11. **Tab model (SHEAF):** Keep the **explicit open/close tab model** + `navigationMode` (no auto-eviction). **Add a `pinned` flag.** Horizontal strip: open tabs, pinned-first. Vertical accordion: PINNED / RECENT (recent = unpinned, by last-activated).
12. **Link previews:** **Full window manager.** Hover (220ms) → preview → **pin** (persistent, draggable) → **minimize** (bottom-left tray). Multiple windows, z-raise on focus, position persistence. Builds on existing `CLink`.
13. **CONSTELLATION:** Keep the working **D3-force layout**, restyle to tokens only — accent edges, mono labels, kind-shaped nodes. **No radar chrome** (no rings/sweep/reticle).
14. **ATRIUM modules:** Hero (greeting + date + Julian flourish + CTAs: open DIURNAL / capture / search); Stat grid + ranked tag bars (real); 26-week activity heatmap (from real timestamps); Sky module + daily aphorism (keep horologe via `suncalc`; curated date-seeded quote). **Priors dropped.**
15. **GAZETTEER:** **Merge** — rebuild as the dense, sortable, grep-filterable **all-notes table** (№ / file-id / kind pip / title·excerpt / tags / timestamp) **with a tag-filter rail/chips**. Adds the missing "table of everything", stays tag-navigable.
16. **STATUS + knobs:** Drop the glassmorphic Tweaks panel. Real panels: **CORPUS** (real stats), **SYSTEM** (real backend/index health), **OPERATOR PREFERENCES**. Expose knobs: **mode** (dark/paper), **accent presets** (6), **density** (compact/default/spacious), **diegetic-chrome toggle**. **Drop** CRYPTO + PRIORS panels. Knobs live in STATUS and/or the existing `SettingsModal`.
17. **Capture:** **Quick-capture modal** restyled as a mini "INTAKE" terminal (restyle `InscribeModal`), via ⌘N / palette. New docs then edited in-situ in FOLIO. **No full-page capture view.**
18. **Boot sequence:** Build it, **off by default**, re-runnable via palette ("RE-RUN BOOT").
19. **DIURNAL:** **Hybrid** — multi-day **register overview strip** (recent days + cadence sparkline, click-to-jump) above the existing **editable single-day journal**.
20. **Sequencing:** One feature branch, **foundation first**, 5 phases with review checkpoints (see §6).

### Kind taxonomy (resolved separately)
No `kind` field exists on pages today (pages have id/path/canonical_name/title/tags/created_at/updated_at/aliases). **Near-term:** source kind from a frontmatter `type` property (fallback: top-level folder → `NOTE`); model it as a **first-class typed enum** in the frontend so pips/filters key off the enum. **List-level wrinkle:** the list endpoint returns only id/path/title, so GAZETTEER row pips derive kind from path until the field is exposed. **Deferred (user intends to add):** a real backend `kind` column with per-kind presentation — design everything so it slots in without rewrites.

---

## 2. Design tokens (exact values, from prototype `styles.css`)

All tokens go in `ui/src/main.css` `@theme` blocks (Tailwind v4, no config file). **Dark is base `:root`; paper is the override.**

### Dark (base / default)
```
--bg:     #0a0a0a   --bg-2: #111111   --bg-3: #161616
--ink:    #e8e6df   --ink-2: #b8b5a8  --ink-3: #6a675c  --ink-4: #3a3833
--rule:   #2a2825   --rule-2: #1c1b18
```
`::selection` = accent bg on black.

### Paper (light mode override)
```
--bg: #efece2  --bg-2: #e7e3d6  --bg-3: #ddd8c9
--ink: #15140f --ink-2: #3a3833 --ink-3: #6a675c --ink-4: #9a978a
--rule: #15140f --rule-2: #6a675c
```
(Accents unchanged across modes; rules become near-black ink.)

### Accents (runtime-swappable presets; `--hot` primary / `--cool` secondary)
```
barbican (DEFAULT) "BARBICAN-ORG"  --hot #ee7733  --cool #4cd9ff
alert              "ALERT-RED"     --hot #ff3b1f  --cool #4cd9ff
amber              "AMBER-CRT"     --hot #ffb84a  --cool #7eeac9
cyan               "RADAR-CYAN"    --hot #4cd9ff  --cool #ff3b1f
phosphor           "PHOSPHOR-GR"   --hot #5dffa6  --cool #ffb84a
bone               "BONE-WHITE"    --hot #e8e6df  --cool #9a978a
--warn: #ffb84a (fixed)
```

### Typography
```
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
--font-sans: "Satoshi", "Helvetica Neue", Arial, sans-serif;   /* prose + display */
--font-body: var(--font-sans);   /* reader prose default = sans */
```
Base: `font-size 11px (--fs)`, `line-height 1.4`, `letter-spacing 0.01em`, `font-feature-settings "ss01","ss02","tnum" 1,"zero" 1`. Labels: 9px uppercase, ls 0.18em, `--ink-3`. Reader prose: 17px Satoshi / lh 1.65, 900px measure. Headings: Satoshi 700/900, uppercase where tactical, negative tracking on large display.

### Density (default; `[data-density]` overrides)
```
--row-h 22  --gap 14  --pad 14  --fs 11  --fs-s 10  --fs-xs 9     (default)
compact:  18 / 10 / 10 / 10 / 9 / 8
spacious: 28 / 18 / 18 / 12 / 11 / 10
```

### Borders / shadows / motion
- **Radius 0 everywhere** (preserved — both systems agree). Borders `1px solid var(--rule)`; dashed `.hr-dash` (6px dash); dotted dividers.
- Hard offset shadows only on floating layers (preview windows, palette, menus) — values per prototype; no blur on inline UI.
- View transition: keep a restrained version of the prototype's `viewSlide` (translateY 8px, slight scale/clip reveal, ~360ms cubic-bezier(.2,.7,.2,1)); **respect `prefers-reduced-motion`**.
- Active-state vocabulary: `inset 0 -2px 0 0 var(--hot)` underline; `outline 1px var(--hot)` for focused rows.

### Fonts to add
- **JetBrains Mono** — already present (`@fontsource-variable/jetbrains-mono`).
- **Satoshi** — self-host from Fontshare (woff2, weights 400/500/700/900 + italics as needed); add `@font-face` declarations. **Remove** Cormorant/Spectral/Zilla/Inter font imports.

---

## 3. App shell (CodexFrame rebuild)

Five-row grid, `height 100vh`, `overflow hidden`:
1. **Header rail** (`auto 1fr auto`, min-h 44px): brand `CLEPSYDRA` glyph (accent slash, → ATRIUM) | nav tabs (`ATRIUM/00 FOLIO/01 GAZETTEER/02 CONSTELLATION/03 DIURNAL/04 STATUS/05`, mono-uppercase tracked, active = accent underline) | header-meta (sync pip + `LINK NOMINAL`, corpus count, `QUERY ⌘K`). Children separated by `border-right: var(--rule)`. Hidden cells when diegetic off.
2. **Ticker** (telemetry strip, #6). Hidden when diegetic off.
3. **SHEAF** horizontal tab strip (#11): `§ SHEAF n` gutter, scroll, kind pip + id + title + pin/close, active accent top-bar, right gutter shows `⌘N` hint.
4. **Workspace** (`1fr`, `overflow hidden`): active route `<Outlet>`, wrapped in the view-transition animation keyed by route.
5. **Footer rail** (`auto 1fr auto auto`): vessel/status | `FILE · VIEW · CORPUS` (truncate, never wrap) | UTC stamp | key hints. Telemetry cells hidden when diegetic off.

Plus fixed layers: `CommandPalette`, `LinkPreviewLayer` (window manager + tray), `SettingsModal`, `BootSequence` (when invoked).

---

## 4. Per-view specs (summary)

- **FOLIO/01** — keystone. 3-col: left META (collapsible/resizable; 4 blocks per #10), center Slate editor styled as dossier (900px, header `FILE / <id>` + Satoshi-black title + tags, dashed rule, prose 17px sans, tactical h2/h3 rules, lists `▸`, callouts, code blocks w/ `CODE / LANG` header, footnotes w/ hover preview), right panel (collapsible/resizable; BACKLINKS/LINKS/TABS tabs). Wikilinks = `⟦ id · label ⟧` buttons summoning preview windows.
- **ATRIUM/00** — hero + stat grid + ranked tag bars + 26-wk heatmap + sky/aphorism (#14).
- **GAZETTEER/02** — dense sortable/grep all-notes table + tag-filter rail (#15).
- **CONSTELLATION/03** — D3-force, token restyle, kind-shaped nodes, mono callouts (#13).
- **DIURNAL/04** — register overview strip + editable day (#19).
- **STATUS/05** — CORPUS / SYSTEM / OPERATOR PREFERENCES panels + knobs (#16).
- **CommandPalette** — restyle to `CLP>` channel; GO commands + SYS (RE-RUN BOOT, toggle diegetic) + real search results (uses search endpoint).
- **INTAKE modal** — restyled `InscribeModal` (#17).
- **BootSequence** — off by default, palette-invokable (#18).

---

## 5. Component / primitive work

- **Restyle React Aria primitives** to new tokens: `Button` (primary/secondary/ghost/danger), `Dialog`, `Badge`, `TextField`, `IconButton`, `Tabs`, `Radio`, `SearchField`, `TagInput`.
- **Replace `.cl-*` utility layer** (Codex small-caps/rules/frames/fleurons) with mono-tactical equivalents: `.label` (9px uppercase tracked), `.hr`/`.hr-dash`, `.kbd`, `.tag` (+ tones hot/cool/warn/solid), `.kv`, `.chip`, `.progress`/`.bar`, kind-pip classes keyed to the kind enum.
- **Port useful primitives:** `Spark` (sparkline), `Hatch` (hatched placeholder), `AsciiBar`. **Drop** `IDPhoto` (custody mug — fiction). `ClassBanner` not used (banners were rejected across chats).
- **ThemeProvider:** invert to dark-default base, add accent/density/diegetic state + persistence; drive runtime CSS-var overrides.
- **Storybook:** update preview theme to dark-default new tokens; refresh stories for restyled primitives.

---

## 6. Build sequence (one branch, 5 phases, review at ◀)

```
branch: feat/clepsydra-vessel-redesign   (off develop)

P1 FOUNDATION                                              ◀ review
   - main.css: dark-base tokens, paper override, accents, density
   - fonts: add Satoshi (Fontshare self-host), keep JetBrains Mono,
     remove serif/Space-Grotesk/Inter imports
   - ThemeProvider: dark default + accent/density/diegetic state
   - replace .cl-* utilities; restyle RAC primitives
   - kind enum + resolver (frontmatter type → folder → NOTE)
P2 SHELL
   - CodexFrame → 5-rail shell; nav tabs; ticker (real telemetry);
     footer rail; SHEAF horizontal + pinning (workspace store: pinned flag)
P3 FOLIO (keystone)                                        ◀ review
   - 3-col layout, collapsible/resizable persisted sidebars
   - Slate editor dossier styling (900px measure, header, prose, blocks)
   - left META (4 blocks incl. vertical open-files accordion)
   - right panel tabs (BACKLINKS/LINKS/TAGS)
P4 VIEWS
   - ATRIUM, GAZETTEER (table+tag rail), CONSTELLATION (restyle),
     DIURNAL (register+day), STATUS (panels+knobs), CommandPalette restyle
P5 SIGNATURE + POLISH                                      ◀ review
   - LinkPreview window manager (hover→pin→drag→minimize tray, persistence)
   - INTAKE modal, BootSequence (palette), view transitions,
     a11y pass, Storybook refresh
merge → develop
```

---

## 7. Deferred / out of scope (flagged, not done here)

- Backend `kind` column + per-kind presentation (user intends; design is forward-compatible).
- Exposing `kind` (and tags) in list/summary API responses (would let GAZETTEER pips/filter use real kind instead of path-derived).
- "Orphans" stat is derived/approximated from `links_unresolved` (no dedicated count).
- Editor inline-vocabulary extensions implied by the prototype (sub/sup, abbr) — only if cheaply supported by current Slate marks; not a blocker.
- Bibliographic "works" subsystem styling — inherits tokens, not specifically redesigned.

---

## 8. Honored from the chats (do-not-reintroduce)

Removed/rejected by the user during prototype iteration; keep them gone: classification banners (top/bottom), corner crop-marks, the original right-gutter references rail, the "Intake" *nav tab*, auto-running boot, 50ch measure (→ 900px), `data.js` naming. The "..." appendix menu is moot (appendix dropped, #9).
