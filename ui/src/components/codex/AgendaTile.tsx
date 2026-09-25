import { useNavigate } from "@tanstack/react-router";
import { Component, type ReactNode } from "react";
import { useTasks, useToggleTaskStatus } from "#/api/tasks";
import { priorityLabel } from "#/components/agenda/AgendaItemList";
import { TaskStatusButton } from "#/components/ui/task-status-button";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** Priority labels arrive in caps ("HIGH"); the Atrium reads sentence case. */
const sentenceCase = (label: string) =>
  label.charAt(0) + label.slice(1).toLowerCase();

import { localDateKey } from "#/lib/time";
import { Section } from "./Section";

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
    <Section
      className={className}
      label="Outstanding agenda"
      caption={total === undefined ? undefined : `${total} outstanding`}
      action={
        <button
          type="button"
          onClick={() => navigate({ to: "/agenda" })}
          aria-label="Open the full agenda"
          className={cn(
            "cursor-pointer rounded-sm text-[14px] text-accent hover:underline",
            FOCUS_RING_NATIVE,
          )}
        >
          Agenda →
        </button>
      }
    >
      {children}
    </Section>
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
  const openTab = useOpenTab();

  if (query.isLoading) {
    return (
      <AgendaFrame className={className}>
        <p role="status" className="m-0 py-2 text-[14px] text-mute">
          Loading agenda…
        </p>
      </AgendaFrame>
    );
  }

  if (query.isError) {
    return (
      <AgendaFrame className={className}>
        <p role="alert" className="m-0 py-2 text-[14px] text-hot">
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
        <p className="m-0 py-2 text-[14px] text-mute">No outstanding tasks.</p>
      ) : (
        <ul className="flex flex-col gap-[18px]">
          {tasks.map((task) => {
            const due = task.properties.due;
            const priority = task.properties.priority;
            const overdue = due ? due < localDateKey(new Date()) : false;
            const source = task.page_title ?? task.page_path;
            const parent = task.parent_content;

            return (
              <li
                key={`${task.page_path}:${task.span_start}`}
                className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-start gap-3"
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

                <div
                  className={cn(
                    "flex min-w-0 flex-col gap-1",
                    parent && "pl-2.5",
                  )}
                >
                  {/* The agenda orders rows by date and priority across every
                      page, so a nested Todo arrives without its parent. The
                      parent line travels with the row instead: the indent
                      shows there is one, this says which. */}
                  {parent ? (
                    <span
                      data-testid="agenda-row-parent"
                      title={parent}
                      className="block truncate text-[12.5px] text-mute"
                    >
                      <span aria-hidden>↳ </span>
                      {parent}
                    </span>
                  ) : null}
                  <span
                    title={task.content}
                    className="block truncate text-[15.5px] leading-[1.4] text-ink"
                  >
                    {task.content}
                  </span>
                  <div className="flex min-w-0 items-center gap-2.5 text-[12.5px] text-mute">
                    {due ? (
                      <>
                        <span
                          className={cn("tabular-nums", overdue && "text-hot")}
                        >
                          {due}
                        </span>
                        {overdue ? (
                          <span className="font-medium text-hot">Overdue</span>
                        ) : null}
                      </>
                    ) : null}
                    {priority ? (
                      <span>{sentenceCase(priorityLabel(priority))}</span>
                    ) : null}
                    {/* The row names a Todo written on a page; the source is
                        the only way back to the line's context, so it opens
                        the Folio the way the full agenda's rows do. */}
                    <button
                      type="button"
                      aria-label={`Open ${source}`}
                      onClick={() => openTab("page", task.page_path, source)}
                      className={cn(
                        "min-w-0 cursor-pointer truncate rounded-sm text-left text-mute underline decoration-faint underline-offset-2 hover:text-accent",
                        FOCUS_RING_NATIVE,
                      )}
                    >
                      {source}
                    </button>
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
          <p role="alert" className="m-0 py-2 text-[14px] text-hot">
            Agenda unavailable.
          </p>
        </AgendaFrame>
      }
    >
      <AgendaTileContent className={className} />
    </AgendaErrorBoundary>
  );
}
