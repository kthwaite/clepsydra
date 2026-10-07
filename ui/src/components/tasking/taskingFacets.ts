// The Tasking board's filter facets: one list for its URL and its FilterBar.

import type { FacetOption } from "#/lib/filters/model";
import type { FacetDef } from "#/lib/filters/route";
import {
  COL_LABEL,
  COL_ORDER,
  PRI_LABEL,
  PRI_ORDER,
  TYPE_LABEL,
  TYPE_NONE,
  TYPE_ORDER,
} from "./board-constants";

const upper = (v: string) => v.toUpperCase();

/** Type facet options: the five task types, then the Untyped sentinel. */
export const TYPE_FILTER_OPTIONS: readonly FacetOption[] = [
  ...TYPE_ORDER.map((value) => ({ value, label: TYPE_LABEL[value] })),
  { value: TYPE_NONE, label: "Untyped" },
];

/** Project and Tags options come from the board data at render. */
export const TASKING_FACETS: readonly FacetDef[] = [
  { id: "project", kind: "multi", label: "Project" },
  { id: "tags", kind: "multi", label: "Tags" },
  {
    id: "pri",
    kind: "multi",
    label: "Priority",
    normalize: upper,
    options: PRI_ORDER.map((value) => ({
      value,
      label: `${value} ${PRI_LABEL[value]}`,
    })),
  },
  {
    id: "type",
    kind: "multi",
    label: "Type",
    normalize: upper,
    options: TYPE_FILTER_OPTIONS,
  },
  {
    id: "status",
    kind: "multi",
    label: "Status",
    normalize: upper,
    options: COL_ORDER.map((value) => ({
      value,
      label: COL_LABEL[value] ?? value,
    })),
  },
  { id: "hold", kind: "flag", label: "Blocked" },
];
