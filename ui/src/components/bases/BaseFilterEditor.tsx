import { useEffect, useRef, useState } from "react";
import type { BaseFilter } from "#/api/bases";
import { Button } from "#/components/ui/button";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { cn } from "#/lib/cn";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
import { FilterComparisonEditor } from "./FilterComparisonEditor";
import {
  emptyComparison,
  FilterNodeMenu,
  FilterSeedMenu,
} from "./filter-actions";
import {
  createFilterDiagnosticScope,
  validateFilterDraft,
} from "./filter-diagnostics";
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
  allowAttendees?: boolean;
}

/** Nested groups alternate tone so each level reads as its own surface
 * without borders: the root group sits on sink, its children on raise. */
function surfaceAt(depth: number) {
  return depth % 2 === 0 ? "bg-sink" : "bg-raise";
}

function depthOf(path: FilterPath) {
  return path.filter((segment) => typeof segment === "string").length;
}

const COMBINATOR_OPTIONS = [
  { id: "all", label: "All" },
  { id: "any", label: "Any" },
] as const;

interface FilterNodeEditorProps {
  value: BaseFilter;
  path: FilterPath;
  position: number;
  properties: DraftProperty[];
  dispatch(action: FilterTreeAction): void;
  registerFocus?: RegisterFocusTarget;
  diagnostics: BaseDiagnostic[];
  diagnosticRoot: string;
  allowAttendees: boolean;
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
  allowAttendees,
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
        allowAttendees={allowAttendees}
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
        allowAttendees={allowAttendees}
        onChange={(next) => dispatch({ type: "replace", path, value: next })}
        diagnosticScope={diagnosticScope}
      />
    );
  }

  if ("not" in value) {
    const childPath: FilterPath = [...path, "not"];
    const depth = depthOf(path);
    return (
      <fieldset
        className={cn("m-0 min-w-0 rounded-xl p-2 sm:p-3", surfaceAt(depth))}
      >
        <legend className="sr-only">Exclude matching condition</legend>
        <p aria-hidden="true" className="mb-3 flex items-center gap-2">
          <span className="rounded-full bg-accent-tint px-2.5 py-0.5 text-[12.5px] font-medium text-accent">
            Not
          </span>
          <span className="text-[13px] text-mute">Exclude pages matching</span>
        </p>
        <FilterNodeEditor
          value={value.not}
          path={childPath}
          position={1}
          properties={properties}
          dispatch={dispatch}
          registerFocus={registerFocus}
          diagnostics={diagnostics}
          diagnosticRoot={diagnosticRoot}
          allowAttendees={allowAttendees}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <FilterNodeMenu
            triggerLabel="Excluded condition actions"
            onWrap={(kind) => dispatch({ type: "wrap", path: childPath, kind })}
            onRemove={() => dispatch({ type: "remove", path: childPath })}
            removeLabel="Remove excluded condition"
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

  const depth = depthOf(path);

  function setCombinator(next: string) {
    if (next === kind) return;
    dispatch({
      type: "replace",
      path,
      value: next === "all" ? { all: children } : { any: children },
    });
  }

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
    <fieldset
      className={cn("m-0 min-w-0 rounded-xl p-2 sm:p-3", surfaceAt(depth))}
    >
      <legend className="sr-only">{label}</legend>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-mute">
        <span aria-hidden="true">Match</span>
        <SegmentedControl
          label="Combine conditions"
          value={kind}
          options={COMBINATOR_OPTIONS}
          onChange={setCombinator}
          optionsClassName={depth % 2 === 0 ? "bg-ground" : undefined}
        />
        <span aria-hidden="true">
          {children.length === 1
            ? "of 1 condition"
            : `of ${children.length} conditions`}
        </span>
      </div>
      <div className="grid gap-2">
        {childRows.map(({ id, value: child }, index) => {
          const childPath: FilterPath = [...path, kind, index];
          const childPosition = index + 1;
          return (
            <div
              key={id}
              className={cn(
                "flex min-w-0 gap-2 rounded-xl",
                "field" in child || readTagCondition(child)
                  ? cn("p-2", surfaceAt(depth + 1))
                  : undefined,
              )}
            >
              <div className="min-w-0 flex-1">
                <FilterNodeEditor
                  value={child}
                  path={childPath}
                  position={childPosition}
                  properties={properties}
                  dispatch={dispatch}
                  registerFocus={registerFocus}
                  diagnostics={diagnostics}
                  diagnosticRoot={diagnosticRoot}
                  allowAttendees={allowAttendees}
                />
              </div>
              <div className="flex shrink-0 items-start gap-1 pt-5">
                <FilterNodeMenu
                  compact
                  triggerLabel={`Condition ${childPosition} actions`}
                  removeLabel={`Remove condition ${childPosition}`}
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
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          ref={(element) =>
            diagnosticScope.registerPath(diagnosticScope.path(), element)
          }
          onPress={() => append(emptyComparison())}
        >
          Add condition
        </Button>
        <FilterSeedMenu
          triggerLabel={`Advanced additions to ${meaning}`}
          triggerText="Add group or tags"
          onSeed={append}
        />
      </div>
      {diagnostics
        .filter((diagnostic) => diagnostic.path === diagnosticScope.path())
        .map((diagnostic) => (
          <p
            key={diagnostic.message}
            role="alert"
            className="mt-2 rounded-lg bg-raise px-2 py-1 text-[12.5px] text-hot"
          >
            {diagnostic.message}
          </p>
        ))}
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
  allowAttendees = true,
}: BaseFilterEditorProps) {
  const [draftValue, setDraftValue] = useState(value);
  const root = useRef<HTMLFieldSetElement>(null);
  const hadFilter = useRef(!!value);
  useEffect(() => {
    if (!hadFilter.current && draftValue) {
      root.current
        ?.querySelector<HTMLElement>('[aria-label="Field for condition 1"]')
        ?.focus();
    }
    hadFilter.current = !!draftValue;
  }, [draftValue]);

  useEffect(() => setDraftValue(value), [value]);
  const localDiagnostics = validateFilterDraft(draftValue, "", diagnosticRoot);
  const combinedDiagnostics = [...diagnostics];
  for (const diagnostic of localDiagnostics) {
    if (
      !combinedDiagnostics.some(
        (existing) =>
          existing.path === diagnostic.path &&
          existing.message === diagnostic.message,
      )
    ) {
      combinedDiagnostics.push(diagnostic);
    }
  }

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
      <fieldset ref={root} className="m-0 min-w-0 p-0">
        <legend className="sr-only">{label}</legend>
        <div className="flex flex-wrap items-center gap-4 rounded-xl bg-sink px-4 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-[14px] font-medium text-ink">All pages</p>
            <p className="text-[12.5px] text-mute">
              Add a condition to limit which pages belong to this base.
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            onPress={() => commit(emptyComparison())}
          >
            Add condition
          </Button>
        </div>
      </fieldset>
    );
  }

  return (
    <fieldset ref={root} className="m-0 min-w-0 p-0">
      <legend className="sr-only">{label}</legend>
      <FilterNodeEditor
        value={draftValue}
        path={[]}
        position={1}
        properties={properties}
        dispatch={dispatch}
        registerFocus={registerFocus}
        diagnostics={combinedDiagnostics}
        diagnosticRoot={diagnosticRoot}
        allowAttendees={allowAttendees}
      />
      <fieldset className="m-0 mt-3 flex min-w-0 flex-wrap gap-2 p-0">
        <legend className="sr-only">Root membership controls</legend>
        {"field" in draftValue ||
        "not" in draftValue ||
        readTagCondition(draftValue) ? (
          <Button
            size="sm"
            variant="secondary"
            onPress={() => commit({ all: [draftValue, emptyComparison()] })}
          >
            Add condition
          </Button>
        ) : null}
        <FilterNodeMenu
          triggerLabel="Membership actions"
          onWrap={(kind) => dispatch({ type: "wrap", path: [], kind })}
          onRemove={() => commit(undefined)}
          removeLabel={
            "field" in draftValue || readTagCondition(draftValue)
              ? "Remove condition 1"
              : "Remove membership filter"
          }
        />
      </fieldset>
    </fieldset>
  );
}
