import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";
import { useOutlinks } from "#/api";
import type { components } from "#/api/schema";

type OutlinkEntry = components["schemas"]["OutlinkEntry"];

export interface WikilinkResolution {
  /** Synchronous lookup of a raw wikilink target against the indexed outlinks. */
  lookup(targetRaw: string): string | null;
  /**
   * Refetch the outlinks query once (to cover index lag), then look up the
   * target in the refreshed data.
   */
  refetchAndLookup(targetRaw: string): Promise<string | null>;
}

/**
 * Default value used when no provider is mounted (Storybook, tests, stray
 * editors): every lookup misses and nothing throws.
 */
const DEFAULT_RESOLUTION: WikilinkResolution = {
  lookup: () => null,
  refetchAndLookup: () => Promise.resolve(null),
};

const WikilinkResolutionContext =
  createContext<WikilinkResolution>(DEFAULT_RESOLUTION);

function buildWikiMap(
  entries: OutlinkEntry[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries ?? []) {
    if (entry.kind === "wiki" && entry.target_path != null) {
      map.set(entry.target_raw, entry.target_path);
    }
  }
  return map;
}

export function WikilinkResolutionProvider({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const { data, refetch } = useOutlinks(path);

  const wikiMap = useMemo(() => buildWikiMap(data), [data]);

  const lookup = useCallback(
    (targetRaw: string) => wikiMap.get(targetRaw) ?? null,
    [wikiMap],
  );

  const refetchAndLookup = useCallback(
    async (targetRaw: string) => {
      const refreshed = await refetch();
      return buildWikiMap(refreshed.data).get(targetRaw) ?? null;
    },
    [refetch],
  );

  const value = useMemo(
    () => ({ lookup, refetchAndLookup }),
    [lookup, refetchAndLookup],
  );

  return (
    <WikilinkResolutionContext.Provider value={value}>
      {children}
    </WikilinkResolutionContext.Provider>
  );
}

export function useWikilinkResolution(): WikilinkResolution {
  return useContext(WikilinkResolutionContext);
}
