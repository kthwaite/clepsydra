import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import type { AgendaItem, AgendaResponse } from "#/api/tasks";
import { useAgenda } from "#/api/tasks";
import { AgendaItemList } from "#/components/agenda/AgendaItemList";
import { FilterBar } from "#/components/filters/FilterBar";
import { MobileAgenda } from "#/components/mobile/MobileAgenda";
import {
  PRI_LABEL,
  PRI_ORDER,
  taskStatusLabel,
} from "#/components/tasking/board-constants";
import { SectionHeading } from "#/components/ui/section-heading";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { type FilterState, isFilterActive } from "#/lib/filters/model";
import {
  defineFilterRoute,
  type FacetDef,
  facetFields,
  useFilterRoute,
} from "#/lib/filters/route";
import { formatDayMonth, localDateKey, parseLocalDate } from "#/lib/time";
import { useProjectValues } from "#/lib/useProjects";

const TODO_STATUS_VALUES = ["open", "doing"] as const;
const TODO_PRIORITY_VALUES = ["A", "B", "C"] as const;
const TASK_STATUS_VALUES = ["INTAKE", "TRIAGE", "FIELD", "REVIEW"] as const;
const TODO_PRIORITY_LABELS = {
  A: "High",
  B: "Medium",
  C: "Low",
} as const;
const upper = (v: string) => v.toUpperCase();

/** The Agenda's facets: one list for its URL and its FilterBar. Project
 *  options come from the vault at render. */
export const AGENDA_FACETS: readonly FacetDef[] = [
  {
    id: "type",
    kind: "single",
    label: "Type",
    options: [
      { value: "todo", label: "Todo" },
      { value: "task", label: "Task" },
    ],
  },
  {
    id: "todoStatus",
    kind: "single",
    label: "Todo status",
    options: TODO_STATUS_VALUES.map((value) => ({
      value,
      label: value === "open" ? "Open" : "Doing",
    })),
  },
  {
    id: "todoPriority",
    kind: "single",
    label: "Todo priority",
    normalize: upper,
    options: TODO_PRIORITY_VALUES.map((value) => ({
      value,
      label: `${TODO_PRIORITY_LABELS[value]} (${value})`,
    })),
  },
  {
    id: "taskStatus",
    kind: "single",
    label: "Task status",
    normalize: upper,
    options: TASK_STATUS_VALUES.map((value) => ({
      value,
      label: taskStatusLabel(value),
    })),
  },
  {
    id: "taskPriority",
    kind: "single",
    label: "Task priority",
    normalize: upper,
    options: PRI_ORDER.map((value) => ({
      value,
      label: `${PRI_LABEL[value]} (${value})`,
    })),
  },
  { id: "project", kind: "single", label: "Project" },
  { id: "blocked", kind: "flag", label: "Blocked" },
];

/** The Agenda's URL-backed filter. */
export const AGENDA_FILTER = defineFilterRoute({
  to: "/agenda",
  facets: AGENDA_FACETS,
});

const FILTERED_EMPTY_MESSAGE = "No items match the filter.";

interface AgendaQueryState {
  data: AgendaResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

export const Route = createFileRoute("/agenda")({
  staticData: { codexView: "agenda" },
  validateSearch: AGENDA_FILTER.validateSearch,
  component: AgendaPage,
});

function AgendaPage() {
  const { filterState, onFilterChange } = useFilterRoute(
    AGENDA_FILTER,
    Route.useSearch(),
  );
  const today = localDateKey(new Date());
  const agenda = useAgenda(today);
  const mobile = useMobileLayout();

  if (mobile) return <MobileAgenda agenda={agenda} today={today} />;

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

  const filterFields = useMemo(
    () =>
      facetFields(AGENDA_FACETS, {
        project: projects.map((value) => ({ value })),
      }),
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
      <header className="flex flex-col gap-4 px-4 pt-8 md:px-10 md:pt-10">
        <h1 className="m-0 font-serif text-[40px] font-normal leading-none tracking-[-0.015em] text-ink md:text-[56px]">
          Agenda
        </h1>
        <FilterBar
          fields={filterFields}
          primaryFieldIds={["type", "todoStatus", "taskStatus"]}
          state={filterState}
          onChange={onFilterChange}
          textPlaceholder="Filter Agenda…"
        />
      </header>

      {agenda.isLoading ? (
        <p role="status" className="px-4 py-6 text-[14px] text-mute md:px-10">
          Loading Agenda…
        </p>
      ) : agenda.isError || !agenda.data || !filtered ? (
        <p role="alert" className="px-4 py-6 text-[14px] text-hot md:px-10">
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
      <div className="px-4 pt-5 pb-2 md:px-10">
        <TabList aria-label="Agenda sections">
          <Tab id="today">Today</Tab>
          <Tab id="upcoming">Upcoming</Tab>
          <Tab id="undated">Undated</Tab>
        </TabList>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
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
                <SectionHeading>Due today</SectionHeading>
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
              <p className="m-0 py-2 text-[14px] text-mute">
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Format a YYYY-MM-DD calendar key ("Tue 1 Sep") without applying a UTC
 *  offset, with fixed weekday and month names. */
function formatAgendaDate(date: string): string {
  return `${WEEKDAYS[parseLocalDate(date).getDay()]} ${formatDayMonth(date)}`;
}
