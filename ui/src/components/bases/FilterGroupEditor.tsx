import type { BaseFilter } from "#/api/bases";
import { Button } from "#/components/ui/button";
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

function emptyComparison(): BaseFilter {
  return { field: "kind", op: "eq", value: "" };
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
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              onChange(replaceFilterAtPath(root, childPath, emptyComparison()))
            }
          >
            Replace excluded condition with condition
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              onChange(replaceFilterAtPath(root, childPath, { all: [] }))
            }
          >
            Replace excluded condition with Match all group
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              onChange(replaceFilterAtPath(root, childPath, { any: [] }))
            }
          >
            Replace excluded condition with Match any group
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() =>
              onChange(
                replaceFilterAtPath(root, childPath, {
                  not: emptyComparison(),
                }),
              )
            }
          >
            Replace excluded condition with Not condition
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => onChange(removeFilterAtPath(root, childPath))}
          >
            Remove excluded condition
          </Button>
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
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={index === 0}
                  onPress={() => moveChild(index, index - 1)}
                >
                  Move condition {childPosition} up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={index === children.length - 1}
                  onPress={() => moveChild(index, index + 1)}
                >
                  Move condition {childPosition} down
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    onChange(
                      replaceFilterAtPath(
                        root,
                        childPath,
                        wrappedFilter("all", child),
                      ),
                    )
                  }
                >
                  Convert condition {childPosition} to Match all group
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    onChange(
                      replaceFilterAtPath(
                        root,
                        childPath,
                        wrappedFilter("any", child),
                      ),
                    )
                  }
                >
                  Convert condition {childPosition} to Any group
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    onChange(
                      replaceFilterAtPath(
                        root,
                        childPath,
                        wrappedFilter("not", child),
                      ),
                    )
                  }
                >
                  Convert condition {childPosition} to Not condition
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => onChange(removeFilterAtPath(root, childPath))}
                >
                  Remove condition {childPosition}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          variant="secondary"
          onPress={() => append(emptyComparison())}
        >
          Add condition to {meaning}
        </Button>
        <Button size="sm" variant="ghost" onPress={() => append({ all: [] })}>
          Add Match all group to {meaning}
        </Button>
        <Button size="sm" variant="ghost" onPress={() => append({ any: [] })}>
          Add Match any group to {meaning}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => append({ not: emptyComparison() })}
        >
          Add Not condition to {meaning}
        </Button>
      </div>
    </div>
  );
}
