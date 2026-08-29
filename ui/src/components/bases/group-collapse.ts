import { asciiCaseFold } from "./local-validation";
import type { ViewStateStorage } from "./view-state";

const GROUPS_PREFIX = "clepsydra.bases.groups.";

/** One string per group key, so `null`, numbers, and strings stay distinct. */
export function groupIdentity(key: unknown): string {
  return JSON.stringify(key ?? null);
}

/** Folds are remembered per base, view, and the field the rows are grouped by. */
export function groupCollapseKey(
  slug: string,
  view: string,
  groupField: string,
): string {
  return `${GROUPS_PREFIX}${slug}.${asciiCaseFold(view)}.${groupField}`;
}

export function readCollapsedGroups(
  storage: ViewStateStorage | undefined,
  key: string,
): Set<string> {
  try {
    const stored = storage?.getItem(key);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === "string"),
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(
  storage: ViewStateStorage | undefined,
  key: string,
  collapsed: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(key, JSON.stringify([...collapsed]));
  } catch {
    // A fold is a convenience; a full or sealed store must not break the table.
  }
}
