import { useCallback, useMemo, useState } from "react";
import {
  type ColumnWidths,
  clampBaseColumnWidth,
  readColumnWidths,
  writeColumnWidths,
} from "./column-widths";
import { getViewStateStorage } from "./view-state";

export interface ColumnWidthsModel {
  widths: ColumnWidths;
  /** `undefined` forgets the width, so the column falls back to its default. */
  setWidth(id: string, width: number | undefined): void;
}

interface StoredWidths {
  key: string;
  widths: ColumnWidths;
}

function widthsFor(key: string): StoredWidths {
  return { key, widths: readColumnWidths(getViewStateStorage(), key) };
}

/** Column widths under `storageKey`, mirrored to localStorage. */
export function useColumnWidths(storageKey: string): ColumnWidthsModel {
  const [stored, setStored] = useState<StoredWidths>(() =>
    widthsFor(storageKey),
  );
  const widths = useMemo(
    () => (stored.key === storageKey ? stored : widthsFor(storageKey)).widths,
    [stored, storageKey],
  );
  const setWidth = useCallback(
    (id: string, width: number | undefined) =>
      setStored((current) => {
        const base =
          current.key === storageKey ? current : widthsFor(storageKey);
        const next = withWidth(base.widths, id, width);
        if (next === base.widths) return base;
        // Idempotent, so a repeated updater call (StrictMode) is harmless.
        writeColumnWidths(getViewStateStorage(), storageKey, next);
        return { key: storageKey, widths: next };
      }),
    [storageKey],
  );
  return { widths, setWidth };
}

function withWidth(
  current: ColumnWidths,
  id: string,
  width: number | undefined,
): ColumnWidths {
  if (width === undefined || !Number.isFinite(width)) {
    if (!Object.hasOwn(current, id)) return current;
    const { [id]: _dropped, ...rest } = current;
    return rest;
  }
  const clamped = clampBaseColumnWidth(width);
  if (current[id] === clamped) return current;
  return { ...current, [id]: clamped };
}
