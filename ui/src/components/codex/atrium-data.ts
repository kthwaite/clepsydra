// Pure derivations for the ATRIUM dashboard. No React, no I/O — fully testable.

import { pad2 } from "#/lib/time";

export interface HeatItem {
  path?: string | null;
  title?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface HeatmapPage {
  path: string;
  title?: string | null;
  activityAt: string;
}

export interface HeatmapDay {
  date: string;
  isFuture: boolean;
  count: number;
  level: number;
  pages: HeatmapPage[];
}

export interface Heatmap {
  /** Week columns, each 7 entries Mon..Sun. */
  weeks: HeatmapDay[][];
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
  kind?: string | null;
}

interface StatsLike {
  pages: number;
  links_total: number;
  links_unresolved: number;
  tags: number;
  orphan_pages: number;
  isolated_pages: number;
  attachments: number;
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
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/** UTC day key (YYYY-MM-DD) for an ISO string. */
function dayKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

/** UTC day key for a Date. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function level(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  if (n <= 10) return 4;
  return 5;
}

export function buildHeatmap(
  items: HeatItem[],
  now: Date = new Date(),
): Heatmap {
  const counts = new Map<string, number>();
  const pagesByDay = new Map<string, HeatmapPage[]>();
  let total = 0;
  for (const item of items) {
    const activityAt = item.updated_at ?? item.created_at;
    if (!activityAt) continue;
    const date = dayKeyOf(activityAt);
    counts.set(date, (counts.get(date) ?? 0) + 1);
    total += 1;
    if (!item.path) continue;
    const pages = pagesByDay.get(date) ?? [];
    pages.push({ path: item.path, title: item.title, activityAt });
    pagesByDay.set(date, pages);
  }
  for (const pages of pagesByDay.values()) {
    pages.sort(
      (a, b) =>
        b.activityAt.localeCompare(a.activityAt) ||
        a.path.localeCompare(b.path),
    );
  }

  // Today at UTC midnight; walk back to the Monday on/before (today - 181d).
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (HEATMAP_DAYS - 1));
  // Monday-first columns: 0=Sun..6=Sat → days back to Monday = (dow + 6) % 7.
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));

  const weeks: HeatmapDay[][] = [];
  const monthLabels: string[] = [];
  let prevMonth = -1;
  const cursor = new Date(start);

  while (cursor <= today) {
    const week: HeatmapDay[] = [];
    const colMonth = cursor.getUTCMonth();
    for (let d = 0; d < 7; d++) {
      const date = dayKey(cursor);
      const isFuture = cursor > today;
      const count = isFuture ? 0 : (counts.get(date) ?? 0);
      week.push({
        date,
        isFuture,
        count,
        level: level(count),
        pages: isFuture ? [] : (pagesByDay.get(date) ?? []),
      });
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
    cells.push({
      label: "Orphans",
      value: n(stats.orphan_pages),
      sub: "no backlinks",
    });
    cells.push({
      label: "Isolated",
      value: n(stats.isolated_pages),
      sub: "no links in or out",
    });
    cells.push({
      label: "Attach",
      value: n(stats.attachments),
      sub: "files",
    });
  }

  const todayKey = dayKey(now);
  const sevenAgoKey = dayKey(new Date(now.getTime() - 7 * MS_PER_DAY));
  let capturesToday = 0;
  let editedToday = 0;
  let new7d = 0;
  let unfiled = 0;
  for (const it of items) {
    if (it.created_at && dayKeyOf(it.created_at) === todayKey)
      capturesToday += 1;
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

/* ── daystart presentation ─────────────────────────────────────────────── */

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Diegetic dot-date, e.g. "2026.08.07". */
export function formatDotDate(d: Date): string {
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

/** Hero daystamp: "2026.08.07 (THU)". */
export function daystampLabel(d: Date): string {
  return `${formatDotDate(d)} (${WEEKDAYS[d.getDay()]})`;
}

/** Time-of-day salutation for the hero heading. */
export function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Still awake?!";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Good night";
}

/** Signed BCL countdown, e.g. "12,345d · 6h" ("+" once crossed). */
export function formatBclDuration(totalSeconds: number): string {
  const past = totalSeconds < 0;
  const s = Math.abs(totalSeconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  return `${past ? "+" : ""}${days.toLocaleString("en-US")}d · ${hours}h`;
}

/** BCL crossing date as a long local date; echoes malformed input unchanged. */
export function formatBclDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return yyyymmdd;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}
