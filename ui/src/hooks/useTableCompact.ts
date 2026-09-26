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
