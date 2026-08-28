import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import type { AgendaItem, AgendaResponse } from "#/api/tasks";
import { useAgenda } from "#/api/tasks";
import { AgendaItemList } from "#/components/agenda/AgendaItemList";
import { FilterBar } from "#/components/filters/FilterBar";
import {
  PRI_LABEL,
  PRI_ORDER,
  taskStatusLabel,
} from "#/components/tasking/board-constants";
import { SectionHeading } from "#/components/ui/section-heading";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
import {
  type FilterField,
  type FilterState,
  isFilterActive,
} from "#/lib/filters/model";
import {
  canonicalizeFilterSearch,
  type FilterUrlOptions,
  mergeFilterSearch,
  parseFilterSearch,
  shouldReplaceFilterHistory,
} from "#/lib/filters/url";
import { localDateKey, parseLocalDate } from "#/lib/time";
import { useProjectValues } from "#/lib/useProjects";

const AGENDA_ROUTE_PATH = "/agenda" as const;

/** Route-level filter field specs for the Agenda's URL-backed filter. */
export const AGENDA_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "type", kind: "single" },
    { id: "todoStatus", kind: "single" },
    { id: "todoPriority", kind: "single", normalize: (v) => v.toUpperCase() },
    { id: "taskStatus", kind: "single", normalize: (v) => v.toUpperCase() },
    { id: "taskPriority", kind: "single", normalize: (v) => v.toUpperCase() },
    { id: "project", kind: "single" },
    { id: "blocked", kind: "flag" },
  ],
};

export function agendaFilterNavigation(
  next: FilterState,
  previous: FilterState,
) {
  return {
    to: AGENDA_ROUTE_PATH,
    search: <TSearch extends Record<string, unknown>>(current: TSearch) =>
      mergeFilterSearch(current, next, AGENDA_FILTER_URL),
    replace: shouldReplaceFilterHistory(next, previous),
  };
}

const TODO_STATUS_VALUES = ["open", "doing"] as const;
const TODO_PRIORITY_VALUES = ["A", "B", "C"] as const;
const TASK_STATUS_VALUES = ["INTAKE", "TRIAGE", "FIELD", "REVIEW"] as const;
const TODO_PRIORITY_LABELS = {
  A: "High",
  B: "Medium",
  C: "Low",
} as const;
const FILTERED_EMPTY_MESSAGE = "No items match the filter.";

