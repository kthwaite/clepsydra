import { X } from "lucide-react";
import { type Ref, useState } from "react";
import { ComboBox, Input, ListBox, Popover } from "react-aria-components";
import { Button } from "#/components/ui/button";
import { SelectItem } from "#/components/ui/select";
import { pageName, usePeople } from "#/hooks/usePeople";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useProjectValues } from "#/lib/useProjects";

export interface FilterValueChoice {
  id: string;
  label: string;
  description?: string;
  searchText?: string;
}

interface FilterValuePickerProps {
  ariaLabel: string;
  ariaDescribedBy?: string;
  isInvalid: boolean;
  isMultiple: boolean;
  selectedValues: string[];
  inputRef: Ref<HTMLInputElement>;
  onChange(values: string[]): void;
}

/** Search is only a draft: only choosing an existing option changes the filter. */
export function FilterValuePicker({
  choices,
  ariaLabel,
  ariaDescribedBy,
  isInvalid,
  isMultiple,
  selectedValues,
  inputRef,
  onChange,
}: FilterValuePickerProps & { choices: readonly FilterValueChoice[] }) {
  const [draft, setDraft] = useState<string>();
  const selectedOptions = [...new Set(selectedValues)];
  const knownIds = new Set(choices.map((choice) => choice.id));
  const options: FilterValueChoice[] = [
    ...choices,
    ...selectedOptions
      .filter((value) => !knownIds.has(value))
      .map((value) => ({ id: value, label: `${value} (not in current list)` })),
  ];
  const selectedLabel = selectedOptions
    .map(
      (value) => options.find((option) => option.id === value)?.label ?? value,
    )
    .join(", ");
  const query = draft?.trim().toLocaleLowerCase() ?? "";
  const visible = options.filter(
    (option) =>
      (!isMultiple || !selectedValues.includes(option.id)) &&
      (!query ||
        `${option.label} ${option.id} ${option.searchText ?? ""}`
          .toLocaleLowerCase()
          .includes(query)),
  );

  return (
    <div className="grid min-w-0 gap-2">
      <ComboBox
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        isInvalid={isInvalid}
        menuTrigger="focus"
        allowsEmptyCollection
        items={visible}
        selectedKey={isMultiple ? null : (selectedValues[0] ?? null)}
        inputValue={draft ?? (isMultiple ? "" : selectedLabel)}
        onInputChange={setDraft}
        onBlur={() => setDraft(undefined)}
        onSelectionChange={(key) => {
          if (key == null) return;
          const id = String(key);
          if (!options.some((option) => option.id === id)) return;
          onChange(isMultiple ? [...selectedValues, id] : [id]);
          setDraft(undefined);
        }}
        className="flex min-w-0 flex-col gap-1"
      >
        <span aria-hidden className="text-[12.5px] text-mute">
          Value
        </span>
        <Input
          ref={inputRef}
          placeholder={isMultiple ? "Search to add a value…" : "Search values…"}
          className={cn(
            "h-10 w-full min-w-0 rounded-full bg-sink px-4 text-[14px] text-ink placeholder:text-mute aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
            FOCUS_RING_NATIVE,
          )}
        />
        <Popover className="min-w-(--trigger-width) max-w-[min(26rem,calc(100vw-2rem))] rounded-xl bg-raise p-1.5 text-ink shadow-lg">
          <ListBox<FilterValueChoice>
            className="max-h-64 overflow-auto outline-none"
            renderEmptyState={() => (
              <p className="px-3 py-2 text-[13px] text-mute">
                No matching values
              </p>
            )}
          >
            {(option) => (
              <SelectItem id={option.id} textValue={option.label}>
                <span className="grid min-w-0 gap-0.5">
                  <span>{option.label}</span>
                  {option.description ? (
                    <span className="break-all text-[12px] text-mute">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      {isMultiple && selectedValues.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selectedOptions.map((value) => (
            <Button
              key={value}
              size="sm"
              variant="secondary"
              aria-label={`Remove ${options.find((option) => option.id === value)?.label ?? value}`}
              onPress={() =>
                onChange(selectedValues.filter((item) => item !== value))
              }
            >
              {options.find((option) => option.id === value)?.label ?? value}
              <X size={12} aria-hidden />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectFilterValuePicker(props: FilterValuePickerProps) {
  const projects = useProjectValues();
  return (
    <FilterValuePicker
      {...props}
      choices={projects.map((project) => ({ id: project, label: project }))}
    />
  );
}

export function PersonFilterValuePicker(props: FilterValuePickerProps) {
  const people = usePeople();
  return (
    <FilterValuePicker
      {...props}
      choices={people.map((person) => ({
        id: person.id,
        label: pageName(person),
        description: person.path,
        searchText: [person.canonical_name, ...person.aliases].join(" "),
      }))}
    />
  );
}
