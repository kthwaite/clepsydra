/** Width bounds for the Folio reading column. The default is the width the
 * column always had; the minimum keeps a line readable rather than a column of
 * two words, and the maximum stops a measure so long the eye loses the line. */
export const READING_COLUMN_MIN = 560;
export const READING_COLUMN_DEFAULT = 900;
export const READING_COLUMN_MAX = 1400;
/** One arrow-key press. */
export const READING_COLUMN_STEP = 32;

/** Where the preference lives: a device, not a vault. */
export const READING_COLUMN_STORAGE_KEY = "clp.folio.column.w";

export interface WidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampReadingColumn(width: number): number {
  return Math.min(
    READING_COLUMN_MAX,
    Math.max(READING_COLUMN_MIN, Math.round(width)),
  );
}

/** The width to render: the author's preference, except that a viewport too
 * narrow to hold it wins — a column that overflows its pane is worse than a
 * column below the readable minimum. */
export function effectiveReadingColumn(
  preference: number,
  available: number,
): number {
  const wanted = clampReadingColumn(preference);
  if (!Number.isFinite(available) || available <= 0) return wanted;
  return Math.min(wanted, Math.round(available));
}

export function readStoredReadingColumn(
  storage: WidthStorage,
  key: string,
): number | undefined {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return undefined;
    return clampReadingColumn(parsed);
  } catch {
    // A browser with storage blocked keeps the default rather than failing.
    return undefined;
  }
}

export function writeStoredReadingColumn(
  storage: WidthStorage,
  key: string,
  width: number,
): void {
  try {
    storage.setItem(key, String(clampReadingColumn(width)));
  } catch {
    // ignore
  }
}
