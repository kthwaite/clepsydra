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
import { pad2 } from "#/lib/time";
import {
  KANBAN_COL_DEFAULT,
  KANBAN_COL_MAX,
  KANBAN_COL_MIN,
  useBoardStore,
} from "#/store/board";
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
    const onMove = (move: PointerEvent) =>
      setColumnWidth(status, startWidth + (move.clientX - startX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
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
      className="absolute right-0 top-0 z-[3] h-full w-[5px] cursor-col-resize outline-none hover:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)]"
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
      className="relative flex min-h-0 flex-[1_0_282px] flex-col border-r border-[var(--rule)] last:border-r-0"
      style={{
        ...(isDropTarget
          ? {
              background:
                "color-mix(in oklab, var(--accent) 7%, transparent)",
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

  const visible = useMemo(() => visibleInKanban(tasks, cycles), [tasks, cycles]);
  const taskStatusById = useMemo(
    () => new Map(visible.map((task) => [task.id, task.status])),
    [visible],
  );

  return (
    <div className="flex h-full min-h-0 overflow-x-auto overflow-y-hidden">
      {columns.map((col) => {
        const items = visible
          .filter((t) => t.status === col.id)
          .sort(
            (a, b) =>
              PRI_ORDER.indexOf(a.priority as (typeof PRI_ORDER)[number]) -
              PRI_ORDER.indexOf(b.priority as (typeof PRI_ORDER)[number]),
          );

        const over = col.wip > 0 && items.length > col.wip;
        const fill =
          col.wip > 0 ? Math.min(100, (items.length / col.wip) * 100) : 0;

        return (
          <KanbanDropColumn
            key={col.id}
            status={col.id}
            label={col.label}
            onMoveTask={moveTask}
            taskStatusById={taskStatusById}
          >
            {/* Column header */}
            <div className="sticky top-0 z-[2] flex items-center gap-[8px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[var(--pad)] py-[8px]">
              <span className="cl-display whitespace-nowrap text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]">
                {col.label}
              </span>
              {col.sub && (
                <span className="cl-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
                  {col.sub}
                </span>
              )}
              <button
                type="button"
                className="inline-flex h-[16px] w-[16px] items-center justify-center border border-[var(--rule)] text-[13px] leading-[1] text-[var(--ink-3)] transition-[color,border-color] duration-[120ms] hover:border-[var(--hot)] hover:text-[var(--hot)]"
                title={`New task in ${col.label}`}
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
                className="cl-mono ml-auto min-w-[22px] border px-[5px] text-center text-[var(--fs-xs)] tracking-[0.1em] font-variant-numeric"
                style={
                  over
                    ? {
                        color: "var(--hot)",
                        borderColor: "var(--hot)",
                      }
                    : {
                        color: "var(--ink-2)",
                        borderColor: "var(--rule)",
                      }
                }
                data-testid={`kb-cnt-${col.id}`}
              >
                {pad2(items.length)}
                {col.wip > 0 ? `/${col.wip}` : ""}
              </span>
            </div>

            {/* WIP fill bar */}
            {col.wip > 0 ? (
              <div className="h-[2px] border-b border-[var(--rule)] bg-[var(--bg-3)]">
                <i
                  className="block h-full transition-[width] duration-[200ms]"
                  style={{
                    width: `${fill}%`,
                    background: over ? "var(--hot)" : "var(--cool)",
                  }}
                />
              </div>
            ) : (
              /* nolimit — transparent spacer so layout stays consistent */
              <div className="h-[2px] bg-transparent" />
            )}

            {/* Column body */}
            <div className="flex flex-1 flex-col gap-[9px] overflow-y-auto p-[var(--pad)] min-h-0">
              {items.length === 0 ? (
                <div
                  className="cl-mono border border-dashed border-[var(--rule)] px-[8px] py-[16px] text-center text-[var(--fs-xs)] uppercase tracking-[0.18em] text-[var(--ink-4)]"
                  data-testid={`kb-empty-${col.id}`}
                >
                  — NONE —
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
