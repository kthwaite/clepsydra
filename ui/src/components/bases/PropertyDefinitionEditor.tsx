import { type KeyboardEvent, useState } from "react";
import type { PropertyDefinition, PropertyType } from "#/api/bases";
import { Button } from "#/components/ui/button";
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

export function changePropertyType(
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

export interface PropertyDefinitionEditorProps {
  property: DraftProperty;
  index: number;
  count: number;
  persisted: boolean;
  renameError?: string;
  onChange(property: DraftProperty): void;
  onMove(from: number, to: number): void;
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

export function PropertyDefinitionEditor({
  property,
  index,
  count,
  persisted,
  renameError,
  onChange,
  onMove,
  onRemove,
  onRename,
  onStartRename,
  onCancelRename,
  registerFocus,
}: PropertyDefinitionEditorProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameKey, setRenameKey] = useState("");

  function handleKeyboardMove(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    if (!event.altKey) return;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      onMove(index, index - 1);
    }
    if (event.key === "ArrowDown" && index < count - 1) {
      event.preventDefault();
      onMove(index, index + 1);
    }
  }

  function updateDefinition(definition: PropertyDefinition) {
    onChange({ ...property, definition });
  }

  return (
    <li
      ref={(element) => {
        if (!renaming) registerFocus(`properties.${property.key}`, element);
      }}
      tabIndex={0}
      aria-label={`Property ${property.key}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onKeyDown={handleKeyboardMove}
      className="border border-border bg-card p-4 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words font-mono text-sm font-semibold text-foreground">
            {property.key}
          </p>
          {persisted && (
            <p className="mt-1 text-xs text-muted-foreground">
              Saved declaration key. Renaming is a remove-plus-add schema
              change.
            </p>
          )}
        </div>
        <div
          className="flex flex-wrap gap-2"
          aria-label={`Order controls for ${property.key}`}
        >
          <Button
            size="sm"
            variant="ghost"
            isDisabled={index === 0}
            onPress={() => onMove(index, index - 1)}
          >
            Move {property.key} up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={index === count - 1}
            onPress={() => onMove(index, index + 1)}
          >
            Move {property.key} down
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              onStartRename(property);
              setRenameKey("");
              setRenaming(true);
            }}
          >
            Rename {property.key}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => onRemove(property)}>
            Remove {property.key}
          </Button>
        </div>
      </div>

      {renaming && (
        <div className="mt-3 border-l-2 border-warn pl-3">
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
              onPress={() => {
                onCancelRename(property);
                setRenaming(false);
              }}
            >
              Cancel rename
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Type for {property.key}
          <select
            value={property.definition.type}
            onChange={(event) =>
              onChange(
                changePropertyType(
                  property,
                  event.target.value as PropertyType,
                ),
              )
            }
            className="mt-1 block w-full border border-input bg-background px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            {PROPERTY_TYPES.map((type) => (
              <option key={type} value={type}>
                {PROPERTY_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>

        {property.definition.type === "relation" && (
          <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            <label htmlFor={`${property.id}-cardinality`}>
              Cardinality for {property.key}
            </label>
            <select
              id={`${property.id}-cardinality`}
              value={property.definition.many === false ? "one" : "many"}
              onChange={(event) =>
                updateDefinition({
                  type: "relation",
                  many: event.target.value === "many",
                })
              }
              className="mt-1 block w-full border border-input bg-background px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              <option value="one">One page</option>
              <option value="many">Many pages</option>
            </select>
            <p className="mt-1 font-normal normal-case tracking-normal leading-5">
              Cardinality is advisory: existing page values are diagnosed, not
              rewritten.
            </p>
          </div>
        )}
      </div>

      {(property.definition.type === "select" ||
        property.definition.type === "multi_select") && (
        <OptionEditor property={property} onChange={onChange} />
      )}
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Keyboard: Alt + ↑ / ↓ reorders this declaration.
      </p>
    </li>
  );
}
