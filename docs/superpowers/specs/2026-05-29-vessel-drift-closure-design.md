# Vessel Redesign — Drift-Closure Design

**Date:** 2026-05-29
**Branch:** `feat/clepsydra-vessel-redesign` (off `develop`)
**Authoritative spec:** `docs/plans/2026-05-29-clepsydra-vessel-redesign.md` (the "20 decisions" contract)
**Prototype reference:** `docs/pkm-redesign/project/*.html` (Claude Design handoff bundle)

## Purpose

The Vessel redesign branch has implemented the broad aesthetic and shell, but several
views remain **incomplete relative to the implementation plan's own intent**. This spec
closes that *plan-intended* drift. Where the literal prototype and the implementation plan
conflict, **the implementation plan wins** — so prototype elements the plan deliberately
rejected are out of scope (see below).

This is a frontend-led pass with one small backend addition (`GET /api/health`). It does
not change the data model, routing architecture, Slate plugin chain, or API client shape
beyond the additions called out per work unit.

## Out of scope (plan-rejected — do NOT reintroduce)

Per decisions #2, #5, #13 and §8 of the authoritative plan:

- Fabricated telemetry (vessel inventory deltas, captures/promotions/reabsorbed counts,
  unfiled-queue SLA, `LAST CAPTURE / LAST REVIEW / NEXT SCHEDULED`, head/Q gauges).
- `PRIORS · OPERATING ENVELOPE` card.
- Fake operator / clearance / coordinate chrome (`OP 0xC1`, `CLR γ-3`, custody mug-shot).
- Scanline / grain / vignette overlays.
- Radar / sonar graph chrome (rings, sweep, reticle) in CONSTELLATION.
- Serif typography (EB Garamond / Cormorant / Spectral) and Space Grotesk.
- `/` global-palette shortcut and `g`-sequence view switching.

All telemetry shown is wired to **real corpus data**; any metric we cannot source from the
existing API is omitted rather than faked.

## New infrastructure introduced this pass

| Item | Layer | Used by |
|---|---|---|
| `lowlight` + `refractor` | frontend dep | WU-4 code-block syntax highlighting (Slate decorations) |
| `GET /api/health` | backend (Axum/Rust) | WU-8 STATUS · SYSTEM panel |
| `src/api/health.ts` query hook | frontend api client | WU-8 |
| Persisted open-history ring buffer | frontend `store/workspace.ts` | WU-2 ATRIUM "OPENED" recents tab |

---

## Current-state baseline (verified)

Confirmed by reading the source on this branch:

- **Link preview window manager** (`LinkPreviewLayer.tsx` + `store/preview.ts`): complete —
  hover-delay, pin-toggle, minimize tray, multiple windows, z-raise, drag, persistence.
  `CLink.tsx` already drives hover→preview at 220ms.
- **`WikilinkElement.tsx`**: click-opens a tab only; does **not** use `CLink`/preview, and
  does not render the `⟦ id · label ⟧` vocabulary.
- **`Atrium.tsx`**: hero (minimal), 5-cell stat grid, 26-wk heatmap (bare), ranked tag bars,
  text-only sky, aphorism, BCL panel, single "Recently inscribed" list. 1140px stacked layout.
- **`workspace.ts`**: `TabDescriptor` has `pinned` + `lastActiveAt`; no persistent open history.
- **`Sheaf.tsx`**: horizontal strip, pinned-first, pin/close. **Folio `OpenFilesAccordion`**:
  PINNED/RECENT grouping present, but `OpenRow` has activation only — no pin/close controls.
- **Editor elements** (`renderElement.tsx`, `CodeBlockElement.tsx`): generic headings,
  `list-disc` bullets, no callouts, code block shows language but no `CODE / LANG` header,
  no syntax highlighting. **Footnotes are dropped** in `mdast-to-slate.ts` (cases at lines
  163, 315) and noted at `usePageEditor.ts:140`.
- **STATUS**: no `/status` route; `SettingsModal.tsx` holds the knobs (mode/accent/density/
  diegetic) under General/Appearance/Editor/Advanced. No SYSTEM panel.
- **`Gazetteer.tsx`**: sortable + grep table present; **no** per-row kind pip, **no** multi-tag
  filter rail (only a single `initialTag` search param).
- **`Diurnal.tsx`**: editable single-day journal + FASTI date sidebar; **no** multi-day
  register overview strip.
