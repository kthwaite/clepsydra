/**
 * BacklogView — the TASKING board's list mode, two Jira-style tables.
 *
 * - Receives pre-filtered `tasks` from TaskingScreen (same visibleTasks
 *   threading as KanbanView) and the active cycle (BoardHeader's rule).
 * - Active cycle table first (only when a cycle is active), then the
 *   backlog table with every other task; splitBacklog sorts each by
 *   priority, status, then due date.
 * - SEALED tasks show only with the board's "Show completed" toggle.
 * - Each table is a virtualised DataTable capped at ten 40px rows; its
 *   rows open the task editor on click or Enter. Priority and status are
 *   InlineEditPopover buttons inside the cells, so they never open it.
 * - Checklist mini-dots: 6px rounds, done = cobalt, open = faint.
 * - Stone & Lamp dense table (spec §5.6): no cell borders, sentence-case
 *   12.5px mute header, 40px rows, hover sink, the row being edited in
 *   accent-tint, tabular numerals. Table headings: tick + italic serif
 *   name + caption.
 */

import { useMemo } from "react";
import type { BoardCycle, BoardTask } from "#/api/board";
import { Tick, type TickVariant } from "#/components/codex/Tick";
import { type DataColumn, DataTable } from "#/components/ui/data-table";
import { useMediaQuery } from "#/hooks/useMediaQuery";
import { cn } from "#/lib/cn";
import { formatDayMonth } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import { splitBacklog } from "./backlog-tables";
import {
  type ColLabelFn,
  fmtCycleWindow,
  isDone,
  PriChip,
  StatePip,
} from "./board-constants";
import { TypeChip } from "./board-presentation";
import { checklistProgress } from "./board-stats";
import { InlineEditPopover } from "./InlineEditPopover";
import { QuickAddRow } from "./QuickAddRow";

const ROW_HEIGHT = 40;
/** Ten rows under the 40px (comfortable) header; more rows scroll. */
const VIRTUALIZE = { rowHeight: ROW_HEIGHT, maxHeight: 11 * ROW_HEIGHT };

const COLUMN_ORDER = [
  "code",
  "task",
  "project",
  "status",
  "assignee",
  "estimate",
  "due",
  "checklist",
];
const NO_WIDTHS: Record<string, number> = {};

/** Narrower screens drop columns so the title keeps room: below 1400px
 *  Assignee and Estimate go, below 1280px Project and Checklist. */
function useColumnVisibility(): Record<string, boolean> {
  const wide = useMediaQuery("(min-width: 1400px)");
  const mid = useMediaQuery("(min-width: 1280px)");
  return useMemo(
    () => ({ assignee: wide, estimate: wide, project: mid, checklist: mid }),
    [wide, mid],
  );
}

function taskColumns(colLabel: ColLabelFn): DataColumn<BoardTask>[] {
  return [
    {
      id: "code",
      label: "Code",
      width: 168,
      rowHeader: true,
      cell: (t) => (
        <span
          className={cn(
            "block truncate text-[13px] tabular-nums",
            isDone(t.status) ? "text-mute" : "text-ink-2",
          )}
        >
          {t.code}
        </span>
      ),
    },
    {
      id: "task",
      label: "Task",
      fill: true,
      minWidth: 200,
      cell: (t) => (
        // Priority chip · type chip · Blocked pill · title
        <span className="flex min-w-0 items-center gap-2.5">
          <InlineEditPopover
            task={t}
            field="priority"
            testIdPrefix="bk"
            colLabel={colLabel}
          >
            <PriChip pri={t.priority} />
          </InlineEditPopover>
          <TypeChip type={t.task_type} />
          {t.blocked && (
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
              isDone(t.status) ? "text-mute" : "text-ink",
            )}
            title={t.title}
          >
            {t.title}
          </span>
        </span>
      ),
    },
    {
      id: "project",
      label: "Project",
      width: 110,
      cell: (t) => (
        <span className="block truncate text-[13px] text-mute">
          {t.project ?? "—"}
        </span>
      ),
    },
    {
      id: "status",
      label: "Status",
      width: 132,
      cell: (t) => (
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
      ),
    },
    {
      id: "assignee",
      label: "Assignee",
      width: 90,
      cell: (t) => (
        <span
          className={cn(
            "block truncate text-[13px]",
            t.assignee ? "text-ink-2" : "text-mute",
          )}
        >
          {t.assignee ?? "—"}
        </span>
      ),
    },
    {
      id: "estimate",
      label: "Estimate",
      width: 76,
      cell: (t) => (
        <span className="block truncate text-[13px] text-mute tabular-nums">
          {t.estimate ?? "—"}
        </span>
      ),
    },
    {
      id: "due",
      label: "Due",
      // Cells pad 12px a side, which the old grid's gaps did not: 64px of
      // text ("14 Oct") needs 88px.
      width: 88,
      align: "end",
      cell: (t) => (
        <span
          className={cn(
            "block truncate text-[13px] tabular-nums",
            t.due ? "text-ink-2" : "text-mute",
          )}
          title={t.due ?? undefined}
        >
          {t.due ? formatDayMonth(t.due) : "—"}
        </span>
      ),
    },
    {
      id: "checklist",
      label: "Checklist",
      width: 86,
      cell: (t) => {
        const { done, total } = checklistProgress(t.checks);
        return (
          <span className="flex gap-[3px]">
            {Array.from({ length: total }, (_, position) => position + 1).map(
              (position) => (
                <span
                  key={`${t.id}-check-${position}`}
                  data-testid={`bk-dot-${t.id}-${position - 1}`}
                  data-done={position <= done ? "true" : "false"}
                  className={cn(
                    "block h-1.5 w-1.5 rounded-full",
                    position <= done ? "bg-accent" : "bg-faint",
                  )}
                />
              ),
            )}
          </span>
        );
      },
    },
  ];
}

