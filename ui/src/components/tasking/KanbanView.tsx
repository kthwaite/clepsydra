/**
 * KanbanView — 5-column drag-and-drop kanban for the TASKING board.
 *
 * - Cards bucketed by task.status, sorted by PRI_ORDER within each column.
 * - Decision 8 (sealed filter): SEALED column excludes tasks whose cycle
 *   refers to a cycle with state "CLOSED" — see `visibleInKanban`.
 * - DnD via Pragmatic drag-and-drop; optimistic patch via usePatchTask.
 * - Column header + button → openTaskModal({ status }) preset.
 * - Card click → setEditTaskId(task.id).
 * - Dossier link click → onOpenDossier prop (stopPropagation internally).
 */

import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BoardColumn, BoardCycle, BoardTask } from "#/api/board";
import { usePatchTask } from "#/api/board";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  KANBAN_COL_DEFAULT,
  KANBAN_COL_MAX,
  KANBAN_COL_MIN,
  useBoardStore,
} from "#/store/board";
import { Tick } from "../codex/Tick";
import { type ColLabelFn, PRI_ORDER } from "./board-constants";
import { QuickAddRow } from "./QuickAddRow";
import { TaskCard } from "./TaskCard";

// ── sealed-cycle filter (Decision 8) ─────────────────────────────────────────

/**
 * Returns only the tasks that should appear in the kanban board.
 *
 * Rule: SEALED-status tasks whose `cycle` matches a CLOSED cycle are excluded
 * (they belong to history, not the live board). Tasks in all other statuses,
 * or SEALED tasks in open/planned/no cycles, are always included.
 *
 * Exported as a pure function so it can be unit-tested in isolation.
 */
export function visibleInKanban(
  tasks: BoardTask[],
  cycles: BoardCycle[],
): BoardTask[] {
  const closedCycleCodes = new Set(
    cycles.filter((c) => c.state === "CLOSED").map((c) => c.code),
  );

  return tasks.filter((t) => {
    if (t.status !== "SEALED") return true;
    // SEALED: exclude if its cycle is closed
    if (t.cycle && closedCycleCodes.has(t.cycle)) return false;
    return true;
  });
}

type TaskCardDragData = {
  kind: "task-card";
  taskId: string;
  status: string;
};

function getTaskCardDragData(
  data: Record<string | symbol, unknown>,
): TaskCardDragData | null {
  if (
    data.kind !== "task-card" ||
    typeof data.taskId !== "string" ||
    typeof data.status !== "string"
  ) {
    return null;
  }

  return {
    kind: "task-card",
    taskId: data.taskId,
    status: data.status,
  };
}

/** Inbox and Done are the board's quiet ends: their ticks are faint. */
const FAINT_COLUMNS = new Set(["INTAKE", "SEALED"]);

// ── column resize handle ─────────────────────────────────────────────────────

function ColumnResizeHandle({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  const setColumnWidth = useBoardStore((s) => s.setColumnWidth);
  const resetColumnWidth = useBoardStore((s) => s.resetColumnWidth);
  const width = useBoardStore((s) => s.columnWidths[status]);
  const current = width ?? KANBAN_COL_DEFAULT;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const column = handle.parentElement;
    const startX = event.clientX;
    const startWidth = column?.getBoundingClientRect().width ?? current;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      if (move.buttons === 0) return; // defense in depth: button already released
      setColumnWidth(status, startWidth + (move.clientX - startX));
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      handle.removeEventListener("lostpointercapture", onEnd);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    handle.addEventListener("lostpointercapture", onEnd);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> can't be focusable or carry drag/keyboard handlers — this is the ARIA APG focusable-separator (splitter) pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuemin={KANBAN_COL_MIN}
      aria-valuemax={KANBAN_COL_MAX}
      aria-valuenow={current}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetColumnWidth(status)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setColumnWidth(status, current + 16);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          setColumnWidth(status, current - 16);
        }
      }}
      className="absolute right-0 top-0 z-[3] h-full w-[5px] cursor-col-resize rounded-full outline-none hover:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)]"
    />
  );
}

interface KanbanDropColumnProps {
  status: string;
  label: string;
  onMoveTask: (taskId: string, status: string) => void;
  taskStatusById: ReadonlyMap<string, string>;
  children: ReactNode;
}

