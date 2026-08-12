/**
 * TaskEditPanel — right-docked edit drawer for a board task.
 *
 * Opens when editTaskId is set in the board store and the task exists in the
 * current board data. Positioned absolute right-0, full height, w-[340px].
 * A scrim behind it closes the panel on click; the panel itself stops
 * propagation.
 *
 * A11y deviation from the house react-aria Dialog: the right-dock layout is
 * absolutely positioned inside the board body (not a centered portal overlay),
 * so the RAC ModalOverlay/Modal primitives don't fit. We hand-roll role=dialog
 * + aria-modal and an Escape-to-close listener, but focus containment and
 * restore are delegated to react-aria's `FocusScope` (contain + restoreFocus
 * + autoFocus) wrapping the panel — it traps Tab inside the panel while open
 * and restores focus to the previously-focused element on close.
 *
 * All edits are sent as optimistic PATCHes:
 *   - Immediate: disposition (status), priority, operation select, cycle select,
 *     hold toggle.
 *   - Debounced 300ms: title, assignee, estimate, start, due, hold reason,
 *     link, tags.
 *     Pending debounces are flushed on unmount (close/task-switch) so edits
 *     aren't dropped — unless a DESTROY is in flight (suppressed to avoid a
 *     trailing PATCH at the just-deleted task).
 *
 * Checklist deviation (plan decision 7):
 *   The checklist is read-only. We show a progress bar + "d / total done"
 *   and an "OPEN PAGE →" affordance (calls onOpenPage(task.path)). The
 *   markdown body is the source of truth for checklist items.
 *
 * Destroy: two-step confirm — first click arms the button ("CONFIRM
 * DESTROY?"), second fires DELETE. The armed state auto-disarms after 3s
 * and on pointer-leave of the footer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FocusScope } from "react-aria";
import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { useDeleteTask, usePatchTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { opKey } from "./board-constants";
import { ChecklistBar } from "./board-presentation";
import { checklistProgress } from "./board-stats";
import {
  DispositionRow,
  EdField,
  INPUT_CLS,
  PriorityRow,
  RADIO_CLS_BASE,
  SELECT_CLS,
} from "./fields";

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

/** How long the armed "CONFIRM DESTROY?" state persists before auto-disarm. */
const DESTROY_DISARM_MS = 3000;

// ── useDebounce ───────────────────────────────────────────────────────────────

