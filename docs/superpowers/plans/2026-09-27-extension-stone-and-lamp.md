# Extension: Stone & Lamp restyle

Spec: `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (the
browser-extension note at line 276 lists this as separate work).

## Rulings (user, 2026-09-27)

- No mockup. Map the popup and options pages onto the app's phase 3 primitives.
- Theme follows the browser (`prefers-color-scheme`): charcoal base, bone under
  `light`. No server call.
- Fonts: package Geist Variable (latin wght normal) and Instrument Serif 400
  (normal + italic). Drop Inter and JetBrains Mono. Code uses the system mono stack.
- Icon chore is in scope, but its outputs are gitignored (`dist*/`, `safari/`),
  so it is a local rebuild, not a commit.

## Design mapping (app source → extension)

| App | Extension |
|---|---|
| `:root` / `.paper` tokens in `ui/src/main.css` | `:root` / `@media (prefers-color-scheme: light) :root` — same names, same values: `--ground --raise --sink --ink --ink-2 --mute --faint --rule --accent --accent-tint --warn --hot --elev-1 --elev-2`, plus `--quire-verdigris` for success |
| Wordmark: `font-serif text-[24px] text-ink` "Clepsydra" | `.wordmark` serif 22px (popup) / 24px (options), no caps, no lead-glyph accent |
| Button primary: `rounded-full bg-accent text-raise`, 44px, 14px medium, hover accent/90 | `.btn-primary` |
| Button secondary (quiet): `rounded-[14px] bg-sink text-ink`, 36px | bare `button` |
| TextField: label 12.5px mute; input `h-10 rounded-full bg-sink px-4 text-[14px]`, placeholder mute | `.field-label`, `input[type=text/number]` |
| Checkbox: 16px, `rounded-[5px] bg-sink` inset 1.5px faint ring, selected accent | `input[type=checkbox]` via `appearance:none` |
| FOCUS_RING: 2px accent ring, 2px offset on ground | `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` |
| Tick: 7px square, radius 1px, accent | `.tick` span before options group titles and the popup "Defaults" eyebrow |
| SectionHeading: tick + italic serif 20px ink | `.group-title` |
| StatusDot: 7px round | `.dot` round; connected = accent, disconnected = hot, unknown = faint |
| Badge/tag chips (rounded, sink) | `.tag` — `rounded-full bg-sink text-ink-2`, 12.5px, no border |
| Panels: no hard rules, no offset shadows (spec decisions 13–14) | `.panel` — `rounded-[12px] bg-sink`, tone as a 7px tick-dot or text colour, no left rule |

Rules: sentence case everywhere (no `text-transform: uppercase`, no tracking);
body 14px Geist; `--elev-*` only on overlays (the tag suggestion listbox);
radius 12px on surfaces. Copy changes: "Capture This Page" → "Capture this page";
"Web Archive" rail label → "Web archive". Keep every id, `role`, `aria-*`, and
class name that `popup.ts` / `options.ts` / tests touch.

Status tones (popup `.capture-status[data-tone]`): reading → mute, processing →
accent, success → `--ok` (= `--quire-verdigris`), conflict → warn, error → hot.
Options `.status-box` / `.saved` same.

## Task 1 — Contract test (red)

New `extension/src/styles.test.ts` (vitest, node fs):

1. Stylesheet is `src/public/styles/clepsydra.css`; `vessel.css` is gone; both
   `popup/popup.html` and `options/options.html` link `/styles/clepsydra.css`.
2. Token parity: parse the charcoal `:root` block and the bone `.paper` block in
   `../ui/src/main.css`; parse the extension's `:root` and light-media `:root`.
   For each shared name in the table above, values match exactly.
3. Every `url(...)` in `@font-face` resolves to a file under `src/public`; the
   families declared are exactly Geist Variable and Instrument Serif; no
   Inter/JetBrains font files remain in `src/public/fonts`; each font has its
   OFL licence file.
4. Language guard over the stylesheet and both pages' inline `<style>`: no
   `uppercase`, no `letter-spacing` above `0.02em`, no Vessel names
   (`--paper`, `--ink-mute`, `--cool`, `--bar-`, `--highlight`, `--shadow-sm`).

Run `bun run test src/styles.test.ts` → fails.

## Task 2 — Implement (green)

- Copy `ui/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2`
  and `@fontsource/instrument-serif/files/instrument-serif-latin-400-{normal,italic}.woff2`
  into `src/public/fonts/`, with OFL licence files (from the package LICENSE).
  Delete the Inter/JetBrains woff2 and licences.
- `git mv vessel.css clepsydra.css`; rewrite per the mapping. Header comment
  explains the two divergences (browser-driven theme; `--ok`).
- Rewrite both pages' inline styles and markup (tick spans, copy).
- `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build`
  (includes verify:bundle) green.

## Task 3 — Visual check

Build, open `dist/popup/popup.html` and `dist/options/options.html` via
Playwright (file URL or a static server) in both colour schemes; screenshot to
scratchpad; compare against the app (e.g. Settings).

## Task 4 — Icon chore (local, uncommitted)

`bun run build`, `build:firefox`, `build:safari`; regenerate
`safari/…/Resources/Icon.png` and `AppIcon.appiconset/*.png` from
`design/icon/clepsydra-icon-macos.svg` (Inkscape CLI; sizes per filename).

## Gates

Extension: test, typecheck, lint, build. UI untouched (contract test only reads
`ui/src/main.css`). No Rust changes.
