import { useEffect, useMemo } from "react";
import type { BoardOperation, BoardTask } from "#/api/board";
import { useBoard } from "#/api/board";
import { useCycleBurndown, useTaskCompletionHistory } from "#/api/tasks";
import {
  applyClientFilter,
  type ClientFilterConfig,
  EMPTY_FILTER_STATE,
  type FilterField,
  type FilterState,
  FLAG_ON,
} from "#/lib/filters/model";
import { useBoardStore } from "#/store/board";
import { BacklogView } from "./BacklogView";
import { BoardHeader } from "./BoardHeader";
import {
  COL_ORDER,
  COL_LABEL,
  type ColLabelFn,
  opKey,
  PRI_ORDER,
} from "./board-constants";
import { CycleView, resolveCycle } from "./CycleView";
import { KanbanView } from "./KanbanView";
import { NewCycleModal } from "./NewCycleModal";
import { NewTaskModal } from "./NewTaskModal";
import { OpenCycleModal } from "./OpenCycleModal";
import { ScopeRail } from "./ScopeRail";
import { SealCycleModal } from "./SealCycleModal";
import { TaskEditPanel } from "./TaskEditPanel";
import { TimelineView } from "./TimelineView";

// ── filterTasks ──────────────────────────────────────────────────────────────

/**
 * Filter tasks by the active opFilter value:
 *  - "ALL"     → return all tasks
 *  - "UNFILED" → tasks whose project is null/empty OR doesn't match any
 *                operation's `project` field
 *  - <key>     → tasks whose project === opFilter
 *
 * Note: opFilter stores the canonical op key (`opKey(op)` — project slug,
 * falling back to op.code when the op has no slug), except for the sentinels
 * "ALL" and "UNFILED". An op without a project slug correctly yields zero
 * tasks here, since no task carries its code as a project.
 */
export function filterTasks(
  tasks: BoardTask[],
  operations: BoardOperation[],
  opFilter: string,
): BoardTask[] {
  if (opFilter === "ALL") return tasks;

  const knownProjects = new Set(
    operations.map((op) => op.project).filter(Boolean),
  );

  if (opFilter === "UNFILED") {
    return tasks.filter((t) => !t.project || !knownProjects.has(t.project));
  }

  // Specific operation — filter by project slug
  return tasks.filter((t) => t.project === opFilter);
}

// ── shared FilterBar wiring ───────────────────────────────────────────────────

/** Client-side facet/text predicate config for the shared FilterBar. */
const BOARD_FILTER_CONFIG: ClientFilterConfig<BoardTask> = {
  textHay: (t) => [t.title, t.code, t.assignee ?? "", ...t.tags].join("\n"),
  accessors: {
    project: (t) => (t.project ? [t.project] : []),
    tags: (t) => t.tags,
    pri: (t) => [t.priority],
    status: (t) => [t.status],
    hold: (t) => (t.hold ? [FLAG_ON] : []),
  },
};

const colLabel: ColLabelFn = (id) => COL_LABEL[id] ?? id;

// ── TaskingScreen ─────────────────────────────────────────────────────────────

