/**
 * BlockerField — one direction of a Task's Blocker links in the edit panel.
 *
 * Renders the linked Task codes as removable chips and a combobox that adds
 * a board Task. The combobox follows the PersonCombo pattern: react-aria
 * ComboBox with our own filtering, remounted after each pick to clear it.
 * The caller owns the PATCH; this component only reports add and remove.
 */

import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import type { BoardTask } from "#/api/board";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { isDone } from "./board-constants";
import { EdField } from "./fields";

export interface BlockerFieldProps {
  label: string;
  /** Singular noun for accessible names: "Add {noun}", "Remove {noun} X". */
  noun: string;
  testId: string;
  /** Linked Task codes, in display order. */
  codes: readonly string[];
  /** Board Tasks, for chip lookup and picker options. */
  tasks: readonly BoardTask[];
  /** This Task's code; never offered. */
  selfCode: string;
  onAdd: (code: string) => void;
  onRemove: (code: string) => void;
  /** Opens a linked Task (chips of dangling codes are not clickable). */
  onOpen: (task: BoardTask) => void;
  /** Server message from the last failed change, shown under the field. */
  error: string | null;
}

export function BlockerField({
  label,
  noun,
  testId,
  codes,
  tasks,
  selfCode,
  onAdd,
  onRemove,
  onOpen,
  error,
}: BlockerFieldProps) {
  const byCode = useMemo(() => new Map(tasks.map((t) => [t.code, t])), [tasks]);
  const exclude = useMemo(() => [selfCode, ...codes], [selfCode, codes]);

  return (
    <EdField label={label}>
      <div className="flex flex-col gap-2" data-testid={testId}>
        {codes.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {codes.map((code) => {
              const linked = byCode.get(code);
              return (
                <li
                  key={code}
                  className="inline-flex items-center gap-0.5 rounded-full bg-sink pr-0.5 pl-2.5 text-[12.5px] leading-6"
                >
                  {linked ? (
                    <button
                      type="button"
                      className={cn(
                        "cursor-pointer rounded-full tabular-nums text-ink-2 hover:text-accent",
                        isDone(linked.status) && "text-mute",
                        FOCUS_RING_NATIVE,
                      )}
                      title={linked.title}
                      onClick={() => onOpen(linked)}
                    >
                      {code}
                    </button>
                  ) : (
                    <span
                      className="tabular-nums text-mute line-through"
                      title="No task on the board has this code"
                    >
                      {code}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${noun} ${code}`}
                    className={cn(
                      "inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-mute hover:bg-raise hover:text-ink",
                      FOCUS_RING_NATIVE,
                    )}
                    onClick={() => onRemove(code)}
                  >
                    <X aria-hidden className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <TaskCombo
          ariaLabel={`Add ${noun}`}
          tasks={tasks}
          exclude={exclude}
          onPick={onAdd}
        />
        {error && (
          <div className="text-[12.5px] text-hot" role="alert">
            {error}
          </div>
        )}
      </div>
    </EdField>
  );
}

// ── TaskCombo ─────────────────────────────────────────────────────────────────

function matches(task: BoardTask, query: string): boolean {
  if (!query) return true;
  return (
    task.code.toLowerCase().includes(query) ||
    task.title.toLowerCase().includes(query)
  );
}

/** Picks a board Task by code or title. */
function TaskCombo({
  ariaLabel,
  tasks,
  exclude,
  onPick,
}: {
  ariaLabel: string;
  tasks: readonly BoardTask[];
  exclude: readonly string[];
  onPick: (code: string) => void;
}) {
  const [draft, setDraft] = useState("");
  // Remounting after a pick clears the selection and closes the popover.
  const [epoch, setEpoch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (epoch > 0) inputRef.current?.focus();
  }, [epoch]);

  const query = draft.trim().toLowerCase();
  const options = useMemo(() => {
    const excluded = new Set(exclude);
    return tasks.filter((t) => !excluded.has(t.code) && matches(t, query));
  }, [tasks, exclude, query]);

  return (
    <ComboBox
      key={epoch}
      aria-label={ariaLabel}
      menuTrigger="focus"
      allowsCustomValue
      inputValue={draft}
      onInputChange={setDraft}
      items={options}
      onSelectionChange={(key) => {
        if (key == null) return;
        const picked = options.find((t) => t.id === key);
        if (!picked) return;
        onPick(picked.code);
        setDraft("");
        setEpoch((value) => value + 1);
      }}
      className="min-w-0"
    >
      <Input
        ref={inputRef}
        placeholder="Add a task by code or title"
        className={cn(
          "h-9 w-full rounded-[10px] bg-sink px-3 text-[14px] text-ink outline-none transition-shadow",
          "placeholder:text-mute",
          "data-[focused]:ring-[1.5px] data-[focused]:ring-accent data-[focused]:ring-inset",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        )}
      />
      <Popover className="w-[320px] min-w-(--trigger-width) rounded-[14px] bg-raise p-1.5 shadow-lg outline-none">
        <ListBox<BoardTask> className="max-h-[280px] overflow-auto outline-none">
          {(task) => (
            <ListBoxItem
              id={task.id}
              textValue={`${task.code} ${task.title}`}
              className={cn(
                "flex min-h-9 cursor-pointer items-baseline gap-2.5 rounded-[9px] px-3 py-1.5 text-[14px] text-ink-2 outline-none",
                "data-[hovered]:bg-sink data-[hovered]:text-ink",
                "data-[focused]:bg-sink data-[focused]:text-ink",
              )}
            >
              <span className="shrink-0 text-[12.5px] tabular-nums text-mute">
                {task.code}
              </span>
              <span className="min-w-0 truncate">{task.title}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
