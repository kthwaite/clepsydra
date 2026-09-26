/**
 * TimelineView — gantt for the Tasking board (Stone & Lamp).
 *
 * Design source: Stone & Lamp phase 5 mockup `TaskingTimeline.dc.html`.
 *
 * Behaviour notes:
 *   - windowOf is derived from cycle dates (decision 14), not hardcoded.
 *   - UNFILED grouping: tasks with a null project are collected into a
 *     synthetic "No project" group at the end. A slug with no PROJECT page is
 *     a synthesized ProjectScope, so its tasks group under their own header.
 *   - Empty state: when no dated cycles exist or no task has a due date, a
 *     centred "No scheduled tasks" notice is shown instead of a broken axis.
 *   - projects prop: ALL → all project scopes, single scope (opFilter set) →
 *     that scope only (threaded from TaskingScreen).
 *   - parseDay ISO-only (see timeline-math.ts for deviation docs).
 *   - Colours come from theme tokens only (CSS vars / token utilities), so
 *     the charcoal night theme restyles every fill.
 *   - A today marker (accent) is drawn when today falls inside the window.
 *   - Bars shorter than five days carry their status label outside the bar.
 */

import { useMemo } from "react";
import type { BoardCycle, BoardTask } from "#/api/board";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { Tick } from "../codex/Tick";
import {
  type ColLabelFn,
  cycleStateLabel,
  HealthDot,
  priColor,
} from "./board-constants";
import type { ProjectScope } from "./board-projects";
import { parseDay, pct, taskRange, windowOf } from "./timeline-math";

// ── types ─────────────────────────────────────────────────────────────────────

interface ScheduledTask {
  task: BoardTask;
  s: number;
  e: number;
}

interface TLGroup {
  scope: ProjectScope | null; // null = UNFILED pseudo-group
  items: ScheduledTask[];
}

const DAY_MS = 864e5;

/** Bars spanning fewer days than this carry their label outside the bar. */
const INSIDE_LABEL_MIN_DAYS = 5;

/** Label column width shared by the axis and every row. */
const ROW_GRID = "grid grid-cols-[320px_minmax(0,1fr)]";

// ── bar look per status (token fills only) ───────────────────────────────────

const TL_BAR_BASE =
  "absolute top-2.5 flex h-[26px] cursor-pointer items-center gap-[7px] overflow-hidden whitespace-nowrap rounded-full px-2.5 text-[12.5px] transition-colors hover:z-[3]";

function tlBarLook(status: string, hold: boolean): string {
  if (hold)
    return "bg-[color-mix(in_oklab,var(--hot)_10%,transparent)] text-hot";
  if (status === "SEALED")
    return "bg-transparent text-mute shadow-[inset_0_0_0_1px_var(--rule)]";
  if (status === "FIELD")
    return "bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-accent";
  if (status === "REVIEW")
    return "bg-raise text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]";
  return "bg-sink text-ink-2"; // INTAKE, TRIAGE and any other status
}

/** Label colour for a bar whose label sits outside it. */
function tlOutsideLabelColor(status: string, hold: boolean): string {
  if (hold) return "text-hot";
  if (status === "SEALED") return "text-mute";
  if (status === "FIELD") return "text-accent";
  if (status === "REVIEW") return "text-ink";
  return "text-ink-2";
}

// ── cycle band fill (axis) ───────────────────────────────────────────────────

function tlBandFill(state: string): string {
  if (state === "ACTIVE") return "bg-accent-tint";
  if (state === "CLOSED") return "bg-sink";
  return "bg-raise"; // PLANNED (and any other state)
}

