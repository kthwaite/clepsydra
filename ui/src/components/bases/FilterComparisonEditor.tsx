import { useEffect, useId, useState } from "react";
import type { BaseFilter, FilterOp, PropertyType } from "#/api/bases";
import type { RegisterFocusTarget } from "./BaseDefinitionWorkspace";
import {
  type DraftProperty,
  type FilterPath,
  operatorsFor,
} from "./definition-model";

interface FieldCapability {
  key: string;
  label: string;
  type: PropertyType | "system-multi" | "system-scalar";
  options?: string[];
}

const SYSTEM_FIELDS: readonly FieldCapability[] = [
  { key: "kind", label: "Kind", type: "system-scalar" },
  { key: "id", label: "ID", type: "system-scalar" },
  { key: "title", label: "Title", type: "system-scalar" },
  { key: "path", label: "Path", type: "system-scalar" },
  { key: "project", label: "Project", type: "system-scalar" },
  { key: "tags", label: "Tags", type: "system-multi" },
  { key: "aliases", label: "Aliases", type: "system-multi" },
  { key: "created_at", label: "Created at", type: "datetime" },
  { key: "updated_at", label: "Updated at", type: "datetime" },
  { key: "journal_date", label: "Journal date", type: "date" },
  { key: "word_count", label: "Word count", type: "number" },
];

const VALUELESS_OPERATORS: Partial<Record<FilterOp, true>> = {
  is_empty: true,
  not_empty: true,
};

