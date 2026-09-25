# Stone & Lamp — frontend redesign (Vessel successor)

**Status:** design approved in mockups, 2026-09-25, including mobile. All open questions are resolved. Phases 1, 2a (shell), 2b (Sheaf C3) and 3 (primitives) built; phase 4 (core screens) next.
**Mockups:** https://claude.ai/artifact/WAmCEdwj8osAmkLkRxGkQd (canvas "Clepsydra redesign"; Folio, Atrium, Tasking, Command palette, Contents, System sheet, tab-row options A–E, C2, C3).
**Replaces:** the Vessel design language (`docs/plans/2026-05-29-clepsydra-vessel-redesign.md`, `ui/CLAUDE.md` § Vessel).
**Inputs:** the drop-dial app icon (`design/icon/clepsydra-icon.svg`, bc7be02c); the `_lookbook/` reference images.

## 1. Goal

Replace Vessel's dense, monospace, hairline-ruled "dossier terminal" look with a calm, reading-first look:

- no monospace outside code;
- serif as an accent voice, not the body face;
- separation by space and tone, not borders;
- more negative space and a clear spacing scale;
- one accent colour, taken from the app icon.

The name comes from the lookbook's Roman-ruin terminal image: warm stone neutrals around one cool light. Bone and cobalt come from the icon.

## 2. Locked decisions

Each of these was decided in the mockup review. Change one only by revisiting this spec.

1. **Palette from the icon.** Light ground is bone. Ink is the icon's navy. Cobalt `#1747E6` is the only accent. Barbican orange is retired.
2. **Night is warm charcoal**, not navy. Cobalt stays the accent at a lighter step.
3. **Three typefaces.** Instrument Serif is the accent: titles, section eyebrows, pull quotes and hero numerals. Geist is used for body, UI and metadata. JetBrains Mono is used only in code blocks and inline code.
4. **No uppercase tracked micro-labels.** Labels are sentence case, in Geist at 12.5–14px, coloured `mute`.
5. **Separation by space and tone.** There are no cell borders, card borders or column rules. Recessed surfaces use `sink` and raised surfaces use `raise`. The single exception is the Sheaf rule (decision 9).
6. **Section ticks stay.** The Vessel `Card` pip survives as a 7px square tick in front of every section eyebrow. It comes in three variants: cobalt (live), a pulsing cobalt (streaming or current), and `faint` (dimmed or secondary).
7. **Header = wordmark + core three + Contents.**
   - The Clepsydra wordmark and icon lead home to the Atrium. Atrium is no longer a nav item.
   - The nav items are Folio, Tasking and Gazetteer, then **Contents ⌄**, all in sans.
   - On a non-core screen (Bases, Feeds, …), Contents takes the active dot.
   - The right side holds Settings only. Sync and save status live in the footer (decision 12).
   - There is no search box and no ⌘K button, because ⌘K is the way in.
8. **Contents** is a drop-down sheet listing every other screen.
   - Screens are grouped into Write, Organise, Gather, Maintain and Reference.
   - Each screen has a one-line description, a shortcut hint and any badge (unread count, conflicts).
   - A filter field and a "recently visited" list sit at the top.
   - The core three are marked "core".
   - New screens join a group, and the header never grows.
9. **The Sheaf is option C3, the segmented rule.**
   - Each quire (tab group) has its own 1px rule segment in its hue at 55% alpha, with 28px gaps between groups.
   - Ungrouped tabs sit on a neutral segment.
   - Each tab starts with a 14px kind glyph. The glyph is monochrome `mute`, and cobalt on the active tab.
   - The active tab carries a 2px cobalt underline on its segment and shows its × close button.
   - The quire label is a dot plus the name in italic serif, both in the quire's hue.
10. **Folio sidebars stay collapsible.**
    - A collapsed sidebar leaves a 32px round button holding a panel glyph. The text column keeps its 680px measure and re-centres.
    - The existing collapse and resize logic in `Folio.tsx` (`left.collapsed`, `right.collapsed`) stays. Only its look changes.