function KanbanDropColumn({
  status,
  label,
  onMoveTask,
  taskStatusById,
  children,
}: KanbanDropColumnProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const width = useBoardStore((s) => s.columnWidths[status]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    return dropTargetForElements({
      element,
      getData: () => ({ kind: "task-card-column", status }),
      canDrop: ({ source }) => {
        const data = getTaskCardDragData(source.data);
        return data !== null && taskStatusById.has(data.taskId);
      },
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: ({ source }) => {
        setIsDropTarget(false);
        const data = getTaskCardDragData(source.data);
        if (!data) return;
        const currentStatus = taskStatusById.get(data.taskId);
        if (currentStatus === undefined || currentStatus === status) return;
        onMoveTask(data.taskId, status);
      },
    });
  }, [onMoveTask, status, taskStatusById]);

  return (
    <div
      ref={ref}
      className="relative flex min-h-0 flex-[1_0_282px] flex-col rounded-xl"
      style={{
        ...(isDropTarget
          ? {
              background: "color-mix(in oklab, var(--accent) 7%, transparent)",
            }
          : undefined),
        ...(width ? { flex: `0 0 ${width}px` } : {}),
      }}
      data-testid={`kb-col-${status}`}
    >
      {children}
      <ColumnResizeHandle status={status} label={label} />
    </div>
  );
}

// ── KanbanView ────────────────────────────────────────────────────────────────

export interface KanbanViewProps {
  columns: BoardColumn[];
  tasks: BoardTask[];
  cycles: BoardCycle[];
  /** Whether ALL ops are showing (drives showOp on cards) */
  showOp: boolean;
  /**
   * Project slug of the currently selected operation, when a real op with a
   * slug is active (mirrors ScopeRail's preset logic — never an op code).
   * Threaded into the column + button's taskModal preset.
   */
  activeProject?: string;
  onOpenDossier?: (link: string) => void;
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function KanbanView({
  columns,
  tasks,
  cycles,
  showOp,
  activeProject,
  onOpenDossier,
  colLabel,
}: KanbanViewProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const openTaskModal = useBoardStore((s) => s.openTaskModal);

  const { mutate: patchTask } = usePatchTask();
  const moveTask = useCallback(
    (taskId: string, status: string) =>
      patchTask({ id: taskId, patch: { status } }),
    [patchTask],
  );

  const visible = useMemo(
    () => visibleInKanban(tasks, cycles),
    [tasks, cycles],
  );
  const taskStatusById = useMemo(
    () => new Map(visible.map((task) => [task.id, task.status])),
    [visible],
  );

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto overflow-y-hidden px-3">
      {columns.map((col) => {
        const items = visible
          .filter((t) => t.status === col.id)
          .sort(
            (a, b) =>
              PRI_ORDER.indexOf(a.priority as (typeof PRI_ORDER)[number]) -
              PRI_ORDER.indexOf(b.priority as (typeof PRI_ORDER)[number]),
          );

        const displayLabel = colLabel(col.id);
        const taskCount = `${items.length} ${
          items.length === 1 ? "task" : "tasks"
        }`;

        return (
          <KanbanDropColumn
            key={col.id}
            status={col.id}
            label={displayLabel}
            onMoveTask={moveTask}
            taskStatusById={taskStatusById}
          >
            {/* Column header — one fixed-height row; only the sub-label may truncate */}
            <div
              className="sticky top-0 z-[2] flex h-11 items-center gap-2 bg-ground px-3"
              data-testid={`kb-head-${col.id}`}
            >
              <Tick variant={FAINT_COLUMNS.has(col.id) ? "faint" : "live"} />
              <span className="whitespace-nowrap font-serif text-[19px] italic text-ink">
                {displayLabel}
              </span>
              {col.sub && (
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-mute">
                  {col.sub}
                </span>
              )}
              <button
                type="button"
                className={cn(
                  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[15px] leading-none text-mute transition-colors hover:bg-sink hover:text-accent",
                  FOCUS_RING_NATIVE,
                )}
                title={`New task in ${displayLabel}`}
                onClick={() =>
                  openTaskModal(
                    activeProject
                      ? { status: col.id, project: activeProject }
                      : { status: col.id },
                  )
                }
                data-testid={`kb-add-${col.id}`}
              >
                +
              </button>
              <span
                className="ml-auto shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-mute"
                data-testid={`kb-cnt-${col.id}`}
              >
                {taskCount}
              </span>
            </div>

            {/* Column body */}
            <div
              className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-1.5 pb-4 pt-1"
              data-testid={`kb-body-${col.id}`}
            >
              {items.length === 0 ? (
                <div
                  className="rounded-[14px] bg-sink px-4 py-5 text-center text-[13px] text-mute"
                  data-testid={`kb-empty-${col.id}`}
                >
                  No tasks
                </div>
              ) : (
                items.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    showOp={showOp}
                    onClick={() => setEditTaskId(t.id)}
                    onOpenDossier={onOpenDossier}
                    colLabel={colLabel}
                  />
                ))
              )}
              <QuickAddRow
                preset={
                  activeProject
                    ? { status: col.id, project: activeProject }
                    : { status: col.id }
                }
                testId={`qa-${col.id}`}
              />
            </div>
          </KanbanDropColumn>
        );
      })}
    </div>
  );
}
