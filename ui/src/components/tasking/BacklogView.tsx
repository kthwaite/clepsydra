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
 * - Checklist mini-dots: small squares, done=filled cool accent.
 *
 * Design source: docs/pkm-redesign/project/board-modes.jsx lines 128-193
 * and .bk* rules in docs/pkm-redesign/project/styles-board.css.
 */

import { useMemo } from "react";
import type { BoardTask } from "#/api/board";
import { pad2 } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import {
  COL_ORDER,
  type ColLabelFn,
  PRI_LABEL,
  PRI_ORDER,
  PriChip,
  priColor,
  StatePip,
} from "./board-constants";
import { checklistProgress } from "./board-stats";
import { InlineEditPopover } from "./InlineEditPopover";
import { QuickAddRow } from "./QuickAddRow";

/** Shared grid tracks for the header row and task rows (.bk-row). */
const BK_COLS = "94px minmax(0,1fr) 90px 122px 58px 70px 58px 72px";

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

  const groups = useMemo(() => groupBacklog(tasks), [tasks]);

  return (
    <div className="h-full overflow-auto text-[var(--fs-s)]">
      {/* ── QuickAddRow ──────────────────────────────────────────────────── */}
      {/*
        The three sticky rows below stack on `top: 0 / var(--row-h) /
        calc(2 * var(--row-h))`, so this bar's rendered height (border-box,
        including its border-b) must equal var(--row-h) exactly at every
        density — no vertical padding here, and the input inside is slimmed
        to fill the remaining height instead of adding its own py.
      */}
      <div
        className="sticky top-0 z-[4] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[var(--pad)]"
        style={{ height: "var(--row-h)" }}
      >
        <QuickAddRow
          preset={{}}
          testId="qa-backlog"
          className="h-full box-border py-0"
        />
      </div>

      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div
        className="cl-mono sticky z-[3] grid w-full border-b border-[var(--rule)] bg-[var(--bg-2)] px-[var(--pad)] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.18em] text-[var(--ink-3)]"
        style={{
          gridTemplateColumns: BK_COLS,
          gap: "12px",
          minHeight: "var(--row-h)",
          alignItems: "center",
          top: "var(--row-h)",
        }}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          ID
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          Task
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          Project
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          Status
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          Assignee
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          Estimate
        </span>
        <span
          className="overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ textAlign: "right" }}
        >
          Due
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          Checklist
        </span>
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {groups.length === 0 && (
        <div
          className="cl-mono border border-dashed border-[var(--rule)] px-[8px] py-[16px] text-center text-[var(--fs-xs)] uppercase tracking-[0.18em] text-[var(--ink-4)]"
          data-testid="bk-empty"
        >
          No tasks
        </div>
      )}

      {/* ── Priority groups ──────────────────────────────────────────────── */}
      {groups.map((g, idx) => (
        <div key={g.pri}>
          {/* Group header — top border on every group except the first
              (matches the stylesheet's `.bk-grp-hd:first-child` intent;
              `first:` can't express this since each header is the first
              child of its own group wrapper). */}
          <div
            data-testid={`bk-grp-hd-${g.pri}`}
            className="sticky z-[4] flex items-center gap-[12px] border-b border-[var(--ink-3)] bg-[var(--bg)] px-[var(--pad)] py-[7px]"
            style={{
              top: "calc(2 * var(--row-h))",
              borderTopStyle: idx === 0 ? "none" : "solid",
              borderTopWidth: idx === 0 ? 0 : "1px",
              borderTopColor: "var(--rule)",
            }}
          >
            <span
              className="cl-display text-[14px] font-black tracking-[0.06em]"
              style={{ color: priColor(g.pri).text }}
            >
              {g.pri}
            </span>
            <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.18em] text-[var(--ink-3)]">
              {PRI_LABEL[g.pri]}
            </span>
            <span className="cl-mono ml-auto text-[var(--fs-xs)] tracking-[0.14em] text-[var(--ink-3)] [font-variant-numeric:tabular-nums]">
              {pad2(g.items.length)} ITEMS
            </span>
          </div>

          {/* Task rows */}
          {g.items.map((t) => {
            const { done, total } = checklistProgress(t.checks);

            return (
              <div
                key={t.id}
                data-testid={`bk-row-${t.id}`}
                className="cl-mono pointer-events-none relative grid w-full cursor-pointer border-b border-dotted border-[var(--rule)] px-[var(--pad)] py-[5px] text-left transition-colors duration-[120ms] hover:bg-[var(--bg-2)]"
                style={{
                  gridTemplateColumns: BK_COLS,
                  gap: "12px",
                  alignItems: "center",
                  minHeight: "var(--row-h)",
                }}
              >
                <button
                  type="button"
                  aria-label={`Edit ${t.code}: ${t.title}`}
                  className="pointer-events-auto absolute inset-0 z-0 cursor-pointer border-0 bg-transparent p-0 text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--hot)] focus-visible:outline-offset-[-1px]"
                  onClick={() => setEditTaskId(t.id)}
                  data-testid={`bk-action-${t.id}`}
                />
                {/* FILE-ID */}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap tracking-[0.04em] text-[var(--ink)] [font-variant-numeric:tabular-nums]">
                  {t.code}
                </span>

                {/* TASKING — priority chip · title with optional HOLD tag */}
                <span className="flex items-center gap-[8px] overflow-hidden text-[var(--ink)]">
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
                      className="flex-shrink-0"
                    >
                      <span className="inline-block border border-[var(--hot)] px-[4px] text-[var(--fs-xs)] leading-[14px] tracking-[0.12em] text-[var(--hot)]">
                        Blocked
                      </span>
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis whitespace-nowrap"
                    title={t.title}
                  >
                    {t.title}
                  </span>
                </span>

                {/* OP */}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap tracking-[0.06em] text-[var(--ink-3)]">
                  {t.project ?? "—"}
                </span>

                {/* DISPOSITION */}
                <span className="flex items-center gap-[7px] tracking-[0.1em] text-[var(--ink-2)]">
                  <InlineEditPopover
                    task={t}
                    field="status"
                    testIdPrefix="bk"
                    colLabel={colLabel}
                  >
                    <span className="flex items-center gap-[7px]">
                      <StatePip col={t.status} />
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                        {colLabel(t.status)}
                      </span>
                    </span>
                  </InlineEditPopover>
                </span>

                {/* OPR */}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--ink-2)]">
                  {t.assignee ?? "—"}
                </span>

                {/* EST */}
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--ink-3)] [font-variant-numeric:tabular-nums]">
                  {t.estimate ?? "—"}
                </span>

                {/* DUE */}
                <span
                  className="overflow-hidden text-ellipsis whitespace-nowrap [font-variant-numeric:tabular-nums]"
                  style={{
                    textAlign: "right",
                    color: t.due ? "var(--ink-2)" : "var(--ink-3)",
                  }}
                >
                  {t.due ?? "—"}
                </span>

                {/* CHK — mini dot grid */}
                <span>
                  <span
                    className="inline-grid gap-[2px]"
                    style={{ gridAutoFlow: "column" }}
                  >
                    {Array.from(
                      { length: total },
                      (_, position) => position + 1,
                    ).map((position) => (
                      <i
                        key={`${t.id}-check-${position}`}
                        data-testid={`bk-dot-${t.id}-${position - 1}`}
                        data-done={position <= done ? "true" : "false"}
                        className="not-italic"
                        style={{
                          width: "5px",
                          height: "5px",
                          background:
                            position <= done ? "var(--cool)" : "var(--ink-4)",
                          display: "block",
                        }}
                      />
                    ))}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
