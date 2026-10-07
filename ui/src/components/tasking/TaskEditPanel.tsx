/**
 * TaskEditPanel — full-height right sidebar for editing a board task.
 *
 * The dock sits beside the board on wide workspaces and overlays its right
 * edge on narrower ones. It is non-modal: cards and board controls remain
 * usable, including switching directly to another task. FocusScope supplies
 * initial focus and restores focus on close without trapping Tab.
 *
 * All edits are sent as optimistic PATCHes:
 *   - Immediate: disposition (status), priority, task type, project select,
 *     cycle select, hold toggle, Blocker links.
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
 * Blockers: "Blocked by" PATCHes this task's `blocked_by` with the full new
 * list. "Blocks" PATCHes the other task's `blocked_by` (its list ± this
 * code); there is no inverse endpoint. A rejected change (400: cycle, self,
 * unknown code) shows the server message under its field.
 *
 * Moving to In Progress goes through useStartWarning, which asks first when
 * the task has open Blockers.
 *
 * Body: the Task page's full markdown body renders read-only at the foot of
 * the dock (TaskBodyField), fetched with the page itself. A link in it to a
 * board task opens that task's card; any other link opens the page.
 *
 * Archive: two-step confirm — first click arms the button ("Confirm
 * archive"), second saves pending edits and archives the page. The armed
 * state auto-disarms after 3s and on pointer-leave of the footer.
 */

import { ArrowRight, Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FocusScope } from "react-aria";
import type { BoardCycle, BoardTask } from "#/api/board";
import { useArchiveTask, usePatchTask } from "#/api/board";
import { formatApiError } from "#/api/error";
import { Button } from "#/components/ui/button";
import { CopyButton } from "#/components/ui/CopyButton";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { BlockerField } from "./BlockerField";
import {
  type ColLabelFn,
  cycleStateLabel,
  PRI_LABEL,
  priColor,
} from "./board-constants";
import { ChecklistBar } from "./board-presentation";
import { type ProjectScope, scopeLabel } from "./board-projects";
import { checklistProgress } from "./board-stats";
import {
  DispositionRow,
  EdField,
  INPUT_CLS,
  PriorityRow,
  TypeRow,
} from "./fields";
import { useStartWarning } from "./StartWarning";
import { TaskBodyField } from "./TaskBodyField";
import { diffToPatch, fromTask, type TaskDraft } from "./taskDraft";
import { useDebounced, usePatchQueue } from "./usePatchQueue";

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
  | "taskType"
  | "project"
  | "cycle"
  | "holdToggle"
  | "blockedBy";

// ── TaskEditPanel ─────────────────────────────────────────────────────────────

export interface TaskEditPanelProps {
  task: BoardTask;
  /** Every board task: the Blocker pickers' options and chip lookup. */
  tasks: BoardTask[];
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
  tasks,
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
  const startWarning = useStartWarning();
  const link = task.link;