- **`CommandPalette.tsx`**: GO + SYS (RE-RUN BOOT, toggle theme) + real search + tag commands;
  **no** toggle-diegetic command.
- **No** health/version/doctor/uptime endpoint in `src/api/`. **No** syntax-highlighting dep.

---

## Work units

Each work unit is a self-contained, independently reviewable build step. Files listed are the
expected touch-points, not an exhaustive guarantee.

### WU-1 · Card primitive + design utilities

**Goal:** a reusable classified-figure card matching the prototype's `.card` / `.card-hd`.

**Design:**
- `Card` component (new, `ui/src/components/codex/Card.tsx`):
  - Header (`card-hd`): a status **pip** (`cool` | `hot` | `dim` — `dim` = no animation),
    a bold tracked label (`b`), and an optional right-aligned caption slot for
    `FIG. N — CAPTION`. Bottom border, `bg` header over `bg-2` body.
  - Body: padded by default; `tight` variant for flush tables/grids.
  - Zero radius, 1px `--rule` border, consistent with existing token utilities.
- Faint hero grid-texture utility (a `::before` repeating-linear-gradient at low opacity),
  exposed as a class in `main.css` so the hero and any future card can opt in.

**Plan basis:** #2 (classification-style section headers kept), §5 (`.cl-*` → mono-tactical).

**Files:** `Card.tsx` (new), `main.css` (grid-texture utility).

---

### WU-2 · ATRIUM → SPLASH fidelity

**Goal:** raise ATRIUM to SPLASH-level richness within plan constraints (real data only).
Implements requested elements A, B, C, D, E, full-width display, dense masonry tiling, and a
real-data inventory section.

**Design:**

1. **Layout (F + full-width + dense tiling):** replace the `max-w-[1140px]` stacked column
   with a full-width container (`max-w-[1600px]`, centered) using a **12-column grid**
   (`grid-cols-12`, `gap` per density token, `grid-auto-rows: min-content`). Modules placed by
   col-span echoing SPLASH: hero `col-12`, inventory `col-12`, aphorism `col-7` + sky `col-5`,
   heatmap `col-8` + top-tags `col-4`, recents `col-7` + BCL/secondary `col-5`. Responsive
   collapse at ~1100px / ~720px breakpoints (spans → 6/12).

2. **Hero (A):**
   - Multi-line display headline, Satoshi 700/900, `clamp(40px, 6vw, 72px)`, line-height ~0.95,
     negative tracking. Greeting copy keyed to time-of-day (existing `greeting()`), kept as a
     real greeting (no invented vessel-status sentence).
   - Greeting meta line (mono, tracked, `--ink-3`): `DAYSTART · <WEEKDAY> <YYYY·MM·DD> ·
     WEEK <n> · DAY <doy>/<365|366> · JD <jd> · <live clock HH:MM:SS LOCAL>`. Clock ticks each
     second via a `useClock` hook (1s interval, cleaned up on unmount; respects no extra
     re-render of the whole tree — local state in a small component).
   - **Primary CTA** "OPEN TODAY'S JOURNAL": resolves today's daily-note path/id (reuse the
     journal route's date→path convention). Shows a doc-id sublabel + `→` arrow; full-bleed
     `--ink` background inverting to `--hot` on hover. If today's note does not yet exist, the
     CTA label/sublabel reflect "create" semantics and routing creates-or-opens.
   - **Secondary buttons:** CAPTURE (`⌘N`, opens Inscribe) and SEARCH (`⌘K`, opens search),
     each with a keyboard-hint sublabel.
   - Faint grid `::before` texture (WU-1 utility).

3. **Inventory section (real data):** a bordered two-row stat grid inside a WU-1 Card
   (`FIG. I — STEADY-STATE TELEMETRY`):
   - Row 1 (from `useStats`): **Notes** (pages), **Links** (links_total, with derived
     `density = links_total / pages` as a sub), **Tags** (with derived `hapax` = tags whose
     count==1, from `useTags`), **Orphans/Unresolved** (links_unresolved, with `%` of links).
   - Row 2 (derived from `useContentIndex` timestamps — all real): **Captures · today**
     (created_at == today), **Edited · today** (updated_at == today), **New · 7d**
     (created_at within trailing 7d), **Unfiled** (items with no tags; labeled honestly).
   - Each cell: small uppercase label, large Satoshi-bold tabular value, and a **real** delta
     sub-line where computable (e.g. `+N / 7d` from timestamps). Cells whose value cannot be
     sourced are omitted — never shown as fabricated.

