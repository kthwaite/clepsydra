/**
 * TimelineView — dossier-style gantt for the Tasking board.
 *
 * Design source:
 *   docs/pkm-redesign/project/board-modes.jsx  lines 301-390 (TimelineView)
 *   docs/pkm-redesign/project/styles-board.css .tl* classes
 *
 * Deviations from prototype:
 *   - windowOf is derived from cycle dates (decision 14), not hardcoded.
 *   - UNFILED grouping: tasks whose project is null or doesn't match any
 *     operation are collected into a synthetic "UNFILED" group at the end.
 *   - Empty state: when no dated cycles exist or no task has a due date, a
 *     centered "— NOTHING SCHEDULED —" notice is shown instead of a broken axis.
 *   - operations prop: ALL → all operations, single op (opFilter set) → that
 *     op's operation only (threaded from TaskingScreen).
 *   - parseDay ISO-only (see timeline-math.ts for deviation docs).
 */

import { useMemo } from "react";
import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { pad2 } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import { type ColLabelFn, fmtCycleWindow, HealthDot } from "./board-constants";
import { parseDay, pct, taskRange, windowOf } from "./timeline-math";

// ── types ─────────────────────────────────────────────────────────────────────

interface ScheduledTask {
  task: BoardTask;
  s: number;
  e: number;
}

interface TLGroup {
  op: BoardOperation | null; // null = UNFILED pseudo-group
  items: ScheduledTask[];
}

// ── shared priority color map (tl-pri, tl-bar-pri) ──────────────────────────

const TL_PRI_COLOR: Record<string, string> = {
  P0: "var(--hot)",
  P1: "var(--warn)",
  P2: "var(--cool)",
};

function tlPriColor(priority: string): string {
  return TL_PRI_COLOR[priority] ?? "var(--ink-4)";
}

// ── bar status → border/background classes (tl-bar) ─────────────────────────

const TL_BAR_BASE =
  "absolute top-1/2 h-[16px] -translate-y-1/2 flex items-center gap-[5px] border px-[5px] cursor-pointer overflow-hidden transition-colors duration-[120ms] hover:border-[var(--hot)] hover:bg-[var(--bg)] hover:z-[3]";

function tlBarStateClass(status: string, hold: boolean): string {
  const bg =
    status === "SEALED" ? "bg-[var(--bg-2)] opacity-70" : "bg-[var(--bg-3)]";
  const border = hold
    ? "border-[var(--hot)] border-dashed"
    : status === "FIELD"
      ? "border-[var(--cool)]"
      : status === "REVIEW"
        ? "border-[var(--warn)]"
        : status === "SEALED"
          ? "border-[var(--ink-faint)] border-dashed"
          : "border-[var(--ink-3)]";
  return `${border} ${bg}`;
}

// ── cycle band/gridline tint (tl-band, tl-grid) ──────────────────────────────

function tlBandTint(state: string): string {
  if (state === "ACTIVE")
    return "color-mix(in oklab, var(--cool) 9%, transparent)";
  if (state === "CLOSED")
    return "color-mix(in oklab, var(--ink-mute) 14%, transparent)";
  return "transparent"; // PLANNED (and any other state)
}

// ── TimelineView ──────────────────────────────────────────────────────────────

