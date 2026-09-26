import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Aggregate, PropertyType } from "#/api/bases";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import { BaseFilterEditor } from "./BaseFilterEditor";
import { DisplayLabelsEditor } from "./DisplayLabelsEditor";
import {
  type AggregateFunction,
  aggregateFunctions,
  canGroup,
  type DraftProperty,
  type DraftView,
  moveItem,
} from "./definition-model";
import { diagnosticRows } from "./diagnostic-rows";
import { OrderedSortEditor } from "./OrderedSortEditor";
import {
  MoveButtons,
  ReorderHandle,
  useIdentifiedRows,
  useReorderable,
} from "./ordered-list";
import { SYSTEM_PROPERTY_FIELDS } from "./PropertiesEditor";

interface FieldCapability {
  key: string;
  type: PropertyType | "system-multi" | "word_count" | undefined;
}

function fieldCapabilities(
  properties: readonly DraftProperty[],
): FieldCapability[] {
  return [
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
}

const controlClass = cn(
  "mt-1.5 block h-10 w-full rounded-full bg-sink px-4 text-[14px] text-ink placeholder:text-mute aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
  FOCUS_RING_NATIVE,
);
const labelClass = "text-[12.5px] text-mute";
const errorClass = "mt-1.5 block text-[12.5px] text-hot";
const warningClass = "mt-1.5 block text-[12.5px] text-warn";

/** One titled block of the view editor: faint tick + italic serif title,
 *  then the body indented to the title. Spacing and tone, no rules. */
function ViewSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <h4
        id={id}
        className="flex items-center gap-2.5 font-serif text-[19px] italic leading-none text-ink"
      >
        <Tick variant="faint" />
        {title}
      </h4>
      <div className="min-w-0 pl-[17px]">{children}</div>
    </section>
  );
}
const AGGREGATE_FUNCTION_OPTIONS = [
  "count",
  "count_filled",
  "count_empty",
  "percent_filled",
  "count_unique",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "range",
] as const satisfies readonly AggregateFunction[];

interface ViewDefinitionEditorProps {
  view: DraftView;
  viewIndex: number;
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  onChange(view: DraftView): void;
  registerFocus: RegisterFocusTarget;
  /** The host owns the live region: views, columns and sorts share one. */
  onAnnounceMove(message: string): void;
}

interface ColumnRow {
  id: string;
  column: string;
}

interface VisibleColumnRowProps {
  row: ColumnRow;
  index: number;
  count: number;
  onMove(from: number, to: number): void;
  onReorder(
    sourceColumnId: string,
    targetColumnId: string,
    edge: "top" | "bottom",
  ): void;
  onRemove(index: number): void;
  onHandleRef(columnId: string, element: HTMLButtonElement | null): void;
}

function VisibleColumnRow({
  row,
  index,
  count,
  onMove,
  onReorder,
  onRemove,
  onHandleRef,
}: VisibleColumnRowProps) {
  const { rowRef, setHandle, onHandleKeyDown } =
    useReorderable<HTMLTableRowElement>({
      kind: "base-view-column",
      idKey: "columnId",
      id: row.id,
      index,
      count,
      onMove,
      onReorder,
      onHandleRef,
    });

  return (
    <tr
      ref={rowRef}
      className={cn(
        "[&>:first-child]:rounded-l-[10px] [&>:last-child]:rounded-r-[10px]",
        index % 2 === 0 && "[&>*]:bg-raise/70",
      )}
    >
      <td className="w-8 py-0.5 pl-1 align-middle">
        <ReorderHandle
          label={`${row.column} column`}
          setHandle={setHandle}
          onKeyDown={onHandleKeyDown}
        />
      </td>
      <th
        scope="row"
        className="break-words px-1.5 py-0.5 text-left align-middle text-[14px] font-normal text-ink"
      >
        {row.column}
      </th>
      <td className="w-[6.5rem] py-0.5 pr-1 align-middle">
        <fieldset className="m-0 flex justify-end border-0 p-0">
          <legend className="sr-only">Actions for {row.column}</legend>
          <MoveButtons
            label={row.column}
            index={index}
            count={count}
            onMove={onMove}
          />
          <IconButton
            aria-label={`Remove ${row.column} column`}
            variant="ghost"
            onPress={() => onRemove(index)}
          >
            <X />
          </IconButton>
        </fieldset>
      </td>
    </tr>
  );
}

