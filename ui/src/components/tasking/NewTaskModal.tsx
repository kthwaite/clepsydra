/**
 * NewTaskModal — creation dialog for a new board task.
 *
 * Opened by openTaskModal() with optional { project, status, cycle } presets.
 * On success: closes the modal and opens the edit panel on the new task.
 *
 * Built on BoardModalFrame, which wraps the same react-aria-components
 * primitives as the house dialog (ui/src/components/ui/dialog.tsx):
 * ModalOverlay/Modal/Dialog provide focus trapping, focus restoration, Escape
 * dismissal and scrim-click dismissal. We do not use the house <Dialog>
 * wrapper because its fixed header (Heading + X icon) and justify-end footer
 * slots don't fit the board chrome (serif title + sub-line + Esc chip header;
 * split footer with the ⌘↵ hint).
 *
 * Stone & Lamp interior (spec §5.5): serif title, sentence-case mute labels
 * over sink inputs, a quiet Cancel and a primary cobalt Create task pill.
 *
 * Design deviation (plan decision 7):
 *   The prototype's SUBTASKS "checklist size" number field is replaced with a
 *   free-text textarea (one item per line). Each non-empty line becomes one
 *   `checklist` string in CreateTaskRequest.checklist[]. This is closer to
 *   the markdown source-of-truth model; the prototype's count-only field
 *   would generate placeholder items anyway.
 *
 *   Dates use native date inputs, which carry the ISO wire format.
 */

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { BoardCycle } from "#/api/board";
import { useCreateTask } from "#/api/board";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { useBoardStore } from "#/store/board";
import {
  BOARD_MODAL_WIDTHS,
  BoardModalFrame,
  ModalEscChip,
} from "./BoardModalFrame";
import { type ColLabelFn, cycleStateLabel } from "./board-constants";
import { type ProjectScope, scopeLabel } from "./board-projects";
import {
  DispositionRow,
  EdField,
  INPUT_CLS,
  PriorityRow,
  TypeRow,
} from "./fields";
import {
  BACKLOG_CYCLE,
  type NewTaskDraft,
  newTaskDraft,
  toCreatePayload,
} from "./taskDraft";

/** The free-text fields whose content makes the form dirty. */
const DIRTY_FIELDS = [
  "title",
  "body",
  "assignee",
  "estimate",
  "due",
  "start",
  "tags",
  "checklist",
  "link",
] as const;

// ── NewTaskModal ──────────────────────────────────────────────────────────────

interface NewTaskModalProps {
  /** Project scopes (operations ∪ task slugs) — see deriveProjectScopes. */
  projects: ProjectScope[];
  cycles: BoardCycle[];
  /** Resolves a column id to its server-supplied display label. */
  colLabel: ColLabelFn;
}

