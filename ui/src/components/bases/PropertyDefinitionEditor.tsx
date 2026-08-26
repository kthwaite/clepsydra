import { Pencil, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import type { PropertyDefinition, PropertyType } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { MoveButtons, ReorderHandle, useReorderable } from "./ordered-list";
import type { DraftProperty } from "./definition-model";
import { moveItem } from "./definition-model";

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
    <fieldset className="mt-4 border-t border-border pt-4">
      <legend className="px-1 font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Options
      </legend>
      {options.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          <strong className="font-medium text-foreground">
            Open vocabulary
          </strong>
          {" — observed values remain valid and available for completion."}
        </p>
      ) : (
        <ol className="grid gap-2" aria-label={`Options for ${property.key}`}>
          {options.map((option, optionIndex) => (
            <li
              key={option}
              className="flex flex-wrap items-center gap-2 border-l-2 border-border pl-3"
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
                    className="min-w-0 flex-1 border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                  />
                  <Button
                    size="sm"
                    variant="primary"
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
                    Save option {option}
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
                  <span className="min-w-0 flex-1 break-words font-mono text-xs text-foreground">
                    {option}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={optionIndex === 0}
                    onPress={() =>
                      commitOptions(
                        moveItem(options, optionIndex, optionIndex - 1),
                      )
                    }
                  >
                    Move {option} up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={optionIndex === options.length - 1}
                    onPress={() =>
                      commitOptions(
                        moveItem(options, optionIndex, optionIndex + 1),
                      )
                    }
                  >
                    Move {option} down
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => {
                      setEditingOption(option);
                      setEditingValue(option);
                      setOptionError(undefined);
                    }}
                  >
                    Rename {option}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      commitOptions(options.filter((value) => value !== option))
                    }
                  >
                    Remove {option}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">
          New option for {property.key}
          <input
            value={newOption}
            onChange={(event) => {
              setNewOption(event.target.value);
              if (optionError)
                setOptionError(validateOption(event.target.value));
            }}
            className="mt-1 block w-full border border-input bg-background px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          />
        </label>
        <Button size="sm" variant="secondary" onPress={addOption}>
          Add option to {property.key}
        </Button>
      </div>
      {optionError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
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

  const { rowRef, setHandle, onHandleKeyDown } = useReorderable<HTMLTableRowElement>(
    {
      kind: "base-property",
      idKey: "propertyId",
      id: property.id,
      index,
      count,
      onMove,
      onReorder,
      onHandleRef,
    },
  );

  function updateDefinition(definition: PropertyDefinition) {
    onChange({ ...property, definition });
  }

  return (
    <Fragment>
      <tr
        ref={(element) => {
          rowRef.current = element;
          if (!renaming) registerFocus(`properties.${property.key}`, element);
        }}
        tabIndex={-1}
        className="border-b border-border align-top outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <td className="w-10 px-1 py-2 align-top sm:px-2">
          <ReorderHandle
            label={property.key}
            setHandle={setHandle}
            onKeyDown={onHandleKeyDown}
          />
        </td>
        <th
          scope="row"
          className="break-words px-2 py-2 text-left font-mono text-xs font-semibold text-foreground sm:px-3"
        >
          {property.key}
        </th>
        <td className="break-words px-2 py-2 text-xs leading-5 text-muted-foreground sm:px-3">
          {propertySummary(property.definition)}
        </td>
        <td className="w-28 px-1 py-2 sm:w-48 sm:px-2">
          <fieldset className="m-0 flex flex-wrap justify-end gap-1 border-0 p-0">
            <legend className="sr-only">Actions for {property.key}</legend>
            <MoveButtons
              label={property.key}
              index={index}
              count={count}
              onMove={onMove}
            />
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setEditing((current) => !current)}
            >
              {editing
                ? `Close editor ${property.key}`
                : `Edit ${property.key}`}
            </Button>
            <IconButton
              aria-label={`Rename ${property.key}`}
              variant="ghost"
              onPress={() => {
                setRenameKey("");
                onStartRename(property);
              }}
            >
              <Pencil />
            </IconButton>
            <IconButton
              aria-label={`Remove ${property.key}`}
              variant="ghost"
              onPress={() => onRemove(property)}
            >
              <Trash2 />
            </IconButton>
          </fieldset>
        </td>
      </tr>

      {(editing || renaming) && (
        <tr className="border-b border-border bg-card">
          <td colSpan={4} className="p-3 sm:p-4">
            {renaming && (
              <div className="border-l-2 border-warn pl-3">
                <label className="block text-xs font-bold uppercase tracking-widest text-muted-foreground">
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
                    className="mt-1 block w-full border border-input bg-background px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                  />
                </label>
                {renameError && (
                  <p
                    id={`${property.id}-rename-error`}
                    role="alert"
                    className="mt-2 text-xs normal-case tracking-normal text-destructive"
                  >
                    {renameError}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
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
              <div
                className={renaming ? "mt-4 border-t border-border pt-4" : ""}
              >
                <div className="grid gap-4 sm:grid-cols-2">
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
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
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
          </td>
        </tr>
      )}
    </Fragment>
  );
}
