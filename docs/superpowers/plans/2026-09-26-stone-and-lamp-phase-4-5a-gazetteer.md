# Stone & Lamp Phase 4.5a — Gazetteer Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the desktop Gazetteer to the approved Stone & Lamp table (serif header, Compact switch, segmented sort, borderless dense table), with rows per page fitted to the viewport and the row range plus page links moved into the shell footer.

**Architecture:** Three reusable pieces land first, because phase 4.5b (Bases) reuses them: a `Switch` primitive plus a per-screen `useTableCompact` preference; a footer controls slot (a portal host in `ShellFooter` that a screen fills with `FooterControls`); and pure paging helpers plus a debounced `useElementHeight` hook. The Gazetteer then consumes them. Mobile (`MobileGazetteer`) is untouched; it keeps 20 rows per page and its own pager until phase 4b.

**Tech Stack:** React 19, Tailwind v4 tokens, react-aria-components (`Switch`, `RadioGroup`), zustand, TanStack Query via openapi-react-query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§5.1 footer, §5.6 dense tables, §9 Q2). Approved mockups: canvas https://claude.ai/artifact/WAmCEdwj8osAmkLkRxGkQd, boards `Gazetteer.dc.html` and `GazetteerCompact.dc.html`.

**User rulings (2026-09-26):** 4.5 split into 4.5a Gazetteer / 4.5b Bases; paging lives in the footer as mocked (the Previous/Next bar under the table goes); rows per page fit the viewport.

## Global Constraints

- Dense tables: no cell borders. Header row Geist 12.5px `mute`, sentence case. Hover `sink`, selected `accent-tint`. Numerals tabular.
- Compact: 32px rows, title 13.5px, meta 12.5px. Comfortable: 42px rows, title 14.5px, meta 13px. The Gazetteer defaults to compact.
- One **Compact** switch (`role="switch"`) per table screen, persisted per screen. The global `data-density` preset sets the default the switch starts from.
- Checkbox column 44px, No. column 52px; the title column takes the remaining width.
- Footer right side for tables: row range and pagination.
- Guard (`src/__tests__/primitivesGuard.test.ts`) forbids: `uppercase`, positive `tracking-*`, `cl-mono`, `cl-serif`, `font-mono`, `border-ink`, `border-[…]`, `border-rule`, `border-border`, bare `border`, `rounded-none`, `text-[9|10|11px]`, `paper-2`, `ink-mute`, `muted-foreground`.
- Scope biome `--write` to files you touched. Never run `clep` against the live vault.

## Review Focus

1. **Resize storms:** dragging the window edge fires ResizeObserver continuously; each new page size is a new query key. Expect one refetch after the drag settles (150ms debounce), not dozens.
2. **Deep links:** `/gazetteer?page=5` opened cold must stay on page 5 in the new page size; only a size change *after* the first measurement re-pages (keeping the first visible row) and does so with `replace`, so Back is not polluted.
3. **Tiny windows:** a table area shorter than a few rows must still show at least 5 rows per page (scrolling inside the table), never 0 or negative.
4. **Footer ownership:** the paging controls must leave the footer when the Gazetteer unmounts (navigating to Folio must not leave stale page links).
5. **Mobile unaffected:** `useMobileLayout() === true` keeps 20-row server pages and fetches immediately (no measurement gate).

Tests for 1–5 live in Tasks 3 and 5.

---

### Task 1: `Switch` primitive and the per-screen Compact preference

**Files:**
- Create: `ui/src/components/ui/switch.tsx`
- Create: `ui/src/components/ui/__tests__/switch.test.tsx`
- Create: `ui/src/hooks/useTableCompact.ts`
- Create: `ui/src/hooks/useTableCompact.test.ts`

**Interfaces:**
- Produces: `Switch(props: SwitchProps)` where `SwitchProps extends RACSwitchProps` (children = visible label).
- Produces: `type TableScreen = "gazetteer" | "bases"`; `tableCompactKey(screen): string` → `` `clepsydra.tableCompact.${screen}` ``; `compactDefault(density: Density, screenDefault: boolean): boolean`; `useTableCompact(screen, screenDefault): [boolean, (next: boolean) => void]`.

- [ ] **Step 1: Write the failing tests**

`ui/src/components/ui/__tests__/switch.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "#/components/ui/switch";

describe("Switch", () => {
  it("is a labelled switch that toggles", async () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>Compact</Switch>);
    const sw = screen.getByRole("switch", { name: "Compact" });
    expect(sw).not.toBeChecked();
    await userEvent.setup().click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reflects a controlled selection", () => {
    render(<Switch isSelected>Compact</Switch>);
    expect(screen.getByRole("switch", { name: "Compact" })).toBeChecked();
  });
});
```

`ui/src/hooks/useTableCompact.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  compactDefault,
  tableCompactKey,
  useTableCompact,
} from "#/hooks/useTableCompact";

beforeEach(() => localStorage.clear());

describe("compactDefault", () => {
  it("follows the compact and spacious presets, else the screen's default", () => {
    expect(compactDefault("compact", false)).toBe(true);
    expect(compactDefault("spacious", true)).toBe(false);
    expect(compactDefault("default", true)).toBe(true);
    expect(compactDefault("default", false)).toBe(false);
  });
});

describe("useTableCompact", () => {
  it("starts from the screen default under the default preset", () => {
    const { result } = renderHook(() => useTableCompact("gazetteer", true));
    expect(result.current[0]).toBe(true);
  });

  it("starts from the global preset when nothing is stored", () => {
    localStorage.setItem("clepsydra.density", "spacious");
    const { result } = renderHook(() => useTableCompact("gazetteer", true));
    expect(result.current[0]).toBe(false);
  });

  it("persists a choice per screen", () => {
    const { result, unmount } = renderHook(() =>
      useTableCompact("gazetteer", true),
    );
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(tableCompactKey("gazetteer"))).toBe("false");
    unmount();
    const again = renderHook(() => useTableCompact("gazetteer", true));
    expect(again.result.current[0]).toBe(false);
    const other = renderHook(() => useTableCompact("bases", false));
    expect(other.result.current[0]).toBe(false);
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem(tableCompactKey("gazetteer"), "maybe");
    const { result } = renderHook(() => useTableCompact("gazetteer", true));
    expect(result.current[0]).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && bun run test src/components/ui/__tests__/switch.test.tsx src/hooks/useTableCompact.test.ts`
