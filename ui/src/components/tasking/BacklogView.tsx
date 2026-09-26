/**
 * BacklogView — priority-grouped register for the TASKING board.
 *
 * - Receives pre-filtered `tasks` from TaskingScreen (same visibleTasks
 *   threading as KanbanView).
 * - Groups by priority P0→P3 (PRI_ORDER), empty groups dropped.
 * - Within each group: sorted by COL_ORDER index, then by due date asc;
 *   tasks with no due date sort last.
 * - Each row uses a native overlay button for click and keyboard activation.
 *   Priority and disposition cells remain independent popover triggers.
 * - Checklist mini-dots: 6px rounds, done = cobalt, open = faint.
 * - Stone & Lamp dense table (spec §5.6): no cell borders, sentence-case
 *   12.5px mute header, 40px rows, hover sink, the row being edited in
 *   accent-tint, tabular numerals. Group headers: tick + italic serif
 *   priority name + "P0 · n tasks" caption.
 *
 * Design source: TaskingBacklog.dc.html (Stone & Lamp phase 5 mockups).
 */

import { useMemo } from "react";
import type { BoardTask } from "#/api/board";
import { Tick, type TickVariant } from "#/components/codex/Tick";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { formatDayMonth } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import {
  COL_ORDER,
  type ColLabelFn,
  PRI_LABEL,
  PRI_ORDER,
  PriChip,
  StatePip,
} from "./board-constants";
import { checklistProgress } from "./board-stats";
import { InlineEditPopover } from "./InlineEditPopover";
import { QuickAddRow } from "./QuickAddRow";

/** Shared grid tracks for the header row and task rows. Narrower screens
 *  drop columns (display:none cells take no track) so the title keeps room:
 *  below 1400px Assignee and Estimate go, below xl Project and Checklist. */
const BK_COLS = cn(
  "grid items-center gap-x-4 px-3",
  "grid-cols-[168px_minmax(0,1fr)_132px_64px]",
  "xl:grid-cols-[168px_minmax(0,1fr)_110px_132px_64px_86px]",
  "min-[1400px]:grid-cols-[168px_minmax(0,1fr)_110px_132px_90px_76px_64px_86px]",
);

/** Cells shown from xl (Project, Checklist). */
const XL_ONLY = "max-xl:hidden";

/** Cells shown from 1400px (Assignee, Estimate). */
const WIDE_ONLY = "max-[1399px]:hidden";

/** Quick-add bar (44px) + 18px gap + column header (40px): where the
 *  sticky group headers dock. */
const GROUP_TOP = "top-[102px]";

/** Group tick: Critical hot, Low faint, the rest cobalt. */
function groupTick(pri: string): { variant: TickVariant; className?: string } {
  if (pri === "P0") return { variant: "live", className: "bg-hot" };
  if (pri === "P3") return { variant: "faint" };
  return { variant: "live" };
}

// ── groupBacklog — pure helper (unit-testable) ────────────────────────────────

export interface BacklogGroup {
  pri: string;
  items: BoardTask[];
}

/**
 * Groups and sorts tasks for the backlog register.
 *
 * Group order: P0 → P1 → P2 → P3 (PRI_ORDER); empty groups dropped.
 * Within each group:
 *   1. Primary: COL_ORDER index (INTAKE < TRIAGE < FIELD < REVIEW < SEALED)
 *   2. Secondary: due date ascending; null/absent due sorts last ("9" sentinel)
 */
export function groupBacklog(tasks: BoardTask[]): BacklogGroup[] {
  return PRI_ORDER.map((pri) => ({
    pri,
    items: tasks
      .filter((t) => t.priority === pri)
      .sort((a, b) => {
        const colDiff =
          COL_ORDER.indexOf(a.status as (typeof COL_ORDER)[number]) -
          COL_ORDER.indexOf(b.status as (typeof COL_ORDER)[number]);
        if (colDiff !== 0) return colDiff;
        // Plain string compare — locale-insensitive, correct for ISO dates
        const aDue = a.due ?? "9";
        const bDue = b.due ?? "9";
        return aDue < bDue ? -1 : aDue > bDue ? 1 : 0;
      }),
  })).filter((g) => g.items.length > 0);
}

// ── BacklogView ───────────────────────────────────────────────────────────────

