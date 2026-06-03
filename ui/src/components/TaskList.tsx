import type { TaskItem } from "#/api/tasks";
import { useToggleTaskStatus } from "#/api/tasks";
import { Badge } from "#/components/ui/badge";
import {
  nextStatus,
  TaskStatusButton,
} from "#/components/ui/task-status-button";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";

function priorityLabel(p: string): string {
  switch (p) {
    case "A":
      return "HIGH";
    case "B":
      return "MED";
    case "C":
      return "LOW";
    default:
      return p.toUpperCase();
  }
}

interface TaskListProps {
  tasks: TaskItem[];
  emptyMessage?: string;
}

export function TaskList({ tasks, emptyMessage = "No tasks." }: TaskListProps) {
  const toggle = useToggleTaskStatus();
  const openTab = useOpenTab();

  if (tasks.length === 0) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">{emptyMessage}</p>
    );
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {tasks.map((task) => {
        const isDone = task.status === "done" || task.status === "cancelled";
        const due = task.properties.due;
        const priority = task.properties.priority;

        return (
          <li
            key={`${task.page_path}:${task.span_start}`}
            className="flex items-start gap-2 px-2 py-2"
          >
            <TaskStatusButton
              status={task.status}
              onToggle={() =>
                toggle.mutate({
                  pagePath: task.page_path,
                  spanStart: task.span_start,
                  status: nextStatus(task.status),
                })
              }
              isDisabled={toggle.isPending}
            />

            <div className="min-w-0 flex-1">
              <span
                className={cn(
                  "text-sm",
                  isDone
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                {task.content}
              </span>

              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {due && <Badge size="sm">{due}</Badge>}
                {priority && <Badge size="sm">{priorityLabel(priority)}</Badge>}
                <button
                  type="button"
                  onClick={() => openTab("page", task.page_path)}
                  className="text-[10px] text-muted-foreground underline decoration-border hover:text-foreground"
                >
                  {task.page_title ?? task.page_path}
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
