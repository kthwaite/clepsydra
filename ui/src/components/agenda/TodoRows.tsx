import { usePatchTask } from "#/api/board";
import { useToggleTaskStatus } from "#/api/tasks";
import {
  COL_ORDER,
  isDone,
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

// The Agenda's row idiom, shared with the Calendar's day panel: a status
// control, the title, then a meta line ending in the source link.

/** The source link under each row: mute, underlined in faint, cobalt on
 *  hover — the Atrium AgendaTile's idiom. */
const SOURCE_LINK = cn(
  "min-w-0 cursor-pointer truncate rounded-sm text-left text-mute underline decoration-faint underline-offset-2 hover:text-accent",
  FOCUS_RING_NATIVE,
);
const ROW = "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3";
const TITLE = "block text-[15.5px] leading-[1.4]";
/** Done rows are struck through and dimmed. */
const titleClass = (done: boolean) =>
  cn(TITLE, done ? "text-mute line-through" : "text-ink");
const META =
  "mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-mute";

const DONE_TODO: ReadonlySet<string> = new Set(["done", "cancelled"]);

/** A checkbox todo block, wherever it was listed from. */
export interface TodoRowItem {
  content: string;
  status: string;
  page_path: string;
  page_title?: string | null;
  span_start: number;
  /** Omitted where the list is already one day. */
  due?: string | null;
  priority?: string | null;
}

/** A TASK page, wherever it was listed from. */
export interface TaskRowItem {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  project?: string | null;
  /** Omitted where the list is already one day. */
  due?: string | null;
  hold?: string | null;
  path: string;
}

/** A checkbox todo: status toggle, content, due, priority, source link. */
export function TodoRow({ todo }: { todo: TodoRowItem }) {
  const toggle = useToggleTaskStatus();
  const openTab = useOpenTab();
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
        <span className={titleClass(DONE_TODO.has(todo.status))}>
          {todo.content}
        </span>

        <div className={META}>
          {todo.due && <span className="tabular-nums">{todo.due}</span>}
          {todo.priority && (
            <Badge size="sm">{todo.priority.toUpperCase()}</Badge>
          )}
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

/** A TASK page: status select, title, code, due, priority, project, hold,
 *  source link. */
/** `stacked` puts the title first and the status select under it, for
 *  narrow columns such as the Calendar's day panel. */
export function TaskRow({
  task,
  stacked = false,
}: {
  task: TaskRowItem;
  stacked?: boolean;
}) {
  const patch = usePatchTask();
  const openTab = useOpenTab();
  const taskPriorityLabel = PRI_LABEL[task.priority];

  const status = (
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
  );

  return (
    <li className={stacked ? "flex min-w-0 flex-col items-start gap-2" : ROW}>
      {!stacked && status}

      <div className="min-w-0 flex-1">
        <span className={titleClass(isDone(task.status))}>{task.title}</span>

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
      {stacked && status}
    </li>
  );
}
