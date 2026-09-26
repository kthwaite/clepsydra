import { useEffect, useMemo, useState } from "react";
import { type BoardTask, useBoard, useCreateTask } from "#/api/board";
import {
  type BoardStatus,
  tasksByStatus,
} from "#/components/mobile/mobile-data";
import {
  COL_LABEL,
  COL_ORDER,
  fmtCycleWindow,
  priColor,
} from "#/components/tasking/board-constants";
import { deriveProjectScopes } from "#/components/tasking/board-projects";
import { filterTasks } from "#/components/tasking/TaskingScreen";
import { Select, SelectItem } from "#/components/ui/select";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";
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
  return COL_ORDER.find((s) => groups[s].length > 0) ?? "INTAKE";
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
  const create = useCreateTask();
  const today = localDateKey(new Date());
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const tasks = data?.tasks ?? [];
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
  const cycleTasks = cycle ? scoped.filter((t) => t.cycle === cycle.code) : [];
  const cycleDone = cycleTasks.filter((t) => t.status === "SEALED").length;

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
      </div>
    </div>
  );
}