Expected: FAIL — cannot resolve `#/components/ui/switch` and `#/hooks/useTableCompact`.

- [ ] **Step 3: Implement**

`ui/src/components/ui/switch.tsx`:

```tsx
import {
  composeRenderProps,
  Switch as RACSwitch,
  type SwitchProps as RACSwitchProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export type SwitchProps = RACSwitchProps;

/** A labelled on/off switch (spec §9 Q2: the tables' Compact switch): a
 *  sink pill holding a 30×18 track, cobalt when on. */
export function Switch({ className, children, ...props }: SwitchProps) {
  return (
    <RACSwitch
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(
          "group flex h-9 cursor-default items-center gap-2.5 rounded-full bg-sink pr-3.5 pl-2.5 text-[13px] text-ink",
          FOCUS_RING,
          prev,
        ),
      )}
    >
      {composeRenderProps(children, (kids) => (
        <>
          <span
            aria-hidden
            className="relative block h-[18px] w-[30px] rounded-full bg-faint transition-colors group-data-[selected]:bg-accent"
          >
            <span className="absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-raise shadow-sm transition-transform group-data-[selected]:translate-x-3" />
          </span>
          {kids}
        </>
      ))}
    </RACSwitch>
  );
}
```

`ui/src/hooks/useTableCompact.ts`:

```ts
import { useCallback, useState } from "react";
import { type Density, readStoredDensity } from "#/lib/theme";

export type TableScreen = "gazetteer" | "bases";

export const tableCompactKey = (screen: TableScreen) =>
  `clepsydra.tableCompact.${screen}`;

/** The switch's starting point (spec §9 Q2): the compact and spacious
 *  presets decide; the default preset defers to the screen. */
export function compactDefault(
  density: Density,
  screenDefault: boolean,
): boolean {
  if (density === "compact") return true;
  if (density === "spacious") return false;
  return screenDefault;
}

function readStored(screen: TableScreen): boolean | null {
  try {
    const raw = window.localStorage.getItem(tableCompactKey(screen));
    return raw === "true" ? true : raw === "false" ? false : null;
  } catch {
    return null;
  }
}

/** A table screen's Compact switch, persisted per screen on this device. */
export function useTableCompact(
  screen: TableScreen,
  screenDefault: boolean,
): [boolean, (next: boolean) => void] {
  const [stored, setStored] = useState<boolean | null>(() =>
    readStored(screen),
  );
  const set = useCallback(
    (next: boolean) => {
      setStored(next);
      try {
        window.localStorage.setItem(tableCompactKey(screen), String(next));
      } catch {
        // storage unavailable — the choice lasts for this visit only
      }
    },
    [screen],
  );
  return [stored ?? compactDefault(readStoredDensity(), screenDefault), set];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && bun run test src/components/ui/__tests__/switch.test.tsx src/hooks/useTableCompact.test.ts src/__tests__/primitivesGuard.test.ts`
Expected: PASS (the guard picks up `switch.tsx` automatically and finds nothing forbidden).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ui/switch.tsx ui/src/components/ui/__tests__/switch.test.tsx ui/src/hooks/useTableCompact.ts ui/src/hooks/useTableCompact.test.ts
git commit -m "feat(ui): Switch primitive and per-screen Compact preference"
```

---

### Task 2: Footer controls slot

**Files:**
- Create: `ui/src/store/footerControls.ts`
- Create: `ui/src/components/codex/FooterControls.tsx`
- Modify: `ui/src/components/codex/ShellFooter.tsx` (render `<FooterControlsHost />` after `<Context />`)
- Test: `ui/src/components/codex/ShellFooter.test.tsx`

**Interfaces:**
- Produces: `useFooterControlsStore` (`{ host: HTMLElement | null; setHost(host) }`); `FooterControlsHost()` (the portal target); `FooterControls({ children })` (portals into the host, renders nothing without one).

- [ ] **Step 1: Write the failing tests** — append to `ShellFooter.test.tsx`:

```tsx
import { FooterControls } from "#/components/codex/FooterControls";

describe("footer controls slot", () => {
  it("shows a screen's controls on the right of the footer", () => {
    render(
      <>
        <ShellFooter view="gazetteer" />
        <FooterControls>
          <span>1–20 of 40</span>
        </FooterControls>
      </>,
    );
    expect(
      within(screen.getByRole("contentinfo")).getByText("1–20 of 40"),
    ).toBeVisible();
  });

  it("drops the controls when their screen unmounts", () => {
    const view = render(
      <>
        <ShellFooter view="gazetteer" />
        <FooterControls>
          <span>1–20 of 40</span>
        </FooterControls>
      </>,
    );
    view.rerender(<ShellFooter view="folio" />);
    expect(screen.queryByText("1–20 of 40")).toBeNull();
  });
});
```

Add `within` to the file's `@testing-library/react` import.

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && bun run test src/components/codex/ShellFooter.test.tsx`
Expected: FAIL — cannot resolve `#/components/codex/FooterControls`.

- [ ] **Step 3: Implement**

`ui/src/store/footerControls.ts`:

