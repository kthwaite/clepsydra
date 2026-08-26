import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { RubbishBin } from "#/components/rubbish/RubbishBin";
import type { FilterState } from "#/lib/filters/model";
import {
  canonicalizeFilterSearch,
  type FilterUrlOptions,
  mergeFilterSearch,
  parseFilterSearch,
  shouldReplaceFilterHistory,
} from "#/lib/filters/url";

const RUBBISH_ROUTE_PATH = "/rubbish" as const;

/** Route-level filter field specs for the Rubbish Bin's URL-backed filter. */
export const RUBBISH_FILTER_URL: FilterUrlOptions = {
  fields: [{ id: "kind", kind: "single", normalize: (v) => v.toUpperCase() }],
};

export function rubbishFilterNavigation(
  next: FilterState,
  previous: FilterState,
) {
  return {
    to: RUBBISH_ROUTE_PATH,
    search: <TSearch extends Record<string, unknown>>(current: TSearch) =>
      mergeFilterSearch(current, next, RUBBISH_FILTER_URL),
    replace: shouldReplaceFilterHistory(next, previous),
  };
}

function RubbishRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const filterState = useMemo(
    () => parseFilterSearch(search, RUBBISH_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate(rubbishFilterNavigation(next, filterState));
    },
    [navigate, filterState],
  );

  return (
    <RubbishBin filterState={filterState} onFilterChange={onFilterChange} />
  );
}

export const Route = createFileRoute(RUBBISH_ROUTE_PATH)({
  staticData: { codexView: "rubbish" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    canonicalizeFilterSearch(search, RUBBISH_FILTER_URL),
  component: RubbishRoute,
});
