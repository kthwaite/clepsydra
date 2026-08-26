import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Editor,
  type Element,
  Node,
  type NodeEntry,
  type Path,
  type PathRef,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { ReactEditor } from "slate-react";
import { TASK_PROPERTY_KEYS, type TaskPropertyKey } from "#/editor/properties";
import type { ListItemElement } from "#/editor/schema/types";
import type { TaskPropertyPopoverController } from "#/editor/taskPropertyContext";
import { cn } from "#/lib/cn";

// ---------------------------------------------------------------------------
// Draft — the buffered edit, seeded at open and written on commit
// ---------------------------------------------------------------------------

export type TaskPropertyDraft = Record<TaskPropertyKey, string>;

function draftFromProperties(
  properties: Record<string, string> | undefined,
): TaskPropertyDraft {
  return {
    due: properties?.due ?? "",
    scheduled: properties?.scheduled ?? "",
    priority: properties?.priority ?? "",
  };
}

function isTaskPropertyKey(key: string): key is TaskPropertyKey {
  return (TASK_PROPERTY_KEYS as readonly string[]).includes(key);
}

/**
 * Fold the draft into the item's record: task keys come from the draft (a
 * cleared field drops its key), every other key is carried through untouched —
 * the popover edits three keys, it does not own the record.
 */
function mergeTaskProperties(
  existing: Record<string, string> | undefined,
  draft: TaskPropertyDraft,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (!isTaskPropertyKey(key)) {
      next[key] = value;
      continue;
    }
    const drafted = draft[key].trim();
    if (drafted) next[key] = drafted;
  }
  for (const key of TASK_PROPERTY_KEYS) {
    const drafted = draft[key].trim();
    if (drafted && !(key in next)) next[key] = drafted;
  }
  return next;
}

function sameProperties(
  existing: Record<string, string> | undefined,
  next: Record<string, string>,
): boolean {
  const keys = Object.keys(next);
  if (Object.keys(existing ?? {}).length !== keys.length) return false;
  return keys.every((key) => existing?.[key] === next[key]);
}

// ---------------------------------------------------------------------------
// Controller — owns the open item (as a PathRef) and the commit write
// ---------------------------------------------------------------------------

export interface TaskPropertySession {
  /** Bumped per open so re-opening remounts the popover with a fresh draft. */
  id: number;
  anchor: HTMLElement;
  initial: TaskPropertyDraft;
}

export interface TaskPropertyPopoverState {
  /** The context value chips and the hover control call into. */
  opener: TaskPropertyPopoverController;
  session: TaskPropertySession | null;
  commit(draft: TaskPropertyDraft): void;
  discard(): void;
}

/** The task list item enclosing the caret, if the caret is inside one. */
export function taskItemAtSelection(
  editor: Editor,
): NodeEntry<ListItemElement> | null {
  const { selection } = editor;
  if (!selection) return null;
  const entry = Editor.above<ListItemElement>(editor, {
    at: selection,
    match: (node) =>
      SlateElement.isElement(node) &&
      node.type === "list-item" &&
      typeof node.checked === "boolean",
    mode: "lowest",
  });
  return entry ?? null;
}

export function useTaskPropertyPopoverController(
  editor: Editor,
): TaskPropertyPopoverState {
  const pathRef = useRef<PathRef | null>(null);
  const sessionIdRef = useRef(0);
  const [session, setSession] = useState<TaskPropertySession | null>(null);

  const close = useCallback(() => {
    pathRef.current?.unref();
    pathRef.current = null;
    setSession(null);
    // The popover never moved the caret, so plain focus puts the operator back
    // exactly where they left off.
    ReactEditor.focus(editor);
  }, [editor]);

  const openForPath = useCallback(
    (path: Path, anchor: HTMLElement) => {
      if (!Editor.hasPath(editor, path)) return;
      const node = Node.get(editor, path);
      if (!SlateElement.isElement(node) || node.type !== "list-item") return;
      pathRef.current?.unref();
      pathRef.current = Editor.pathRef(editor, path);
      sessionIdRef.current += 1;
      setSession({
        id: sessionIdRef.current,
        anchor,
        initial: draftFromProperties(node.properties),
      });
    },
    [editor],
  );

  const commit = useCallback(
    (draft: TaskPropertyDraft) => {
      // A live path is the only thing that authorizes the write: if the item
      // was deleted while the popover was open, the draft is dropped.
      const path = pathRef.current?.current;
      if (path && Editor.hasPath(editor, path)) {
        const node = Node.get(editor, path);
        if (SlateElement.isElement(node) && node.type === "list-item") {
          const next = mergeTaskProperties(node.properties, draft);
          // An unchanged record must not reach the editor — a no-op commit
          // would otherwise schedule a save and dirty the folio.
          if (!sameProperties(node.properties, next)) {
            HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
              if (Object.keys(next).length === 0) {
                Transforms.unsetNodes(editor, "properties", { at: path });
              } else {
                Transforms.setNodes(
                  editor,
                  { properties: next } as Partial<Element>,
                  { at: path },
                );
              }
            });
          }
        }
      }
      close();
    },
    [close, editor],
  );

  useEffect(
    () => () => {
      pathRef.current?.unref();
      pathRef.current = null;
    },
    [],
  );

  // The opener is the context value every chip subscribes to: keep it stable so
  // an unrelated editor render does not re-render every task item.
  const opener = useMemo(() => ({ openForPath }), [openForPath]);

  return useMemo(
    () => ({ opener, session, commit, discard: close }),
    [close, commit, opener, session],
  );
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

