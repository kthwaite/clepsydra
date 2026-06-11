/**
 * KanbanView — 5-column drag-and-drop kanban for the TASKING board.
 *
 * - Cards bucketed by task.status, sorted by PRI_ORDER within each column.
 * - Decision 8 (sealed filter): SEALED column excludes tasks whose cycle
 *   refers to a cycle with state "CLOSED" — see `visibleInKanban`.
 * - DnD via native HTML5 drag-and-drop; optimistic patch via usePatchTask.
 * - Column header + button → openTaskModal({ status }) preset.
 * - Card click → setEditTaskId(task.id).
 * - Dossier link click → onOpenDossier prop (stopPropagation internally).
 */

import { useState } from "react";
import type { BoardColumn, BoardCycle, BoardTask } from "#/api/board";
import { usePatchTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { PRI_ORDER } from "./board-constants";
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
}

export function KanbanView({
  columns,
  tasks,
  cycles,
  showOp,
  activeProject,
  onOpenDossier,
}: KanbanViewProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const openTaskModal = useBoardStore((s) => s.openTaskModal);

  const patchTask = usePatchTask();

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  const visible = visibleInKanban(tasks, cycles);

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
        const isDropTarget = dropCol === col.id;

        return (
          <div
            key={col.id}
            className="flex min-h-0 flex-[1_0_282px] flex-col border-r border-[var(--rule)] last:border-r-0"
            style={
              isDropTarget
                ? {
                    background:
                      "color-mix(in oklab, var(--accent) 7%, transparent)",
                  }
                : undefined
            }
            onDragOver={(e) => {
              e.preventDefault();
              if (dropCol !== col.id) setDropCol(col.id);
            }}
            onDragLeave={(e) => {
              // Only clear when leaving the column div itself, not a child
              if (e.currentTarget === e.target) setDropCol(null);
            }}
            onDrop={() => {
              if (dragId) {
                patchTask.mutate({ id: dragId, patch: { status: col.id } });
              }
              setDragId(null);
              setDropCol(null);
            }}
            data-testid={`kb-col-${col.id}`}
          >
            {/* Column header */}
            <div className="sticky top-0 z-[2] flex items-center gap-[8px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[var(--pad,12px)] py-[8px]">
              <span className="cl-display whitespace-nowrap text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]">
                {col.label}
              </span>
              {col.sub && (
                <span className="cl-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
                  {col.sub}
                </span>
              )}
              <button
                className="inline-flex h-[16px] w-[16px] items-center justify-content-center border border-[var(--rule)] text-[13px] leading-[1] text-[var(--ink-3)] transition-[color,border-color] duration-[120ms] hover:border-[var(--hot)] hover:text-[var(--hot)]"
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
                {String(items.length).padStart(2, "0")}
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
            <div className="flex flex-1 flex-col gap-[9px] overflow-y-auto p-[var(--pad,12px)] min-h-0">
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
                    isDragging={dragId === t.id}
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropCol(null);
                    }}
                    onClick={() => setEditTaskId(t.id)}
                    onOpenDossier={onOpenDossier}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
