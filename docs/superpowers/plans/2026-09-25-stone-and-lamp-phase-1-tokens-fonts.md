# Stone & Lamp, Phase 1 (Tokens and Fonts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap Vessel's palette and fonts for Stone & Lamp's across the whole UI, in one branch. After it merges, every screen renders in bone or charcoal with cobalt, Geist and Instrument Serif, and code stays in JetBrains Mono.

**Architecture:**
- Every colour lives once, as a bare custom property (`--paper`, `--ink`, …) on `:root` (charcoal) and `.paper` (bone).
- The Tailwind `@theme` colour tokens become `var()` references to those bare properties, so `.paper` no longer re-binds any `--color-*`.
- `.cl-mono` is remapped to sans as a stopgap. A higher-specificity rule keeps `pre`, `code`, `kbd` and `samp` monospace.
- The theme default flips to light (bone). The `<meta name="theme-color">` tag follows the resolved theme.
- Accent presets are deleted.
- CSS is verified by a contract test that parses `ui/src/main.css`.

**Tech Stack:** Tailwind CSS v4 (`@theme`), Vite 8, React 19, Vitest + jsdom, Bun, Fontsource.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md`. Phase 1 is in §6; tokens are in §3; plumbing is in §4.

## Global Constraints

- Charcoal (dark, `:root`): ground `#151412`, sink `#1F1D1A`, raise `#262420`, ink `#EEE8DB`, ink-2 `#CBC5B8`, mute `#9A948A`, faint `#57524A`, rule `#34312C`, accent `#809CFF`, accent-tint = accent @ 15%, warn `#E08A6A`.
- Bone (light, `.paper`): ground `#F4EFE4`, sink `#EAE3D3`, raise `#FBF8F2`, ink `#0E1A3A`, ink-2 `#343B50`, mute `#5F6372`, faint `#A9A89F`, rule `#DDD5C3`, accent `#1747E6`, accent-tint = accent @ 9%, warn `#B3401F`.
- Quire ids are unchanged: `sepia`, `verdigris`, `slate`, `madder`, `ochre`, `indigo`. `indigo` takes the plum value.
  - Bone: ochre `#8A6424`, verdigris `#3F7F6A`, madder `#A2463F`, indigo `#7A4F8C`, slate `#4E6A80`, sepia `#7A5C45`.
  - Night: ochre `#D2A95A`, verdigris `#7FC0A8`, madder `#E08A80`, indigo `#B996CC`, slate `#93AFC6`, sepia `#C19E82`.
- Fonts:
  - Geist (`@fontsource-variable/geist`, family `"Geist Variable"`) is sans.
  - Instrument Serif (`@fontsource/instrument-serif`, 400 regular and italic) is serif.
  - JetBrains Mono stays, for code only.
  - Inter is removed.
- The default theme is light (bone). A stored `clepsydra.theme` value always wins.
- Radius is 12px. Shadows are soft and used only on overlays; the hard offset shadows are removed.
- Existing token **names** (`--paper`, `--paper-2`, `--paper-edge`, `--ink-mute`, `--ink-faint`, `--highlight`, `--cool`, `--hot`, `--color-*`) keep working, so there is no call-site churn in this phase.
  - The mapping: `paper` = ground, `paper-2` = raise, `paper-edge` = sink, `ink-mute` = mute, `ink-faint` = faint, `highlight` = accent-tint.
  - `cool` becomes the accent. `hot` and `warn` both become warn.
- Kinds must stay distinguishable by colour. Phase 1 merges `cool` and `accent-deep` into cobalt and `warn` into `hot`, which would leave 16 kinds on 2 hues. Task 5 moves the kinds onto the quire hues.
- Out of scope, and deferred to phase 2 as a recorded deviation from spec §6:
  - `data-diegetic`;
  - the footer;
  - the header;
  - any component markup other than the Accent row in Settings and one `font-serif` call site.
- Diegetic removal moves to phase 2 because the only thing it hides is the footer telemetry, which phase 2 rebuilds.
- Tests run under Node 26, where jsdom's `localStorage` is unreliable (project baseline). Every new test that touches storage stubs `localStorage` with the in-memory fake defined in Task 3.

## Review Focus

1. **A Vessel user with a stored `clepsydra.theme = "dark"`** must still get dark (charcoal) after upgrade. The new light default must not override it. (Task 3 test.)
2. **Code must stay monospace after `.cl-mono` goes sans.** That covers inline code, editor code leaves, `PreviewMarkdown`'s `<code className="cl-mono">` and `<pre className="cl-mono">`, and feed `pre`. (Task 2 contract test, plus the Task 5 smoke.)
3. **A browser with a leftover `clepsydra.accent = "alert"`** from before the upgrade must not turn the UI red. No `[data-accent]` rule may remain, and the stale key is cleared. (Task 4 tests.)
4. **The `system` mode flip.** When the OS switches dark, the page resolves to charcoal and `theme-color` updates to `#151412` without a reload. (Task 3 test on `applyThemeClass`, which `ThemeProvider` already calls on media change.)
5. **Muted text must stay readable on every surface.** `mute` on ground, raise and sink, and `accent` on ground, must each reach ≥ 4.5:1 in both themes. (Task 1 contrast test.)

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `ui/src/main.css` | All tokens (bare properties + `@theme` aliases), font imports, `body`, `.cl-mono` / `.cl-cap` stopgaps, code-font rule; accent presets deleted | 1, 2, 4 |
| `ui/src/__tests__/css-contract.ts` (new) | Test helper: parses `main.css` into top-level rules and custom properties; WCAG contrast | 1 |
| `ui/src/__tests__/themeTokens.test.ts` (new) | Contract: palette values, alias wiring, contrast, radius, shadows, no barbican | 1 |
| `ui/src/__tests__/themeFonts.test.ts` (new) | Contract: font stacks, imports, deps, body font, mono stopgap, code stays mono | 2 |
| `ui/package.json`, `ui/bun.lock` | Add Geist and Instrument Serif; drop Inter | 2 |
| `ui/src/components/codex/CLink.tsx` | The only `font-serif` call site: drop `font-semibold` (Instrument Serif has only a regular weight) | 2 |
| `ui/src/lib/theme.ts` | Default light; `THEME_COLOR`; `applyThemeClass` syncs meta; accent API removed; `clearLegacyAccent` | 3, 4 |
| `ui/src/lib/__tests__/theme.test.ts` (new) | Unit tests for defaults, stored preference, meta sync, legacy accent clearing | 3, 4 |
| `ui/public/theme-bootstrap.js` | Pre-paint: default light, meta sync, no accent | 3, 4 |
| `ui/src/__tests__/themeBootstrap.test.ts` (new) | Runs the bootstrap script in jsdom; checks it agrees with `theme.ts` | 3 |
| `ui/index.html` | `theme-color` starts at bone `#F4EFE4` | 3 |
| `ui/src/components/ThemeProvider.tsx` | Accent state removed; calls `clearLegacyAccent` once | 4 |
| `ui/src/components/SettingsModal.tsx` | Accent row and `swatch` helper removed | 4 |
| `ui/src/components/__tests__/SettingsModal.appearance.test.tsx` | Updated: no Accent group | 4 |
| `ui/src/docs/content/configuration.mdx`, `getting-started.mdx` | Accent and colour wording updated | 4 |
| `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` | Record the diegetic → phase 2 deviation | 4 |
| `ui/src/lib/kind.ts`, `ui/src/lib/kind.test.ts` | Kind colours move off the collapsed signal tokens onto accent + quire hues + inks | 5 |
| `ui/src/docs/content/getting-started.mdx` (§ Pips and status colours) | Kind colour table rewritten | 5 |

