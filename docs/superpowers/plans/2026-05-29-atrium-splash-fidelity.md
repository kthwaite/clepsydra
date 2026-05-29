# ATRIUM → SPLASH Fidelity Implementation Plan (WU-1 + WU-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the ATRIUM home view to SPLASH-prototype richness — rich hero + primary CTA, real-data inventory grid, graphical moon/day-arc sky, heatmap chrome, classified-figure cards, and a tabbed recents card — within the authoritative plan's constraints (real data only, no fabricated telemetry).

**Architecture:** Extract all pure derivations into testable helper modules (`atrium-data.ts`, `sky.ts`) and a `useClock` hook; introduce a reusable `Card` primitive and `MoonDisc`/`DayArc` presentational components; add a persisted open-history ring buffer to the workspace store for the "OPENED" recents tab; then reassemble `Atrium.tsx` as a full-width 12-column tiled dashboard consuming those pieces.

**Tech Stack:** React 19, TanStack Router/Query, Zustand (+persist), Tailwind v4 (`@theme` tokens in `main.css`), `suncalc`, Vitest + Testing Library, Biome.

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` (WU-1, WU-2).
**Prototype reference:** `docs/pkm-redesign/project/SPLASH.html`.

**Conventions already in the codebase (reuse, do not reinvent):**
- API hooks: `useStats()` → `VaultStats { pages, links_total, links_unresolved, links_resolved, tags, attachments, last_indexed_at }`; `useTags()` → `TagCount[] { tag, count }`; `useContentIndex(limit)` → `{ items: ContentEntry[] }` where `ContentEntry { path, title?, description, tags[], links[], created_at?, updated_at?, word_count? }`. All in `#/api/index`.
- `useJournalToday()` → `JournalDetail { path, meta: { id, ... } }` in `#/api/journal`.
- `useLocation()` → `{ latitude, longitude, label }` in `#/api/location`.
- Kind helpers in `#/lib/kind`: `resolveKindFromPath(path) → Kind`, `kindColorVar(kind) → string`.
- Time helpers in `#/components/codex/codex-time`: `formatRelativeTime(iso)`.
- `useOpenTab()` from `#/hooks/useOpenTab` → `(type, path?, label?) => void`.
- Tailwind token classes already in use: `text-ink`, `text-ink-2`, `text-ink-mute`, `bg-paper`, `bg-paper-2`, `bg-rule`, `bg-rule-soft`, `border-rule`, `text-accent`, `text-warn`, `font-sans`. Utility classes: `cl-frame`, `cl-btn`, `cl-btn-hot`, `cl-mono`, `cl-marg`.
- Tests are colocated `*.test.ts(x)`, run with `cd ui && bun run test`. Fake-timer pattern: `vi.useFakeTimers(); vi.setSystemTime(new Date("..."))`.
- **Determinism rule for dates:** all day-bucketing uses **UTC day keys** (`iso.slice(0, 10)` for entries; `date.toISOString().slice(0, 10)` for "today"), so tests are timezone-independent.

**Working directory for all `bun`/`git` commands:** `ui/` unless a path says otherwise. Repo root is `/Users/kit/Source/_p.pkm/clepsydra`.

---

## File structure

**Create:**
- `ui/src/hooks/useClock.ts` — 1-second ticking `Date` hook (hero clock).
- `ui/src/components/codex/atrium-data.ts` — pure derivations: `dayOfYear`, `julianDay`, `buildHeatmap`, `deriveInventory`, `sortRecents`, shared date helpers + types.
- `ui/src/components/codex/atrium-data.test.ts` — unit tests for the above.
- `ui/src/components/codex/sky.ts` — pure astro math: `describeMoon`, `moonPhase`, `bezierPoint`, `sunArcPosition`.
- `ui/src/components/codex/sky.test.ts` — unit tests for the above.
- `ui/src/components/codex/Card.tsx` — classified-figure card primitive.
- `ui/src/components/codex/Card.test.tsx` — render tests for Card.
- `ui/src/components/codex/MoonDisc.tsx` — CSS moon-phase disc.
- `ui/src/components/codex/DayArc.tsx` — SVG day arc with NOW sun marker.

**Modify:**
- `ui/src/store/workspace.ts` — add `openHistory` + `recordOpen`, persist v2 migration.
- `ui/src/store/workspace.test.ts` — **create** if absent; tests for the open-history reducer.
- `ui/src/components/codex/Atrium.tsx` — full rework consuming the new pieces.
- `ui/src/main.css` — add `.cl-grid-texture` hero utility.

---

## Task 1: Workspace open-history ring buffer

Adds a persisted, de-duplicated, capped list of recently opened page paths to drive ATRIUM's "OPENED" recents tab. The reducer is pure and tested; the store calls it.

**Files:**
- Modify: `ui/src/store/workspace.ts`
- Test: `ui/src/store/workspace.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `ui/src/store/workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type OpenHistoryEntry, pushOpenHistory } from "./workspace";

