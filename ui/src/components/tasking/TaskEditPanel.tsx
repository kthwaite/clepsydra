/**
 * TaskEditPanel — floating right dock for editing a board task.
 *
 * Opens when editTaskId is set in the board store and the task exists in the
 * current board data. The dock floats inside the board body on `raise`
 * (18px radius, overlay shadow). There is no dim scrim: the board stays
 * undimmed (approved Stone & Lamp ruling). A transparent layer behind the
 * dock still closes it on an outside click.
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
 *   - Immediate: disposition (status), priority, project select, cycle select,
 *     hold toggle.
 *   - Debounced 300ms: title, assignee, estimate, start, due, hold reason,
 *     link, tags.
 *     Pending debounces are flushed on unmount (close/task-switch) so edits
 *     aren't dropped. Archiving explicitly flushes and awaits every pending
 *     patch before it sends DELETE.
 *
 * Checklist deviation (plan decision 7):
 *   The checklist is read-only. We show a progress bar + "d of total done"
 *   and an "Open page" affordance (calls onOpenPage(task.path)). The
 *   markdown body is the source of truth for checklist items.
 *
 * Archive: two-step confirm — first click arms the button ("Confirm
 * archive"), second saves pending edits and archives the page. The armed
 * state auto-disarms after 3s and on pointer-leave of the footer.
 */

import { ArrowRight, Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FocusScope } from "react-aria";
import type { BoardCycle, BoardTask, PatchTaskRequest } from "#/api/board";
import { useArchiveTask, usePatchTask } from "#/api/board";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import {
  type ColLabelFn,
  cycleStateLabel,
  PRI_LABEL,
  priColor,
} from "./board-constants";
import { ChecklistBar } from "./board-presentation";
import type { ProjectScope } from "./board-projects";
import { checklistProgress } from "./board-stats";
import { DispositionRow, EdField, INPUT_CLS, PriorityRow } from "./fields";

/** How long the armed "Confirm archive" state persists before auto-disarm. */
const ARCHIVE_DISARM_MS = 3000;

/** Debounce delay for text-field patches (title, assignee, estimate, …). */
const DEBOUNCE_MS = 300;

type PatchIntentLane =
  | "title"
  | "assignee"
  | "estimate"
  | "due"
  | "start"
  | "holdReason"
  | "link"
  | "tags"
  | "status"
  | "priority"
  | "project"
  | "cycle"
  | "holdToggle";

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
  /** Project scopes (operations ∪ task slugs) — see deriveProjectScopes. */
  projects: ProjectScope[];
  cycles: BoardCycle[];
  colLabel: ColLabelFn;
  onClose: () => void;
  onOpenPage?: (path: string) => void;
  onOpenDossier?: (link: string) => void;
}