## Setup (before Task 1)

- [ ] Create the worktree and install:

```bash
cd /Users/kit/Source/_p.pkm/clepsydra
git worktree add .worktrees/stone-lamp-p1 -b feature/stone-lamp-p1 develop
cd .worktrees/stone-lamp-p1/ui && bun install
```

- [ ] Record the baseline failure list. The develop baseline has environmental failures under Node 26, so we diff against it rather than expecting green:

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/.worktrees/stone-lamp-p1/ui
bun run test 2>&1 | grep -E "^ (FAIL|×)" | sort -u > /tmp/stone-lamp-p1-baseline.txt; wc -l /tmp/stone-lamp-p1-baseline.txt
```

Expected: a non-zero count, which is the baseline. Keep the file.

---

### Task 1: Palette tokens behind a CSS contract test

**Files:**
- Create: `ui/src/__tests__/css-contract.ts`
- Create: `ui/src/__tests__/themeTokens.test.ts`
- Modify: `ui/src/main.css`, lines 15–280: the `@theme` colour/radius/shadow tokens, the `:root` block and the `.paper` block. Leave the `[data-accent]` blocks for Task 4 and the density blocks unchanged.

**Interfaces:**
- Produces: `mainCss: string`, `rule(selector: string, css?: string): string`, `customProps(body: string): Record<string, string>`, `prop(body: string, name: string): string | undefined` and `contrast(a: string, b: string): number` from `#/__tests__/css-contract`. Task 2 and Task 4 use them.
- Produces the new bare aliases, on `:root` only: `--ground`, `--raise`, `--sink`, `--mute`, `--faint`, `--accent-tint`, and `--elev-1` … `--elev-4` (per theme).
- Produces the Tailwind colours `ground`, `raise`, `sink`, `mute`, `faint`, `accent-tint` (so `bg-raise`, `text-mute`, etc. work in phase 2+).

- [ ] **Step 1: Write the contract helper**

`ui/src/__tests__/css-contract.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Raw text of ui/src/main.css. */
export const mainCss = readFileSync(
  fileURLToPath(new URL("../main.css", import.meta.url)),
  "utf8",
);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Rule = { selector: string; body: string };

/** Top-level `selector { body }` pairs, comments stripped, selectors
 *  whitespace-normalised. `@import …;` statements are skipped. */
export function topLevelRules(css: string = mainCss): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0;
  let selStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (depth === 0) {
        rules.push({ selector: norm(src.slice(selStart, i)), body: "" });
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules[rules.length - 1].body = src.slice(bodyStart, i);
        selStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      selStart = i + 1;
    }
  }
  return rules;
}

/** Body of the first top-level rule whose selector equals `selector`
 *  (whitespace-insensitive). Throws when absent so tests fail loudly. */
export function rule(selector: string, css: string = mainCss): string {
  const want = norm(selector);
  const found = topLevelRules(css).find((r) => r.selector === want);
  if (!found) throw new Error(`main.css has no top-level rule "${want}"`);
  return found.body;
}

/** `--name: value;` pairs in a rule body; values whitespace-normalised and
 *  lower-cased. */
export function customProps(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = norm(m[2]).toLowerCase();
  }
  return out;
}

/** A plain property (e.g. `font-family`) in a rule body, normalised. */
export function prop(body: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`).exec(body);
  return m ? norm(m[1]) : undefined;
}

