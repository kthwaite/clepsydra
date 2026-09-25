import { useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import type { Selection } from "react-aria-components/ListBox";
import { Popover } from "#/components/ui/popover";
import { cn } from "#/lib/cn";
import {
  clearFacet,
  clearFilter,
  type FilterField,
  type FilterState,
  FLAG_ON,
  isFilterActive,
  setText,
  toggleFacetValue,
} from "#/lib/filters/model";

interface FilterBarProps {
  fields: readonly FilterField[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** Fields shown as permanent chips; defaults to the first three fields. */
  primaryFieldIds?: readonly string[];
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
  /** Extra option styling for context-specific targets such as mobile sheets. */
  optionClassName?: string;
}

/** Above this many options, an option pane gets its own substring filter. */
const OPTION_FILTER_THRESHOLD = 8;

const inputClasses =
  "h-9 min-w-[180px] rounded-full bg-sink px-4 text-[13.5px] text-ink outline-none placeholder:text-mute focus-visible:ring-2 focus-visible:ring-accent";

const chromeButtonClasses =
  "h-8 shrink-0 cursor-pointer whitespace-nowrap rounded-full bg-sink px-3 text-[13px] text-ink-2 outline-none transition-colors hover:text-ink data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent focus-visible:ring-2 focus-visible:ring-accent";

const activeChipClasses = "bg-accent-tint text-ink hover:text-ink";

const optionClasses =
  "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] text-ink outline-none transition-colors hover:bg-sink data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent data-[selected]:bg-accent-tint";

function chipLabel(field: FilterField, values: readonly string[]): string {
  if (field.kind === "flag" || values.length === 0) return field.label;
  if (values.length === 1) {
    const value = values[0] ?? "";
    const label =
      field.options.find((option) => option.value === value)?.label ?? value;
    return `${field.label}: ${label}`;
  }
  return `${field.label} · ${values.length}`;
}

export function FilterBar({
  fields,
  state,
  onChange,
  primaryFieldIds,
  showText = true,
  textPlaceholder = "Filter…",
  textAriaLabel = "Filter",
  textInputId,
  filteredCount,
  totalCount,
  className,
  optionClassName,
}: FilterBarProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [optionFilter, setOptionFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const configuredPrimaryIds =
    primaryFieldIds ?? fields.slice(0, 3).map((field) => field.id);
  const primaryIds = new Set(configuredPrimaryIds);
  const primaryFields = configuredPrimaryIds.flatMap((fieldId) => {
    const field = fields.find((candidate) => candidate.id === fieldId);
    return field ? [field] : [];
  });

  const visibleLongTailFields = fields.filter(
    (field) =>
      !primaryIds.has(field.id) &&
      ((state.facets[field.id]?.length ?? 0) > 0 || activeFieldId === field.id),
  );
  const visibleFields = [...primaryFields, ...visibleLongTailFields];
  const visibleFieldIds = new Set(visibleFields.map((field) => field.id));
  const availableLongTailFields = fields.filter(
    (field) => !primaryIds.has(field.id) && !visibleFieldIds.has(field.id),
  );

  const active = isFilterActive(state);
  const showCount =
    active && filteredCount !== undefined && totalCount !== undefined;

  const closeOptionPane = () => {
    setActiveFieldId(null);
    setOptionFilter("");
  };

  const openOptionPane = (fieldId: string) => {
    setAddOpen(false);
    setActiveFieldId(fieldId);
    setOptionFilter("");
  };

  const handleLongTailAction = (fieldId: string | number) => {
    const field = fields.find((candidate) => candidate.id === String(fieldId));
    if (!field) return;
    if (field.kind === "flag") {
      onChange(toggleFacetValue(state, field, ""));
      setAddOpen(false);
      return;
    }
    openOptionPane(field.id);
  };

  const focusPrimaryChip = (fieldId: string) => {
    const primaryChips =
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-filter-primary-chip]",
      ) ?? [];
    for (const chip of primaryChips) {
      if (chip.dataset.filterPrimaryChip === fieldId) {
        chip.focus();
        return;
      }
    }
  };

  const handleClearAll = () => {
    if (showText) {
      textInputRef.current?.focus();
    } else {
      rootRef.current
        ?.querySelector<HTMLButtonElement>("[data-filter-primary-chip]")
        ?.focus();
    }
    onChange(clearFilter(state));
    setAddOpen(false);
    closeOptionPane();
  };

  return (
    <div
      ref={rootRef}
      className={cn("flex flex-wrap items-center gap-[10px]", className)}
    >
      {showText && (
        <input
          ref={textInputRef}
          id={textInputId}
          data-testid="filter-bar-input"
          type="text"
          aria-label={textAriaLabel}
          placeholder={textPlaceholder}
          className={inputClasses}
          value={state.text}
          onChange={(event) => onChange(setText(state, event.target.value))}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onChange(setText(state, ""));
              event.currentTarget.blur();
              event.stopPropagation();
            }
          }}
        />
      )}

      {visibleFields.map((field) => {
        const values = state.facets[field.id] ?? [];
        const isOpen = activeFieldId === field.id;
        const clearField = () => {
          if (primaryIds.has(field.id)) focusPrimaryChip(field.id);
          else addButtonRef.current?.focus();
          onChange(clearFacet(state, field.id));
          if (isOpen) closeOptionPane();
        };

        if (field.kind === "flag") {
          const selected = values.includes(FLAG_ON);
          return (
            <div key={field.id} className="flex shrink-0 items-stretch">
              <Button
                data-testid={`filter-bar-chip-${field.id}`}
                data-filter-primary-chip={
                  primaryIds.has(field.id) ? field.id : undefined
                }
                aria-pressed={selected}
                className={cn(
                  chromeButtonClasses,
                  selected && activeChipClasses,
                )}
                onPress={() => onChange(toggleFacetValue(state, field, ""))}
              >
                {field.label}
              </Button>
              {selected && (
                <Button
                  aria-label={`Clear ${field.label} filter`}
                  className={cn(
                    chromeButtonClasses,
                    "-ml-1 bg-accent-tint px-2 text-ink hover:text-ink",
                  )}
                  onPress={clearField}
                >
                  ×
                </Button>
              )}
            </div>
          );
        }

        return (
          <FacetChip
            key={field.id}
            field={field}
            values={values}
            isPrimary={primaryIds.has(field.id)}
            isOpen={isOpen}
            optionFilter={optionFilter}
            onOptionFilterChange={setOptionFilter}
            optionClassName={optionClassName}
            onOpenChange={(isFieldOpen) => {
              if (isFieldOpen) openOptionPane(field.id);
              else if (isOpen) closeOptionPane();
            }}
            onSelectionChange={(keys, renderedOptions) => {
              const currentValues = new Set(values);
              let nextState = state;
              let changed = false;

              for (const { value } of renderedOptions) {
                const selectedNext = keys === "all" || keys.has(value);
                if (currentValues.has(value) && !selectedNext) {
                  nextState = toggleFacetValue(nextState, field, value);
                  changed = true;
                }
              }
              for (const { value } of renderedOptions) {
                const selectedNext = keys === "all" || keys.has(value);
                if (!currentValues.has(value) && selectedNext) {
                  nextState = toggleFacetValue(nextState, field, value);
                  changed = true;
                }
              }

              if (changed) onChange(nextState);
              if (field.kind === "single") closeOptionPane();
            }}
            onClear={clearField}
          />
        );
      })}

      <DialogTrigger isOpen={addOpen} onOpenChange={setAddOpen}>
        <Button
          ref={addButtonRef}
          data-testid="filter-bar-add"
          className={chromeButtonClasses}
        >
          + Filter
        </Button>
        <Popover hideArrow placement="bottom start">
          <Dialog
            aria-label="Add filter"
            className="w-[240px] rounded-xl bg-raise p-1.5 shadow-lg outline-none"
          >
            <ListBox
              aria-label="Available filters"
              className="flex flex-col gap-[2px] outline-none"
              onAction={handleLongTailAction}
            >
              {availableLongTailFields.map((field) => (
                <ListBoxItem
                  key={field.id}
                  id={field.id}
                  textValue={field.label}
                  data-testid={`filter-bar-field-${field.id}`}
                  className={cn(optionClasses, optionClassName)}
                >
                  {field.label}
                </ListBoxItem>
              ))}
            </ListBox>
          </Dialog>
        </Popover>
      </DialogTrigger>

      {active && (
        <button
          type="button"
          data-testid="filter-bar-clear"
          className={chromeButtonClasses}
          onClick={handleClearAll}
        >
          Clear
        </button>
      )}

      {showCount && (
        <span
          data-testid="filter-bar-count"
          className="ml-auto shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-mute"
        >
          {filteredCount as number} of {totalCount as number}
        </span>
      )}
    </div>
  );
}

