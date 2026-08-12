/**
 * CycleView — sprint view for the TASKING board.
 *
 * Design source: docs/pkm-redesign/project/board-modes.jsx lines 195-299
 * (SprintView) + docs/pkm-redesign/project/styles-board.css .sp* classes.
 *
 * - resolveCycle: exported pure helper; determines the displayed cycle from
 *   the persisted cycleSel store value and the live cycles array.
 * - board-stats: pure helpers compute committed/sealed/field/hold/
 *   check counts and sealed percentage.
 * - CycleView: renders the header (window·state, h2 label, goal, actions),
 *   right-side metrics + historical burndown Spark, progress bar, and
 *   disposition lanes.
 */

import { useMemo } from "react";
import type { BoardCycle, BoardTask } from "#/api/board";
import { Spark } from "#/components/ui/spark";
import { pad2 } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import {
  COL_ORDER,
  type ColLabelFn,
  fmtCycleWindow,
  HoldTag,
  PRI_ORDER,
  PriChip,
  StatePip,
} from "./board-constants";
import { checklistProgress, cycleStats } from "./board-stats";
import { InlineEditPopover } from "./InlineEditPopover";

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
  burndown?: number[];
  burndownPending?: boolean;
  burndownError?: boolean;
  burndownApplicable?: boolean;
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function CycleView({
  cycle,
  tasks,
  activeProject,
  onEditTask,
  burndown = [],
  burndownPending = false,
  burndownError = false,
  burndownApplicable = true,
  colLabel,
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

  // Whether this is a real BoardCycle with an id (can open modals).
  // The BACKLOG pseudo-cycle has no `id` field; everything else is a real cycle.
  function isRealCycle(
    c: BoardCycle | typeof BACKLOG_PSEUDO_CYCLE,
  ): c is BoardCycle {
    return "id" in c && c.id !== undefined;
  }

  // Whether this is the BACKLOG pseudo-cycle (no id → can't open modals)
  const isBacklog = cycle.code === "BACKLOG";

  // Window label
  const windowLabel = fmtCycleWindow(cycle.start, cycle.end);

  // State label color — mirrors .sp-state.* in styles-board.css
  // Note: "OPEN" is the BACKLOG pseudo-cycle state (uncommitted tasking).
  const stateColor =
    cycle.state === "ACTIVE"
      ? "var(--cool)"
      : cycle.state === "PLANNED"
        ? "var(--ink-2)"
        : cycle.state === "CLOSED"
          ? "var(--ink-3)"
          : cycle.state === "OPEN"
            ? "var(--warn)" // BACKLOG pseudo-cycle
            : "var(--ink-mute)";

  function handleCommitTask() {
    const preset: { cycle?: string; project?: string } = {};
    if (!isBacklog) preset.cycle = cycle.code;
    if (activeProject) preset.project = activeProject;
    openTaskModal(preset);
  }

  return (
    <div className="cl-mono h-full overflow-y-auto px-[var(--pad)] py-[16px]">
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
              {cycle.state === "PLANNED" && isRealCycle(cycle) && (
                <button
                  type="button"
                  className="cursor-pointer border border-[var(--hot)] px-[12px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-colors hover:bg-[var(--hot)] hover:text-black"
                  onClick={() =>
                    openCycleModal({
                      kind: "open",
                      cycleId: cycle.id,
                    })
                  }
                >
                  ▶ OPEN CYCLE
                </button>
              )}
              {cycle.state === "ACTIVE" && isRealCycle(cycle) && (
                <button
                  type="button"
                  className="cursor-pointer border border-[var(--hot)] px-[12px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-colors hover:bg-[var(--hot)] hover:text-black"
                  onClick={() =>
                    openCycleModal({
                      kind: "seal",
                      cycleId: cycle.id,
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
                {pad2(stats.committed)}
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
                {pad2(stats.sealed)}
              </b>
            </div>
            <div className="flex flex-col items-end gap-[1px]">
              <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                IN-FIELD
              </span>
              <b className="cl-display text-[22px] font-black leading-none [font-variant-numeric:tabular-nums]">
                {pad2(stats.field)}
              </b>
            </div>
            <div className="flex flex-col items-end gap-[1px]">
              <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
                HOLD
              </span>
              <b
                className="cl-display text-[22px] font-black leading-none [font-variant-numeric:tabular-nums]"
                data-hot={stats.hold > 0 ? "true" : undefined}
                style={stats.hold > 0 ? { color: "var(--hot)" } : undefined}
              >
                {pad2(stats.hold)}
              </b>
            </div>
          </div>

          {/* Burndown */}
          <div className="flex flex-col items-end gap-[2px]">
            <span className="text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
              BURNDOWN
            </span>
            {!burndownApplicable ? (
              <span className="text-[var(--fs-xs)] text-[var(--ink-mute)]">
                NOT APPLICABLE
              </span>
            ) : burndownPending ? (
              <span className="text-[var(--fs-xs)] text-[var(--ink-mute)]">
                LOADING
              </span>
            ) : burndownError ? (
              <span className="text-[var(--fs-xs)] text-[var(--hot)]">
                UNAVAILABLE
              </span>
            ) : burndown.length === 0 ? (
              <span className="text-[var(--fs-xs)] text-[var(--ink-mute)]">
                NO HISTORY
              </span>
            ) : (
              <div aria-label={`Cycle burndown: ${burndown.join(", ")}`}>
                <Spark
                  data={burndown}
                  width={150}
                  height={30}
                  accent="var(--hot)"
                />
              </div>
            )}
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
        <div className="grid grid-cols-2 gap-[18px]">
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
                  {colLabel(g.cid)}
                </span>
                <span
                  className="ml-auto text-[var(--fs-xs)] [font-variant-numeric:tabular-nums] text-[var(--ink-3)]"
                  data-testid={`cv-lane-count-${g.cid}`}
                >
                  {pad2(g.items.length)}
                </span>
              </div>

              {/* Task rows */}
              {g.items.map((t) => {
                const { done: d, total } = checklistProgress(t.checks);

                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    data-testid={`cv-row-${t.id}`}
                    className="flex w-full cursor-pointer items-center gap-[8px] border-b border-dotted border-[var(--rule)] py-[5px] px-[2px] text-left transition-colors duration-[120ms] hover:bg-[var(--bg-2)] focus:outline-[1px] focus:outline-[var(--hot)] focus:outline-offset-[-1px]"
                    onClick={() => handleEditTask(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleEditTask(t.id);
                      }
                    }}
                  >
                    {/* Priority chip */}
                    <span className="flex-shrink-0">
                      <InlineEditPopover
                        task={t}
                        field="priority"
                        testIdPrefix="cv"
                      >
                        <PriChip pri={t.priority} />
                      </InlineEditPopover>
                    </span>

                    {/* Code */}
                    <span className="flex-shrink-0 text-[var(--fs-s)] [font-variant-numeric:tabular-nums] text-[var(--ink)]">
                      {t.code}
                    </span>

                    {/* Status pip */}
                    <span className="flex-shrink-0">
                      <InlineEditPopover
                        task={t}
                        field="status"
                        testIdPrefix="cv"
                        colLabel={colLabel}
                      >
                        <StatePip col={t.status} />
                      </InlineEditPopover>
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
                      <span
                        className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-s)] text-[var(--ink)]"
                        title={t.title}
                      >
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
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