export interface TimelineViewProps {
  /** Op-filtered tasks from TaskingScreen (already filtered by opFilter). */
  tasks: BoardTask[];
  /**
   * Operations to group by:
   *   opFilter=ALL → all operations
   *   opFilter=<key> → caller passes only the single active operation
   * TaskingScreen threads this correctly; tests may pass any subset.
   */
  operations: BoardOperation[];
  cycles: BoardCycle[];
  /** Override for edit handler; defaults to store setEditTaskId. */
  onEditTask?: (id: string) => void;
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function TimelineView({
  tasks,
  operations,
  cycles,
  onEditTask,
  colLabel,
}: TimelineViewProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const handleEditTask = onEditTask ?? setEditTaskId;

  // Derive display window from cycle dates (decision 14)
  const win = useMemo(() => windowOf(cycles), [cycles]);

  // Dated cycles only (need both pct-computable bounds for band rendering)
  const datedCycles = useMemo(
    () =>
      cycles.filter(
        (c) => parseDay(c.start) !== null || parseDay(c.end) !== null,
      ),
    [cycles],
  );

  // Build groups: one per operation that has ≥1 scheduled task in `tasks`,
  // plus an UNFILED pseudo-group for tasks with no matching operation.
  const { groups, unscheduled } = useMemo(() => {
    const knownProjects = new Set(
      operations.map((op) => op.project).filter(Boolean),
    );

    // Partition tasks into scheduled vs unscheduled
    const scheduled: (BoardTask & { _s: number; _e: number })[] = [];
    let unscheduledCount = 0;

    for (const t of tasks) {
      const range = taskRange(t);
      if (range === null) {
        unscheduledCount++;
      } else {
        scheduled.push({ ...t, _s: range.s, _e: range.e });
      }
    }

    // Group by operation
    const opGroups: TLGroup[] = operations
      .map((op) => ({
        op,
        items: scheduled
          .filter((t) => t.project === op.project)
          .sort((a, b) => a._s - b._s)
          .map((t) => ({ task: t, s: t._s, e: t._e })),
      }))
      .filter((g) => g.items.length > 0);

    // UNFILED: tasks with null/empty project or project not in any op
    const unfiledItems = scheduled
      .filter((t) => !t.project || !knownProjects.has(t.project))
      .sort((a, b) => a._s - b._s)
      .map((t) => ({ task: t, s: t._s, e: t._e }));

    const grps: TLGroup[] =
      unfiledItems.length > 0
        ? [...opGroups, { op: null, items: unfiledItems }]
        : opGroups;

    return { groups: grps, unscheduled: unscheduledCount };
  }, [tasks, operations]);

  // ── Empty state ────────────────────────────────────────────────────────────

  const hasScheduledTasks = groups.length > 0;

  if (!win || !hasScheduledTasks) {
    return (
      <div
        className="cl-mono flex h-full items-center justify-center text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]"
        data-testid="tl-empty"
      >
        — NOTHING SCHEDULED —
      </div>
    );
  }

  // ── Axis band helpers ──────────────────────────────────────────────────────

  function bandStyle(c: BoardCycle): React.CSSProperties | null {
    const s = parseDay(c.start);
    const e = parseDay(c.end);
    if (s === null && e === null) return null;
    const l = s !== null ? pct(s, win!) : 0;
    const r = e !== null ? pct(e, win!) : 100;
    const w = Math.max(0, r - l);
    return { left: `${l}%`, width: `${w}%` };
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col overflow-auto" data-testid="tl-root">
      {/* ── Axis ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-[2] grid grid-cols-[240px_1fr] border-b border-[var(--rule)] bg-[var(--bg-2)]">
        <div className="flex items-center border-r border-[var(--rule)] px-[var(--pad)]">
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-3)]">
            OPERATION / TASK
          </span>
        </div>
        <div className="relative h-[34px] overflow-hidden">
          {datedCycles.map((c) => {
            const style = bandStyle(c);
            if (!style) return null;
            const winLabel = fmtCycleWindow(c.start, c.end).split(" — ")[0];
            const lblColor =
              c.state === "ACTIVE" ? "var(--cool)" : "var(--ink-2)";
            return (
              <div
                key={c.id}
                className={`absolute top-0 bottom-0 flex items-center gap-[6px] overflow-hidden border-l border-r border-[var(--rule)] px-[6px] ${c.state}`}
                style={{ ...style, background: tlBandTint(c.state) }}
                data-testid={`tl-band-${c.code}`}
              >
                <span
                  className="cl-mono whitespace-nowrap text-[var(--fs-xs)] tracking-[0.1em]"
                  style={{ color: lblColor }}
                >
                  {c.code}
                </span>
                <span className="cl-mono whitespace-nowrap text-[var(--fs-xs)] tracking-[0.06em] text-[var(--ink-4)]">
                  {winLabel}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      <div className="flex-1">
        {groups.map((g) => {
          const groupKey = g.op ? (g.op.project ?? g.op.code) : "UNFILED";

          return (
            <div
              key={groupKey}
              className="border-b border-[var(--rule)]"
              data-testid={`tl-grp-${groupKey}`}
            >
              {/* Group header */}
              <div className="flex items-center gap-[8px] border-b border-[var(--ink-3)] bg-[var(--bg)] px-[var(--pad)] py-[6px]">
                <HealthDot health={g.op ? g.op.health : "NONE"} />
                <span className="cl-mono text-[var(--fs-s)] tracking-[0.08em] text-[var(--ink)]">
                  {g.op ? g.op.code : "UNFILED"}
                </span>
                <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.06em] text-[var(--ink-3)]">
                  {g.op ? g.op.name : "UNFILED TASKS"}
                </span>
              </div>

              {/* Task rows */}
              {g.items.map(({ task: t, s, e }) => {
                const l = pct(s, win!);
                const w = Math.max(2.5, pct(e, win!) - l);

                return (
                  <div
                    key={t.id}
                    className="grid grid-cols-[240px_1fr] items-center border-b border-dotted border-[var(--rule)] hover:bg-[var(--bg-2)]"
                    data-testid={`tl-row-${t.id}`}
                  >
                    {/* Label cell */}
                    <div className="flex min-w-0 items-center gap-[7px] border-r border-[var(--rule)] px-[var(--pad)] py-[6px]">
                      <span
                        className="h-[13px] w-[3px] flex-shrink-0"
                        style={{ background: tlPriColor(t.priority) }}
                      />
                      <span className="cl-mono flex-shrink-0 text-[var(--fs-xs)] text-[var(--ink-2)] [font-variant-numeric:tabular-nums]">
                        {t.code}
                      </span>
                      <span
                        className="cl-mono min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-xs)] uppercase tracking-[0.04em] text-[var(--ink-3)]"
                        title={t.title}
                      >
                        {t.title}
                      </span>
                    </div>

                    {/* Track cell */}
                    <div className="relative min-h-[30px]">
                      {/* Cycle gridlines */}
                      {datedCycles.map((c) => {
                        const cs = parseDay(c.start);
                        if (cs === null) return null;
                        return (
                          <span
                            key={c.id}
                            className="tl-grid absolute top-0 bottom-0 w-px"
                            style={{
                              left: `${pct(cs, win!)}%`,
                              background:
                                c.state === "ACTIVE"
                                  ? "color-mix(in oklab, var(--cool) 22%, transparent)"
                                  : "var(--rule)",
                            }}
                          />
                        );
                      })}

                      {/* Task bar */}
                      <button
                        type="button"
                        className={`${TL_BAR_BASE} ${tlBarStateClass(t.status, !!t.hold)} ${t.status}${t.hold ? " hold" : ""}`}
                        style={{ left: `${l}%`, width: `${w}%` }}
                        title={t.title}
                        data-testid={`tl-bar-${t.id}`}
                        onClick={() => handleEditTask(t.id)}
                      >
                        <span
                          className="h-[8px] w-[3px] flex-shrink-0"
                          style={{ background: tlPriColor(t.priority) }}
                        />
                        <span className="cl-mono whitespace-nowrap text-[var(--fs-xs)] tracking-[0.04em] text-[var(--ink-2)]">
                          {t.code} · {colLabel(t.status)}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      {unscheduled > 0 && (
        <div
          className="flex items-center gap-[10px] border-t border-[var(--rule)] px-[var(--pad)] py-[7px]"
          data-testid="tl-foot"
        >
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-2)]">
            {pad2(unscheduled)} UNSCHEDULED
          </span>
          <span className="cl-mono text-[var(--fs-xs)] text-[var(--ink-4)]">
            — no due date · held in backlog / intake
          </span>
        </div>
      )}
    </div>
  );
}
