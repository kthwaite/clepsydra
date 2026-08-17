import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { RubbishBin } from "#/components/rubbish/RubbishBin";
import type { FilterState } from "#/lib/filters/model";
import {
  type FilterUrlOptions,
  filterStateToSearch,
  parseFilterSearch,
} from "#/lib/filters/url";

/** Route-level filter field specs for the Rubbish Bin's URL-backed filter. */
export const RUBBISH_FILTER_URL: FilterUrlOptions = {
  fields: [{ id: "kind", kind: "single", normalize: (v) => v.toUpperCase() }],
};

function RubbishRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const filterState = useMemo(
    () => parseFilterSearch(search, RUBBISH_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate({
        to: "/rubbish",
        search: (current) => ({
          ...current,
          ...filterStateToSearch(next, RUBBISH_FILTER_URL),
        }),
      });
    },
    [navigate],
  );

  return (
    <RubbishBin filterState={filterState} onFilterChange={onFilterChange} />
  );
}

export const Route = createFileRoute("/rubbish")({
  staticData: { codexView: "rubbish" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
    ...search,
    ...filterStateToSearch(
      parseFilterSearch(search, RUBBISH_FILTER_URL),
      RUBBISH_FILTER_URL,
    ),
  }),
  component: RubbishRoute,
});
