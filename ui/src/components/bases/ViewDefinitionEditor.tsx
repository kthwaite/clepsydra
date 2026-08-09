import { useState } from "react";
import type { Aggregate, PropertyType, SortKey } from "#/api/bases";
import { Button } from "#/components/ui/button";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import {
  type AggregateFunction,
  aggregateFunctions,
  canGroup,
  type DraftProperty,
  type DraftView,
  moveItem,
} from "./definition-model";
import { MembershipEditor } from "./MembershipEditor";
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

const controlClass =
  "mt-1 block w-full border border-input bg-background px-3 py-2 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";
const labelClass =
  "text-xs font-bold uppercase tracking-widest text-muted-foreground";
const headingClass =
  "font-mono text-xs font-semibold uppercase tracking-widest text-foreground";

interface ViewDefinitionEditorProps {
  view: DraftView;
  viewIndex: number;
  properties: DraftProperty[];
  diagnostics: BaseDiagnostic[];
  onChange(view: DraftView): void;
  registerFocus: RegisterFocusTarget;
}

export function ViewDefinitionEditor({
  view,
  viewIndex,
  properties,
  diagnostics,
  onChange,
  registerFocus,
}: ViewDefinitionEditorProps) {
  const [columnToAdd, setColumnToAdd] = useState("");
  const fields = fieldCapabilities(properties);
  const viewPath = `views[${viewIndex}]`;
  const unsupportedLayout = (view.layout as string) !== "table";
  const groupFields = fields.filter(
    ({ type }) =>
      type !== "system-multi" && type !== "word_count" && canGroup(type),
  );
  const unselectedColumns = fields.filter(
    ({ key }) => !view.columns.includes(key),
  );
  const viewDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.path?.startsWith(viewPath),
  );

  function replaceSort(index: number, sort: SortKey) {
    onChange({
      ...view,
      sort: view.sort.map((current, position) =>
        position === index ? sort : current,
      ),
    });
  }

  function replaceAggregate(index: number, aggregate: Aggregate) {
    onChange({
      ...view,
      aggregates: view.aggregates.map((current, position) =>
        position === index ? aggregate : current,
      ),
    });
  }

  return (
    <div className="min-w-0">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className={labelClass}>
          View name
          <input
            ref={(element) => registerFocus(`${viewPath}.name`, element)}
            className={controlClass}
            value={view.name}
            onChange={(event) =>
              onChange({ ...view, name: event.target.value })
            }
          />
        </label>
        <label className={labelClass}>
          Layout
          <select
            ref={(element) => registerFocus(`${viewPath}.layout`, element)}
            className={controlClass}
            value={view.layout}
            onChange={(event) =>
              onChange({ ...view, layout: event.target.value })
            }
          >
            {unsupportedLayout ? (
              <option value={view.layout as string}>{view.layout}</option>
            ) : null}
            <option value="table">Table</option>
          </select>
        </label>
      </div>
      {unsupportedLayout ? (
        <p
          role="alert"
          className="mt-3 border border-destructive p-3 text-sm text-destructive"
        >
          Unsupported layout “{view.layout}”. The guided editor supports only
          table layouts. Choose Table to repair it.
        </p>
      ) : null}
      {viewDiagnostics.length > 0 ? (
        <ul className="mt-3 border-l-2 border-warn pl-3 text-xs text-warn">
          {viewDiagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.path}-${index}`}>{diagnostic.message}</li>
          ))}
        </ul>
      ) : null}

      <section
        className="mt-6 border-t border-border pt-4"
        aria-labelledby={`${view.id}-columns-heading`}
      >
        <h4 id={`${view.id}-columns-heading`} className={headingClass}>
          Visible columns
        </h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Columns render from left to right in this exact order.
        </p>
        <ol className="mt-3 grid gap-2" aria-label="Visible column order">
          {view.columns.map((column, index) => (
            <li
              key={`${column}-${index}`}
              className="flex items-center gap-2 border-b border-border py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {column}
              </span>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={index === 0}
                onPress={() =>
                  onChange({
                    ...view,
                    columns: moveItem(view.columns, index, index - 1),
                  })
                }
              >
                Move {column} up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={index === view.columns.length - 1}
                onPress={() =>
                  onChange({
                    ...view,
                    columns: moveItem(view.columns, index, index + 1),
                  })
                }
              >
                Move {column} down
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onPress={() =>
                  onChange({
                    ...view,
                    columns: view.columns.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              >
                Remove {column} column
              </Button>
            </li>
          ))}
        </ol>
        <div className="mt-3 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className={labelClass}>
            Column to add
            <select
              className={controlClass}
              value={columnToAdd}
              onChange={(event) => setColumnToAdd(event.target.value)}
            >
              <option value="">Choose a field</option>
              {unselectedColumns.map(({ key }) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!columnToAdd}
            onPress={() => {
              if (!columnToAdd) return;
              onChange({ ...view, columns: [...view.columns, columnToAdd] });
              setColumnToAdd("");
            }}
          >
            Add column
          </Button>
        </div>
      </section>

      <section
        className="mt-6 border-t border-border pt-4"
        aria-labelledby={`${view.id}-sort-heading`}
      >
        <h4 id={`${view.id}-sort-heading`} className={headingClass}>
          Sort order
        </h4>
        <ol className="mt-3 grid gap-2" aria-label="Ordered sort keys">
          {view.sort.map((sort, index) => (
            <li
              key={index}
              className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto]"
            >
              <label className={labelClass}>
                Sort field {index + 1}
                <select
                  ref={(element) =>
                    registerFocus(`${viewPath}.sort[${index}]`, element)
                  }
                  className={controlClass}
                  value={sort.field}
                  onChange={(event) =>
                    replaceSort(index, { ...sort, field: event.target.value })
                  }
                >
                  {fields.map(({ key }) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                Sort direction {index + 1}
                <select
                  className={controlClass}
                  value={sort.dir ?? "asc"}
                  onChange={(event) =>
                    replaceSort(index, {
                      ...sort,
                      dir: event.target.value as "asc" | "desc",
                    })
                  }
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={index === 0}
                  onPress={() =>
                    onChange({
                      ...view,
                      sort: moveItem(view.sort, index, index - 1),
                    })
                  }
                >
                  Move sort {index + 1} up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={index === view.sort.length - 1}
                  onPress={() =>
                    onChange({
                      ...view,
                      sort: moveItem(view.sort, index, index + 1),
                    })
                  }
                >
                  Move sort {index + 1} down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    onChange({
                      ...view,
                      sort: view.sort.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  Remove sort {index + 1}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          onPress={() =>
            onChange({
              ...view,
              sort: [
                ...view.sort,
                { field: fields[0]?.key ?? "title", dir: "asc" },
              ],
            })
          }
        >
          Add sort
        </Button>
      </section>

      <section
        className="mt-6 border-t border-border pt-4"
        aria-labelledby={`${view.id}-group-heading`}
      >
        <h4 id={`${view.id}-group-heading`} className={headingClass}>
          Grouping
        </h4>
        <label className={`${labelClass} mt-3 block`}>
          Group by
          <select
            ref={(element) => registerFocus(`${viewPath}.group_by`, element)}
            className={controlClass}
            value={view.group_by ?? ""}
            onChange={(event) =>
              onChange({
                ...view,
                group_by: event.target.value || undefined,
              })
            }
          >
            <option value="">No grouping</option>
            {groupFields.map(({ key }) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section
        className="mt-6 border-t border-border pt-4"
        aria-labelledby={`${view.id}-aggregates-heading`}
      >
        <h4 id={`${view.id}-aggregates-heading`} className={headingClass}>
          Aggregates
        </h4>
        <ol className="mt-3 grid gap-2">
          {view.aggregates.map((aggregate, index) => {
            const fn = aggregate.fn as AggregateFunction;
            const eligibleFields = fields.filter(({ type }) =>
              aggregateFunctions(
                type === "system-multi" ? undefined : type,
              ).includes(fn),
            );
            return (
              <li
                key={index}
                className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
              >
                <label className={labelClass}>
                  Aggregate function {index + 1}
                  <select
                    ref={(element) => {
                      registerFocus(
                        `${viewPath}.aggregates[${index}]`,
                        element,
                      );
                      registerFocus(
                        `${viewPath}.aggregates[${index}].fn`,
                        element,
                      );
                    }}
                    className={controlClass}
                    value={fn}
                    onChange={(event) => {
                      const nextFn = event.target.value as AggregateFunction;
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
                    {(["count", "sum", "avg", "min", "max"] as const).map(
                      (option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                {fn !== "count" ? (
                  <label className={labelClass}>
                    Aggregate field {index + 1}
                    <select
                      ref={(element) =>
                        registerFocus(
                          `${viewPath}.aggregates[${index}].field`,
                          element,
                        )
                      }
                      className={controlClass}
                      value={aggregate.field ?? ""}
                      onChange={(event) =>
                        replaceAggregate(index, {
                          fn,
                          field: event.target.value,
                        })
                      }
                    >
                      {eligibleFields.map(({ key }) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    onChange({
                      ...view,
                      aggregates: view.aggregates.filter(
                        (_, position) => position !== index,
                      ),
                    })
                  }
                >
                  Remove aggregate {index + 1}
                </Button>
              </li>
            );
          })}
        </ol>
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          onPress={() =>
            onChange({
              ...view,
              aggregates: [...view.aggregates, { fn: "count" }],
            })
          }
        >
          Add aggregate
        </Button>
      </section>

      <section
        className="mt-6 border-t border-border pt-4"
        aria-labelledby={`${view.id}-filter-heading`}
      >
        <h4 id={`${view.id}-filter-heading`} className={headingClass}>
          Additional filter
        </h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Additional filter; always ANDed with base membership.
        </p>
        <div className="mt-3">
          <MembershipEditor
            value={view.filter}
            properties={properties}
            onChange={(filter) => onChange({ ...view, filter })}
            registerFocus={(path, element) =>
              registerFocus(`${viewPath}.${path}`, element)
            }
          />
        </div>
      </section>
    </div>
  );
}
