import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import type { TaskItem } from "#/api/tasks";
import {
  useAgendaOverdue,
  useAgendaToday,
  useAgendaWeek,
  useTasks,
} from "#/api/tasks";
import { FilterBar } from "#/components/filters/FilterBar";
import { priorityLabel, TaskList } from "#/components/TaskList";
import { SectionHeading } from "#/components/ui/section-heading";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
import {
  applyClientFilter,
  type ClientFilterConfig,
  type FilterField,
  type FilterState,
} from "#/lib/filters/model";
import {
  type FilterUrlOptions,
  filterStateToSearch,
  parseFilterSearch,
} from "#/lib/filters/url";
import { localDateKey, parseLocalDate } from "#/lib/time";

/** Route-level filter field specs for the Agenda's URL-backed filter. */
export const AGENDA_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "status", kind: "single" },
    { id: "priority", kind: "single", normalize: (v) => v.toUpperCase() },
  ],
};

/**
 * Client-side facet/text predicate config shared by all three Agenda panels.
 * Priority is the A/B/C agenda vocabulary read from `properties.priority`
 * (deliberately distinct from the board's P0–P3 — R3).
 */
export const AGENDA_FILTER_CONFIG: ClientFilterConfig<TaskItem> = {
  textHay: (t) => `${t.content}\n${t.page_title ?? ""}`,
  accessors: {
    status: (t) => [t.status],
    priority: (t) => {
      const p = t.properties.priority;
      return p ? [p.toUpperCase()] : [];
    },
  },
};

const STATUS_VALUES = ["todo", "doing", "done", "cancelled"] as const;
const PRIORITY_VALUES = ["A", "B", "C"] as const;

export const Route = createFileRoute("/agenda")({
  staticData: { codexView: "agenda" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
    ...search,
    ...filterStateToSearch(
      parseFilterSearch(search, AGENDA_FILTER_URL),
      AGENDA_FILTER_URL,
    ),
  }),
  component: AgendaPage,
});

function AgendaPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const filterState = useMemo(
    () => parseFilterSearch(search, AGENDA_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate({
        to: "/agenda",
        search: (current) => ({
          ...current,
          ...filterStateToSearch(next, AGENDA_FILTER_URL),
        }),
      });
    },
    [navigate],
  );

  return (
    <AgendaScreen filterState={filterState} onFilterChange={onFilterChange} />
  );
}

/** Exported for tests: the presentational half of `/agenda`, controlled by
 * route-owned filterState/onFilterChange props (mirrors RubbishBin/
 * AcademicLibrary's split so panel-filtering tests don't need to fake
 * TanStack Router's file-route hooks). */
export function AgendaScreen({
  filterState,
  onFilterChange,
}: {
  filterState: FilterState;
  onFilterChange: (next: FilterState) => void;
}) {
  const filterFields: FilterField[] = useMemo(
    () => [
      {
        id: "status",
        kind: "single",
        label: "STATUS",
        options: STATUS_VALUES.map((value) => ({
          value,
          label: value.toUpperCase(),
        })),
      },
      {
        id: "priority",
        kind: "single",
        label: "PRIORITY",
        options: PRIORITY_VALUES.map((value) => ({
          value,
          label: priorityLabel(value),
        })),
      },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2">
        <h1 className="font-heading text-lg font-bold">Agenda</h1>
        <FilterBar
          fields={filterFields}
          state={filterState}
          onChange={onFilterChange}
          textPlaceholder="Filter tasks…"
          className="mt-2"
        />
      </div>

      <Tabs defaultSelectedKey="today" className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-4 py-2">
          <TabList aria-label="Agenda sections">
            <Tab id="today">Today</Tab>
            <Tab id="upcoming">Upcoming</Tab>
            <Tab id="inbox">Inbox</Tab>
          </TabList>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-6">
            <TabPanel id="today">
              <TodayPanel filterState={filterState} />
            </TabPanel>
            <TabPanel id="upcoming">
              <UpcomingPanel filterState={filterState} />
            </TabPanel>
            <TabPanel id="inbox">
              <InboxPanel filterState={filterState} />
            </TabPanel>
          </div>
        </div>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab panels
// ---------------------------------------------------------------------------

function TodayPanel({ filterState }: { filterState: FilterState }) {
  const { data: todayData, isLoading: todayLoading } = useAgendaToday();
  const { data: overdueData, isLoading: overdueLoading } = useAgendaOverdue();

  if (todayLoading || overdueLoading) {
    return <LoadingIndicator />;
  }

  const overdueRaw = overdueData?.tasks ?? [];
  const overdueTasks = applyClientFilter(
    overdueRaw,
    filterState,
    AGENDA_FILTER_CONFIG,
  );
  const todayRaw = todayData?.tasks ?? [];
  const todayTasks = applyClientFilter(
    todayRaw,
    filterState,
    AGENDA_FILTER_CONFIG,
  );
  const todayEmptyMessage =
    todayRaw.length > 0 && todayTasks.length === 0
      ? "No tasks match the filter."
      : "Nothing due today.";

  return (
    <div className="space-y-6">
      {overdueTasks.length > 0 && (
        <section>
          <SectionHeading>Overdue</SectionHeading>
          <TaskList tasks={overdueTasks} />
        </section>
      )}
      <section>
        <SectionHeading>Due Today</SectionHeading>
        <TaskList tasks={todayTasks} emptyMessage={todayEmptyMessage} />
      </section>
    </div>
  );
}

function UpcomingPanel({ filterState }: { filterState: FilterState }) {
  const { data, isLoading } = useAgendaWeek();

  if (isLoading) {
    return <LoadingIndicator />;
  }

  const rawDays = data?.days ?? [];

  if (rawDays.length === 0) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        No upcoming tasks this week.
      </p>
    );
  }

  const filteredDays = rawDays
    .map((day) => ({
      ...day,
      tasks: applyClientFilter(day.tasks, filterState, AGENDA_FILTER_CONFIG),
    }))
    .filter((day) => day.tasks.length > 0);

  if (filteredDays.length === 0) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        No tasks match the filter.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {filteredDays.map((day) => (
        <section key={day.date}>
          <SectionHeading>{formatWeekDate(day.date)}</SectionHeading>
          <TaskList tasks={day.tasks} emptyMessage="No tasks." />
        </section>
      ))}
    </div>
  );
}

function InboxPanel({ filterState }: { filterState: FilterState }) {
  const params = useMemo(() => ({ has_no_date: true, status: "todo" }), []);
  const { data, isLoading } = useTasks(params);

  if (isLoading) {
    return <LoadingIndicator />;
  }

  const rawTasks = data?.tasks ?? [];
  const tasks = applyClientFilter(rawTasks, filterState, AGENDA_FILTER_CONFIG);
  const emptyMessage =
    rawTasks.length > 0 && tasks.length === 0
      ? "No tasks match the filter."
      : "No undated tasks in inbox.";

  return (
    <div>
      <SectionHeading>Undated Tasks</SectionHeading>
      <TaskList tasks={tasks} emptyMessage={emptyMessage} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function LoadingIndicator() {
  return <p className="py-4 text-xs text-muted-foreground">Loading...</p>;
}

/** Format YYYY-MM-DD as a readable weekday + date label. */
function formatWeekDate(dateStr: string): string {
  if (dateStr === localDateKey(new Date())) return "Today";

  return parseLocalDate(dateStr).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
