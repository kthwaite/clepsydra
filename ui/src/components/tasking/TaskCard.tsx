/**
 * TaskCard — individual kanban card with Pragmatic drag-and-drop.
 *
 * Stone & Lamp card: `raise` fill, 14px radius, no border; Done cards drop
 * the fill and mute their title.
 */

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";
import type { BoardTask } from "#/api/board";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { type CardBlocker, cardBlockers } from "./blockers";
import { type ColLabelFn, priColor, StatePip } from "./board-constants";
import { ChecklistBar, TypeChip } from "./board-presentation";
import { checklistProgress } from "./board-stats";
import { InlineEditPopover } from "./InlineEditPopover";

// ── TaskCard ──────────────────────────────────────────────────────────────────

export interface TaskCardProps {
  task: BoardTask;
  /** Show the operation/project code in the top row (used when ALL ops visible) */
  showOp: boolean;
  /** Opens the task editor from card click/keyboard activation. */
  onClick: () => void;
  onOpenDossier?: (link: string) => void;
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
  /** Every board task by code: resolves blocker chips. */
  taskByCode: ReadonlyMap<string, BoardTask>;
}

export function TaskCard({
  task: t,
  showOp,
  onClick,
  onOpenDossier,
  colLabel,
  taskByCode,
}: TaskCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const element = cardRef.current;
    const dragHandle = actionRef.current;
    if (!element || !dragHandle) return;

    return draggable({
      element,
      dragHandle,
      getInitialData: () => ({
        kind: "task-card",
        taskId: t.id,
        status: t.status,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [t.id, t.status]);
  const {
    done,
    total,
    percent: pct,
    isComplete: checksDone,
  } = checklistProgress(t.checks);

  const { text: priTextColor } = priColor(t.priority);
  const link = t.link;
  const sealed = t.status === "SEALED";
  const blockers = cardBlockers(t, taskByCode);
  // More than two blockers collapse to the first plus a +N count.
  const shownBlockers = blockers.length > 2 ? blockers.slice(0, 1) : blockers;
  const hiddenBlockers = blockers.length - shownBlockers.length;
  const blocksCount = sealed ? 0 : t.blocks.length;

  return (
    <div
      ref={cardRef}
      className={cn(
        "group pointer-events-none relative min-w-0 shrink-0 cursor-grab rounded-[14px] px-3.5 py-3 transition-[background,box-shadow] duration-[120ms] active:cursor-grabbing",
        sealed
          ? "bg-transparent hover:bg-sink"
          : "bg-raise hover:shadow-[0_1px_4px_rgb(0_0_0/0.08)]",
      )}
      style={
        isDragging
          ? { opacity: 0.35, outline: "1px dashed var(--faint)" }
          : undefined
      }
      data-testid={`task-card-${t.id}`}
    >
      <button
        ref={actionRef}
        type="button"
        aria-label={`Edit ${t.code}: ${t.title}`}
        className={cn(
          "pointer-events-auto absolute inset-0 z-0 cursor-grab rounded-[14px] bg-transparent p-0 text-left active:cursor-grabbing",
          FOCUS_RING_NATIVE,
        )}
        onClick={onClick}
        data-testid={`task-action-${t.id}`}
      />

      {/* Top row: code · priority · type · status · project */}
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-mute">
        <span className="max-w-full truncate tabular-nums">{t.code}</span>
        <InlineEditPopover
          task={t}
          field="priority"
          testIdPrefix="kb"
          colLabel={colLabel}
        >
          <span className="tabular-nums" style={{ color: priTextColor }}>
            {t.priority}
          </span>
        </InlineEditPopover>
        <TypeChip type={t.task_type} />
        <InlineEditPopover
          task={t}
          field="status"
          testIdPrefix="kb"
          colLabel={colLabel}
        >
          <StatePip col={t.status} />
        </InlineEditPopover>
        {t.blocked && (
          <span
            className="pointer-events-none rounded-full bg-[color-mix(in_oklab,var(--hot)_12%,transparent)] px-2 leading-5 text-hot"
            data-testid={`hold-stamp-${t.id}`}
          >
            Blocked
          </span>
        )}
        {showOp && t.project && (
          <span className="ml-auto truncate">{t.project}</span>
        )}
      </div>

      {/* Title */}
      <div
        data-card-title
        className={cn(
          "break-words text-[14.5px] leading-[1.45] [text-wrap:pretty]",
          sealed ? "text-mute" : "text-ink",
        )}
      >
        {t.title}
      </div>

      {t.body_excerpt && (
        <p
          className="mt-1.5 line-clamp-2 break-words text-[13px] leading-[1.45] text-mute"
          data-testid={`task-excerpt-${t.id}`}
        >
          {t.body_excerpt}
        </p>
      )}

      {/* Hold reason line */}
      {t.hold && (
        <div
          className="mt-2 text-[12.5px] text-hot"
          data-testid={`hold-line-${t.id}`}
        >
          {t.hold}
        </div>
      )}

      {/* Blocker chips: what this task waits on, and how many it holds up */}
      {(blockers.length > 0 || blocksCount > 0) && (
        <div className="mt-2 flex flex-wrap gap-1 text-[12px] leading-5">
          {shownBlockers.map((b) => (
            <BlockerChip key={b.code} blocker={b} />
          ))}
          {hiddenBlockers > 0 && (
            <span
              className="rounded-full bg-[color-mix(in_oklab,var(--hot)_12%,transparent)] px-2 text-hot"
              data-testid={`blocker-more-${t.id}`}
            >
              +{hiddenBlockers}
            </span>
          )}
          {blocksCount > 0 && (
            <span
              className="rounded-full bg-sink px-2 text-ink-2"
              data-testid={`blocks-chip-${t.id}`}
            >
              blocks {blocksCount}
            </span>
          )}
        </div>
      )}

      {/* Checklist progress bar */}
      {total > 0 && (
        <div className="mt-2.5 flex items-center gap-2">
          <ChecklistBar
            percent={pct}
            isComplete={checksDone}
            className="h-1 flex-1"
          />
          <span className="text-[12.5px] tabular-nums text-mute">
            {done}/{total}
          </span>
        </div>
      )}

      {/* Tags — up to 3, with a +N overflow chip */}
      {t.tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {t.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-sink px-2 text-[12px] leading-5 text-ink-2"
            >
              {tag}
            </span>
          ))}
          {t.tags.length > 3 && (
            <span
              data-testid={`task-tags-more-${t.id}`}
              className="rounded-full bg-sink px-2 text-[12px] leading-5 text-mute"
            >
              +{t.tags.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Meta row */}
      <div className="mt-3 flex items-center gap-2.5 text-[12.5px] text-mute">
        {t.assignee && <span className="text-ink-2">{t.assignee}</span>}
        {t.estimate && <span className="tabular-nums">{t.estimate}</span>}
        {link && (
          <button
            type="button"
            className={cn(
              "pointer-events-auto relative z-[1] cursor-pointer truncate rounded text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent",
              FOCUS_RING_NATIVE,
            )}
            onClick={(e) => {
              e.stopPropagation();
              onOpenDossier?.(link);
            }}
          >
            {link}
          </button>
        )}
        <span
          className="ml-auto whitespace-nowrap tabular-nums"
          style={t.due ? { color: "var(--ink-2)" } : undefined}
        >
          Due {t.due ?? "—"}
        </span>
      </div>
    </div>
  );
}

/**
 * "blocked by CODE". An open blocker is a button that opens its editor; it
 * stops propagation so the card underneath does not act too. A dangling code
 * (no task on the board) is struck through and inert.
 */
function BlockerChip({ blocker }: { blocker: CardBlocker }) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const label = `blocked by ${blocker.code}`;
  const target = blocker.task;
  if (!target) {
    return (
      <span
        className="rounded-full bg-sink px-2 text-mute line-through"
        title="No task on the board has this code"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        "pointer-events-auto relative z-[1] cursor-pointer rounded-full bg-[color-mix(in_oklab,var(--hot)_12%,transparent)] px-2 text-hot hover:underline",
        FOCUS_RING_NATIVE,
      )}
      title={target.title}
      onClick={(e) => {
        e.stopPropagation();
        setEditTaskId(target.id);
      }}
    >
      {label}
    </button>
  );
}