11. **The Atrium keeps every current panel**, restyled: day-start line, greeting, journal and capture actions, Recent (edited/created/opened), Outstanding agenda, Feed river, Brimley-Cocoon Line, Sky, Activity heatmap and Reading continues. The hero Search button is dropped because ⌘K covers it.
12. **The footer stays, simplified.** It is a 34px `sink` band with sans 12.5px `mute` text.
    - Left: sync state (dot plus "Synced", "Sending…" or "Offline since 10:42") and save state (✓ "Saved 2 min ago" or a pulsing "Saving…").
    - Right: context for the current screen, separated by `·`. Folio shows the vault path, word count, % read and "Indexed 1 min ago". Tables show row range and pagination.
    - Removed: VESSEL, the FILE/VIEW/CORPUS codes, uptime and the UTC clock.
13. **Radii.** Surfaces use 12px, the command palette and Contents 16–22px, buttons and search fields a full pill, and ticks 1px. `--radius: 0` is retired.
14. **Elevation.** Only overlays cast a shadow: the palette, Contents, menus and popovers. Vessel's hard offset shadows are retired.

## 3. Tokens

### 3.1 Colour

| Token | Bone (light) | Charcoal (night) | Role |
|---|---|---|---|
| `ground` | `#F4EFE4` | `#151412` | page background |
| `sink` | `#EAE3D3` | `#1F1D1A` | recessed: code, inputs, segmented tracks, collapsed-rail buttons |
| `raise` | `#FBF8F2` | `#262420` | raised: cards (Tasking), palette, Contents, selected segment |
| `ink` | `#0E1A3A` | `#EEE8DB` | primary text |
| `ink-2` | `#343B50` | `#CBC5B8` | prose body |
| `mute` | `#5F6372` | `#9A948A` | labels, metadata, inactive nav and tabs (≥4.5:1 on ground) |
| `faint` | `#A9A89F` | `#57524A` | decoration only: dim ticks, separators, close ×; never informational text |
| `rule` | `#DDD5C3` | `#34312C` | the Sheaf's neutral segment; the only line token |
| `accent` | `#1747E6` | `#809CFF` | links, focus, active states, primary buttons, ticks |
| `accent-tint` | accent @ 9% | accent @ 15% | selection, search-hit highlight, selected row |
| `warn` | `#B3401F` | `#E08A6A` (tune) | overdue, conflict counts, errors |

The mockups also define **graphite** and **navy** night tones (`nightTone` tweak). Only charcoal ships. The others are recorded here in case charcoal fails in long use: graphite ground `#121314`, sink `#1B1C1E`, raise `#222326`, rule `#303134`.

**Quire hues.** The token ids stay the same so persisted quire state does not need migrating. `indigo` keeps its id but gets a plum value.

| Id | Bone | Night |
|---|---|---|
| `ochre` | `#8A6424` | `#D2A95A` |
| `verdigris` | `#3F7F6A` | `#7FC0A8` |
| `madder` | `#A2463F` | `#E08A80` |
| `indigo` (plum) | `#7A4F8C` | `#B996CC` |
| `slate` | `#4E6A80` | `#93AFC6` |
| `sepia` | `#7A5C45` | `#C19E82` |

**Kind colours** (`lib/kind.ts` `KIND_META[].color`) stay for places where kind is the subject: Gazetteer, graph and Stats. The Sheaf and the Atrium Recent list use monochrome glyphs (see §5.3).

### 3.2 Type

| Role | Face | Size / line-height | Used for |
|---|---|---|---|
| display | Instrument Serif | 112 / 0.95, −0.025em | Atrium greeting |
| title | Instrument Serif | 56–60 / 1.02 | Folio page title, screen titles (Tasking project) |
| heading | Instrument Serif | 30 / 1.15 | prose h2; h3 steps down to 24 |
| eyebrow | Instrument Serif *italic* | 18–22 | section labels, always paired with a tick |
| numeral | Instrument Serif | 56–96 | Brimley-Cocoon countdown, streak stats, list indices |
| prose | Geist | 17 / 1.7 | Folio editor body |
| ui | Geist | 14–15 | nav, buttons, list rows |
| meta | Geist | 12.5–13 | codes (`TSK-…`), dates, counts, hints; tabular numerals where aligned |
| code | JetBrains Mono | 13 / 1.65 | code blocks and inline code only |

