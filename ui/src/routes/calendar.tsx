import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { CalendarScreen } from "#/components/calendar/CalendarScreen";
import {
  CALENDAR_FILTER_URL,
  type CalendarViewSearch,
  calendarViewToSearch,
  parseCalendarFilters,
  parseCalendarView,
  validateCalendarSearch,
} from "#/lib/calendar/search";
import type { FilterState } from "#/lib/filters/model";
import {
  mergeFilterSearch,
  shouldReplaceFilterHistory,
} from "#/lib/filters/url";

const CALENDAR_ROUTE_PATH = "/calendar" as const;

/** Paging and day selection replace history; mode and span changes push. */
export function calendarViewNavigation(patch: Partial<CalendarViewSearch>) {
  return {
    to: CALENDAR_ROUTE_PATH,
    search: <TSearch extends Record<string, unknown>>(current: TSearch) => ({
      ...current,
      ...calendarViewToSearch({ ...parseCalendarView(current), ...patch }),
    }),
    replace: !("mode" in patch || "span" in patch),
  };
}

export function calendarFilterNavigation(
  next: FilterState,
  previous: FilterState,
) {
  return {
    to: CALENDAR_ROUTE_PATH,
    search: <TSearch extends Record<string, unknown>>(current: TSearch) =>
      mergeFilterSearch(current, next, CALENDAR_FILTER_URL),
    replace: shouldReplaceFilterHistory(next, previous),
  };
}

export const Route = createFileRoute("/calendar")({
  staticData: { codexView: "calendar" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    validateCalendarSearch(search),
  component: CalendarPage,
});

function CalendarPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const view = useMemo(() => parseCalendarView(search), [search]);
  const filterState = useMemo(() => parseCalendarFilters(search), [search]);

  const onViewChange = useCallback(
    (patch: Partial<CalendarViewSearch>) => {
      void navigate(calendarViewNavigation(patch));
    },
    [navigate],
  );
  const onFilterChange = useCallback(
    (next: FilterState) => {
      void navigate(calendarFilterNavigation(next, filterState));
    },
    [navigate, filterState],
  );

  return (
    <CalendarScreen
      view={view}
      filterState={filterState}
      onViewChange={onViewChange}
      onFilterChange={onFilterChange}
    />
  );
}
