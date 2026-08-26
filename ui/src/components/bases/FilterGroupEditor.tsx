import type { BaseFilter } from "#/api/bases";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { DraftProperty } from "./definition-model";
import {
  type FilterPath,
  type FilterWrapKind,
  updateFilterTree,
} from "./filter-tree";
import { FilterNodeMenu, FilterSeedMenu } from "./filter-actions";
import { FilterComparisonEditor } from "./FilterComparisonEditor";
import { useIdentifiedRows } from "./ordered-list";
import { readTagCondition } from "./tag-condition";
import { TagConditionEditor } from "./TagConditionEditor";

interface FilterGroupEditorProps {
  value: BaseFilter;
  root: BaseFilter;
  path: FilterPath;
  position: number;
  properties: DraftProperty[];
  onChange(value: BaseFilter | undefined): void;
  registerFocus: RegisterFocusTarget;
  diagnostics?: BaseDiagnostic[];
  diagnosticRoot?: string;
}

export function FilterGroupEditor({
  value,
  root,
  path,
  position,
  properties,
  onChange,
  registerFocus,
  diagnostics = [],
  diagnosticRoot = "filter",
}: FilterGroupEditorProps) {
  const logicalChildren =
    "all" in value ? value.all : "any" in value ? value.any : [];
  const {
    createRow,
    rows: childRows,
    setRows: setChildRows,
  } = useIdentifiedRows(logicalChildren, "filter");
  // A membership predicate over tags or aliases — however it is spelled in the
  // AST — authors as one row rather than a hand-nested group.
  if (readTagCondition(value)) {
    return (
      <TagConditionEditor
        value={value}
        path={path}
        position={position}
        properties={properties}
        onChange={(next) =>
          onChange(
            updateFilterTree(
              root,
              next === undefined
                ? { type: "remove", path }
                : { type: "replace", path, value: next },
            ),
          )
        }
        registerFocus={registerFocus}
        diagnostics={diagnostics}
        diagnosticRoot={diagnosticRoot}
      />
    );
  }

  if ("field" in value) {
    return (
      <FilterComparisonEditor
        value={value}
        path={path}
        position={position}
        properties={properties}
        onChange={(next) =>
          onChange(updateFilterTree(root, { type: "replace", path, value: next }))
        }
        registerFocus={registerFocus}
        diagnostics={diagnostics}
        diagnosticRoot={diagnosticRoot}
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
        <FilterGroupEditor
          value={value.not}
          root={root}
          path={childPath}
          position={1}
          properties={properties}
          onChange={onChange}
          registerFocus={registerFocus}
          diagnostics={diagnostics}
          diagnosticRoot={diagnosticRoot}
        />
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <FilterSeedMenu
            triggerLabel="Excluded condition actions"
            replace
            onSeed={(seed) =>
              onChange(
                updateFilterTree(root, {
                  type: "replace",
                  path: childPath,
                  value: seed,
                }),
              )
            }
            clear={{
              label: "Remove excluded condition",
              onAction: () =>
                onChange(
                  updateFilterTree(root, {
                    type: "remove",
                    path: childPath,
                  }),
                ),
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
    onChange(
      updateFilterTree(root, {
        type: "append",
        path,
        value: child,
      }),
    );
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
    onChange(
      updateFilterTree(root, {
        type: "move",
        path: [...path, kind, childIndex],
        offset: destination < childIndex ? -1 : 1,
      }),
    );
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
              <FilterGroupEditor
                value={child}
                root={root}
                path={childPath}
                position={childPosition}
                properties={properties}
                onChange={onChange}
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
                      current.map((row, position) =>
                        position === index
                          ? { ...row, value: wrapped }
                          : row,
                      ),
                    );
                    onChange(
                      updateFilterTree(root, {
                        type: "wrap",
                        path: childPath,
                        kind,
                      }),
                    );
                  }}
                  onRemove={() => {
                    setChildRows((current) =>
                      current.filter((_, position) => position !== index),
                    );
                    onChange(
                      updateFilterTree(root, {
                        type: "remove",
                        path: childPath,
                      }),
                    );
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        <FilterSeedMenu
          triggerLabel={`Add to ${meaning}`}
          onSeed={append}
        />
      </div>
    </fieldset>
  );
}