- Italic serif can also mark one emphasised word in a title (for example "Good morning, *Kit.*"). Use it at most once per title.
- Bold serif is never used. Instrument Serif has only a regular weight.

### 3.3 Space

The scale is 4, 8, 12, 16, 24, 32, 48, 72 and 96px.

- Sections on a screen are 96–112px apart.
- Within a section, the header sits 22–26px above its content.
- Page padding is 40px horizontally at 1440 wide.
- Content under a section header is indented 17–19px, so it lines up with the eyebrow text rather than the tick.

The density presets (`data-density`) keep their row-height role and scale this spacing, not the type.

## 4. Fonts and theme plumbing

- **Fonts.**
  - Add `@fontsource-variable/geist` and `@fontsource/instrument-serif` (regular and italic).
  - Drop `@fontsource-variable/inter`.
  - Keep `@fontsource-variable/jetbrains-mono`, scoped to code.
  - In `main.css` `@theme`: `--font-sans` becomes Geist, `--font-serif` becomes Instrument Serif, and `--font-mono` stays JetBrains Mono. Retire the aliases `--font-body`, `--font-heading`, `--font-slab` and `--font-serif-sc`, or point them at the new roles.
  - `body` switches to `font-family: var(--font-sans); font-size: 14px`.
- **Themes.**
  - Keep the `.paper` class mechanism in `main.css`, `lib/theme.ts` and `public/theme-bootstrap.js`, and swap in the values from §3.1: `:root` becomes charcoal and `.paper` becomes bone.
  - Renaming to `data-theme` is optional and out of scope.
  - Default theme: see §9, Q1.
- **Accent presets.** `data-accent` and the `ACCENTS` list in `lib/theme.ts` and Settings are removed. Cobalt is fixed, so settings still holding a stored accent are ignored.
- **Diegetic setting.** `data-diegetic` and `DIEGETIC_STORAGE_KEY` are removed, because the chrome it hid is gone. Removal happens in phase 2 with the footer rework, not phase 1.
- **`index.html`.** Set `<meta name="theme-color">` to the ground colour of the resolved theme, updated by `applyThemeClass`. This closes the open item from the app-icon work.

## 5. Components

### 5.1 Shell — `components/codex/DesktopCodexFrame.tsx`

- **Header.**
  - Height 72px, no bottom border.
  - Left: icon plus the serif wordmark as a button that runs `goToView("atrium")`, with `aria-label` "Clepsydra — Atrium (home)". On the Atrium it carries the 4px cobalt active dot.
  - Nav: `CORE_NAV = ["folio", "tasking", "gazetteer"]` replaces `DESKTOP_NAV`. The numbered `00 ATRIUM` prefixes are dropped. The active item gets ink, weight 500 and a 4px cobalt dot 10px below.
  - Contents trigger: see §5.2.
  - Right: a Settings icon button.
  - The theme toggle leaves the header. It stays in the palette and on its shortcut.
- **Footer (decision 12).**
  - Keep the `bottomSlot` portal and replace its contents.
  - `SyncIndicator` renders there, restyled as a dot plus word.
  - A new save-status source feeds it. The editor's pending-write state (the existing `writing` flag in the frame) becomes "Saving…"; the last successful write becomes "Saved <relative time>".
  - Each view supplies its own right-hand context through a small `footerContext` slot in `VIEW_REGISTRY`, or a React context the view sets.
- **Labels.** `VIEW_REGISTRY[].label` changes from caps ("GAZETTEER") to title case ("Gazetteer"). Add `group` (Write, Organise, Gather, Maintain, Reference) and `description` (one line) fields for Contents.

### 5.2 Contents — new `components/codex/ContentsMenu.tsx`