4. **Sky (B) — graphical horologe:**
   - **MoonDisc** (new component): a CSS-drawn disc. Phase fraction from
     `SunCalc.getMoonIllumination(now).phase`; lit hemisphere via clip-path; terminator
     ellipse via `scaleX(var(--phase-x))`; waxing/waning resolved from the illumination angle
     and applied as a horizontal flip. Bordered frame with corner ticks per prototype.
   - **DayArc** (new component): an SVG arc with a dashed horizon, sunrise/solar-noon/sunset
     ticks + labels from `SunCalc.getTimes(now, lat, lon)`, and a **NOW** sun marker whose x is
     interpolated between sunrise and sunset by current time (clamped to the arc; pre-dawn /
     post-dusk render the marker at the horizon ends). Falls back to default 06:00/20:00 when
     no location is available (existing `useLocation` fallback).
   - Retain the textual KV rows (phase %, moonrise/set where derivable, sunrise/sunset,
     daylight remaining, civil dusk) beside the disc.

5. **Heatmap chrome (C):**
   - Add a left **DOW** column (`M  W  F  S`) and a **month-row** label strip aligned to week
     columns (label appears on a month's first column).
   - Extend levels from 5 → **6** (`0..5`): keep accent ramp for 1–3, add a `--warn` step (4)
     and `--hot` step (5); update `level()` thresholds and `HEAT_LEVEL`.
   - Footer: **TOTAL** captures, **LONGEST STREAK**, **CURRENT STREAK** (computed from the
     per-day count map — longest/current run of consecutive nonzero days ending today), plus a
     `LESS → MORE` swatch legend.

6. **Cards / FIG. N (D):** every ATRIUM module is wrapped in the WU-1 Card with a `FIG. N`
   caption (I inventory, II aphorism, III sky, IV activity, V categories, VI recents). The
   existing `Panel`/`§ label` usage in ATRIUM is replaced by Card.

7. **Recents tabbed card (E):** a single card with a `tabs-mini` control —
   **RECENTLY EDITED** (updated_at desc), **RECENTLY CREATED** (created_at desc),
   **OPENED** (from the new workspace open-history ring buffer, most-recent first). Rows show
   index · file-id · kind-pip + title · relative time, click-to-open. When open-history is
   empty (fresh session), OPENED shows an empty-state line rather than fabricated rows.

8. **BCL panel:** retained (personal feature, not from prototype/plan), slotted into the grid.

**Open-history (workspace store):** add a bounded (`≤ 32`) persisted list of
`{ path, openedAt }` to `store/workspace.ts`, pushed on `openTab`/activation, de-duplicated by
path (most-recent wins), persisted to localStorage alongside existing tab state.

**Plan basis:** #14 (ATRIUM modules), #2 (figure headers), #7 (vocabulary).

**Files:** `Atrium.tsx` (major rework), `MoonDisc.tsx` + `DayArc.tsx` (new), `Card.tsx`
(WU-1), `store/workspace.ts` (open-history), `useClock.ts` (new hook), `main.css` (any new
utilities).

---

### WU-3 · Wikilink previews + `⟦ id · label ⟧` vocabulary

**Goal:** wire inline wikilinks into the existing preview window manager and adopt the
bracket vocabulary; make inline markdown links clickable (TODO #4).

**Design:**
- `WikilinkElement` renders the `⟦ id · label ⟧` form (resolved page id + display label) and
  routes hover through `CLink` (or the same `store/preview` hover scheduler `CLink` uses):
  220ms hover → preview window; click still opens a tab. Reuse `CLink`'s payload path so the
  preview shows the target's heading/excerpt.
- Inline markdown links (the link leaf/element used by non-wikilink `[text](url)`): make them
  clickable — internal links open a tab, external links open in a new context. (TODO #4.)

**Plan basis:** #12 (previews build on `CLink`), #132 (wikilink vocabulary).

**Files:** `WikilinkElement.tsx`, `CLink.tsx` (reuse), `store/preview.ts` (reuse), link
leaf/element in `renderLeaf.tsx`/`renderElement.tsx`.

---

### WU-4 · FOLIO dossier block styling + editor bug fixes

**Goal:** bring Slate block rendering to the dossier spec and fix the aligned editor bugs.

**Design — styling (#132):**
- **Headings:** tactical h2/h3 treatment — section rule (top hairline/number tab), Satoshi
  weight, uppercase where the spec calls for tactical headings; preserve scrollspy ids.
- **Lists:** replace `list-disc` with `▸` custom bullets (and a nested-level treatment);
  preserve the canonical `list-item > paragraph > text` shape (outliner normalizer).
- **Callouts:** styled blockquote/admonition (left accent rule, label row).
- **Code blocks:** `CODE / LANG` header bar on `CodeBlockElement`; **syntax highlighting** via
  **lowlight/refractor** mapped to Slate leaf **decorations** (token ranges → styled leaves),
  token colors driven by CSS vars; add the missing spacing before code blocks (TODO #5).
- **Footnotes:** un-drop footnotes — restore `footnoteReference` / `footnoteDefinition` through
  `mdast-to-slate` and the reverse `slate-to-mdast` path; render references as superscript
  markers and definitions in a footnotes region; references get **hover preview** (reuse the
  preview/`CLink` hover affordance). This is the heaviest sub-item; it must round-trip cleanly
  (parse → edit → serialize) without dropping data.

**Design — editor bug fixes (from `TODO.md`):**
- **Tag Tab (#1):** pressing Tab while editing a tag completes the current tag and places the
  cursor after it (like Enter), rather than moving focus to the aliases field.
- **Save/autosave (#7/#8):** `⌘S` works while the title field is focused; title **and** tags
  autosave on blur.
- **Path dedup (#3):** the folio main view shows the path only in the sidebar; the header shows
  the title, falling back to a greyed-out filename when no title exists — no duplicated path.

**Plan basis:** #8, #132; `TODO.md` #1/#3/#5/#6/#7/#8.

**Files:** `renderElement.tsx`, `CodeBlockElement.tsx`, heading/list/callout/footnote element
modules (new as needed), `convert/mdast-to-slate.ts` + slate-to-mdast, `usePageEditor.ts`,
`Folio.tsx` (title/tags autosave, header path dedup), `footnotes.ts`. New dep: `lowlight`,
`refractor`.

---

### WU-5 · SHEAF + open-files accordion controls

**Goal:** complete the vertical open-files affordances and fix the last-tab close behavior.

**Design:**
- Add **pin** and **close** controls to the accordion `OpenRow` in Folio (PINNED/RECENT
  grouping already exists); pin toggles `pinned`, close removes the tab. Mirror the horizontal
  Sheaf controls.
- **Empty state (TODO #2):** allow closing the last open tab; FOLIO renders a valid empty
  state (prompt to open/search/capture) instead of breaking.

**Plan basis:** #10 (open-files accordion), #11 (pinned flag); `TODO.md` #2.

**Files:** `Folio.tsx` (`OpenFilesAccordion`/`OpenRow`, empty state), `Sheaf.tsx`,
`store/workspace.ts` (reuse existing pin/close actions).

---

### WU-6 · GAZETTEER kind pip + tag-filter rail

**Goal:** finish the all-notes table to the #15 spec.

**Design:**
- Add a per-row **kind pip** (via `resolveKindFromPath`, colored by `kindColorVar`) to the
  title column or as a dedicated narrow column.
- Add a **tag-filter rail / chips**: multi-select tag filters (AND/OR semantics — default AND,
  documented in the component), replacing the single-`initialTag` limitation while remaining
  compatible with arriving via the `?tag=` search param.

**Plan basis:** #15.

**Files:** `Gazetteer.tsx`.

---

### WU-7 · DIURNAL register overview strip

**Goal:** add the hybrid multi-day register above the existing day editor (#19).

**Design:**
- A **register overview strip** above the single-day journal: recent days as a horizontal
  register with a **cadence sparkline** (per-day entry/word counts) and **click-to-jump** to a
  day. Reuse a `Spark` sparkline primitive (port if not present).
- Keep the existing editable single-day journal and FASTI date sidebar unchanged below it.

**Plan basis:** #19.

**Files:** `Diurnal.tsx`, `Spark` primitive (new/ported).

---

### WU-8 · STATUS/05 route + backend health endpoint

**Goal:** a real STATUS view with CORPUS / SYSTEM / OPERATOR PREFERENCES (#16), backed by a
new health endpoint.

**Design — backend:**
- New `GET /api/health` (Axum) returning real system/index health: index freshness
  (last build / page count parity), database status, corpus counts, process **uptime**, and
  build **version**. Mounted on the existing API router; no auth change.

**Design — frontend:**
- New `src/api/health.ts` TanStack Query hook for the endpoint.
- New `/status` route + STATUS view (`Status.tsx`) with three panels:
  - **CORPUS** — real stats (reuse `useStats`/`useTags`).
  - **SYSTEM** — from `/api/health` (index freshness, db, uptime, version) plus client build
    info (route, render timing) where useful.
  - **OPERATOR PREFERENCES** — the knobs (mode dark/paper, accent presets ×6, density,
    diegetic-chrome toggle).
- **Share the knob components** between STATUS and `SettingsModal` (extract the preference
  controls into a shared module so both surfaces render the same controls).
- Ensure the `STATUS/05` nav tab routes to `/status` (adding the tab if it is not already
  present in the header nav).

**Plan basis:** #16, #137; §7 (backend health was deferred — now pulled in per decision).

**Files:** backend Axum handler + route registration in `src/` (api layer + `lib.rs`);
`src/api/health.ts` (new); `routes/status.*` (new); `Status.tsx` (new); `SettingsModal.tsx`
(extract shared preference controls).

---

### WU-9 · Command palette · toggle diegetic

**Goal:** expose the diegetic-chrome toggle as a SYS command (#138).

**Design:** add a `TOGGLE DIEGETIC CHROME` command to the palette's SYS group, driving the
same `ThemeProvider`/UI state the SettingsModal/STATUS toggle uses.

**Plan basis:** #138.

**Files:** `CommandPalette.tsx`.

---

## Sequencing

Reviewable checkpoints at the end of each numbered step.

1. **WU-1 → WU-2** — Card primitive, then ATRIUM/SPLASH fidelity. *(◀ review)*
2. **WU-3** — Wikilink previews + vocabulary (highest-impact interaction).
3. **WU-4** — FOLIO dossier styling + editor bug fixes (keystone). *(◀ review)*
4. **WU-5** — SHEAF + open-files accordion + empty state.
5. **WU-6 + WU-7** — GAZETTEER kind pip/tag rail; DIURNAL register strip.
6. **WU-8** — STATUS route + backend `/api/health`.
7. **WU-9 + polish** — palette toggle; a11y pass; Storybook refresh for new/restyled
   primitives (Card, MoonDisc, DayArc, Spark, STATUS panels).

## TODO.md bug → work-unit mapping

| TODO.md item | Work unit |
|---|---|
| #1 tag Tab completes (not next field) | WU-4 |
| #2 close last folio tab → empty state | WU-5 |
| #3 path deduplicated in folio header | WU-4 |
| #4 inline links clickable | WU-3 |
| #5 spacing between paragraph and code blocks | WU-4 |
| #6 code block syntax highlighting | WU-4 |
| #7 ⌘S while editing title; title autosave on blur | WU-4 |
| #8 tags autosave on blur | WU-4 |

## Testing & verification

- **Frontend:** `bun run typecheck` + `bun run lint` clean. Targeted component tests for new
  pure logic (heatmap streak computation, inventory derivations, moon-phase/day-arc math,
  open-history ring buffer). Storybook stories for Card, MoonDisc, DayArc, Spark, STATUS panels.
- **Editor round-trip:** footnote and code-block serialization tested parse → edit → serialize
  with no data loss (follows existing editor test patterns; Slate transforms tested without
  `withReact` per project convention).
- **Backend:** `cargo test` for the `/api/health` handler (shape + real values); `cargo clippy`
  + `cargo fmt` clean.
- **Manual:** verify ATRIUM at full width and at the responsive breakpoints; verify wikilink
  hover preview + click; verify STATUS panels render real data; verify the editor bug fixes.

## Deferred / explicitly not done here

- Per-kind backend `kind` column and list-endpoint `kind`/`tags` exposure (GAZETTEER pips stay
  path-derived) — unchanged from the authoritative plan's deferrals.
- CONSTELLATION radar chrome (plan-rejected).
- Any prototype element listed under "Out of scope" above.
