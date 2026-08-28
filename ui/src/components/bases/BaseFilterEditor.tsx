import { useEffect, useState } from "react";
import type { BaseFilter } from "#/api/bases";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
import { FilterComparisonEditor } from "./FilterComparisonEditor";
import { FilterNodeMenu, FilterSeedMenu } from "./filter-actions";
import { createFilterDiagnosticScope } from "./filter-diagnostics";
import {
  type FilterPath,
  type FilterTreeAction,
  type FilterWrapKind,
  updateFilterTree,
} from "./filter-tree";
import { useIdentifiedRows } from "./ordered-list";
import { TagConditionEditor } from "./TagConditionEditor";
import { readTagCondition } from "./tag-condition";

interface BaseFilterEditorProps {
  value: BaseFilter | undefined;
  properties: DraftProperty[];
  onChange(value: BaseFilter | undefined): void;
  registerFocus?: RegisterFocusTarget;
  label?: string;
  diagnostics?: BaseDiagnostic[];
  diagnosticRoot?: string;
}

interface FilterNodeEditorProps {
  value: BaseFilter;
  path: FilterPath;
  position: number;
  properties: DraftProperty[];
  dispatch(action: FilterTreeAction): void;
  registerFocus?: RegisterFocusTarget;
  diagnostics: BaseDiagnostic[];
  diagnosticRoot: string;
}

