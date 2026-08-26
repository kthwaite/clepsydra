import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { AcademicLibrary } from "#/components/academic/AcademicLibrary";
import { FeatureGate } from "#/components/FeatureGate";
import type { FilterState } from "#/lib/filters/model";
import {
  canonicalizeFilterSearch,
  type FilterUrlOptions,
  mergeFilterSearch,
  parseFilterSearch,
  shouldReplaceFilterHistory,
} from "#/lib/filters/url";

const ACADEMIC_ROUTE_PATH = "/academic" as const;

/** Route-level filter field specs for the Academic Library's URL-backed filter. */
export const ACADEMIC_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "work_type", kind: "single" },
    { id: "status", kind: "single" },
    { id: "year", kind: "single" },
    { id: "tag", kind: "single" },
  ],
};

export function academicFilterNavigation(
  next: FilterState,
  previous: FilterState,
) {
  return {
    to: ACADEMIC_ROUTE_PATH,
    search: <TSearch extends Record<string, unknown>>(current: TSearch) =>
      mergeFilterSearch(current, next, ACADEMIC_FILTER_URL),
    replace: shouldReplaceFilterHistory(next, previous),
  };
}

function AcademicPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const filterState = useMemo(
    () => parseFilterSearch(search, ACADEMIC_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate(academicFilterNavigation(next, filterState));
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

export const Route = createFileRoute(ACADEMIC_ROUTE_PATH)({
  staticData: { codexView: "academic" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    canonicalizeFilterSearch(search, ACADEMIC_FILTER_URL),
  component: AcademicRoute,
});
