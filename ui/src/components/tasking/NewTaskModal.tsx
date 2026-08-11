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
import type { BoardCycle, BoardOperation } from "#/api/board";
import { useCreateTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { BoardModalFrame } from "./BoardModalFrame";
import { opKey } from "./board-constants";
import {
  DispositionRow,
  EdField,
  INPUT_CLS,
  PriorityRow,
  SELECT_CLS,
} from "./fields";

// ── NewTaskModal ──────────────────────────────────────────────────────────────

interface NewTaskModalProps {
  operations: BoardOperation[];
  cycles: BoardCycle[];
}

export function NewTaskModal({ operations, cycles }: NewTaskModalProps) {
  const taskModal = useBoardStore((s) => s.taskModal);
  const closeTaskModal = useBoardStore((s) => s.closeTaskModal);
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const create = useCreateTask();

  // Form state — re-initialised whenever the modal opens
  const [title, setTitle] = useState("");
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
  useEffect(() => {
    if (!isOpen) return;
    setTitle("");
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
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps — intentional: only on open

  if (!isOpen) return null;

  // A board:true PROJECT page with no project: frontmatter has no valid
  // filter/assignment key (filterTasks compares t.project === opFilter, and
  // a slug-less op's key can never match a task's project) — exclude it so
  // a task can't be misfiled to it.
  const assignableOps = operations.filter((op) => Boolean(op.project));

  // Closed cycles are not assignable to new tasks.
  const selectableCycles = cycles.filter((c) => c.state !== "CLOSED");

  // Derived display for the sub-header
  const opLabel = project
    ? (operations.find((op) => opKey(op) === project)?.code ?? project)
    : "UNFILED";

  const commit = () => {
    const finalTitle = title.trim() || "UNTITLED TASKING";
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
      ariaLabel="New Tasking"
      widthClassName="w-[660px]"
      backdropTestId="new-task-modal-backdrop"
      modalTestId="new-task-modal"
      onClose={closeTaskModal}
      onKeyDown={handleKeyDown}
      constrainHeight
    >
      {/* Header */}
      <div className="flex items-center gap-[10px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <span className="cl-display text-[16px] font-extrabold text-[var(--hot)]">
          +
        </span>
        <span className="cl-display text-[14px] font-extrabold uppercase tracking-[0.06em] text-[var(--ink)]">
          NEW TASKING
        </span>
        <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
          {opLabel} · COMMIT TO REGISTER
        </span>
        <button
          type="button"
          className="cl-mono ml-auto cursor-pointer border border-[var(--rule)] px-[7px] py-[2px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] hover:border-[var(--hot)] hover:text-[var(--hot)]"
          onClick={closeTaskModal}
          data-testid="new-task-close-btn"
        >
          ESC
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-[12px] overflow-y-auto p-[14px]">
        {/* TITLE */}
        <EdField label="TASKING / TITLE">
          <input
            ref={titleRef}
            type="text"
            className={INPUT_CLS}
            autoFocus
            placeholder="describe the unit of work…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="new-task-title"
          />
        </EdField>

        {/* OPERATION + CYCLE */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="OPERATION">
            <select
              className={SELECT_CLS}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              data-testid="new-task-operation"
            >
              <option value="">UNFILED / NONE</option>
              {assignableOps.map((op) => (
                <option key={op.id} value={opKey(op)}>
                  {op.code} — {op.name}
                </option>
              ))}
            </select>
          </EdField>
          <EdField label="CYCLE">
            <select
              className={SELECT_CLS}
              value={cycle}
              onChange={(e) => setCycle(e.target.value)}
              data-testid="new-task-cycle"
            >
              <option value="BACKLOG">BACKLOG / UNSCHEDULED</option>
              {selectableCycles.map((c) => (
                <option key={c.id} value={c.code}>
                  {c.code} · {c.label} ({c.state})
                </option>
              ))}
            </select>
          </EdField>
        </div>

        {/* DISPOSITION */}
        <EdField label="DISPOSITION">
          <DispositionRow
            value={status}
            onChange={setStatus}
            testIdPrefix="new-task"
          />
        </EdField>

        {/* PRIORITY */}
        <EdField label="PRIORITY">
          <PriorityRow
            value={priority}
            onChange={setPriority}
            testIdPrefix="new-task"
          />
        </EdField>

        {/* OPERATOR / EST */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="OPERATOR">
            <input
              type="text"
              className={INPUT_CLS}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              data-testid="new-task-assignee"
            />
          </EdField>
          <EdField label="EST">
            <input
              type="text"
              className={INPUT_CLS}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              data-testid="new-task-estimate"
            />
          </EdField>
        </div>

        {/* START / DUE */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="START" hint="YYYY-MM-DD">
            <input
              type="date"
              className={INPUT_CLS}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              data-testid="new-task-start"
            />
          </EdField>
          <EdField label="DUE" hint="YYYY-MM-DD">
            <input
              type="date"
              className={INPUT_CLS}
              value={due}
              onChange={(e) => setDue(e.target.value)}
              data-testid="new-task-due"
            />
          </EdField>
        </div>

        {/* TAGS + CHECKLIST */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="TAGS" hint="comma-sep">
            <input
              type="text"
              className={INPUT_CLS}
              placeholder="INFRA, PROCESS"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              data-testid="new-task-tags"
            />
          </EdField>
          {/* CHECKLIST: one item per line → checklist[] array on POST.
                    Plan deviation: prototype used a count field; we use a
                    textarea so items carry actual text in the page body. */}
          <EdField label="CHECKLIST" hint="one item per line">
            <textarea
              className={`${INPUT_CLS} resize-none`}
              rows={3}
              placeholder={"item 1\nitem 2"}
              value={checklist}
              onChange={(e) => setChecklist(e.target.value)}
              data-testid="new-task-checklist"
            />
          </EdField>
        </div>

        {/* DOSSIER LINK */}
        <EdField label="DOSSIER LINK" hint="optional">
          <input
            type="text"
            className={INPUT_CLS}
            placeholder="[[dossier]]"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            data-testid="new-task-link"
          />
        </EdField>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <div className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.12em] text-[var(--ink-3)]">
          <span className="inline-block border border-[var(--rule)] px-[5px] py-[1px] text-[var(--fs-xs)]">
            ⌘↵
          </span>{" "}
          commit ·{" "}
          <span className="inline-block border border-[var(--rule)] px-[5px] py-[1px] text-[var(--fs-xs)]">
            ESC
          </span>{" "}
          cancel
        </div>
        <div className="flex gap-[8px]">
          <button
            type="button"
            className="cl-btn"
            onClick={closeTaskModal}
            data-testid="new-task-cancel"
          >
            CANCEL
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-hot"
            onClick={commit}
            disabled={create.isPending}
            data-testid="new-task-commit"
          >
            {create.isPending ? "COMMITTING…" : "COMMIT TASK"}
          </button>
        </div>
      </div>
    </BoardModalFrame>
  );
}
