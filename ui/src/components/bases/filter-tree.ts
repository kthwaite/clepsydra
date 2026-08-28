import type { BaseFilter } from "#/api/bases";

export type FilterPathSegment = "all" | "any" | "not" | number;
export type FilterPath = readonly FilterPathSegment[];
export type FilterWrapKind = "all" | "any" | "not";

export type FilterTreeAction =
  | { type: "replace"; path: FilterPath; value: BaseFilter }
  | { type: "remove"; path: FilterPath }
  | { type: "append"; path: FilterPath; value: BaseFilter }
  | { type: "move"; path: FilterPath; offset: -1 | 1 }
  | { type: "wrap"; path: FilterPath; kind: FilterWrapKind };

interface FilterUpdate {
  value: BaseFilter | undefined;
  move?: -1 | 1;
}

function wrap(kind: FilterWrapKind, value: BaseFilter): BaseFilter {
  if (kind === "all") return { all: [value] };
  if (kind === "any") return { any: [value] };
  return { not: value };
}

function applyAction(
  filter: BaseFilter,
  action: FilterTreeAction,
): FilterUpdate {
  if (action.type === "replace") return { value: action.value };
  if (action.type === "remove") return { value: undefined };
  if (action.type === "wrap") {
    return { value: wrap(action.kind, filter) };
  }
  if (action.type === "move") {
    return { value: filter, move: action.offset };
  }
  if ("all" in filter) {
    return { value: { all: [...filter.all, action.value] } };
  }
  if ("any" in filter) {
    return { value: { any: [...filter.any, action.value] } };
  }
  return { value: filter };
}

function updateFilterAtOffset(
  filter: BaseFilter,
  action: FilterTreeAction,
  offset: number,
): FilterUpdate {
  if (offset === action.path.length) return applyAction(filter, action);

  const branch = action.path[offset];
  if (branch === "not" && "not" in filter) {
    const child = updateFilterAtOffset(filter.not, action, offset + 1);
    if (child.move !== undefined || child.value === filter.not) {
      return { value: filter };
    }
    return {
      value: child.value === undefined ? undefined : { not: child.value },
    };
  }

  if (branch !== "all" && branch !== "any") return { value: filter };
  const children =
    branch === "all"
      ? "all" in filter
        ? filter.all
        : undefined
      : "any" in filter
        ? filter.any
        : undefined;
  if (children === undefined) return { value: filter };

  const childIndex = action.path[offset + 1];
  if (
    typeof childIndex !== "number" ||
    !Number.isInteger(childIndex) ||
    childIndex < 0 ||
    childIndex >= children.length
  ) {
    return { value: filter };
  }

  const child = updateFilterAtOffset(children[childIndex], action, offset + 2);
  if (child.move !== undefined) {
    const destination = childIndex + child.move;
    if (destination < 0 || destination >= children.length) {
      return { value: filter };
    }
    const nextChildren = [...children];
    nextChildren[childIndex] = children[destination];
    nextChildren[destination] = children[childIndex];
    return {
      value: branch === "all" ? { all: nextChildren } : { any: nextChildren },
    };
  }
  if (child.value === children[childIndex]) return { value: filter };

  const nextChildren = [...children];
  if (child.value === undefined) nextChildren.splice(childIndex, 1);
  else nextChildren[childIndex] = child.value;
  return {
    value:
      nextChildren.length === 0
        ? undefined
        : branch === "all"
          ? { all: nextChildren }
          : { any: nextChildren },
  };
}

export function updateFilterTree(
  root: BaseFilter,
  action: FilterTreeAction,
): BaseFilter | undefined {
  const result = updateFilterAtOffset(root, action, 0);
  return result.move === undefined ? result.value : root;
}
