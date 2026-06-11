/**
 * CycleView — sprint view for the TASKING board.
 *
 * Design source: docs/pkm-redesign/project/board-modes.jsx lines 195-299
 * (SprintView) + docs/pkm-redesign/project/styles-board.css .sp* classes.
 *
 * - resolveCycle: exported pure helper; determines the displayed cycle from
 *   the persisted cycleSel store value and the live cycles array.
 * - cycleStats: exported pure helper; computes committed/sealed/field/hold/
 *   check counts and sealed percentage.
 * - CycleView: renders the header (window·state, h2 label, goal, actions),
 *   right-side metrics + synthetic burndown Spark, progress bar, and
 *   disposition lanes.
 */

import { useMemo } from "react";
import type { BoardCycle, BoardTask } from "#/api/board";
import { Spark } from "#/components/ui/spark";
import { useBoardStore } from "#/store/board";
import {
  COL_LABEL,
  COL_ORDER,
  fmtCycleWindow,
  HoldTag,
  PRI_ORDER,
  PriChip,
  StatePip,
} from "./board-constants";

// ── resolveCycle ──────────────────────────────────────────────────────────────

/** The pseudo-cycle object used when no named cycle is selected. */
export const BACKLOG_PSEUDO_CYCLE: Omit<BoardCycle, "id" | "path"> & {
  id?: string;
  path?: string;
} = {
  code: "BACKLOG",
  label: "BACKLOG",
  state: "OPEN",
  start: null,
  end: null,
  goal: "Uncommitted tasking — not yet pulled into a cycle.",
};

/**
 * Resolves the displayed cycle from a persisted cycleSel value and the live
 * cycles array.
 *
 * Resolution rules:
 *   "BACKLOG"        → BACKLOG pseudo-cycle
 *   <cycle code>     → the matching BoardCycle if found; else ACTIVE → else first → else BACKLOG
 *   "" (empty)       → ACTIVE cycle if one exists; else first cycle; else BACKLOG
 */
export function resolveCycle(
  cycleSel: string,
  cycles: BoardCycle[],
): BoardCycle | typeof BACKLOG_PSEUDO_CYCLE {
  if (cycleSel === "BACKLOG") return BACKLOG_PSEUDO_CYCLE;

  const activeCycle = cycles.find((c) => c.state === "ACTIVE");

  if (cycleSel !== "") {
    // Explicit cycle code — return it if found, else fall through to default
    const found = cycles.find((c) => c.code === cycleSel);
    if (found) return found;
    // stale/no-match
  }

  // "" or stale → active → first → backlog
  if (activeCycle) return activeCycle;
  if (cycles.length > 0) return cycles[0];
  return BACKLOG_PSEUDO_CYCLE;
}

// ── cycleStats ────────────────────────────────────────────────────────────────

export interface CycleStatsResult {
  committed: number;
  sealed: number;
  field: number;
  hold: number;
  checkDone: number;
  checkTot: number;
  pct: number;
}

/**
 * Computes aggregate statistics for a set of cycle items.
 * `pct` is 0 when committed = 0 (guards against division by zero).
 */
export function cycleStats(items: BoardTask[]): CycleStatsResult {
  const committed = items.length;
  const sealed = items.filter((t) => t.status === "SEALED").length;
  const field = items.filter((t) => t.status === "FIELD").length;
  const hold = items.filter((t) => !!t.hold).length;
  const checkDone = items.reduce(
    (a, t) => a + (t.checks.length >= 2 ? t.checks[0] : 0),
    0,
  );
  const checkTot = items.reduce(
    (a, t) => a + (t.checks.length >= 2 ? t.checks[1] : 0),
    0,
  );
  const pct = committed ? Math.round((sealed / committed) * 100) : 0;
  return { committed, sealed, field, hold, checkDone, checkTot, pct };
}

// ── CycleView ─────────────────────────────────────────────────────────────────

export interface CycleViewProps {
  /**
   * The resolved cycle to display (may be the BACKLOG pseudo-cycle — code
   * === "BACKLOG" with no `id` field).
   */
  cycle: BoardCycle | typeof BACKLOG_PSEUDO_CYCLE;
  /**
   * Op-filtered tasks from TaskingScreen (same `visibleTasks` slice used by
   * KanbanView and BacklogView). CycleView filters to items whose cycle
   * matches internally.
   */
  tasks: BoardTask[];
  /**
   * Project slug of the currently selected operation, when a real op with a
   * slug is active (mirrors KanbanView's `activeOp?.project ?? undefined` —
   * never an op code). Threaded into the COMMIT TASK preset.
   */
  activeProject?: string;
  /** Optional: called when a task row is clicked. Defaults to store action. */
  onEditTask?: (id: string) => void;
}