/** WCAG 2.1 contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
```

- [ ] **Step 2: Write the failing token test**

`ui/src/__tests__/themeTokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contrast, customProps, mainCss, rule } from "./css-contract";

const night = customProps(rule(":root"));
const bone = customProps(rule(".paper"));
const theme = customProps(rule("@theme"));

const NIGHT = {
  "--paper": "#151412",
  "--paper-2": "#262420",
  "--paper-edge": "#1f1d1a",
  "--ink": "#eee8db",
  "--ink-2": "#cbc5b8",
  "--ink-mute": "#9a948a",
  "--ink-faint": "#57524a",
  "--rule": "#34312c",
  "--accent": "#809cff",
  "--cool": "#809cff",
  "--warn": "#e08a6a",
  "--hot": "#e08a6a",
  "--highlight": "rgba(128, 156, 255, 0.15)",
  "--quire-ochre": "#d2a95a",
  "--quire-verdigris": "#7fc0a8",
  "--quire-madder": "#e08a80",
  "--quire-indigo": "#b996cc",
  "--quire-slate": "#93afc6",
  "--quire-sepia": "#c19e82",
};

const BONE = {
  "--paper": "#f4efe4",
  "--paper-2": "#fbf8f2",
  "--paper-edge": "#eae3d3",
  "--ink": "#0e1a3a",
  "--ink-2": "#343b50",
  "--ink-mute": "#5f6372",
  "--ink-faint": "#a9a89f",
  "--rule": "#ddd5c3",
  "--accent": "#1747e6",
  "--cool": "#1747e6",
  "--warn": "#b3401f",
  "--hot": "#b3401f",
  "--highlight": "rgba(23, 71, 230, 0.09)",
  "--quire-ochre": "#8a6424",
  "--quire-verdigris": "#3f7f6a",
  "--quire-madder": "#a2463f",
  "--quire-indigo": "#7a4f8c",
  "--quire-slate": "#4e6a80",
  "--quire-sepia": "#7a5c45",
};

describe("Stone & Lamp palette", () => {
  it("defines charcoal on :root", () => {
    expect(night).toMatchObject(NIGHT);
  });

  it("defines bone on .paper", () => {
    expect(bone).toMatchObject(BONE);
  });

  it("exposes the new role aliases on :root", () => {
    expect(night).toMatchObject({
      "--ground": "var(--paper)",
      "--raise": "var(--paper-2)",
      "--sink": "var(--paper-edge)",
      "--mute": "var(--ink-mute)",
      "--faint": "var(--ink-faint)",
      "--accent-tint": "var(--highlight)",
    });
  });

  it("wires every Tailwind colour through a bare property", () => {
    const expected: Record<string, string> = {
      "--color-paper": "var(--paper)",
      "--color-paper-2": "var(--paper-2)",
      "--color-paper-edge": "var(--paper-edge)",
      "--color-ink": "var(--ink)",
      "--color-ink-2": "var(--ink-2)",
      "--color-ink-mute": "var(--ink-mute)",
      "--color-ink-faint": "var(--ink-faint)",
      "--color-accent": "var(--accent)",
      "--color-cool": "var(--cool)",
      "--color-warn": "var(--warn)",
      "--color-hot": "var(--hot)",
      "--color-rule": "var(--rule)",
      "--color-highlight": "var(--highlight)",
      "--color-ground": "var(--paper)",
      "--color-raise": "var(--paper-2)",
      "--color-sink": "var(--paper-edge)",
      "--color-mute": "var(--ink-mute)",
      "--color-faint": "var(--ink-faint)",
      "--color-accent-tint": "var(--highlight)",
      "--color-background": "var(--paper)",
      "--color-foreground": "var(--ink)",
      "--color-primary": "var(--accent)",
      "--color-ring": "var(--accent)",
      "--color-border": "var(--rule)",
    };
    expect(theme).toMatchObject(expected);
    // .paper re-binds bare properties only; no --color-* duplication.
    expect(Object.keys(bone).filter((k) => k.startsWith("--color-"))).toEqual(
      [],
    );
  });

  it("retires barbican orange", () => {
    expect(mainCss.toLowerCase()).not.toContain("#ee7733");
  });

  it("rounds to 12px and keeps shadows soft (no hard offsets)", () => {
    expect(theme["--radius"]).toBe("12px");
    for (const k of ["--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-xl"]) {
      expect(theme[k]).toMatch(/^var\(--elev-[1-4]\)$/);
    }
    for (const body of [night, bone]) {
      for (const k of ["--elev-1", "--elev-2", "--elev-3", "--elev-4"]) {
        expect(body[k]).toMatch(/^0 \d+px \d+px /);
      }
    }
  });

  it.each([
    ["charcoal", NIGHT],
    ["bone", BONE],
  ])("keeps mute and accent legible in %s", (_name, t) => {
    for (const surface of [t["--paper"], t["--paper-2"], t["--paper-edge"]]) {
      expect(contrast(t["--ink-mute"], surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t["--accent"], t["--paper"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["--ink"], t["--paper"])).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/.worktrees/stone-lamp-p1/ui && bun run test src/__tests__/themeTokens.test.ts
```

Expected: FAIL. Charcoal/bone values don't match (the current `--paper` is `#0a0a0a`), the aliases are missing, and `#ee7733` is present.

- [ ] **Step 4: Rewrite the colour, radius and shadow tokens in `main.css`**

Replace the header comment and the colour/radius/shadow part of `@theme` (from `/* Vessel dark palette` through the `--shadow-xl` line) with the following. Keep the typography stacks (Task 2 changes them) and the density scale:

```css
    /* Colours: every Tailwind colour points at a bare property defined per
       theme on :root (charcoal) / .paper (bone). One source of truth. */
    --color-paper: var(--paper);
    --color-paper-2: var(--paper-2);
    --color-paper-edge: var(--paper-edge);
    --color-ink: var(--ink);
    --color-ink-2: var(--ink-2);
    --color-ink-mute: var(--ink-mute);
    --color-ink-faint: var(--ink-faint);
    --color-accent: var(--accent);
    --color-accent-deep: var(--accent-deep);
    --color-cool: var(--cool);
    --color-warn: var(--warn);
    --color-hot: var(--hot);
    --color-rule: var(--rule);
    --color-rule-soft: var(--rule-soft);
    --color-highlight: var(--highlight);
    --color-bar-bg: var(--bar-bg);
    --color-bar-fg: var(--bar-fg);
    --color-bar-rule: var(--bar-rule);

    /* Stone & Lamp role names (spec §3.1) */
    --color-ground: var(--paper);
    --color-raise: var(--paper-2);
    --color-sink: var(--paper-edge);
    --color-mute: var(--ink-mute);
    --color-faint: var(--ink-faint);
    --color-accent-tint: var(--highlight);

    /* Tailwind / shadcn semantic aliases */
    --color-background: var(--paper);
    --color-foreground: var(--ink);
    --color-card: var(--paper-2);
    --color-card-foreground: var(--ink);
    --color-popover: var(--paper-2);
    --color-popover-foreground: var(--ink);
    --color-primary: var(--accent);
    --color-primary-foreground: var(--paper-2);
    --color-secondary: var(--paper-edge);
    --color-secondary-foreground: var(--ink);
    --color-muted: var(--paper-edge);
    --color-muted-foreground: var(--ink-mute);
    --color-accent-foreground: var(--paper-2);
    --color-destructive: var(--hot);
    --color-destructive-foreground: var(--paper-2);
    --color-border: var(--rule);
    --color-input: var(--rule);
    --color-ring: var(--accent);

    /* Radius: surfaces 12px (spec decision 13) */
    --radius: 12px;

    /* Elevation: overlays only (spec decision 14); values per theme */
    --shadow-sm: var(--elev-1);
    --shadow-md: var(--elev-2);
    --shadow-lg: var(--elev-3);
    --shadow-xl: var(--elev-4);
```

Replace the file-top comment block with:

```css
/* =============================================================================
   CLEPSYDRA — Stone & Lamp tokens (spec: docs/superpowers/specs/
   2026-09-25-stone-and-lamp-redesign-design.md). Charcoal is :root; bone is
   `.paper`. Cobalt is the only accent. Sans (Geist) for UI and prose, serif
   (Instrument Serif) as accent, mono (JetBrains Mono) for code only.
   ============================================================================= */
