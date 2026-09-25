# Stone & Lamp Phase 3 — Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every shared UI primitive to Stone & Lamp: a `Tick` and a `Section` replacing `Card`, restyled `Button`/`IconButton` with a `.cl-btn` CSS stopgap, and every `components/ui/*` overlay and form control, plus a shared focus ring.

**Architecture:** A source-scan guard test lists every primitive file and fails on Vessel tokens (caps, tracking, mono, hard borders, 9–11px type). Files not yet restyled are marked pending with `it.fails`, so each task turns its files green and must remove them from the pending set. Behaviour tests stay unchanged. The visual contract below is the spec for each restyle.

**Tech Stack:** React 19, react-aria-components 1.20, Tailwind v4, lucide-react, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` — §2 decisions 3–6, 13, 14; §3; §5.4; §5.5; §6 phase 3.

**User rulings (2026-09-25), binding on this plan:**
- **Breadth:** all `components/ui/*` primitives are in scope, not only the spec's Section/Button/Tick.
- **`.cl-btn`:** restyle `.cl-btn` / `.cl-btn-hot` in `main.css` now as a stopgap matching Button's quiet/primary looks. Call sites still migrate to `<Button>` in phase 5.
- Carried from 2b: the Sheaf context menu (the shared `ui/menu`) and `TabPreviewCard` are restyled here; the Sheaf "+" and tab buttons get the shared focus ring.

## Global Constraints (the visual contract)

- **Type:** Geist for all primitive text; labels sentence case, 12.5–14px, `mute` (decision 4). Instrument Serif italic only for section eyebrows and dialog titles (decision 3). Never uppercase or tracked.
- **Surfaces:** radius 12px for popovers, menus, dialogs, cards; 16–22px for the palette-sized sheets; full pill for buttons and text/search fields; ticks 1px (decision 13).
- **Separation:** no hairline borders. Fields sit on `sink`; overlays are `raise` with `shadow-lg` (the soft `--elev-*`); rows highlight with `sink` on hover and `accent-tint` when selected (decisions 5, 14).
- **Colour roles:** `ground`, `raise`, `sink`, `ink`, `ink-2`, `mute`, `faint`, `accent`, `accent-tint`, `hot` (danger). Do not use `paper-2`, `ink-mute`, `muted-foreground`, `border-border` in touched files.
- **Focus:** every interactive primitive uses the shared `FOCUS_RING` (RAC `data-[focus-visible]`) or `FOCUS_RING_NATIVE` (`:focus-visible`) from `ui/src/lib/focusRing.ts`.
- **Ticks:** 7px square, 1px radius; `live` cobalt, `pulse` cobalt pulsing, `faint` (decision 6).
- **Guard tokens** (forbidden in guarded files): `uppercase`, `tracking-`, `cl-mono`, `cl-serif`, `font-mono`, `border-ink`, `border-[`, `border-rule`, `border-border`, a bare `border` class, `rounded-none`, `text-[9px]`, `text-[10px]`, `text-[11px]`, `paper-2`, `ink-mute`, `muted-foreground`.
- **Out of scope:** `components/ui/command-palette.tsx` (restyled with the palette in phase 4); screen code (phases 4–5); `.cl-btn` call-site migration (phase 5).
- Gates from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`; diff the full-suite FAIL list against develop's baseline (836 after 2b); only new failures count.

## Review Focus

1. **Keyboard focus visibility on every restyled control.** Removing borders must not remove the only focus cue. Pinned by the Task 1 guard (each guarded interactive file references `FOCUS_RING`/`FOCUS_RING_NATIVE`), checked in the smoke.
2. **Disabled and invalid states.** Without borders, a disabled button or an invalid field must still read as such (opacity / `hot` text + `aria-invalid` styling). Pinned in Tasks 3 and 5.
3. **Dialogs in charcoal.** `raise` over the dimmed ground must stay distinct; the scrim is ink at 26–40%. Checked in the smoke.
4. **Section `tight` / `wrapHeader` callers.** The six Card importers keep their layout options; nothing collapses. Pinned in Task 2.
5. **Checkbox/radio affordance without borders.** Unchecked controls must remain visible on `ground` and `raise` (sink fill + inset ring). Pinned in Task 5.

---

### Task 1: Guard test and the shared focus ring

**Files:**
- Create: `ui/src/lib/focusRing.ts`, `ui/src/lib/focusRing.test.ts`
- Create: `ui/src/__tests__/primitivesGuard.test.ts`
- Modify: `ui/src/components/codex/Sheaf.tsx` ("+" button and tab buttons get `FOCUS_RING_NATIVE`)

**Interfaces:**
- Produces: `FOCUS_RING` (RAC data attributes) and `FOCUS_RING_NATIVE` (`focus-visible:`) class strings; `PENDING` set in the guard, shrunk by Tasks 2–5.

- [ ] **Step 1: Failing tests**

`ui/src/lib/focusRing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FOCUS_RING, FOCUS_RING_NATIVE } from "#/lib/focusRing";

describe("focus ring", () => {
  it("draws a 2px cobalt ring offset on the ground for RAC focus-visible", () => {
    expect(FOCUS_RING).toContain("outline-none");
    expect(FOCUS_RING).toContain("data-[focus-visible]:ring-2");
    expect(FOCUS_RING).toContain("data-[focus-visible]:ring-accent");
  });

  it("offers the same ring for native :focus-visible", () => {
    expect(FOCUS_RING_NATIVE).toContain("focus-visible:ring-2");
    expect(FOCUS_RING_NATIVE).toContain("focus-visible:ring-accent");
  });
});
```

`ui/src/__tests__/primitivesGuard.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "..");
const uiDir = path.join(src, "components/ui");

/** Restyled in phase 4 with the command palette. */
const OUT_OF_SCOPE = new Set(["command-palette.tsx"]);

