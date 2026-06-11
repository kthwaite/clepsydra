/**
 * TaskEditPanel — right-docked edit drawer for a board task.
 *
 * Opens when editTaskId is set in the board store and the task exists in the
 * current board data. Positioned absolute right-0, full height, w-[340px].
 * A scrim behind it closes the panel on click; the panel itself stops
 * propagation.
 *
 * All edits are sent as optimistic PATCHes:
 *   - Immediate: disposition (status), priority, operation select, cycle select,
 *     tags, hold toggle.
 *   - Debounced 300ms: title, assignee, estimate, due, hold reason, link.
 *
 * Checklist deviation (plan decision 7):
 *   The checklist is read-only. We show a progress bar + "d / total done"
 *   and an "OPEN PAGE →" affordance (calls onOpenPage(task.path)). The
 *   markdown body is the source of truth for checklist items.
 *
 * Destroy: two-step confirm — first click arms the button, second fires DELETE.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { useDeleteTask, usePatchTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { opKey } from "./board-constants";
import { EdField, INPUT_CLS, SELECT_CLS } from "./NewTaskModal";

// ── priority colour helpers (mirrors TaskCard) ────────────────────────────────

const PRI_BAR_COLOR: Record<string, string> = {
  P0: "var(--hot)",
  P1: "var(--warn)",
  P2: "var(--cool)",
  P3: "var(--ink-4)",
};

const PRI_TEXT_COLOR: Record<string, string> = {
  P0: "var(--hot)",
  P1: "var(--warn)",
  P2: "var(--cool)",
  P3: "var(--ink-mute)",
};

const RADIO_CLS_BASE =
  "cl-mono border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] cursor-pointer flex-1 text-center transition-[background,color,border-color] duration-[120ms]";

const RADIO_CLS_ON = "bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)]";

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

const COL_ORDER = [
  { id: "INTAKE", label: "INTAKE" },
  { id: "TRIAGE", label: "TRIAGE" },
  { id: "FIELD", label: "IN-FIELD" },
  { id: "REVIEW", label: "REVIEW" },
  { id: "SEALED", label: "SEALED" },
] as const;

const PRI_OPTS = ["P0", "P1", "P2", "P3"] as const;

// ── useDebounce ───────────────────────────────────────────────────────────────

function useDebounced(
  value: string,
  delay: number,
  onChange: (v: string) => void,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onChangeRef.current(value);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay]);
}

// ── TaskEditPanel ─────────────────────────────────────────────────────────────

export interface TaskEditPanelProps {
  task: BoardTask;
  operations: BoardOperation[];
  cycles: BoardCycle[];
  onClose: () => void;
  onOpenPage?: (path: string) => void;
  onOpenDossier?: (link: string) => void;
}

export function TaskEditPanel({
  task,
  operations,
  cycles,
  onClose,
  onOpenPage,
  onOpenDossier,
}: TaskEditPanelProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const patch = usePatchTask();
  const del = useDeleteTask();

  // Local mirror of text fields that debounce before patching
  const [titleVal, setTitleVal] = useState(task.title);
  const [assigneeVal, setAssigneeVal] = useState(task.assignee ?? "");
  const [estimateVal, setEstimateVal] = useState(task.estimate ?? "");
  const [dueVal, setDueVal] = useState(task.due ?? "");
  const [holdReason, setHoldReason] = useState(task.hold ?? "");
  const [linkVal, setLinkVal] = useState(task.link ?? "");
  const [tagsVal, setTagsVal] = useState(task.tags.join(", "));

  // Destroy confirmation state
  const [destroying, setDestroying] = useState(false);

  // Sync local mirrors when the task identity changes (different editTaskId)
  const taskId = task.id;
  useEffect(() => {
    setTitleVal(task.title);
    setAssigneeVal(task.assignee ?? "");
    setEstimateVal(task.estimate ?? "");
    setDueVal(task.due ?? "");
    setHoldReason(task.hold ?? "");
    setLinkVal(task.link ?? "");
    setTagsVal(task.tags.join(", "));
    setDestroying(false);
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps — intentional

  // Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Immediate patch helper
  const patchNow = useCallback(
    (p: Parameters<typeof patch.mutate>[0]["patch"]) => {
      patch.mutate({ id: task.id, patch: p });
    },
    [patch, task.id],
  );

  // Debounced patches (300ms)
  useDebounced(titleVal, 300, (v) => {
    if (v.trim() && v !== task.title) patchNow({ title: v.trim() });
  });
  useDebounced(assigneeVal, 300, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.assignee ?? null)) patchNow({ assignee: trimmed });
  });
  useDebounced(estimateVal, 300, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.estimate ?? null)) patchNow({ estimate: trimmed });
  });
  useDebounced(dueVal, 300, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.due ?? null)) patchNow({ due: trimmed });
  });
  useDebounced(holdReason, 300, (v) => {
    if (task.hold && v !== task.hold) patchNow({ hold: v.trim() || task.hold });
  });
  useDebounced(linkVal, 300, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.link ?? null)) patchNow({ link: trimmed });
  });

  // Tags: comma-sep input → immediate patch on change (debounced 300ms)
  useDebounced(tagsVal, 300, (v) => {
    const arr = v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const current = task.tags.join(",");
    if (arr.join(",") !== current) patchNow({ tags: arr });
  });

  // Checklist progress (read-only: decision 7)
  const [done, total] =
    task.checks.length >= 2 ? [task.checks[0], task.checks[1]] : [0, 0];
  const pct = total > 0 ? (done / total) * 100 : 0;

  const barColor = PRI_BAR_COLOR[task.priority] ?? "var(--ink-3)";
  const priTextColor = PRI_TEXT_COLOR[task.priority] ?? "var(--ink-mute)";

  // Active operation code for header display
  const opCode = task.project
    ? (operations.find((op) => op.project === task.project)?.code ??
      task.project)
    : "UNFILED";

  return (
    <>
      {/* Scrim */}
      <div
        className="absolute inset-0 z-40 bg-black/28"
        onClick={onClose}
        data-testid="edit-panel-scrim"
      />

      {/* Panel */}
      <div
        className="absolute bottom-0 right-0 top-0 z-50 flex w-[340px] max-w-[92%] flex-col bg-[var(--bg-2)] border-l border-[var(--ink-3)]"
        style={{ boxShadow: "-16px 0 40px rgba(0,0,0,0.45)" }}
        onClick={(e) => e.stopPropagation()}
        data-testid="edit-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Edit Tasking"
      >
        {/* Panel header */}
        <div className="relative flex items-center gap-[8px] bg-[var(--bg)] px-[12px] py-[10px] pl-[16px] border-b border-[var(--rule)]">
          {/* Priority bar */}
          <span
            className="absolute bottom-0 left-0 top-0 w-[3px]"
            style={{ background: barColor }}
            aria-hidden
          />
          <span
            className="cl-mono text-[var(--fs-s)] tracking-[0.06em] text-[var(--ink)] font-variant-numeric"
            data-testid="edit-panel-code"
          >
            {task.code}
          </span>
          <span
            className="cl-mono border px-[4px] py-0 text-[var(--fs-xs)] tracking-[0.08em]"
            style={{ color: priTextColor, borderColor: priTextColor }}
            data-testid="edit-panel-priority"
          >
            {task.priority}
          </span>
          <span
            className="cl-mono ml-auto border border-[var(--rule)] px-[5px] py-0 text-[var(--fs-xs)] tracking-[0.1em] text-[var(--ink-3)]"
            data-testid="edit-panel-op"
          >
            {opCode}
          </span>
          <button
            type="button"
            className="cl-mono inline-flex h-[22px] w-[22px] items-center justify-center border border-[var(--rule)] text-[13px] text-[var(--ink-3)] cursor-pointer hover:border-[var(--hot)] hover:text-[var(--hot)]"
            onClick={onClose}
            data-testid="edit-panel-close"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Panel body */}
        <div className="flex flex-1 flex-col gap-[13px] overflow-y-auto p-[14px_12px]">
          {/* TITLE */}
          <EdField label="TASKING / TITLE">
            <textarea
              className="cl-mono w-full resize-none border border-[var(--rule)] bg-transparent px-[9px] py-[7px] text-[var(--fs-s)] font-semibold uppercase tracking-[0.02em] text-[var(--ink)] leading-[1.3] outline-none focus:border-[var(--hot)]"
              rows={2}
              value={titleVal}
              onChange={(e) => setTitleVal(e.target.value)}
              data-testid="edit-panel-title"
            />
          </EdField>

          {/* DISPOSITION */}
          <EdField label="DISPOSITION">
            <div className="flex gap-[6px]">
              {COL_ORDER.map((col) => (
                <button
                  key={col.id}
                  type="button"
                  className={`${RADIO_CLS_BASE} ${task.status === col.id ? RADIO_CLS_ON : "hover:text-[var(--ink)] hover:border-[var(--ink-3)]"}`}
                  onClick={() => patchNow({ status: col.id })}
                  data-testid={`edit-panel-status-${col.id}`}
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
                  className={RADIO_CLS_BASE}
                  style={
                    task.priority === p ? PRI_ON_STYLE[p] : PRI_OFF_STYLE[p]
                  }
                  onClick={() => patchNow({ priority: p })}
                  data-testid={`edit-panel-priority-${p}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </EdField>

          {/* OPERATION + CYCLE */}
          <div className="grid grid-cols-2 gap-[12px]">
            <EdField label="OPERATION">
              <select
                className={SELECT_CLS}
                value={task.project ?? ""}
                onChange={(e) =>
                  /* empty string is the sentinel for clear → UNFILED */
                  patchNow({ project: e.target.value })
                }
                data-testid="edit-panel-operation"
              >
                <option value="">UNFILED</option>
                {operations.map((op) => (
                  <option key={op.id} value={opKey(op)}>
                    {op.code}
                  </option>
                ))}
              </select>
            </EdField>
            <EdField label="CYCLE">
              <select
                className={SELECT_CLS}
                value={task.cycle ?? "BACKLOG"}
                onChange={(e) => {
                  const v = e.target.value;
                  /* BACKLOG → send null to clear cycle */
                  patchNow({ cycle: v === "BACKLOG" ? null : v });
                }}
                data-testid="edit-panel-cycle"
              >
                <option value="BACKLOG">BACKLOG</option>
                {cycles.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.code} ({c.state})
                  </option>
                ))}
              </select>
            </EdField>
          </div>

          {/* OPERATOR / EST / DUE */}
          <div className="grid grid-cols-3 gap-[12px]">
            <EdField label="OPERATOR">
              <input
                type="text"
                className={INPUT_CLS}
                value={assigneeVal}
                onChange={(e) => setAssigneeVal(e.target.value)}
                data-testid="edit-panel-assignee"
              />
            </EdField>
            <EdField label="EST">
              <input
                type="text"
                className={INPUT_CLS}
                value={estimateVal}
                onChange={(e) => setEstimateVal(e.target.value)}
                data-testid="edit-panel-estimate"
              />
            </EdField>
            <EdField label="DUE" hint="YYYY-MM-DD">
              <input
                type="text"
                className={INPUT_CLS}
                value={dueVal}
                onChange={(e) => setDueVal(e.target.value)}
                data-testid="edit-panel-due"
              />
            </EdField>
          </div>

          {/* CHECKLIST — read-only (plan decision 7).
              The markdown body is the source of truth for checklist items.
              We show progress + an "OPEN PAGE →" affordance. */}
          <EdField
            label="CHECKLIST"
            hint={total ? `${done} / ${total} done` : "none"}
          >
            <div className="flex flex-col gap-[8px]">
              {/* Progress bar */}
              <div className="h-[6px] w-full border border-[var(--rule)] bg-[var(--bg-3)]">
                <i
                  className="block h-full"
                  style={{
                    width: `${pct}%`,
                    background:
                      total > 0 && done === total
                        ? "var(--cool)"
                        : "var(--ink-2)",
                  }}
                  data-testid="edit-panel-checklist-bar"
                />
              </div>
              {/* Open page link */}
              <button
                type="button"
                className="cl-btn self-start text-[var(--fs-xs)]"
                onClick={() => onOpenPage?.(task.path)}
                data-testid="edit-panel-open-page"
              >
                OPEN PAGE →
              </button>
            </div>
          </EdField>

          {/* TAGS */}
          <EdField label="TAGS" hint="comma-sep">
            <input
              type="text"
              className={INPUT_CLS}
              value={tagsVal}
              onChange={(e) => setTagsVal(e.target.value)}
              data-testid="edit-panel-tags"
            />
          </EdField>

          {/* HOLD / BLOCKER */}
          <EdField label="HOLD / BLOCKER">
            <div className="flex flex-col gap-[7px]">
              <button
                type="button"
                className={`${RADIO_CLS_BASE} w-full`}
                style={
                  task.hold
                    ? {
                        background: "var(--hot)",
                        borderColor: "var(--hot)",
                        color: "#000",
                      }
                    : undefined
                }
                onClick={() =>
                  patchNow({
                    hold: task.hold ? null : "BLOCKED — STATE REASON",
                  })
                }
                data-testid="edit-panel-hold-toggle"
              >
                {task.hold ? "▲ ON HOLD" : "ACTIVE"}
              </button>
              {task.hold && (
                <input
                  type="text"
                  className={INPUT_CLS}
                  value={holdReason}
                  onChange={(e) => setHoldReason(e.target.value)}
                  data-testid="edit-panel-hold-reason"
                />
              )}
            </div>
          </EdField>

          {/* DOSSIER LINK */}
          <EdField label="DOSSIER LINK" hint="optional">
            <div className="flex gap-[8px]">
              <input
                type="text"
                className={`${INPUT_CLS} flex-1`}
                placeholder="[[dossier]]"
                value={linkVal}
                onChange={(e) => setLinkVal(e.target.value)}
                data-testid="edit-panel-link"
              />
              {task.link && (
                <button
                  type="button"
                  className="cl-btn whitespace-nowrap"
                  onClick={() => onOpenDossier?.(task.link!)}
                  data-testid="edit-panel-open-dossier"
                >
                  OPEN →
                </button>
              )}
            </div>
          </EdField>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg)] px-[12px] py-[10px]">
          {/* Two-step destroy */}
          {destroying ? (
            <button
              type="button"
              className="cl-mono cursor-pointer border border-[var(--hot)] bg-[var(--hot)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[#000]"
              onClick={() => {
                del.mutate(
                  { path: task.path },
                  {
                    onSuccess: () => {
                      setEditTaskId(null);
                    },
                  },
                );
                setDestroying(false);
              }}
              data-testid="edit-panel-destroy-confirm"
            >
              CONFIRM DESTROY?
            </button>
          ) : (
            <button
              type="button"
              className="cl-mono cursor-pointer border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-[background,color,border-color] duration-[120ms] hover:border-[var(--hot)] hover:bg-[var(--hot)] hover:text-[#000]"
              onClick={() => setDestroying(true)}
              data-testid="edit-panel-destroy"
            >
              ✕ DESTROY
            </button>
          )}
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-4)]">
            EDITS AUTO-SEALED
          </span>
        </div>
      </div>
    </>
  );
}
