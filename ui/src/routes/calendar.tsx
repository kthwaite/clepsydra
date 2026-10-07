import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { CalendarScreen } from "#/components/calendar/CalendarScreen";
import {
  CALENDAR_FILTER,
  type CalendarViewSearch,
  calendarViewToSearch,
  parseCalendarView,
  validateCalendarSearch,
} from "#/lib/calendar/search";
import { useFilterRoute } from "#/lib/filters/route";

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
  const { filterState, onFilterChange } = useFilterRoute(
    CALENDAR_FILTER,
    search,
  );

  const onViewChange = useCallback(
    (patch: Partial<CalendarViewSearch>) => {
      void navigate(calendarViewNavigation(patch));
    },
    [navigate],
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
