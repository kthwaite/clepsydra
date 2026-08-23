import { useMemo, useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import { FacetBadge } from "#/components/filters/FacetBadge";
import { Popover } from "#/components/ui/popover";
import { cn } from "#/lib/cn";
import {
  activeFacets,
  clearFacet,
  clearFilter,
  type FilterField,
  type FilterState,
  FLAG_ON,
  isFilterActive,
  removeFacetValue,
  setText,
  toggleFacetValue,
} from "#/lib/filters/model";
import { pad2 } from "#/lib/time";

interface FilterBarProps {
  fields: readonly FilterField[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** default true; feeds has no text search */
  showText?: boolean;
  textPlaceholder?: string;
  /** accessible name for the text input; falls back to "Filter" */
  textAriaLabel?: string;
  /** id for the text input (the board passes "tasking-filter" for the / shortcut) */
  textInputId?: string;
  filteredCount?: number;
  totalCount?: number;
  className?: string;
}

/** Above this many options, pane 2 gets its own substring filter input. */
const OPTION_FILTER_THRESHOLD = 8;

const inputClasses =
  "cl-mono border border-[var(--rule)] bg-transparent px-[8px] py-[4px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)]";

const chromeButtonClasses =
  "cl-mono shrink-0 cursor-pointer whitespace-nowrap border border-[var(--rule)] px-[7px] py-[3px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-mute)] transition-colors hover:text-[var(--ink-2)]";

export function FilterBar({
  fields,
  state,
  onChange,
  showText = true,
  textPlaceholder = "FILTER…",
  textAriaLabel = "Filter",
  textInputId,
  filteredCount,
  totalCount,
  className,
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [optionFilter, setOptionFilter] = useState("");

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setActiveFieldId(null);
      setOptionFilter("");
    }
  };

  const activeField = fields.find((f) => f.id === activeFieldId) ?? null;

  const filteredOptions = useMemo(() => {
    if (!activeField) return [];
    const q = optionFilter.trim().toLowerCase();
    if (q === "") return activeField.options;
    return activeField.options.filter(
      (o) =>
        o.value.toLowerCase().includes(q) ||
        (o.label ?? "").toLowerCase().includes(q),
    );
  }, [activeField, optionFilter]);

  const handleFieldClick = (field: FilterField) => {
    if (field.kind === "flag") {
      onChange(toggleFacetValue(state, field, ""));
      handleOpenChange(false);
      return;
    }
    setActiveFieldId(field.id);
    setOptionFilter("");
  };

  const handleOptionClick = (field: FilterField, value: string) => {
    onChange(toggleFacetValue(state, field, value));
    if (field.kind === "single") {
      handleOpenChange(false);
    }
  };

  // One badge per active field, not per applied value — FacetBadge collapses
  // a multi-value field behind a popover.
  const badges = activeFacets(state).flatMap(([fieldId, values]) => {
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return [];
    return [{ field, values }];
  });

  const active = isFilterActive(state);
  const showCount =
    active && filteredCount !== undefined && totalCount !== undefined;

  return (
    <div className={cn("flex items-center gap-[10px]", className)}>
      {showText && (
        <input
          id={textInputId}
          data-testid="filter-bar-input"
          type="text"
          aria-label={textAriaLabel}
          placeholder={textPlaceholder}
          className={inputClasses}
          value={state.text}
          onChange={(e) => onChange(setText(state, e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onChange(setText(state, ""));
              e.currentTarget.blur();
              e.stopPropagation(); // don't let Escape reach panel-close listeners
            }
          }}
        />
      )}

      <DialogTrigger isOpen={open} onOpenChange={handleOpenChange}>
        <Button data-testid="filter-bar-add" className={chromeButtonClasses}>
          + FILTER
        </Button>
        <Popover hideArrow placement="bottom start">
          <Dialog
            aria-label="Add filter"
            className="w-[220px] border border-[var(--ink-3)] bg-[var(--bg)] p-[6px] outline-none"
          >
            {activeField ? (
              <div className="flex flex-col gap-[4px]">
                <button
                  type="button"
                  className="cl-mono self-start px-[4px] py-[2px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-mute)] hover:text-[var(--ink-2)]"
                  onClick={() => setActiveFieldId(null)}
                >
                  ← FIELDS
                </button>
                {activeField.options.length > OPTION_FILTER_THRESHOLD && (
                  <input
                    data-testid="filter-bar-option-filter"
                    type="text"
                    aria-label="Filter options"
                    placeholder="FILTER OPTIONS…"
                    className={inputClasses}
                    value={optionFilter}
                    onChange={(e) => setOptionFilter(e.target.value)}
                  />
                )}
                {filteredOptions.map((option) => {
                  const selected = (
                    state.facets[activeField.id] ?? []
                  ).includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`filter-bar-option-${activeField.id}-${option.value}`}
                      aria-pressed={selected}
                      className={cn(
                        "cl-mono flex items-center justify-between gap-[8px] px-[6px] py-[4px] text-left text-[var(--fs-xs)] uppercase tracking-[0.1em] transition-colors",
                        selected
                          ? "bg-[var(--hot)] text-[var(--paper)]"
                          : "text-[var(--ink-2)] hover:bg-[var(--paper-edge)]",
                      )}
                      onClick={() =>
                        handleOptionClick(activeField, option.value)
                      }
                    >
                      <span>{option.label ?? option.value}</span>
                      {selected && <span aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-[2px]">
                {fields.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    data-testid={`filter-bar-field-${field.id}`}
                    aria-pressed={
                      field.kind === "flag"
                        ? (state.facets[field.id] ?? []).includes(FLAG_ON)
                        : undefined
                    }
                    className="cl-mono px-[6px] py-[4px] text-left text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-edge)]"
                    onClick={() => handleFieldClick(field)}
                  >
                    {field.label}
                  </button>
                ))}
              </div>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>

      {badges.map(({ field, values }) => (
        <FacetBadge
          key={field.id}
          field={field}
          values={values}
          onRemoveValue={(value) =>
            onChange(removeFacetValue(state, field.id, value))
          }
          onClearField={() => onChange(clearFacet(state, field.id))}
        />
      ))}

      {active && (
        <button
          type="button"
          data-testid="filter-bar-clear"
          className={chromeButtonClasses}
          onClick={() => onChange(clearFilter(state))}
        >
          CLEAR
        </button>
      )}

      {showCount && (
        <span
          data-testid="filter-bar-count"
          className="cl-mono ml-auto shrink-0 whitespace-nowrap text-[var(--fs-xs)] uppercase tracking-[0.15em] text-[var(--ink-mute)]"
        >
          {pad2(filteredCount as number)} OF {pad2(totalCount as number)}
        </span>
      )}
    </div>
  );
}
