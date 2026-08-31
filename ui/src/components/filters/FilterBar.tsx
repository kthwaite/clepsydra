import { useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
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
import { pad2 } from "#/lib/time";

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
  "cl-mono border border-[var(--rule)] bg-transparent px-[8px] py-[4px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)]";

const chromeButtonClasses =
  "cl-mono shrink-0 cursor-pointer whitespace-nowrap border border-[var(--rule)] px-[7px] py-[3px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-mute)] outline-none transition-colors hover:text-[var(--ink-2)] focus-visible:border-[var(--hot)]";

const activeChipClasses =
  "border-[var(--hot)] bg-[var(--hot)] text-[var(--paper)] hover:text-[var(--paper)]";

const optionClasses =
  "cl-mono flex cursor-pointer items-center justify-between gap-[8px] px-[6px] py-[4px] text-left text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink-2)] outline-none transition-colors hover:bg-[var(--paper-edge)] data-[focus-visible]:outline data-[focus-visible]:outline-1 data-[focus-visible]:outline-[var(--hot)] data-[selected]:bg-[var(--hot)] data-[selected]:text-[var(--paper)]";

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
  textPlaceholder = "FILTER…",
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
      ((state.facets[field.id]?.length ?? 0) > 0 ||
        activeFieldId === field.id),
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
                    "border-l-0 border-[var(--hot)] bg-[var(--hot)] px-[5px] text-[var(--paper)] hover:text-[var(--paper)]",
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
            onOptionAction={(value) => {
              onChange(toggleFacetValue(state, field, value));
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
          + FILTER
        </Button>
        <Popover hideArrow placement="bottom start">
          <Dialog
            aria-label="Add filter"
            className="w-[220px] border border-[var(--ink-3)] bg-[var(--bg)] p-[6px] outline-none"
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

interface FacetChipProps {
  field: FilterField;
  values: readonly string[];
  isPrimary: boolean;
  isOpen: boolean;
  optionFilter: string;
  optionClassName?: string;
  onOptionFilterChange: (value: string) => void;
  onOpenChange: (isOpen: boolean) => void;
  onOptionAction: (value: string) => void;
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
  onOptionAction,
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
            className="w-[220px] border border-[var(--ink-3)] bg-[var(--bg)] p-[6px] outline-none"
          >
            <div className="flex flex-col gap-[4px]">
              {field.options.length > OPTION_FILTER_THRESHOLD && (
                <input
                  data-testid="filter-bar-option-filter"
                  type="search"
                  aria-label={`Filter ${field.label} options`}
                  placeholder="FILTER OPTIONS…"
                  className={inputClasses}
                  value={optionFilter}
                  onChange={(event) =>
                    onOptionFilterChange(event.target.value)
                  }
                />
              )}
              <ListBox
                aria-label={`${field.label} options`}
                className="flex max-h-[280px] flex-col gap-[2px] overflow-auto outline-none"
                selectionMode={field.kind === "multi" ? "multiple" : "single"}
                selectedKeys={selectedKeys}
                escapeKeyBehavior="none"
                onAction={(key) => onOptionAction(String(key))}
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
            "border-l-0 border-[var(--hot)] bg-[var(--hot)] px-[5px] text-[var(--paper)] hover:text-[var(--paper)]",
          )}
          onPress={onClear}
        >
          ×
        </Button>
      )}
    </div>
  );
}
