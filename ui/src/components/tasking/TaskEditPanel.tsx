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
 *     aren't dropped. Archiving explicitly flushes and awaits every pending
 *     patch before it sends DELETE.
 *
 * Checklist deviation (plan decision 7):
 *   The checklist is read-only. We show a progress bar + "d / total done"
 *   and an "OPEN PAGE →" affordance (calls onOpenPage(task.path)). The
 *   markdown body is the source of truth for checklist items.
 *
 * Archive: two-step confirm — first click arms the button ("CONFIRM
 * ARCHIVE?"), second saves pending edits and archives the page. The armed
 * state auto-disarms after 3s and on pointer-leave of the footer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FocusScope } from "react-aria";
import type {
  BoardCycle,
  BoardOperation,
  BoardTask,
  PatchTaskRequest,
} from "#/api/board";
import { useArchiveTask, usePatchTask } from "#/api/board";
import { useBoardStore } from "#/store/board";
import { type ColLabelFn, opKey, priColor } from "./board-constants";
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

/** How long the armed "CONFIRM ARCHIVE?" state persists before auto-disarm. */
const ARCHIVE_DISARM_MS = 3000;

/** Debounce delay for text-field patches (title, assignee, estimate, …). */
const DEBOUNCE_MS = 300;

// ── useDebounce ───────────────────────────────────────────────────────────────

function useDebounced(
  value: string,
  delay: number,
  onChange: (v: string) => void | Promise<void>,
): () => Promise<void> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pending = useRef<{ value: string; version: number } | null>(null);
  const version = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const active = useRef<Promise<void> | null>(null);

  const deliver = useCallback((): Promise<void> => {
    clearTimeout(timer.current ?? undefined);
    timer.current = null;
    if (pending.current === null) {
      return active.current ?? Promise.resolve();
    }

    const next = pending.current;
    pending.current = null;
    const delivery = queue.current.then(() => onChangeRef.current(next.value));
    active.current = delivery;
    queue.current = delivery.catch(() => {
      // A failed save remains pending for an explicit retry, unless a newer
      // value has already superseded it.
      if (version.current === next.version && pending.current === null) {
        pending.current = next;
      }
      return undefined;
    });
    void delivery.then(
      () => {
        if (active.current === delivery) active.current = null;
      },
      () => {
        if (active.current === delivery) active.current = null;
      },
    );
    return delivery;
  }, []);

  useEffect(() => {
    clearTimeout(timer.current ?? undefined);
    version.current += 1;
    pending.current = { value, version: version.current };
    timer.current = setTimeout(() => {
      void deliver().catch(() => undefined);
    }, delay);
    return () => {
      clearTimeout(timer.current ?? undefined);
    };
  }, [value, delay, deliver]);

  // Flush on unmount: closing the panel or switching tasks within the debounce
  // window must not silently lose the edit.
  useEffect(
    () => () => {
      void deliver().catch(() => undefined);
    },
    [deliver],
  );

  return deliver;
}

// ── TaskEditPanel ─────────────────────────────────────────────────────────────

export interface TaskEditPanelProps {
  task: BoardTask;
  operations: BoardOperation[];
  cycles: BoardCycle[];
  colLabel: ColLabelFn;
  onClose: () => void;
  onOpenPage?: (path: string) => void;
  onOpenDossier?: (link: string) => void;
}

