import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { AcademicLibrary } from "#/components/academic/AcademicLibrary";
import { FeatureGate } from "#/components/FeatureGate";
import { facetsEqual, type FilterState } from "#/lib/filters/model";
import {
  type FilterUrlOptions,
  filterStateToSearch,
  parseFilterSearch,
} from "#/lib/filters/url";

/** Route-level filter field specs for the Academic Library's URL-backed filter. */
export const ACADEMIC_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "work_type", kind: "single" },
    { id: "status", kind: "single" },
    { id: "year", kind: "single" },
    { id: "tag", kind: "single" },
  ],
};

function AcademicPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const filterState = useMemo(
    () => parseFilterSearch(search, ACADEMIC_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate({
        to: "/academic",
        search: (current) => ({
          ...current,
          ...filterStateToSearch(next, ACADEMIC_FILTER_URL),
        }),
        replace: facetsEqual(next.facets, filterState.facets),
      });
    },
    [navigate, filterState],
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
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
    ...search,
    ...filterStateToSearch(
      parseFilterSearch(search, ACADEMIC_FILTER_URL),
      ACADEMIC_FILTER_URL,
    ),
  }),
  component: AcademicRoute,
});