```ts
import { create } from "zustand";

interface FooterControlsState {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
}

/** Where a screen's footer controls render (spec decision 12: tables put
 *  their row range and pagination in the footer). */
export const useFooterControlsStore = create<FooterControlsState>((set) => ({
  host: null,
  setHost: (host) => set({ host }),
}));
```

`ui/src/components/codex/FooterControls.tsx`:

```tsx
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFooterControlsStore } from "#/store/footerControls";

/** The footer's portal target; ShellFooter renders it on the right. */
export function FooterControlsHost() {
  const setHost = useFooterControlsStore((s) => s.setHost);
  return (
    <span
      data-slot="footer-controls"
      ref={setHost}
      className="flex items-center gap-4 empty:hidden"
    />
  );
}

/** Renders `children` in the shell footer while mounted. */
export function FooterControls({ children }: { children: ReactNode }) {
  const host = useFooterControlsStore((s) => s.host);
  return host ? createPortal(children, host) : null;
}
```

In `ShellFooter.tsx`, import `FooterControlsHost` and render it last:

```tsx
      <span className="flex-1" />
      <Context view={view} />
      <FooterControlsHost />
    </footer>
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && bun run test src/components/codex/ShellFooter.test.tsx`
Expected: PASS (all ShellFooter tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/footerControls.ts ui/src/components/codex/FooterControls.tsx ui/src/components/codex/ShellFooter.tsx ui/src/components/codex/ShellFooter.test.tsx
git commit -m "feat(ui): footer controls slot for screen paging"
```

---

### Task 3: Paging helpers and `useElementHeight`

**Files:**
- Create: `ui/src/components/codex/gazetteer-paging.ts`
- Create: `ui/src/components/codex/gazetteer-paging.test.ts`
- Create: `ui/src/hooks/useElementHeight.ts`
- Create: `ui/src/hooks/useElementHeight.test.tsx`

**Interfaces:**
- Produces: `FALLBACK_PAGE_SIZE = 20`; `MIN_PAGE_SIZE = 5`; `rowsThatFit(height: number, compact: boolean): number`; `repage(page: number, fromSize: number, toSize: number): number`; `pageItems(current: number, count: number): Array<number | "gap">`; `rangeLabel(page: number, size: number, shown: number, total: number): string`.
- Produces: `useElementHeight<T extends HTMLElement>(debounceMs?: number): [(node: T | null) => void, number | null]` — `null` until an element attaches; the first measurement is synchronous, later ones debounced.

Table geometry the helpers encode (from the mockup): compact = 32px rows under a 34px header with 14px top padding (overhead 48); comfortable = 42px rows under a 40px header with 20px top padding (overhead 60).

- [ ] **Step 1: Write the failing tests**

`ui/src/components/codex/gazetteer-paging.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  pageItems,
  rangeLabel,
  repage,
  rowsThatFit,
} from "./gazetteer-paging";

describe("rowsThatFit", () => {
  it("falls back to 20 before layout (jsdom, hidden)", () => {
    expect(rowsThatFit(0, true)).toBe(20);
  });
  it("fits compact and comfortable rows under the header", () => {
    expect(rowsThatFit(48 + 32 * 10, true)).toBe(10);
    expect(rowsThatFit(60 + 42 * 7, false)).toBe(7);
    expect(rowsThatFit(60 + 42 * 7 + 41, false)).toBe(7);
  });
  it("never shows fewer than 5 rows", () => {
    expect(rowsThatFit(50, true)).toBe(5);
  });
});

describe("repage", () => {
  it("keeps the first visible row on screen", () => {
    expect(repage(4, 10, 7)).toBe(5); // row 31 → page 5 of 7-row pages
    expect(repage(3, 7, 10)).toBe(2); // row 15 → page 2
    expect(repage(1, 10, 7)).toBe(1);
  });
});

describe("pageItems", () => {
  it("lists every page when there are seven or fewer", () => {
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps first, last and the current page's neighbours", () => {
    expect(pageItems(1, 14)).toEqual([1, 2, "gap", 14]);
    expect(pageItems(7, 14)).toEqual([1, "gap", 6, 7, 8, "gap", 14]);
    expect(pageItems(14, 14)).toEqual([1, "gap", 13, 14]);
    expect(pageItems(3, 14)).toEqual([1, 2, 3, 4, "gap", 14]);
  });
});

describe("rangeLabel", () => {
  it("names the rows on this page", () => {
    expect(rangeLabel(1, 10, 10, 45)).toBe("1–10 of 45");
    expect(rangeLabel(5, 10, 5, 45)).toBe("41–45 of 45");
    expect(rangeLabel(1, 10, 10, 1204)).toBe("1–10 of 1,204");
  });
  it("says so when nothing matches", () => {
    expect(rangeLabel(1, 10, 0, 0)).toBe("No pages");
  });
});
```

`ui/src/hooks/useElementHeight.test.tsx`:

```tsx
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementHeight } from "#/hooks/useElementHeight";

let fire: (() => void) | undefined;
let height = 300;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height }) as DOMRect,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ onHeight }: { onHeight: (h: number | null) => void }) {
  const [ref, h] = useElementHeight<HTMLDivElement>();
  onHeight(h);
  return <div ref={ref} />;
}

