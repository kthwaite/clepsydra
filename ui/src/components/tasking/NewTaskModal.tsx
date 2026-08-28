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
 * slots don't fit the authoritative board chrome (prompt glyph + sub-line +
 * ESC chip header; split footer with the ⌘↵ hint) from
 * docs/pkm-redesign/project/board-panels.jsx.
 *
 * Styling follows the .board-modal-* / .cap-* / .ed-* classes from
 * docs/pkm-redesign/project/styles-board.css, translated to Tailwind tokens.
 *
 * Design deviation (plan decision 7):
 *   The prototype's SUBTASKS "checklist size" number field is replaced with a
 *   free-text textarea (one item per line). Each non-empty line becomes one
 *   `checklist` string in CreateTaskRequest.checklist[]. This is closer to
 *   the markdown source-of-truth model; the prototype's count-only field
 *   would generate placeholder items anyway.
 *
 *   DUE hint changed from "MM.DD" to "YYYY-MM-DD" to match the ISO wire format.
 */

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { BoardCycle } from "#/api/board";
import { useCreateTask } from "#/api/board";
import { Select, SelectItem } from "#/components/ui/select";
import { useBoardStore } from "#/store/board";
import {
  BOARD_MODAL_WIDTHS,
  BoardModalFrame,
  ModalEscChip,
} from "./BoardModalFrame";
import { type ColLabelFn, cycleStateLabel } from "./board-constants";
import { type ProjectScope, scopeLabel } from "./board-projects";
import { DispositionRow, EdField, INPUT_CLS, PriorityRow } from "./fields";

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
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [project, setProject] = useState<string>("");
  const [cycle, setCycle] = useState<string>("BACKLOG");
  const [status, setStatus] = useState<string>("INTAKE");
  const [priority, setPriority] = useState<string>("P2");
  const [assignee, setAssignee] = useState("");
  const [estimate, setEstimate] = useState("");
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const [tags, setTags] = useState("");
  const [checklist, setChecklist] = useState("");
  const [link, setLink] = useState("");

  const titleRef = useRef<HTMLInputElement>(null);
  const isOpen = taskModal !== null;

  // Reinitialise on open
  // biome-ignore lint/correctness/useExhaustiveDependencies: reinitialise only on open
  useEffect(() => {
    if (!isOpen) return;
    setTitle("");
    setBrief("");
    setProject(taskModal.project ?? "");
    setCycle(taskModal.cycle ?? "BACKLOG");
    setStatus(taskModal.status ?? "INTAKE");
    setPriority("P2");
    setAssignee("");
    setEstimate("");
    setStart("");
    setDue("");
    setTags("");
    setChecklist("");
    setLink("");
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
  const opLabel = project
    ? (projects.find((p) => p.key === project)?.code ?? project)
    : "No project";
  const dirty =
    title !== "" ||
    brief !== "" ||
    assignee !== "" ||
    estimate !== "" ||
    due !== "" ||
    start !== "" ||
    tags !== "" ||
    checklist !== "" ||
    link !== "";

  const commit = () => {
    const finalTitle = title.trim();
    if (!finalTitle) return;

    const tagsArr = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const checklistArr = checklist
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    create.mutate(
      {
        title: finalTitle,
        project: project || null,
        status: status || null,
        priority: priority || null,
        cycle: cycle === "BACKLOG" ? null : cycle || null,
        assignee: assignee.trim() || null,
        estimate: estimate.trim() || null,
        start: start.trim() || null,
        due: due.trim() || null,
        tags: tagsArr.length ? tagsArr : null,
        link: link.trim() || null,
        body: brief.trim() || null,
        checklist: checklistArr.length ? checklistArr : null,
      },
      {
        onSuccess: (task) => {
          closeTaskModal();
          setEditTaskId(task.id);
        },
      },
    );
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
      <div className="flex items-center gap-[10px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <span className="cl-display text-[16px] font-extrabold text-[var(--hot)]">
          +
        </span>
        <span className="cl-display text-[14px] font-extrabold uppercase tracking-[0.06em] text-[var(--ink)]">
          New task
        </span>
        <span className="cl-mono text-[var(--fs-xs)] tracking-[0.14em] text-[var(--ink-3)]">
          {opLabel} · Create task
        </span>
        <ModalEscChip onClose={closeTaskModal} testId="new-task-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-[12px] overflow-y-auto p-[14px]">
        {/* TITLE */}
        <EdField label="Title">
          <input
            ref={titleRef}
            type="text"
            aria-label="Title"
            className={INPUT_CLS}
            placeholder="What needs to be done…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="new-task-title"
          />
        </EdField>

        {/* BRIEF — prose body, written above any checklist on the page. */}
        <EdField label="Description" hint="Optional">
          <textarea
            aria-label="Description"
            className={`${INPUT_CLS} resize-none`}
            rows={3}
            placeholder="What the task is and why it matters…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            data-testid="new-task-brief"
          />
        </EdField>

        {/* PROJECT + CYCLE */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="Project">
            <Select
              aria-label="Project"
              value={project}
              onChange={(key) => setProject(key === null ? "" : String(key))}
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
              value={cycle}
              onChange={(key) =>
                setCycle(key === null ? "BACKLOG" : String(key))
              }
              data-testid="new-task-cycle"
            >
              <SelectItem id="BACKLOG">Backlog</SelectItem>
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

        {/* DISPOSITION */}
        <EdField label="Status">
          <DispositionRow
            value={status}
            onChange={setStatus}
            testIdPrefix="new-task"
            colLabel={colLabel}
          />
        </EdField>

        {/* PRIORITY */}
        <EdField label="Priority">
          <PriorityRow
            value={priority}
            onChange={setPriority}
            testIdPrefix="new-task"
          />
        </EdField>

        {/* ASSIGNEE / EST */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="Assignee">
            <input
              type="text"
              aria-label="Assignee"
              className={INPUT_CLS}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              data-testid="new-task-assignee"
            />
          </EdField>
          <EdField label="Estimate">
            <input
              type="text"
              aria-label="Estimate"
              className={INPUT_CLS}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              data-testid="new-task-estimate"
            />
          </EdField>
        </div>

        {/* START / DUE */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="Start date" hint="YYYY-MM-DD">
            <input
              type="date"
              aria-label="Start date"
              className={INPUT_CLS}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              data-testid="new-task-start"
            />
          </EdField>
          <EdField label="Due date" hint="YYYY-MM-DD">
            <input
              type="date"
              aria-label="Due date"
              className={INPUT_CLS}
              value={due}
              onChange={(e) => setDue(e.target.value)}
              data-testid="new-task-due"
            />
          </EdField>
        </div>

        {/* TAGS + CHECKLIST */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="Tags" hint="Comma-separated">
            <input
              type="text"
              aria-label="Tags"
              className={INPUT_CLS}
              placeholder="tag-one, tag-two"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              data-testid="new-task-tags"
            />
          </EdField>
          {/* CHECKLIST: one item per line → checklist[] array on POST.
                    Plan deviation: prototype used a count field; we use a
                    textarea so items carry actual text in the page body. */}
          <EdField label="Checklist" hint="One item per line">
            <textarea
              aria-label="Checklist"
              className={`${INPUT_CLS} resize-none`}
              rows={3}
              placeholder="One item per line"
              value={checklist}
              onChange={(e) => setChecklist(e.target.value)}
              data-testid="new-task-checklist"
            />
          </EdField>
        </div>

        {/* DOSSIER LINK */}
        <EdField label="Related page" hint="Optional">
          <input
            type="text"
            aria-label="Related page"
            className={INPUT_CLS}
            placeholder="[[page]]"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            data-testid="new-task-link"
          />
        </EdField>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <div className="cl-mono text-[var(--fs-xs)] tracking-[0.12em] text-[var(--ink-3)]">
          <span className="inline-block border border-[var(--rule)] px-[5px] py-[1px] text-[var(--fs-xs)]">
            ⌘↵
          </span>{" "}
          Create task ·{" "}
          <span className="inline-block border border-[var(--rule)] px-[5px] py-[1px] text-[var(--fs-xs)]">
            ESC
          </span>{" "}
          Cancel
        </div>
        <div className="flex gap-[8px]">
          <button
            type="button"
            className="cl-btn"
            onClick={closeTaskModal}
            data-testid="new-task-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-hot"
            onClick={commit}
            disabled={create.isPending || title.trim() === ""}
            data-testid="new-task-commit"
          >
            {create.isPending ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>
    </BoardModalFrame>
  );
}
