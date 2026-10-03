# Moon detail — plan (2026-10-03)

Branch `feature/moon-detail`, worktree `.worktrees/moon-detail`. UI only.

## Rulings (user, 2026-10-03)

- One **Moon dialog**, opened from the Sky card's moon disc. Contents top→bottom: large live 3D moon; phase name + scrubbed date/time; timeline scrubber (±3 days, hourly ticks, day labels, "Now" reset); stats list; phase calendar (month grid, prev/next month, phase glyph per day, "New moon"/"Full moon" dates for the shown month).
- **Card** gains rows: Moonrise, Moonset (location-dependent, greyed like sun rows when no location), Next full (in N days), Distance (km).
- **3D moon**: three.js, lazy-loaded chunk (never in the Atrium entry chunk). Lit by the real Sun direction. Oriented by real libration + lunar pole position angle, so it matches the sky. Drag to spin, springs back.
- **Card moon**: realistic, static. Rendered to a 2D canvas by pure per-pixel orthographic projection of a small texture. No three.js on Atrium. Phase gauge ticks kept.
- **Textures**: NASA SVS CGI Moon Kit (public domain, svs.gsfc.nasa.gov/4720). 4k colour + 2k relief, plus a 1k colour for the card. WebP in `ui/public/moon/`. Not precached; SW runtime cache (CacheFirst) for `/moon/*`.
- **Units**: km.
- **Timeline ↔ calendar linked**: clicking a calendar day sets the scrubbed instant to that day at the current time-of-day; timeline recentres. "Now" resets.

## Astronomy

Use `astronomy-engine` (MIT, pure TS) for moon maths: `Illumination`, `SearchMoonPhase`, `SearchRiseSet`, `Libration`, `GeoMoon`, `GeoVector(Body.Sun)`, `RotationAxis(Body.Moon)`. Keep suncalc for the sun rows (existing behaviour, untouched).

## Tasks (TDD; each: failing test → impl → green)

1. **`moon.ts` astronomy core** (`ui/src/components/codex/moon/moon.ts`, pure). `moonAt(date, loc?)` → `{ phaseName, glyph, phase (0..1 age fraction), illumPct, waxing, distanceKm, rise: Date|null, set: Date|null, nextFull: Date, nextNew: Date }`. `monthPhases(year, month)` → per-day `{ date, phase, illumFraction, waxing }` at local noon, plus the new/full instants falling in the month. Tests pin known events (e.g. full moon 2026-10-26, new 2026-10-10 UTC dates), distance range 356k–407k, rise/set null without location.
2. **`moonOrientation.ts`** (pure). `orientMoon(date)` → camera-frame basis: unit `sunDir` (light) and a rotation (quaternion or 3×3) taking selenographic body frame → view frame (x right, y up = celestial north projected, z toward viewer). Built from GeoMoon, Sun vector, RotationAxis pole, Libration elon/elat. Tests: sub-Earth point maps to +z within 0.5°; illuminated fraction from `sunDir` (½(1+cos phase angle)) matches `Illumination` within 1%; waxing ⇒ lit limb on the west (right in north-up view, i.e. sunDir.x > 0).
3. **Texture assets + SW route**. Script `ui/scripts/fetch-moon-textures.sh` (curl NASA TIFFs → magick → WebP: `moon-color-4k.webp` 4096×2048, `moon-color-1k.webp` 1024×512, `moon-relief-2k.webp` 2048×1024 from LDEM). Commit outputs + a `CREDITS.md` (NASA SVS attribution). SW: `registerRoute` CacheFirst `moon-textures` for `/moon/`; test in the existing SW classifier tests if the route is classified there.
4. **`renderMoonDisc`** (pure canvas fn, `moon/projectMoon.ts`): for each output pixel in the disc → view-frame normal → body frame (inverse rotation) → lat/lon → sample texture ImageData (bilinear) → Lambert(sunDir) with soft terminator + slight earthshine + limb darkening. Test the projection maths (centre pixel → sub-Earth lat/lon; terminator pixel brightness≈0; full moon centre lit). `MoonFace` component draws into a `<canvas>` at DPR, falls back to the existing CSS disc until the texture loads / in jsdom.
5. **Card rows + MoonFace in `MoonDisc`** — SkyCard rows Moonrise/Moonset/Next full/Distance; `SkyData.moon` extended from task 1. Disc becomes a button opening the dialog (`aria-label="Moon details"`). Update SkyCard/MoonDisc/sky tests + story.
6. **`MoonGlobe` (three.js, lazy)**: `React.lazy` module; sphere (`SphereGeometry` 128 seg) + `MeshStandardMaterial` (map 4k, bumpMap/displacement relief), DirectionalLight from `sunDir`, faint ambient for earthshine, mesh quaternion from task 2. Pointer drag rotates, spring back on release; respects `prefers-reduced-motion` (no spring animation). Disposes renderer/textures on unmount. WebGL-unavailable fallback → `MoonFace` at large size. Test: mounts fallback under jsdom (no WebGL), module is code-split (no static import from Atrium path — guard test greps `three` imports).
7. **`MoonTimeline` scrubber**: ±3 days, hourly ticks, day ticks taller + labels (weekday short / "Today"), cobalt ▼ marker at centre; drag/wheel/arrow keys (←/→ 1 h, Shift 1 day, Home = now) scroll the strip; `role="slider"` with aria-valuetext = formatted instant. Tests: keyboard changes value; aria-valuetext.
8. **`MoonCalendar`**: month grid Mon-first, small SVG phase glyph per day (lit fraction + waxing side), today ringed, selected day in accent-tint, prev/next month buttons, New/Full dates list. Clicking a day calls `onSelectDay`. Tests: Oct 2026 grid starts Thu 1st; 10 Oct shows new glyph; footer lists "Sat 10 Oct" / "Mon 26 Oct".
9. **`MoonDialog`** composes 6–8 + stats list (Illumination, Moonrise, Moonset, Next full moon "N days", Next new moon, Distance km) driven by one `instant` state; wire into SkyCard. Test: open from card, scrub changes stats, calendar day click changes heading date, Now resets.
10. **Gates + browser smoke** (Playwright: open Atrium, open dialog, screenshot), docs touch (`ui/src/docs/content` if the Atrium is documented).

Stone & Lamp: no caps/mono/hairlines; serif accent headings; tokens only. Moon greys are content (texture), not chrome.
