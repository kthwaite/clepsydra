import { Check, Circle, Loader2, X } from "lucide-react";
import type { TaskItem } from "#/api/tasks";
import { useToggleTaskStatus } from "#/api/tasks";
import { useOpenTab } from "#/hooks/useOpenTab";

const STATUS_ICONS: Record<string, typeof Circle> = {
  todo: Circle,
  doing: Loader2,
  done: Check,
  cancelled: X,
};

function nextStatus(current: string): string {
  switch (current) {
    case "todo":
      return "done";
    case "doing":
      return "done";
    case "done":
      return "todo";
    case "cancelled":
      return "todo";
    default:
      return "done";
  }
}

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
        const Icon = STATUS_ICONS[task.status] ?? Circle;
        const due = task.properties.due;
        const priority = task.properties.priority;

        return (
          <li
            key={`${task.page_path}:${task.span_start}`}
            className="flex items-start gap-2 px-2 py-2"
          >
            <button
              type="button"
              onClick={() =>
                toggle.mutate({
                  pagePath: task.page_path,
                  spanStart: task.span_start,
                  status: nextStatus(task.status),
                })
              }
              disabled={toggle.isPending}
              className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              aria-label={`Mark task ${nextStatus(task.status)}`}
            >
              <Icon className="h-3 w-3" />
            </button>

            <div className="min-w-0 flex-1">
              <span
                className={`text-sm ${isDone ? "text-muted-foreground line-through" : "text-foreground"}`}
              >
                {task.content}
              </span>

              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {due && (
                  <span className="border border-border px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {due}
                  </span>
                )}
                {priority && (
                  <span className="border border-border px-1 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {priorityLabel(priority)}
                  </span>
                )}
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