/** ISO day → "26 May". */
function fmtDay(iso: string): string {
  const ms = parseDay(iso);
  if (ms === null) return iso;
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function bandWhen(c: BoardCycle): string {
  if (c.start) return fmtDay(c.start);
  if (c.end) return `to ${fmtDay(c.end)}`;
  return "";
}

/** Local midnight today as ms epoch. */
function todayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── TimelineView ──────────────────────────────────────────────────────────────

export interface TimelineViewProps {
  /** Op-filtered tasks from TaskingScreen (already filtered by opFilter). */
  tasks: BoardTask[];
  /**
   * Project scopes to group by (operations ∪ task slugs):
   *   opFilter=ALL → all scopes
   *   opFilter=<key> → caller passes only the single active scope
   * TaskingScreen threads this correctly; tests may pass any subset.
   */
  projects: ProjectScope[];
  cycles: BoardCycle[];
  /** Override for edit handler; defaults to store setEditTaskId. */
  onEditTask?: (id: string) => void;
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function TimelineView({
  tasks,
  projects,
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

  // Build groups: one per project scope that has ≥1 scheduled task in
  // `tasks`, plus an UNFILED pseudo-group for tasks with no project.
  const { groups, unscheduled } = useMemo(() => {
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

    // Group by slug. A slug-less op has no slug for a task to carry, so it
    // yields no group (and never absorbs null-project tasks via null===null).
    const scopeGroups: TLGroup[] = projects
      .filter((scope) => scope.slug !== null)
      .map((scope) => ({
        scope,
        items: scheduled
          .filter((t) => t.project === scope.slug)
          .sort((a, b) => a._s - b._s)
          .map((t) => ({ task: t, s: t._s, e: t._e })),
      }))
      .filter((g) => g.items.length > 0);

    // UNFILED: tasks with null/empty project
    const unfiledItems = scheduled
      .filter((t) => !t.project)
      .sort((a, b) => a._s - b._s)
      .map((t) => ({ task: t, s: t._s, e: t._e }));

    const grps: TLGroup[] =
      unfiledItems.length > 0
        ? [...scopeGroups, { scope: null, items: unfiledItems }]
        : scopeGroups;

    return { groups: grps, unscheduled: unscheduledCount };
  }, [tasks, projects]);

  // ── Empty state ────────────────────────────────────────────────────────────

  const hasScheduledTasks = groups.length > 0;

  if (!win || !hasScheduledTasks) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2.5"
        data-testid="tl-empty"
      >
        <Tick variant="faint" />
        <span className="font-serif text-[19px] italic text-mute">
          No scheduled tasks
        </span>
      </div>
    );
  }

  // ── Axis band helpers ──────────────────────────────────────────────────────
  const displayWindow = win;

  function bandStyle(c: BoardCycle): React.CSSProperties | null {
    const s = parseDay(c.start);
    const e = parseDay(c.end);
    if (s === null && e === null) return null;
    const l = s !== null ? pct(s, displayWindow) : 0;
    const r = e !== null ? pct(e, displayWindow) : 100;
    const w = Math.max(0, r - l);
    return { left: `${l}%`, width: `${w}%` };
  }

  const today = todayMs();
  const todayPct =
    today >= displayWindow.start && today <= displayWindow.end
      ? pct(today, displayWindow)
      : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full flex-col overflow-auto px-3 pb-6"
      data-testid="tl-root"
    >
      {/* ── Axis ─────────────────────────────────────────────────────── */}
      <div className={cn(ROW_GRID, "sticky top-0 z-[4] h-[52px] bg-ground")}>
        <span className="self-center px-5 text-[12.5px] text-mute">
          Project / task
        </span>
        <div className="relative">
          {datedCycles.map((c) => {
            const style = bandStyle(c);
            if (!style) return null;
            const active = c.state === "ACTIVE";
            return (
              <div
                key={c.id}
                className={`absolute top-0 bottom-0 px-[3px] ${c.state}`}
                style={style}
                data-testid={`tl-band-${c.code}`}
              >
                <div
                  className={cn(
                    "flex h-full flex-col justify-center gap-0.5 overflow-hidden rounded-xl px-3.5",
                    tlBandFill(c.state),
                  )}
                >
                  <span
                    className={cn(
                      "whitespace-nowrap text-[13px]",
                      active ? "font-medium text-accent" : "text-ink-2",
                    )}
                  >
                    {c.code}
                  </span>
                  <span className="whitespace-nowrap text-[12px] text-mute">
                    {bandWhen(c)} · {cycleStateLabel(c.state)}
                  </span>
                </div>
              </div>
            );
          })}
          {todayPct !== null && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-[1] w-px bg-accent"
              style={{ left: `${todayPct}%` }}
              data-testid="tl-today"
            >
              <span className="absolute bottom-0.5 left-1.5 rounded-full bg-ground px-1.5 text-[12px] leading-4 text-accent">
                Today
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      <div className="flex-1">
        {groups.map((g) => {
          const groupKey = g.scope ? g.scope.key : "UNFILED";

          return (
            <section
              key={groupKey}
              className="mt-6 flex flex-col"
              data-testid={`tl-grp-${groupKey}`}
            >
              {/* Group header */}
              <h2 className="mb-2.5 flex items-center gap-2.5 px-5 font-normal">
                <HealthDot health={g.scope?.health ?? "NONE"} />
                <span className="font-serif text-[22px] italic text-ink">
                  {g.scope ? g.scope.name : "No project"}
                </span>
                {g.scope && (
                  <span className="text-[12.5px] text-mute tabular-nums">
                    {g.scope.code}
                  </span>
                )}
                <span className="text-[12.5px] text-mute tabular-nums">
                  {g.items.length} scheduled
                </span>
              </h2>

              {/* Task rows */}
              {g.items.map(({ task: t, s, e }) => {
                const l = pct(s, displayWindow);
                const w = Math.max(2.5, pct(e, displayWindow) - l);
                const hold = !!t.hold;
                const label = hold ? "Hold" : colLabel(t.status);
                const inside = (e - s) / DAY_MS >= INSIDE_LABEL_MIN_DAYS;
                const priBar = priColor(t.priority).bar;

                return (
                  <div
                    key={t.id}
                    className={cn(
                      ROW_GRID,
                      "h-[46px] rounded-[10px] hover:bg-raise",
                    )}
                    data-testid={`tl-row-${t.id}`}
                  >
                    {/* Label cell */}
                    <div className="flex min-w-0 items-center gap-2.5 px-5">
                      <span
                        className="h-3.5 w-[3px] flex-shrink-0 rounded-sm"
                        style={{ background: priBar }}
                      />
                      <span className="w-[118px] flex-shrink-0 truncate text-[12.5px] text-mute tabular-nums">
                        {t.code}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 truncate text-[14px]",
                          t.status === "SEALED" ? "text-mute" : "text-ink",
                        )}
                        title={t.title}
                      >
                        {t.title}
                      </span>
                    </div>

                    {/* Track cell */}
                    <div className="relative">
                      {/* Cycle gridlines */}
                      {datedCycles.map((c) => {
                        const cs = parseDay(c.start);
                        if (cs === null) return null;
                        return (
                          <span
                            key={c.id}
                            className="tl-grid absolute top-0 bottom-0 w-px"
                            style={{
                              left: `${pct(cs, displayWindow)}%`,
                              background:
                                c.state === "ACTIVE"
                                  ? "color-mix(in oklab, var(--accent) 22%, transparent)"
                                  : "var(--rule)",
                            }}
                          />
                        );
                      })}

                      {/* Today line */}
                      {todayPct !== null && (
                        <span
                          aria-hidden
                          className="tl-today pointer-events-none absolute top-0 bottom-0 z-[1] w-px bg-accent"
                          style={{ left: `${todayPct}%` }}
                        />
                      )}

                      {/* Task bar */}
                      <button
                        type="button"
                        className={cn(
                          TL_BAR_BASE,
                          tlBarLook(t.status, hold),
                          FOCUS_RING_NATIVE,
                          t.status,
                          hold && "hold",
                        )}
                        style={{ left: `${l}%`, width: `${w}%` }}
                        title={t.title}
                        aria-label={`Edit ${t.code}: ${t.title}, ${label}`}
                        data-testid={`tl-bar-${t.id}`}
                        onClick={() => handleEditTask(t.id)}
                      >
                        <span
                          className="h-2.5 w-[3px] flex-shrink-0 rounded-sm"
                          style={{ background: priBar }}
                        />
                        {inside && <span className="truncate">{label}</span>}
                      </button>
                      {!inside && (
                        <span
                          aria-hidden
                          className={cn(
                            "pointer-events-none absolute top-2.5 flex h-[26px] items-center whitespace-nowrap pl-2.5 text-[12.5px]",
                            tlOutsideLabelColor(t.status, hold),
                          )}
                          style={{ left: `${l + w}%` }}
                          data-testid={`tl-label-${t.id}`}
                        >
                          {label}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      {unscheduled > 0 && (
        <div
          className="mt-4 flex items-center gap-3 px-5 text-[13px] text-mute"
          data-testid="tl-foot"
        >
          <span className="text-ink-2 tabular-nums">
            {unscheduled} without a due date
          </span>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <span>In Backlog or Inbox</span>
        </div>
      )}
    </div>
  );
}
