import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import { Popover } from "#/components/ui/popover";
import { cn } from "#/lib/cn";
import { FOCUS_RING, FOCUS_RING_NATIVE } from "#/lib/focusRing";

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
      ? "any"
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
          "inline-flex h-9 max-w-[16rem] cursor-pointer items-center gap-2 rounded-full pr-3 pl-3.5 text-[13.5px] transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
          value.length > 0
            ? "bg-accent-tint text-accent"
            : "bg-sink text-ink data-[hovered]:bg-sink/70",
          FOCUS_RING,
        )}
      >
        <span>{label}</span>
        <span
          className={cn(
            "min-w-0 truncate",
            value.length > 0 ? "text-accent" : "text-mute",
          )}
        >
          {summary}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0" />
      </Button>
      <Popover hideArrow placement="bottom start" offset={6}>
        <Dialog
          aria-label={`${label} options`}
          className="max-h-64 w-[15rem] overflow-y-auto rounded-2xl bg-raise p-1.5 text-ink shadow-lg outline-none"
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
                    "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors",
                    selected
                      ? "bg-accent-tint font-medium text-ink"
                      : "text-ink-2 hover:bg-sink",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {selected ? (
                    <Check
                      aria-hidden
                      className="size-4 shrink-0 text-accent"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