export interface BacklogViewProps {
  /** Pre-filtered visible tasks (same as KanbanView.tasks). */
  tasks: BoardTask[];
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function BacklogView({ tasks, colLabel }: BacklogViewProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const editTaskId = useBoardStore((s) => s.editTaskId);

  const groups = useMemo(() => groupBacklog(tasks), [tasks]);

  return (
    <div className="h-full overflow-auto px-4 pb-6 text-[14px]">
      {/* Quick add + column header share one sticky block on ground. */}
      <div className="sticky top-0 z-[4] bg-ground">
        <div className="flex h-11 items-center rounded-[14px] bg-sink">
          <QuickAddRow
            preset={{}}
            testId="qa-backlog"
            className="h-full hover:bg-transparent focus:bg-transparent"
          />
        </div>

        <div
          className={cn(
            BK_COLS,
            "mt-[18px] h-10 text-[12.5px] text-mute [&>span]:truncate",
          )}
        >
          <span>Code</span>
          <span>Task</span>
          <span className={XL_ONLY}>Project</span>
          <span>Status</span>
          <span className={WIDE_ONLY}>Assignee</span>
          <span className={WIDE_ONLY}>Estimate</span>
          <span className="text-right">Due</span>
          <span className={XL_ONLY}>Checklist</span>
        </div>
      </div>

      {groups.length === 0 && (
        <div
          className="mt-2 rounded-xl bg-sink px-3 py-6 text-center text-[13px] text-mute"
          data-testid="bk-empty"
        >
          No tasks
        </div>
      )}

      {groups.map((g) => {
        const tick = groupTick(g.pri);
        const count =
          g.items.length === 1 ? "1 task" : `${g.items.length} tasks`;
        return (
          <section key={g.pri} className="flex flex-col">
            <h2
              data-testid={`bk-grp-hd-${g.pri}`}
              className={cn(
                "sticky z-[3] m-0 flex h-[46px] items-center gap-2.5 bg-ground px-3 pt-2 font-normal",
                GROUP_TOP,
              )}
            >
              <Tick variant={tick.variant} className={tick.className} />
              <span className="font-serif text-[21px] italic leading-none text-ink">
                {PRI_LABEL[g.pri]}
              </span>
              <span className="text-[12.5px] text-mute tabular-nums">
                {g.pri} · {count}
              </span>
            </h2>

            {g.items.map((t) => {
              const { done, total } = checklistProgress(t.checks);
              const selected = t.id === editTaskId;
              const sealed = t.status === "SEALED";

              return (
                <div
                  key={t.id}
                  data-testid={`bk-row-${t.id}`}
                  data-selected={selected ? "true" : undefined}
                  className={cn(
                    BK_COLS,
                    "pointer-events-none relative h-10 rounded-[10px] transition-colors duration-[120ms]",
                    selected ? "bg-accent-tint" : "hover:bg-sink",
                  )}
                >
                  <button
                    type="button"
                    aria-label={`Edit ${t.code}: ${t.title}`}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "pointer-events-auto absolute inset-0 z-0 cursor-pointer rounded-[10px] bg-transparent p-0 text-left",
                      FOCUS_RING_NATIVE,
                    )}
                    onClick={() => setEditTaskId(t.id)}
                    data-testid={`bk-action-${t.id}`}
                  />
                  {/* Code */}
                  <span
                    className={cn(
                      "truncate text-[13px] tabular-nums",
                      sealed ? "text-mute" : "text-ink-2",
                    )}
                  >
                    {t.code}
                  </span>

                  {/* Task — priority chip · Blocked pill · title */}
                  <span className="flex min-w-0 items-center gap-2.5">
                    <InlineEditPopover
                      task={t}
                      field="priority"
                      testIdPrefix="bk"
                      colLabel={colLabel}
                    >
                      <PriChip pri={t.priority} />
                    </InlineEditPopover>
                    {t.hold && (
                      <span
                        data-testid={`bk-hold-tag-${t.id}`}
                        className="inline-flex h-[22px] flex-shrink-0 items-center rounded-full bg-[color-mix(in_oklab,var(--hot)_10%,transparent)] px-[9px] text-[12px] text-hot"
                      >
                        Blocked
                      </span>
                    )}
                    <span
                      className={cn(
                        "truncate",
                        sealed ? "text-mute" : "text-ink",
                      )}
                      title={t.title}
                    >
                      {t.title}
                    </span>
                  </span>

                  {/* Project */}
                  <span
                    className={cn("truncate text-[13px] text-mute", XL_ONLY)}
                  >
                    {t.project ?? "—"}
                  </span>

                  {/* Status */}
                  <span className="flex min-w-0 items-center text-[13px] text-ink-2">
                    <InlineEditPopover
                      task={t}
                      field="status"
                      testIdPrefix="bk"
                      colLabel={colLabel}
                    >
                      <span className="flex items-center gap-2">
                        <StatePip col={t.status} />
                        <span className="truncate">{colLabel(t.status)}</span>
                      </span>
                    </InlineEditPopover>
                  </span>

                  {/* Assignee */}
                  <span
                    className={cn(
                      "truncate text-[13px]",
                      t.assignee ? "text-ink-2" : "text-mute",
                      WIDE_ONLY,
                    )}
                  >
                    {t.assignee ?? "—"}
                  </span>

                  {/* Estimate */}
                  <span
                    className={cn(
                      "truncate text-[13px] text-mute tabular-nums",
                      WIDE_ONLY,
                    )}
                  >
                    {t.estimate ?? "—"}
                  </span>

                  {/* Due */}
                  <span
                    className={cn(
                      "truncate text-right text-[13px] tabular-nums",
                      t.due ? "text-ink-2" : "text-mute",
                    )}
                    title={t.due ?? undefined}
                  >
                    {t.due ? formatDayMonth(t.due) : "—"}
                  </span>

                  {/* Checklist — mini dots */}
                  <span className={cn("flex gap-[3px]", XL_ONLY)}>
                    {Array.from(
                      { length: total },
                      (_, position) => position + 1,
                    ).map((position) => (
                      <span
                        key={`${t.id}-check-${position}`}
                        data-testid={`bk-dot-${t.id}-${position - 1}`}
                        data-done={position <= done ? "true" : "false"}
                        className={cn(
                          "block h-1.5 w-1.5 rounded-full",
                          position <= done ? "bg-accent" : "bg-faint",
                        )}
                      />
                    ))}
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