```

Replace the whole `:root { … }` block. Keep the density and board-alias sections exactly as they are, and swap only the colour lines above them:

```css
:root {
    color-scheme: dark;
    /* Charcoal */
    --paper: #151412;
    --paper-2: #262420;
    --paper-edge: #1f1d1a;
    --ink: #eee8db;
    --ink-2: #cbc5b8;
    --ink-mute: #9a948a;
    --ink-faint: #57524a;
    --accent: #809cff;
    --accent-deep: #6680f0;
    --cool: #809cff;
    --warn: #e08a6a;
    --hot: #e08a6a;
    /* Quire (tab-group) hues; ids unchanged, indigo carries plum */
    --quire-sepia: #c19e82;
    --quire-verdigris: #7fc0a8;
    --quire-slate: #93afc6;
    --quire-madder: #e08a80;
    --quire-ochre: #d2a95a;
    --quire-indigo: #b996cc;
    --rule: #34312c;
    --rule-soft: #2b2925;
    --grid: rgba(238, 232, 219, 0.05);
    --highlight: rgba(128, 156, 255, 0.15);
    --bar-bg: #1f1d1a;
    --bar-fg: #cbc5b8;
    --bar-rule: rgba(238, 232, 219, 0.12);
    --elev-1: 0 1px 2px rgba(0, 0, 0, 0.3);
    --elev-2: 0 8px 24px rgba(0, 0, 0, 0.35);
    --elev-3: 0 24px 60px rgba(0, 0, 0, 0.45);
    --elev-4: 0 40px 100px rgba(0, 0, 0, 0.55);

    /* Stone & Lamp role names (spec §3.1); resolve per theme via the above */
    --ground: var(--paper);
    --raise: var(--paper-2);
    --sink: var(--paper-edge);
    --mute: var(--ink-mute);
    --faint: var(--ink-faint);
    --accent-tint: var(--highlight);

    /* Density (default) */
    /* …unchanged from here to the end of the block… */
```

Replace the whole `.paper { … }` block with:

```css
/* Bone (light). Toggled by `.paper` on <html>. Re-binds bare properties only;
   the @theme --color-* aliases follow automatically. */
.paper {
    color-scheme: light;
    --paper: #f4efe4;
    --paper-2: #fbf8f2;
    --paper-edge: #eae3d3;
    --ink: #0e1a3a;
    --ink-2: #343b50;
    --ink-mute: #5f6372;
    --ink-faint: #a9a89f;
    --accent: #1747e6;
    --accent-deep: #0f36b8;
    --cool: #1747e6;
    --warn: #b3401f;
    --hot: #b3401f;
    --quire-sepia: #7a5c45;
    --quire-verdigris: #3f7f6a;
    --quire-slate: #4e6a80;
    --quire-madder: #a2463f;
    --quire-ochre: #8a6424;
    --quire-indigo: #7a4f8c;
    --rule: #ddd5c3;
    --rule-soft: #e6dfd0;
    --grid: rgba(14, 26, 58, 0.05);
    --highlight: rgba(23, 71, 230, 0.09);
    --bar-bg: #eae3d3;
    --bar-fg: #343b50;
    --bar-rule: rgba(14, 26, 58, 0.12);
    --elev-1: 0 1px 2px rgba(14, 26, 58, 0.08);
    --elev-2: 0 8px 24px rgba(14, 26, 58, 0.12);
    --elev-3: 0 24px 60px rgba(14, 26, 58, 0.18);
    --elev-4: 0 40px 100px rgba(14, 26, 58, 0.24);
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
bun run test src/__tests__/themeTokens.test.ts
```

Expected: PASS (all 8 tests; the `it.each` counts twice).

- [ ] **Step 6: Confirm Tailwind still compiles**

```bash
bun run build 2>&1 | tail -5
```

Expected: build succeeds. If Tailwind rejects a `var()`-valued `--color-*`, stop and report. Do not switch to `@theme inline` without review, because that changes whether the `--color-*` properties are emitted.

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/css-contract.ts src/__tests__/themeTokens.test.ts src/main.css
git commit -m "feat(ui): Stone & Lamp palette tokens behind a CSS contract test"
```

---

### Task 2: Fonts, and the mono stopgap that keeps code monospace

**Files:**
- Create: `ui/src/__tests__/themeFonts.test.ts`
- Modify: `ui/package.json` and `ui/bun.lock` (through `bun add` / `bun remove`)
- Modify: `ui/src/main.css`: the `@import` lines (top of file), the typography stacks in `@theme`, the `body` rule, `.cl-mono`, `.cl-cap`; add the code-font rule directly after `.cl-mono`
- Modify: `ui/src/components/codex/CLink.tsx:118`

**Interfaces:**
- Consumes: `mainCss`, `rule`, `customProps` and `prop` from `./css-contract` (Task 1).
- Produces: the Tailwind `font-sans` (Geist), `font-serif` (Instrument Serif) and `font-mono` (JetBrains Mono) utilities, which phase 2+ uses.

- [ ] **Step 1: Write the failing font test**

`ui/src/__tests__/themeFonts.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { customProps, mainCss, prop, rule } from "./css-contract";

const theme = customProps(rule("@theme"));
const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  ),
) as { dependencies: Record<string, string> };

describe("Stone & Lamp fonts", () => {
  it("sets Geist as sans, Instrument Serif as serif, JetBrains Mono as mono", () => {
    expect(theme["--font-sans"]).toMatch(/^"geist variable"/);
    expect(theme["--font-serif"]).toMatch(/^"instrument serif"/);
    expect(theme["--font-mono"]).toMatch(/^"jetbrains mono variable"/);
  });

  it("imports the faces and drops Inter", () => {
    expect(mainCss).toContain('@import "@fontsource-variable/geist";');
    expect(mainCss).toContain('@import "@fontsource/instrument-serif/400.css";');
    expect(mainCss).toContain(
      '@import "@fontsource/instrument-serif/400-italic.css";',
    );
    expect(mainCss).not.toContain("@fontsource-variable/inter");
    expect(pkg.dependencies).toHaveProperty("@fontsource-variable/geist");
    expect(pkg.dependencies).toHaveProperty("@fontsource/instrument-serif");
    expect(pkg.dependencies).not.toHaveProperty("@fontsource-variable/inter");
  });

  it("sets body in sans at 14px without global tabular figures", () => {
    const body = rule("body");
    expect(prop(body, "font-family")).toBe("var(--font-sans)");
    expect(prop(body, "font-size")).toBe("14px");
    expect(prop(body, "font-feature-settings") ?? "").not.toContain("tnum");
  });

  it("remaps .cl-mono and .cl-cap to sans (stopgap until the phase 5 sweep)", () => {
    expect(prop(rule(".cl-mono"), "font-family")).toBe("var(--font-sans)");
    const cap = rule(".cl-cap");
    expect(prop(cap, "font-family")).toBe("var(--font-sans)");
    expect(prop(cap, "text-transform")).toBe("none");
    expect(prop(cap, "letter-spacing")).toBe("normal");
  });

  it("keeps code monospace, including code marked .cl-mono", () => {
    const code = rule(
      ":where(pre, code, kbd, samp), pre.cl-mono, code.cl-mono, kbd.cl-mono, samp.cl-mono",
    );
    expect(prop(code, "font-family")).toBe("var(--font-mono)");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run test src/__tests__/themeFonts.test.ts
```

Expected: FAIL. `--font-sans` starts with `"inter variable"`, the Geist import is missing, body is mono, and there is no code rule.

- [ ] **Step 3: Swap the font packages**

```bash
bun add @fontsource-variable/geist @fontsource/instrument-serif
bun remove @fontsource-variable/inter
```

Expected: `package.json` dependencies list both new packages and no Inter.

- [ ] **Step 4: Update the imports and stacks in `main.css`**

Replace the four import lines and the Inter comment at the top with:

```css
@import "tailwindcss";
@import "@fontsource-variable/geist";
@import "@fontsource/instrument-serif/400.css";
@import "@fontsource/instrument-serif/400-italic.css";
@import "@fontsource-variable/jetbrains-mono";
```

Replace the typography stacks in `@theme` with:

```css
    /* Typography stacks ---------------------------------------------------- */
    --font-sans:
        "Geist Variable", "Geist", ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
    --font-serif: "Instrument Serif", "Iowan Old Style", Georgia, serif;
    --font-mono:
        "JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    /* Legacy aliases: keep resolving to sans until their call sites are
       migrated (font-heading has 18 users; phase 4/5 decides each). */
    --font-body: var(--font-sans);
    --font-heading: var(--font-sans);
    --font-slab: var(--font-sans);
    --font-serif-sc: var(--font-sans);
```

- [ ] **Step 5: Update `body`, `.cl-mono` and `.cl-cap`, and add the code rule**

Replace the `body` rule with:

```css
body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    letter-spacing: 0;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}
```

Replace `.cl-cap` (keep `.cl-cap-tight` and `.cl-cap-wide` as they are; they only set letter-spacing and are swept in phase 5) with:

```css
/* Stopgap (spec §6 phase 1): Vessel's tracked caps labels read as plain sans
   until each call site is restyled in the phase 5 sweep. */
.cl-cap {
    font-family: var(--font-sans);
    text-transform: none;
    letter-spacing: normal;
    font-weight: 500;
}
```

Replace `.cl-mono` with the following, and put the code rule immediately after it:

```css
/* Stopgap (spec §6 phase 1): `.cl-mono` has 501 uses; point it at sans so
   the chrome leaves mono in one commit. Code keeps mono via the rule below. */
.cl-mono {
    font-family: var(--font-sans);
}

/* Code is the only monospace (spec decision 3). Element selectors carry the
   `.cl-mono` class too, so they outrank the stopgap above. */
:where(pre, code, kbd, samp),
pre.cl-mono,
code.cl-mono,
kbd.cl-mono,
samp.cl-mono {
    font-family: var(--font-mono);
    font-feature-settings:
        "calt" 0,
        "liga" 0;
}
```

- [ ] **Step 6: Fix the only `font-serif` call site**

In `ui/src/components/codex/CLink.tsx:118`, Instrument Serif has only a regular weight, so `font-semibold` would synthesise a fake bold. Change:

```tsx
          <span className="mb-[3px] block font-serif text-[14px] font-semibold leading-[1.2]">
```

to:

```tsx
          <span className="mb-[3px] block font-serif text-[17px] leading-[1.15]">
```

- [ ] **Step 7: Run the font tests and the token tests**

```bash
bun run test src/__tests__/themeFonts.test.ts src/__tests__/themeTokens.test.ts
```

Expected: PASS (both files).

- [ ] **Step 8: Run the neighbours that render code or CLink**

```bash
bun run test src/components/codex/CLink.test.tsx src/components/MarkdownRenderer.test.tsx src/components/codex/PreviewMarkdown.test.tsx
```

Expected: no new failures compared with `/tmp/stone-lamp-p1-baseline.txt`. Class-name assertions on `font-semibold` in `CLink.test.tsx`, if any, are updated to the new classes.

- [ ] **Step 9: Commit**

```bash
git add package.json bun.lock src/main.css src/__tests__/themeFonts.test.ts src/components/codex/CLink.tsx src/components/codex/CLink.test.tsx
git commit -m "feat(ui): Geist + Instrument Serif; mono only for code"
```

---

### Task 3: Bone by default, and `theme-color` follows the theme

**Files:**
- Create: `ui/src/lib/__tests__/theme.test.ts`
- Create: `ui/src/__tests__/themeBootstrap.test.ts`
- Modify: `ui/src/lib/theme.ts`: `DEFAULT_THEME`, `getSystemTheme` SSR fallback, `applyThemeClass`; add `THEME_COLOR`
- Modify: `ui/public/theme-bootstrap.js`
- Modify: `ui/index.html:11`

**Interfaces:**
- Produces: `export const THEME_COLOR: { light: "#F4EFE4"; dark: "#151412" }` from `#/lib/theme`.
- Produces: `applyThemeClass(resolved)` now also sets `<meta name="theme-color">` content, creating the tag if it is absent.
- Produces: the test helper `fakeStorage()`, defined inline in both test files. It is an in-memory `Storage` stand-in, because jsdom's storage is unreliable under Node 26.

- [ ] **Step 1: Write the failing unit tests**

`ui/src/lib/__tests__/theme.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeClass,
  readStoredTheme,
  THEME_COLOR,
  THEME_STORAGE_KEY,
} from "#/lib/theme";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

const meta = () =>
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

beforeEach(() => {
  document.documentElement.className = "";
  meta()?.remove();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme defaults", () => {
  it("defaults to light (bone) when nothing is stored", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(readStoredTheme()).toBe("light");
  });

  it("respects a stored Vessel-era dark preference", () => {
    vi.stubGlobal("localStorage", fakeStorage({ [THEME_STORAGE_KEY]: "dark" }));
    expect(readStoredTheme()).toBe("dark");
  });

  it("respects a stored system preference", () => {
    vi.stubGlobal(
      "localStorage",
      fakeStorage({ [THEME_STORAGE_KEY]: "system" }),
    );
    expect(readStoredTheme()).toBe("system");
  });
});

describe("applyThemeClass", () => {
  it("adds .paper and bone theme-color for light", () => {
    applyThemeClass("light");
    expect(document.documentElement.classList.contains("paper")).toBe(true);
    expect(meta()?.content).toBe(THEME_COLOR.light);
    expect(THEME_COLOR.light).toBe("#F4EFE4");
  });

  it("removes .paper and sets charcoal theme-color for dark", () => {
    applyThemeClass("light");
    applyThemeClass("dark");
    expect(document.documentElement.classList.contains("paper")).toBe(false);
    expect(meta()?.content).toBe(THEME_COLOR.dark);
    expect(THEME_COLOR.dark).toBe("#151412");
  });

  it("updates an existing meta tag rather than adding a second", () => {
    const tag = document.createElement("meta");
    tag.name = "theme-color";
    tag.content = "#efece2";
    document.head.append(tag);
    applyThemeClass("dark");
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(tag.content).toBe("#151412");
  });
});
```

`ui/src/__tests__/themeBootstrap.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_COLOR } from "#/lib/theme";

const script = readFileSync(
  fileURLToPath(new URL("../../public/theme-bootstrap.js", import.meta.url)),
  "utf8",
);

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

function run(seed: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", fakeStorage(seed));
  new Function(script)();
}

const meta = () =>
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

beforeEach(() => {
  const root = document.documentElement;
  root.className = "";
  root.removeAttribute("data-accent");
  root.style.colorScheme = "";
  meta()?.remove();
  const tag = document.createElement("meta");
  tag.name = "theme-color";
  tag.content = "#000000";
  document.head.append(tag);
});

afterEach(() => vi.unstubAllGlobals());

describe("theme-bootstrap.js (pre-paint) agrees with lib/theme", () => {
  it("paints bone by default", () => {
    run();
    expect(document.documentElement.classList.contains("paper")).toBe(true);
    expect(meta()?.content).toBe(THEME_COLOR.light);
  });

  it("paints charcoal for a stored dark preference", () => {
    run({ "clepsydra.theme": "dark" });
    expect(document.documentElement.classList.contains("paper")).toBe(false);
    expect(meta()?.content).toBe(THEME_COLOR.dark);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
bun run test src/lib/__tests__/theme.test.ts src/__tests__/themeBootstrap.test.ts
```

Expected: FAIL. `THEME_COLOR` is not exported, the default is `"dark"`, and the meta tag is untouched.

- [ ] **Step 3: Implement in `lib/theme.ts`**

Change the header comment's first two paragraphs to describe Stone & Lamp:

```ts
// Stone & Lamp theme + operator-preference state.
//
// Charcoal (dark) is the base palette on :root; bone (light) is `.paper` on
// <html>. Bone is the default for new installs; a stored preference wins.
// Density / diegetic-chrome are data-attributes on <html> consumed by main.css.
```

Set the default and SSR fallback:

```ts
// Bone is the resting default (Stone & Lamp spec §9 Q1).
const DEFAULT_THEME: ThemeMode = "light";
```

```ts
export function getSystemTheme(): Exclude<ThemeMode, "system"> {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
```

Add the colour map and extend `applyThemeClass`:

```ts
/** Browser-chrome colour per resolved theme — the `ground` token. Keep in
 *  sync with public/theme-bootstrap.js (a test enforces it). */
export const THEME_COLOR = { light: "#F4EFE4", dark: "#151412" } as const;

export function applyThemeClass(resolved: Exclude<ThemeMode, "system">) {
  const root = document.documentElement;
  // Charcoal is the base palette → light adds `.paper`.
  root.classList.toggle("paper", resolved === "light");
  root.style.colorScheme = resolved;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = THEME_COLOR[resolved];
}
```

- [ ] **Step 4: Implement in `public/theme-bootstrap.js`**

Replace the comment and the theme half of the IIFE. Leave the accent, density and diegetic lines for now; Task 4 removes the accent line:

```js
// Pre-paint: apply stored operator prefs before React mounts. Charcoal is the
// base palette (no class); bone adds `.paper` and is the default. Keep in sync
// with src/lib/theme.ts (src/__tests__/themeBootstrap.test.ts enforces it).
// This stays external so production can use a strict `script-src 'self'` CSP.
(function () {
  try {
    var ls = window.localStorage;
    var mode = ls.getItem("clepsydra.theme") || "light";
    var resolved =
      mode === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    var root = document.documentElement;
    if (resolved === "light") root.classList.add("paper");
    else root.classList.remove("paper");
    root.style.colorScheme = resolved;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "light" ? "#F4EFE4" : "#151412");
```

Leave the rest of the IIFE (accent, density and diegetic lines, then the closing `} catch (e) {}` and `})();`) unchanged.

- [ ] **Step 5: Update the static meta in `index.html`**

Change line 11 from:

```html
    <meta name="theme-color" content="#efece2" />
```

to:

```html
    <meta name="theme-color" content="#F4EFE4" />
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
bun run test src/lib/__tests__/theme.test.ts src/__tests__/themeBootstrap.test.ts
```

Expected: PASS (6 + 2).

- [ ] **Step 7: Run everything that consumes `useTheme`, and diff against the baseline**

```bash
bun run test src/components 2>&1 | grep -E "^ (FAIL|×)" | sort -u > /tmp/p1-t3.txt; comm -13 /tmp/stone-lamp-p1-baseline.txt /tmp/p1-t3.txt
```

Expected: empty output (no new failures). If a test asserted `resolvedTheme: "dark"` by default or `#efece2`, update it to the bone default. A mocked `useTheme` returning `"dark"` is a test fixture choice and can stay.

- [ ] **Step 8: Commit**

```bash
git add src/lib/theme.ts src/lib/__tests__/theme.test.ts src/__tests__/themeBootstrap.test.ts public/theme-bootstrap.js index.html
git commit -m "feat(ui): bone by default; theme-color follows the resolved theme"
```

---

### Task 4: Remove accent presets

**Files:**
- Modify: `ui/src/lib/theme.ts`: delete `Accent`, `ACCENTS`, `DEFAULT_ACCENT`, `readStoredAccent`, `storeAccent` and `applyAccent`; keep `ACCENT_STORAGE_KEY`, now used only for cleanup; add `clearLegacyAccent`
- Modify: `ui/src/lib/__tests__/theme.test.ts`: add the cleanup tests
- Modify: `ui/src/__tests__/themeTokens.test.ts`: add the no-`[data-accent]` test
- Modify: `ui/src/main.css`: delete the five `[data-accent=…]` blocks and their comment
- Modify: `ui/public/theme-bootstrap.js`: delete the two accent lines
- Modify: `ui/src/components/ThemeProvider.tsx`
- Modify: `ui/src/components/SettingsModal.tsx`: the Accent `Row`, the `swatch` helper, and the `ACCENTS` import
- Modify: `ui/src/components/__tests__/SettingsModal.appearance.test.tsx`
- Modify: `ui/src/docs/content/configuration.mdx:21,34-37`, `ui/src/docs/content/getting-started.mdx:484`
- Modify: `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§4 and §6 phase 1)

**Interfaces:**
- Consumes: `fakeStorage` pattern from Task 3's `theme.test.ts` (same file).
- Produces: `clearLegacyAccent(): void` from `#/lib/theme`. It removes `data-accent` from `<html>` and deletes `localStorage["clepsydra.accent"]`, and it never throws.
- Produces: `useTheme()` no longer returns `accent` or `setAccent`. Consumers: `SettingsModal` only; the grep in Step 6 confirms.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/lib/__tests__/theme.test.ts`, and add `clearLegacyAccent` and `ACCENT_STORAGE_KEY` to its import from `#/lib/theme`:

```ts
describe("clearLegacyAccent", () => {
  it("drops a pre-upgrade accent attribute and stored key", () => {
    const storage = fakeStorage({ [ACCENT_STORAGE_KEY]: "alert" });
    vi.stubGlobal("localStorage", storage);
    document.documentElement.setAttribute("data-accent", "alert");
    clearLegacyAccent();
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(storage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => clearLegacyAccent()).not.toThrow();
  });
});
```

Append to `ui/src/__tests__/themeTokens.test.ts`, inside the `describe`:

```ts
  it("has no accent presets (cobalt is fixed)", () => {
    expect(mainCss).not.toContain("[data-accent");
  });
```

Replace the test body in `ui/src/components/__tests__/SettingsModal.appearance.test.tsx`:
- remove `setAccent` from the `mocks` object and `accent`/`setAccent` from the mocked `useTheme` return value;
- rename the test;
- drop the three Accent lines.

```ts
  it("routes mode and density choices to theme callbacks, with no accent picker", async () => {
    const user = userEvent.setup();
    render(<SettingsModal />);

    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Density" })).toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "Accent" })).toBeNull();

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Default/i })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Paper" }));
    expect(mocks.setMode).toHaveBeenCalledWith("light");

    await user.click(screen.getByRole("radio", { name: /Compact/i }));
    expect(mocks.setDensity).toHaveBeenCalledWith("compact");
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
bun run test src/lib/__tests__/theme.test.ts src/__tests__/themeTokens.test.ts src/components/__tests__/SettingsModal.appearance.test.tsx
```

Expected: FAIL. `clearLegacyAccent` is not exported, `[data-accent` is still in main.css, and the Accent radiogroup still renders.

- [ ] **Step 3: Implement in `lib/theme.ts`**

Delete the `Accent` type, `ACCENTS`, `DEFAULT_ACCENT`, `readStoredAccent`, `storeAccent` and `applyAccent`. Keep `ACCENT_STORAGE_KEY` and add:

```ts
/** Accent presets were retired in Stone & Lamp (cobalt is fixed). Clears
 *  what an older build may have left behind so it can't recolour anything. */
export function clearLegacyAccent() {
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-accent");
  }
  try {
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
  } catch {
    // storage unavailable (private mode, tests) — nothing to clear
  }
}
```

- [ ] **Step 4: Update `ThemeProvider.tsx`**

- Remove `type Accent`, `applyAccent`, `readStoredAccent` and `storeAccent` from the import, and add `clearLegacyAccent`.
- Delete from `ThemeContextValue`: `accent` and `setAccent`.
- Delete the `accent` state, `setAccent`, the `applyAccent` effect, and both entries in the `useMemo` value and its deps array.
- Add this one-time effect beside the density effect:

```tsx
  useEffect(() => clearLegacyAccent(), []);
```

- [ ] **Step 5: Update `SettingsModal.tsx`**

- Delete the whole `<Row label="Accent">…</Row>` element.
- Delete the `swatch` helper function (search `function swatch`).
- Change the import to `import { DENSITIES } from "#/lib/theme";`.
- Remove `accent` and `setAccent` from the `useTheme()` destructure in `OperatorPreferences`.

- [ ] **Step 6: Delete the accent CSS and bootstrap lines, and confirm no other consumers**

In `main.css`, delete the comment `/* Accent presets — …` and all five `[data-accent="…"] { … }` blocks.

In `public/theme-bootstrap.js`, delete:

```js
    var accent = ls.getItem("clepsydra.accent");
    if (accent && accent !== "barbican") root.setAttribute("data-accent", accent);
```

Then:

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/.worktrees/stone-lamp-p1/ui && rg -n "ACCENTS|applyAccent|readStoredAccent|storeAccent|setAccent|data-accent|barbican" src public
```

Expected: matches only in `src/lib/theme.ts` (`clearLegacyAccent`), `src/lib/__tests__/theme.test.ts`, `src/__tests__/themeBootstrap.test.ts` (the `removeAttribute` in `beforeEach`) and `src/__tests__/themeTokens.test.ts`. Fix any other hit by deleting the accent usage.

- [ ] **Step 7: Update the user docs**

In `ui/src/docs/content/configuration.mdx`:
- line 21: `- **Appearance** controls mode, density, and diegetic chrome.`
- lines 34–37: remove "the shipped accent palettes and". Rewrite the storage sentence to name only `clepsydra.theme` and `clepsydra.density`, and add: "Cobalt is the only accent; the old accent presets were retired, and a leftover `clepsydra.accent` value is cleared on load."

In `ui/src/docs/content/getting-started.mdx`, line 484: "Diagrams follow the current theme, and the mermaid renderer loads…" (drop "and accent"). The "Pips and status colours" section is Task 5's job.

- [ ] **Step 8: Record the diegetic deviation in the spec**

In `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md`:
- In §4, change the **Diegetic setting** bullet to end with: "Removal happens in phase 2 with the footer rework, not phase 1."
- In §6 phase 1, replace "Remove accent presets and the diegetic setting." with "Remove accent presets. (Diegetic removal moves to phase 2 with the footer.)"

- [ ] **Step 9: Run the tests and watch them pass**

```bash
bun run test src/lib/__tests__/theme.test.ts src/__tests__/themeTokens.test.ts src/components/__tests__/SettingsModal.appearance.test.tsx src/docs
```

Expected: PASS. The `src/docs` suite covers `featureInventory` and `registry`. It has no new failures against the baseline.

- [ ] **Step 10: Commit**

```bash
git add src/lib/theme.ts src/lib/__tests__/theme.test.ts src/__tests__/themeTokens.test.ts src/main.css public/theme-bootstrap.js src/components/ThemeProvider.tsx src/components/SettingsModal.tsx src/components/__tests__/SettingsModal.appearance.test.tsx src/docs/content/configuration.mdx src/docs/content/getting-started.mdx
git add ../docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md
git commit -m "feat(ui): retire accent presets; cobalt is the only accent"
```

---

### Task 5: Kind colours onto the quire hues

**Files:**
- Modify: `ui/src/lib/kind.ts:79-109` (the `KIND_META` colours and the comment above them)
- Modify: `ui/src/lib/kind.test.ts`
- Modify: `ui/src/docs/content/getting-started.mdx:310-340` (§ Pips and status colours)

**Interfaces:**
- Consumes: the `--quire-*` properties from Task 1 (both themes).
- Produces: `kindColorVar(kind)` returns one of `var(--accent)`, `var(--quire-{ochre,verdigris,madder,indigo,slate,sepia})`, `var(--ink)`, `var(--ink-2)`, `var(--ink-mute)` or `var(--ink-3)`. The signature is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/lib/kind.test.ts`, inside the existing top-level `describe`:

```ts
  it("maps kinds onto accent, quire hues, and inks (Stone & Lamp)", () => {
    expect(Object.fromEntries(KINDS.map((k) => [k, kindColorVar(k)]))).toEqual({
      PROJECT: "var(--accent)",
      TASK: "var(--quire-verdigris)",
      TODO: "var(--quire-verdigris)",
      CYCLE: "var(--ink-2)",
      JOURNAL: "var(--quire-ochre)",
      AI_JOURNAL: "var(--quire-indigo)",
      AI_CONVERSATION: "var(--quire-indigo)",
      PERSON: "var(--quire-madder)",
      MEETING: "var(--quire-madder)",
      CAPTURE: "var(--quire-slate)",
      QUOTE: "var(--quire-slate)",
      BOOK: "var(--quire-sepia)",
      RECIPE: "var(--quire-sepia)",
      CODE: "var(--ink)",
      NOTE: "var(--ink-mute)",
      ARCHIVE: "var(--ink-3)",
    });
  });

  it("uses no retired Vessel signal token", () => {
    for (const k of KINDS) {
      expect(kindColorVar(k)).not.toMatch(/--(cool|hot|warn|accent-deep)\)/);
    }
  });
```

If `KINDS` in `kind.test.ts` is not the full list of `Kind` values, use `Object.keys(KIND_META) as Kind[]` instead. The equality test must cover every kind, so a new kind breaks it on purpose.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/.worktrees/stone-lamp-p1/ui && bun run test src/lib/kind.test.ts
```

Expected: FAIL on both new tests (the current map uses `--cool`, `--warn`, `--hot` and `--accent-deep`).

- [ ] **Step 3: Update `KIND_META`**

Replace the comment above `KIND_META` with:

```ts
// Colour assignment (Stone & Lamp): cobalt marks projects; related kinds share
// a quire hue (people → madder, work → verdigris, days → ochre, machine-made →
// indigo/plum, collected → slate, reading → sepia); neutral kinds use inks.
// The icon names the kind; colour only groups.
```

Set the `color` fields exactly as in the test above. Keep every other field and comment. Update the MEETING comment to "Meetings are about people, so they share PERSON's madder." and the AI_JOURNAL comment to "The assistants' daily stream shares the machine-made indigo (plum) hue."

- [ ] **Step 4: Rewrite the docs table**

In `getting-started.mdx`, § Pips and status colours:
- Change the intro sentence to: "Small square ticks mark section headers throughout the interface, and page kinds carry an icon coloured from the same palette: **cobalt** (the accent), six quire hues, and the ink ramp for neutral kinds."
- Replace the table's Colour column values to match the test: PROJECT Cobalt (accent); BOOK and RECIPE Sepia; AI JOURNAL and AI CONVERSATION Plum; JOURNAL Ochre; PERSON and MEETING Madder; CAPTURE and QUOTE Slate; TODO and TASK Verdigris; CODE Ink (brightest); CYCLE Ink (dimmer); NOTE and ARCHIVE Muted ink.
- Keep the row order grouped by colour.

- [ ] **Step 5: Run the tests and the kind consumers**

```bash
bun run test src/lib/kind.test.ts src/lib/kindPresentation.test.tsx src/components/KindIcon.test.tsx src/docs
```

Expected: PASS, with no new failures against the baseline.

- [ ] **Step 6: Commit**

```bash
git add src/lib/kind.ts src/lib/kind.test.ts src/docs/content/getting-started.mdx
git commit -m "feat(ui): kind colours move onto the quire hues"
```

---

### Task 6: Gates, browser smoke, merge

**Files:** none are changed unless a gate fails.

- [ ] **Step 1: Typecheck and lint**

```bash
cd /Users/kit/Source/_p.pkm/clepsydra/.worktrees/stone-lamp-p1/ui && bun run typecheck && bun run lint
```

Expected: both exit 0.

- [ ] **Step 2: Full test suite, diffed against the baseline**

```bash
bun run test 2>&1 | grep -E "^ (FAIL|×)" | sort -u > /tmp/stone-lamp-p1-final.txt
comm -13 /tmp/stone-lamp-p1-baseline.txt /tmp/stone-lamp-p1-final.txt
```

Expected: empty (no new failures). Report the counts, baseline versus final, explicitly.

- [ ] **Step 3: Browser smoke (Playwright plugin), against a scratch vault**

Run `clep` with `CLEPSYDRA__VAULT__ROOT` pointing at a scratch vault, never the live one. Start `bun run dev` in `ui/`. Then check:

1. A fresh profile (no localStorage) loads bone: `<html class="paper">`, and `meta[name=theme-color]` is `#F4EFE4`.
2. `document.fonts.check('16px "Geist Variable"')` and `document.fonts.check('italic 20px "Instrument Serif"')` both return `true` after load.
3. Open a page that has inline code and a fenced code block: `getComputedStyle(code).fontFamily` starts with `"JetBrains Mono Variable"`. Header nav text computes to Geist.
4. Settings → Appearance: switch to Dark. The background computes to `rgb(21, 20, 19)` and theme-color to `#151412`. There is no Accent row.
5. In the console, `localStorage.setItem('clepsydra.accent','alert')` then reload: `<html>` has no `data-accent`, and the key is gone.
6. Gazetteer: kind icons show several distinct hues (cobalt, ochre, madder, verdigris, slate, sepia, plum), not just blue and red.
7. Take screenshots of the Atrium and a Folio page in both themes and attach them to the report. Expect Vessel layouts in the new colours and fonts; the layouts change in phase 2+.

- [ ] **Step 4: Merge to develop and clean up** (project workflow: integration branch is `develop`)

Before merging, audit develop for concurrent-session commits (project memory: shared-worktree sessions):

```bash
cd /Users/kit/Source/_p.pkm/clepsydra && git fetch --all --quiet; git log --oneline feature/stone-lamp-p1..develop
git checkout develop && git merge --no-ff feature/stone-lamp-p1 -m "Merge Stone & Lamp phase 1 (tokens + fonts) into develop"
git worktree remove .worktrees/stone-lamp-p1 && git branch -d feature/stone-lamp-p1
```

Expected: the merge succeeds. If `develop` moved, re-run Step 2 on the merged tree before removing the worktree.
