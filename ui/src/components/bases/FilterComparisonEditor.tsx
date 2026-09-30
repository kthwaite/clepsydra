import { type Ref, useEffect, useId, useState } from "react";
import type { Key } from "react-aria-components";
import type { BaseFilter, FilterOp, PropertyType } from "#/api/bases";
import { Header } from "#/components/ui/list-box";
import { Select, SelectItem, SelectSection } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KINDS, kindDisplayLabel, sortKindsByLabel } from "#/lib/kind";
import { type DraftProperty, operatorsFor } from "./definition-model";
import {
  FilterValuePicker,
  PersonFilterValuePicker,
  ProjectFilterValuePicker,
} from "./FilterValuePicker";
import type { FilterDiagnosticScope } from "./filter-diagnostics";
import { OPERATOR_LABELS, VALUELESS_OPERATORS } from "./operator-labels";

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
export const CANONICAL_FILTER_FIELDS = SYSTEM_FIELDS.map(({ key }) => key);

const KIND_CHOICES = sortKindsByLabel(KINDS).map((kind) => ({
  id: kind,
  label: kindDisplayLabel(kind),
}));

function fieldOperators(capability: FieldCapability): FilterOp[] {
  if (capability.key === "kind" || capability.key === "project") {
    return ["eq", "ne", "in", "is_empty", "not_empty"];
  }
  if (capability.key === "attendees" && capability.type === "relation") {
    return ["links_to", "is_empty", "not_empty"];
  }
  return operatorsFor(capability.type);
}

function comparison(field: string, op: FilterOp, value: unknown): BaseFilter {
  return VALUELESS_OPERATORS[op] ? { field, op } : { field, op, value };
}

function defaultValue(capability: FieldCapability, op: FilterOp): unknown {
  if (VALUELESS_OPERATORS[op]) return undefined;
  if (op === "in") return [];
  if (
    capability.key === "kind" ||
    capability.key === "project" ||
    (capability.key === "attendees" && capability.type === "relation")
  ) {
    return "";
  }
  if (capability.type === "bool") return true;
  return capability.options?.[0] ?? "";
}
interface SelectChoice {
  id: string;
  label: string;
}
const BOOLEAN_CHOICES: readonly SelectChoice[] = [
  { id: "true", label: "True" },
  { id: "false", label: "False" },
];

interface ConditionalValueSelectProps {
  ariaLabel: string;
  ariaDescribedBy?: string;
  isInvalid: boolean;
  isMultiple: boolean;
  selectedValues: string[];
  choices: readonly SelectChoice[];
  triggerRef: Ref<HTMLButtonElement>;
  onSingleChange(value: string): void;
  onMultipleChange(values: string[]): void;
}

function ConditionalValueSelect({
  ariaLabel,
  ariaDescribedBy,
  isInvalid,
  isMultiple,
  selectedValues,
  choices,
  triggerRef,
  onSingleChange,
  onMultipleChange,
}: ConditionalValueSelectProps) {
  const items = choices.map(({ id, label }) => (
    <SelectItem key={id} id={id}>
      {label}
    </SelectItem>
  ));

  if (isMultiple) {
    return (
      <Select
        label="Value"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        isInvalid={isInvalid}
        selectionMode="multiple"
        value={selectedValues}
        triggerRef={triggerRef}
        onChange={(keys: Key[]) => {
          onMultipleChange(keys.map(String));
        }}
      >
        {items}
      </Select>
    );
  }

  return (
    <Select
      label="Value"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      isInvalid={isInvalid}
      value={selectedValues[0] ?? ""}
      triggerRef={triggerRef}
      onChange={(key: Key | null) => {
        if (key == null) return;
        onSingleChange(String(key));
      }}
    >
      {items}
    </Select>
  );
}

interface FilterComparisonEditorProps {
  value: BaseFilter;
  position: number;
  properties: DraftProperty[];
  onChange(value: BaseFilter): void;
  diagnosticScope: FilterDiagnosticScope;
  allowAttendees?: boolean;
}

