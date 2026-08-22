import { useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import { Popover } from "#/components/ui/popover";
import { cn } from "#/lib/cn";

export type FeedFacetOption = { value: string; label: string };

/**
 * One filter facet as its own dropdown. `multiple` toggles values in and out of
 * the selection; single mode replaces the value, and re-picking it clears the
 * facet. An empty selection always means "every value".
 */
export function FeedFacetSelect({
  label,
  options,
  value,
  onChange,
  multiple = false,
}: {
  label: string;
  options: readonly FeedFacetOption[];
  value: readonly string[];
  onChange: (values: string[]) => void;
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    value.length === 0
      ? "All"
      : value.length === 1
        ? (options.find((option) => option.value === value[0])?.label ??
          value[0])
        : `${value.length} selected`;

  const toggle = (optionValue: string) => {
    if (!multiple) {
      onChange(value.includes(optionValue) ? [] : [optionValue]);
      setOpen(false);
      return;
    }
    onChange(
      value.includes(optionValue)
        ? value.filter((current) => current !== optionValue)
        : [...value, optionValue],
    );
  };

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        aria-label={`${label} filter`}
        isDisabled={options.length === 0}
        className={cn(
          "cl-btn max-w-[13rem] gap-2 px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent",
          value.length > 0 && "cl-btn-hot",
          options.length === 0 && "opacity-50",
        )}
      >
        <span>{label}</span>
        <span className="min-w-0 truncate text-ink-mute">{summary}</span>
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover hideArrow placement="bottom start">
        <Dialog
          aria-label={`${label} options`}
          className="max-h-64 w-[15rem] overflow-y-auto border border-rule bg-paper-2 p-1.5 outline-none"
        >
          <div className="flex flex-col gap-0.5">
            {options.map((option) => {
              const selected = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggle(option.value)}
                  className={cn(
                    "cl-mono flex items-center justify-between gap-2 px-1.5 py-1 text-left text-[10px] uppercase tracking-[0.12em] transition-colors",
                    selected
                      ? "bg-accent text-black"
                      : "text-ink-2 hover:bg-paper-edge",
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {selected ? <span aria-hidden="true">✓</span> : null}
                </button>
              );
            })}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
