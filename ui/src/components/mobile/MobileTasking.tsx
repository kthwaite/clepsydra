import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { type BoardTask, useBoard, useCreateTask } from "#/api/board";
import { formatApiError } from "#/api/error";
import {
  type BoardStatus,
  tasksByStatus,
} from "#/components/mobile/mobile-data";
import { BoardProjects } from "#/components/tasking/BoardProjects";
import {
  COL_LABEL,
  COL_ORDER,
  DEFAULT_STATUS,
  fmtCycleWindow,
  isDone,
  isEpic,
  priColor,
  taskStatusLabel,
} from "#/components/tasking/board-constants";
import { TypeChip } from "#/components/tasking/board-presentation";
import { deriveProjectScopes } from "#/components/tasking/board-projects";
import { NewTaskModal } from "#/components/tasking/NewTaskModal";
import { TaskEditPanel } from "#/components/tasking/TaskEditPanel";
import { filterTasks } from "#/components/tasking/TaskingScreen";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
import { useResolveWikilinkTarget } from "#/editor/useResolveWikilinkTarget";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { localDateKey } from "#/lib/time";
import { useBoardStore } from "#/store/board";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dueLabel(due: string, today: string): string {
  const [y, m, d] = due.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const days =
    (date.getTime() - new Date(`${today}T00:00:00`).getTime()) / 864e5;
  return days >= 0 && days < 7 ? WEEKDAY[date.getDay()] : `${d}.${m}`;
}

function firstStatus(groups: Record<BoardStatus, BoardTask[]>): BoardStatus {
  if (groups.TRIAGE.length > 0) return "TRIAGE";
  return COL_ORDER.find((s) => groups[s].length > 0) ?? DEFAULT_STATUS;
}

