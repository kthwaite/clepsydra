import type { BaseFilter } from "#/api/bases";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import {
  type DraftProperty,
  type FilterPath,
  removeFilterAtPath,
  replaceFilterAtPath,
} from "./definition-model";
import { FilterNodeMenu, FilterSeedMenu } from "./filter-actions";
import { FilterComparisonEditor } from "./FilterComparisonEditor";
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

function wrappedFilter(
  kind: "all" | "any" | "not",
  child: BaseFilter,
): BaseFilter {
  if (kind === "all") return { all: [child] };
  if (kind === "any") return { any: [child] };
  return { not: child };
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
            next === undefined
              ? removeFilterAtPath(root, path)
              : replaceFilterAtPath(root, path, next),
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
        onChange={(next) => onChange(replaceFilterAtPath(root, path, next))}
        registerFocus={registerFocus}
        diagnostics={diagnostics}
        diagnosticRoot={diagnosticRoot}
      />
    );
  }

  if ("not" in value) {
    const childPath: FilterPath = [...path, "not"];
    return (
      <div
        role="group"
        aria-label="Exclude matching condition"
        className="border-l-2 border-primary/70 bg-card/40 pl-3"
      >
        <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
          Not
        </p>
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
              onChange(replaceFilterAtPath(root, childPath, seed))
            }
            clear={{
              label: "Remove excluded condition",
              onAction: () => onChange(removeFilterAtPath(root, childPath)),
            }}
          />
        </div>
      </div>
    );
  }

  const isAll = "all" in value;
  const kind = isAll ? "all" : "any";
  const children = isAll ? value.all : value.any;
  const meaning = kind === "all" ? "Match all" : "Match any";
  const label =
    children.length === 0
      ? `${meaning} conditions`
      : `${meaning} of ${children.length} ${children.length === 1 ? "condition" : "conditions"}`;

  function append(child: BaseFilter) {
    const next: BaseFilter =
      kind === "all"
        ? { all: [...children, child] }
        : { any: [...children, child] };
    onChange(replaceFilterAtPath(root, path, next));
  }

  function moveChild(childIndex: number, destination: number) {
    const moving = children[childIndex];
    const displaced = children[destination];
    if (!moving || !displaced) return;
    const nextChildren = [...children];
    nextChildren[childIndex] = displaced;
    nextChildren[destination] = moving;
    const next: BaseFilter =
      kind === "all" ? { all: nextChildren } : { any: nextChildren };
    onChange(replaceFilterAtPath(root, path, next));
  }

  return (
    <div
      role="group"
      aria-label={label}
      className="border-l-2 border-border bg-card/40 pl-3"
    >
      <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {meaning}
      </p>
      <div className="grid gap-4">
        {children.map((child, index) => {
          const childPath: FilterPath = [...path, kind, index];
          const childPosition = index + 1;
          return (
            <div
              key={`${kind}-${index}`}
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
                  onWrap={(wrapKind) =>
                    onChange(
                      replaceFilterAtPath(
                        root,
                        childPath,
                        wrappedFilter(wrapKind, child),
                      ),
                    )
                  }
                  onRemove={() => onChange(removeFilterAtPath(root, childPath))}
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
    </div>
  );
}
