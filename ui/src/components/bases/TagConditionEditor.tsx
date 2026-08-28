import { useId, useState } from "react";
import type { BaseFilter } from "#/api/bases";
import { useTags } from "#/api/index";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import { TagInput } from "#/components/ui/tag-input";
import type { DraftProperty } from "./definition-model";
import { FilterComparisonEditor } from "./FilterComparisonEditor";
import type { FilterDiagnosticScope } from "./filter-diagnostics";
import {
  readTagCondition,
  TAG_CONDITION_FIELDS,
  type TagConditionField,
  type TagQuantifier,
  writeTagCondition,
} from "./tag-condition";

interface TagConditionEditorProps {
  value: BaseFilter;
  position: number;
  properties: DraftProperty[];
  onChange(value: BaseFilter | undefined): void;
  diagnosticScope: FilterDiagnosticScope;
}

const FIELD_LABELS: Record<TagConditionField, string> = {
  tags: "Tags",
  aliases: "Aliases",
};

const QUANTIFIER_LABELS: Record<TagQuantifier, string> = {
  all_of: "Has all of",
  any_of: "Has any of",
  none_of: "Has none of",
};

/** Membership authoring for the multi-valued system fields: one row for
 * has-all-of / has-any-of / has-none-of, serialized through the existing
 * filter AST (see `tag-condition.ts`). Anything the row cannot express stays
 * available behind the advanced condition it wraps. */
export function TagConditionEditor({
  value,
  position,
  properties,
  onChange,
  diagnosticScope,
}: TagConditionEditorProps) {
  const [advanced, setAdvanced] = useState(false);
  const [pendingQuantifier, setPendingQuantifier] = useState<TagQuantifier>();
  const errorId = useId();
  const { data: tagIndex } = useTags();
  const condition = readTagCondition(value);

  if (!condition || advanced) {
    return (
      <div className="grid gap-2">
        <FilterComparisonEditor
          value={value}
          position={position}
          properties={properties}
          onChange={(next) => onChange(next)}
          diagnosticScope={diagnosticScope}
        />
        {condition ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setAdvanced(false)}
            >
              Edit condition {position} as a tag condition
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // Below two values the AST cannot tell all-of from any-of, so the row
  // remembers the author's choice until the filter can carry it.
  const quantifier =
    condition.values.length >= 2
      ? condition.quantifier
      : (pendingQuantifier ?? condition.quantifier);
  const rowDiagnostics = diagnosticScope.subtree();
  const invalid = rowDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const suggestions = (tagIndex ?? []).map((entry) => entry.tag);
  const valuesLabel = `Values for condition ${position}`;

  // Captured past the guard above: a hoisted declaration would not keep the
  // narrowing that proves `condition` is defined.
  const current = condition;
  const commit = (next: {
    field?: TagConditionField;
    quantifier?: TagQuantifier;
    values?: string[];
  }) => {
    onChange(
      writeTagCondition({
        field: next.field ?? current.field,
        quantifier: next.quantifier ?? quantifier,
        values: next.values ?? current.values,
        encoding: current.encoding,
      }),
    );
  };

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
        <div className="min-w-0">
          <Select
            label="Field"
            aria-label={`Field for condition ${position}`}
            value={condition.field}
            onChange={(key) => {
              if (key == null) return;
              commit({ field: key as TagConditionField });
            }}
          >
            {TAG_CONDITION_FIELDS.map((field) => (
              <SelectItem key={field} id={field}>
                {FIELD_LABELS[field]}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="min-w-0">
          <Select
            label="Operator"
            aria-label={`Operator for condition ${position}`}
            value={quantifier}
            isInvalid={invalid}
            onChange={(key) => {
              if (key == null) return;
              setPendingQuantifier(key as TagQuantifier);
              commit({ quantifier: key as TagQuantifier });
            }}
          >
            {(Object.keys(QUANTIFIER_LABELS) as TagQuantifier[]).map(
              (quantifier) => (
                <SelectItem key={quantifier} id={quantifier}>
                  {QUANTIFIER_LABELS[quantifier]}
                </SelectItem>
              ),
            )}
          </Select>
        </div>
      </div>

      <TagInput
        label="Values"
        ariaLabel={valuesLabel}
        ariaDescribedBy={rowDiagnostics.length > 0 ? errorId : undefined}
        values={condition.values}
        suggestions={suggestions}
        valuePrefix={condition.field === "tags" ? "#" : ""}
        placeholder="add a value…"
        maxSuggestions={8}
        onChange={(values) => commit({ values })}
      />

      {rowDiagnostics.length > 0 ? (
        <div
          id={errorId}
          ref={(element) => {
            for (const diagnostic of rowDiagnostics) {
              if (typeof diagnostic.path === "string") {
                diagnosticScope.registerPath(diagnostic.path, element);
              }
            }
          }}
          tabIndex={-1}
          className="grid gap-1"
        >
          {rowDiagnostics.map((diagnostic) => (
            <p
              key={`${diagnostic.path}:${diagnostic.message}`}
              role={diagnostic.severity === "error" ? "alert" : undefined}
              className={
                diagnostic.severity === "error"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {diagnostic.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onPress={() => setAdvanced(true)}>
          Edit condition {position} as an advanced condition
        </Button>
      </div>
    </div>
  );
}
