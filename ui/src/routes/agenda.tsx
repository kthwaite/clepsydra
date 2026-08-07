import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  useAgendaOverdue,
  useAgendaToday,
  useAgendaWeek,
  useTasks,
} from "#/api/tasks";
import { TaskList } from "#/components/TaskList";
import { SectionHeading } from "#/components/ui/section-heading";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
import { localDateKey, parseLocalDate } from "#/lib/time";

export const Route = createFileRoute("/agenda")({
  component: AgendaPage,
});

function AgendaPage() {
  return (
    <div className="flex h-full flex-col">
      <Tabs defaultSelectedKey="today" className="flex h-full flex-col">
        <div className="border-b border-border px-4 py-2">
          <h1 className="font-heading text-lg font-bold">Agenda</h1>
          <TabList aria-label="Agenda sections" className="mt-2">
            <Tab id="today">Today</Tab>
            <Tab id="upcoming">Upcoming</Tab>
            <Tab id="inbox">Inbox</Tab>
          </TabList>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-6">
            <TabPanel id="today">
              <TodayPanel />
            </TabPanel>
            <TabPanel id="upcoming">
              <UpcomingPanel />
            </TabPanel>
            <TabPanel id="inbox">
              <InboxPanel />
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

function TodayPanel() {
  const { data: todayData, isLoading: todayLoading } = useAgendaToday();
  const { data: overdueData, isLoading: overdueLoading } = useAgendaOverdue();

  if (todayLoading || overdueLoading) {
    return <LoadingIndicator />;
  }

  const overdueTasks = overdueData?.tasks ?? [];
  const todayTasks = todayData?.tasks ?? [];

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
        <TaskList tasks={todayTasks} emptyMessage="Nothing due today." />
      </section>
    </div>
  );
}

function UpcomingPanel() {
  const { data, isLoading } = useAgendaWeek();

  if (isLoading) {
    return <LoadingIndicator />;
  }

  const days = data?.days ?? [];

  if (days.length === 0) {
    return (
      <p className="py-4 text-xs text-muted-foreground">
        No upcoming tasks this week.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.date}>
          <SectionHeading>{formatWeekDate(day.date)}</SectionHeading>
          <TaskList tasks={day.tasks} emptyMessage="No tasks." />
        </section>
      ))}
    </div>
  );
}

function InboxPanel() {
  const params = useMemo(() => ({ has_no_date: "true", status: "todo" }), []);
  const { data, isLoading } = useTasks(params);

  if (isLoading) {
    return <LoadingIndicator />;
  }

  return (
    <div>
      <SectionHeading>Undated Tasks</SectionHeading>
      <TaskList
        tasks={data?.tasks ?? []}
        emptyMessage="No undated tasks in inbox."
      />
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
