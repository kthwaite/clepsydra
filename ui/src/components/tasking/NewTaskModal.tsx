/**
 * NewTaskModal — creation dialog for a new board task.
 *
 * Opened by openTaskModal() with optional { project, status, cycle } presets.
 * On success: closes the modal and opens the edit panel on the new task.
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
import { opKey } from "./board-constants";

// ── EdField ───────────────────────────────────────────────────────────────────

/** Small labelled field wrapper. Shared by NewTaskModal and TaskEditPanel. */
export function EdField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="flex items-baseline justify-between gap-[8px]">
        <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-[var(--ink-mute)]">
          {label}
        </span>
        {hint && (
          <span className="cl-mono text-[9px] uppercase tracking-[0.1em] text-[var(--ink-4)]">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── shared field primitives ───────────────────────────────────────────────────

export const INPUT_CLS =
  "cl-mono w-full border border-[var(--rule)] bg-transparent px-[9px] py-[7px] text-[var(--fs-s)] text-[var(--ink)] tracking-[0.04em] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)]";

export const SELECT_CLS =
  "cl-mono w-full border border-[var(--rule)] bg-[var(--bg-2)] px-[9px] py-[7px] text-[var(--fs-s)] text-[var(--ink)] tracking-[0.04em] outline-none cursor-pointer focus:border-[var(--hot)]";

const RADIO_CLS_BASE =
  "cl-mono border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] cursor-pointer flex-1 text-center transition-[background,color,border-color] duration-[120ms]";

const RADIO_CLS_ON = "bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)]";

// Priority on-state uses the priority color
const PRI_ON_STYLE: Record<string, React.CSSProperties> = {
  P0: { background: "var(--hot)", borderColor: "var(--hot)", color: "#000" },
  P1: { background: "var(--warn)", borderColor: "var(--warn)", color: "#000" },
  P2: { background: "var(--cool)", borderColor: "var(--cool)", color: "#000" },
  P3: {
    background: "var(--ink-3)",
    borderColor: "var(--ink-3)",
    color: "#000",
  },
};

const PRI_OFF_STYLE: Record<string, React.CSSProperties> = {
  P0: { color: "var(--hot)", borderColor: "var(--hot)" },
  P1: { color: "var(--warn)", borderColor: "var(--warn)" },
  P2: { color: "var(--cool)", borderColor: "var(--cool)" },
  P3: { color: "var(--ink-mute)", borderColor: "var(--rule)" },
};

// ── NewTaskModal ──────────────────────────────────────────────────────────────

const COL_ORDER = [
  { id: "INTAKE", label: "INTAKE" },
  { id: "TRIAGE", label: "TRIAGE" },
  { id: "FIELD", label: "IN-FIELD" },
  { id: "REVIEW", label: "REVIEW" },
  { id: "SEALED", label: "SEALED" },
] as const;

const PRI_OPTS = ["P0", "P1", "P2", "P3"] as const;

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
    setDue("");
    setTags("");
    setChecklist("");
    setLink("");
    // Focus title after state flush
    setTimeout(() => titleRef.current?.focus(), 0);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps — intentional: only on open

  // Keyboard: Escape closes
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTaskModal();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, closeTaskModal]);

  if (!isOpen) return null;

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
    <div
      className="fixed inset-0 z-[9000] flex justify-center bg-black/60 backdrop-blur-[2px]"
      style={{ paddingTop: "9vh" }}
      onMouseDown={closeTaskModal}
      data-testid="new-task-modal-backdrop"
    >
      <div
        className="flex max-h-[82vh] w-[660px] max-w-[94vw] flex-col border border-[var(--ink-3)] bg-[var(--bg)]"
        style={{
          boxShadow: "0 20px 80px rgba(0,0,0,0.7), 0 0 0 1px var(--rule)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="new-task-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New Tasking"
        onKeyDown={handleKeyDown}
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
                {operations.map((op) => (
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
                {cycles.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.code} · {c.label} ({c.state})
                  </option>
                ))}
              </select>
            </EdField>
          </div>

          {/* DISPOSITION */}
          <EdField label="DISPOSITION">
            <div className="flex gap-[6px]">
              {COL_ORDER.map((col) => (
                <button
                  key={col.id}
                  type="button"
                  className={`${RADIO_CLS_BASE} ${status === col.id ? RADIO_CLS_ON : "hover:text-[var(--ink)] hover:border-[var(--ink-3)]"}`}
                  onClick={() => setStatus(col.id)}
                  data-testid={`new-task-status-${col.id}`}
                >
                  {col.label}
                </button>
              ))}
            </div>
          </EdField>

          {/* PRIORITY */}
          <EdField label="PRIORITY">
            <div className="flex gap-[6px]">
              {PRI_OPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`${RADIO_CLS_BASE}`}
                  style={priority === p ? PRI_ON_STYLE[p] : PRI_OFF_STYLE[p]}
                  onClick={() => setPriority(p)}
                  data-testid={`new-task-priority-${p}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </EdField>

          {/* OPERATOR / EST / DUE */}
          <div className="grid grid-cols-3 gap-[12px]">
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
            <EdField label="DUE" hint="YYYY-MM-DD">
              <input
                type="text"
                className={INPUT_CLS}
                placeholder="2026-12-31"
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
      </div>
    </div>
  );
}
