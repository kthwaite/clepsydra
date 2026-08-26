/**
 * Chip-triggered popover for editing a task's status or priority inline,
 * without opening the full TaskEditPanel.
 */

import { useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import type { BoardTask } from "#/api/board";
import { usePatchTask } from "#/api/board";
import { Popover } from "#/components/ui/popover";
import type { ColLabelFn } from "./board-constants";
import { DispositionRow, PriorityRow } from "./fields";

export function InlineEditPopover({
  task,
  field,
  children,
  testIdPrefix,
  colLabel,
}: {
  task: BoardTask;
  field: "status" | "priority";
  children: React.ReactNode;
  testIdPrefix: string;
  /** Only consulted when field === "status"; forwarded to DispositionRow. */
  colLabel: ColLabelFn;
}) {
  const [open, setOpen] = useState(false);
  const patch = usePatchTask();

  const commit = (value: string) => {
    patch.mutate({ id: task.id, patch: { [field]: value } });
    setOpen(false);
  };

  return (
    // No manual stopPropagation guard here: RAC's Button (via usePress)
    // already stops propagation of the pointer/keyboard events it handles
    // (click, Enter/Space) by default, which is sufficient to keep chip
    // interaction from opening the card underneath. A blanket
    // onKeyDown={stopPropagation} wrapper would additionally swallow every
    // OTHER keydown while focus rests on the chip — including global
    // shortcut chords the RAC press handling never touches — before they
    // reach the window-level useGlobalShortcuts dispatcher.
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        className="pointer-events-auto relative z-10 cursor-pointer outline-none focus-visible:outline-[1px] focus-visible:outline-[var(--hot)]"
        data-testid={`${testIdPrefix}-inline-${field}-${task.id}`}
        aria-label={`Change ${field}`}
      >
        {children}
      </Button>
      <Popover hideArrow placement="bottom start">
        <Dialog
          aria-label={`Set ${field}`}
          className="w-[320px] border border-[var(--ink-3)] bg-[var(--bg)] p-[8px] outline-none"
        >
          {field === "status" ? (
            <DispositionRow
              value={task.status}
              onChange={commit}
              testIdPrefix="inline"
              colLabel={colLabel}
            />
          ) : (
            <PriorityRow
              value={task.priority}
              onChange={commit}
              testIdPrefix="inline"
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
