import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  useAgendaOverdue,
  useAgendaToday,
  useAgendaWeek,
  useTasks,
} from "#/api/tasks";
import { TaskList } from "#/components/TaskList";

export const Route = createFileRoute("/agenda")({
  component: AgendaPage,
});

type Tab = "today" | "upcoming" | "inbox";

const TABS: { id: Tab; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "inbox", label: "Inbox" },
];

function AgendaPage() {
  const [activeTab, setActiveTab] = useState<Tab>("today");

  return (
    <div className="flex h-full flex-col">
      {/* Header + tab bar */}
      <div className="border-b border-border px-4 py-2">
        <h1 className="font-heading text-lg font-bold">Agenda</h1>
        <nav className="mt-2 flex gap-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`pb-1 text-xs uppercase tracking-wider ${
                activeTab === tab.id
                  ? "border-b-2 border-foreground font-bold text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          {activeTab === "today" && <TodayPanel />}
          {activeTab === "upcoming" && <UpcomingPanel />}
          {activeTab === "inbox" && <InboxPanel />}
        </div>
      </div>
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
      {children}
    </h2>
  );
}

function LoadingIndicator() {
  return <p className="py-4 text-xs text-muted-foreground">Loading...</p>;
}

/** Format YYYY-MM-DD as a readable weekday + date label. */
function formatWeekDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  if (dateStr === todayStr) return "Today";

  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