  // Local mirror of text fields that debounce before patching
  const [draft, setDraft] = useState<TaskDraft>(() => fromTask(task));
  const setField = (field: keyof TaskDraft, value: string) =>
    setDraft((d) => ({ ...d, [field]: value }));

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
    setDraft(fromTask(task));
    setArchiveArmed(false);
    setArchiving(false);
  }, [taskId]);

  // Escape closes unless the save-and-archive sequence is in flight or the
  // start warning owns the key.
  const startWarningOpen = startWarning.isOpen;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !archiving && !startWarningOpen) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [archiving, startWarningOpen, onClose]);

  // When hold toggle is activated (task.hold becomes truthy from an optimistic
  // patch), sync the reason input's state with the hold value.
  useEffect(() => {
    if (task.hold && focusReasonOnHold.current) {
      focusReasonOnHold.current = false;
      // Sync the state with the new hold value so the input is populated
      setDraft((d) => ({ ...d, hold: task.hold ?? "" }));
      // Signal that we need to focus after state updates
      setNeedsFocus(true);
    }
  }, [task.hold]);

  // After the reason draft has been updated, focus and select the input
  useEffect(() => {
    if (needsFocus && holdReasonRef.current) {
      holdReasonRef.current.focus();
      holdReasonRef.current.select();
      setNeedsFocus(false);
    }
  }, [needsFocus]);

  // Fallback focus target for the non-modal editor.
  const panelRef = useRef<HTMLDivElement>(null);

  // Every Tasking PATCH enters one serial queue, so archive has a single
  // barrier for immediate controls, debounced fields, and earlier failures.
  const patchAsync = patch.mutateAsync;
  const queue = usePatchQueue<PatchIntentLane>(task, patchAsync);

  // Debounced patches (300ms). Each hook exposes an awaited flush used by
  // archive so no local edit can be discarded or race the DELETE. An edit
  // that diffs to nothing is no longer pending: it clears its lane.
  const saveField = (
    lane: PatchIntentLane,
    field: keyof TaskDraft,
    value: string,
  ) => {
    const next = diffToPatch(task, { [field]: value });
    if (Object.keys(next).length > 0) return queue.enqueue(lane, next);
    queue.clearFailure(lane);
  };
  const flushes = [
    useDebounced(draft.title, DEBOUNCE_MS, (v) =>
      saveField("title", "title", v),
    ),
    useDebounced(draft.assignee, DEBOUNCE_MS, (v) =>
      saveField("assignee", "assignee", v),
    ),
    useDebounced(draft.estimate, DEBOUNCE_MS, (v) =>
      saveField("estimate", "estimate", v),
    ),
    useDebounced(draft.due, DEBOUNCE_MS, (v) => saveField("due", "due", v)),
    useDebounced(draft.start, DEBOUNCE_MS, (v) =>
      saveField("start", "start", v),
    ),
    useDebounced(draft.hold, DEBOUNCE_MS, (v) =>
      saveField("holdReason", "hold", v),
    ),
    useDebounced(draft.link, DEBOUNCE_MS, (v) => saveField("link", "link", v)),
    useDebounced(draft.tags, DEBOUNCE_MS, (v) => saveField("tags", "tags", v)),
  ];

  // Blocker links. A rejected change is not a pending edit: clear its lane
  // so it never holds back archive, and show the server message instead.
  const [blockedByError, setBlockedByError] = useState<string | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const saveBlockedBy = (next: string[]) => {
    setBlockedByError(null);
    queue.enqueue("blockedBy", { blocked_by: next }).catch((error) => {
      queue.clearFailure("blockedBy");
      setBlockedByError(formatApiError(error, "Couldn’t save blockers"));
    });
  };
  const saveBlocks = (otherCode: string, add: boolean) => {
    const other = tasks.find((t) => t.code === otherCode);
    if (!other) return;
    setBlocksError(null);
    const next = add
      ? [...other.blocked_by, task.code]
      : other.blocked_by.filter((code) => code !== task.code);
    patchAsync({ id: other.id, patch: { blocked_by: next } }).catch((error) =>
      setBlocksError(formatApiError(error, "Couldn’t save blocked tasks")),
    );
  };
  const openTask = (other: BoardTask) => setEditTaskId(other.id);

  // A body link to a board task opens its card; anything else opens a page.
  const openBodyLink = (path: string) => {
    const linked = tasks.find((t) => t.path === path);
    if (linked) openTask(linked);
    else onOpenPage?.(path);
  };

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

  const projectScope = projects.find((p) => p.slug === task.project);
  const projectLabel = projectScope
    ? scopeLabel(projectScope)
    : (task.project ?? "No project");

  const confirmArchive = async () => {
    if (archiving) return;
    setArchiving(true);
    clearTimeout(disarmTimer.current ?? undefined);
    disarmTimer.current = null;

    try {
      for (const flush of flushes) {
        await flush();
      }
      await queue.barrier();
      await archive.mutateAsync({ path: queue.latestPath() });
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
      {startWarning.dialog}
      <FocusScope restoreFocus autoFocus>
        <div
          ref={panelRef}
          tabIndex={-1}
          className="absolute inset-y-0 right-0 z-30 flex w-[480px] max-w-full min-h-0 shrink-0 flex-col overflow-hidden rounded-l-xl bg-raise shadow-lg outline-none @min-[1100px]:relative @min-[1100px]:w-[clamp(400px,32cqw,560px)] @min-[1100px]:shadow-none"
          data-testid="edit-panel"
          role="dialog"
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
              className="min-w-0 truncate text-[12.5px] text-ink-2 tabular-nums"
              data-testid="edit-panel-code"
              title={task.code}
            >
              {task.code}
            </span>
            <CopyButton
              getText={() => task.code}
              label="Copy task code"
              className="-ml-1 h-6 w-6 shrink-0"
            />
            <span
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[12px]"
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
              title={projectLabel}
            >
              {projectLabel}
            </span>
            <IconButton
              className="h-9 w-9 shrink-0 text-mute"
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
              className="m-0 flex h-full min-w-0 flex-col gap-4.5 overflow-y-auto px-6 pt-3 pb-6 [&>*]:shrink-0"
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
                value={draft.title}
                onChange={(e) => setField("title", e.target.value)}
                data-testid="edit-panel-title"
              />

              <EdField label="Status">
                <DispositionRow
                  value={task.status}
                  onChange={(colId) =>
                    startWarning.guard(task, colId, () =>
                      queue.patchNow("status", { status: colId }),
                    )
                  }
                  testIdPrefix="edit-panel"
                  colLabel={colLabel}
                />
              </EdField>

              <EdField label="Priority">
                <PriorityRow
                  value={task.priority}
                  onChange={(p) => queue.patchNow("priority", { priority: p })}
                  testIdPrefix="edit-panel"
                />
              </EdField>

              <EdField label="Type">
                <TypeRow
                  value={task.task_type}
                  onChange={(t) => queue.patchNow("taskType", { task_type: t })}
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
                      queue.patchNow("project", {
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
                    value={task.cycle ?? "BACKLOG"}
                    onChange={(key) => {
                      const value = key === null ? "BACKLOG" : String(key);
                      /* BACKLOG → send null to clear cycle */
                      queue.patchNow("cycle", {
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
                    value={draft.assignee}
                    onChange={(e) => setField("assignee", e.target.value)}
                    data-testid="edit-panel-assignee"
                  />
                </EdField>
                <EdField label="Estimate">
                  <input
                    type="text"
                    aria-label="Estimate"
                    className={INPUT_CLS}
                    value={draft.estimate}
                    onChange={(e) => setField("estimate", e.target.value)}
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
                    value={draft.start}
                    onChange={(e) => setField("start", e.target.value)}
                    data-testid="edit-panel-start"
                  />
                </EdField>
                <EdField label="Due date">
                  <input
                    type="date"
                    aria-label="Due date"
                    className={INPUT_CLS}
                    value={draft.due}
                    onChange={(e) => setField("due", e.target.value)}
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
                  value={draft.tags}
                  onChange={(e) => setField("tags", e.target.value)}
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
                      queue.patchNow("holdToggle", {
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
                      value={draft.hold}
                      onChange={(e) => setField("hold", e.target.value)}
                      data-testid="edit-panel-hold-reason"
                    />
                  )}
                </div>
              </EdField>

              <BlockerField
                label="Blocked by"
                noun="blocker"
                testId="edit-panel-blocked-by"
                codes={task.blocked_by}
                tasks={tasks}
                selfCode={task.code}
                onAdd={(code) => saveBlockedBy([...task.blocked_by, code])}
                onRemove={(code) =>
                  saveBlockedBy(task.blocked_by.filter((c) => c !== code))
                }
                onOpen={openTask}
                error={blockedByError}
              />

              <BlockerField
                label="Blocks"
                noun="blocked task"
                testId="edit-panel-blocks"
                codes={task.blocks}
                tasks={tasks}
                selfCode={task.code}
                onAdd={(code) => saveBlocks(code, true)}
                onRemove={(code) => saveBlocks(code, false)}
                onOpen={openTask}
                error={blocksError}
              />

              {/* Related page */}
              <EdField label="Related page" hint="Optional">
                <div className="flex gap-2">
                  <input
                    type="text"
                    aria-label="Related page"
                    className={cn(
                      INPUT_CLS,
                      "flex-1",
                      draft.link && "text-accent",
                    )}
                    placeholder="[[page]]"
                    value={draft.link}
                    onChange={(e) => setField("link", e.target.value)}
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

              <TaskBodyField path={task.path} onOpenPage={openBodyLink} />
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