const PRIORITY_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "A", label: "HIGH" },
  { value: "B", label: "MED" },
  { value: "C", label: "LOW" },
];

const LABEL_CLASS =
  "cl-mono block text-[9px] uppercase tracking-widest text-ink-mute";

const INPUT_CLASS =
  "cl-mono min-w-0 flex-1 border border-rule bg-paper px-1 py-0.5 text-[11px] text-ink outline-none focus:border-accent";

const SMALL_BUTTON_CLASS =
  "cl-mono border px-1 py-0.5 text-[10px] leading-none tracking-wider";

export interface TaskPropertyPopoverProps {
  anchor: HTMLElement;
  initial: TaskPropertyDraft;
  onCommit(draft: TaskPropertyDraft): void;
  onDiscard(): void;
}

export function TaskPropertyPopover({
  anchor,
  initial,
  onCommit,
  onDiscard,
}: TaskPropertyPopoverProps) {
  const [draft, setDraft] = useState(initial);
  // Dismissal can arrive from a listener that captured an older render; the
  // ref keeps every exit path writing the draft the operator actually sees.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const finishedRef = useRef(false);
  // Named explicitly rather than by tabbable index: the date inputs report no
  // layout boxes in jsdom, which the index form treats as untabbable.
  const dueFieldRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const dueId = useId();
  const scheduledId = useId();

  const finish = (mode: "commit" | "discard") => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (mode === "commit") onCommit(draftRef.current);
    else onDiscard();
  };

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) finish("commit");
    },
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  // Position only: leaving the anchor out of the dismiss graph means a click
  // back onto the chip (or into the task's own text) commits and closes.
  useEffect(() => {
    refs.setPositionReference(anchor);
  }, [anchor, refs]);

  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const setField = (key: TaskPropertyKey, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish("discard");
      return;
    }
    if (event.key !== "Enter") return;
    // Enter on a button is that button's activation (toggle / clear); the
    // operator presses Enter again from anywhere else to commit.
    if (event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    finish("commit");
  };

  return (
    <FloatingPortal>
      <FloatingFocusManager
        context={context}
        modal={false}
        initialFocus={dueFieldRef}
        returnFocus={false}
      >
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          contentEditable={false}
          className="z-50 w-56 border border-ink bg-paper-2 p-3 shadow-[4px_4px_0_0_var(--color-ink)]"
          {...getFloatingProps({
            "aria-labelledby": titleId,
            onKeyDown: handleKeyDown,
          })}
        >
          <p id={titleId} className="cl-cap text-[9px] text-ink-mute">
            Todo properties
          </p>

          <label className={cn(LABEL_CLASS, "mt-3")} htmlFor={dueId}>
            Due
          </label>
          <div className="mt-1 flex items-center gap-1">
            <input
              ref={dueFieldRef}
              id={dueId}
              type="date"
              value={draft.due}
              onChange={(event) => setField("due", event.target.value)}
              className={INPUT_CLASS}
            />
            <button
              type="button"
              aria-label="Clear due"
              onClick={() => setField("due", "")}
              className={cn(
                SMALL_BUTTON_CLASS,
                "border-rule text-ink-mute hover:border-ink-mute hover:text-ink",
              )}
            >
              ×
            </button>
          </div>

          <label className={cn(LABEL_CLASS, "mt-3")} htmlFor={scheduledId}>
            Scheduled
          </label>
          <div className="mt-1 flex items-center gap-1">
            <input
              id={scheduledId}
              type="date"
              value={draft.scheduled}
              onChange={(event) => setField("scheduled", event.target.value)}
              className={INPUT_CLASS}
            />
            <button
              type="button"
              aria-label="Clear scheduled"
              onClick={() => setField("scheduled", "")}
              className={cn(
                SMALL_BUTTON_CLASS,
                "border-rule text-ink-mute hover:border-ink-mute hover:text-ink",
              )}
            >
              ×
            </button>
          </div>

          <fieldset className="mt-3 border-0 p-0">
            <legend className={LABEL_CLASS}>Priority</legend>
            <div className="mt-1 flex gap-1">
              {PRIORITY_CHOICES.map((choice) => {
                const active = draft.priority === choice.value;
                return (
                  <button
                    key={choice.value}
                    type="button"
                    aria-pressed={active}
                    // A second press on the active level clears the key.
                    onClick={() =>
                      setField("priority", active ? "" : choice.value)
                    }
                    className={cn(
                      SMALL_BUTTON_CLASS,
                      "flex-1",
                      active
                        ? "border-accent text-accent"
                        : "border-rule text-ink-mute hover:border-ink-mute hover:text-ink",
                    )}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
