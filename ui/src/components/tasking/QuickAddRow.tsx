/**
 * QuickAddRow — quick-add inline task creation.
 *
 * Renders a single-line input for creating tasks without opening a modal.
 * Used in kanban column bodies and backlog header.
 *
 * - Type title + Enter → POST CreateTaskRequest with preset fields
 * - Input clears and keeps focus on success
 * - Empty/whitespace title → no fetch
 * - Escape → clear and blur
 */

import { useState } from "react";
import { useCreateTask } from "#/api/board";
import { cn } from "#/lib/cn";

export interface QuickAddRowProps {
  /** Preset fields: status, project, cycle (all optional) */
  preset: { status?: string; project?: string; cycle?: string };
  /** Test identifier (e.g., "qa-INTAKE", "qa-backlog") */
  testId: string;
  /** Overrides/extends the input's default classes (e.g. to fit a fixed-height sticky bar). */
  className?: string;
}

export function QuickAddRow({ preset, testId, className }: QuickAddRowProps) {
  const [title, setTitle] = useState("");
  const create = useCreateTask();

  const commit = () => {
    const t = title.trim();
    if (!t || create.isPending) return;
    create.mutate(
      {
        title: t,
        status: preset.status ?? null,
        project: preset.project ?? null,
        cycle: preset.cycle ?? null,
        priority: null,
        assignee: null,
        estimate: null,
        due: null,
        start: null,
        tags: null,
        link: null,
        checklist: null,
      },
      { onSuccess: () => setTitle("") },
    );
  };

  return (
    <input
      type="text"
      data-testid={testId}
      className={cn(
        "cl-mono w-full border border-dashed border-[var(--rule)] bg-transparent px-[8px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.08em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)] focus:border-solid",
        className,
      )}
      placeholder="+ ADD"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setTitle("");
          e.currentTarget.blur();
          e.stopPropagation();
        }
      }}
    />
  );
}