function TaskCard({ task, today }: { task: BoardTask; today: string }) {
  const openTab = useOpenTab();
  const overdue = task.due ? task.due < today : false;
  return (
    <button
      type="button"
      onClick={() => openTab("page", task.path, task.title)}
      className={cn(
        "flex flex-col gap-2.5 rounded-2xl bg-raise px-[18px] py-4 text-left",
        FOCUS_RING_NATIVE,
      )}
    >
      <span className="text-[15.5px] leading-[1.4] text-ink">{task.title}</span>
      {isEpic(task.task_type) ? (
        <span className="text-sm text-mute">
          Epic · {task.child_progress[0]} of {task.child_progress[1]} tasks done
        </span>
      ) : (
        <TypeChip type={task.task_type} />
      )}
      <span className="flex items-center gap-2 text-[12.5px] text-mute">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: priColor(task.priority).bar }}
        />
        {task.code}
        <span className="flex-1" />
        {task.due && (
          <span className={overdue ? "text-hot" : undefined}>
            {dueLabel(task.due, today)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Mobile Tasks (spec §9 Q3; user ruling: built as mocked). */
export function MobileTasking() {
  const { data, isLoading, isError } = useBoard();
  const opFilter = useBoardStore((s) => s.opFilter);
  const setOpFilter = useBoardStore((s) => s.setOpFilter);
  const editTaskId = useBoardStore((s) => s.editTaskId);
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const taskModal = useBoardStore((s) => s.taskModal);
  const openTaskModal = useBoardStore((s) => s.openTaskModal);
  const selectedBoard = useBoard({
    includeRetired: true,
    enabled: editTaskId !== null,
  });
  const openTab = useOpenTab();
  const { resolve } = useResolveWikilinkTarget();
  const create = useCreateTask();
  const today = localDateKey(new Date());
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const tasks = data?.tasks ?? [];
  const editTask =
    tasks.find((task) => task.id === editTaskId) ??
    selectedBoard.data?.tasks.find((task) => task.id === editTaskId);
  const scopes = useMemo(
    () => deriveProjectScopes(data?.operations ?? [], data?.tasks ?? []),
    [data],
  );
  const scoped = filterTasks(tasks, opFilter);
  const groups = tasksByStatus(scoped);
  const selected = status ?? firstStatus(groups);
  const scope = scopes.find((p) => p.key === opFilter) ?? null;
  const title =
    opFilter === "UNFILED"
      ? "No project"
      : scope
        ? scope.name || scope.code
        : "All projects";

  // Self-heal a stale saved project, as the desktop board does.
  useEffect(() => {
    if (!data || opFilter === "ALL" || opFilter === "UNFILED") return;
    if (!scopes.some((p) => p.key === opFilter)) setOpFilter("ALL");
  }, [data, scopes, opFilter, setOpFilter]);

  const cycle = data?.cycles.find((c) => c.state === "ACTIVE");
  const cycleTasks = cycle
    ? scoped.filter((t) => !isEpic(t.task_type) && t.cycle === cycle.code)
    : [];
  const cycleDone = cycleTasks.filter((t) => isDone(t.status)).length;

  const submit = () => {
    const title = draft.trim();
    if (!title || create.isPending) return;
    create.mutate(
      { title, status: selected, project: scope?.slug ?? null },
      { onSuccess: () => setDraft("") },
    );
  };

  return (
    <div className="flex flex-col pb-10">
      <div className="flex flex-col gap-2.5 px-5 pt-1">
        <Select
          aria-label="Project"
          selectedKey={opFilter}
          onSelectionChange={(key) => {
            if (key !== null) setOpFilter(String(key));
            setStatus(null);
          }}
          className="w-auto max-w-[240px]"
        >
          <SelectItem id="ALL">All projects</SelectItem>
          <SelectItem id="UNFILED">No project</SelectItem>
          {scopes.map((p) => (
            <SelectItem key={p.key} id={p.key}>
              {p.name || p.code}
            </SelectItem>
          ))}
        </Select>
        <BoardProjects
          onOpenPage={(path, label) => openTab("page", path, label)}
        />
        <h1 className="font-serif text-[44px] leading-none text-ink">
          {title}
        </h1>
        {cycle && cycleTasks.length > 0 && (
          <div className="flex items-center gap-2.5 text-[13px] text-mute">
            <span className="min-w-0 truncate">
              {`Cycle ${cycle.code} · ${fmtCycleWindow(cycle.start, cycle.end)}`}
            </span>
            <span className="flex-1" />
            <span
              role="progressbar"
              aria-label="Cycle progress"
              aria-valuemin={0}
              aria-valuenow={cycleDone}
              aria-valuemax={cycleTasks.length}
              className="block h-1 w-16 overflow-hidden rounded-full bg-rule"
            >
              <span
                className="block h-full bg-accent"
                style={{
                  width: `${Math.round((cycleDone / cycleTasks.length) * 100)}%`,
                }}
              />
            </span>
            <span className="tabular-nums">{`${cycleDone}/${cycleTasks.length}`}</span>
          </div>
        )}
      </div>

      {isLoading && <p className="px-5 pt-6 text-[15px] text-mute">Loading…</p>}
      {isError && (
        <p role="alert" className="px-5 pt-6 text-[15px] text-hot">
          Tasks failed to load.
        </p>
      )}

      <Tabs
        selectedKey={selected}
        onSelectionChange={(key) => setStatus(key as BoardStatus)}
        className="mt-[18px]"
      >
        <TabList
          aria-label="Status"
          className="flex h-[46px] items-stretch gap-5 overflow-x-auto px-5 shadow-[inset_0_-1px_0_var(--rule)] [scrollbar-width:none]"
        >
          {COL_ORDER.map((s) => (
            <Tab
              key={s}
              id={s}
              className="flex shrink-0 items-center whitespace-nowrap px-0.5 pb-0 data-[selected]:no-underline data-[selected]:shadow-[inset_0_-2px_0_var(--accent)]"
            >
              {`${COL_LABEL[s]} ${groups[s].length}`}
            </Tab>
          ))}
        </TabList>
        {COL_ORDER.map((s) => (
          <TabPanel
            key={s}
            id={s}
            className="flex flex-col gap-2.5 px-4 pt-[18px]"
          >
            {groups[s].length === 0 ? (
              <p className="px-1 text-[15px] text-mute">No tasks here.</p>
            ) : (
              groups[s].map((t) => (
                <TaskCard key={t.id} task={t} today={today} />
              ))
            )}
          </TabPanel>
        ))}
      </Tabs>

      <div className="px-4 pt-3">
        {adding ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: revealed on demand by "+ New task"
            autoFocus
            aria-label="New task title"
            placeholder="Task title"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setAdding(false);
                setDraft("");
              }
            }}
            className={cn(
              "h-12 w-full rounded-full bg-sink px-5 text-[15px] text-ink placeholder:text-mute",
              FOCUS_RING_NATIVE,
            )}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={cn(
              "h-12 w-full rounded-full bg-sink text-[15px] text-ink",
              FOCUS_RING_NATIVE,
            )}
          >
            + New task
          </button>
        )}
        <Button
          onPress={() =>
            openTaskModal({
              project: scope?.slug ?? undefined,
              status: selected,
            })
          }
        >
          New task with details
        </Button>
      </div>
      {editTaskId && !editTask && (
        <div
          role={selectedBoard.isError ? "alert" : "status"}
          className="px-5 pt-4 text-sm text-mute"
        >
          {selectedBoard.isLoading
            ? "Loading selected task…"
            : selectedBoard.isError
              ? "Couldn’t load the selected task."
              : "The selected task is no longer available."}
          {selectedBoard.isError && (
            <Button
              onPress={() => {
                void selectedBoard.refetch();
              }}
            >
              Retry
            </Button>
          )}
          <Button onPress={() => setEditTaskId(null)}>Dismiss</Button>
        </div>
      )}
      {editTask && (
        <div className="fixed inset-0 z-50 bg-ground">
          <TaskEditPanel
            key={editTask.id}
            task={editTask}
            tasks={selectedBoard.data?.tasks ?? tasks}
            projects={
              selectedBoard.data
                ? deriveProjectScopes(
                    selectedBoard.data.operations,
                    selectedBoard.data.tasks,
                  )
                : scopes
            }
            cycles={data?.cycles ?? []}
            colLabel={taskStatusLabel}
            onClose={() => setEditTaskId(null)}
            onOpenPage={(path, label, target) =>
              openTab("page", path, label, target)
            }
            onOpenDossier={(link) => {
              void resolve(link)
                .then((target) => {
                  if (!target) throw new Error("Related page not found.");
                  openTab("page", target.path, target.title);
                })
                .catch((error) =>
                  toast.error(
                    formatApiError(error, "Couldn’t open related page."),
                  ),
                );
            }}
          />
        </div>
      )}
      {taskModal && (
        <NewTaskModal
          projects={scopes}
          cycles={data?.cycles ?? []}
          tasks={selectedBoard.data?.tasks ?? tasks}
          colLabel={taskStatusLabel}
        />
      )}
    </div>
  );
}
