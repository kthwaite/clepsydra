import { useEffect, useMemo } from "react";
import type { BoardOperation, BoardTask } from "#/api/board";
import { useBoard } from "#/api/board";
import { useCycleBurndown, useTaskCompletionHistory } from "#/api/tasks";
import { useBoardStore } from "#/store/board";
import { BacklogView } from "./BacklogView";
import { BoardHeader } from "./BoardHeader";
import { opKey } from "./board-constants";
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

// ── TaskingScreen ─────────────────────────────────────────────────────────────

export function TaskingScreen({
  onOpenDossier,
  onOpenPage,
}: {
  onOpenDossier?: (link: string) => void;
  onOpenPage?: (path: string) => void;
} = {}) {
  const { data, isLoading, isError } = useBoard();
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

  const { operations, cycles, tasks, activeOp, visibleTasks, editTask } =
    useMemo(() => {
      if (!data) {
        return {
          operations: [],
          cycles: [],
          tasks: [],
          activeOp: null,
          visibleTasks: [],
          editTask: null,
        };
      }

      const filtered = filterTasks(data.tasks, data.operations, opFilter);
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
        editTask: editTaskId
          ? (data.tasks.find((t) => t.id === editTaskId) ?? null)
          : null,
      };
    }, [data, opFilter, editTaskId]);

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
      <div className="cl-mono flex h-full items-center justify-center text-[11px] uppercase tracking-[0.18em] text-[var(--hot)]">
        ERROR — board unavailable
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
        <NewTaskModal operations={operations} cycles={cycles} />
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

          {/* Body router — Tasks 9-12 replace each placeholder */}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {mode === "card" && (
              <KanbanView
                columns={data.columns}
                tasks={visibleTasks}
                cycles={cycles}
                showOp={opFilter === "ALL"}
                activeProject={activeOp?.project ?? undefined}
                onOpenDossier={onOpenDossier}
              />
            )}
            {mode === "backlog" && <BacklogView tasks={visibleTasks} />}
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