export function FilterComparisonEditor({
  value,
  position,
  properties,
  onChange,
  diagnosticScope,
  allowAttendees = true,
}: FilterComparisonEditorProps) {
  const [relationSuggestions, setRelationSuggestions] = useState<string[]>([]);
  const [freeformDraft, setFreeformDraft] = useState<{
    field: string;
    op: FilterOp;
    text: string;
  }>();
  const relationListId = useId();
  const diagnosticId = useId();

  const declaredFields: FieldCapability[] = properties
    .filter(
      (property) =>
        !SYSTEM_FIELDS.some((system) => system.key === property.key),
    )
    .map((property) => ({
      key: property.key,
      label: property.key === "attendees" ? "Attendees" : property.key,
      type: property.definition.type,
      options: property.definition.options,
    }));
  const pageFields: readonly FieldCapability[] =
    allowAttendees && !declaredFields.some((field) => field.key === "attendees")
      ? [
          ...SYSTEM_FIELDS,
          { key: "attendees", label: "Attendees", type: "relation" },
        ]
      : SYSTEM_FIELDS;
  const fields = [...pageFields, ...declaredFields];
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
  const operators = fieldOperators(capability);
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
  const activeDraft =
    freeformDraft?.field === filterValue.field &&
    freeformDraft.op === activeOperator
      ? freeformDraft.text
      : undefined;
  const displayValueText = activeDraft ?? valueText;
  const constrainedKind = capability.key === "kind";
  const constrainedProject = capability.key === "project";
  const constrainedPerson =
    capability.key === "attendees" && capability.type === "relation";
  const declaredOptions = capability.options ?? [];
  const selectedOptionValues = Array.isArray(filterValue.value)
    ? filterValue.value.map(String)
    : valueText === ""
      ? []
      : [valueText];
  const missingOptions = selectedOptionValues.filter(
    (option) => !declaredOptions.includes(option),
  );
  const fieldDiagnostics = diagnosticScope.exact("field");
  const operatorDiagnostics = diagnosticScope.exact("op");
  const valueDiagnostics = diagnosticScope.exact("value");
  const fieldInvalid = fieldDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const operatorInvalid = operatorDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const valueInvalid = valueDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const fieldErrorId = `${diagnosticId}-field-error`;
  const operatorErrorId = `${diagnosticId}-operator-error`;
  const valueErrorId = `${diagnosticId}-value-error`;

  useEffect(() => {
    let cancelled = false;
    if (
      capability.type !== "relation" ||
      constrainedPerson ||
      displayValueText.trim() === ""
    ) {
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
  }, [capability.type, constrainedPerson, displayValueText]);

  if (!("field" in value)) return null;

  const labelClass = "text-[12.5px] text-mute";
  const controlClass = cn(
    "mt-1 h-10 w-full min-w-0 rounded-full bg-sink px-4 text-[14px] text-ink placeholder:text-mute disabled:cursor-not-allowed disabled:opacity-45 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
    FOCUS_RING_NATIVE,
  );
  const inputType =
    capability.type === "number"
      ? "number"
      : capability.type === "date"
        ? "date"
        : capability.type === "datetime"
          ? "datetime-local"
          : "text";

  function commitFreeform(rawValue: string) {
    const nextValue =
      activeOperator === "in"
        ? rawValue
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : capability.type === "number"
          ? rawValue === ""
            ? ""
            : Number(rawValue)
          : rawValue;
    onChange(comparison(filterValue.field, activeOperator, nextValue));
  }

  const pickerProps = {
    ariaLabel: `Value for condition ${position}`,
    ariaDescribedBy: valueDiagnostics.length > 0 ? valueErrorId : undefined,
    isInvalid: valueInvalid,
    isMultiple: activeOperator === "in",
    selectedValues: selectedOptionValues,
    inputRef: (element: HTMLInputElement | null) =>
      diagnosticScope.register("value", element),
    onChange: (values: string[]) =>
      onChange(
        comparison(
          filterValue.field,
          activeOperator,
          activeOperator === "in" ? values : (values[0] ?? ""),
        ),
      ),
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
      <div className="min-w-0">
        <Select
          label="Field"
          aria-label={`Field for condition ${position}`}
          triggerRef={(element) => diagnosticScope.register("field", element)}
          value={filterValue.field}
          isInvalid={fieldInvalid}
          aria-describedby={
            fieldDiagnostics.length > 0 ? fieldErrorId : undefined
          }
          onChange={(key) => {
            if (key == null) return;
            const nextCapability = fields.find(
              (field) => field.key === String(key),
            );
            if (!nextCapability) return;
            setFreeformDraft(undefined);
            const nextOperator = fieldOperators(nextCapability)[0];
            onChange(
              comparison(
                nextCapability.key,
                nextOperator,
                defaultValue(nextCapability, nextOperator),
              ),
            );
          }}
        >
          {!knownCapability && (
            <SelectItem
              id={filterValue.field}
              textValue={`${filterValue.field} (undeclared)`}
            >
              {filterValue.field} (undeclared)
            </SelectItem>
          )}
          <SelectSection>
            <Header>Page fields</Header>
            {pageFields.map((field) => (
              <SelectItem key={field.key} id={field.key}>
                {field.label}
              </SelectItem>
            ))}
          </SelectSection>
          {declaredFields.length > 0 && (
            <SelectSection>
              <Header>Declared properties</Header>
              {declaredFields.map((field) => (
                <SelectItem key={field.key} id={field.key}>
                  {field.label}
                </SelectItem>
              ))}
            </SelectSection>
          )}
        </Select>
        {fieldDiagnostics.length > 0 ? (
          <span
            id={fieldErrorId}
            role="alert"
            className="mt-1 block text-[12.5px] text-hot"
          >
            {fieldDiagnostics.map((diagnostic) => diagnostic.message).join(" ")}
          </span>
        ) : null}
      </div>

      <div className="min-w-0">
        <Select
          label="Operator"
          aria-label={`Operator for condition ${position}`}
          triggerRef={(element) => diagnosticScope.register("op", element)}
          isInvalid={operatorInvalid}
          aria-describedby={
            operatorDiagnostics.length > 0 ? operatorErrorId : undefined
          }
          value={activeOperator}
          onChange={(key) => {
            const nextOperator = operatorOptions.find(
              (operator) => operator === key,
            );
            if (!nextOperator) return;
            setFreeformDraft(undefined);
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
        >
          {operatorOptions.map((operator) => (
            <SelectItem key={operator} id={operator}>
              {operators.includes(operator)
                ? constrainedPerson && operator === "links_to"
                  ? "includes"
                  : OPERATOR_LABELS[operator]
                : `${operator} (unsupported)`}
            </SelectItem>
          ))}
        </Select>
        {operatorDiagnostics.length > 0 ? (
          <span
            id={operatorErrorId}
            role="alert"
            className="mt-1 block text-[12.5px] text-hot"
          >
            {operatorDiagnostics
              .map((diagnostic) => diagnostic.message)
              .join(" ")}
          </span>
        ) : null}
      </div>

      {hasValue && (
        <div className="min-w-0">
          {constrainedKind ? (
            <FilterValuePicker
              key={`${filterValue.field}:${activeOperator}`}
              {...pickerProps}
              choices={KIND_CHOICES}
            />
          ) : constrainedProject ? (
            <ProjectFilterValuePicker
              key={`${filterValue.field}:${activeOperator}`}
              {...pickerProps}
            />
          ) : constrainedPerson && activeOperator === "links_to" ? (
            <PersonFilterValuePicker
              key={`${filterValue.field}:${activeOperator}`}
              {...pickerProps}
            />
          ) : capability.type === "bool" ? (
            <ConditionalValueSelect
              ariaLabel={`Value for condition ${position}`}
              ariaDescribedBy={
                valueDiagnostics.length > 0 ? valueErrorId : undefined
              }
              isInvalid={valueInvalid}
              isMultiple={activeOperator === "in"}
              selectedValues={
                activeOperator === "in"
                  ? Array.isArray(filterValue.value)
                    ? filterValue.value.map(String)
                    : []
                  : [filterValue.value === false ? "false" : "true"]
              }
              choices={BOOLEAN_CHOICES}
              triggerRef={(element) =>
                diagnosticScope.register("value", element)
              }
              onSingleChange={(selectedValue) =>
                onChange(
                  comparison(
                    filterValue.field,
                    activeOperator,
                    selectedValue === "true",
                  ),
                )
              }
              onMultipleChange={(selectedValues) =>
                onChange(
                  comparison(
                    filterValue.field,
                    activeOperator,
                    selectedValues.map(
                      (selectedValue) => selectedValue === "true",
                    ),
                  ),
                )
              }
            />
          ) : declaredOptions.length > 0 ? (
            <ConditionalValueSelect
              ariaLabel={`Value for condition ${position}`}
              ariaDescribedBy={
                valueDiagnostics.length > 0 ? valueErrorId : undefined
              }
              isInvalid={valueInvalid}
              isMultiple={activeOperator === "in"}
              selectedValues={selectedOptionValues}
              choices={[
                ...declaredOptions.map((option) => ({
                  id: option,
                  label: option,
                })),
                ...missingOptions.map((option) => ({
                  id: option,
                  label: `${option} (not declared)`,
                })),
              ]}
              triggerRef={(element) =>
                diagnosticScope.register("value", element)
              }
              onSingleChange={(selectedValue) =>
                onChange(
                  comparison(filterValue.field, activeOperator, selectedValue),
                )
              }
              onMultipleChange={(selectedValues) =>
                onChange(
                  comparison(filterValue.field, activeOperator, selectedValues),
                )
              }
            />
          ) : (
            <label className="flex min-w-0 flex-col">
              <span className={labelClass}>Value</span>
              <input
                ref={(element) => diagnosticScope.register("value", element)}
                aria-label={`Value for condition ${position}`}
                aria-invalid={valueInvalid || undefined}
                aria-describedby={
                  valueDiagnostics.length > 0 ? valueErrorId : undefined
                }
                type={inputType}
                list={
                  capability.type === "relation" ? relationListId : undefined
                }
                value={displayValueText}
                onBlur={(event) => {
                  if (activeOperator === "in" && activeDraft !== undefined) {
                    commitFreeform(event.currentTarget.value);
                  }
                  setFreeformDraft(undefined);
                }}
                onChange={(event) => {
                  setFreeformDraft({
                    field: filterValue.field,
                    op: activeOperator,
                    text: event.target.value,
                  });
                  if (activeOperator !== "in") {
                    commitFreeform(event.target.value);
                  }
                }}
                onKeyDown={(event) => {
                  if (activeOperator !== "in" || event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  commitFreeform(event.currentTarget.value);
                  setFreeformDraft(undefined);
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
            </label>
          )}
          {valueDiagnostics.length > 0 ? (
            <span
              id={valueErrorId}
              role="alert"
              className="mt-1 block text-[12.5px] text-hot"
            >
              {valueDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
