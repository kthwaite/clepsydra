/**
 * CycleView — the Cycle view of the Tasking board (Stone & Lamp).
 *
 * Design source: the phase 5 mockup TaskingCycle.dc.html.
 *
 * - resolveCycle: exported pure helper; determines the displayed cycle from
 *   the persisted cycleSel store value and the live cycles array.
 * - board-stats: pure helpers compute committed/sealed/field/hold/
 *   check counts and sealed percentage.
 * - CycleView: renders the cycle strip (CycleStrip), the header (window ·
 *   state meta line, serif h2, goal, quiet lifecycle action), serif numeral
 *   stats + burndown Spark, the progress bar, and the status lanes.
 */

import { useMemo } from "react";
import type { BoardCycle, BoardTask } from "#/api/board";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { Spark } from "#/components/ui/spark";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import {
  COL_ORDER,
  type ColLabelFn,
  cycleStateLabel,
  fmtCycleWindow,
  PRI_ORDER,
  PriChip,
  StatePip,
} from "./board-constants";
import { checklistProgress, cycleStats } from "./board-stats";
import { CycleStrip } from "./CycleStrip";
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
  goal: "Tasks not assigned to a Cycle.",
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
  /** Every cycle on the board, in board order — drives the cycle strip. */
  cycles: BoardCycle[];
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
  cycles,
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
  const windowLabel = isBacklog
    ? "No cycle"
    : fmtCycleWindow(cycle.start, cycle.end);

  // Display label — the Backlog pseudo-cycle's stored label is "BACKLOG".
  const displayLabel = isBacklog ? "Backlog" : cycle.label;

  // State word colour. "OPEN" is the Backlog pseudo-cycle state.
  const stateClass =
    cycle.state === "ACTIVE"
      ? "text-accent"
      : cycle.state === "OPEN"
        ? "text-hot"
        : "text-mute";

  // Unassigned tasks, counted over the same slice the view shows.
  const backlogCount = useMemo(
    () => tasks.filter((t) => !t.cycle).length,
    [tasks],
  );

  function handleCommitTask() {
    const preset: { cycle?: string; project?: string } = {};
    if (!isBacklog) preset.cycle = cycle.code;
    if (activeProject) preset.project = activeProject;
    openTaskModal(preset);
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-10 pb-10 pt-9">
      <CycleStrip
        cycles={cycles}
        selectedCode={cycle.code}
        backlogCount={backlogCount}
      />

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="mt-8 flex flex-wrap items-start gap-12">
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span data-testid="cv-meta" className="text-[13px] text-mute">
            {windowLabel}
            <span aria-hidden="true"> · </span>
            <span className={stateClass}>
              {cycleStateLabel(isBacklog ? "BACKLOG" : cycle.state)}
            </span>
          </span>

          <h2 className="m-0 font-serif text-[36px] font-normal leading-[1.05] tracking-[-0.01em] text-ink">
            {displayLabel}
          </h2>

          {cycle.goal && (
            <p className="m-0 max-w-[560px] text-[15px] leading-[1.55] text-ink-2">
              {cycle.goal}
            </p>
          )}

          {!isBacklog && (
            <div className="mt-2 flex items-center gap-2.5">
              {cycle.state === "PLANNED" && isRealCycle(cycle) && (
                <Button
                  onPress={() =>
                    openCycleModal({ kind: "open", cycleId: cycle.id })
                  }
                >
                  Start cycle
                </Button>
              )}
              {cycle.state === "ACTIVE" && isRealCycle(cycle) && (
                <Button
                  onPress={() =>
                    openCycleModal({ kind: "seal", cycleId: cycle.id })
                  }
                >
                  Close cycle
                </Button>
              )}
              {cycle.state === "CLOSED" && (
                <span className="text-[13px] text-mute">Cycle closed</span>
              )}
            </div>
          )}
        </div>

        {/* Right — stats + burndown */}
        <div className="flex flex-shrink-0 flex-col items-end gap-[18px]">
          <dl className="m-0 flex gap-8">
            <Stat label="Tasks" value={stats.committed} />
            <Stat label="Done" value={stats.sealed} className="text-accent" />
            <Stat label="In progress" value={stats.field} />
            <Stat
              label="Blocked"
              value={stats.hold}
              hot={stats.hold > 0}
              className={stats.hold > 0 ? "text-hot" : undefined}
            />
          </dl>

          <div data-testid="cv-burndown" className="flex items-center gap-3">
            <span className="text-[12.5px] text-mute">Progress</span>
            {!burndownApplicable ? (
              <span className="text-[12.5px] text-mute">Not applicable</span>
            ) : burndownPending ? (
              <span className="text-[12.5px] text-mute">Loading</span>
            ) : burndownError ? (
              <span className="text-[12.5px] text-hot">Unavailable</span>
            ) : burndown.length === 0 ? (
              <span className="text-[12.5px] text-mute">No history</span>
            ) : (
              <figure
                className="m-0"
                aria-labelledby={`cycle-progress-caption-${cycle.id}`}
              >
                <div aria-hidden="true">
                  <Spark
                    data={burndown}
                    width={150}
                    height={30}
                    accent="var(--accent)"
                  />
                </div>
                <figcaption
                  id={`cycle-progress-caption-${cycle.id}`}
                  className="sr-only"
                >
                  Cycle progress: {burndown.join(", ")}
                </figcaption>
              </figure>
            )}
          </div>
        </div>
      </div>

      {/* ── Progress bar ────────────────────────────────────────────── */}
      <div className="mt-[26px] flex items-center gap-4">
        <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-sink">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-[240ms]"
            style={{ width: `${stats.pct}%` }}
          />
        </span>
        <span className="whitespace-nowrap text-[13px] tabular-nums text-mute">
          {stats.pct}% complete · {stats.checkDone} of {stats.checkTot}{" "}
          checklist items
        </span>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <span className="text-[15px] text-mute">
            No tasks in {displayLabel}
          </span>
          <Button onPress={handleCommitTask}>New task</Button>
        </div>
      ) : (
        <div className="mt-[34px] grid grid-cols-1 items-start gap-x-12 gap-y-[30px] min-[1400px]:grid-cols-2">
          {byCol.map((g) => (
            <section
              key={g.cid}
              className="flex min-w-0 flex-col gap-0.5"
              data-testid={`cv-lane-${g.cid}`}
            >
              <h3 className="m-0 mb-2 flex items-center gap-2.5 font-normal">
                <Tick variant={g.cid === "SEALED" ? "faint" : "live"} />
                <span className="font-serif text-[21px] italic text-ink">
                  {colLabel(g.cid)}
                </span>
                <span
                  className="text-[12.5px] tabular-nums text-mute"
                  data-testid={`cv-lane-count-${g.cid}`}
                >
                  {g.items.length}
                </span>
              </h3>

              {g.items.map((t) => {
                const { done: d, total } = checklistProgress(t.checks);

                return (
                  <div
                    key={t.id}
                    data-testid={`cv-row-${t.id}`}
                    className="pointer-events-none relative flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[14px] transition-colors hover:bg-raise"
                  >
                    <button
                      type="button"
                      aria-label={`Edit ${t.code}: ${t.title}`}
                      className={cn(
                        "pointer-events-auto absolute inset-0 z-0 cursor-pointer rounded-[10px] bg-transparent p-0 text-left",
                        FOCUS_RING_NATIVE,
                      )}
                      onClick={() => handleEditTask(t.id)}
                      data-testid={`cv-action-${t.id}`}
                    />
                    <span className="flex-shrink-0">
                      <InlineEditPopover
                        task={t}
                        field="priority"
                        testIdPrefix="cv"
                        colLabel={colLabel}
                      >
                        <PriChip pri={t.priority} />
                      </InlineEditPopover>
                    </span>

                    <span className="w-[168px] min-w-[72px] shrink truncate text-[13px] tabular-nums text-ink-2">
                      {t.code}
                    </span>

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

                    <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      {t.hold && (
                        <span
                          className="flex-shrink-0"
                          data-testid={`cv-hold-${t.id}`}
                        >
                          <span className="inline-flex h-[22px] items-center rounded-full bg-[color-mix(in_oklab,var(--hot)_10%,transparent)] px-[9px] text-[12px] text-hot">
                            Blocked
                          </span>
                        </span>
                      )}
                      <span
                        className={cn(
                          "truncate",
                          t.status === "SEALED" ? "text-mute" : "text-ink",
                        )}
                        title={t.title}
                      >
                        {t.title}
                      </span>
                    </span>

                    <span className="min-w-0 max-w-[112px] shrink truncate text-[12.5px] text-mute">
                      {t.project ?? "—"}
                    </span>

                    <span className="min-w-0 max-w-[96px] shrink truncate text-[12.5px] text-mute">
                      {t.assignee ?? "—"}
                    </span>

                    <span className="w-[34px] flex-shrink-0 text-right text-[12.5px] tabular-nums text-mute">
                      {total ? `${d}/${total}` : "—"}
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** One serif numeral stat: the label sits under the value, right-aligned. */
function Stat({
  label,
  value,
  hot,
  className,
}: {
  label: string;
  value: number;
  /** Marks the value as a warning (data attribute, not a class). */
  hot?: boolean;
  className?: string;
}) {
  return (
    <div className="flex flex-col-reverse items-end gap-1.5">
      <dt className="text-[12.5px] text-mute">{label}</dt>
      <dd
        className={cn(
          "m-0 font-serif text-[40px] leading-none tabular-nums",
          className,
        )}
        data-hot={hot ? "true" : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
