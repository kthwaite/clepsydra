import { useCallback } from "react";
import type { ResolvedWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { searchWikilinkTarget } from "#/editor/wikilinkSearch";

export interface ResolveWikilinkTarget {
  /**
   * Find the page a raw wikilink target names, or null. Never creates a page.
   * Throws when the index search fails.
   */
  resolve(targetRaw: string): Promise<ResolvedWikilinkTarget | null>;
}

/** The page name of a raw target: the part before any `#heading`. */
export function wikilinkPageName(targetRaw: string): string {
  const hash = targetRaw.indexOf("#");
  return (hash === -1 ? targetRaw : targetRaw.slice(0, hash)).trim();
}

/**
 * Resolve-only wikilink resolution for derived, read-only output. It refetches
 * the surrounding provider's outlinks (a no-op without a provider), then
 * searches the index and matches the page name against each result's title,
 * file stem and path.
 */
export function useResolveWikilinkTarget(): ResolveWikilinkTarget {
  const { refetchAndLookup } = useWikilinkResolution();

  const resolve = useCallback(
    async (targetRaw: string) => {
      const title = wikilinkPageName(targetRaw);
      if (!title) return null;
      const refreshed = await refetchAndLookup(targetRaw);
      if (refreshed) return { path: refreshed, title };
      const found = await searchWikilinkTarget(title, "title-stem-or-path");
      return found ? { path: found, title } : null;
    },
    [refetchAndLookup],
  );

  return { resolve };
}
