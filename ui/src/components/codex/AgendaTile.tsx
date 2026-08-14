import { useNavigate } from "@tanstack/react-router";
import { Component, type ReactNode } from "react";
import { useTasks, useToggleTaskStatus } from "#/api/tasks";
import { priorityLabel } from "#/components/TaskList";
import { TaskStatusButton } from "#/components/ui/task-status-button";
import { cn } from "#/lib/cn";
import { localDateKey } from "#/lib/time";
import { Card } from "./Card";

const AGENDA_FILTERS = { status: "todo", sort: "agenda", limit: 8 } as const;
const MAX_ROWS = 8;

interface AgendaTileProps {
  className?: string;
}

interface AgendaFrameProps extends AgendaTileProps {
  children: ReactNode;
  total?: number;
}

function AgendaFrame({ children, className, total }: AgendaFrameProps) {
  const navigate = useNavigate();

  return (
    <Card
      className={className}
      label="Outstanding agenda"
      caption={total === undefined ? undefined : `${total} outstanding`}
      action={
        <button
          type="button"
          onClick={() => navigate({ to: "/agenda" })}
          aria-label="Open the full agenda"
          className="cl-mono border-l border-rule pl-2.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          Agenda →
        </button>
      }
      tight
    >
      {children}
    </Card>
  );
}

interface AgendaErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

class AgendaErrorBoundary extends Component<
  AgendaErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function AgendaTileContent({ className }: AgendaTileProps) {
  const query = useTasks(AGENDA_FILTERS);
  const toggle = useToggleTaskStatus();

  if (query.isLoading) {
    return (
      <AgendaFrame className={className}>
        <p role="status" className="cl-marg m-0 px-3 py-4">
          Loading agenda…
        </p>
      </AgendaFrame>
    );
  }

  if (query.isError) {
    return (
      <AgendaFrame className={className}>
        <p role="alert" className="cl-marg m-0 px-3 py-4 text-warn">
          Agenda unavailable.
        </p>
      </AgendaFrame>
    );
  }

  const tasks = query.data?.tasks.slice(0, MAX_ROWS) ?? [];
  const total = query.data?.total ?? 0;

  return (
    <AgendaFrame className={className} total={total}>
      {tasks.length === 0 ? (
        <p className="cl-marg m-0 px-3 py-4">No outstanding tasks.</p>
      ) : (
        <ul className="divide-y divide-rule">
          {tasks.map((task) => {
            const due = task.properties.due;
            const priority = task.properties.priority;
            const overdue = due
              ? due < localDateKey(new Date())
              : false;

            return (
              <li
                key={`${task.page_path}:${task.span_start}`}
                className="flex min-w-0 items-start gap-2 px-3 py-2"
              >
                <TaskStatusButton
                  status={task.status}
                  onToggle={() =>
                    toggle.mutate({
                      pagePath: task.page_path,
                      spanStart: task.span_start,
                      status: "done",
                    })
                  }
                  isDisabled={toggle.isPending}
                />

                <div className="min-w-0 flex-1">
                  <span
                    title={task.content}
                    className="cl-mono block truncate text-[11px] text-ink"
                  >
                    {task.content}
                  </span>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                    {due ? (
                      <>
                        <span
                          className={cn(
                            "cl-mono text-[9px] tabular-nums",
                            overdue ? "text-warn" : "text-ink-mute",
                          )}
                        >
                          {due}
                        </span>
                        {overdue ? (
                          <span className="cl-mono text-[9px] font-medium text-warn">
                            OVERDUE
                          </span>
                        ) : null}
                      </>
                    ) : null}
                    {priority ? (
                      <span className="cl-mono text-[9px] text-ink-mute">
                        {priorityLabel(priority)}
                      </span>
                    ) : null}
                    <span className="cl-mono min-w-0 truncate text-[9px] text-ink-mute">
                      {task.page_title ?? task.page_path}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AgendaFrame>
  );
}

export function AgendaTile({ className }: AgendaTileProps) {
  return (
    <AgendaErrorBoundary
      fallback={
        <AgendaFrame className={className}>
          <p role="alert" className="cl-marg m-0 px-3 py-4 text-warn">
            Agenda unavailable.
          </p>
        </AgendaFrame>
      }
    >
      <AgendaTileContent className={className} />
    </AgendaErrorBoundary>
  );
}
