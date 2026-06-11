import { useMemo } from "react";
import type { BoardOperation, BoardTask } from "#/api/board";
import { useBoard } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { BoardHeader } from "./BoardHeader";
import { opKey } from "./board-constants";
import { ScopeRail } from "./ScopeRail";

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

// ── body placeholders ─────────────────────────────────────────────────────────

function BodyPlaceholder({ label }: { label: string }) {
  return (
    <div className="cl-mono flex h-full items-center justify-center text-[9px] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
      {label} VIEW — COMING SOON
    </div>
  );
}

// ── TaskingScreen ─────────────────────────────────────────────────────────────

export function TaskingScreen() {
  const { data, isLoading, isError } = useBoard();
  const { mode, opFilter, railOpen } = useBoardStore();

  const { operations, cycles, tasks, activeOp, visibleTasks } = useMemo(() => {
    if (!data) {
      return {
        operations: [],
        cycles: [],
        tasks: [],
        activeOp: null,
        visibleTasks: [],
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
    };
  }, [data, opFilter]);

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

  return (
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
        />

        {/* Body router — Tasks 9-12 replace each placeholder */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {mode === "card" && <BodyPlaceholder label="CARD" />}
          {mode === "backlog" && <BodyPlaceholder label="BACKLOG" />}
          {mode === "cycle" && <BodyPlaceholder label="CYCLE" />}
          {mode === "timeline" && <BodyPlaceholder label="TIMELINE" />}
        </div>
      </div>
    </div>
  );
}