- A popover sheet anchored under the header, 24px from each side, with 22px radius, `raise` background and the overlay shadow. Everything below the header is dimmed with ink at 26%.
- The data comes from `VIEW_REGISTRY`: every view with `go !== null`, grouped by `group`, in five columns. Feature-flagged views (Feeds) follow `enabledNavItems`.
- Each row shows the name (15–16px, weight 500), a badge (unread count, or a conflict count in `warn`), a shortcut hint on the right, and the description in `mute`.
- A filter input at the top narrows the rows. "Recently: …" comes from view history, not page history. Core views are tinted `accent-tint` and marked "core".
- The keyboard model: arrow keys move between rows, Enter goes to the screen, Esc closes. Use React Aria `Popover` and `ListBox` (`react-aria` skill).
- **Shortcut.** ⌘. conflicts with `editor.mark.superscript`. Use **⌘⇧O** ("overview"), which is free in `lib/shortcuts.ts`, and add it to the shortcut help modal.
- **G-then-letter jumps.** These need sequence chords in the shortcut registry, which do not exist today. Deferred (§8).
- **Pinning.** Pinning a non-core screen into the header is deferred (§8).

### 5.3 Sheaf — `components/codex/Sheaf.tsx`

- Implement C3: one segment per quire, then the ungrouped segment, which flex-grows to the right edge and ends in "+".
- Tabs are text plus a kind glyph. Add a `tone?: "kind" | "mono"` prop to `KindIcon`, defaulting to `"kind"`. The Sheaf passes `"mono"`, so the glyph takes `currentColor`, which is `mute` for inactive tabs and `accent` for the active one.
- Collapsed quires, pinning, drag-reorder, hover preview and the context menu keep their behaviour and need a restyle only.
- The quire label is a 6px dot plus italic serif text at 17px.

### 5.4 Section primitive — replaces `components/codex/Card.tsx`

- A new `Section` has the same props as `Card` (`label`, `caption`, `action`, `pip`), so its six importers swap it in directly. Tests are listed in §7.
- The header row is `tick + eyebrow + caption (meta, mute) + spacer + action`. Action links are cobalt text with "→".
- The body is indented to the eyebrow text. It has no border, no header band and no `bg-paper-2` fill.
- `pip` maps as follows: `cool` becomes a cobalt tick, `hot` a pulsing cobalt tick, and `dim` a `faint` tick.
- `FIG. …` captions are dropped. They appear in 6 places across 3 files.

### 5.5 Buttons — `.cl-btn`

- **Primary:** cobalt pill, `raise`-coloured text, 44px tall.
- **Quiet:** `sink` fill with 14px radius, or text only.
- **Icon buttons:** 32–40px round, `aria-label` required.
- `.cl-btn-hot` becomes the primary variant.
- There are 85 uses across 25 files. Add a `Button` wrapper over the React Aria `Button` with `variant` of `primary`, `quiet` or `ghost`, and migrate call sites to it rather than restyling the class in place.

### 5.6 Screens

- **Folio (`Folio.tsx`).**
  - Columns 232 / fluid / 296, with 64–72px gaps and no column rules.
  - Left column: tick-and-eyebrow sections "On this page" and "Properties". Properties is a label/value `dl`.
  - Right column: "Linked from" entries are a serif title plus a snippet with the match highlighted in `accent-tint`. "Unlinked mentions" gets a `faint` tick.
  - Page header: a meta line, then the serif title. The Vessel `FILE /` header is removed.
  - Prose h2s get a cobalt tick hanging in the left margin.
  - Pull quotes: italic serif 25px, with a cobalt serif open-quote.
- **Atrium (`Atrium.tsx`).**
  - The layout follows the mockup: hero, Recent 7/12 plus Agenda 5/12, full-width Feed river, BCL 7/12 plus Sky 5/12, full-width Activity, and Reading continues.
  - `cl-grid-texture` goes. `MoonDisc` and `DayArc` are redrawn in cobalt on `sink`.
  - The heatmap uses cobalt alpha steps of 22, 45, 70 and 100%, over a `sink`-adjacent empty tone.
