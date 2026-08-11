/**
 * Chip-triggered popover for editing a task's status or priority inline,
 * without opening the full TaskEditPanel.
 */

import { useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import type { BoardTask } from "#/api/board";
import { usePatchTask } from "#/api/board";
import { Popover } from "#/components/ui/popover";
import { DispositionRow, PriorityRow } from "./fields";

export function InlineEditPopover({
  task,
  field,
  children,
  testIdPrefix,
}: {
  task: BoardTask;
  field: "status" | "priority";
  children: React.ReactNode;
  testIdPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  const patch = usePatchTask();

  const commit = (value: string) => {
    patch.mutate({ id: task.id, patch: { [field]: value } });
    setOpen(false);
  };

  return (
    // span guard: chip interaction must never bubble into the card's onClick
    <span
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button
          className="cursor-pointer outline-none focus-visible:outline-[1px] focus-visible:outline-[var(--hot)]"
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
    </span>
  );
}
