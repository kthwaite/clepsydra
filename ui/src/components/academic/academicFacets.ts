// The Academic Library's filter facets: one list for its URL and its
// FilterBar.

import type { ReadingStatus, WorkType } from "#/api/academic";
import type { FacetDef } from "#/lib/filters/route";

/** WorkType union values (ui/src/api/schema.d.ts) — drive the work_type
 * facet's options and validate URL-arriving values before they reach the
 * server; `satisfies` fails loudly if the schema's union ever drifts. */
export const WORK_TYPES = [
  "paper",
  "book",
  "thesis",
  "report",
  "other",
] as const satisfies readonly WorkType[];

/** ReadingStatus union values (ui/src/api/schema.d.ts) — same role as
 * WORK_TYPES for the status facet. */
export const READING_STATUSES = [
  "unread",
  "reading",
  "done",
] as const satisfies readonly ReadingStatus[];

/** Year and Tag options come from the loaded works at render. */
export const ACADEMIC_FACETS: readonly FacetDef[] = [
  {
    id: "work_type",
    kind: "single",
    label: "Type",
    options: WORK_TYPES.map((value) => ({ value })),
  },
  {
    id: "status",
    kind: "single",
    label: "Status",
    options: READING_STATUSES.map((value) => ({ value })),
  },
  { id: "year", kind: "single", label: "Year" },
  { id: "tag", kind: "single", label: "Tag" },
];
