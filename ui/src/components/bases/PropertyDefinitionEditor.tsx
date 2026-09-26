import { ArrowDown, ArrowUp, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { PropertyDefinition, PropertyType } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { DraftProperty } from "./definition-model";
import { moveItem } from "./definition-model";
import { MoveButtons, ReorderHandle, useReorderable } from "./ordered-list";

export const PROPERTY_TYPES: readonly PropertyType[] = [
  "text",
  "number",
  "bool",
  "date",
  "datetime",
  "select",
  "multi_select",
  "url",
  "relation",
];

const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: "Text",
  number: "Number",
  bool: "Boolean",
  date: "Date",
  datetime: "Date and time",
  select: "Select",
  multi_select: "Multi-select",
  url: "URL",
  relation: "Relation",
};

const INPUT = cn(
  "block h-10 w-full rounded-full bg-sink px-4 text-[14px] text-ink placeholder:text-mute aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
  FOCUS_RING_NATIVE,
);

function changePropertyType(
  property: DraftProperty,
  type: PropertyType,
): DraftProperty {
  return {
    ...property,
    definition: {
      type,
      ...(type === "select" || type === "multi_select" ? { options: [] } : {}),
      ...(type === "relation" ? { many: true } : {}),
    },
  };
}

interface PropertyDefinitionEditorProps {
  property: DraftProperty;
  index: number;
  count: number;
  persisted: boolean;
  renaming: boolean;
  renameError?: string;
  onChange(property: DraftProperty): void;
  onMove(from: number, to: number): void;
  onReorder(
    sourcePropertyId: string,
    targetPropertyId: string,
    edge: "top" | "bottom",
  ): void;
  onHandleRef(propertyId: string, element: HTMLButtonElement | null): void;
  onRemove(property: DraftProperty): void;
  onRename(property: DraftProperty, key: string): void;
  onStartRename(property: DraftProperty): void;
  onCancelRename(property: DraftProperty): void;
  registerFocus(path: string, element: HTMLElement | null): void;
}

