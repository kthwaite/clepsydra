import { asciiCaseFold } from "./local-validation";
import type { ViewStateStorage } from "./view-state";

const COLUMNS_PREFIX = "clepsydra.bases.columns.";

export const BASE_COLUMN_MIN = 40;
export const BASE_COLUMN_MAX = 640;

/** Column id → width in pixels. */
export type ColumnWidths = Readonly<Record<string, number>>;

/** `ViewStateStorage`, plus `removeItem` when the store has one. */
type WidthStorage = ViewStateStorage & { removeItem?(key: string): void };

export function clampBaseColumnWidth(width: number): number {
  return Math.round(
    Math.min(BASE_COLUMN_MAX, Math.max(BASE_COLUMN_MIN, width)),
  );
}

/** Widths are remembered per base and view. */
export function columnWidthsKey(slug: string, view: string): string {
  return `${COLUMNS_PREFIX}${slug}.${asciiCaseFold(view)}`;
}

export function readColumnWidths(
  storage: ViewStateStorage | undefined,
  key: string,
): ColumnWidths {
  try {
    const stored = storage?.getItem(key);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const widths: Record<string, number> = {};
    for (const [id, width] of Object.entries(parsed)) {
      if (typeof width === "number" && Number.isFinite(width))
        widths[id] = clampBaseColumnWidth(width);
    }
    return widths;
  } catch {
    return {};
  }
}

export function writeColumnWidths(
  storage: WidthStorage | undefined,
  key: string,
  widths: ColumnWidths,
): void {
  try {
    if (Object.keys(widths).length > 0) {
      storage?.setItem(key, JSON.stringify(widths));
    } else if (storage?.removeItem) {
      storage.removeItem(key);
    } else {
      storage?.setItem(key, "{}");
    }
  } catch {
    // A width is a convenience; a full or sealed store must not break the table.
  }
}