export function CycleView({
  cycle,
  tasks,
  activeProject,
  onEditTask,
}: CycleViewProps) {
  // Store actions — field-selector pattern (no ephemeral re-renders)
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const openTaskModal = useBoardStore((s) => s.openTaskModal);
  const openCycleModal = useBoardStore((s) => s.openCycleModal);

  const handleEditTask = onEditTask ?? setEditTaskId;

  // Filter tasks for this cycle
  const items = useMemo(
    () =>
      cycle.code === "BACKLOG"
        ? tasks.filter((t) => !t.cycle)
        : tasks.filter((t) => t.cycle === cycle.code),
    [tasks, cycle.code],
  );

  const stats = useMemo(() => cycleStats(items), [items]);

  // Synthetic burndown (7 points, prototype formula exactly)
  const burn = useMemo(() => {
    const open = stats.committed - stats.sealed;
    const days = 7;
    return Array.from({ length: days }, (_, i) =>
      Math.max(
        open,
        Math.round(
          stats.committed - (stats.committed - open) * (i / (days - 1)),
        ),
      ),
    );
  }, [stats.committed, stats.sealed]);

  // Disposition lanes — only non-empty, in COL_ORDER
  const byCol = useMemo(
    () =>
      COL_ORDER.map((cid) => ({
        cid,
        items: items
          .filter((t) => t.status === cid)
          .sort(
            (a, b) =>
              PRI_ORDER.indexOf(a.priority as (typeof PRI_ORDER)[number]) -
              PRI_ORDER.indexOf(b.priority as (typeof PRI_ORDER)[number]),
          ),
      })).filter((g) => g.items.length > 0),
    [items],
  );

  // Whether this is the BACKLOG pseudo-cycle (no id → can't open modals)
  const isBacklog = cycle.code === "BACKLOG";

  // Window label
  const windowLabel = fmtCycleWindow(cycle.start, cycle.end);

  // State label color — mirrors .sp-state.* in styles-board.css
  const stateColor =
    cycle.state === "ACTIVE"
      ? "var(--cool)"
      : cycle.state === "PLANNED"
        ? "var(--ink-2)"
        : cycle.state === "CLOSED"
          ? "var(--ink-3)"
          : cycle.state === "OPEN"
            ? "var(--warn)"
            : "var(--ink-mute)";

  function handleCommitTask() {
    const preset: { cycle?: string; project?: string } = {};
    if (!isBacklog) preset.cycle = cycle.code;
    if (activeProject) preset.project = activeProject;
    openTaskModal(preset);
  }

  return (
    <div className="cl-mono h-full overflow-y-auto px-[var(--pad,12px)] py-[16px]">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="mb-[16px] flex items-start justify-between gap-[24px]">
        {/* Left */}
        <div className="min-w-0 flex-1">
          {/* Window · State */}
          <div className="mb-[2px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
            {windowLabel}
            <span className="mx-[6px] text-[var(--rule)]">·</span>
            <span style={{ color: stateColor, letterSpacing: "0.16em" }}>
              {cycle.state}
            </span>
          </div>

          {/* h2 label */}
          <h2 className="cl-display mb-[4px] text-[22px] font-black uppercase leading-none tracking-[0.04em] text-[var(--ink)]">
            {cycle.label}
          </h2>

          {/* Goal */}
          {cycle.goal && (
            <div className="max-w-[520px] text-[13px] leading-snug text-[var(--ink-2)]">
              {cycle.goal}
            </div>
          )}

          {/* Actions */}
          {!isBacklog && (
            <div className="mt-[12px] flex items-center gap-[10px]">
              {cycle.state === "PLANNED" && (
                <button
                  type="button"
                  className="cursor-pointer border border-[var(--hot)] px-[12px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-colors hover:bg-[var(--hot)] hover:text-black"
                  onClick={() =>
                    openCycleModal({
                      kind: "open",
                      cycleId: (cycle as BoardCycle).id,
                    })
                  }
                >
                  ▶ OPEN CYCLE
                </button>
              )}
              {cycle.state === "ACTIVE" && (
                <button
                  type="button"
                  className="cursor-pointer border border-[var(--hot)] px-[12px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-colors hover:bg-[var(--hot)] hover:text-black"
                  onClick={() =>
                    openCycleModal({
                      kind: "seal",
                      cycleId: (cycle as BoardCycle).id,
                    })
                  }
                >
                  ■ SEAL CYCLE
                </button>
              )}
              {cycle.state === "CLOSED" && (
                <span className="border border-[var(--ink-3)] px-[10px] py-[4px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
                  ✓ CYCLE SEALED
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right — metrics + burndown */}
        <div className="flex flex-col items-end gap-[10px]">
          <div className="flex gap-[20px]">
            <div className="flex flex-col items-end gap-[1px]">
              <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                COMMITTED
              </span>
              <b className="cl-display text-[22px] font-black leading-none [font-variant-numeric:tabular-nums]">
                {String(stats.committed).padStart(2, "0")}
              </b>
            </div>
            <div className="flex flex-col items-end gap-[1px]">
              <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                SEALED
              </span>
              <b
                className="cl-display text-[22px] font-black leading-none [font-variant-numeric:tabular-nums]"
                style={{ color: "var(--cool)" }}
              >
                {String(stats.sealed).padStart(2, "0")}
              </b>
            </div>
            <div className="flex flex-col items-end gap-[1px]">
              <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                IN-FIELD
              </span>
              <b className="cl-display text-[22px] font-black leading-none [font-variant-numeric:tabular-nums]">
                {String(stats.field).padStart(2, "0")}
              </b>
            </div>
            <div className="flex flex-col items-end gap-[1px]">
              <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                HOLD
              </span>
              <b
                className={`cl-display text-[22px] font-black leading-none [font-variant-numeric:tabular-nums]${stats.hold > 0 ? " hot" : ""}`}
                style={stats.hold > 0 ? { color: "var(--hot)" } : undefined}
              >
                {String(stats.hold).padStart(2, "0")}
              </b>
            </div>
          </div>

          {/* Burndown */}
          <div className="flex flex-col items-end gap-[2px]">
            <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
              BURNDOWN
            </span>
            <Spark data={burn} width={150} height={30} accent="var(--hot)" />
          </div>
        </div>
      </div>

      {/* ── Progress bar ────────────────────────────────────────────── */}
      <div className="mb-[16px] flex items-center gap-[12px]">
        <div className="h-[8px] flex-1 border border-[var(--rule)] bg-[var(--bg-3)]">
          <i
            className="block h-full transition-[width] duration-[240ms]"
            style={{ width: `${stats.pct}%`, background: "var(--cool)" }}
          />
        </div>
        <span className="whitespace-nowrap text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
          {stats.pct}% SEALED · {stats.checkDone}/{stats.checkTot} CHECKS
        </span>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      {items.length === 0 ? (
        /* Empty state */
        <div className="py-[60px] text-center">
          <div className="mb-[8px] text-[32px] text-[var(--ink-mute)]">∅</div>
          <div className="mb-[12px] text-[var(--fs-xs)] uppercase tracking-[0.18em] text-[var(--ink-3)]">
            NO TASKS IN {cycle.label}
          </div>
          <button
            type="button"
            className="cursor-pointer border border-[var(--hot)] px-[12px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-colors hover:bg-[var(--hot)] hover:text-black"
            onClick={handleCommitTask}
          >
            + COMMIT TASK
          </button>
        </div>
      ) : (
        /* Disposition lanes */
        <div
          className="grid gap-[18px]"
          style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
        >
          {byCol.map((g) => (
            <div
              key={g.cid}
              className="mb-[16px] break-inside-avoid"
              data-testid={`cv-lane-${g.cid}`}
            >
              {/* Lane header */}
              <div className="mb-[4px] flex items-center gap-[6px] border-b border-[var(--rule)] pb-[5px]">
                <StatePip col={g.cid} />
                <span className="cl-display text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]">
                  {COL_LABEL[g.cid]}
                </span>
                <span
                  className="ml-auto text-[var(--fs-xs)] [font-variant-numeric:tabular-nums] text-[var(--ink-3)]"
                  data-testid={`cv-lane-count-${g.cid}`}
                >
                  {String(g.items.length).padStart(2, "0")}
                </span>
              </div>

              {/* Task rows */}
              {g.items.map((t) => {
                const [d, total] =
                  t.checks.length >= 2 ? [t.checks[0], t.checks[1]] : [0, 0];

                return (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`cv-row-${t.id}`}
                    className="flex w-full cursor-pointer items-center gap-[8px] border-b border-dotted border-[var(--rule)] py-[5px] px-[2px] text-left transition-colors duration-[120ms] hover:bg-[var(--bg-2)] focus:outline-[1px] focus:outline-[var(--hot)] focus:outline-offset-[-1px]"
                    onClick={() => handleEditTask(t.id)}
                  >
                    {/* Priority chip */}
                    <span className="flex-shrink-0">
                      <PriChip pri={t.priority} />
                    </span>

                    {/* Code */}
                    <span className="flex-shrink-0 text-[var(--fs-s)] [font-variant-numeric:tabular-nums] text-[var(--ink)]">
                      {t.code}
                    </span>

                    {/* Title + HOLD tag */}
                    <span className="flex min-w-0 flex-1 items-center gap-[6px] overflow-hidden">
                      {t.hold && (
                        <span
                          className="flex-shrink-0"
                          data-testid={`cv-hold-${t.id}`}
                        >
                          <HoldTag />
                        </span>
                      )}
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-s)] text-[var(--ink)]">
                        {t.title}
                      </span>
                    </span>

                    {/* Project */}
                    <span className="flex-shrink-0 text-[var(--fs-xs)] tracking-[0.06em] text-[var(--ink-3)]">
                      {t.project ?? "—"}
                    </span>

                    {/* Assignee */}
                    <span className="flex-shrink-0 text-[var(--fs-xs)] text-[var(--ink-2)]">
                      {t.assignee ?? "—"}
                    </span>

                    {/* Checks */}
                    <span className="flex-shrink-0 text-right text-[var(--fs-xs)] [font-variant-numeric:tabular-nums] text-[var(--ink-3)]">
                      {total ? `${d}/${total}` : "—"}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