export function TaskingScreen({
  onOpenDossier,
  onOpenPage,
  filterState = EMPTY_FILTER_STATE,
  onFilterChange = () => {},
}: {
  onOpenDossier?: (link: string) => void;
  onOpenPage?: (path: string) => void;
  filterState?: FilterState;
  onFilterChange?: (next: FilterState) => void;
} = {}) {
  const { data, isLoading, isError, refetch } = useBoard();
  // Field selectors — the shell must not re-render on ephemeral modal state.
  const mode = useBoardStore((s) => s.mode);
  const opFilter = useBoardStore((s) => s.opFilter);
  const cycleSel = useBoardStore((s) => s.cycleSel);
  const railOpen = useBoardStore((s) => s.railOpen);
  const editTaskId = useBoardStore((s) => s.editTaskId);
  const taskModal = useBoardStore((s) => s.taskModal);
  const cycleModal = useBoardStore((s) => s.cycleModal);
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const setOpFilter = useBoardStore((s) => s.setOpFilter);

  // Self-heal a stale persisted opFilter: if the filter names an op that no
  // longer exists (renamed/deleted since last session), the board would render
  // silently empty — reset to ALL once board data is available.
  useEffect(() => {
    if (!data || opFilter === "ALL" || opFilter === "UNFILED") return;
    if (!data.operations.some((op) => opKey(op) === opFilter)) {
      setOpFilter("ALL");
    }
  }, [data, opFilter, setOpFilter]);

  const {
    operations,
    cycles,
    tasks,
    activeOp,
    visibleTasks,
    opFilteredCount,
    editTask,
  } = useMemo(() => {
    if (!data) {
      return {
        operations: [],
        cycles: [],
        tasks: [],
        activeOp: null,
        visibleTasks: [],
        opFilteredCount: 0,
        editTask: null,
      };
    }

    const opFiltered = filterTasks(data.tasks, data.operations, opFilter);
    const filtered = applyClientFilter(
      opFiltered,
      filterState,
      BOARD_FILTER_CONFIG,
    );
    const active =
      opFilter !== "ALL" && opFilter !== "UNFILED"
        ? (data.operations.find((op) => opKey(op) === opFilter) ?? null)
        : null;

    return {
      operations: data.operations,
      cycles: data.cycles,
      tasks: data.tasks,
      activeOp: active,
      visibleTasks: filtered,
      opFilteredCount: opFiltered.length,
      editTask: editTaskId
        ? (data.tasks.find((t) => t.id === editTaskId) ?? null)
        : null,
    };
  }, [data, opFilter, filterState, editTaskId]);

  // Options are data-derived: unions of operation/task projects, task tags,
  // and the fixed priority/status vocabularies.
  const filterFields: FilterField[] = useMemo(
    () => [
      {
        id: "project",
        kind: "multi",
        label: "Project",
        options: [
          ...new Set([
            ...operations
              .map((o) => o.project)
              .filter((p): p is string => Boolean(p)),
            ...tasks
              .map((t) => t.project)
              .filter((p): p is string => Boolean(p)),
          ]),
        ]
          .sort()
          .map((value) => ({ value })),
      },
      {
        id: "tags",
        kind: "multi",
        label: "Tags",
        options: [...new Set(tasks.flatMap((t) => t.tags))]
          .sort()
          .map((value) => ({ value })),
      },
      {
        id: "pri",
        kind: "multi",
        label: "Priority",
        options: PRI_ORDER.map((value) => ({ value })),
      },
      {
        id: "status",
        kind: "multi",
        label: "Status",
        options: COL_ORDER.map((value) => ({ value })),
      },
      { id: "hold", kind: "flag", label: "Blocked", options: [] },
    ],
    [operations, tasks],
  );

  const telemetryProject = activeOp?.project ?? undefined;
  const telemetryUnfiled = opFilter === "UNFILED";
  const telemetryApplicable =
    opFilter === "ALL" || telemetryUnfiled || Boolean(telemetryProject);
  const telemetryEnabled = Boolean(data) && telemetryApplicable;
  const completionHistory = useTaskCompletionHistory(
    telemetryProject,
    telemetryUnfiled,
    telemetryEnabled,
  );
  const columns = useMemo(
    () =>
      data?.columns.map((column) => ({
        ...column,
        label: colLabel(column.id),
      })) ?? [],
    [data],
  );

  const selectedCycle = data ? resolveCycle(cycleSel, cycles) : null;
  const cycleBurndown = useCycleBurndown(
    mode === "cycle" && selectedCycle?.code !== "BACKLOG"
      ? (selectedCycle?.code ?? null)
      : null,
    telemetryProject,
    telemetryUnfiled,
    telemetryEnabled,
  );

  if (isLoading) {
    return (
      <div className="cl-mono flex h-full items-center justify-center text-[11px] uppercase tracking-[0.18em] text-[var(--ink-mute)]">
        LOADING
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="cl-mono flex h-full flex-col items-center justify-center gap-[12px] text-[11px] uppercase tracking-[0.18em] text-[var(--hot)]">
        ERROR — board unavailable
        <button type="button" className="cl-btn" onClick={() => refetch()}>
          RETRY
        </button>
      </div>
    );
  }

  // Resolve cycle for open/seal modals (only when cycleModal has a cycleId)
  const cycleModalCycle =
    cycleModal !== null && cycleModal.kind !== "new"
      ? (cycles.find((c) => c.id === cycleModal.cycleId) ?? null)
      : null;

  return (
    <>
      {/* Creation modal — rendered at root level so it's not clipped */}
      {taskModal !== null && (
        <NewTaskModal
          operations={operations}
          cycles={cycles}
          colLabel={colLabel}
        />
      )}

      {/* Cycle lifecycle modals */}
      {cycleModal?.kind === "new" && <NewCycleModal cycles={cycles} />}
      {cycleModal?.kind === "open" && cycleModalCycle !== null && (
        <OpenCycleModal cycle={cycleModalCycle} cycles={cycles} tasks={tasks} />
      )}
      {cycleModal?.kind === "seal" && cycleModalCycle !== null && (
        <SealCycleModal cycle={cycleModalCycle} cycles={cycles} tasks={tasks} />
      )}

      <div className="relative flex h-full overflow-hidden">
        {/* Left scope rail — renders popout button when collapsed */}
        {railOpen ? (
          <div className="w-[232px] flex-none">
            <ScopeRail operations={operations} cycles={cycles} tasks={tasks} />
          </div>
        ) : (
          <ScopeRail operations={operations} cycles={cycles} tasks={tasks} />
        )}

        {/* Main — always flex-1, always full width when rail is collapsed */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <BoardHeader
            operations={operations}
            cycles={cycles}
            tasks={visibleTasks}
            activeOp={activeOp}
            filteredCount={visibleTasks.length}
            opFilteredCount={opFilteredCount}
            filterFields={filterFields}
            filterState={filterState}
            onFilterChange={onFilterChange}
            onOpenDossier={onOpenDossier}
            sealHistory={
              telemetryApplicable
                ? completionHistory.data?.days.map((day) => day.count)
                : undefined
            }
            sealHistoryPending={completionHistory.isPending && telemetryEnabled}
            sealHistoryError={completionHistory.isError}
            sealHistoryApplicable={telemetryApplicable}
          />

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {mode === "card" && (
              <KanbanView
                columns={columns}
                tasks={visibleTasks}
                cycles={cycles}
                showOp={opFilter === "ALL"}
                activeProject={activeOp?.project ?? undefined}
                onOpenDossier={onOpenDossier}
                colLabel={colLabel}
              />
            )}
            {mode === "backlog" && (
              <BacklogView tasks={visibleTasks} colLabel={colLabel} />
            )}
            {mode === "cycle" && (
              <CycleView
                cycle={resolveCycle(cycleSel, cycles)}
                tasks={visibleTasks}
                activeProject={activeOp?.project ?? undefined}
                burndown={
                  telemetryApplicable
                    ? cycleBurndown.data?.points.map((point) => point.remaining)
                    : undefined
                }
                burndownPending={cycleBurndown.isPending && telemetryEnabled}
                burndownError={cycleBurndown.isError}
                burndownApplicable={telemetryApplicable}
                colLabel={colLabel}
              />
            )}
            {mode === "timeline" && (
              <TimelineView
                tasks={visibleTasks}
                operations={
                  opFilter === "ALL" || opFilter === "UNFILED"
                    ? operations
                    : activeOp
                      ? [activeOp]
                      : []
                }
                cycles={cycles}
                colLabel={colLabel}
              />
            )}

            {/* Right-dock edit panel — keyed by task id so switching tasks
                is a real remount: the unmount flush delivers any pending
                debounced edit for the old task before the new panel mounts. */}
            {editTask && (
              <TaskEditPanel
                key={editTask.id}
                task={editTask}
                operations={operations}
                cycles={cycles}
                colLabel={colLabel}
                onClose={() => setEditTaskId(null)}
                onOpenPage={onOpenPage}
                onOpenDossier={onOpenDossier}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