interface FacetChipProps {
  field: FilterField;
  values: readonly string[];
  isPrimary: boolean;
  isOpen: boolean;
  optionFilter: string;
  optionClassName?: string;
  onOptionFilterChange: (value: string) => void;
  onOpenChange: (isOpen: boolean) => void;
  onSelectionChange: (
    keys: Selection,
    renderedOptions: FilterField["options"],
  ) => void;
  onClear: () => void;
}

function FacetChip({
  field,
  values,
  isPrimary,
  isOpen,
  optionFilter,
  optionClassName,
  onOptionFilterChange,
  onOpenChange,
  onSelectionChange,
  onClear,
}: FacetChipProps) {
  const filteredOptions = useMemo(() => {
    const query = optionFilter.trim().toLowerCase();
    if (query === "") return field.options;
    return field.options.filter(
      (option) =>
        option.value.toLowerCase().includes(query) ||
        (option.label ?? "").toLowerCase().includes(query),
    );
  }, [field, optionFilter]);
  const selectedKeys = new Set(values);
  const selected = values.length > 0;

  return (
    <div className="flex shrink-0 items-stretch">
      <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        <Button
          data-testid={`filter-bar-chip-${field.id}`}
          data-filter-primary-chip={isPrimary ? field.id : undefined}
          className={cn(chromeButtonClasses, selected && activeChipClasses)}
        >
          {chipLabel(field, values)}
        </Button>
        <Popover hideArrow placement="bottom start">
          <Dialog
            aria-label={`${field.label} options`}
            className="w-[240px] rounded-xl bg-raise p-1.5 shadow-lg outline-none"
          >
            <div className="flex flex-col gap-[4px]">
              {field.options.length > OPTION_FILTER_THRESHOLD && (
                <input
                  data-testid="filter-bar-option-filter"
                  type="search"
                  aria-label={`Filter ${field.label} options`}
                  placeholder="Filter options…"
                  className={inputClasses}
                  value={optionFilter}
                  onChange={(event) => onOptionFilterChange(event.target.value)}
                />
              )}
              <ListBox
                aria-label={`${field.label} options`}
                className="flex max-h-[280px] flex-col gap-[2px] overflow-auto outline-none"
                selectionMode={field.kind === "multi" ? "multiple" : "single"}
                selectedKeys={selectedKeys}
                escapeKeyBehavior="none"
                onSelectionChange={(keys) =>
                  onSelectionChange(keys, filteredOptions)
                }
              >
                {filteredOptions.map((option) => (
                  <ListBoxItem
                    key={option.value}
                    id={option.value}
                    textValue={option.label ?? option.value}
                    data-testid={`filter-bar-option-${field.id}-${option.value}`}
                    className={cn(optionClasses, optionClassName)}
                  >
                    {({ isSelected }) => (
                      <>
                        <span>{option.label ?? option.value}</span>
                        {isSelected && <span aria-hidden="true">✓</span>}
                      </>
                    )}
                  </ListBoxItem>
                ))}
              </ListBox>
            </div>
          </Dialog>
        </Popover>
      </DialogTrigger>
      {selected && (
        <Button
          aria-label={`Clear ${field.label} filter`}
          className={cn(
            chromeButtonClasses,
            "-ml-1 bg-accent-tint px-2 text-ink hover:text-ink",
          )}
          onPress={onClear}
        >
          ×
        </Button>
      )}
    </div>
  );
}