export function ViewDefinitionEditor({
  view,
  viewIndex,
  properties,
  diagnostics,
  onChange,
  registerFocus,
  onAnnounceMove,
}: ViewDefinitionEditorProps) {
  const [columnToAdd, setColumnToAdd] = useState("");
  const columnReasonId = `${useId()}-column-reason`;
  const announceMove = (label: string, position: number, count: number) =>
    onAnnounceMove(`Moved ${label} to position ${position} of ${count}.`);
  const [focusColumnId, setFocusColumnId] = useState<string>();
  const reorderHandles = useRef(new Map<string, HTMLButtonElement>());
  const nextColumnId = useRef(view.columns.length);
  const [columnRows, setColumnRows] = useState(() =>
    view.columns.map((column, index) => ({
      id: `column-${index}`,
      column,
    })),
  );
  const {
    createRow: createAggregateRow,
    rows: aggregateRows,
    setRows: setAggregateRows,
  } = useIdentifiedRows(view.aggregates, "aggregate");
  const fields = fieldCapabilities(properties);
  const columnFields: FieldCapability[] = [
    ...fields,
    { key: "body", type: undefined },
  ];
  const viewPath = `views[${viewIndex}]`;
  const unsupportedLayout = (view.layout as string) !== "table";
  const groupFields = fields.filter(
    ({ type }) =>
      type !== "system-multi" && type !== "word_count" && canGroup(type),
  );
  const unselectedColumns = columnFields.filter(
    ({ key }) => !view.columns.includes(key),
  );
  useEffect(() => {
    setColumnRows((current) => {
      if (
        current.length === view.columns.length &&
        current.every(({ column }, index) => column === view.columns[index])
      )
        return current;
      const available = [...current];
      return view.columns.map((column) => {
        const matchIndex = available.findIndex(
          (candidate) => candidate.column === column,
        );
        if (matchIndex >= 0) return available.splice(matchIndex, 1)[0];
        const id = `column-${nextColumnId.current}`;
        nextColumnId.current += 1;
        return { id, column };
      });
    });
  }, [view.columns]);
  const nameDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === `${viewPath}.name`,
  );
  const layoutDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === `${viewPath}.layout`,
  );
  const viewDiagnostics = diagnostics.filter(
    (diagnostic) =>
      diagnostic.path?.startsWith(viewPath) &&
      diagnostic.path !== `${viewPath}.name` &&
      diagnostic.path !== `${viewPath}.layout` &&
      !/\.sort\[\d+\]\.field$/.test(diagnostic.path),
  );
  const nameInvalid = nameDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const layoutInvalid = layoutDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );

  useEffect(() => {
    if (!focusColumnId) return;
    if (!columnRows.some(({ id }) => id === focusColumnId)) return;
    const handle = reorderHandles.current.get(focusColumnId);
    if (!handle) return;
    handle.focus();
    setFocusColumnId(undefined);
  }, [columnRows, focusColumnId]);
  function moveColumn(from: number, to: number) {
    if (
      from < 0 ||
      to < 0 ||
      from >= view.columns.length ||
      to >= view.columns.length
    )
      return;
    const movedRow = columnRows[from];
    if (!movedRow || from === to) return;
    setFocusColumnId(movedRow.id);
    setColumnRows(moveItem(columnRows, from, to));
    announceMove(movedRow.column, to + 1, view.columns.length);
    onChange({
      ...view,
      columns: moveItem(view.columns, from, to),
    });
  }

  function dropColumn(
    sourceId: string,
    targetId: string,
    edge: "top" | "bottom",
  ) {
    const sourceIndex = columnRows.findIndex(({ id }) => id === sourceId);
    const targetIndex = columnRows.findIndex(({ id }) => id === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
      return;

    const insertionIndex = targetIndex + (edge === "bottom" ? 1 : 0);
    const destinationIndex =
      insertionIndex - (sourceIndex < insertionIndex ? 1 : 0);
    moveColumn(sourceIndex, destinationIndex);
  }

  function removeColumn(index: number) {
    setColumnRows((current) =>
      current.filter((_, position) => position !== index),
    );
    onChange({
      ...view,
      columns: view.columns.filter((_, position) => position !== index),
    });
  }

  function replaceAggregate(index: number, aggregate: Aggregate) {
    setAggregateRows((current) =>
      current.map((row, position) =>
        position === index ? { ...row, value: aggregate } : row,
      ),
    );
    onChange({
      ...view,
      aggregates: view.aggregates.map((current, position) =>
        position === index ? aggregate : current,
      ),
    });
  }

  function removeAggregate(index: number) {
    setAggregateRows((current) =>
      current.filter((_, position) => position !== index),
    );
    onChange({
      ...view,
      aggregates: view.aggregates.filter((_, position) => position !== index),
    });
  }

  function appendAggregate() {
    const aggregate: Aggregate = { fn: "count" };
    setAggregateRows((current) => [...current, createAggregateRow(aggregate)]);
    onChange({
      ...view,
      aggregates: [...view.aggregates, aggregate],
    });
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-[26px]">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12.5rem]">
        <div>
          <label className={labelClass} htmlFor={`view-name-${viewIndex}`}>
            View name
          </label>
          <input
            id={`view-name-${viewIndex}`}
            ref={(element) => registerFocus(`${viewPath}.name`, element)}
            className={controlClass}
            value={view.name}
            onChange={(event) =>
              onChange({ ...view, name: event.target.value })
            }
            aria-invalid={nameInvalid || undefined}
            aria-describedby={
              nameDiagnostics.length > 0
                ? `view-name-error-${viewIndex}`
                : undefined
            }
          />
          {nameDiagnostics.length > 0 ? (
            <span
              id={`view-name-error-${viewIndex}`}
              className={nameInvalid ? errorClass : warningClass}
            >
              {nameDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </span>
          ) : null}
        </div>
        <div>
          <Select
            id={`view-layout-${viewIndex}`}
            label="Layout"
            triggerRef={(element) =>
              registerFocus(`${viewPath}.layout`, element)
            }
            value={view.layout}
            onChange={(key) => {
              if (key == null) return;
              onChange({ ...view, layout: String(key) });
            }}
            isInvalid={layoutInvalid}
            aria-describedby={
              layoutDiagnostics.length > 0
                ? `view-layout-error-${viewIndex}`
                : undefined
            }
          >
            {unsupportedLayout ? (
              <SelectItem id={view.layout as string}>{view.layout}</SelectItem>
            ) : null}
            <SelectItem id="table">Table</SelectItem>
          </Select>
          {layoutDiagnostics.length > 0 ? (
            <span
              id={`view-layout-error-${viewIndex}`}
              className={layoutInvalid ? errorClass : warningClass}
            >
              {layoutDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </span>
          ) : null}
        </div>
      </div>
      {unsupportedLayout && layoutDiagnostics.length === 0 ? (
        <p
          role="alert"
          className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-hot"
        >
          Unsupported layout “{view.layout}”. The guided editor supports only
          table layouts. Choose Table to repair it.
        </p>
      ) : null}
      {viewDiagnostics.length > 0 ? (
        <ul className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-warn">
          {diagnosticRows(viewDiagnostics).map(({ diagnostic, key }) => (
            <li key={key}>{diagnostic.message}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-x-10 gap-y-[26px] @min-[52rem]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-[26px]">
          <ViewSection
            id={`${view.id}-columns-heading`}
            title="Visible columns"
          >
            <p className="text-[13px] leading-normal text-mute">
              Columns render from left to right in this exact order.
            </p>
            <table
              className="mt-2 w-full table-fixed border-separate border-spacing-y-[3px]"
              aria-label="Visible column order"
            >
              <thead className="sr-only">
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Column</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {columnRows.map((row, index) => (
                  <VisibleColumnRow
                    key={row.id}
                    row={row}
                    index={index}
                    count={columnRows.length}
                    onMove={moveColumn}
                    onReorder={dropColumn}
                    onRemove={removeColumn}
                    onHandleRef={(columnId, element) => {
                      if (element)
                        reorderHandles.current.set(columnId, element);
                      else reorderHandles.current.delete(columnId);
                    }}
                  />
                ))}
              </tbody>
            </table>

            <div className="mt-2 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Select
                label="Column to add"
                value={columnToAdd}
                onChange={(key) =>
                  setColumnToAdd(key == null ? "" : String(key))
                }
              >
                <SelectItem id="">Choose a field</SelectItem>
                {unselectedColumns.map(({ key }) => (
                  <SelectItem key={key} id={key}>
                    {key}
                  </SelectItem>
                ))}
              </Select>
              <Button
                className="mb-1"
                size="sm"
                variant="secondary"
                isDisabled={!columnToAdd}
                aria-describedby={columnToAdd ? undefined : columnReasonId}
                onPress={() => {
                  if (!columnToAdd) return;
                  const id = `column-${nextColumnId.current}`;
                  nextColumnId.current += 1;
                  setColumnRows((current) => [
                    ...current,
                    { id, column: columnToAdd },
                  ]);
                  onChange({
                    ...view,
                    columns: [...view.columns, columnToAdd],
                  });
                  setColumnToAdd("");
                }}
              >
                Add column
              </Button>
              {columnToAdd ? null : (
                <span id={columnReasonId} className="sr-only">
                  Choose a field to add
                </span>
              )}
            </div>
          </ViewSection>

          <DisplayLabelsEditor
            labels={view.labels}
            properties={properties}
            diagnostics={diagnostics}
            diagnosticRoot={`${viewPath}.labels`}
            onChange={(labels) => onChange({ ...view, labels })}
            registerFocus={registerFocus}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-[26px]">
          <ViewSection id={`${view.id}-sort-heading`} title="Sort order">
            <OrderedSortEditor
              value={view.sort}
              properties={properties}
              diagnostics={diagnostics}
              diagnosticRoot={`${viewPath}.sort`}
              idPrefix={`view-${viewIndex}`}
              onChange={(sort) => onChange({ ...view, sort })}
              registerFocus={registerFocus}
              announceMove={announceMove}
            />
          </ViewSection>

          <ViewSection id={`${view.id}-group-heading`} title="Grouping">
            <Select
              label="Group by"
              triggerRef={(element) =>
                registerFocus(`${viewPath}.group_by`, element)
              }
              value={view.group_by ?? ""}
              onChange={(key) =>
                onChange({
                  ...view,
                  group_by: key == null || key === "" ? undefined : String(key),
                })
              }
            >
              <SelectItem id="">No grouping</SelectItem>
              {groupFields.map(({ key }) => (
                <SelectItem key={key} id={key}>
                  {key}
                </SelectItem>
              ))}
            </Select>
          </ViewSection>

          <ViewSection id={`${view.id}-aggregates-heading`} title="Aggregates">
            <ol className="flex flex-col gap-2 empty:hidden">
              {aggregateRows.map(({ id, value: aggregate }, index) => {
                const fn = aggregate.fn as AggregateFunction;
                const eligibleFields = fields.filter(({ type }) =>
                  aggregateFunctions(
                    type === "system-multi" ? undefined : type,
                  ).includes(fn),
                );
                return (
                  <li
                    key={id}
                    className="grid shrink-0 items-end gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)_auto]"
                  >
                    <Select
                      label={`Aggregate function ${index + 1}`}
                      triggerRef={(element) => {
                        registerFocus(
                          `${viewPath}.aggregates[${index}]`,
                          element,
                        );
                        registerFocus(
                          `${viewPath}.aggregates[${index}].fn`,
                          element,
                        );
                      }}
                      value={fn}
                      onChange={(key) => {
                        const nextFn = AGGREGATE_FUNCTION_OPTIONS.find(
                          (option) => option === key,
                        );
                        if (!nextFn) return;
                        if (nextFn === "count") {
                          replaceAggregate(index, { fn: "count" });
                          return;
                        }
                        const first = fields.find(({ type }) =>
                          aggregateFunctions(
                            type === "system-multi" ? undefined : type,
                          ).includes(nextFn),
                        );
                        replaceAggregate(index, {
                          fn: nextFn,
                          field: first?.key,
                        });
                      }}
                    >
                      {AGGREGATE_FUNCTION_OPTIONS.map((option) => (
                        <SelectItem key={option} id={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </Select>
                    {fn !== "count" ? (
                      <Select
                        label={`Aggregate field ${index + 1}`}
                        triggerRef={(element) =>
                          registerFocus(
                            `${viewPath}.aggregates[${index}].field`,
                            element,
                          )
                        }
                        value={aggregate.field ?? ""}
                        onChange={(key) => {
                          if (key == null) return;
                          replaceAggregate(index, {
                            fn,
                            field: String(key),
                          });
                        }}
                      >
                        {eligibleFields.map(({ key }) => (
                          <SelectItem key={key} id={key}>
                            {key}
                          </SelectItem>
                        ))}
                      </Select>
                    ) : (
                      <span />
                    )}
                    <IconButton
                      className="mb-1"
                      aria-label={`Remove aggregate ${index + 1}`}
                      variant="ghost"
                      onPress={() => removeAggregate(index)}
                    >
                      <X />
                    </IconButton>
                  </li>
                );
              })}
            </ol>
            <Button
              className="mt-2.5"
              size="sm"
              variant="secondary"
              onPress={appendAggregate}
            >
              Add aggregate
            </Button>
          </ViewSection>

          <ViewSection
            id={`${view.id}-filter-heading`}
            title="Additional filter"
          >
            <p className="text-[13px] leading-normal text-mute">
              Always combined with base membership.
            </p>
            <div className="mt-2.5">
              <BaseFilterEditor
                value={view.filter}
                properties={properties}
                onChange={(filter) => onChange({ ...view, filter })}
                registerFocus={registerFocus}
                diagnostics={diagnostics}
                diagnosticRoot={`${viewPath}.filter`}
              />
            </div>
          </ViewSection>
        </div>
      </div>
    </div>
  );
}
