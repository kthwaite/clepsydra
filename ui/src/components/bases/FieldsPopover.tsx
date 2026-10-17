import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
} from "react-aria-components";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Popover } from "#/components/ui/popover";
import { PICKER_PILL } from "./BasePickers";
import { columnHideLock } from "./view-overrides";

export interface FieldsPopoverProps {
  /** The view's columns, with any column-order override applied. */
  columns: string[];
  /** Hidden overrides; entries no longer in `columns` are not counted. */
  hidden: string[];
  labelFor(column: string): string;
  onHideColumn(column: string): void;
  onShowColumn(column: string): void;
  onShowAll(): void;
}

/** A checklist of the view's columns; unticking hides one as a view override. */
export function FieldsPopover({
  columns,
  hidden,
  labelFor,
  onHideColumn,
  onShowColumn,
  onShowAll,
}: FieldsPopoverProps) {
  const visibleCount = columns.filter((c) => !hidden.includes(c)).length;
  const hiddenInView = hidden.filter((c) => columns.includes(c));
  return (
    <DialogTrigger>
      <AriaButton className={PICKER_PILL(hiddenInView.length > 0)}>
        {hiddenInView.length === 0
          ? "Fields"
          : `Fields (${hiddenInView.length} hidden)`}
      </AriaButton>
      <Popover hideArrow placement="bottom start">
        <Dialog
          aria-label="Fields"
          className="flex min-w-[220px] flex-col gap-2 p-3 text-[13px] text-ink outline-none"
        >
          {columns.map((column) => {
            const visible = !hidden.includes(column);
            const lock = visible
              ? columnHideLock(column, visibleCount)
              : undefined;
            return (
              <Checkbox
                key={column}
                isSelected={visible}
                isDisabled={lock !== undefined}
                description={lock}
                onChange={(selected) =>
                  selected ? onShowColumn(column) : onHideColumn(column)
                }
              >
                {labelFor(column)}
              </Checkbox>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            isDisabled={hidden.length === 0}
            onPress={onShowAll}
          >
            Show all
          </Button>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