function OptionEditor({
  property,
  onChange,
}: {
  property: DraftProperty;
  onChange(property: DraftProperty): void;
}) {
  const options = property.definition.options ?? [];
  const [newOption, setNewOption] = useState("");
  const [editingOption, setEditingOption] = useState<string>();
  const [editingValue, setEditingValue] = useState("");
  const [optionError, setOptionError] = useState<string>();

  function commitOptions(next: string[]) {
    onChange({
      ...property,
      definition: { ...property.definition, options: next },
    });
  }

  function validateOption(value: string, previous?: string) {
    const key = value.trim();
    if (!key) return "Option name is required.";
    if (options.some((option) => option === key && option !== previous))
      return "That option already exists.";
    return undefined;
  }

  function addOption() {
    const error = validateOption(newOption);
    setOptionError(error);
    if (error) return;
    commitOptions([...options, newOption.trim()]);
    setNewOption("");
  }

  return (
    <fieldset className="m-0 min-w-0 p-0">
      <legend className="p-0 text-[12.5px] text-mute">Options</legend>
      {options.length === 0 ? (
        <p className="mt-1.5 text-[13px] leading-normal text-mute">
          <strong className="font-medium text-ink">Open vocabulary</strong>
          {" — observed values remain valid and available for completion."}
        </p>
      ) : (
        <ol
          className="mt-1.5 flex flex-col gap-1"
          aria-label={`Options for ${property.key}`}
        >
          {options.map((option, optionIndex) => (
            <li
              key={option}
              className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 rounded-[10px] bg-ground py-0.5 pr-1.5 pl-3"
            >
              {editingOption === option ? (
                <>
                  <label
                    className="sr-only"
                    htmlFor={`${property.id}-option-${optionIndex}`}
                  >
                    Option name for {option}
                  </label>
                  <input
                    id={`${property.id}-option-${optionIndex}`}
                    value={editingValue}
                    onChange={(event) => setEditingValue(event.target.value)}
                    className={cn(INPUT, "h-8 min-w-0 flex-1 bg-raise")}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    aria-label={`Save option ${option}`}
                    onPress={() => {
                      const error = validateOption(editingValue, option);
                      setOptionError(error);
                      if (error) return;
                      commitOptions(
                        options.map((value) =>
                          value === option ? editingValue.trim() : value,
                        ),
                      );
                      setEditingOption(undefined);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setEditingOption(undefined)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 break-words text-[14px] text-ink">
                    {option}
                  </span>
                  <IconButton
                    aria-label={`Move ${option} up`}
                    isDisabled={optionIndex === 0}
                    onPress={() =>
                      commitOptions(
                        moveItem(options, optionIndex, optionIndex - 1),
                      )
                    }
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    aria-label={`Move ${option} down`}
                    isDisabled={optionIndex === options.length - 1}
                    onPress={() =>
                      commitOptions(
                        moveItem(options, optionIndex, optionIndex + 1),
                      )
                    }
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    aria-label={`Rename ${option}`}
                    onPress={() => {
                      setEditingOption(option);
                      setEditingValue(option);
                      setOptionError(undefined);
                    }}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    aria-label={`Remove ${option}`}
                    onPress={() =>
                      commitOptions(options.filter((value) => value !== option))
                    }
                  >
                    <X />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label className="flex min-w-48 flex-1">
          <span className="sr-only">New option for {property.key}</span>
          <input
            value={newOption}
            placeholder="New option"
            onChange={(event) => {
              setNewOption(event.target.value);
              if (optionError)
                setOptionError(validateOption(event.target.value));
            }}
            className={cn(INPUT, "h-9")}
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Add option to ${property.key}`}
          onPress={addOption}
        >
          Add option
        </Button>
      </div>
      {optionError && (
        <p role="alert" className="mt-2 text-[12.5px] text-hot">
          {optionError}
        </p>
      )}
    </fieldset>
  );
}

function propertySummary(definition: PropertyDefinition) {
  const label = PROPERTY_TYPE_LABELS[definition.type];
  if (definition.type === "select" || definition.type === "multi_select") {
    const optionCount = definition.options?.length ?? 0;
    return `${label} · ${
      optionCount === 0
        ? "Open vocabulary"
        : `${optionCount} ${optionCount === 1 ? "option" : "options"}`
    }`;
  }
  if (definition.type === "relation") {
    return `${label} · ${definition.many === false ? "One page" : "Many pages"}`;
  }
  return label;
}

export function PropertyDefinitionEditor({
  property,
  index,
  count,
  renaming,
  renameError,
  onChange,
  onMove,
  onReorder,
  onHandleRef,
  onRemove,
  onRename,
  onStartRename,
  onCancelRename,
  registerFocus,
}: PropertyDefinitionEditorProps) {
  const [renameKey, setRenameKey] = useState("");
  const [editing, setEditing] = useState(false);

  const { rowRef, setHandle, onHandleKeyDown } =
    useReorderable<HTMLTableRowElement>({
      kind: "base-property",
      idKey: "propertyId",
      id: property.id,
      index,
      count,
      onMove,
      onReorder,
      onHandleRef,
    });

  function updateDefinition(definition: PropertyDefinition) {
    onChange({ ...property, definition });
  }

  const open = editing || renaming;
  const cell = "bg-raise align-middle";

  return (
    <tbody>
      <tr
        ref={(element) => {
          rowRef.current = element;
          if (!renaming) registerFocus(`properties.${property.key}`, element);
        }}
        tabIndex={-1}
        className={FOCUS_RING_NATIVE}
      >
        <td
          className={cn(
            cell,
            "rounded-tl-xl py-1.5 text-center",
            !open && "rounded-bl-xl",
          )}
        >
          <ReorderHandle
            label={property.key}
            setHandle={setHandle}
            onKeyDown={onHandleKeyDown}
          />
        </td>
        <th
          scope="row"
          className={cn(
            cell,
            "break-words py-2.5 pr-2 pl-1 text-left text-[14px] font-medium text-ink",
          )}
        >
          {property.key}
        </th>
        <td className={cn(cell, "py-2.5 pr-2")}>
          <span className="inline-block max-w-full break-words rounded-full bg-sink px-2.5 py-0.5 text-[12.5px] text-ink-2">
            {propertySummary(property.definition)}
          </span>
        </td>
        <td
          className={cn(
            cell,
            "rounded-tr-xl py-1.5 pr-1.5",
            !open && "rounded-br-xl",
          )}
        >
          <fieldset className="m-0 flex flex-wrap items-center justify-end gap-0.5 p-0">
            <legend className="sr-only">Actions for {property.key}</legend>
            <MoveButtons
              label={property.key}
              index={index}
              count={count}
              onMove={onMove}
            />
            <Button
              size="sm"
              variant={editing ? "secondary" : "ghost"}
              aria-label={
                editing
                  ? `Close editor ${property.key}`
                  : `Edit ${property.key}`
              }
              aria-expanded={editing}
              className="mx-1 text-ink"
              onPress={() => setEditing((current) => !current)}
            >
              {editing ? "Close" : "Edit"}
            </Button>
            <IconButton
              aria-label={`Rename ${property.key}`}
              onPress={() => {
                setRenameKey("");
                onStartRename(property);
              }}
            >
              <Pencil />
            </IconButton>
            <IconButton
              aria-label={`Remove ${property.key}`}
              onPress={() => onRemove(property)}
            >
              <Trash2 />
            </IconButton>
          </fieldset>
        </td>
      </tr>

      {open && (
        <tr>
          {/* The table spaces rows 6px apart; the before: strip bridges
              that gap so a row and its editor read as one raise surface. */}
          <td
            colSpan={4}
            className="relative rounded-b-xl bg-raise px-4 pt-1 pb-5 before:absolute before:inset-x-0 before:-top-1.5 before:h-1.5 before:bg-raise sm:pr-[22px] sm:pl-9"
          >
            <div className="flex flex-col gap-5">
              {renaming && (
                <div className="rounded-xl bg-sink p-3">
                  <label className="flex flex-col gap-1.5 text-[12.5px] text-mute">
                    New key for {property.key}
                    <input
                      ref={(element) =>
                        registerFocus(`properties.${property.key}`, element)
                      }
                      value={renameKey}
                      aria-invalid={renameError ? true : undefined}
                      aria-describedby={
                        renameError ? `${property.id}-rename-error` : undefined
                      }
                      onChange={(event) => setRenameKey(event.target.value)}
                      className={cn(INPUT, "bg-raise")}
                    />
                  </label>
                  {renameError && (
                    <p
                      id={`${property.id}-rename-error`}
                      role="alert"
                      className="mt-2 text-[12.5px] text-hot"
                    >
                      {renameError}
                    </p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onPress={() => onRename(property, renameKey)}
                    >
                      Review rename {property.key}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => onCancelRename(property)}
                    >
                      Cancel rename
                    </Button>
                  </div>
                </div>
              )}

              {editing && (
                <div className="grid gap-5 sm:grid-cols-[minmax(0,13.75rem)_minmax(0,1fr)] sm:gap-8">
                  <div className="flex min-w-0 flex-col gap-4">
                    <Select
                      label={`Type for ${property.key}`}
                      value={property.definition.type}
                      onChange={(key) => {
                        if (key == null) return;
                        const type = String(key) as PropertyType;
                        if (!PROPERTY_TYPES.includes(type)) return;
                        onChange(changePropertyType(property, type));
                      }}
                    >
                      {PROPERTY_TYPES.map((type) => (
                        <SelectItem key={type} id={type}>
                          {PROPERTY_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </Select>

                    {property.definition.type === "relation" && (
                      <div>
                        <Select
                          id={`${property.id}-cardinality`}
                          label={`Cardinality for ${property.key}`}
                          value={
                            property.definition.many === false ? "one" : "many"
                          }
                          onChange={(key) => {
                            if (key !== "one" && key !== "many") return;
                            updateDefinition({
                              type: "relation",
                              many: key === "many",
                            });
                          }}
                        >
                          <SelectItem id="one">One page</SelectItem>
                          <SelectItem id="many">Many pages</SelectItem>
                        </Select>
                        <p className="mt-1.5 text-[12.5px] leading-normal text-mute">
                          Cardinality is advisory: existing page values are
                          diagnosed, not rewritten.
                        </p>
                      </div>
                    )}
                  </div>

                  {(property.definition.type === "select" ||
                    property.definition.type === "multi_select") && (
                    <OptionEditor property={property} onChange={onChange} />
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}