describe("pushOpenHistory", () => {
  it("prepends the newest path", () => {
    const out = pushOpenHistory([], "a.md", 1000);
    expect(out).toEqual([{ path: "a.md", openedAt: 1000 }]);
  });

  it("de-duplicates by path, moving the existing entry to front with new time", () => {
    const start: OpenHistoryEntry[] = [
      { path: "a.md", openedAt: 1 },
      { path: "b.md", openedAt: 2 },
    ];
    const out = pushOpenHistory(start, "a.md", 3000);
    expect(out).toEqual([
      { path: "a.md", openedAt: 3000 },
      { path: "b.md", openedAt: 2 },
    ]);
  });

  it("caps the buffer at 32 entries, dropping the oldest", () => {
    let hist: OpenHistoryEntry[] = [];
    for (let i = 0; i < 40; i++) hist = pushOpenHistory(hist, `p${i}.md`, i);
    expect(hist).toHaveLength(32);
    expect(hist[0]).toEqual({ path: "p39.md", openedAt: 39 });
    expect(hist.at(-1)).toEqual({ path: "p8.md", openedAt: 8 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/store/workspace.test.ts`
Expected: FAIL — `pushOpenHistory`/`OpenHistoryEntry` not exported.

- [ ] **Step 3: Implement the reducer + wire it into the store**

In `ui/src/store/workspace.ts`, add the exported type and pure reducer near the top (after the existing `TabType` export):

```ts
export interface OpenHistoryEntry {
  path: string;
  openedAt: number;
}

const OPEN_HISTORY_CAP = 32;

/** Prepend `path`, de-duplicate by path (newest wins), cap to 32 entries. */
export function pushOpenHistory(
  history: OpenHistoryEntry[],
  path: string,
  now: number,
): OpenHistoryEntry[] {
  const without = history.filter((e) => e.path !== path);
  return [{ path, openedAt: now }, ...without].slice(0, OPEN_HISTORY_CAP);
}
```

Add `openHistory` to `WorkspaceState`:

```ts
interface WorkspaceState {
  tabs: TabDescriptor[];
  activeTabId: string | null;
  navigationMode: NavigationMode;
  openHistory: OpenHistoryEntry[];
}
```

Initialise it in the store body (alongside `tabs: []`):

```ts
      tabs: [],
      activeTabId: null,
      navigationMode: "smart",
      openHistory: [],
```

Record opens. In `openTab`, when a page is opened or re-focused, update history. In the **existing-tab** branch (inside `if (existing) { ... }`) change the `set(...)` to also push history:

```ts
        if (existing) {
          set({
            activeTabId: existing.id,
            tabs: state.tabs.map((t) =>
              t.id === existing.id ? { ...t, lastActiveAt: Date.now() } : t,
            ),
            openHistory:
              existing.type === "page" && existing.path
                ? pushOpenHistory(state.openHistory, existing.path, Date.now())
                : state.openHistory,
          });
          return;
        }
```

In the **new-tab** branch, after computing `newTab`, fold history into both `set` calls. Replace the `"new"/"smart"` branch `set({...})` with:

```ts
          set({
            tabs: [...state.tabs, newTab],
            activeTabId: newTab.id,
            openHistory:
              type === "page" && path
                ? pushOpenHistory(state.openHistory, path, Date.now())
                : state.openHistory,
          });
```

(The `"replace"` branch keeps recording too — add the same `openHistory:` line to its `set({...})`.)

Bump the persist config to version 2 with a migration so older persisted state gains the field:

```ts
    {
      name: "clepsydra.workspace",
      version: 2,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<WorkspaceState>;
        if (version < 2 || !Array.isArray(s.openHistory)) {
          return { ...s, openHistory: [] } as WorkspaceState & WorkspaceActions;
        }
        return s as WorkspaceState & WorkspaceActions;
      },
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/store/workspace.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/store/workspace.ts ui/src/store/workspace.test.ts
git commit -m "feat(workspace): persisted open-history ring buffer for ATRIUM recents"
```

---

## Task 2: `useClock` hook

A self-contained 1-second clock so the hero greeting line can show a live local time without re-rendering the whole ATRIUM tree.

**Files:**
- Create: `ui/src/hooks/useClock.ts`
- Test: `ui/src/hooks/useClock.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `ui/src/hooks/useClock.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClock } from "./useClock";

describe("useClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T18:17:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns the current date and advances each second", () => {
    const { result } = renderHook(() => useClock());
    const first = result.current.getTime();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getTime()).toBe(first + 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/hooks/useClock.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `ui/src/hooks/useClock.ts`:

```ts
import { useEffect, useState } from "react";

/** Ticks once per second; returns a fresh `Date`. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/hooks/useClock.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useClock.ts ui/src/hooks/useClock.test.tsx
git commit -m "feat(hooks): useClock 1s ticking clock"
```

---

## Task 3: ATRIUM data derivations (`atrium-data.ts`)

All pure logic ATRIUM needs: day-of-year/Julian, the enriched heatmap (6 levels + month labels + streaks), the real-data inventory, and recent sorting.

**Files:**
- Create: `ui/src/components/codex/atrium-data.ts`
- Test: `ui/src/components/codex/atrium-data.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/codex/atrium-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildHeatmap,
  deriveInventory,
  dayOfYear,
  julianDay,
  sortRecents,
  type RecentItem,
} from "./atrium-data";

describe("dayOfYear / julianDay", () => {
  it("computes day-of-year (1-based)", () => {
    expect(dayOfYear(new Date(Date.UTC(2026, 0, 1)))).toBe(1);
    expect(dayOfYear(new Date(Date.UTC(2026, 4, 2)))).toBe(122);
  });
  it("computes the Julian Day Number", () => {
    expect(julianDay(new Date(Date.UTC(2026, 4, 2)))).toBe(2461163);
  });
});

describe("buildHeatmap", () => {
  const now = new Date("2026-05-02T12:00:00Z");

  it("returns 26 week-columns of 7 days each", () => {
    const h = buildHeatmap([], now);
    expect(h.weeks).toHaveLength(27); // 26 full weeks + the partial current week
    for (const w of h.weeks) expect(w).toHaveLength(7);
    expect(h.total).toBe(0);
    expect(h.currentStreak).toBe(0);
    expect(h.longestStreak).toBe(0);
  });

  it("counts entries by UTC day and totals them", () => {
    const items = [
      { updated_at: "2026-05-02T01:00:00Z" },
      { updated_at: "2026-05-02T09:00:00Z" },
      { updated_at: "2026-05-01T09:00:00Z" },
      { created_at: "2026-04-30T09:00:00Z", updated_at: null },
    ];
    const h = buildHeatmap(items, now);
    expect(h.total).toBe(4);
    // 3 consecutive days ending today => current streak 3
    expect(h.currentStreak).toBe(3);
    expect(h.longestStreak).toBeGreaterThanOrEqual(3);
  });

  it("maps counts to six levels (0..5)", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, () => ({ updated_at: "2026-05-02T01:00:00Z" }));
    expect(buildHeatmap(mk(0), now).maxLevelToday).toBe(0);
    expect(buildHeatmap(mk(1), now).maxLevelToday).toBe(1);
    expect(buildHeatmap(mk(3), now).maxLevelToday).toBe(2);
    expect(buildHeatmap(mk(6), now).maxLevelToday).toBe(3);
    expect(buildHeatmap(mk(10), now).maxLevelToday).toBe(4);
    expect(buildHeatmap(mk(20), now).maxLevelToday).toBe(5);
  });
});

describe("deriveInventory", () => {
  const now = new Date("2026-05-02T12:00:00Z");
  const stats = {
    pages: 100,
    links_total: 343,
    links_unresolved: 12,
    links_resolved: 331,
    tags: 20,
    attachments: 5,
    last_indexed_at: null,
  };
  const tags = [
    { tag: "epistemics", count: 5 },
    { tag: "hapax-one", count: 1 },
    { tag: "hapax-two", count: 1 },
  ];
  const items = [
    { created_at: "2026-05-02T01:00:00Z", updated_at: "2026-05-02T02:00:00Z", tags: ["x"] },
    { created_at: "2026-04-29T01:00:00Z", updated_at: "2026-05-02T05:00:00Z", tags: [] },
    { created_at: "2026-03-01T01:00:00Z", updated_at: "2026-03-01T01:00:00Z", tags: ["y"] },
  ];

  it("derives corpus cells with real subs", () => {
    const cells = deriveInventory(stats, tags, items, now);
    const byLabel = Object.fromEntries(cells.map((c) => [c.label, c]));
    expect(byLabel.Notes.value).toBe("100");
    expect(byLabel.Links.value).toBe("343");
    expect(byLabel.Links.sub).toBe("density 3.43");
    expect(byLabel.Tags.sub).toBe("hapax 2");
    expect(byLabel.Unresolved.value).toBe("12");
    expect(byLabel.Unresolved.tone).toBe("warn");
  });

  it("derives today/7d cells from item timestamps", () => {
    const cells = deriveInventory(stats, tags, items, now);
    const byLabel = Object.fromEntries(cells.map((c) => [c.label, c]));
    expect(byLabel["Captures · today"].value).toBe("1"); // created 05-02
    expect(byLabel["Edited · today"].value).toBe("2"); // updated 05-02 x2
    expect(byLabel["New · 7d"].value).toBe("2"); // created 05-02 and 04-29
    expect(byLabel.Unfiled.value).toBe("1"); // one item with no tags
  });

  it("omits corpus cells when stats are unavailable", () => {
    const cells = deriveInventory(undefined, undefined, items, now);
    const labels = cells.map((c) => c.label);
    expect(labels).not.toContain("Notes");
    expect(labels).toContain("Captures · today");
  });
});

describe("sortRecents", () => {
  const items: RecentItem[] = [
    { path: "a.md", title: "A", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-03T00:00:00Z", tags: [] },
    { path: "b.md", title: "B", created_at: "2026-05-02T00:00:00Z", updated_at: "2026-05-01T00:00:00Z", tags: [] },
  ];
  it("sorts by updated_at desc for 'edited'", () => {
    expect(sortRecents(items, "edited").map((i) => i.path)).toEqual(["a.md", "b.md"]);
  });
  it("sorts by created_at desc for 'created'", () => {
    expect(sortRecents(items, "created").map((i) => i.path)).toEqual(["b.md", "a.md"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/components/codex/atrium-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `atrium-data.ts`**

Create `ui/src/components/codex/atrium-data.ts`:

```ts
// Pure derivations for the ATRIUM dashboard. No React, no I/O — fully testable.

export interface HeatItem {
  updated_at?: string | null;
  created_at?: string | null;
}

export interface Heatmap {
  /** Week columns, each 7 entries Mon..Sun, values are levels 0..5. */
  weeks: number[][];
  /** Month label per week column ("" when same month as the column before). */
  monthLabels: string[];
  total: number;
  longestStreak: number;
  currentStreak: number;
  /** Level (0..5) of today's cell — exposed for tests/legends. */
  maxLevelToday: number;
}

export interface InventoryCell {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}

export interface RecentItem {
  path: string;
  title?: string | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface StatsLike {
  pages: number;
  links_total: number;
  links_unresolved: number;
  tags: number;
}

interface TagLike {
  tag: string;
  count: number;
}

const MS_PER_DAY = 86_400_000;
const HEATMAP_DAYS = 26 * 7;
const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/** UTC day key (YYYY-MM-DD) for an ISO string. */
function dayKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

/** UTC day key for a Date. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / MS_PER_DAY);
}

export function julianDay(d: Date): number {
  const a = Math.floor((14 - (d.getUTCMonth() + 1)) / 12);
  const y = d.getUTCFullYear() + 4800 - a;
  const m = d.getUTCMonth() + 1 + 12 * a - 3;
  return (
    d.getUTCDate() +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

function level(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  if (n <= 10) return 4;
  return 5;
}

export function buildHeatmap(items: HeatItem[], now: Date = new Date()): Heatmap {
  const counts = new Map<string, number>();
  let total = 0;
  for (const it of items) {
    const ts = it.updated_at ?? it.created_at;
    if (!ts) continue;
    const key = dayKeyOf(ts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }

  // Today at UTC midnight; walk back to the Monday on/before (today - 181d).
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (HEATMAP_DAYS - 1));
  // Monday-first columns: 0=Sun..6=Sat → days back to Monday = (dow + 6) % 7.
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));

  const weeks: number[][] = [];
  const monthLabels: string[] = [];
  let prevMonth = -1;
  const cursor = new Date(start);

  while (cursor <= today) {
    const week: number[] = [];
    const colMonth = cursor.getUTCMonth();
    for (let d = 0; d < 7; d++) {
      const key = dayKey(cursor);
      week.push(cursor <= today ? level(counts.get(key) ?? 0) : 0);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
    monthLabels.push(colMonth !== prevMonth ? MONTHS[colMonth] : "");
    prevMonth = colMonth;
  }

  // Streaks over the contiguous day range ending today.
  let currentStreak = 0;
  let longestStreak = 0;
  let run = 0;
  const walk = new Date(start);
  while (walk <= today) {
    const c = counts.get(dayKey(walk)) ?? 0;
    if (c > 0) {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else {
      run = 0;
    }
    walk.setUTCDate(walk.getUTCDate() + 1);
  }
  // current streak = trailing run of nonzero days ending today
  const back = new Date(today);
  while ((counts.get(dayKey(back)) ?? 0) > 0) {
    currentStreak += 1;
    back.setUTCDate(back.getUTCDate() - 1);
  }

  return {
    weeks,
    monthLabels,
    total,
    longestStreak,
    currentStreak,
    maxLevelToday: level(counts.get(dayKey(today)) ?? 0),
  };
}

export function deriveInventory(
  stats: StatsLike | undefined,
  tags: TagLike[] | undefined,
  items: RecentItem[],
  now: Date = new Date(),
): InventoryCell[] {
  const cells: InventoryCell[] = [];
  const n = (v: number) => v.toLocaleString("en-US");

  if (stats) {
    cells.push({ label: "Notes", value: n(stats.pages) });
    cells.push({
      label: "Links",
      value: n(stats.links_total),
      sub: `density ${(stats.links_total / Math.max(stats.pages, 1)).toFixed(2)}`,
    });
    const hapax = (tags ?? []).filter((t) => t.count === 1).length;
    cells.push({
      label: "Tags",
      value: n(stats.tags),
      sub: tags ? `hapax ${hapax}` : undefined,
    });
    const pct =
      stats.links_total > 0
        ? ((stats.links_unresolved / stats.links_total) * 100).toFixed(1)
        : "0.0";
    cells.push({
      label: "Unresolved",
      value: n(stats.links_unresolved),
      sub: `${pct}% of links`,
      tone: stats.links_unresolved > 0 ? "warn" : undefined,
    });
  }

  const todayKey = dayKey(now);
  const sevenAgo = now.getTime() - 7 * MS_PER_DAY;
  let capturesToday = 0;
  let editedToday = 0;
  let new7d = 0;
  let unfiled = 0;
  for (const it of items) {
    if (it.created_at && dayKeyOf(it.created_at) === todayKey) capturesToday += 1;
    if (it.updated_at && dayKeyOf(it.updated_at) === todayKey) editedToday += 1;
    if (it.created_at && Date.parse(it.created_at) >= sevenAgo) new7d += 1;
    if (!it.tags || it.tags.length === 0) unfiled += 1;
  }

  cells.push({ label: "Captures · today", value: n(capturesToday) });
  cells.push({ label: "Edited · today", value: n(editedToday) });
  cells.push({ label: "New · 7d", value: n(new7d), sub: `+${new7d} / 7d` });
  cells.push({
    label: "Unfiled",
    value: n(unfiled),
    tone: unfiled > 0 ? "warn" : undefined,
  });

  return cells;
}

export function sortRecents(
  items: RecentItem[],
  mode: "edited" | "created",
  limit = 8,
): RecentItem[] {
  const key = mode === "edited" ? "updated_at" : "created_at";
  return [...items]
    .sort((a, b) => {
      const av = a[key] ? Date.parse(a[key] as string) : 0;
      const bv = b[key] ? Date.parse(b[key] as string) : 0;
      return bv - av;
    })
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/components/codex/atrium-data.test.ts`
Expected: PASS (all describe blocks).

> Note: `buildHeatmap([], now).weeks` length is 27 because the Monday-aligned start plus the partial current week yields 27 columns for a 26×7 window ending mid-week. The test asserts 27 deliberately.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/atrium-data.ts ui/src/components/codex/atrium-data.test.ts
git commit -m "feat(atrium): pure data derivations (heatmap streaks, inventory, recents)"
```

---

## Task 4: Sky math (`sky.ts`)

Pure astro math for the moon disc and day arc, split from `suncalc` so it is testable. `describeMoon` takes raw illumination; `moonPhase` is the thin `suncalc` wrapper. `bezierPoint`/`sunArcPosition` drive the day-arc SVG.

**Files:**
- Create: `ui/src/components/codex/sky.ts`
- Test: `ui/src/components/codex/sky.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/codex/sky.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bezierPoint, describeMoon, sunArcPosition } from "./sky";

describe("describeMoon", () => {
  it("names the new moon and marks it neither waxing nor full", () => {
    const m = describeMoon({ fraction: 0, phase: 0 });
    expect(m.phaseName).toBe("New");
    expect(m.illumPct).toBe(0);
  });
  it("treats phase < 0.5 as waxing and > 0.5 as waning", () => {
    expect(describeMoon({ fraction: 0.6, phase: 0.3 }).waxing).toBe(true);
    expect(describeMoon({ fraction: 0.6, phase: 0.7 }).waxing).toBe(false);
  });
  it("names the full moon at phase 0.5", () => {
    expect(describeMoon({ fraction: 1, phase: 0.5 }).phaseName).toBe("Full");
    expect(describeMoon({ fraction: 1, phase: 0.5 }).illumPct).toBe(100);
  });
});

describe("bezierPoint (day-arc quadratic)", () => {
  it("hits the endpoints", () => {
    expect(bezierPoint(0)).toEqual({ x: 24, y: 48 });
    expect(bezierPoint(1)).toEqual({ x: 576, y: 48 });
  });
  it("computes the midpoint", () => {
    expect(bezierPoint(0.5)).toEqual({ x: 300, y: 8 });
  });
});

describe("sunArcPosition", () => {
  const sunrise = new Date("2026-05-02T05:54:00Z");
  const sunset = new Date("2026-05-02T20:31:00Z");
  it("clamps to the horizon before sunrise and after sunset", () => {
    expect(sunArcPosition(new Date("2026-05-02T04:00:00Z"), sunrise, sunset).t).toBe(0);
    expect(sunArcPosition(new Date("2026-05-02T22:00:00Z"), sunrise, sunset).t).toBe(1);
  });
  it("is ~0.5 at solar midpoint", () => {
    const mid = new Date("2026-05-02T13:12:00Z");
    expect(sunArcPosition(mid, sunrise, sunset).t).toBeCloseTo(0.5, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/components/codex/sky.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sky.ts`**

Create `ui/src/components/codex/sky.ts`:

```ts
import SunCalc from "suncalc";

const MOON_NAMES = [
  "New", "Waxing crescent", "First quarter", "Waxing gibbous",
  "Full", "Waning gibbous", "Last quarter", "Waning crescent",
];
const MOON_GLYPHS = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];

export interface MoonInfo {
  phaseName: string;
  glyph: string;
  /** Illuminated fraction, 0..100, rounded. */
  illumPct: number;
  waxing: boolean;
  /** Terminator ellipse scaleX for the CSS disc (0 = half-lit edge, 1 = full). */
  terminatorScaleX: number;
}

/** Pure mapping from raw illumination to display info. */
export function describeMoon(illum: { fraction: number; phase: number }): MoonInfo {
  const idx = Math.round(illum.phase * 8) % 8;
  return {
    phaseName: MOON_NAMES[idx],
    glyph: MOON_GLYPHS[idx],
    illumPct: Math.round(illum.fraction * 100),
    waxing: illum.phase < 0.5,
    // |1 - 2f|: 1 at new/full, 0 at the quarters (straight terminator).
    terminatorScaleX: Math.abs(1 - 2 * illum.fraction),
  };
}

export function moonPhase(now: Date): MoonInfo {
  return describeMoon(SunCalc.getMoonIllumination(now));
}

// Day-arc quadratic Bézier control points (matches SPLASH viewBox 0 0 600 56):
// P0 (24,48) → P1 (300,-32) → P2 (576,48).
const P0 = { x: 24, y: 48 };
const P1 = { x: 300, y: -32 };
const P2 = { x: 576, y: 48 };

export function bezierPoint(t: number): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: Math.round(mt * mt * P0.x + 2 * mt * t * P1.x + t * t * P2.x),
    y: Math.round(mt * mt * P0.y + 2 * mt * t * P1.y + t * t * P2.y),
  };
}

export interface SunArc {
  t: number;
  x: number;
  y: number;
}

/** Sun position along the arc by time-of-day, clamped to [0,1]. */
export function sunArcPosition(now: Date, sunrise: Date, sunset: Date): SunArc {
  const span = sunset.getTime() - sunrise.getTime();
  const raw = span > 0 ? (now.getTime() - sunrise.getTime()) / span : 0;
  const t = Math.min(1, Math.max(0, raw));
  return { t, ...bezierPoint(t) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/components/codex/sky.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/sky.ts ui/src/components/codex/sky.test.ts
git commit -m "feat(atrium): pure sky math (moon phase, day-arc bezier, sun position)"
```

---

## Task 5: `Card` primitive (WU-1)

The reusable classified-figure card: header with a status pip, tracked label, and optional `FIG. N` caption; bordered body with a `tight` variant.

**Files:**
- Create: `ui/src/components/codex/Card.tsx`
- Test: `ui/src/components/codex/Card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/codex/Card.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
  it("renders label, caption, and children", () => {
    render(
      <Card label="Inventory" caption="FIG. I — TELEMETRY">
        <p>body</p>
      </Card>,
    );
    expect(screen.getByText("Inventory")).toBeInTheDocument();
    expect(screen.getByText("FIG. I — TELEMETRY")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("omits the caption node when none is given", () => {
    render(<Card label="Sky">x</Card>);
    expect(screen.queryByText(/FIG\./)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/components/codex/Card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Card.tsx`**

Create `ui/src/components/codex/Card.tsx`:

```tsx
import type { ReactNode } from "react";
import { clsx } from "clsx";

type Pip = "cool" | "hot" | "dim";

const PIP_CLASS: Record<Pip, string> = {
  cool: "bg-cool animate-pulse",
  hot: "bg-accent animate-pulse",
  dim: "bg-ink-mute",
};

export function Card({
  label,
  caption,
  pip = "cool",
  tight = false,
  className,
  children,
}: {
  label: string;
  caption?: ReactNode;
  pip?: Pip;
  tight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={clsx("border border-rule bg-paper-2", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-rule bg-paper px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={clsx("h-[7px] w-[7px] flex-shrink-0", PIP_CLASS[pip])} />
          <span className="cl-mono truncate text-[9px] font-medium uppercase tracking-[0.22em] text-ink">
            {label}
          </span>
        </div>
        {caption ? (
          <span className="cl-mono whitespace-nowrap text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            {caption}
          </span>
        ) : null}
      </div>
      <div className={tight ? "" : "p-3.5"}>{children}</div>
    </section>
  );
}
```

> `clsx` is already a project dependency (per CLAUDE.md code-style). `bg-cool` maps to the `--cool` token via the Tailwind v4 `@theme`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/components/codex/Card.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Card.tsx ui/src/components/codex/Card.test.tsx
git commit -m "feat(codex): Card primitive with classified-figure header"
```

---

## Task 6: `MoonDisc` and `DayArc` components

Presentational sky components driven by `sky.ts`. Light render tests confirm they mount and accept their props.

**Files:**
- Create: `ui/src/components/codex/MoonDisc.tsx`
- Create: `ui/src/components/codex/DayArc.tsx`
- Test: `ui/src/components/codex/MoonDisc.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/codex/MoonDisc.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayArc } from "./DayArc";
import { MoonDisc } from "./MoonDisc";

describe("sky components", () => {
  it("renders MoonDisc with a phase label", () => {
    const { getByLabelText } = render(
      <MoonDisc info={{ phaseName: "Full", glyph: "🌕", illumPct: 100, waxing: false, terminatorScaleX: 1 }} />,
    );
    expect(getByLabelText(/Full · 100%/)).toBeInTheDocument();
  });

  it("renders DayArc as an svg", () => {
    const { container } = render(
      <DayArc t={0.5} x={300} y={8} sunriseLabel="05:54" sunsetLabel="20:31" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/components/codex/MoonDisc.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the components**

Create `ui/src/components/codex/MoonDisc.tsx`:

```tsx
import type { MoonInfo } from "./sky";

/** CSS-drawn moon-phase disc. Lit hemisphere + terminator ellipse scaled by phase. */
export function MoonDisc({ info }: { info: MoonInfo }) {
  return (
    <div
      className="relative flex h-24 w-24 items-center justify-center border border-rule bg-paper"
      aria-label={`${info.phaseName} · ${info.illumPct}%`}
    >
      <div
        className="relative h-16 w-16 overflow-hidden rounded-full"
        style={{
          background: "#1a1a18",
          boxShadow: "inset 0 0 0 1px var(--ink-mute)",
          transform: info.waxing ? "none" : "scaleX(-1)",
        }}
      >
        {/* lit hemisphere */}
        <span
          className="absolute inset-0"
          style={{ background: "var(--ink)", clipPath: "inset(0 0 0 50%)" }}
        />
        {/* terminator ellipse */}
        <span
          className="absolute inset-0"
          style={{
            background: "var(--ink)",
            transformOrigin: "center",
            transform: `scaleX(${info.terminatorScaleX})`,
            mixBlendMode: "lighten",
          }}
        />
      </div>
    </div>
  );
}
```

Create `ui/src/components/codex/DayArc.tsx`:

```tsx
/** SVG day arc with sunrise/noon/sunset ticks and a NOW sun marker. */
export function DayArc({
  x,
  y,
  sunriseLabel,
  sunsetLabel,
}: {
  t: number;
  x: number;
  y: number;
  sunriseLabel: string;
  sunsetLabel: string;
}) {
  return (
    <div className="mt-3 border-t border-rule pt-3">
      <svg
        className="block h-14 w-full"
        viewBox="0 0 600 56"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line x1="0" y1="48" x2="600" y2="48" stroke="var(--ink-mute)" strokeWidth="1" strokeDasharray="2,3" />
        <path d="M 24 48 Q 300 -32 576 48" fill="none" stroke="var(--ink-mute)" strokeWidth="1" />
        <line x1="24" y1="42" x2="24" y2="54" stroke="var(--ink-2)" strokeWidth="1" />
        <line x1="576" y1="42" x2="576" y2="54" stroke="var(--ink-2)" strokeWidth="1" />
        <circle cx={x} cy={y} r="5" fill="var(--warn)" />
        <circle cx={x} cy={y} r="9" fill="none" stroke="var(--warn)" strokeWidth="1" opacity="0.4" />
      </svg>
      <div className="cl-mono mt-1 flex justify-between text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        <span>↑ {sunriseLabel}</span>
        <span>{sunsetLabel} ↓</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/components/codex/MoonDisc.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/MoonDisc.tsx ui/src/components/codex/DayArc.tsx ui/src/components/codex/MoonDisc.test.tsx
git commit -m "feat(atrium): MoonDisc + DayArc sky components"
```

---

## Task 7: Hero grid-texture utility

A faint grid background for the hero, exposed as a reusable class (WU-1).

**Files:**
- Modify: `ui/src/main.css`

- [ ] **Step 1: Add the utility class**

Append to `ui/src/main.css` (after the existing `.cl-frame` block; keep it in the same layer the other `.cl-*` utilities use):

```css
/* Faint dossier grid texture (hero, cards). Sits behind content via ::before. */
.cl-grid-texture {
    position: relative;
    overflow: hidden;
}
.cl-grid-texture > * {
    position: relative;
}
.cl-grid-texture::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
        repeating-linear-gradient(0deg, transparent 0 23px, var(--rule-soft) 23px 24px),
        repeating-linear-gradient(90deg, transparent 0 23px, var(--rule-soft) 23px 24px);
    opacity: 0.5;
    pointer-events: none;
}
```

- [ ] **Step 2: Verify the build still compiles CSS**

Run: `cd ui && bun run typecheck`
Expected: no errors (CSS is validated at build; typecheck confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add ui/src/main.css
git commit -m "style(atrium): .cl-grid-texture hero grid utility"
```

---

## Task 8: ATRIUM layout shell + Card adoption

Rework the container to a full-width 12-column grid and replace the ad-hoc `Panel` with `Card` (FIG. captions), keeping existing content rendering so the app stays working between tasks. Subsequent tasks fill each module.

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`

- [ ] **Step 1: Replace imports and the helper `Panel`/`Stat`/date helpers with the new modules**

At the top of `ui/src/components/codex/Atrium.tsx`, update imports:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { useBcl } from "#/api/bcl";
import { useContentIndex, useStats, useTags } from "#/api/index";
import { useJournalToday } from "#/api/journal";
import { useLocation } from "#/api/location";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { shortFolio } from "#/components/codex/folio-utils";
import { useClock } from "#/hooks/useClock";
import { useOpenTab } from "#/hooks/useOpenTab";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import { Card } from "./Card";
import { DayArc } from "./DayArc";
import { MoonDisc } from "./MoonDisc";
import {
  buildHeatmap,
  dayOfYear,
  deriveInventory,
  julianDay,
  sortRecents,
} from "./atrium-data";
import { moonPhase, sunArcPosition } from "./sky";
```

Delete the local `dayOfYear`, `julianDay`, `buildHeatmap`, `level` definitions (now in `atrium-data.ts`) and the `MOON_PHASES`/`buildSky`/`dflt` definitions (now in `sky.ts`). Keep `greeting`, `fmtDate`, `fmtTime`, `pad`, `APHORISMS`, `fmtBclDuration`, `fmtBclDate`, and the `KVLine` helper. Keep the `Heatmap` component for now (Task 12 replaces it). Delete the `Panel` helper (replaced by `Card`) and the `Stat` helper (replaced in Task 10) once their last use is gone — to stay green between steps, do the deletions in the tasks that remove the last usage. In **this** task, only remove `Panel` after switching all call-sites to `Card` below.

- [ ] **Step 2: Switch the container to a 12-col full-width grid and Card-wrap modules**

Replace the outer wrapper and module layout. The new return keeps the *current* inner content of each module but wraps each in `Card` with a FIG caption and places them on a 12-col grid:

```tsx
  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-3.5 px-4 py-4">
      {/* HERO — col-12 (filled in Task 9) */}
      <div className="col-span-12">{/* hero placeholder, replaced in Task 9 */}</div>

      {/* INVENTORY — col-12 (filled in Task 10) */}
      <div className="col-span-12">{/* inventory placeholder, replaced in Task 10 */}</div>

      {/* APHORISM (col-7) + SKY (col-5) */}
      <Card className="col-span-12 lg:col-span-7" label="Aphorism" pip="dim" caption="FIG. II">
        <blockquote className="m-0 font-sans text-[18px] italic leading-[1.4] text-ink-2">
          “{aphorism.text}”
        </blockquote>
        <div className="cl-mono mt-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          — {aphorism.who}
        </div>
      </Card>
      <Card className="col-span-12 lg:col-span-5" label="Sky" caption="FIG. III">
        {/* replaced in Task 11 */}
        <div className="cl-mono flex flex-col gap-1.5 text-[11px]">
          <KVLine k="Sunrise" v={fmtTime(skyTimes.sunrise)} />
          <KVLine k="Sunset" v={fmtTime(skyTimes.sunset)} />
        </div>
      </Card>

      {/* HEATMAP (col-8) + TAGS (col-4) */}
      <Card className="col-span-12 lg:col-span-8" label={`Activity · ${heat.total} edits / 26wk`} pip="cool" caption="FIG. IV — CAPTURES PER DAY">
        <Heatmap weeks={heat.weeks} />
      </Card>
      <Card className="col-span-12 lg:col-span-4" label="Subjects, by frequency" caption="FIG. V">
        {topTags.length === 0 ? (
          <p className="cl-marg m-0">No tags yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topTags.map((t) => (
              <button
                type="button"
                key={t.tag}
                onClick={() =>
                  navigate({ to: "/gazetteer", search: { tag: t.tag } as never })
                }
                className="group grid cursor-pointer grid-cols-[120px_1fr_36px] items-center gap-2 text-left"
              >
                <span className="cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-ink-2 group-hover:text-accent">
                  #{t.tag}
                </span>
                <span className="h-[8px] bg-rule-soft">
                  <span
                    className="block h-full bg-accent"
                    style={{ width: `${Math.max(4, (t.count / maxTag) * 100)}%` }}
                  />
                </span>
                <span className="cl-mono text-right text-[10px] tabular-nums text-ink-mute">
                  {t.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* RECENTS (col-7, filled in Task 13) + BCL (col-5) */}
      <div className="col-span-12 lg:col-span-7">{/* recents placeholder, replaced in Task 13 */}</div>
      {bcl?.birth_date && bcl.bcl_date && bcl.remaining_seconds !== null && (
        <Card className="col-span-12 lg:col-span-5" label="Brimley-Cocoon Line" pip="dim" caption="FIG. VII">
          <div className="cl-mono text-[22px] leading-none text-accent">
            {fmtBclDuration(bcl.remaining_seconds)}
          </div>
          <div className="cl-mono mt-1.5 text-[10px] text-ink-mute">
            {bcl.remaining_seconds >= 0 ? "crosses" : "crossed"}{" "}
            {fmtBclDate(bcl.bcl_date)} · natal {bcl.birth_date}
          </div>
        </Card>
      )}
    </div>
  );
```

- [ ] **Step 3: Provide the data the shell references**

In the component body (above the `return`), replace the old `recent`/`heat`/`sky` memo block with:

```tsx
  const items = content?.items ?? [];
  const now = useClock();

  const heat = useMemo(() => buildHeatmap(items, now), [items, now]);
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  const skyTimes = useMemo(() => {
    const lat = location?.latitude ?? null;
    const lon = location?.longitude ?? null;
    if (lat !== null && lon !== null) {
      // suncalc imported lazily through sky.ts wrappers in later tasks;
      // here we only need sunrise/sunset for the placeholder.
    }
    return { sunrise: dfltTime(now, 6), sunset: dfltTime(now, 20) };
  }, [location, now]);

  const aphorism = APHORISMS[dayOfYear(now) % APHORISMS.length];
```

Add a small local `dfltTime` helper near the other date helpers (kept minimal; Task 11 replaces the sky placeholder entirely with real `suncalc` data):

```tsx
function dfltTime(now: Date, h: number): Date {
  const d = new Date(now);
  d.setHours(h, 0, 0, 0);
  return d;
}
```

> `now` now comes from `useClock()`, so the heatmap/aphorism recompute at most once per second — cheap, and `useMemo` keeps them stable within a second.

- [ ] **Step 4: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass. (Unused-symbol errors here mean a leftover `Panel`/`Stat`/`buildSky` wasn't removed — delete it.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): full-width 12-col grid + Card adoption with FIG captions"
```

---

## Task 9: Hero rework (display headline + greeting meta + CTAs)

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`

- [ ] **Step 1: Add the journal-today hook + derived strings**

In the component body add:

```tsx
  const { data: journalToday } = useJournalToday();
  const todayLabel = `${fmtDate(now)} (${WEEKDAYS[now.getDay()]})`;
  const doy = dayOfYear(now);
  const yearDays = isLeap(now.getFullYear()) ? 366 : 365;
  const week = Math.ceil(doy / 7);
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const journalSub = journalToday?.meta.id
    ? `${journalToday.meta.id} · DAILY / ${fmtDate(now)}`
    : `DAILY / ${fmtDate(now)}`;
```

Add helpers near the other date helpers:

```tsx
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
```

- [ ] **Step 2: Replace the hero placeholder**

Replace `<div className="col-span-12">{/* hero placeholder... */}</div>` with:

```tsx
      <section className="cl-grid-texture col-span-12 grid items-end gap-6 border border-rule bg-paper-2 px-6 py-5 md:grid-cols-[1fr_auto]">
        <div>
          <div className="cl-mono mb-3 flex flex-wrap items-center gap-4 text-[9px] uppercase tracking-[0.28em] text-ink-mute">
            <span className="text-accent">●</span>
            <span>DAYSTART / <b className="font-medium text-ink">{todayLabel}</b></span>
            <span>WEEK {week}</span>
            <span>DAY {doy} / {yearDays}</span>
            <span>JD {julianDay(now)}</span>
            <span className="tabular-nums">{clock} LOCAL</span>
          </div>
          <h1 className="font-sans text-[clamp(40px,6vw,72px)] font-black leading-[0.95] tracking-[-0.02em] text-ink">
            {greeting(now)}.
          </h1>
        </div>

        <div className="flex min-w-[280px] flex-col gap-2">
          <button
            type="button"
            onClick={() => navigate({ to: "/journal" })}
            className="group grid grid-cols-[1fr_auto] items-center gap-4 border border-ink bg-ink px-4 py-3.5 text-left text-paper transition-colors hover:border-accent hover:bg-accent"
          >
            <div>
              <div className="font-sans text-[12px] font-semibold uppercase tracking-[0.18em]">
                Open today’s journal
              </div>
              <div className="cl-mono mt-1 text-[9px] uppercase tracking-[0.18em] opacity-75">
                {journalSub}
              </div>
            </div>
            <div className="text-[16px]">→</div>
          </button>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={openInscribe}
              className="cl-mono border border-rule bg-paper px-2.5 py-2 text-left text-[9px] uppercase tracking-[0.22em] text-ink-2 hover:border-ink-mute hover:text-ink"
            >
              Capture
              <div className="mt-1 text-[9px] tracking-[0.18em] text-ink-mute">⌘ N</div>
            </button>
            <button
              type="button"
              onClick={openSearch}
              className="cl-mono border border-rule bg-paper px-2.5 py-2 text-left text-[9px] uppercase tracking-[0.22em] text-ink-2 hover:border-ink-mute hover:text-ink"
            >
              Search
              <div className="mt-1 text-[9px] tracking-[0.18em] text-ink-mute">⌘ K</div>
            </button>
          </div>
        </div>
      </section>
```

Confirm `openSearch`/`openInscribe` are still pulled from `useUiStore` at the top of the component (they were in the original). If not present, add:

```tsx
  const openSearch = useUiStore((s) => s.openSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): rich hero with primary journal CTA and greeting meta"
```

---

## Task 10: Inventory section (real-data grid)

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`

- [ ] **Step 1: Compute cells and render the inventory Card**

In the component body add:

```tsx
  const inventory = useMemo(
    () => deriveInventory(stats, tags, items, now),
    [stats, tags, items, now],
  );
```

Replace the inventory placeholder `<div className="col-span-12">{/* inventory placeholder... */}</div>` with:

```tsx
      <Card
        className="col-span-12"
        label="Vessel · Inventory"
        caption="FIG. I — STEADY-STATE TELEMETRY"
        tight
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
          {inventory.map((cell, i) => (
            <div
              key={cell.label}
              className={
                "flex flex-col gap-1 border-rule px-3.5 py-3 " +
                (i % 8 !== 7 ? "border-r " : "") +
                (i >= 4 ? "border-t lg:border-t-0 " : "") +
                (i >= 4 ? "" : "")
              }
            >
              <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
                {cell.label}
              </span>
              <span
                className={
                  "font-sans text-[28px] font-bold leading-none tabular-nums " +
                  (cell.tone === "warn" ? "text-warn" : "text-ink")
                }
              >
                {cell.value}
              </span>
              {cell.sub ? (
                <span className="cl-mono text-[9px] tracking-[0.12em] text-ink-mute">
                  {cell.sub}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Card>
```

> The inventory is a single flat 8-cell grid (4-up on small screens, 8-up on large) rather than two bordered rows; this keeps the border math simple and reads cleanly at the col-12 width. Cells omitted by `deriveInventory` (no stats) simply don't render.

- [ ] **Step 2: Remove the now-unused `Stat` helper**

Delete the `Stat` function and its old `<section className="grid ...">` stat grid if any reference remains. Confirm no other file imports `Stat` (it was local to `Atrium.tsx`).

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): real-data inventory grid (corpus + today/7d cells)"
```

---

## Task 11: Sky module (MoonDisc + DayArc + KV rows)

Replace the placeholder Sky card body with the graphical disc, day arc, and KV rows, all from real `suncalc` data.

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`

- [ ] **Step 1: Compute real sky data**

Replace the `skyTimes`/`dfltTime` placeholder logic from Task 8 with real `suncalc` usage:

```tsx
  const sky = useMemo(() => {
    const lat = location?.latitude ?? null;
    const lon = location?.longitude ?? null;
    const hasLoc = lat !== null && lon !== null;
    const times = hasLoc
      ? SunCalc.getTimes(now, lat, lon)
      : { sunrise: atHour(now, 6), sunset: atHour(now, 20) };
    const arc = sunArcPosition(now, times.sunrise, times.sunset);
    const moon = moonPhase(now);
    const remMin = Math.max(0, Math.floor((times.sunset.getTime() - now.getTime()) / 60_000));
    return {
      moon,
      sunrise: fmtTime(times.sunrise),
      sunset: fmtTime(times.sunset),
      lightLeft: `${Math.floor(remMin / 60)}h ${pad(remMin % 60)}m`,
      arc,
      place: location?.label ?? null,
    };
  }, [location, now]);
```

Add the `SunCalc` import and `atHour` helper:

```tsx
import SunCalc from "suncalc";
```
```tsx
function atHour(now: Date, h: number): Date {
  const d = new Date(now);
  d.setHours(h, 0, 0, 0);
  return d;
}
```

Remove the Task-8 `skyTimes`/`dfltTime` placeholder.

- [ ] **Step 2: Replace the Sky card body**

Replace the placeholder Sky `<Card label="Sky" ...>` body with:

```tsx
      <Card className="col-span-12 lg:col-span-5" label="Sky" caption="FIG. III">
        <div className="grid grid-cols-[96px_1fr] gap-4">
          <MoonDisc info={sky.moon} />
          <div className="cl-mono flex flex-col gap-1.5 text-[11px]">
            <div className="border-b border-rule pb-1.5 font-medium uppercase tracking-[0.2em] text-ink">
              {sky.moon.phaseName} · {sky.moon.illumPct}%
            </div>
            <KVLine k="Sunrise" v={sky.sunrise} />
            <KVLine k="Sunset" v={sky.sunset} />
            <KVLine k="Light left" v={sky.lightLeft} />
            {sky.place && <KVLine k="At" v={sky.place} />}
          </div>
        </div>
        <DayArc
          t={sky.arc.t}
          x={sky.arc.x}
          y={sky.arc.y}
          sunriseLabel={sky.sunrise}
          sunsetLabel={sky.sunset}
        />
      </Card>
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): graphical sky module (moon disc + day arc)"
```

---

## Task 12: Heatmap chrome (DOW labels, months, 6 levels, streak footer, legend)

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`

- [ ] **Step 1: Replace the `Heatmap` component**

Replace the existing `Heatmap` function and `HEAT_LEVEL` constant with the enriched version:

```tsx
const HEAT_LEVEL = [
  "bg-rule-soft",
  "bg-accent/30",
  "bg-accent/55",
  "bg-accent/80",
  "bg-warn",
  "bg-accent",
];
const DOW_LABELS = ["M", "", "W", "", "F", "", "S"]; // Monday-first rows

function Heatmap({
  weeks,
  monthLabels,
}: {
  weeks: number[][];
  monthLabels: string[];
}) {
  return (
    <div>
      <div className="mb-1.5 ml-[26px] flex">
        {monthLabels.map((m, i) => (
          <span
            key={`m${i}`}
            className="cl-mono min-w-0 flex-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute"
          >
            {m}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-[22px_1fr] gap-2">
        <div className="cl-noscroll grid grid-rows-7 gap-[3px] pr-1 text-right text-[9px] text-ink-mute">
          {DOW_LABELS.map((d, i) => (
            <span key={`dow${i}`} className="h-[12px] leading-[12px]">
              {d}
            </span>
          ))}
        </div>
        <div className="cl-noscroll flex gap-[3px] overflow-x-auto">
          {weeks.map((week, wi) => (
            <div key={`w${wi}`} className="flex flex-col gap-[3px]">
              {week.map((lvl, di) => (
                <span key={`d${di}`} className={`h-[12px] w-[12px] ${HEAT_LEVEL[lvl]}`} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatmapFooter({
  total,
  longest,
  current,
}: {
  total: number;
  longest: number;
  current: number;
}) {
  return (
    <div className="cl-mono mt-3 flex flex-wrap items-center justify-between gap-2 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
      <span>
        TOTAL <b className="font-medium text-ink">{total.toLocaleString("en-US")}</b> · LONGEST{" "}
        <b className="font-medium text-ink">{longest}d</b> · CURRENT{" "}
        <b className="text-accent">{current}d</b>
      </span>
      <span className="flex items-center gap-1.5">
        LESS
        {HEAT_LEVEL.map((c, i) => (
          <i key={`leg${i}`} className={`inline-block h-3 w-3 border border-rule ${c}`} />
        ))}
        MORE
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Update the heatmap Card to pass the new props + footer**

Replace the heatmap `<Card>` from Task 8 with:

```tsx
      <Card
        className="col-span-12 lg:col-span-8"
        label="Activity · Rolling 26 weeks"
        pip="cool"
        caption="FIG. IV — CAPTURES PER DAY · UTC"
      >
        <Heatmap weeks={heat.weeks} monthLabels={heat.monthLabels} />
        <HeatmapFooter total={heat.total} longest={heat.longestStreak} current={heat.currentStreak} />
      </Card>
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): heatmap chrome — DOW/month labels, 6 levels, streak footer, legend"
```

---

## Task 13: Recents tabbed card (EDITED / CREATED / OPENED)

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`

- [ ] **Step 1: Add recents state + derived lists**

In the component body add:

```tsx
  const openTab = useOpenTab();
  const openHistory = useWorkspaceStore((s) => s.openHistory);
  const [recentTab, setRecentTab] = useState<"edited" | "created" | "opened">("edited");

  const byPath = useMemo(() => {
    const m = new Map<string, (typeof items)[number]>();
    for (const it of items) m.set(it.path, it);
    return m;
  }, [items]);

  const recentRows = useMemo(() => {
    if (recentTab === "opened") {
      return openHistory
        .map((h) => byPath.get(h.path))
        .filter((x): x is (typeof items)[number] => Boolean(x))
        .slice(0, 8);
    }
    return sortRecents(items, recentTab);
  }, [recentTab, openHistory, byPath, items]);
```

Add the `useState` import (extend the existing React import):

```tsx
import { type ReactNode, useMemo, useState } from "react";
```

- [ ] **Step 2: Replace the recents placeholder**

Replace `<div className="col-span-12 lg:col-span-7">{/* recents placeholder... */}</div>` with:

```tsx
      <section className="col-span-12 border border-rule bg-paper-2 lg:col-span-7">
        <div className="flex items-center justify-between border-b border-rule bg-paper">
          <div className="flex">
            {(["edited", "created", "opened"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setRecentTab(t)}
                className={
                  "cl-mono border-r border-rule px-3.5 py-2 text-[9px] uppercase tracking-[0.22em] " +
                  (recentTab === t
                    ? "text-ink shadow-[inset_0_2px_0_var(--accent)]"
                    : "text-ink-mute hover:text-ink")
                }
              >
                {t === "edited" ? "Recently edited" : t === "created" ? "Recently created" : "Opened"}
              </button>
            ))}
          </div>
          <span className="cl-mono px-3 py-2 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            {recentRows.length} OF {items.length}
          </span>
        </div>

        {recentRows.length === 0 ? (
          <p className="cl-marg m-0 p-3.5">
            {recentTab === "opened" ? "∅ Nothing opened yet this session." : "∅ No folios yet inscribed."}
          </p>
        ) : (
          <div className="flex flex-col">
            {recentRows.map((n, i) => {
              const kind = resolveKindFromPath(n.path);
              const ts = recentTab === "created" ? n.created_at : n.updated_at;
              return (
                <button
                  type="button"
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className="grid cursor-pointer grid-cols-[18px_90px_1fr_72px] items-baseline gap-3 border-b border-dotted border-rule-soft px-3.5 py-2 text-left hover:bg-paper-edge"
                >
                  <span className="cl-mono text-[9px] tabular-nums text-ink-mute">{pad(i + 1)}</span>
                  <span className="cl-mono flex items-center gap-1.5 text-[9px] text-ink-mute">
                    <span
                      className="inline-block h-[6px] w-[6px] flex-shrink-0"
                      style={{ background: kindColorVar(kind) }}
                    />
                    {shortFolio(n.path)}
                  </span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[14px] text-ink">
                    {n.title || n.path}
                  </span>
                  <span className="cl-mono text-right text-[9px] uppercase text-ink-mute">
                    {formatRelativeTime(ts)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
```

> This recents section is a raw `<section>` (not `Card`) because it needs the tab strip inside the header row. It mirrors the Card border/background tokens for visual consistency.

- [ ] **Step 3: Remove any leftover single "Recently inscribed" Panel/markup**

Delete the original `<Panel label={`Recently inscribed · ${recent.length}`}>...</Panel>` block and the `recent` memo if still present.

- [ ] **Step 4: Typecheck, lint, build, full test run**

Run: `cd ui && bun run typecheck && bun run lint && bun run build && bun run test`
Expected: all pass; the new `atrium-data`, `sky`, `useClock`, `Card`, `MoonDisc`, and `workspace` tests are green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "feat(atrium): tabbed recents card (edited/created/opened)"
```

---

## Task 14: Final verification + manual check

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green. Record the test count.

- [ ] **Step 2: Manual smoke (dev server)**

Run: `cd ui && bun run dev`, open ATRIUM, and confirm:
- Full-width layout fills wide viewports; collapses sanely below ~1100px and ~720px (cards stack to col-span-12 / 6).
- Hero clock ticks each second; "Open today's journal" navigates to `/journal`; Capture/Search open their modals.
- Inventory shows real corpus numbers; "Captures · today" / "Edited · today" reflect real timestamps; no fabricated deltas.
- Sky shows the moon disc (phase matches the KV phase name) and a day arc whose sun sits between sunrise/sunset for the current time.
- Heatmap shows DOW + month labels, a 6-step legend, and TOTAL/LONGEST/CURRENT streaks.
- Recents tabs switch between EDITED / CREATED / OPENED; OPENED populates after you open a few folios.

- [ ] **Step 3: Stop the dev server** (Ctrl-C) and note any visual gaps for follow-up.

---

## Self-review notes (coverage map)

| Spec WU-2 element | Task |
|---|---|
| Full-width 12-col dense tiling (F) | 8 |
| Rich hero + primary CTA + greeting meta (A) | 9 |
| Real-data inventory section | 10 |
| Graphical moon + day-arc sky (B) | 4, 6, 11 |
| Heatmap chrome (C) | 3, 12 |
| FIG. N card headers (D) | 5, 8 |
| Recents tabbed card EDITED/CREATED/OPENED (E) | 1, 13 |
| BCL panel retained | 8 |
| Live clock | 2, 9 |
| Out-of-scope (no fabricated telemetry/priors/scanlines) | honored throughout — inventory is real-data only |