export function TaskEditPanel({
  task,
  projects,
  cycles,
  colLabel,
  onClose,
  onOpenPage,
  onOpenDossier,
}: TaskEditPanelProps) {
  const setEditTaskId = useBoardStore((s) => s.setEditTaskId);
  const patch = usePatchTask();
  const archive = useArchiveTask();
  const link = task.link;

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
  const failedPatchLanes = useRef(new Set<PatchIntentLane>());
  const laneVersions = useRef<Partial<Record<PatchIntentLane, number>>>({});
  const coordinatorTaskId = useRef(task.id);
  const latestTaskPath = useRef(task.path);
  const enqueuePatch = useCallback(
    (lane: PatchIntentLane, nextPatch: PatchTaskRequest) => {
      const requestTaskId = task.id;
      const intentVersion = (laneVersions.current[lane] ?? 0) + 1;
      laneVersions.current[lane] = intentVersion;
      const request = patchQueue.current.then(async () => {
        try {
          const savedTask = await patchAsync({
            id: requestTaskId,
            patch: nextPatch,
          });
          if (coordinatorTaskId.current === requestTaskId) {
            latestTaskPath.current = savedTask.path;
            if (laneVersions.current[lane] === intentVersion) {
              failedPatchLanes.current.delete(lane);
            }
          }
        } catch (error) {
          if (
            coordinatorTaskId.current === requestTaskId &&
            laneVersions.current[lane] === intentVersion
          ) {
            failedPatchLanes.current.add(lane);
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
    (lane: PatchIntentLane, nextPatch: PatchTaskRequest) => {
      void enqueuePatch(lane, nextPatch).catch(() => undefined);
    },
    [enqueuePatch],
  );
  const savePatch = enqueuePatch;
  const clearPatchFailure = useCallback((lane: PatchIntentLane) => {
    laneVersions.current[lane] = (laneVersions.current[lane] ?? 0) + 1;
    failedPatchLanes.current.delete(lane);
  }, []);
  const awaitPatchBarrier = useCallback(async () => {
    await patchQueue.current;
    if (failedPatchLanes.current.size > 0) {
      throw new Error("One or more task edits failed to save.");
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only for a new task identity
  useEffect(() => {
    coordinatorTaskId.current = task.id;
    latestTaskPath.current = task.path;
    laneVersions.current = {};
    failedPatchLanes.current.clear();
  }, [task.id]);

  // Debounced patches (300ms). Each hook exposes an awaited flush used by
  // archive so no local edit can be discarded or race the DELETE.
  const flushTitle = useDebounced(titleVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== task.title)
      return savePatch("title", { title: trimmed });
    if (trimmed === task.title) clearPatchFailure("title");
  });
  const flushAssignee = useDebounced(assigneeVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.assignee ?? null))
      return savePatch("assignee", { assignee: trimmed });
    clearPatchFailure("assignee");
  });
  const flushEstimate = useDebounced(estimateVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.estimate ?? null))
      return savePatch("estimate", { estimate: trimmed });
    clearPatchFailure("estimate");
  });
  const flushDue = useDebounced(dueVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.due ?? null))
      return savePatch("due", { due: trimmed });
    clearPatchFailure("due");
  });
  const flushStart = useDebounced(startVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.start ?? null))
      return savePatch("start", { start: trimmed });
    clearPatchFailure("start");
  });
  // Asymmetric guard, deliberately: the reason input only exists while the
  // task is held (task.hold truthy), and an emptied reason falls back to the
  // previous reason rather than clearing the hold — clearing the hold is the
  // toggle's job (hold: null), never a side effect of editing the reason.
  const flushHoldReason = useDebounced(holdReason, DEBOUNCE_MS, (v) => {
    if (task.hold && v !== task.hold)
      return savePatch("holdReason", { hold: v.trim() || task.hold });
    if (v === task.hold) clearPatchFailure("holdReason");
  });
  const flushLink = useDebounced(linkVal, DEBOUNCE_MS, (v) => {
    const trimmed = v.trim() || null;
    if (trimmed !== (task.link ?? null))
      return savePatch("link", { link: trimmed });
    clearPatchFailure("link");
  });

  // Tags: comma-sep input → debounced 300ms like the other text fields
  const flushTags = useDebounced(tagsVal, DEBOUNCE_MS, (v) => {
    const arr = v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const current = task.tags.join(",");
    if (arr.join(",") !== current) return savePatch("tags", { tags: arr });
    clearPatchFailure("tags");
  });

  // Checklist progress (read-only: decision 7)
  const {
    done,
    total,
    percent: pct,
    isComplete,
  } = checklistProgress(task.checks);

  const { bar: barColor, text: priTextColor } = priColor(task.priority);

  // A PROJECT page with no project: frontmatter has no valid assignment key
  // (a task's project is a slug, and a slug-less op has none) — exclude it
  // so a task can't be reassigned to it. Synthesized scopes (slug with no
  // page) are assignable: the slug is the project.
  const assignableScopes = projects.filter((p) => p.slug !== null);

  // Closed cycles are not assignable except to tasks already in them
  // (so the current value remains representable).
  const selectableCycles = cycles.filter(
    (c) => c.state !== "CLOSED" || c.code === task.cycle,
  );

  // Active project code for header display
  const opCode = task.project
    ? (projects.find((p) => p.slug === task.project)?.code ?? task.project)
    : "No project";

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
      await archive.mutateAsync({ path: latestTaskPath.current });
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
      {/* Transparent click-outside layer — no dimming (the board stays
          undimmed by design); it only catches the dismissing click. */}
      <button
        type="button"
        aria-label="Close task editor"
        className="absolute inset-0 z-40 cursor-default bg-transparent"
        onClick={onClose}
        disabled={archiving}
        data-testid="edit-panel-dismiss"
      />

      {/* Dock */}
      <FocusScope contain restoreFocus autoFocus>
        <div
          ref={panelRef}
          tabIndex={-1}
          className="absolute top-3.5 right-4 bottom-3.5 z-50 flex w-[420px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-[18px] bg-raise shadow-lg outline-none"
          data-testid="edit-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Edit task"
        >
          {/* Dock header */}
          <div className="flex shrink-0 items-center gap-2.5 pt-4 pr-4 pl-6">
            {/* Priority bar */}
            <span
              className="h-4 w-[3px] shrink-0 rounded-sm"
              style={{ background: barColor }}
              aria-hidden
            />
            <span
              className="text-[13.5px] text-ink-2 tabular-nums"
              data-testid="edit-panel-code"
            >
              {task.code}
            </span>
            <span
              className="inline-flex h-5.5 items-center rounded-full px-2 text-[12px]"
              style={{
                color: priTextColor,
                background: `color-mix(in srgb, ${priTextColor} 10%, transparent)`,
              }}
              data-testid="edit-panel-priority"
            >
              {task.priority}
              {PRI_LABEL[task.priority] ? ` · ${PRI_LABEL[task.priority]}` : ""}
            </span>
            <span
              className="ml-auto min-w-0 truncate text-[12.5px] text-mute"
              data-testid="edit-panel-op"
            >
              {opCode}
            </span>
            <IconButton
              className="h-9 w-9 text-mute"
              onPress={onClose}
              isDisabled={archiving}
              data-testid="edit-panel-close"
              aria-label="Close"
            >
              <X aria-hidden />
            </IconButton>
          </div>

          {/* Dock body — a fade at the foot hints at more fields below */}
          <div className="relative min-h-0 flex-1">
            <fieldset
              className="m-0 flex h-full min-w-0 flex-col gap-4.5 overflow-y-auto px-6 pt-3 pb-6"
              disabled={archiving}
              data-testid="edit-panel-fields"
            >
              <legend className="sr-only">Task fields</legend>

              {/* Title — serif, borderless */}
              <textarea
                className={cn(
                  "-mx-2.5 resize-none rounded-[10px] bg-transparent px-2.5 py-1.5 font-serif text-[26px] leading-[1.15] text-ink hover:bg-sink/50",
                  FOCUS_RING_NATIVE,
                )}
                rows={2}
                aria-label="Title"
                value={titleVal}
                onChange={(e) => setTitleVal(e.target.value)}
                data-testid="edit-panel-title"
              />

              <EdField label="Status">
                <DispositionRow
                  value={task.status}
                  onChange={(colId) => patchNow("status", { status: colId })}
                  testIdPrefix="edit-panel"
                  colLabel={colLabel}
                />
              </EdField>

              <EdField label="Priority">
                <PriorityRow
                  value={task.priority}
                  onChange={(p) => patchNow("priority", { priority: p })}
                  testIdPrefix="edit-panel"
                />
              </EdField>

              {/* Project + cycle */}
              <div className="grid grid-cols-2 gap-3.5">
                <EdField label="Project">
                  <Select
                    aria-label="Project"
                    value={task.project ?? ""}
                    onChange={(key) =>
                      /* empty string is the sentinel for clear → UNFILED */
                      patchNow("project", {
                        project: key === null ? "" : String(key),
                      })
                    }
                    isDisabled={archiving}
                    data-testid="edit-panel-project"
                  >
                    <SelectItem id="">No project</SelectItem>
                    {assignableScopes.map((scope) => (
                      <SelectItem
                        key={scope.key}
                        id={scope.key}
                        textValue={scope.code}
                      >
                        {scope.code}
                      </SelectItem>
                    ))}
                  </Select>
                </EdField>
                <EdField label="Cycle">
                  <Select
                    aria-label="Cycle"
                    value={task.cycle ?? "BACKLOG"}
                    onChange={(key) => {
                      const value = key === null ? "BACKLOG" : String(key);
                      /* BACKLOG → send null to clear cycle */
                      patchNow("cycle", {
                        cycle: value === "BACKLOG" ? null : value,
                      });
                    }}
                    isDisabled={archiving}
                    data-testid="edit-panel-cycle"
                  >
                    <SelectItem id="BACKLOG">Backlog</SelectItem>
                    {selectableCycles.map((c) => (
                      <SelectItem
                        key={c.id}
                        id={c.code}
                        textValue={`${c.code} (${cycleStateLabel(c.state)})`}
                      >
                        {c.code} ({cycleStateLabel(c.state)})
                      </SelectItem>
                    ))}
                  </Select>
                </EdField>
              </div>

              {/* Assignee + estimate */}
              <div className="grid grid-cols-2 gap-3.5">
                <EdField label="Assignee">
                  <input
                    type="text"
                    aria-label="Assignee"
                    className={INPUT_CLS}
                    value={assigneeVal}
                    onChange={(e) => setAssigneeVal(e.target.value)}
                    data-testid="edit-panel-assignee"
                  />
                </EdField>
                <EdField label="Estimate">
                  <input
                    type="text"
                    aria-label="Estimate"
                    className={INPUT_CLS}
                    value={estimateVal}
                    onChange={(e) => setEstimateVal(e.target.value)}
                    data-testid="edit-panel-estimate"
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
                    value={startVal}
                    onChange={(e) => setStartVal(e.target.value)}
                    data-testid="edit-panel-start"
                  />
                </EdField>
                <EdField label="Due date">
                  <input
                    type="date"
                    aria-label="Due date"
                    className={INPUT_CLS}
                    value={dueVal}
                    onChange={(e) => setDueVal(e.target.value)}
                    data-testid="edit-panel-due"
                  />
                </EdField>
              </div>

              {/* Checklist — read-only (plan decision 7). The markdown body is
                  the source of truth for checklist items; we show progress
                  and an "Open page" affordance. */}
              <EdField
                label="Checklist"
                hint={total ? `${done} of ${total} done` : "No items"}
              >
                <div className="flex items-center gap-3.5">
                  <ChecklistBar
                    percent={pct}
                    isComplete={isComplete}
                    className="h-1.5 flex-1"
                    indicatorTestId="edit-panel-checklist-bar"
                  />
                  <Button
                    size="sm"
                    className="shrink-0 rounded-full"
                    onPress={() => onOpenPage?.(task.path)}
                    data-testid="edit-panel-open-page"
                  >
                    Open page
                    <ArrowRight aria-hidden className="h-3 w-3" />
                  </Button>
                </div>
              </EdField>

              <EdField label="Tags" hint="Comma-separated">
                <input
                  type="text"
                  aria-label="Tags"
                  className={INPUT_CLS}
                  value={tagsVal}
                  onChange={(e) => setTagsVal(e.target.value)}
                  data-testid="edit-panel-tags"
                />
              </EdField>

              {/* Blocker — a switch-looking toggle button */}
              <EdField label="Blocker">
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    aria-pressed={Boolean(task.hold)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 self-start rounded-full text-[14px] text-ink-2",
                      FOCUS_RING_NATIVE,
                    )}
                    onClick={() => {
                      if (!task.hold) focusReasonOnHold.current = true;
                      patchNow("holdToggle", {
                        hold: task.hold ? null : "BLOCKED",
                      });
                    }}
                    data-testid="edit-panel-hold-toggle"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "relative h-5 w-8.5 shrink-0 rounded-full transition-colors",
                        task.hold ? "bg-hot" : "bg-faint",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.75 h-3.5 w-3.5 rounded-full bg-raise shadow-sm transition-[left]",
                          task.hold ? "left-4.25" : "left-0.75",
                        )}
                      />
                    </span>
                    {task.hold ? "Blocked" : "Not blocked"}
                  </button>
                  {task.hold && (
                    <input
                      ref={holdReasonRef}
                      type="text"
                      aria-label="Blocker"
                      className={INPUT_CLS}
                      value={holdReason}
                      onChange={(e) => setHoldReason(e.target.value)}
                      data-testid="edit-panel-hold-reason"
                    />
                  )}
                </div>
              </EdField>

              {/* Related page */}
              <EdField label="Related page" hint="Optional">
                <div className="flex gap-2">
                  <input
                    type="text"
                    aria-label="Related page"
                    className={cn(
                      INPUT_CLS,
                      "flex-1",
                      linkVal && "text-accent",
                    )}
                    placeholder="[[page]]"
                    value={linkVal}
                    onChange={(e) => setLinkVal(e.target.value)}
                    data-testid="edit-panel-link"
                  />
                  {link && (
                    <Button
                      size="sm"
                      className="h-9.5 shrink-0 rounded-full"
                      onPress={() => onOpenDossier?.(link)}
                      data-testid="edit-panel-open-dossier"
                      aria-label="Open related page"
                    >
                      Open
                      <ArrowRight aria-hidden className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </EdField>
            </fieldset>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-b from-transparent to-raise"
            />
          </div>

          {/* Footer — leaving it disarms a pending archive */}
          <div
            className="flex shrink-0 items-center justify-between gap-3 bg-ground px-6 pt-3 pb-3.5"
            onPointerLeave={() => {
              if (archiveArmed && !archiving) disarmArchive();
            }}
            data-testid="edit-panel-foot"
          >
            {/* Two-step archive */}
            {archiveArmed ? (
              <Button
                variant="danger"
                size="sm"
                onPress={() => void confirmArchive()}
                isDisabled={archiving}
                data-testid="edit-panel-archive-confirm"
              >
                {archiving ? "Archiving…" : "Confirm archive"}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-3.5 text-hot data-[hovered]:text-hot"
                onPress={armArchive}
                data-testid="edit-panel-archive"
              >
                Archive
              </Button>
            )}
            <span className="flex items-center gap-1.5 text-[12.5px] text-mute">
              {!archiving && <Check aria-hidden className="h-3 w-3" />}
              {archiving
                ? "Moving to Rubbish Bin…"
                : "Changes saved automatically"}
            </span>
          </div>
        </div>
      </FocusScope>
    </>
  );
}
