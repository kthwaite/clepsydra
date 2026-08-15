import type { PropertyType, SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import { canSort, type DraftProperty, moveItem } from "./definition-model";
import { SYSTEM_PROPERTY_FIELDS } from "./PropertiesEditor";

interface FieldCapability {
  key: string;
  type: PropertyType | "system-multi" | "word_count" | undefined;
}

export function sortableFieldKeys(
  properties: readonly DraftProperty[],
): string[] {
  const fields: FieldCapability[] = [
    ...SYSTEM_PROPERTY_FIELDS.filter((key) => key !== "encryption").map(
      (key): FieldCapability => ({
        key,
        type:
          key === "tags" || key === "aliases"
            ? "system-multi"
            : key === "word_count"
              ? "word_count"
              : undefined,
      }),
    ),
    ...properties.map((property) => ({
      key: property.key,
      type: property.definition.type,
    })),
  ];
  return fields.filter(({ type }) => canSort(type)).map(({ key }) => key);
}


interface OrderedSortEditorProps {
  value: SortKey[];
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  diagnosticRoot: string;
  idPrefix: string;
  onChange(value: SortKey[]): void;
  registerFocus: RegisterFocusTarget;
}

export function OrderedSortEditor({
  value,
  properties,
  diagnostics,
  diagnosticRoot,
  idPrefix,
  onChange,
  registerFocus,
}: OrderedSortEditorProps) {
  const fields = sortableFieldKeys(properties);

  function replace(index: number, sort: SortKey) {
    onChange(
      value.map((current, position) => (position === index ? sort : current)),
    );
  }

  return (
    <>
      <ol className="mt-3 grid gap-2" aria-label="Ordered sort keys">
        {value.map((sort, index) => {
          const sortPath = `${diagnosticRoot}[${index}].field`;
          const sortDiagnostics = diagnostics.filter(
            (diagnostic) => diagnostic.path === sortPath,
          );
          const sortInvalid = sortDiagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          );
          const sortSupported = fields.includes(sort.field);
          const errorId = `${idPrefix}-sort-field-error-${index}`;
          return (
            <li
              key={index}
              className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
            >
              <div>
                <Select
                  label={`Sort field ${index + 1}`}
                  triggerRef={(element) => registerFocus(sortPath, element)}
                  value={sort.field}
                  isInvalid={sortInvalid}
                  aria-describedby={
                    sortDiagnostics.length ? errorId : undefined
                  }
                  onChange={(key) => {
                    if (key == null) return;
                    replace(index, {
                      ...sort,
                      field: String(key),
                    });
                  }}
                >
                  {!sortSupported ? (
                    <SelectItem
                      id={sort.field}
                      textValue={`${sort.field} (unsupported for sorting)`}
                    >
                      {sort.field} (unsupported for sorting)
                    </SelectItem>
                  ) : null}
                  {fields.map((key) => (
                    <SelectItem key={key} id={key}>
                      {key}
                    </SelectItem>
                  ))}
                </Select>
                {sortDiagnostics.length > 0 ? (
                  <span
                    id={errorId}
                    role="alert"
                    className="mt-1 block text-xs normal-case tracking-normal text-destructive"
                  >
                    {sortDiagnostics
                      .map((diagnostic) => diagnostic.message)
                      .join(" ")}
                  </span>
                ) : null}
              </div>
              <Select
                label={`Sort direction ${index + 1}`}
                value={sort.dir ?? "asc"}
                onChange={(key) => {
                  if (key !== "asc" && key !== "desc") return;
                  replace(index, {
                    ...sort,
                    dir: key,
                  });
                }}
              >
                <SelectItem id="asc">Ascending</SelectItem>
                <SelectItem id="desc">Descending</SelectItem>
              </Select>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={index === 0}
                  onPress={() => onChange(moveItem(value, index, index - 1))}
                >
                  Move sort {index + 1} up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={index === value.length - 1}
                  onPress={() => onChange(moveItem(value, index, index + 1))}
                >
                  Move sort {index + 1} down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    onChange(value.filter((_, position) => position !== index))
                  }
                >
                  Remove sort {index + 1}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        className="mt-3"
        size="sm"
        variant="secondary"
        onPress={() =>
          onChange([...value, { field: fields[0] ?? "title", dir: "asc" }])
        }
      >
        Add sort
      </Button>
    </>
  );
}