- **Tasking (`tasking/*`).**
  - Screen header: a tick and italic "Project" eyebrow, the serif project title, then the cycle meta with a 4px progress bar.
  - View switch: a `sink` segmented track, with the selected segment in `raise`.
  - "New task" is the primary button.
  - Columns have a tick and italic serif header with a count. Done and Inbox columns get `faint` ticks.
  - Cards: `raise` background, 14px radius, no border. Done cards have no fill and `mute` text.
- **Command palette (`CommandPalette.tsx`).**
  - 640px wide, 18px radius, `raise` background. Input in Geist at 21px, with no `CLP>` prompt.
  - Result groups have a tick and italic eyebrow. The selected row is `accent-tint` with 12px radius.
  - The footer holds key hints on `ground`.
- **Dense tables (Gazetteer, Bases, Backlog).**
  - No cell borders.
  - Header row: Geist 12.5px in `mute`, sentence case.
  - Rows: 40px (default density), with hover `sink` and selected `accent-tint`.
  - Numerals in tables are tabular.
  - These tables are the main risk area. See §9, Q2.
- **Everything else** (Academic, Feeds, Archive, Docs, Rubbish, Repairs, Agenda, Conflicts, Settings, Stats, Constellation) gets the long-tail sweep in §6, phase 5.

## 6. Migration phases

Each phase is its own feature branch off `develop` and merges when green. Phases 1–2 are the only ones that change everything at once.

1. **Tokens and fonts.**
   - Swap the values in §3.1 and §4. Install Geist and Instrument Serif and remove Inter.
   - Stopgap: redefine `.cl-mono { font-family: var(--font-sans) }` and `.cl-cap` (sentence case, no tracking). This takes about 80% of the UI off mono in one commit, before the sweep. `.cl-mono` has 501 uses in 116 files, and `font-mono` has 84 uses in 37 files.
   - Set `--radius` to 12px.
   - Remove accent presets. (Diegetic removal moves to phase 2 with the footer.)
2. **Shell.** Header and simplified footer with save status (§5.1), Sheaf C3 (§5.3), Contents (§5.2), and the `VIEW_REGISTRY` label, group and description fields.
3. **Primitives.** `Section` in place of `Card` (§5.4), the `Button` wrapper (§5.5), the `KindIcon` `tone` prop, and the tick component.
4. **Core screens.** Folio, Atrium, Tasking and the command palette (§5.6).
5. **Long-tail sweep.** Screen by screen:
   - remove `uppercase` + `tracking-[…]` (441 and 324 uses respectively);
   - remove `border-rule` separators (305 uses in 82 files);
   - replace the remaining `cl-mono` and `font-mono` classes with the sans roles;
   - replace `cl-btn` with `Button`.
6. **Guard and cleanup.**
   - Add a Vitest source-scan test that fails on `font-mono` or `cl-mono` outside an allowlist (code block, inline code, the Neovim/LSP docs snippets) and on `uppercase` combined with `tracking-[` anywhere.
   - Delete the dead `.cl-*` utilities: `cl-stamp`, `cl-coord`, `cl-grid*`, `cl-frame*`, `cl-rule-double`, `cl-ascii*` if unused, and the `bar-*` tokens.
   - Update `ui/CLAUDE.md` § Vessel to describe Stone & Lamp.

`MobileCodexFrame.tsx` gets the same tokens automatically in phase 1.

**Phase 4b, Mobile companion (§9, Q3).**
- Replace `MOBILE_NAV` with Today, Agenda, Tasks, Search and Folio.
- Add the open-pages sheet and the Folio details sheet.
- Search takes over ⌘K and Contents, with "Go to" chips.
- Status becomes a dot in the top bar.
- Step the type scale down.

## 7. Testing

- **Unit and component (Vitest).**
  - Existing tests that assert Vessel text or classes need updating: "VESSEL", "FIG.", `CLP>`, caps view labels, `border-rule`. Find them with `rg -l 'VESSEL|FIG\.|CLP>|"GAZETTEER"|"FOLIO"' ui/src --glob '*test*'`.
  - New tests:
    - `ContentsMenu`: grouping from the registry, filter, feature flags, keyboard, badge rendering.
    - `Sheaf`: segment per quire, ungrouped segment, active underline, mono glyph tone.
    - `Section`: pip to tick variant mapping.
    - `DesktopCodexFrame`: wordmark goes to the Atrium; nav is exactly the core three plus Contents.
    - The phase-6 guard test.
  - `routeViews.test` must still pass. Every view keeps its `codexView` entry.
