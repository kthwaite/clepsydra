import { createFileRoute } from "@tanstack/react-router";
import { RubbishBin } from "#/components/rubbish/RubbishBin";
import { RUBBISH_FACETS } from "#/components/rubbish/rubbishFacets";
import { defineFilterRoute, useFilterRoute } from "#/lib/filters/route";

/** The Rubbish Bin's URL-backed filter. */
export const RUBBISH_FILTER = defineFilterRoute({
  to: "/rubbish",
  facets: RUBBISH_FACETS,
});

function RubbishRoute() {
  const { filterState, onFilterChange } = useFilterRoute(
    RUBBISH_FILTER,
    Route.useSearch(),
  );

  return (
    <RubbishBin filterState={filterState} onFilterChange={onFilterChange} />
  );
}

export const Route = createFileRoute("/rubbish")({
  staticData: { codexView: "rubbish" },
  validateSearch: RUBBISH_FILTER.validateSearch,
  component: RubbishRoute,
});