/** Not yet restyled; each task removes its files. `it.fails` makes a file
 *  that is already clean fail, forcing its removal here. */
const PENDING = new Set<string>([
  "button.tsx",
  "icon-button.tsx",
  "badge.tsx",
  "CopyButton.tsx",
  "task-status-button.tsx",
  "section-heading.tsx",
  "menu.tsx",
  "dialog.tsx",
  "tooltip.tsx",
  "Toaster.tsx",
  "lightbox.tsx",
  "editor-suggestion-popover.tsx",
  "select.tsx",
  "text-field.tsx",
  "search-field.tsx",
  "checkbox.tsx",
  "checkbox-group.tsx",
  "radio-group.tsx",
  "tabs.tsx",
  "tag-input.tsx",
  "../codex/TabPreviewCard.tsx",
]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["uppercase", /\buppercase\b/],
  ["tracking", /\btracking-/],
  ["cl-mono", /\bcl-mono\b/],
  ["cl-serif", /\bcl-serif\b/],
  ["font-mono", /\bfont-mono\b/],
  ["border-ink", /\bborder-ink\b/],
  ["border-[…]", /\bborder-\[/],
  ["border-rule", /\bborder-rule\b/],
  ["border-border", /\bborder-border\b/],
  ["bare border", /["'\s]border["'\s]/],
  ["rounded-none", /\brounded-none\b/],
  ["9–11px type", /\btext-\[(9|10|11)px\]/],
  ["paper-2", /\bpaper-2\b/],
  ["ink-mute", /\bink-mute\b/],
  ["muted-foreground", /\bmuted-foreground\b/],
];

const files = [
  ...readdirSync(uiDir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".stories."))
    .filter((f) => !OUT_OF_SCOPE.has(f)),
  "../codex/TabPreviewCard.tsx",
  "../codex/Section.tsx",
  "../codex/Tick.tsx",
].filter((f) => {
  try {
    readFileSync(path.join(uiDir, f));
    return true;
  } catch {
    return false; // Section/Tick appear in Task 2
  }
});

function offences(file: string): string[] {
  const text = readFileSync(path.join(uiDir, file), "utf8");
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("Stone & Lamp primitives carry no Vessel chrome", () => {
  for (const file of files) {
    const run = PENDING.has(file) ? it.fails : it;
    run(`${file} is clean`, () => {
      expect(offences(file)).toEqual([]);
    });
  }

  it("every pending file still exists", () => {
    for (const file of PENDING) {
      expect(files).toContain(file);
    }
  });
});
```

- [ ] **Step 2:** Run `cd ui && bun run test src/lib/focusRing.test.ts src/__tests__/primitivesGuard.test.ts`. Expected: focusRing FAIL (module missing). Guard: every PENDING file passes (as an expected failure) and every non-pending file passes clean. **If a non-pending file fails, it has Vessel tokens the survey missed: add it to PENDING and ledger it.** If a pending file is already clean, remove it from PENDING.

- [ ] **Step 3: Implement** `ui/src/lib/focusRing.ts`:

```ts
/** The one keyboard-focus cue for Stone & Lamp controls: a 2px cobalt ring,
 *  offset on the page ground so it reads on sink and raise fills too. */
export const FOCUS_RING =
  "outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent data-[focus-visible]:ring-offset-2 data-[focus-visible]:ring-offset-ground";

/** Same ring for plain elements (no React Aria focus attributes). */
export const FOCUS_RING_NATIVE =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ground";
```

In `Sheaf.tsx`, add `FOCUS_RING_NATIVE` (via `cn`) to the tab activation button, the close button and the "+" button; remove the "+" button's `focus-visible:outline-none` (the constant owns outline). Add to `Sheaf.test.tsx`:

```tsx
  it("gives the + and tab buttons a visible keyboard focus ring", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    for (const name of ["New page", "Alpha"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "focus-visible:ring-2",
      );
    }
  });
```

(Write this test before the Sheaf edit and watch it fail.)

- [ ] **Step 4:** Run the three test files. Expected: PASS. `bun run typecheck && bun run lint`: 0.

- [ ] **Step 5: Commit** `feat(ui): shared focus ring and primitives guard`.

---

### Task 2: Tick and Section (replacing Card)

**Files:**
- Create: `ui/src/components/codex/Tick.tsx`, `ui/src/components/codex/Section.tsx`, `ui/src/components/codex/Section.test.tsx`
- Delete: `ui/src/components/codex/Card.tsx`, `ui/src/components/codex/Card.test.tsx`
- Modify (swap `Card` → `Section`, drop `FIG.` captions): `SkyCard.tsx` (caption "FIG. III"), `Stats.tsx` ("FIG. I — STEADY-STATE TELEMETRY" → "Steady-state telemetry"; "FIG. V" → none), `Atrium.tsx` (inline "FIG. VI" span removed; "FIG. VII" → none; "FIG. IV — CAPTURES PER DAY · UTC" → "Captures per day · UTC"), `FeedManagement.tsx`, `FeedRiverPanel.tsx`, `AgendaTile.tsx`, and any tests asserting "FIG."

**Interfaces:**
- Produces:
  - `Tick({ variant = "live", className }: { variant?: "live" | "pulse" | "faint"; className?: string })` — a 7×7px, 1px-radius `aria-hidden` span: `live` `bg-accent`, `pulse` `bg-accent animate-pulse`, `faint` `bg-faint`.
  - `Section` with Card's props exactly: `{ label: string; caption?: ReactNode; action?: ReactNode; pip?: "cool" | "hot" | "dim"; tight?: boolean; wrapHeader?: boolean; className?: string; children: ReactNode }`. `pip` maps `cool→live`, `hot→pulse`, `dim→faint`.

- [ ] **Step 1: Failing tests** `Section.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Section } from "#/components/codex/Section";

describe("Section", () => {
  it("renders the eyebrow as a heading, caption and children", () => {
    render(
      <Section label="Recent" caption="2 of 2">
        <p>body</p>
      </Section>,
    );
    const heading = screen.getByRole("heading", { name: "Recent" });
    expect(heading).toHaveClass("font-serif", "italic");
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("omits the caption node when none is given", () => {
    const { container } = render(<Section label="Sky">x</Section>);
    expect(container.querySelector("[data-section-caption]")).toBeNull();
  });

  it.each([
    ["cool", "bg-accent", false],
    ["hot", "bg-accent", true],
    ["dim", "bg-faint", false],
  ] as const)("maps pip %s to a tick", (pip, bg, pulses) => {
    const { container } = render(
      <Section label="L" pip={pip}>
        x
      </Section>,
    );
    const tick = container.querySelector("[data-tick]");
    expect(tick).toHaveClass(bg);
    expect(tick?.classList.contains("animate-pulse")).toBe(pulses);
  });

  it("indents the body to the eyebrow unless tight", () => {
    const { rerender } = render(<Section label="L">x</Section>);
    expect(screen.getByText("x").closest("[data-section-body]")).toHaveClass(
      "pl-[19px]",
    );
    rerender(
      <Section label="L" tight>
        x
      </Section>,
    );
    expect(
      screen.getByText("x").closest("[data-section-body]"),
    ).not.toHaveClass("pl-[19px]");
  });

  it("has no border, band or fill", () => {
    const { container } = render(<Section label="L">x</Section>);
    const section = container.querySelector("section");
    expect(section?.className ?? "").not.toMatch(/border|bg-/);
  });
});
```

- [ ] **Step 2:** Run it. Expected: FAIL (module missing).

- [ ] **Step 3: Implement.**

`Tick.tsx`:

```tsx
import { cn } from "#/lib/cn";

export type TickVariant = "live" | "pulse" | "faint";

const TICK: Record<TickVariant, string> = {
  live: "bg-accent",
  pulse: "bg-accent animate-pulse",
  faint: "bg-faint",
};

/** The section tick (spec decision 6): a 7px square in front of every
 *  eyebrow — cobalt when live, pulsing when streaming, faint when dimmed. */
export function Tick({
  variant = "live",
  className,
}: {
  variant?: TickVariant;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-tick
      className={cn(
        "inline-block h-[7px] w-[7px] flex-shrink-0 rounded-[1px]",
        TICK[variant],
        className,
      )}
    />
  );
}
```

`Section.tsx`:

```tsx
import type { ReactNode } from "react";
import { Tick, type TickVariant } from "#/components/codex/Tick";
import { cn } from "#/lib/cn";

type Pip = "cool" | "hot" | "dim";
const PIP_TICK: Record<Pip, TickVariant> = {
  cool: "live",
  hot: "pulse",
  dim: "faint",
};

/** A titled block (spec §5.4): tick + italic serif eyebrow + caption +
 *  action, then the body indented to the eyebrow. No border, band or fill. */
export function Section({
  label,
  caption,
  action,
  pip = "cool",
  tight = false,
  wrapHeader = false,
  className,
  children,
}: {
  label: string;
  caption?: ReactNode;
  action?: ReactNode;
  pip?: Pip;
  tight?: boolean;
  wrapHeader?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-[22px]", className)}>
      <div
        className={cn(
          "flex items-center gap-3",
          wrapHeader && "min-w-0 flex-wrap",
        )}
      >
        <Tick variant={PIP_TICK[pip]} />
        <h2 className="truncate font-serif text-[22px] italic leading-none text-ink">
          {label}
        </h2>
        {caption ? (
          <span
            data-section-caption
            className={cn(
              "text-[13px] text-mute",
              wrapHeader ? "whitespace-normal" : "whitespace-nowrap",
            )}
          >
            {caption}
          </span>
        ) : null}
        <span className="flex-1" />
        {action ? (
          <div
            className={cn(
              "flex items-center gap-2.5 text-[13.5px] text-accent",
              wrapHeader ? "min-w-0 flex-wrap" : "flex-shrink-0",
            )}
          >
            {action}
          </div>
        ) : null}
      </div>
      <div data-section-body className={cn("min-w-0", !tight && "pl-[19px]")}>
        {children}
      </div>
    </section>
  );
}
```

Swap every importer from `Card` to `Section` (same props), make the `FIG.` edits listed above, delete `Card.tsx` and `Card.test.tsx`. Search tests for `FIG.` (`rg -n "FIG\\." ui/src --glob '*test*'`) and update them to the new captions.

- [ ] **Step 4:** Run `bun run test src/components/codex/Section.test.tsx src/components/codex src/__tests__/primitivesGuard.test.ts` (compare failures with baseline — Atrium/Stats suites may already fail environmentally); `bun run typecheck && bun run lint`.

- [ ] **Step 5: Commit** `feat(ui): Tick and Section replace Card`.

---

### Task 3: Buttons, badges and the `.cl-btn` stopgap

**Files:**
- Modify: `ui/src/components/ui/button.tsx`, `icon-button.tsx`, `badge.tsx`, `CopyButton.tsx`, `task-status-button.tsx`, `section-heading.tsx` and their tests/stories as needed
- Modify: `ui/src/main.css` (`.cl-btn`, `.cl-btn:hover`, `.cl-btn-hot`, `.cl-btn-hot:hover`)
- Modify: `ui/src/__tests__/themeFonts.test.ts` (or a new `buttonsCss.test.ts`) for the stopgap contract
- Modify: `primitivesGuard.test.ts` (remove these files from `PENDING`)

**Contract:**
- `Button` variants: `primary` — `bg-accent text-raise` pill, hover slightly darker (`hover:bg-accent/90`); `secondary` (the spec's *quiet*) — `bg-sink text-ink` with `rounded-[14px]`, hover `bg-sink/70`; `ghost` — text only, `text-mute hover:text-ink`; `danger` — `bg-hot text-raise` pill. Sizes: `md` 44px tall (`h-11 px-5 text-[14px]`), `sm` 32px (`h-8 px-3.5 text-[13px]`), `icon` 32px round. All `font-medium`, sentence case, `FOCUS_RING`, disabled `opacity-45 cursor-not-allowed`.
- `IconButton`: 32–40px round, `text-mute hover:text-ink hover:bg-sink`, `FOCUS_RING`; keeps its required `aria-label`.
- `Badge`: pill, `text-[12px]`, tones via existing variants mapped to `accent-tint/accent`, `sink/ink-2`, `hot/12 + hot`.
- `SectionHeading`: `Tick` + `font-serif italic text-[20px] text-ink` (no caps).
- `.cl-btn`: `display:inline-flex; gap:6px; height:32px; padding:0 14px; border:0; border-radius:14px; background:var(--sink); color:var(--ink); font:500 13px var(--font-sans); text-transform:none; letter-spacing:normal`; hover `background: color-mix(in srgb, var(--sink) 70%, var(--ink) 8%)`. `.cl-btn-hot`: `background:var(--accent); color:var(--raise); border-radius:9999px`; hover `filter: brightness(0.94)`.

- [ ] **Step 1: Failing tests.**
  - Update `button.test.tsx`: assert `primary` has `bg-accent` and `rounded-full`, `secondary` has `bg-sink`, `ghost` has neither fill, every variant has `data-[focus-visible]:ring-2` and no `uppercase`; a disabled button has `data-[disabled]:opacity-45`.
  - `icon-button.test.tsx`: `rounded-full` and the focus ring.
  - CSS contract (new `ui/src/__tests__/buttonsCss.test.ts` using `rule`/`prop` from `css-contract.ts`): `.cl-btn` `text-transform: none`, `letter-spacing: normal`, `border: 0`, `border-radius: 14px`, `background: var(--sink)`; `.cl-btn-hot` `background: var(--accent)`, `color: var(--raise)`, `border-radius: 9999px`.
  - Remove the six files from `PENDING`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Restyle to the contract. Keep every exported name, prop and variant key (57 importers depend on them). Update `button.stories.tsx` copy if it shows caps.
- [ ] **Step 4:** Run `bun run test src/components/ui src/__tests__` + typecheck + lint. Existing `themeFonts` assertion `.cl-btn font-family var(--font-sans)` must still pass.
- [ ] **Step 5: Commit** `feat(ui): Stone & Lamp buttons, badges, and a .cl-btn stopgap`.

---

### Task 4: Overlays — menu, popover, dialog, tooltip, toaster, lightbox, suggestions, preview card

**Files:**
- Modify: `ui/src/components/ui/menu.tsx`, `popover.tsx`, `dialog.tsx`, `tooltip.tsx`, `Toaster.tsx`, `lightbox.tsx`, `editor-suggestion-popover.tsx`, `ui/src/components/codex/TabPreviewCard.tsx`, their tests as needed
- Modify: `primitivesGuard.test.ts` (remove these from `PENDING`)

**Contract:**
- Menu / popover / suggestion popover: `bg-raise rounded-xl shadow-lg p-1.5 text-[13.5px] text-ink`, no border; items `rounded-lg px-3 py-1.5`, `data-[focused]:bg-sink`, `data-[selected]:bg-accent-tint`, destructive items `text-hot`; section headers `text-[12px] text-mute px-3 pt-2 pb-1` (sentence case); separators become 6px of space, not a rule. `Popover` drops the `OverlayArrow` by default (`hideArrow` default true; callers that pass `hideArrow={false}` keep it).
- Dialog: overlay `bg-ink/30` (charcoal: same token), panel `bg-raise rounded-2xl shadow-xl p-7 max-w-[560px]`, title `font-serif italic text-[26px] text-ink`, body `text-[14px] text-ink-2`, footer actions right-aligned with 12px gap using `Button`.
- Tooltip: `bg-ink text-ground rounded-lg px-2.5 py-1 text-[12.5px] shadow-md`.
- Toaster: `bg-raise rounded-xl shadow-lg px-4 py-3 text-[13.5px]`, tone shown by a leading `Tick` (`live` success/info, `pulse` pending, `hot`-coloured dot for error — add `hot` to Tick only if needed; otherwise a `bg-hot` 7px span).
- Lightbox: scrim `bg-ink/80`, controls as `IconButton`s, caption `text-[13px] text-ground/80`.
- TabPreviewCard: `bg-raise rounded-xl shadow-lg p-4 w-[340px]`; kind line `text-[12.5px] text-mute` sentence case; title `font-serif text-[20px] text-ink`; snippet `text-[13px] text-ink-2 line-clamp-3`; meta right-aligned `text-[12px] text-faint`.

- [ ] **Step 1: Failing tests.** Remove the eight files from `PENDING` (guard goes RED for them). Add to `menu.test.tsx`: the popover panel has `rounded-xl` and `shadow-lg` and no `border-`; items have no `uppercase`. Add to `dialog.test.tsx`: the title has `font-serif`, the panel `rounded-2xl`. Add a `TabPreviewCard` test (new file `ui/src/components/codex/__tests__/TabPreviewCard.test.tsx` if none exists; mock its data hook the way `Sheaf.test.tsx` does) asserting `rounded-xl` and no border.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Restyle to the contract. Keep every export, prop, role and ARIA name (menu/dialog behaviour tests pin them).
- [ ] **Step 4:** Run `bun run test src/components/ui src/components/codex/__tests__/Sheaf*.test.tsx src/components/codex/__tests__/TabPreviewCard.test.tsx src/__tests__` + typecheck + lint; diff other failures against baseline.
- [ ] **Step 5: Commit** `feat(ui): Stone & Lamp overlays and tab preview card`.

---

### Task 5: Form controls

**Files:**
- Modify: `ui/src/components/ui/select.tsx`, `list-box.tsx`, `text-field.tsx`, `search-field.tsx`, `checkbox.tsx`, `checkbox-group.tsx`, `radio-group.tsx`, `segmented-control.tsx`, `tabs.tsx`, `tag-input.tsx`, their tests as needed
- Modify: `primitivesGuard.test.ts` (PENDING becomes empty; delete the constant's entries and keep the mechanism)

**Contract:**
- Text / search fields: pill `rounded-full bg-sink px-4 h-10 text-[14px] text-ink placeholder:text-mute`, no border, `FOCUS_RING` on the input's focus-visible (use `data-[focus-visible]` on the RAC `Input`), invalid `aria-invalid:ring-2 aria-invalid:ring-hot` and error text `text-[12.5px] text-hot`; label `text-[12.5px] text-mute mb-1.5`.
- Select trigger: same pill as fields, chevron `text-mute`; its popover and list items follow Task 4's menu contract.
- ListBox: items `rounded-lg px-3 py-1.5`, focused `bg-sink`, selected `bg-accent-tint`.
- Checkbox / radio: 16px box (radio round, checkbox `rounded-[5px]`), unchecked `bg-sink shadow-[inset_0_0_0_1.5px_var(--faint)]`, checked `bg-accent` with a `text-raise` check/dot, `FOCUS_RING`; label `text-[14px] text-ink`, description `text-[12.5px] text-mute`.
- Segmented control / tabs: a `bg-sink rounded-full p-1` track; selected segment `bg-raise shadow-sm rounded-full text-ink font-medium`; others `text-mute`. Tabs (non-segmented `tabs.tsx`) may instead use the Atrium style: text tabs with a 1.5px cobalt underline offset 7px for the selected one — pick one and ledger it.
- Tag input: chips `rounded-full bg-sink px-2.5 h-7 text-[13px]`, remove button an `IconButton`-style 20px round; the input follows the field contract.

- [ ] **Step 1: Failing tests.** Empty `PENDING`. Add to `text-field.test.tsx`: the input has `rounded-full` and `bg-sink`; with `isInvalid`, the error text has `text-hot`. Add to `checkbox.test.tsx`: the unchecked box has `bg-sink` and the checked box `bg-accent`. Add to `segmented-control.test.tsx`: the selected segment has `bg-raise`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Restyle to the contract, keeping every export, prop and ARIA behaviour. `select.test.tsx:250` asserts `w-full text-start` on the trigger — keep those classes.
- [ ] **Step 4:** Run `bun run test src/components/ui src/__tests__` + typecheck + lint.
- [ ] **Step 5: Commit** `feat(ui): Stone & Lamp form controls`.

---

### Task 6: Gates, smoke, docs, merge

- [ ] **Step 1: Full gates** as in Global Constraints; no new failures vs the baseline list captured before Task 1.
- [ ] **Step 2: Browser smoke** (scratch vault only; `CLEPSYDRA__VAULT__ROOT`, local `config.toml`; `clep serve` :3917, `bun run dev --port 5917`). In bone and charcoal: Atrium sections (ticks, italic eyebrows, no FIG captions), Stats; Settings dialog (fields, segmented controls, checkboxes); a Select (Tasking or Bases); a Sheaf context menu and tab preview; a tooltip; a toast (e.g. save); the Contents sheet unchanged; tab through a dialog and the header to confirm the focus ring everywhere; a disabled button. Screenshots to the scratchpad.
- [ ] **Step 3: Docs.** `ui/CLAUDE.md` Design Aesthetic: phases 1–3 done; primitives list (`Section`, `Tick`, `FOCUS_RING`, Button variants incl. "secondary = quiet"); the guard test keeps `components/ui` clean. Spec status line. Update `getting-started.mdx` "Pips and status colours" → ticks where it describes card pips.
- [ ] **Step 4: Commit, then finish** with superpowers:finishing-a-development-branch (merge to develop per the project workflow; audit `git log <branch>..develop` first).
