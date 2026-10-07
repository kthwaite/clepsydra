// The Rubbish Bin's filter facets: one list for its URL and its FilterBar.

import type { FacetDef } from "#/lib/filters/route";

/** Kind options come from the binned items at render. */
export const RUBBISH_FACETS: readonly FacetDef[] = [
  {
    id: "kind",
    kind: "single",
    label: "Kind",
    normalize: (v) => v.toUpperCase(),
  },
];
