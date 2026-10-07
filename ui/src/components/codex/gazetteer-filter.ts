// The GAZETTEER's URL search: its facets, sort and page. No I/O — testable.

import type { ContentIndexSort } from "#/api/types";
import { defineFilterRoute, type FacetDef } from "#/lib/filters/route";
import { KINDS, kindDisplayLabel, sortKindsByLabel } from "#/lib/kind";

export type GazetteerSort = "ts" | "created" | "title" | "words";

const SORTS: readonly GazetteerSort[] = ["ts", "created", "title", "words"];

const CONTENT_INDEX_SORT: Record<GazetteerSort, ContentIndexSort> = {
  ts: "updated",
  created: "created",
  title: "title",
  words: "words",
};

/** The server-side content-index order that matches a Gazetteer sort. */
export function toContentIndexSort(sort: GazetteerSort): ContentIndexSort {
  return CONTENT_INDEX_SORT[sort];
}

export function appendUniqueTag(selectedTags: string[], tag: string): string[] {
  return selectedTags.includes(tag) ? selectedTags : [...selectedTags, tag];
}

/** The Gazetteer's facets: one list for its URL and its FilterBar. Project
 *  and Tag options come from the index at render. An unknown Kind is kept,
 *  so the server can reject it. */
export const GAZETTEER_FACETS: readonly FacetDef[] = [
  {
    id: "kind",
    kind: "single",
    label: "Kind",
    normalize: (v) => v.toUpperCase(),
    options: sortKindsByLabel(KINDS).map((k) => ({
      value: k,
      label: kindDisplayLabel(k),
    })),
  },
  { id: "project", kind: "single", label: "Project" },
  { id: "tags", kind: "multi", label: "Tag" },
];

/** The Gazetteer's URL-backed filter. `?tag=x` is the older spelling of
 *  `?tags=x`. A filter change returns to the first page. */
export const GAZETTEER_FILTER = defineFilterRoute({
  to: "/gazetteer",
  facets: GAZETTEER_FACETS,
  aliases: { tag: "tags" },
  resetOnChange: { page: 1 },
});

export type GazetteerSearch = Record<string, unknown> & {
  q?: string;
  tags?: string[];
  kind?: string;
  project?: string;
  sort: GazetteerSort;
  page: number;
};

export function validateGazetteerSearch(
  search: Record<string, unknown>,
): GazetteerSearch {
  const sort: GazetteerSort = SORTS.includes(search.sort as GazetteerSort)
    ? (search.sort as GazetteerSort)
    : "ts";
  const page =
    typeof search.page === "number" &&
    Number.isFinite(search.page) &&
    search.page >= 1
      ? Math.floor(search.page)
      : 1;
  // The filter codec writes q, tags, kind and project in these shapes.
  return {
    ...GAZETTEER_FILTER.validateSearch(search),
    sort,
    page,
  } as GazetteerSearch;
}
