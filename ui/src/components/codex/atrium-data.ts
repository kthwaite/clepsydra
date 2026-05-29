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

interface InventoryItem {
  created_at?: string | null;
  updated_at?: string | null;
  tags?: string[] | null;
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
  while (back >= start && (counts.get(dayKey(back)) ?? 0) > 0) {
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
  items: InventoryItem[],
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
  const sevenAgoKey = dayKey(new Date(now.getTime() - 7 * MS_PER_DAY));
  let capturesToday = 0;
  let editedToday = 0;
  let new7d = 0;
  let unfiled = 0;
  for (const it of items) {
    if (it.created_at && dayKeyOf(it.created_at) === todayKey) capturesToday += 1;
    if (it.updated_at && dayKeyOf(it.updated_at) === todayKey) editedToday += 1;
    if (it.created_at && dayKeyOf(it.created_at) >= sevenAgoKey) new7d += 1;
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
