/**
 * One badge per active filter field, not per applied value.
 *
 * A field holding a single value renders a plain chip that removes it on
 * click. A field holding several collapses to `TAG: rust +2`, and the applied
 * values move into a popover — keeping the filter strip to one badge per field
 * however many values are on, so it neither eats the row nor grows it taller.
 */

import { useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import { Popover } from "#/components/ui/popover";
import type { FilterField } from "#/lib/filters/model";

const badgeClasses =
  "cl-mono shrink-0 cursor-pointer whitespace-nowrap border border-[var(--hot)] bg-[var(--hot)] px-[7px] py-[3px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--paper)] transition-colors";

export interface FacetBadgeProps {
  field: FilterField;
  /** The field's applied values, in the order they were added. */
  values: readonly string[];
  onRemoveValue: (value: string) => void;
  onClearField: () => void;
}

/** The option's display label, falling back to the raw facet value. */
function optionLabel(field: FilterField, value: string): string {
  return field.options.find((o) => o.value === value)?.label ?? value;
}

/**
 * `ON HOLD` for flag fields, whose sole value is an internal sentinel;
 * `TAG: rust` for everything else.
 */
function valueLabel(field: FilterField, value: string): string {
  if (field.kind === "flag") return field.label;
  return `${field.label}: ${optionLabel(field, value)}`;
}

export function FacetBadge({
  field,
  values,
  onRemoveValue,
  onClearField,
}: FacetBadgeProps) {
  const first = values[0];
  if (first === undefined) return null;
  // Rendering distinct components rather than branching inside one keeps the
  // collapsed badge's open state from surviving a collapse back to one value.
  if (values.length === 1) {
    return <SingleChip field={field} value={first} onRemove={onRemoveValue} />;
  }
  return (
    <CollapsedBadge
      field={field}
      values={values}
      onRemoveValue={onRemoveValue}
      onClearField={onClearField}
    />
  );
}

function SingleChip({
  field,
  value,
  onRemove,
}: {
  field: FilterField;
  value: string;
  onRemove: (value: string) => void;
}) {
  const label = valueLabel(field, value);
  return (
    <button
      type="button"
      data-testid={`filter-bar-chip-${field.id}-${value}`}
      aria-label={`Remove filter ${label}`}
      className={badgeClasses}
      onClick={() => onRemove(value)}
    >
      {label}
    </button>
  );
}

function CollapsedBadge({
  field,
  values,
  onRemoveValue,
  onClearField,
}: FacetBadgeProps) {
  const [open, setOpen] = useState(false);

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        data-testid={`filter-bar-chip-${field.id}`}
        aria-label={`${field.label}: ${values.length} filters applied`}
        className={badgeClasses}
      >
        {`${field.label}: ${optionLabel(field, values[0] ?? "")} +${
          values.length - 1
        }`}
      </Button>
      <Popover hideArrow placement="bottom start">
        <Dialog
          aria-label={`${field.label} filters`}
          className="w-[200px] border border-[var(--ink-3)] bg-[var(--bg)] p-[6px] outline-none"
        >
          <div className="flex flex-col gap-[2px]">
            {values.map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`filter-bar-facet-${field.id}-${value}`}
                aria-label={`Remove filter ${valueLabel(field, value)}`}
                className="cl-mono flex cursor-pointer items-center justify-between gap-[8px] px-[6px] py-[4px] text-left text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-edge)]"
                onClick={() => onRemoveValue(value)}
              >
                <span>{optionLabel(field, value)}</span>
                <span aria-hidden="true" className="text-[var(--ink-mute)]">
                  ×
                </span>
              </button>
            ))}
            <button
              type="button"
              data-testid={`filter-bar-facet-clear-${field.id}`}
              aria-label={`Clear all ${field.label} filters`}
              className="cl-mono mt-[4px] cursor-pointer border-t border-[var(--rule)] px-[6px] pb-[2px] pt-[6px] text-left text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-mute)] transition-colors hover:text-[var(--ink-2)]"
              onClick={onClearField}
            >
              CLEAR {field.label}
            </button>
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
