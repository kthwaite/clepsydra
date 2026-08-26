/**
 * TaskCard — individual kanban card with Pragmatic drag-and-drop.
 *
 * Mirrors the kc-* / kb-card anatomy from styles-board.css exactly,
 * translated to Tailwind + Vessel design tokens.
 */

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useEffect, useRef, useState } from "react";
import type { BoardTask } from "#/api/board";
import { type ColLabelFn, priColor, StatePip } from "./board-constants";
import { ChecklistBar } from "./board-presentation";
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
}

export function TaskCard({
  task: t,
  showOp,
  onClick,
  onOpenDossier,
  colLabel,
}: TaskCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;

    return draggable({
      element,
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

  const { bar: barColor, text: priTextColor } = priColor(t.priority);

  return (
    <div
      ref={cardRef}
      className="group relative cursor-grab border border-[var(--rule)] bg-[var(--bg)] p-[9px_11px_9px_14px] transition-[border-color,background,transform] duration-[80ms,120ms,80ms] hover:border-[var(--hot)] hover:bg-[var(--bg-3)] active:cursor-grabbing"
      style={isDragging ? { opacity: 0.35, borderStyle: "dashed" } : undefined}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      data-testid={`task-card-${t.id}`}
    >
      {/* Left priority bar */}
      <span
        className="absolute bottom-0 left-0 top-0 w-[3px]"
        style={{ background: barColor }}
        aria-hidden
      />

      {/* HOLD stamp — absolute top-right */}
      {t.hold && (
        <span
          className="cl-display pointer-events-none absolute right-[8px] top-[6px] border-[1.5px] border-[var(--hot)] bg-[color-mix(in_oklab,var(--hot)_12%,var(--bg))] px-[5px] py-[1px] text-[9px] font-extrabold tracking-[0.18em] text-[var(--hot)]"
          style={{ transform: "rotate(-7deg)" }}
          data-testid={`hold-stamp-${t.id}`}
        >
          Blocked
        </span>
      )}

      {/* Top row: id · priority badge · op code */}
      <div className="mb-[6px] flex items-center gap-[8px]">
        <span className="cl-mono font-variant-numeric text-[var(--fs-xs)] tracking-[0.06em] text-[var(--ink-2)]">
          {t.code}
        </span>
        <InlineEditPopover
          task={t}
          field="priority"
          testIdPrefix="kb"
          colLabel={colLabel}
        >
          <span
            className="cl-mono border px-[4px] py-0 text-[var(--fs-xs)] tracking-[0.08em]"
            style={{ color: priTextColor, borderColor: priTextColor }}
          >
            {t.priority}
          </span>
        </InlineEditPopover>
        <InlineEditPopover
          task={t}
          field="status"
          testIdPrefix="kb"
          colLabel={colLabel}
        >
          <StatePip col={t.status} />
        </InlineEditPopover>
        {showOp && t.project && (
          <span className="cl-mono ml-auto border border-[var(--rule)] px-[4px] text-[var(--fs-xs)] tracking-[0.1em] text-[var(--ink-3)]">
            {t.project}
          </span>
        )}
      </div>

      {/* Title */}
      <div className="cl-display mb-[8px] text-[12.5px] font-semibold uppercase leading-[1.22] tracking-[0.02em] text-[var(--ink)] [text-wrap:pretty]">
        {t.title}
      </div>

      {t.body_excerpt && (
        <p
          className="line-clamp-3 mb-[8px] -mt-[4px] text-[var(--fs-sm)] leading-[1.35] text-[var(--ink-2)]"
          data-testid={`task-excerpt-${t.id}`}
        >
          {t.body_excerpt}
        </p>
      )}

      {/* Hold reason line */}
      {t.hold && (
        <div
          className="cl-mono mb-[7px] -mt-[2px] flex items-center gap-[6px] text-[var(--fs-xs)] uppercase tracking-[0.06em] text-[var(--hot)] before:content-['▲']"
          data-testid={`hold-line-${t.id}`}
        >
          {t.hold}
        </div>
      )}

      {/* Checklist progress bar */}
      {total > 0 && (
        <div className="mb-[7px] flex items-center gap-[7px]">
          <ChecklistBar
            percent={pct}
            isComplete={checksDone}
            className="h-[4px] flex-1"
          />
          <span className="cl-mono font-variant-numeric text-[var(--fs-xs)] tracking-[0.06em] text-[var(--ink-3)]">
            {done}/{total}
          </span>
        </div>
      )}

      {/* Tags — up to 3, with a +N overflow chip */}
      {t.tags.length > 0 && (
        <div className="mb-[7px] flex flex-wrap gap-[3px]">
          {t.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="cl-mono border border-[var(--rule)] px-[4px] py-0 text-[var(--fs-xs)] tracking-[0.06em] text-[var(--ink-3)]"
            >
              {tag}
            </span>
          ))}
          {t.tags.length > 3 && (
            <span
              data-testid={`task-tags-more-${t.id}`}
              className="cl-mono border border-[var(--rule)] px-[4px] text-[var(--fs-xs)] text-[var(--ink-3)]"
            >
              +{t.tags.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="cl-mono flex items-center gap-[10px] border-t border-dotted border-[var(--rule)] pt-[6px] text-[var(--fs-xs)] uppercase tracking-[0.08em] text-[var(--ink-3)]">
        {t.assignee && (
          <span className="text-[var(--ink-2)]">{t.assignee}</span>
        )}
        {t.estimate && (
          <span className="font-variant-numeric">{t.estimate}</span>
        )}
        {t.link && (
          <button
            type="button"
            className="cursor-pointer border-b border-dotted border-[var(--cool)] text-[var(--cool)] hover:bg-[var(--cool)] hover:text-[var(--bg)]"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDossier?.(t.link!);
            }}
          >
            {t.link}
          </button>
        )}
        <span
          className="ml-auto font-variant-numeric"
          style={t.due ? { color: "var(--ink-2)" } : undefined}
        >
          Due {t.due ?? "—"}
        </span>
      </div>
    </div>
  );
}
