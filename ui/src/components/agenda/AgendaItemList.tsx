import { usePatchTask } from "#/api/board";
import type { AgendaItem, AgendaTask, AgendaTodo } from "#/api/tasks";
import { useToggleTaskStatus } from "#/api/tasks";
import {
  COL_ORDER,
  PRI_LABEL,
  taskStatusLabel,
} from "#/components/tasking/board-constants";
import { Badge } from "#/components/ui/badge";
import { Select, SelectItem } from "#/components/ui/select";
import {
  nextStatus,
  TaskStatusButton,
} from "#/components/ui/task-status-button";
import { useOpenTab } from "#/hooks/useOpenTab";

export function priorityLabel(priority: string): string {
  switch (priority.toUpperCase()) {
    case "A":
      return "HIGH";
    case "B":
      return "MED";
    case "C":
      return "LOW";
    default:
      return priority.toUpperCase();
  }
}

function AgendaTodoRow({ todo }: { todo: AgendaTodo }) {
  const toggle = useToggleTaskStatus();
  const openTab = useOpenTab();
  const due = todo.properties.due;
  const priority = todo.properties.priority;
  const next = nextStatus(todo.status);
  const source = todo.page_title ?? todo.page_path;

  return (
    <li className="flex items-start gap-2 px-2 py-2">
      <TaskStatusButton
        status={todo.status}
        onToggle={() =>
          toggle.mutate({
            pagePath: todo.page_path,
            spanStart: todo.span_start,
            status: next,
          })
        }
        isDisabled={toggle.isPending}
        accessibleLabel={`Mark Todo ${next}: ${todo.content} (${source})`}
      />

      <div className="min-w-0 flex-1">
        <span className="text-sm text-foreground">{todo.content}</span>

        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {due && <Badge size="sm">{due}</Badge>}
          {priority && <Badge size="sm">{priority.toUpperCase()}</Badge>}
          <button
            type="button"
            onClick={() => openTab("page", todo.page_path)}
            className="text-[10px] text-muted-foreground underline decoration-border hover:text-foreground"
          >
            {source}
          </button>
        </div>
      </div>
    </li>
  );
}

function AgendaTaskRow({ task }: { task: AgendaTask }) {
  const patch = usePatchTask();
  const openTab = useOpenTab();
  const taskPriorityLabel = PRI_LABEL[task.priority];

  return (
    <li className="flex items-start gap-2 px-2 py-2">
      <Select
        aria-label={`Status for ${task.code}: ${task.title}`}
        selectedKey={task.status}
        onSelectionChange={(status) => {
          if (status === null) return;
          patch.mutate({
            id: task.id,
            patch: { status: String(status) },
          });
        }}
        isDisabled={patch.isPending}
        className="w-36 shrink-0"
      >
        {COL_ORDER.map((status) => (
          <SelectItem key={status} id={status}>
            {taskStatusLabel(status)}
          </SelectItem>
        ))}
      </Select>

      <div className="min-w-0 flex-1">
        <span className="text-sm text-foreground">{task.title}</span>

        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <Badge size="sm">{task.code}</Badge>
          {task.due && <Badge size="sm">{task.due}</Badge>}
          <Badge size="sm">
            {task.priority}
            {taskPriorityLabel ? ` ${taskPriorityLabel}` : ""}
          </Badge>
          {task.project && <Badge size="sm">{task.project}</Badge>}
          {task.hold?.trim() && <Badge size="sm">Blocked</Badge>}
          <button
            type="button"
            onClick={() => openTab("page", task.path)}
            className="text-[10px] text-muted-foreground underline decoration-border hover:text-foreground"
          >
            {task.path}
          </button>
        </div>
      </div>
    </li>
  );
}

export function AgendaItemList({
  items,
  emptyMessage = "No items.",
}: {
  items: AgendaItem[];
  emptyMessage?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">{emptyMessage}</p>
    );
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((item) =>
        item.kind === "todo" ? (
          <AgendaTodoRow
            key={`${item.page_path}:${item.span_start}`}
            todo={item}
          />
        ) : (
          <AgendaTaskRow key={item.id} task={item} />
        ),
      )}
    </ul>
  );
}
