import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { PropertyType, SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import { canSort, type DraftProperty, moveItem } from "./definition-model";
import {
  MoveButtons,
  ReorderAnnouncement,
  ReorderHandle,
  useReorderable,
  useReorderAnnouncement,
} from "./ordered-list";
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
  /** Supplied when the host already owns a live region, so the two ordered
   * lists in a view editor do not each announce into their own. */
  announceMove?(label: string, position: number, count: number): void;
}

export function OrderedSortEditor({
  value,
  properties,
  diagnostics,
  diagnosticRoot,
  idPrefix,
  onChange,
  registerFocus,
  announceMove,
}: OrderedSortEditorProps) {
  const fields = sortableFieldKeys(properties);
  const own = useReorderAnnouncement();
  const announce = announceMove ?? own.announce;

  function replace(index: number, sort: SortKey) {
    onChange(
      value.map((current, position) => (position === index ? sort : current)),
    );
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= value.length || from === to) return;
    announce(`sort ${from + 1}`, to + 1, value.length);
    onChange(moveItem(value, from, to));
  }

  /** Sort keys have no identity of their own, so the drag payload carries the
   * row's position. */
  function dropSort(sourceId: string, targetId: string, edge: string) {
    const from = Number(sourceId);
    const target = Number(targetId);
    if (!Number.isInteger(from) || !Number.isInteger(target)) return;
    const to = edge === "bottom" && from > target ? target + 1 : target;
    move(from, from < to ? to - 1 : to);
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
            <SortRow
              key={index}
              index={index}
              count={value.length}
              onMove={move}
              onReorder={dropSort}
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
              <div className="flex flex-wrap justify-end gap-1">
                <MoveButtons
                  label={`sort ${index + 1}`}
                  index={index}
                  count={value.length}
                  onMove={move}
                />
                <IconButton
                  aria-label={`Remove sort ${index + 1}`}
                  variant="ghost"
                  onPress={() =>
                    onChange(value.filter((_, position) => position !== index))
                  }
                >
                  <Trash2 />
                </IconButton>
              </div>
            </SortRow>
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
      {announceMove ? null : <ReorderAnnouncement message={own.announcement} />}
    </>
  );
}

/** One sort key row, carrying the shared grip so sorts reorder exactly as
 * properties and columns do. */
function SortRow({
  index,
  count,
  onMove,
  onReorder,
  children,
}: {
  index: number;
  count: number;
  onMove(from: number, to: number): void;
  onReorder(sourceId: string, targetId: string, edge: string): void;
  children: ReactNode;
}) {
  const { rowRef, setHandle, onHandleKeyDown } =
    useReorderable<HTMLLIElement>({
      kind: "base-sort",
      idKey: "sortIndex",
      id: String(index),
      index,
      count,
      onMove,
      onReorder,
    });

  return (
    <li
      ref={rowRef}
      className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[auto_minmax(0,1fr)_9rem_auto]"
    >
      <ReorderHandle
        label={`sort ${index + 1}`}
        setHandle={setHandle}
        onKeyDown={onHandleKeyDown}
      />
      {children}
    </li>
  );
}