interface AgendaQueryState {
  data: AgendaResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

export const Route = createFileRoute("/agenda")({
  staticData: { codexView: "agenda" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    canonicalizeFilterSearch(search, AGENDA_FILTER_URL),
  component: AgendaPage,
});

function AgendaPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const today = localDateKey(new Date());
  const agenda = useAgenda(today);

  const filterState = useMemo(
    () => parseFilterSearch(search, AGENDA_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate(agendaFilterNavigation(next, filterState));
    },
    [navigate, filterState],
  );

  return (
    <AgendaScreen
      agenda={agenda}
      filterState={filterState}
      onFilterChange={onFilterChange}
    />
  );
}

/** Pure source-aware predicate shared by all Agenda panels. */
export function matchesAgendaFilter(
  item: AgendaItem,
  filterState: FilterState,
): boolean {
  const type = filterState.facets.type ?? [];
  if (type.length > 0 && !type.includes(item.kind)) return false;

  const todoStatus = filterState.facets.todoStatus ?? [];
  const todoPriority = filterState.facets.todoPriority ?? [];
  const taskStatus = filterState.facets.taskStatus ?? [];
  const taskPriority = filterState.facets.taskPriority ?? [];
  const project = filterState.facets.project ?? [];
  const blocked = filterState.facets.blocked ?? [];
  const hasTodoFacet = todoStatus.length > 0 || todoPriority.length > 0;
  const hasTaskFacet =
    taskStatus.length > 0 ||
    taskPriority.length > 0 ||
    project.length > 0 ||
    blocked.length > 0;

  let textHay: string;
  if (item.kind === "todo") {
    if (hasTaskFacet) return false;
    const displayStatus = item.status === "todo" ? "open" : item.status;
    if (todoStatus.length > 0 && !todoStatus.includes(displayStatus)) {
      return false;
    }
    const priority = item.properties.priority?.toUpperCase();
    if (
      todoPriority.length > 0 &&
      (!priority || !todoPriority.includes(priority))
    ) {
      return false;
    }
    textHay = `${item.content}\n${item.page_title ?? ""}\n${item.page_path}`;
  } else {
    if (hasTodoFacet) return false;
    if (
      taskStatus.length > 0 &&
      !taskStatus.includes(item.status.toUpperCase())
    ) {
      return false;
    }
    if (
      taskPriority.length > 0 &&
      !taskPriority.includes(item.priority.toUpperCase())
    ) {
      return false;
    }
    if (
      project.length > 0 &&
      (!item.project || !project.includes(item.project))
    ) {
      return false;
    }
    if (blocked.length > 0 && !item.hold?.trim()) return false;
    textHay = `${item.title}\n${item.path}`;
  }

  const query = filterState.text.trim().toLowerCase();
  return query === "" || textHay.toLowerCase().includes(query);
}

export function AgendaScreen({
  agenda,
  filterState,
  onFilterChange,
}: {
  agenda: AgendaQueryState;
  filterState: FilterState;
  onFilterChange: (next: FilterState) => void;
}) {
  const projects = useProjectValues();

  const filterFields: FilterField[] = useMemo(
    () => [
      {
        id: "type",
        kind: "single",
        label: "TYPE",
        options: [
          { value: "todo", label: "Todo" },
          { value: "task", label: "Task" },
        ],
      },
      {
        id: "todoStatus",
        kind: "single",
        label: "TODO STATUS",
        options: TODO_STATUS_VALUES.map((value) => ({
          value,
          label: value === "open" ? "Open" : "Doing",
        })),
      },
      {
        id: "todoPriority",
        kind: "single",
        label: "TODO PRIORITY",
        options: TODO_PRIORITY_VALUES.map((value) => ({
          value,
          label: `${TODO_PRIORITY_LABELS[value]} (${value})`,
        })),
      },
      {
        id: "taskStatus",
        kind: "single",
        label: "TASK STATUS",
        options: TASK_STATUS_VALUES.map((value) => ({
          value,
          label: taskStatusLabel(value),
        })),
      },
      {
        id: "taskPriority",
        kind: "single",
        label: "TASK PRIORITY",
        options: PRI_ORDER.map((value) => ({
          value,
          label: `${PRI_LABEL[value]} (${value})`,
        })),
      },
      {
        id: "project",
        kind: "single",
        label: "PROJECT",
        options: projects.map((value) => ({ value })),
      },
      {
        id: "blocked",
        kind: "flag",
        label: "BLOCKED",
        options: [],
      },
    ],
    [projects],
  );

  const filtered = useMemo(() => {
    const data = agenda.data;
    if (!data) return null;
    const apply = (items: readonly AgendaItem[]) =>
      items.filter((item) => matchesAgendaFilter(item, filterState));
    return {
      overdue: apply(data.overdue),
      today: apply(data.today),
      upcoming: data.upcoming
        .map((day) => ({ ...day, items: apply(day.items) }))
        .filter((day) => day.items.length > 0),
      undated: apply(data.undated),
    };
  }, [agenda.data, filterState]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2">
        <h1 className="font-heading text-lg font-bold">Agenda</h1>
        <FilterBar
          fields={filterFields}
          state={filterState}
          onChange={onFilterChange}
          textPlaceholder="Filter Agenda…"
          className="mt-2"
        />
      </div>

      {agenda.isLoading ? (
        <p role="status" className="px-8 py-6 text-xs text-muted-foreground">
          Loading Agenda…
        </p>
      ) : agenda.isError || !agenda.data || !filtered ? (
        <p role="alert" className="px-8 py-6 text-xs text-muted-foreground">
          Couldn’t load Agenda.
        </p>
      ) : (
        <AgendaTabs
          data={agenda.data}
          filtered={filtered}
          filterActive={isFilterActive(filterState)}
        />
      )}
    </div>
  );
}

function AgendaTabs({
  data,
  filtered,
  filterActive,
}: {
  data: AgendaResponse;
  filtered: {
    overdue: AgendaItem[];
    today: AgendaItem[];
    upcoming: { date: string; items: AgendaItem[] }[];
    undated: AgendaItem[];
  };
  filterActive: boolean;
}) {
  const emptyMessage = (
    sourceCount: number,
    filteredCount: number,
    sourceEmpty: string,
  ) =>
    filterActive && sourceCount > 0 && filteredCount === 0
      ? FILTERED_EMPTY_MESSAGE
      : sourceEmpty;
  const undatedSourceCount = data.undated.filter(
    (item) => item.kind === "todo",
  ).length;
  const upcomingSourceCount = data.upcoming.reduce(
    (count, day) => count + day.items.length,
    0,
  );
  const upcomingFilteredCount = filtered.upcoming.reduce(
    (count, day) => count + day.items.length,
    0,
  );

  return (
    <Tabs defaultSelectedKey="today" className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-2">
        <TabList aria-label="Agenda sections">
          <Tab id="today">Today</Tab>
          <Tab id="upcoming">Upcoming</Tab>
          <Tab id="undated">Undated</Tab>
        </TabList>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <TabPanel id="today">
            <div className="space-y-6">
              <section>
                <SectionHeading>Overdue</SectionHeading>
                <AgendaItemList
                  items={filtered.overdue}
                  emptyMessage={emptyMessage(
                    data.overdue.length,
                    filtered.overdue.length,
                    "No overdue items.",
                  )}
                />
              </section>
              <section>
                <SectionHeading>Due Today</SectionHeading>
                <AgendaItemList
                  items={filtered.today}
                  emptyMessage={emptyMessage(
                    data.today.length,
                    filtered.today.length,
                    "Nothing due today.",
                  )}
                />
              </section>
            </div>
          </TabPanel>
          <TabPanel id="upcoming">
            {filtered.upcoming.length === 0 ? (
              <p className="py-4 text-xs text-muted-foreground">
                {filterActive &&
                upcomingSourceCount > 0 &&
                upcomingFilteredCount === 0
                  ? FILTERED_EMPTY_MESSAGE
                  : "No upcoming items."}
              </p>
            ) : (
              <div className="space-y-6">
                {filtered.upcoming.map((day) => (
                  <section key={day.date}>
                    <SectionHeading>
                      {formatAgendaDate(day.date)}
                    </SectionHeading>
                    <AgendaItemList items={day.items} />
                  </section>
                ))}
              </div>
            )}
          </TabPanel>
          <TabPanel id="undated">
            <section>
              <SectionHeading>Undated Todos</SectionHeading>
              <AgendaItemList
                items={filtered.undated}
                emptyMessage={emptyMessage(
                  undatedSourceCount,
                  filtered.undated.length,
                  "No undated Todos.",
                )}
              />
            </section>
          </TabPanel>
        </div>
      </div>
    </Tabs>
  );
}

/** Format a YYYY-MM-DD calendar key without applying a UTC offset. */
function formatAgendaDate(date: string): string {
  return parseLocalDate(date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