export function NewTaskModal({
  projects,
  cycles,
  colLabel,
}: NewTaskModalProps) {
  const taskModal = useBoardStore((s) => s.taskModal);
  const closeTaskModal = useBoardStore((s) => s.closeTaskModal);
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const create = useCreateTask();

  // Form state — re-initialised whenever the modal opens
  const [draft, setDraft] = useState<NewTaskDraft>(newTaskDraft);
  const setField = <K extends keyof NewTaskDraft>(
    field: K,
    value: NewTaskDraft[K],
  ) => setDraft((d) => ({ ...d, [field]: value }));

  const titleRef = useRef<HTMLInputElement>(null);
  const isOpen = taskModal !== null;

  // Reinitialise on open
  // biome-ignore lint/correctness/useExhaustiveDependencies: reinitialise only on open
  useEffect(() => {
    if (!isOpen) return;
    setDraft(newTaskDraft(taskModal));
    // Focus title after state flush
    setTimeout(() => titleRef.current?.focus(), 0);
  }, [isOpen]);

  if (!isOpen) return null;

  // A PROJECT page with no project: frontmatter has no valid assignment key
  // (a task's project is a slug, and a slug-less op has none) — exclude it
  // so a task can't be misfiled to it. Synthesized scopes (slug with no
  // page) are assignable: the slug is the project.
  const assignableScopes = projects.filter((p) => p.slug !== null);

  // Closed cycles are not assignable to new tasks.
  const selectableCycles = cycles.filter((c) => c.state !== "CLOSED");

  // Derived display for the sub-header
  const selectedScope = projects.find((scope) => scope.key === draft.project);
  const opLabel = selectedScope
    ? scopeLabel(selectedScope)
    : draft.project || "No project";
  const dirty = DIRTY_FIELDS.some((field) => draft[field] !== "");

  const commit = () => {
    const payload = toCreatePayload(draft);
    if (!payload) return;
    create.mutate(payload, {
      onSuccess: (task) => {
        closeTaskModal();
        setEditTaskId(task.id);
      },
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  return (
    <BoardModalFrame
      ariaLabel="New task"
      widthClassName={BOARD_MODAL_WIDTHS.task}
      backdropTestId="new-task-modal-backdrop"
      modalTestId="new-task-modal"
      onClose={closeTaskModal}
      onKeyDown={handleKeyDown}
      constrainHeight
      isDismissable={!dirty}
    >
      {/* Header */}
      <div className="flex items-baseline gap-3 px-6 pt-5 pb-2">
        <h2 className="m-0 font-serif text-[26px] leading-none font-normal text-ink">
          New task
        </h2>
        <span className="min-w-0 truncate text-[13px] text-mute">
          {opLabel} · Create task
        </span>
        <ModalEscChip onClose={closeTaskModal} testId="new-task-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4.5 overflow-y-auto px-6 pt-3 pb-6">
        {/* Title */}
        <EdField label="Title">
          <input
            ref={titleRef}
            type="text"
            aria-label="Title"
            className={INPUT_CLS}
            placeholder="What needs to be done…"
            value={draft.title}
            onChange={(e) => setField("title", e.target.value)}
            data-testid="new-task-title"
          />
        </EdField>

        {/* Brief — prose body, written above any checklist on the page. */}
        <EdField label="Description" hint="Optional">
          <textarea
            aria-label="Description"
            className={cn(INPUT_CLS, "resize-none")}
            rows={3}
            placeholder="What the task is and why it matters…"
            value={draft.body}
            onChange={(e) => setField("body", e.target.value)}
            data-testid="new-task-brief"
          />
        </EdField>

        {/* Project + cycle */}
        <div className="grid grid-cols-2 gap-3.5">
          <EdField label="Project">
            <Select
              aria-label="Project"
              value={draft.project}
              onChange={(key) =>
                setField("project", key === null ? "" : String(key))
              }
              data-testid="new-task-project"
            >
              <SelectItem id="">No project</SelectItem>
              {assignableScopes.map((scope) => (
                <SelectItem
                  key={scope.key}
                  id={scope.key}
                  textValue={scopeLabel(scope)}
                >
                  {scopeLabel(scope)}
                </SelectItem>
              ))}
            </Select>
          </EdField>
          <EdField label="Cycle">
            <Select
              aria-label="Cycle"
              value={draft.cycle}
              onChange={(key) =>
                setField("cycle", key === null ? BACKLOG_CYCLE : String(key))
              }
              data-testid="new-task-cycle"
            >
              <SelectItem id={BACKLOG_CYCLE}>Backlog</SelectItem>
              {selectableCycles.map((c) => (
                <SelectItem
                  key={c.id}
                  id={c.code}
                  textValue={`${c.code} · ${c.label} (${cycleStateLabel(c.state)})`}
                >
                  {c.code} · {c.label} ({cycleStateLabel(c.state)})
                </SelectItem>
              ))}
            </Select>
          </EdField>
        </div>

        {/* Status */}
        <EdField label="Status">
          <DispositionRow
            value={draft.status}
            onChange={(v) => setField("status", v)}
            testIdPrefix="new-task"
            colLabel={colLabel}
          />
        </EdField>

        {/* Priority */}
        <EdField label="Priority">
          <PriorityRow
            value={draft.priority}
            onChange={(v) => setField("priority", v)}
            testIdPrefix="new-task"
          />
        </EdField>

        {/* Type */}
        <EdField label="Type">
          <TypeRow
            value={draft.taskType}
            onChange={(v) => setField("taskType", v)}
            testIdPrefix="new-task"
          />
        </EdField>

        {/* Assignee + estimate */}
        <div className="grid grid-cols-2 gap-3.5">
          <EdField label="Assignee">
            <input
              type="text"
              aria-label="Assignee"
              className={INPUT_CLS}
              value={draft.assignee}
              onChange={(e) => setField("assignee", e.target.value)}
              data-testid="new-task-assignee"
            />
          </EdField>
          <EdField label="Estimate">
            <input
              type="text"
              aria-label="Estimate"
              className={INPUT_CLS}
              value={draft.estimate}
              onChange={(e) => setField("estimate", e.target.value)}
              data-testid="new-task-estimate"
            />
          </EdField>
        </div>

        {/* Start + due */}
        <div className="grid grid-cols-2 gap-3.5">
          <EdField label="Start date">
            <input
              type="date"
              aria-label="Start date"
              className={INPUT_CLS}
              value={draft.start}
              onChange={(e) => setField("start", e.target.value)}
              data-testid="new-task-start"
            />
          </EdField>
          <EdField label="Due date">
            <input
              type="date"
              aria-label="Due date"
              className={INPUT_CLS}
              value={draft.due}
              onChange={(e) => setField("due", e.target.value)}
              data-testid="new-task-due"
            />
          </EdField>
        </div>

        {/* Tags + checklist */}
        <div className="grid grid-cols-2 gap-3.5">
          <EdField label="Tags" hint="Comma-separated">
            <input
              type="text"
              aria-label="Tags"
              className={INPUT_CLS}
              placeholder="tag-one, tag-two"
              value={draft.tags}
              onChange={(e) => setField("tags", e.target.value)}
              data-testid="new-task-tags"
            />
          </EdField>
          {/* Checklist: one item per line → checklist[] array on POST.
                    Plan deviation: prototype used a count field; we use a
                    textarea so items carry actual text in the page body. */}
          <EdField label="Checklist" hint="One item per line">
            <textarea
              aria-label="Checklist"
              className={cn(INPUT_CLS, "resize-none")}
              rows={3}
              placeholder="One item per line"
              value={draft.checklist}
              onChange={(e) => setField("checklist", e.target.value)}
              data-testid="new-task-checklist"
            />
          </EdField>
        </div>

        {/* Related page */}
        <EdField label="Related page" hint="Optional">
          <input
            type="text"
            aria-label="Related page"
            className={INPUT_CLS}
            placeholder="[[page]]"
            value={draft.link}
            onChange={(e) => setField("link", e.target.value)}
            data-testid="new-task-link"
          />
        </EdField>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 bg-ground px-6 pt-3 pb-3.5">
        <div className="flex items-center gap-1.5 text-[12.5px] text-mute">
          <kbd className="rounded-md bg-sink px-1.5 font-sans text-[12px] text-ink-2">
            ⌘↵
          </kbd>
          <span>Create task ·</span>
          <kbd className="rounded-md bg-sink px-1.5 font-sans text-[12px] text-ink-2">
            Esc
          </kbd>
          <span>Cancel</span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onPress={closeTaskModal}
            data-testid="new-task-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onPress={commit}
            isDisabled={create.isPending || draft.title.trim() === ""}
            data-testid="new-task-commit"
          >
            {create.isPending ? "Creating…" : "Create task"}
          </Button>
        </div>
      </div>
    </BoardModalFrame>
  );
}
