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
export function pageItems(
  current: number,
  count: number,
): Array<number | "gap"> {
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