function diagnosticPath(path: FilterPath, control: "field" | "op" | "value") {
  let result = "filter";
  for (const segment of path) {
    result += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return `${result}.${control}`;
}

function comparison(field: string, op: FilterOp, value: unknown): BaseFilter {
  return VALUELESS_OPERATORS[op] ? { field, op } : { field, op, value };
}

function defaultValue(capability: FieldCapability, op: FilterOp): unknown {
  if (VALUELESS_OPERATORS[op]) return undefined;
  if (op === "in") return [];
  if (capability.type === "bool") return true;
  return capability.options?.[0] ?? "";
}

export interface FilterComparisonEditorProps {
  value: BaseFilter;
  path: FilterPath;
  position: number;
  properties: DraftProperty[];
  onChange(value: BaseFilter): void;
  registerFocus: RegisterFocusTarget;
}

export function FilterComparisonEditor({
  value,
  path,
  position,
  properties,
  onChange,
  registerFocus,
}: FilterComparisonEditorProps) {
  const [relationSuggestions, setRelationSuggestions] = useState<string[]>([]);
  const [freeformDraft, setFreeformDraft] = useState<string>();
  const relationListId = useId();

  const declaredFields: FieldCapability[] = properties
    .filter(
      (property) =>
        !SYSTEM_FIELDS.some((system) => system.key === property.key),
    )
    .map((property) => ({
      key: property.key,
      label: property.key,
      type: property.definition.type,
      options: property.definition.options,
    }));
  const fields = [...SYSTEM_FIELDS, ...declaredFields];
  const filterValue =
    "field" in value
      ? value
      : ({ field: "kind", op: "eq", value: "" } satisfies BaseFilter);
  const knownCapability = fields.find(
    (field) => field.key === filterValue.field,
  );
  const capability =
    knownCapability ??
    ({
      key: filterValue.field,
      label: filterValue.field,
      type: "system-scalar",
    } satisfies FieldCapability);
  const operators = operatorsFor(capability.type);
  const operatorOptions = operators.includes(filterValue.op)
    ? operators
    : [...operators, filterValue.op];
  const activeOperator = filterValue.op;
  const hasValue = !VALUELESS_OPERATORS[activeOperator];
  const valueText = Array.isArray(filterValue.value)
    ? filterValue.value.join(", ")
    : filterValue.value == null
      ? ""
      : String(filterValue.value);
  const displayValueText = freeformDraft ?? valueText;
  const declaredOptions = capability.options ?? [];
  const selectedOptionValues = Array.isArray(filterValue.value)
    ? filterValue.value.map(String)
    : valueText === ""
      ? []
      : [valueText];
  const missingOptions = selectedOptionValues.filter(
    (option) => !declaredOptions.includes(option),
  );

  useEffect(() => {
    let cancelled = false;
    if (capability.type !== "relation" || displayValueText.trim() === "") {
      setRelationSuggestions([]);
      return;
    }
    void fetch(
      `/api/vault/index/search?q=${encodeURIComponent(displayValueText.trim())}&limit=8`,
    )
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: Array<{ title?: string | null; path: string }>) => {
        if (cancelled) return;
        setRelationSuggestions(
          rows.map(
            (row) =>
              row.title ?? row.path.replace(/\.md$/, "").split("/").pop() ?? "",
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [capability.type, displayValueText]);

  if (!("field" in value)) return null;

  const labelClass =
    "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";
  const controlClass =
    "mt-1 w-full min-w-0 border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
  const inputType =
    capability.type === "number"
      ? "number"
      : capability.type === "date"
        ? "date"
        : capability.type === "datetime"
          ? "datetime-local"
          : "text";

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
      <label className="flex min-w-0 flex-col">
        <span className={labelClass}>Field</span>
        <select
          ref={(element) =>
            registerFocus(diagnosticPath(path, "field"), element)
          }
          aria-label={`Field for condition ${position}`}
          value={filterValue.field}
          onChange={(event) => {
            const nextCapability = fields.find(
              (field) => field.key === event.target.value,
            );
            if (!nextCapability) return;
            const nextOperator = operatorsFor(nextCapability.type)[0];
            onChange(
              comparison(
                nextCapability.key,
                nextOperator,
                defaultValue(nextCapability, nextOperator),
              ),
            );
          }}
          className={controlClass}
        >
          {!knownCapability && (
            <option value={filterValue.field}>
              {filterValue.field} (undeclared)
            </option>
          )}
          <optgroup label="Page fields">
            {SYSTEM_FIELDS.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </optgroup>
          {declaredFields.length > 0 && (
            <optgroup label="Declared properties">
              {declaredFields.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <label className="flex min-w-0 flex-col">
        <span className={labelClass}>Operator</span>
        <select
          ref={(element) => registerFocus(diagnosticPath(path, "op"), element)}
          aria-label={`Operator for condition ${position}`}
          value={activeOperator}
          onChange={(event) => {
            const nextOperator = operatorOptions.find(
              (operator) => operator === event.target.value,
            );
            if (!nextOperator) return;
            const nextValue =
              nextOperator === "in"
                ? Array.isArray(filterValue.value)
                  ? filterValue.value
                  : filterValue.value == null || filterValue.value === ""
                    ? []
                    : [filterValue.value]
                : Array.isArray(filterValue.value)
                  ? (filterValue.value[0] ??
                    defaultValue(capability, nextOperator))
                  : (filterValue.value ??
                    defaultValue(capability, nextOperator));
            onChange(comparison(filterValue.field, nextOperator, nextValue));
          }}
          className={controlClass}
        >
          {operatorOptions.map((operator) => (
            <option key={operator} value={operator}>
              {operators.includes(operator)
                ? operator.replace("_", " ")
                : `${operator} (unsupported)`}
            </option>
          ))}
        </select>
      </label>

      {hasValue && (
        <label className="flex min-w-0 flex-col">
          <span className={labelClass}>Value</span>
          {capability.type === "bool" ? (
            <select
              ref={(element) =>
                registerFocus(diagnosticPath(path, "value"), element)
              }
              aria-label={`Value for condition ${position}`}
              multiple={activeOperator === "in"}
              value={
                activeOperator === "in"
                  ? Array.isArray(filterValue.value)
                    ? filterValue.value.map(String)
                    : []
                  : filterValue.value === false
                    ? "false"
                    : "true"
              }
              onChange={(event) =>
                onChange(
                  comparison(
                    filterValue.field,
                    activeOperator,
                    activeOperator === "in"
                      ? Array.from(
                          event.target.selectedOptions,
                          (option) => option.value === "true",
                        )
                      : event.target.value === "true",
                  ),
                )
              }
              className={controlClass}
            >
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          ) : declaredOptions.length > 0 ? (
            <select
              ref={(element) =>
                registerFocus(diagnosticPath(path, "value"), element)
              }
              aria-label={`Value for condition ${position}`}
              multiple={activeOperator === "in"}
              value={
                activeOperator === "in"
                  ? Array.isArray(filterValue.value)
                    ? filterValue.value.map(String)
                    : []
                  : valueText
              }
              onChange={(event) =>
                onChange(
                  comparison(
                    filterValue.field,
                    activeOperator,
                    activeOperator === "in"
                      ? Array.from(
                          event.target.selectedOptions,
                          (option) => option.value,
                        )
                      : event.target.value,
                  ),
                )
              }
              className={controlClass}
            >
              {declaredOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              {missingOptions.map((option) => (
                <option key={option} value={option}>
                  {option} (not declared)
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                ref={(element) =>
                  registerFocus(diagnosticPath(path, "value"), element)
                }
                aria-label={`Value for condition ${position}`}
                type={inputType}
                list={
                  capability.type === "relation" ? relationListId : undefined
                }
                value={displayValueText}
                onBlur={() => setFreeformDraft(undefined)}
                onChange={(event) => {
                  setFreeformDraft(event.target.value);
                  onChange(
                    comparison(
                      filterValue.field,
                      activeOperator,
                      activeOperator === "in"
                        ? event.target.value
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean)
                        : capability.type === "number"
                          ? event.target.value === ""
                            ? ""
                            : event.target.valueAsNumber
                          : event.target.value,
                    ),
                  );
                }}
                className={controlClass}
              />
              {capability.type === "relation" && (
                <datalist id={relationListId}>
                  {relationSuggestions.map((suggestion) => (
                    <option key={suggestion} value={suggestion} />
                  ))}
                </datalist>
              )}
            </>
          )}
        </label>
      )}
    </div>
  );
}