function FilterNodeEditor({
  value,
  path,
  position,
  properties,
  dispatch,
  registerFocus,
  diagnostics,
  diagnosticRoot,
}: FilterNodeEditorProps) {
  const logicalChildren =
    "all" in value ? value.all : "any" in value ? value.any : [];
  const {
    createRow,
    rows: childRows,
    setRows: setChildRows,
  } = useIdentifiedRows(logicalChildren, "filter");
  const diagnosticScope = createFilterDiagnosticScope({
    root: diagnosticRoot,
    path,
    diagnostics,
    registerFocus,
  });

  // A membership predicate over tags or aliases — however it is spelled in the
  // AST — authors as one row rather than a hand-nested group.
  if (readTagCondition(value)) {
    return (
      <TagConditionEditor
        value={value}
        position={position}
        properties={properties}
        onChange={(next) =>
          dispatch(
            next === undefined
              ? { type: "remove", path }
              : { type: "replace", path, value: next },
          )
        }
        diagnosticScope={diagnosticScope}
      />
    );
  }

  if ("field" in value) {
    return (
      <FilterComparisonEditor
        value={value}
        position={position}
        properties={properties}
        onChange={(next) => dispatch({ type: "replace", path, value: next })}
        diagnosticScope={diagnosticScope}
      />
    );
  }

  if ("not" in value) {
    const childPath: FilterPath = [...path, "not"];
    return (
      <fieldset className="m-0 min-w-0 border-y-0 border-r-0 border-l-2 border-primary/70 bg-card/40 p-0 pl-3">
        <legend className="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
          <span aria-hidden="true">Not</span>
          <span className="sr-only">Exclude matching condition</span>
        </legend>
        <FilterNodeEditor
          value={value.not}
          path={childPath}
          position={1}
          properties={properties}
          dispatch={dispatch}
          registerFocus={registerFocus}
          diagnostics={diagnostics}
          diagnosticRoot={diagnosticRoot}
        />
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <FilterSeedMenu
            triggerLabel="Excluded condition actions"
            replace
            onSeed={(seed) =>
              dispatch({
                type: "replace",
                path: childPath,
                value: seed,
              })
            }
            clear={{
              label: "Remove excluded condition",
              onAction: () =>
                dispatch({
                  type: "remove",
                  path: childPath,
                }),
            }}
          />
        </div>
      </fieldset>
    );
  }

  const isAll = "all" in value;
  const kind = isAll ? "all" : "any";
  const children = logicalChildren;
  const meaning = kind === "all" ? "Match all" : "Match any";
  const label =
    children.length === 0
      ? `${meaning} conditions`
      : `${meaning} of ${children.length} ${children.length === 1 ? "condition" : "conditions"}`;

  function append(child: BaseFilter) {
    setChildRows((current) => [...current, createRow(child)]);
    dispatch({
      type: "append",
      path,
      value: child,
    });
  }

  function moveChild(childIndex: number, destination: number) {
    if (
      destination < 0 ||
      destination >= children.length ||
      destination === childIndex
    ) {
      return;
    }
    setChildRows((current) => {
      const next = [...current];
      next[childIndex] = current[destination];
      next[destination] = current[childIndex];
      return next;
    });
    dispatch({
      type: "move",
      path: [...path, kind, childIndex],
      offset: destination < childIndex ? -1 : 1,
    });
  }

  return (
    <fieldset className="m-0 min-w-0 border-y-0 border-r-0 border-l-2 border-border bg-card/40 p-0 pl-3">
      <legend className="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        <span aria-hidden="true">{meaning}</span>
        <span className="sr-only">{label}</span>
      </legend>
      <div className="grid gap-4">
        {childRows.map(({ id, value: child }, index) => {
          const childPath: FilterPath = [...path, kind, index];
          const childPosition = index + 1;
          return (
            <div
              key={id}
              className="border-t border-border pt-3 first:border-t-0 first:pt-0"
            >
              <FilterNodeEditor
                value={child}
                path={childPath}
                position={childPosition}
                properties={properties}
                dispatch={dispatch}
                registerFocus={registerFocus}
                diagnostics={diagnostics}
                diagnosticRoot={diagnosticRoot}
              />
              <div className="mt-2 flex flex-wrap gap-1">
                <FilterNodeMenu
                  triggerLabel={`Condition ${childPosition} actions`}
                  ordinal={{
                    position: childPosition,
                    count: children.length,
                  }}
                  onMove={(destination) => moveChild(index, destination)}
                  onWrap={(kind: FilterWrapKind) => {
                    const wrapped = updateFilterTree(child, {
                      type: "wrap",
                      path: [],
                      kind,
                    });
                    if (wrapped === undefined) return;
                    setChildRows((current) =>
                      current.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, value: wrapped } : row,
                      ),
                    );
                    dispatch({
                      type: "wrap",
                      path: childPath,
                      kind,
                    });
                  }}
                  onRemove={() => {
                    setChildRows((current) =>
                      current.filter((_, rowIndex) => rowIndex !== index),
                    );
                    dispatch({
                      type: "remove",
                      path: childPath,
                    });
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        <FilterSeedMenu triggerLabel={`Add to ${meaning}`} onSeed={append} />
      </div>
    </fieldset>
  );
}

export function BaseFilterEditor({
  value,
  properties,
  onChange,
  registerFocus,
  label = "Membership filter",
  diagnostics = [],
  diagnosticRoot = "filter",
}: BaseFilterEditorProps) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => setDraftValue(value), [value]);

  function commit(next: BaseFilter | undefined) {
    setDraftValue(next);
    onChange(next);
  }

  function dispatch(action: FilterTreeAction) {
    if (!draftValue) return;
    const next = updateFilterTree(draftValue, action);
    setDraftValue(next);
    onChange(next);
  }

  if (!draftValue) {
    return (
      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="sr-only">{label}</legend>
        <div className="border-y border-border py-5">
          <p className="text-sm font-medium text-foreground">All pages</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Add a rule to limit which pages belong to this base.
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <FilterSeedMenu
            triggerLabel="Add rule"
            variant="primary"
            onSeed={commit}
          />
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <FilterNodeEditor
        value={draftValue}
        path={[]}
        position={1}
        properties={properties}
        dispatch={dispatch}
        registerFocus={registerFocus}
        diagnostics={diagnostics}
        diagnosticRoot={diagnosticRoot}
      />
      <fieldset className="m-0 mt-4 flex min-w-0 flex-wrap gap-2 border-x-0 border-b-0 border-t border-border p-0 pt-3">
        <legend className="sr-only">Root membership controls</legend>
        <FilterSeedMenu
          triggerLabel="Membership actions"
          replace
          onSeed={commit}
          clear={{
            label: "Clear membership",
            onAction: () => commit(undefined),
          }}
        />
      </fieldset>
    </fieldset>
  );
}
