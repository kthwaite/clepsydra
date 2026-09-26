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
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** The source link under each row: mute, underlined in faint, cobalt on
 *  hover — the Atrium AgendaTile's idiom. */
const SOURCE_LINK = cn(
  "min-w-0 cursor-pointer truncate rounded-sm text-left text-mute underline decoration-faint underline-offset-2 hover:text-accent",
  FOCUS_RING_NATIVE,
);
const ROW = "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3";
const TITLE = "block text-[15.5px] leading-[1.4] text-ink";
const META =
  "mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-mute";

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
    <li className={ROW}>
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
        <span className={TITLE}>{todo.content}</span>

        <div className={META}>
          {due && <span className="tabular-nums">{due}</span>}
          {priority && <Badge size="sm">{priority.toUpperCase()}</Badge>}
          <button
            type="button"
            onClick={() => openTab("page", todo.page_path)}
            className={SOURCE_LINK}
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
    <li className={ROW}>
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
        <span className={TITLE}>{task.title}</span>

        <div className={META}>
          <Badge size="sm">{task.code}</Badge>
          {task.due && <span className="tabular-nums">{task.due}</span>}
          <Badge size="sm">
            {task.priority}
            {taskPriorityLabel ? ` ${taskPriorityLabel}` : ""}
          </Badge>
          {task.project && <Badge size="sm">{task.project}</Badge>}
          {task.hold?.trim() && <Badge size="sm">Blocked</Badge>}
          <button
            type="button"
            onClick={() => openTab("page", task.path)}
            className={SOURCE_LINK}
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
    return <p className="m-0 py-2 text-[14px] text-mute">{emptyMessage}</p>;
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-[18px] p-0">
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