function useDebounced(
  value: string,
  delay: number,
  onChange: (v: string) => void,
  /**
   * When suppress.current is true, neither the timer nor the unmount flush
   * delivers the pending value — set before DELETE so no trailing PATCH is
   * fired at a just-destroyed task.
   */
  suppress?: React.RefObject<boolean>,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Latest value not yet delivered to onChange. Non-null only while a timer
  // is pending — lets the unmount cleanup flush instead of dropping the edit.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = value;
    timer.current = setTimeout(() => {
      pending.current = null;
      if (suppress?.current) return;
      onChangeRef.current(value);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, suppress]);

  // Flush on unmount: closing the panel (✕ / Escape / scrim) or switching
  // tasks within the debounce window must not silently lose the edit. The
  // per-field onChange guards (value !== task.field) make a no-edit flush a
  // no-op; a pending DESTROY suppresses the flush entirely.
  useEffect(
    () => () => {
      if (pending.current !== null) {
        const v = pending.current;
        pending.current = null;
        if (suppress?.current) return;
        onChangeRef.current(v);
      }
    },
    [suppress],
  );
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

  // Shared kill-switch for all pending debounced edits (see useDebounced).
  const suppressFlush = useRef(false);

  // Local mirror of text fields that debounce before patching
  const [titleVal, setTitleVal] = useState(task.title);
  const [assigneeVal, setAssigneeVal] = useState(task.assignee ?? "");
  const [estimateVal, setEstimateVal] = useState(task.estimate ?? "");
  const [startVal, setStartVal] = useState(task.start ?? "");
  const [dueVal, setDueVal] = useState(task.due ?? "");
  const [holdReason, setHoldReason] = useState(task.hold ?? "");
  const [linkVal, setLinkVal] = useState(task.link ?? "");
  const [tagsVal, setTagsVal] = useState(task.tags.join(", "));

  // Destroy confirmation state (two-step; auto-disarms)
  const [destroying, setDestroying] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hold toggle focus-on-activation: when the toggle is clicked to turn hold on,
  // set focusReasonOnHold.current to true. When the optimistic patch flips task.hold
  // to truthy on the next render, the useEffect below fires focus + select.
  const holdReasonRef = useRef<HTMLInputElement>(null);
  const focusReasonOnHold = useRef(false);
  const [needsFocus, setNeedsFocus] = useState(false);

  const disarmDestroy = useCallback(() => {
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = null;
    setDestroying(false);
  }, []);

  const armDestroy = useCallback(() => {
    setDestroying(true);
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    disarmTimer.current = setTimeout(
      () => setDestroying(false),
      DESTROY_DISARM_MS,
    );
  }, []);

  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    [],
  );

  // Sync local mirrors when the task identity changes (different editTaskId)
  const taskId = task.id;
  useEffect(() => {
    setTitleVal(task.title);
    setAssigneeVal(task.assignee ?? "");
    setEstimateVal(task.estimate ?? "");
    setStartVal(task.start ?? "");
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

  // When hold toggle is activated (task.hold becomes truthy from an optimistic
  // patch), sync the reason input's state with the hold value.
  useEffect(() => {
    if (task.hold && focusReasonOnHold.current) {
      focusReasonOnHold.current = false;
      // Sync the state with the new hold value so the input is populated
      setHoldReason(task.hold ?? "");
      // Signal that we need to focus after state updates
      setNeedsFocus(true);
    }
  }, [task.hold]);

  // After holdReason state has been updated, focus and select the input
  useEffect(() => {
    if (needsFocus && holdReasonRef.current) {
      holdReasonRef.current.focus();
      holdReasonRef.current.select();
      setNeedsFocus(false);
    }
  }, [needsFocus]);

  // Focus containment and restore are handled by the FocusScope wrapping the
  // panel below (see header comment); panelRef remains for its tabIndex={-1}
  // fallback focus target.
  const panelRef = useRef<HTMLDivElement>(null);

  // Immediate patch helper
  const patchNow = useCallback(
    (p: Parameters<typeof patch.mutate>[0]["patch"]) => {
      patch.mutate({ id: task.id, patch: p });
    },
    [patch, task.id],
  );

  // Debounced patches (300ms)
  useDebounced(
    titleVal,
    300,
    (v) => {
      if (v.trim() && v !== task.title) patchNow({ title: v.trim() });
    },
    suppressFlush,
  );
  useDebounced(
    assigneeVal,
    300,
    (v) => {
      const trimmed = v.trim() || null;
      if (trimmed !== (task.assignee ?? null)) patchNow({ assignee: trimmed });
    },
    suppressFlush,
  );
  useDebounced(
    estimateVal,
    300,
    (v) => {
      const trimmed = v.trim() || null;
      if (trimmed !== (task.estimate ?? null)) patchNow({ estimate: trimmed });
    },
    suppressFlush,
  );
  useDebounced(
    dueVal,
    300,
    (v) => {
      const trimmed = v.trim() || null;
      if (trimmed !== (task.due ?? null)) patchNow({ due: trimmed });
    },
    suppressFlush,
  );
  useDebounced(
    startVal,
    300,
    (v) => {
      const trimmed = v.trim() || null;
      if (trimmed !== (task.start ?? null)) patchNow({ start: trimmed });
    },
    suppressFlush,
  );
  // Asymmetric guard, deliberately: the reason input only exists while the
  // task is held (task.hold truthy), and an emptied reason falls back to the
  // previous reason rather than clearing the hold — clearing the hold is the
  // toggle's job (hold: null), never a side effect of editing the reason.
  useDebounced(
    holdReason,
    300,
    (v) => {
      if (task.hold && v !== task.hold)
        patchNow({ hold: v.trim() || task.hold });
    },
    suppressFlush,
  );
  useDebounced(
    linkVal,
    300,
    (v) => {
      const trimmed = v.trim() || null;
      if (trimmed !== (task.link ?? null)) patchNow({ link: trimmed });
    },
    suppressFlush,
  );

  // Tags: comma-sep input → debounced 300ms like the other text fields
  useDebounced(
    tagsVal,
    300,
    (v) => {
      const arr = v
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const current = task.tags.join(",");
      if (arr.join(",") !== current) patchNow({ tags: arr });
    },
    suppressFlush,
  );

  // Checklist progress (read-only: decision 7)
  const {
    done,
    total,
    percent: pct,
    isComplete,
  } = checklistProgress(task.checks);

  const barColor = PRI_BAR_COLOR[task.priority] ?? "var(--ink-3)";
  const priTextColor = PRI_TEXT_COLOR[task.priority] ?? "var(--ink-mute)";

  // A board:true PROJECT page with no project: frontmatter has no valid
  // filter/assignment key (filterTasks compares t.project === opFilter, and
  // a slug-less op's key can never match a task's project) — exclude it so
  // a task can't be reassigned to it.
  const assignableOps = operations.filter((op) => Boolean(op.project));

  // Closed cycles are not assignable except to tasks already in them
  // (so the current value remains representable).
  const selectableCycles = cycles.filter(
    (c) => c.state !== "CLOSED" || c.code === task.cycle,
  );

  // Active operation code for header display
  const opCode = task.project
    ? (operations.find((op) => op.project === task.project)?.code ??
      task.project)
    : "UNFILED";

  const confirmDestroy = () => {
    // Kill any pending debounced edits BEFORE the DELETE — a trailing PATCH
    // at the just-deleted task would 404.
    suppressFlush.current = true;
    if (disarmTimer.current) clearTimeout(disarmTimer.current);
    del.mutate(
      { path: task.path },
      {
        onSuccess: () => {
          setEditTaskId(null);
        },
        onError: () => {
          // Page still exists — re-enable edit flushing.
          suppressFlush.current = false;
        },
      },
    );
    setDestroying(false);
  };

  return (
    <>
      {/* Scrim */}
      <div
        className="absolute inset-0 z-40 bg-black/28"
        onClick={onClose}
        data-testid="edit-panel-scrim"
      />

      {/* Panel */}
      <FocusScope contain restoreFocus autoFocus>
        <div
          ref={panelRef}
          tabIndex={-1}
          className="absolute bottom-0 right-0 top-0 z-50 flex w-[340px] max-w-[92%] flex-col bg-[var(--bg-2)] border-l border-[var(--ink-3)] outline-none"
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
              <DispositionRow
                value={task.status}
                onChange={(colId) => patchNow({ status: colId })}
                testIdPrefix="edit-panel"
              />
            </EdField>

            {/* PRIORITY */}
            <EdField label="PRIORITY">
              <PriorityRow
                value={task.priority}
                onChange={(p) => patchNow({ priority: p })}
                testIdPrefix="edit-panel"
              />
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
                  {assignableOps.map((op) => (
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
                  {selectableCycles.map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code} ({c.state})
                    </option>
                  ))}
                </select>
              </EdField>
            </div>

            {/* OPERATOR / EST */}
            <div className="grid grid-cols-2 gap-[12px]">
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
            </div>

            {/* START / DUE */}
            <div className="grid grid-cols-2 gap-[12px]">
              <EdField label="START" hint="YYYY-MM-DD">
                <input
                  type="date"
                  className={INPUT_CLS}
                  value={startVal}
                  onChange={(e) => setStartVal(e.target.value)}
                  data-testid="edit-panel-start"
                />
              </EdField>
              <EdField label="DUE" hint="YYYY-MM-DD">
                <input
                  type="date"
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
                <ChecklistBar
                  percent={pct}
                  isComplete={isComplete}
                  className="h-[6px] w-full"
                  indicatorTestId="edit-panel-checklist-bar"
                />
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
                  onClick={() => {
                    if (!task.hold) focusReasonOnHold.current = true;
                    patchNow({
                      hold: task.hold ? null : "BLOCKED",
                    });
                  }}
                  data-testid="edit-panel-hold-toggle"
                >
                  {task.hold ? "▲ ON HOLD" : "ACTIVE"}
                </button>
                {task.hold && (
                  <input
                    ref={holdReasonRef}
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

          {/* Footer — leaving it disarms a pending destroy */}
          <div
            className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg)] px-[12px] py-[10px]"
            onPointerLeave={() => {
              if (destroying) disarmDestroy();
            }}
            data-testid="edit-panel-foot"
          >
            {/* Two-step destroy */}
            {destroying ? (
              <button
                type="button"
                className="cl-mono cursor-pointer border border-[var(--hot)] bg-[var(--hot)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[#000]"
                onClick={confirmDestroy}
                data-testid="edit-panel-destroy-confirm"
              >
                CONFIRM DESTROY?
              </button>
            ) : (
              <button
                type="button"
                className="cl-mono cursor-pointer border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-[background,color,border-color] duration-[120ms] hover:border-[var(--hot)] hover:bg-[var(--hot)] hover:text-[#000]"
                onClick={armDestroy}
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
      </FocusScope>
    </>
  );
}