- **Baseline.** Diff failures against develop's known environmental baseline (see project memory: Node 26 localStorage failures) and do not treat that baseline as regressions.
- **Browser smoke (Playwright plugin), per phase.**
  - Folio in both themes: collapse and expand each sidebar, Sheaf tab switching, quire collapse.
  - Atrium with and without location, BCL and feeds.
  - Tasking board.
  - ⌘K palette and ⌘⇧O Contents.
  - Gazetteer and a Bases table at compact and default density.
- **Contrast.** Check `mute` on `ground`, `raise` and `sink` in both themes, and the cobalt link on `ground` (≥4.5:1). `faint` is decorative only.
- **Gates.** `bun run typecheck`, `bun run lint`, `bun run test` from `ui/`. No backend change is expected, so no OpenAPI regeneration.

## 8. Out of scope and deferred

- **Pinning** non-core screens into the header.
- **Sequence shortcuts** (G then a letter) in `lib/shortcuts.ts`.
- **Night tones** other than charcoal, and the `data-theme` rename.
- **Browser extension.**
  - The source icon is already the drop-dial (`extension/src/public/icons/icon-128.png`).
  - The built `extension/dist*/` outputs and the Safari wrapper's `Resources/Icon.png` and `AppIcon.appiconset` still carry the old hourglass. Rebuild and regenerate them as a separate chore.
  - Restyling the extension popup to Stone & Lamp is also separate.
- **Constellation graph** restyle beyond tokens.
- **Neovim plugin, LSP and CLI output.** Unaffected.

## 9. Open questions

1. ~~Default theme.~~ **Resolved 2026-09-25: bone is the default.**
   - `DEFAULT_THEME` becomes `"light"` in `lib/theme.ts` and `theme-bootstrap.js`.
   - A stored preference still wins.
2. ~~Dense tables in sans.~~ **Resolved 2026-09-25.** Both tables were prototyped on the canvas and approved.
   - Compact: 32px rows, title 13.5px, meta 12.5px. The Gazetteer defaults to compact.
   - Comfortable: 42px rows, title 14.5px, meta 13px. Bases defaults to comfortable.
   - Each table screen has a single **Compact** switch (`role="switch"`), not a two-way radio. It persists per screen.
   - The global `data-density` preset sets the default the switch starts from.
   - The checkbox and No. columns are fixed narrow (44px and 52px). The title column takes the remaining width.
3. ~~Mobile.~~ **Resolved 2026-09-25: a companion, mainly for reading.** The mockups (canvas "Mobile companion") are approved. Mobile is its own phase, after phase 4 (§6).
   - Bottom bar with five slots: Today, Agenda, Tasks, Search, and Folio (open-page count badge; opens the open-pages sheet).
   - Search replaces both ⌘K and Contents. Its "Go to" chips list the other screens.
   - Folio reading: back button, the page's group label, save state, and a details button. The details bottom sheet holds Outline, Properties and Linked. A 3px reading-progress bar sits above the bottom bar.
   - Open pages: a bottom sheet grouped by tab group, with the same segmented rule as the desktop Sheaf.
   - Status: a dot, not a footer.
   - Type steps down: page title 38px, screen titles 44px, prose 17px.
4. ~~Where the footer data goes.~~ **Resolved 2026-09-25: the footer stays, simplified, and also carries save status** (decision 12).
5. ~~Sidebar shortcuts.~~ **Resolved 2026-09-25.**
   - ⌘⌥[ and ⌘⌥] toggle the left and right Folio sidebars.
   - ⌘\\ toggles both (focus mode).
   - Plain [ and ] toggle them outside the editor, mirroring `tasking.toggleRail`.
   - The theme toggle moves from ⌘\\ to ⌘⇧\\. Update `lib/shortcuts.ts` and the shortcut help modal.