const countLabel = (n: number) => (n === 1 ? "1 task" : `${n} tasks`);

function TableHeading({
  tick,
  name,
  caption,
}: {
  tick: TickVariant;
  name: string;
  caption: string;
}) {
  return (
    // Wraps at phone widths: the caption drops below the name.
    <h2 className="m-0 flex min-h-[46px] flex-wrap items-center gap-x-2.5 gap-y-1 px-3 pt-2 pb-1 font-normal">
      <Tick variant={tick} />
      <span className="whitespace-nowrap font-serif text-[21px] italic leading-none text-ink">
        {name}
      </span>
      <span className="text-[12.5px] text-mute tabular-nums">{caption}</span>
    </h2>
  );
}

function TaskTable({
  ariaLabel,
  tasks,
  columns,
  columnVisibility,
  empty,
}: {
  ariaLabel: string;
  tasks: BoardTask[];
  columns: DataColumn<BoardTask>[];
  columnVisibility: Record<string, boolean>;
  empty: string;
}) {
  const editTaskId = useBoardStore((s) => s.editTaskId);
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  return (
    <DataTable<BoardTask>
      ariaLabel={ariaLabel}
      rows={tasks}
      columns={columns}
      getRowId={(t) => t.id}
      density="comfortable"
      columnOrder={COLUMN_ORDER}
      columnVisibility={columnVisibility}
      columnWidths={NO_WIDTHS}
      virtualize={VIRTUALIZE}
      onRowActivate={(t) => setEditTaskId(t.id)}
      isRowCurrent={(t) => t.id === editTaskId}
      rowClassName={(t) =>
        cn(
          "[&>td:first-child]:rounded-l-[10px] [&>td:last-child]:rounded-r-[10px] [&>td]:transition-colors [&>td]:duration-[120ms]",
          t.id === editTaskId
            ? "[&>td]:bg-accent-tint"
            : "hover:[&>td]:bg-sink",
        )
      }
      emptyState={
        <p className="m-0 rounded-xl bg-sink px-3 py-6 text-center text-[13px] text-mute">
          {empty}
        </p>
      }
    />
  );
}

// ── BacklogView ───────────────────────────────────────────────────────────────

export interface BacklogViewProps {
  /** Pre-filtered visible tasks (same as KanbanView.tasks). */
  tasks: BoardTask[];
  /** The cycle in progress (`state === "ACTIVE"`), or null. */
  activeCycle: BoardCycle | null;
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function BacklogView({
  tasks,
  activeCycle,
  colLabel,
}: BacklogViewProps) {
  const showDone = useBoardStore((s) => s.showCompleted);
  const columnVisibility = useColumnVisibility();
  const columns = useMemo(() => taskColumns(colLabel), [colLabel]);
  const split = useMemo(
    () => splitBacklog(tasks, activeCycle, { showDone }),
    [tasks, activeCycle, showDone],
  );

  return (
    <div className="h-full overflow-auto px-4 pb-6 text-[14px]">
      <div className="flex h-11 items-center rounded-[14px] bg-sink">
        <QuickAddRow
          preset={{}}
          testId="qa-backlog"
          className="h-full hover:bg-transparent focus:bg-transparent"
        />
      </div>

      {activeCycle && split.cycle && (
        <section className="mt-[18px]">
          <TableHeading
            tick="live"
            name={activeCycle.label}
            caption={`${activeCycle.code} · ${fmtCycleWindow(activeCycle.start, activeCycle.end)} · ${countLabel(split.cycle.length)}`}
          />
          <TaskTable
            ariaLabel={`Active cycle: ${activeCycle.label}`}
            tasks={split.cycle}
            columns={columns}
            columnVisibility={columnVisibility}
            empty="No tasks in this cycle"
          />
        </section>
      )}

      <section className="mt-[18px]">
        <TableHeading
          tick="faint"
          name="Backlog"
          caption={countLabel(split.backlog.length)}
        />
        <TaskTable
          ariaLabel="Backlog"
          tasks={split.backlog}
          columns={columns}
          columnVisibility={columnVisibility}
          empty="No tasks in the backlog"
        />
      </section>
    </div>
  );
}
