import { createFileRoute } from "@tanstack/react-router";
import { AcademicLibrary } from "#/components/academic/AcademicLibrary";
import { ACADEMIC_FACETS } from "#/components/academic/academicFacets";
import { FeatureGate } from "#/components/FeatureGate";
import { defineFilterRoute, useFilterRoute } from "#/lib/filters/route";

/** The Academic Library's URL-backed filter. */
export const ACADEMIC_FILTER = defineFilterRoute({
  to: "/academic",
  facets: ACADEMIC_FACETS,
});

function AcademicPage() {
  const { filterState, onFilterChange } = useFilterRoute(
    ACADEMIC_FILTER,
    Route.useSearch(),
  );

  return (
    <AcademicLibrary
      filterState={filterState}
      onFilterChange={onFilterChange}
    />
  );
}

function AcademicRoute() {
  return (
    <FeatureGate feature="academic">
      <AcademicPage />
    </FeatureGate>
  );
}

export const Route = createFileRoute("/academic")({
  staticData: { codexView: "academic" },
  validateSearch: ACADEMIC_FILTER.validateSearch,
  component: AcademicRoute,
});