export function TaskEditPanel({
  task,
  operations,
  cycles,
  colLabel,
  onClose,
  onOpenPage,
  onOpenDossier,
}: TaskEditPanelProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const patch = usePatchTask();
  const archive = useArchiveTask();

  // Local mirror of text fields that debounce before patching
  const [titleVal, setTitleVal] = useState(task.title);
  const [assigneeVal, setAssigneeVal] = useState(task.assignee ?? "");
  const [estimateVal, setEstimateVal] = useState(task.estimate ?? "");
  const [startVal, setStartVal] = useState(task.start ?? "");
  const [dueVal, setDueVal] = useState(task.due ?? "");
  const [holdReason, setHoldReason] = useState(task.hold ?? "");
  const [linkVal, setLinkVal] = useState(task.link ?? "");
  const [tagsVal, setTagsVal] = useState(task.tags.join(", "));

  // Archive confirmation state (two-step; auto-disarms)
  const [archiveArmed, setArchiveArmed] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hold toggle focus-on-activation: when the toggle is clicked to turn hold on,
  // set focusReasonOnHold.current to true. When the optimistic patch flips task.hold
  // to truthy on the next render, the useEffect below fires focus + select.
  const holdReasonRef = useRef<HTMLInputElement>(null);
  const focusReasonOnHold = useRef(false);
  const [needsFocus, setNeedsFocus] = useState(false);

  const disarmArchive = useCallback(() => {
    clearTimeout(disarmTimer.current ?? undefined);
    disarmTimer.current = null;
    setArchiveArmed(false);
  }, []);

  const armArchive = useCallback(() => {
    setArchiveArmed(true);
    clearTimeout(disarmTimer.current ?? undefined);
    disarmTimer.current = setTimeout(
      () => setArchiveArmed(false),
      ARCHIVE_DISARM_MS,
    );
  }, []);

  useEffect(
    () => () => {
      clearTimeout(disarmTimer.current ?? undefined);
    },
    [],
  );

  // Sync local mirrors when the task identity changes (different editTaskId)
  const taskId = task.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reinitialise only on open
  useEffect(() => {
    setTitleVal(task.title);
    setAssigneeVal(task.assignee ?? "");
    setEstimateVal(task.estimate ?? "");
    setStartVal(task.start ?? "");
    setDueVal(task.due ?? "");
    setHoldReason(task.hold ?? "");
    setLinkVal(task.link ?? "");
    setTagsVal(task.tags.join(", "));
    setArchiveArmed(false);
    setArchiving(false);
  }, [taskId]);

  // Escape closes unless the save-and-archive sequence is in flight.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !archiving) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [archiving, onClose]);

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

  // Every Tasking PATCH enters one serial queue. `mutateAsync` retains the
  // mutation hook's optimistic onMutate behavior while giving archive a single
  // barrier for immediate controls, debounced fields, and earlier failures.
  const patchAsync = patch.mutateAsync;
  const patchQueue = useRef<Promise<void>>(Promise.resolve());
  const failedPatchFields = useRef(new Set<keyof PatchTaskRequest>());
  const coordinatorTaskId = useRef(task.id);
  const enqueuePatch = useCallback(
    (nextPatch: PatchTaskRequest) => {
      const requestTaskId = task.id;
      const fields = Object.keys(nextPatch) as (keyof PatchTaskRequest)[];
      const request = patchQueue.current.then(async () => {
        try {
          await patchAsync({ id: requestTaskId, patch: nextPatch });
          if (coordinatorTaskId.current === requestTaskId) {
            for (const field of fields) failedPatchFields.current.delete(field);
          }
        } catch (error) {
          if (coordinatorTaskId.current === requestTaskId) {
            for (const field of fields) failedPatchFields.current.add(field);
          }
          throw error;
        }
      });
      patchQueue.current = request.catch(() => undefined);
      return request;
    },
    [patchAsync, task.id],
  );
  const patchNow = useCallback(
    (nextPatch: PatchTaskRequest) => {
      void enqueuePatch(nextPatch).catch(() => undefined);
    },
    [enqueuePatch],
  );
  const savePatch = enqueuePatch;
  const awaitPatchBarrier = useCallback(async () => {
    await patchQueue.current;
    if (failedPatchFields.current.size > 0) {
      throw new Error("One or more task edits failed to save.");
    }
  }, []);
  useEffect(() => {
    coordinatorTaskId.current = task.id;
    failedPatchFields.current.clear();
  }, [task.id]);


  // Debounced patches (300ms). Each hook exposes an awaited flush used by
  // archive so no local edit can be discarded or race the DELETE.
  const flushTitle = useDebounced(titleVal, DEBOUNCE_MS, (v) => {
    if (v.trim() && v !== task.title) return savePatch({ title: v.trim() });
  });
  const flushAssignee = useDebounced(assigneeVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.assignee ?? null))
      return savePatch({ assignee: trimmed });
  });
  const flushEstimate = useDebounced(estimateVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.estimate ?? null))
      return savePatch({ estimate: trimmed });
  });
  const flushDue = useDebounced(dueVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.due ?? null)) return savePatch({ due: trimmed });
  });
  const flushStart = useDebounced(startVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.start ?? null)) return savePatch({ start: trimmed });
  });
  // Asymmetric guard, deliberately: the reason input only exists while the
  // task is held (task.hold truthy), and an emptied reason falls back to the
  // previous reason rather than clearing the hold — clearing the hold is the
  // toggle's job (hold: null), never a side effect of editing the reason.
  const flushHoldReason = useDebounced(holdReason, DEBOUNCE_MS, (v) => {
    if (task.hold && v !== task.hold)
      return savePatch({ hold: v.trim() || task.hold });
  });
  const flushLink = useDebounced(linkVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.link ?? null)) return savePatch({ link: trimmed });
  });

  // Tags: comma-sep input → debounced 300ms like the other text fields
  const flushTags = useDebounced(tagsVal, DEBOUNCE_MS, (v) => {
    const arr = v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const current = task.tags.join(",");
    if (arr.join(",") !== current) return savePatch({ tags: arr });
  });

  // Checklist progress (read-only: decision 7)
  const {
    done,
    total,
    percent: pct,
    isComplete,
  } = checklistProgress(task.checks);

  const { bar: barColor, text: priTextColor } = priColor(task.priority);

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

  const confirmArchive = async () => {
    if (archiving) return;
    setArchiving(true);
    clearTimeout(disarmTimer.current ?? undefined);
    disarmTimer.current = null;

    try {
      for (const flush of [
        flushTitle,
        flushAssignee,
        flushEstimate,
        flushDue,
        flushStart,
        flushHoldReason,
        flushLink,
        flushTags,
      ]) {
        await flush();
      }
      await awaitPatchBarrier();
      await archive.mutateAsync({ path: task.path });
      setEditTaskId(null);
    } catch {
      // Both mutation hooks surface the specific failure. Keep the task open
      // and return to the retryable first-step action.
      setArchiveArmed(false);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <>
      {/* Scrim */}
      <div
        className="absolute inset-0 z-40 bg-black/28"
        onClick={archiving ? undefined : onClose}
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
              className="cl-mono inline-flex h-[22px] w-[22px] items-center justify-center border border-[var(--rule)] text-[13px] text-[var(--ink-3)] cursor-pointer hover:border-[var(--hot)] hover:text-[var(--hot)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onClose}
              disabled={archiving}
              data-testid="edit-panel-close"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Panel body */}
          <fieldset
            className="flex flex-1 flex-col gap-[13px] overflow-y-auto p-[14px_12px]"
            disabled={archiving}
            data-testid="edit-panel-fields"
          >
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
                colLabel={colLabel}
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
          </fieldset>

          {/* Footer — leaving it disarms a pending archive */}
          <div
            className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg)] px-[12px] py-[10px]"
            onPointerLeave={() => {
              if (archiveArmed && !archiving) disarmArchive();
            }}
            data-testid="edit-panel-foot"
          >
            {/* Two-step archive */}
            {archiveArmed ? (
              <button
                type="button"
                className="cl-mono cursor-pointer border border-[var(--hot)] bg-[var(--hot)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[#000] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void confirmArchive()}
                disabled={archiving}
                data-testid="edit-panel-archive-confirm"
              >
                {archiving ? "SAVING + ARCHIVING…" : "CONFIRM ARCHIVE?"}
              </button>
            ) : (
              <button
                type="button"
                className="cl-mono cursor-pointer border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--hot)] transition-[background,color,border-color] duration-[120ms] hover:border-[var(--hot)] hover:bg-[var(--hot)] hover:text-[#000]"
                onClick={armArchive}
                data-testid="edit-panel-archive"
              >
                ARCHIVE
              </button>
            )}
            <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-4)]">
              {archiving ? "MOVING TO RUBBISH BIN" : "EDITS AUTO-SEALED"}
            </span>
          </div>
        </div>
      </FocusScope>
    </>
  );
}
