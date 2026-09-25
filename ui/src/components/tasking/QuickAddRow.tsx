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
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

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
        "h-9 w-full rounded-[14px] bg-transparent px-[18px] text-[13.5px] text-ink placeholder:text-mute hover:bg-sink focus:bg-sink",
        FOCUS_RING_NATIVE,
        className,
      )}
      aria-label="New task"
      placeholder="+ New task"
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
