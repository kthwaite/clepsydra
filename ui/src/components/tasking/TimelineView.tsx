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
import { useBoardStore } from "#/store/board";
import { COL_LABEL, fmtCycleWindow, HealthDot } from "./board-constants";
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
}

export function TimelineView({
  tasks,
  operations,
  cycles,
  onEditTask,
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
    <div className="tl" data-testid="tl-root">
      {/* ── Axis ─────────────────────────────────────────────────────── */}
      <div className="tl-axis">
        <div className="tl-axis-label">
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-3)]">
            OPERATION / TASK
          </span>
        </div>
        <div className="tl-axis-track">
          {datedCycles.map((c) => {
            const style = bandStyle(c);
            if (!style) return null;
            const winLabel = fmtCycleWindow(c.start, c.end).split(" — ")[0];
            return (
              <div
                key={c.id}
                className={`tl-band ${c.state}`}
                style={style}
                data-testid={`tl-band-${c.code}`}
              >
                <span className="tl-band-lbl">{c.code}</span>
                <span className="tl-band-win">{winLabel}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      <div className="tl-body">
        {groups.map((g) => {
          const groupKey = g.op ? (g.op.project ?? g.op.code) : "UNFILED";

          return (
            <div
              key={groupKey}
              className="tl-grp"
              data-testid={`tl-grp-${groupKey}`}
            >
              {/* Group header */}
              <div className="tl-grp-hd">
                <HealthDot health={g.op ? g.op.health : "NONE"} />
                <span className="tl-grp-code">
                  {g.op ? g.op.code : "UNFILED"}
                </span>
                <span className="tl-grp-name">
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
                    className="tl-row"
                    data-testid={`tl-row-${t.id}`}
                  >
                    {/* Label cell */}
                    <div className="tl-row-label">
                      <span className={`tl-pri ${t.priority}`} />
                      <span className="tl-row-id">{t.code}</span>
                      <span className="tl-row-title" title={t.title}>
                        {t.title}
                      </span>
                    </div>

                    {/* Track cell */}
                    <div className="tl-row-track">
                      {/* Cycle gridlines */}
                      {datedCycles.map((c) => {
                        const cs = parseDay(c.start);
                        if (cs === null) return null;
                        return (
                          <span
                            key={c.id}
                            className={`tl-grid ${c.state}`}
                            style={{ left: `${pct(cs, win!)}%` }}
                          />
                        );
                      })}

                      {/* Task bar */}
                      <button
                        type="button"
                        className={`tl-bar ${t.status}${t.hold ? " hold" : ""}`}
                        style={{ left: `${l}%`, width: `${w}%` }}
                        title={t.title}
                        data-testid={`tl-bar-${t.id}`}
                        onClick={() => handleEditTask(t.id)}
                      >
                        <span className={`tl-bar-pri ${t.priority}`} />
                        <span className="tl-bar-txt">
                          {t.code} · {COL_LABEL[t.status] ?? t.status}
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
        <div className="tl-foot" data-testid="tl-foot">
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-2)]">
            {String(unscheduled).padStart(2, "0")} UNSCHEDULED
          </span>
          <span className="cl-mono text-[var(--fs-xs)] text-[var(--ink-4)]">
            — no due date · held in backlog / intake
          </span>
        </div>
      )}
    </div>
  );
}