describe("useElementHeight", () => {
  it("measures on attach, then settles resizes after a debounce", () => {
    const seen: Array<number | null> = [];
    render(<Probe onHeight={(h) => seen.push(h)} />);
    expect(seen.at(-1)).toBe(300);

    height = 500;
    act(() => {
      fire?.();
      fire?.();
      vi.advanceTimersByTime(100);
    });
    expect(seen.at(-1)).toBe(300);
    act(() => vi.advanceTimersByTime(60));
    expect(seen.at(-1)).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && bun run test src/components/codex/gazetteer-paging.test.ts src/hooks/useElementHeight.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`ui/src/components/codex/gazetteer-paging.ts`:

```ts
// Pure paging arithmetic for the Gazetteer table. No React — testable.

export const FALLBACK_PAGE_SIZE = 20;
export const MIN_PAGE_SIZE = 5;

/** Row height and the space above the first row (header + top padding). */
const GEOMETRY = {
  compact: { row: 32, overhead: 48 },
  comfortable: { row: 42, overhead: 60 },
} as const;

/** Rows per page that fill a table area `height` px tall. */
export function rowsThatFit(height: number, compact: boolean): number {
  if (height <= 0) return FALLBACK_PAGE_SIZE;
  const g = compact ? GEOMETRY.compact : GEOMETRY.comfortable;
  return Math.max(MIN_PAGE_SIZE, Math.floor((height - g.overhead) / g.row));
}

/** The page, at `toSize` rows, holding the first row of `page` at `fromSize`. */
export function repage(page: number, fromSize: number, toSize: number): number {
  return Math.floor(((page - 1) * fromSize) / toSize) + 1;
}

/** Page links: all pages up to seven, else first, last and current ± 1. */
export function pageItems(current: number, count: number): Array<number | "gap"> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const keep = [...new Set([1, current - 1, current, current + 1, count])]
    .filter((p) => p >= 1 && p <= count)
    .sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  for (const p of keep) {
    const last = out.at(-1);
    if (typeof last === "number" && p - last > 1) out.push("gap");
    out.push(p);
  }
  return out;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** "1–20 of 312": the rows this page shows. */
export function rangeLabel(
  page: number,
  size: number,
  shown: number,
  total: number,
): string {
  if (total === 0 || shown === 0) return "No pages";
  const start = (page - 1) * size + 1;
  return `${fmt(start)}–${fmt(start + shown - 1)} of ${fmt(total)}`;
}
```

`ui/src/hooks/useElementHeight.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

/** An element's height: measured synchronously when it attaches, then
 *  re-measured `debounceMs` after resizing stops (a window drag fires the
 *  observer continuously; callers key queries on the result). */
export function useElementHeight<T extends HTMLElement>(
  debounceMs = 150,
): [(node: T | null) => void, number | null] {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  const ref = useCallback((node: T | null) => {
    setElement(node);
    if (node) setHeight(node.getBoundingClientRect().height);
  }, []);

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(
        () => setHeight(element.getBoundingClientRect().height),
        debounceMs,
      );
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [element, debounceMs]);

  return [ref, height];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && bun run test src/components/codex/gazetteer-paging.test.ts src/hooks/useElementHeight.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/gazetteer-paging.ts ui/src/components/codex/gazetteer-paging.test.ts ui/src/hooks/useElementHeight.ts ui/src/hooks/useElementHeight.test.tsx
git commit -m "feat(ui): table paging helpers and debounced element height"
```

---

### Task 4: Gazetteer header, filter row and selection actions

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx` (header, filter row, bulk bar, facet labels)
- Create: `ui/src/components/codex/Gazetteer.desktop.test.tsx`
- Modify: `ui/src/components/codex/Gazetteer.test.ts` (copy updates only; listed below)
- Modify: `ui/src/routes/-gazetteer.test.tsx` (copy updates only)
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (add Gazetteer as PENDING)

**Interfaces:**
- Consumes: `Switch` (Task 1), `useTableCompact("gazetteer", true)` (Task 1), `Tick` (`#/components/codex/Tick`), `RadioGroup`/`Radio` with `segmented` (`#/components/ui/radio-group`), `FOCUS_RING_NATIVE` (`#/lib/focusRing`).
- Produces: `GazetteerFilters.onPageChange: (page: number, replace?: boolean) => void` (widened here so Task 5 can pass `replace`).

- [ ] **Step 1: Guard entry, as pending**

In `primitivesGuard.test.ts` add `"../codex/Gazetteer.tsx"` to `SCREEN_FILES` and to `PENDING` (`new Set<string>(["../codex/Gazetteer.tsx"])`). Task 5 removes it from `PENDING`.

- [ ] **Step 2: Write the failing tests** — `ui/src/components/codex/Gazetteer.desktop.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gazetteer, type GazetteerFilters } from "./Gazetteer";

const { content, useContentIndexMock, heightState } = vi.hoisted(() => ({
  content: {
    data: { items: [] as Array<Record<string, unknown>>, total: 0 } as
      | { items: Array<Record<string, unknown>>; total: number }
      | undefined,
    error: null as Error | null,
    isSuccess: true,
  },
  useContentIndexMock: vi.fn(),
  heightState: { value: 0 as number | null },
}));

vi.mock("#/api/index", () => ({
  useContentIndex: (...args: unknown[]) => {
    useContentIndexMock(...args);
    return content;
  },
  useTags: () => ({
    data: [{ tag: "research", count: 1, computed_count: 0 }],
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignBulk: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => false }));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["atlas"],
  useProjectValues: () => ["atlas"],
}));
vi.mock("#/hooks/useElementHeight", () => ({
  useElementHeight: () => [() => {}, heightState.value],
}));

function entry(i: number) {
  return {
    path: `notes/page-${i + 1}.md`,
    title: `Page ${i + 1}`,
    description: null,
    tags: [],
    kind: "NOTE",
    updated_at: "2026-09-01T00:00:00Z",
    word_count: 1200,
  };
}

function makeFilters(over: Partial<GazetteerFilters> = {}): GazetteerFilters {
  return {
    filterState: { text: "", facets: {} },
    sort: "ts",
    page: 1,
    onFilterChange: vi.fn(),
    onSortChange: vi.fn(),
    onPageChange: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  heightState.value = 0;
  content.data = { items: Array.from({ length: 20 }, (_, i) => entry(i)), total: 45 };
  content.isSuccess = true;
  useContentIndexMock.mockClear();
});

describe("Gazetteer header (desktop)", () => {
  it("titles the screen in serif under an Index eyebrow, with the page count", () => {
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Gazetteer" })).toBeVisible();
    expect(screen.getByText("Index")).toBeVisible();
    expect(screen.getByText("45 pages")).toBeVisible();
  });

  it("starts compact and remembers the Compact switch", async () => {
    const user = userEvent.setup();
    const view = render(<Gazetteer filters={makeFilters()} />);
    const sw = screen.getByRole("switch", { name: "Compact" });
    expect(sw).toBeChecked();
    await user.click(sw);
    expect(sw).not.toBeChecked();
    view.unmount();
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("switch", { name: "Compact" })).not.toBeChecked();
  });

  it("starts comfortable under the spacious preset", () => {
    localStorage.setItem("clepsydra.density", "spacious");
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("switch", { name: "Compact" })).not.toBeChecked();
  });

  it("sorts through the segmented Sort control", async () => {
    const onSortChange = vi.fn();
    render(<Gazetteer filters={makeFilters({ onSortChange })} />);
    const sort = screen.getByRole("radiogroup", { name: "Sort" });
    expect(screen.getByRole("radio", { name: "Edited" })).toBeChecked();
    expect(sort).toBeVisible();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Title" }));
    expect(onSortChange).toHaveBeenCalledWith("title");
  });

  it("offers selection actions in the filter row", async () => {
    const user = userEvent.setup();
    render(<Gazetteer filters={makeFilters()} />);
    const box = screen.getByRole("checkbox", { name: "Select Page 1" });
    await user.click(box);
    expect(screen.getByText("1 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(box).not.toBeChecked();
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("carries no Vessel copy", () => {
    render(<Gazetteer filters={makeFilters()} />);
    const text = document.body.textContent ?? "";
    for (const gone of ["/ Index", "File-ID", "entries", "KIND", "PROJECT", "TAG"]) {
      expect(text).not.toContain(gone);
    }
    expect(screen.getByTestId("filter-bar-input")).toHaveAttribute(
      "placeholder",
      "Filter pages",
    );
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd ui && bun run test src/components/codex/Gazetteer.desktop.test.tsx`
Expected: FAIL — no level-1 heading named "Gazetteer" (it reads "Gazetteer / Index"), no switch, no radiogroup, "✕ 1 selected" copy.

- [ ] **Step 4: Implement**

In `Gazetteer.tsx`:

1. Imports: add `Tick`, `Switch`, `RadioGroup`/`Radio`, `useTableCompact`, `FOCUS_RING_NATIVE`.
2. Widen `GazetteerFilters.onPageChange` to `(page: number, replace?: boolean) => void`; type the local `setPage` as `(page: number, replace?: boolean) => void`. In `routes/gazetteer.tsx`: `onPageChange: (page, replace = false) => updateSearch({ page }, false, replace)`.
3. Sentence-case facet labels: `"Kind"`, `"Project"`, `"Tag"`.
4. Add near the top of the component: `const [compact, setCompact] = useTableCompact("gazetteer", true);`
5. Add module constants:

```tsx
const SORT_OPTIONS: Array<{ value: GazetteerSort; label: string }> = [
  { value: "ts", label: "Edited" },
  { value: "id", label: "Code" },
  { value: "title", label: "Title" },
  { value: "words", label: "Words" },
];

const fmt = (n: number) => n.toLocaleString("en-US");
```

6. Replace the desktop header `<div>` (the `Gazetteer / Index` block and the mono sort buttons) with:

```tsx
      <div
        className={cn(
          "flex flex-shrink-0 flex-wrap items-end gap-x-7 gap-y-4 px-10",
          compact ? "pt-7" : "pt-10",
        )}
      >
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">Index</span>
          </span>
          <h1
            className={cn(
              "font-serif leading-none tracking-[-0.015em] text-ink",
              compact ? "text-[44px]" : "text-[52px]",
            )}
          >
            Gazetteer
          </h1>
        </div>
        <span className="pb-1.5 text-[14px] text-mute">
          {filteredCount === totalCount
            ? `${fmt(totalCount)} ${totalCount === 1 ? "page" : "pages"}`
            : `${fmt(filteredCount)} of ${fmt(totalCount)} pages`}
          {tagSummary}
        </span>
        <div className="flex-1" />
        <Switch isSelected={compact} onChange={setCompact}>
          Compact
        </Switch>
        <RadioGroup
          segmented
          aria-label="Sort"
          orientation="horizontal"
          value={sort}
          onChange={(value) => setSort(value as GazetteerSort)}
        >
          {SORT_OPTIONS.map((option) => (
            <Radio key={option.value} value={option.value}>
              {option.label}
            </Radio>
          ))}
        </RadioGroup>
      </div>
```

7. Replace the FilterBar wrapper and the separate bulk action bar with one filter row:

```tsx
      <div
        className={cn(
          "flex flex-shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 px-10",
          compact ? "pt-[18px]" : "pt-6",
        )}
      >
        <FilterBar
          fields={filterFields}
          primaryFieldIds={["kind", "project", "tags"]}
          state={filterState}
          onChange={onFilterChange}
          textPlaceholder="Filter pages"
          textAriaLabel="Search pages"
          filteredCount={filteredCount}
          totalCount={totalCount}
          className="min-w-0 flex-1 flex-wrap"
        />
        {selected.length > 0 && (
          <div className="flex items-center gap-3.5 text-[13.5px]">
            <span className="font-medium text-accent">
              {selected.length} selected
            </span>
            <div className="w-[150px]">
              <KindSelect
                value={null}
                inferred={false}
                ariaLabel="Set kind for selection"
                placeholder="Set kind…"
                isDisabled={bulk.isPending}
                onAssign={applyKind}
              />
            </div>
            <div className="w-[180px]">
              <ProjectCombo
                value={null}
                options={projects}
                onAssign={applyProject}
                onClear={applyClearProject}
              />
            </div>
            <button
              type="button"
              aria-label="Clear selection"
              onClick={clearSelection}
              className={cn(
                "h-8 cursor-pointer rounded-full px-2 text-mute hover:text-ink",
                FOCUS_RING_NATIVE,
              )}
            >
              Clear
            </button>
          </div>
        )}
      </div>
```

8. Update copy in existing tests:
   - `Gazetteer.test.ts`: `"TAG: research"` → `"Tag: research"`; `"TAG: legacy-url-tag"` → `"Tag: legacy-url-tag"`; `"Clear TAG filter"` → `"Clear Tag filter"`; `getByRole("button", { name: "✕ 1 selected" })` → `getByText("1 selected")`; the `queryByRole(... "✕ 1 selected")` → `queryByText("1 selected")`.
   - `routes/-gazetteer.test.tsx`: `"KIND: WIDGET"` → `"Kind: WIDGET"`; `"PROJECT: clepsydra"` → `"Project: clepsydra"`; `"Clear PROJECT filter"` → `"Clear Project filter"`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd ui && bun run test src/components/codex/Gazetteer src/routes/-gazetteer.test.tsx src/__tests__/primitivesGuard.test.ts`
Expected: PASS. The guard's Gazetteer case is `it.fails` (the table body still carries `cl-mono`, `border-rule`, `ink-mute`), so it passes as an expected failure.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/Gazetteer.desktop.test.tsx ui/src/components/codex/Gazetteer.test.ts ui/src/routes/gazetteer.tsx ui/src/routes/-gazetteer.test.tsx ui/src/__tests__/primitivesGuard.test.ts
git commit -m "feat(ui): Gazetteer header, Compact switch, sort and filter row"
```

---

### Task 5: Gazetteer table, fitted pages and footer paging

**Files:**
- Modify: `ui/src/api/index.ts` (`useContentIndex` takes `{ enabled }`)
- Modify: `ui/src/components/codex/Gazetteer.tsx` (table, page size, repaging, footer paging; remove the bottom `<nav>`)
- Modify: `ui/src/components/codex/Gazetteer.desktop.test.tsx` (append)
- Modify: `ui/src/components/codex/Gazetteer.test.ts` (mock `useElementHeight`; argument updates listed below)
- Modify: `ui/src/__tests__/primitivesGuard.test.ts` (empty `PENDING`)

**Interfaces:**
- Consumes: `rowsThatFit`, `repage`, `pageItems`, `rangeLabel`, `FALLBACK_PAGE_SIZE` (Task 3); `useElementHeight` (Task 3); `FooterControls` (Task 2); `compact` (Task 4).
- Produces: `useContentIndex(options?: ContentIndexOptions, query?: { enabled?: boolean })`.

- [ ] **Step 1: Write the failing tests** — append to `Gazetteer.desktop.test.tsx` (add imports `within` and `FooterControlsHost` from `#/components/codex/FooterControls`):

```tsx
const COMPACT_10 = 48 + 32 * 10; // 368px: ten compact rows, seven comfortable

describe("Gazetteer table (desktop)", () => {
  it("marks the table's density and switches it", async () => {
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
    await userEvent.setup().click(screen.getByRole("switch", { name: "Compact" }));
    expect(screen.getByRole("table")).toHaveAttribute("data-density", "comfortable");
  });

  it("fits the page size to the table's height", () => {
    heightState.value = COMPACT_10;
    render(<Gazetteer filters={makeFilters({ page: 3 })} />);
    expect(useContentIndexMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
      { enabled: true },
    );
  });

  it("waits for the first measurement before fetching, and keeps a deep-linked page", () => {
    heightState.value = null;
    const onPageChange = vi.fn();
    const filters = makeFilters({ page: 4, onPageChange });
    const view = render(<Gazetteer filters={filters} />);
    expect(useContentIndexMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { enabled: false },
    );
    heightState.value = COMPACT_10;
    view.rerender(<Gazetteer filters={filters} />);
    expect(useContentIndexMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 10, offset: 30 }),
      { enabled: true },
    );
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("keeps the first visible row when the page size changes, replacing history", async () => {
    heightState.value = COMPACT_10;
    const onPageChange = vi.fn();
    render(<Gazetteer filters={makeFilters({ page: 4, onPageChange })} />);
    await userEvent.setup().click(screen.getByRole("switch", { name: "Compact" }));
    expect(onPageChange).toHaveBeenCalledWith(5, true);
  });

  it("numbers rows from the page's first row", () => {
    heightState.value = COMPACT_10;
    content.data = { items: Array.from({ length: 10 }, (_, i) => entry(i)), total: 45 };
    render(<Gazetteer filters={makeFilters({ page: 2 })} />);
    const first = screen.getAllByRole("row")[1];
    expect(within(first).getByText("011")).toBeVisible();
  });

  it("marks the sorted column", () => {
    render(<Gazetteer filters={makeFilters({ sort: "title" })} />);
    expect(screen.getByRole("columnheader", { name: "Title" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: "Edited" })).not.toHaveAttribute(
      "aria-sort",
    );
  });

  it("puts the row range and page links in the shell footer", async () => {
    heightState.value = COMPACT_10;
    content.data = { items: Array.from({ length: 10 }, (_, i) => entry(i)), total: 45 };
    const onPageChange = vi.fn();
    render(
      <>
        <Gazetteer filters={makeFilters({ onPageChange })} />
        <FooterControlsHost />
      </>,
    );
    expect(screen.getByText("1–10 of 45")).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "Gazetteer pagination" });
    expect(within(nav).getByRole("button", { name: "Page 1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "Page 5" })).toBeVisible();
    expect(within(nav).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await userEvent.setup().click(within(nav).getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("keeps no pager in the page body", () => {
    render(<Gazetteer filters={makeFilters()} />);
    expect(
      screen.queryByRole("navigation", { name: "Gazetteer pagination" }),
    ).toBeNull();
  });

  it("says plainly when nothing matches", () => {
    content.data = { items: [], total: 0 };
    render(<Gazetteer filters={makeFilters()} />);
    expect(screen.getByText("No pages match.")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && bun run test src/components/codex/Gazetteer.desktop.test.tsx`
Expected: FAIL — no `data-density`, `limit: 20` without `{ enabled }`, pager still in the body, "∅ no folios" copy.

- [ ] **Step 3: Implement**

`api/index.ts` — `useContentIndex`:

```ts
export function useContentIndex(
  { q, tags, kind, project, limit, offset }: ContentIndexOptions = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  const query = { /* unchanged */ };
  return $api.useQuery(
    "get",
    "/api/vault/index/content-index",
    { params: { query } },
    { enabled },
  );
}
```

`Gazetteer.tsx`:

1. Move `const isMobile = useMobileLayout();` above the content query. Add:

```tsx
  const [tableRef, tableHeight] = useElementHeight<HTMLDivElement>();
  const pageSize = isMobile
    ? MOBILE_GAZETTEER_PAGE_SIZE
    : rowsThatFit(tableHeight ?? 0, compact);
  // Desktop waits one layout pass for the table's height so the first fetch
  // already has the right page size.
  const measured = isMobile || tableHeight !== null;
```

2. Pass `limit: pageSize, offset: (requestedPage - 1) * pageSize` in the `filters` branch and `{ enabled: measured }` as the second argument. Replace every other `MOBILE_GAZETTEER_PAGE_SIZE` in the page math (`pageCount`, the client `slice`, row numbering) with `pageSize`.
3. Make the clamp effect replace history: `setPage(currentPage, true)`.
4. Re-page on size changes after the first measurement:

```tsx
  const lastSize = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (isMobile || !measured) return;
    const before = lastSize.current;
    lastSize.current = pageSize;
    if (before === null || before === pageSize) return;
    const next = repage(requestedPage, before, pageSize);
    if (next !== requestedPage) setPage(next, true);
  }, [isMobile, measured, pageSize, requestedPage, setPage]);
```

5. Add module constants:

```tsx
const SORT_DIRECTION: Record<GazetteerSort, "ascending" | "descending"> = {
  ts: "descending",
  words: "descending",
  title: "ascending",
  id: "ascending",
};
```

6. Replace the table container through the end of the old bottom `<nav>` with:

```tsx
      <div
        ref={tableRef}
        className={cn(
          "cl-noscroll min-h-0 flex-1 overflow-auto px-7",
          compact ? "pt-3.5" : "pt-5",
        )}
      >
        <table
          data-density={compact ? "compact" : "comfortable"}
          className="w-full table-fixed border-collapse text-left"
        >
          <thead className="sticky top-0 z-10 bg-ground">
            <tr className={cn("text-[12.5px] text-mute", compact ? "h-[34px]" : "h-10")}>
              <th className="w-[44px] px-3 font-normal">
                <input
                  type="checkbox"
                  aria-label="Select all visible rows"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  disabled={rows.length === 0}
                  className="cursor-pointer accent-accent"
                />
              </th>
              <Th w="52px">No.</Th>
              <Th w="250px" sorted={sort === "id" ? SORT_DIRECTION.id : undefined}>Code</Th>
              <Th sorted={sort === "title" ? SORT_DIRECTION.title : undefined}>Title</Th>
              <Th w="210px">Tags</Th>
              <Th w="76px" right sorted={sort === "words" ? SORT_DIRECTION.words : undefined}>
                Words
              </Th>
              <Th w="110px" right sorted={sort === "ts" ? SORT_DIRECTION.ts : undefined}>
                Edited
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n, i) => {
              const kind = resolveKind({ path: n.path, kind: n.kind });
              const isSelected = selectedPaths.has(n.path);
              const meta = compact ? "text-[12.5px]" : "text-[13px]";
              return (
                <tr
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className={cn(
                    "cursor-pointer",
                    compact ? "h-8" : "h-[42px]",
                    isSelected ? "[&>td]:bg-accent-tint" : "hover:[&>td]:bg-sink",
                  )}
                >
                  <td
                    className="rounded-l-[10px] px-3"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${n.title || n.path}`}
                      checked={isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRow(n.path)}
                      className="cursor-pointer accent-accent"
                    />
                  </td>
                  <td className={cn("px-3 tabular-nums text-faint", meta)}>
                    {String((currentPage - 1) * pageSize + i + 1).padStart(3, "0")}
                  </td>
                  <td className={cn("truncate px-3 text-mute", meta)}>
                    <span className="inline-flex items-center gap-2 align-middle">
                      <KindIcon
                        kind={kind}
                        size={14}
                        className="flex-shrink-0"
                        title={kindLabel(kind)}
                      />
                      {shortFolio(n.path)}
                    </span>
                  </td>
                  <td className="truncate px-3">
                    <span className={cn("text-ink", compact ? "text-[13.5px]" : "text-[14.5px]")}>
                      {n.title || n.path}
                    </span>
                    {n.description && (
                      <span className={cn("ml-2.5 text-mute", meta)}>
                        {n.description}
                      </span>
                    )}
                  </td>
                  <td className={cn("truncate px-3", meta)}>
                    {(n.tags ?? []).length > 0 ? (
                      <span className="flex gap-1.5 overflow-hidden whitespace-nowrap">
                        {(n.tags ?? []).map((tag) => {
                          const tagSelected = selectedTags.includes(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              aria-label={`Filter by tag ${tag}`}
                              aria-pressed={tagSelected}
                              onClick={(event) => {
                                event.stopPropagation();
                                applyResultTag(tag);
                              }}
                              className={cn(
                                "shrink-0 rounded-sm",
                                FOCUS_RING_NATIVE,
                                tagSelected
                                  ? "cursor-default text-mute"
                                  : "cursor-pointer text-accent hover:text-hot",
                              )}
                            >
                              #{tag}
                            </button>
                          );
                        })}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className={cn("px-3 text-right tabular-nums text-mute", meta)}>
                    {n.word_count != null ? fmt(n.word_count) : "—"}
                  </td>
                  <td className={cn("rounded-r-[10px] px-3 text-right text-mute", meta)}>
                    {formatRelativeTime(n.updated_at)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[13.5px] text-mute">
                  {selectedTags.length === 0 && !query
                    ? "No pages match."
                    : `No pages${
                        selectedTags.length > 0
                          ? ` under ${selectedTags.map((t) => `#${t}`).join(" ")}`
                          : ""
                      }${query ? ` match “${query}”` : ""}.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <FooterControls>
        <span>{rangeLabel(currentPage, pageSize, rows.length, filteredCount)}</span>
        <nav aria-label="Gazetteer pagination" className="flex items-center gap-3 text-ink">
          <button
            type="button"
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
            className={cn("cursor-pointer rounded-sm disabled:cursor-default disabled:text-faint", FOCUS_RING_NATIVE)}
          >
            ‹
          </button>
          {pageItems(currentPage, pageCount).map((item, index) =>
            item === "gap" ? (
              <span key={`gap-${index}`} aria-hidden>
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                aria-label={`Page ${item}`}
                aria-current={item === currentPage ? "page" : undefined}
                onClick={() => setPage(item)}
                className={cn(
                  "cursor-pointer rounded-sm tabular-nums",
                  FOCUS_RING_NATIVE,
                  item === currentPage ? "font-medium text-accent" : "hover:text-accent",
                )}
              >
                {item}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label="Next page"
            disabled={currentPage >= pageCount}
            onClick={() => setPage(currentPage + 1)}
            className={cn("cursor-pointer rounded-sm disabled:cursor-default disabled:text-faint", FOCUS_RING_NATIVE)}
          >
            ›
          </button>
        </nav>
      </FooterControls>
```

7. Replace `Th` with:

```tsx
function Th({
  children,
  w,
  right,
  sorted,
}: {
  children: React.ReactNode;
  w?: string;
  right?: boolean;
  sorted?: "ascending" | "descending";
}) {
  return (
    <th
      aria-sort={sorted}
      className={cn(
        "px-3 font-normal",
        right ? "text-right" : "text-left",
        sorted && "text-ink",
      )}
      style={w ? { width: w } : undefined}
    >
      {children}
      {sorted && <span aria-hidden>{sorted === "descending" ? " ↓" : " ↑"}</span>}
    </th>
  );
}
```

8. Imports: `useRef`, `useElementHeight`, `FooterControls`, `pageItems`, `rangeLabel`, `repage`, `rowsThatFit` from `./gazetteer-paging`.
9. Guard: empty `PENDING` again (`new Set<string>([])`).
10. `Gazetteer.test.ts`: add `vi.mock("#/hooks/useElementHeight", () => ({ useElementHeight: () => [() => {}, 0] }));`; change `expect(useContentIndexMock).toHaveBeenLastCalledWith({ ...limit: 20, offset: 20 })` to take a second argument `{ enabled: true }`; change `expect(onPageChange).toHaveBeenCalledWith(1)` to `(1, true)`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && bun run test src/components/codex/Gazetteer src/routes/-gazetteer.test.tsx src/__tests__/primitivesGuard.test.ts src/api`
Expected: PASS, and the guard's Gazetteer case now runs as a normal `it` and passes.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/index.ts ui/src/components/codex/Gazetteer.tsx ui/src/components/codex/Gazetteer.desktop.test.tsx ui/src/components/codex/Gazetteer.test.ts ui/src/__tests__/primitivesGuard.test.ts
git commit -m "feat(ui): Gazetteer dense table, fitted pages, footer paging"
```

---

### Task 6: Docs and full gates

**Files:**
- Modify: `ui/src/docs/content/getting-started.mdx` (Gazetteer section)

- [ ] **Step 1: Docs** — in "## Gazetteer: find and organize the corpus", after the sort sentence, add:

```mdx
The **Compact** switch in the header toggles between 32px and 42px rows; the
Gazetteer starts compact, and the choice is remembered per screen. A page holds
as many rows as fit the window. The footer shows the row range and the page
links; resizing the window keeps the first visible row in view.
```

Also change "the sort controls order by update time, path ID, title, or word count" to "the Sort control orders by Edited (update time), Code (path), Title, or Words".

- [ ] **Step 2: Full gates**

Run: `cd ui && bun run typecheck && bun run lint && bun run test > ../.superpowers/gates.log 2>&1; tail -5 ../.superpowers/gates.log`
Expected: typecheck 0 errors; lint clean; full suite green (baseline 5306 + new tests).

- [ ] **Step 3: Browser smoke** (scratch vault only; see memory `reference_dev_server_and_browser_smoke.md`)

With `CLEPSYDRA__VAULT__ROOT=<scratch vault> clep serve` on :3917 and Vite on :5917, open `/gazetteer`: compact and comfortable screenshots in both themes; resize the window and confirm one refetch after the drag, the first row stays in view, and footer paging works; navigate to Folio and confirm the page links leave the footer.

- [ ] **Step 4: Commit**

```bash
git add ui/src/docs/content/getting-started.mdx
git commit -m "docs(ui): Gazetteer Compact switch and footer paging"
```
