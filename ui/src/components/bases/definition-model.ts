import type {
  Aggregate,
  BaseDetailResponse,
  BaseFile,
  BaseFilter,
  FilterOp,
  PropertyDefinition,
  PropertyType,
  SortKey,
} from "#/api/bases";

export type { BaseFilter, FilterOp } from "#/api/bases";

export interface DraftProperty {
  id: string;
  key: string;
  definition: PropertyDefinition;
}

export interface DraftView {
  id: string;
  name: string;
  layout: string;
  filter?: BaseFilter;
  sort: SortKey[];
  group_by?: string;
  aggregates: Aggregate[];
  columns: string[];
}

export interface BaseDraft {
  name: string;
  description?: string;
  filter?: BaseFilter;
  properties: DraftProperty[];
  views: DraftView[];
}

export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";

export type FilterPathSegment = "all" | "any" | "not" | number;
export type FilterPath = readonly FilterPathSegment[];

function replaceFilterAtOffset(
  filter: BaseFilter,
  path: FilterPath,
  offset: number,
  replacement: BaseFilter,
): BaseFilter {
  if (offset === path.length) return replacement;
  const branch = path[offset];
  if (branch === "not" && "not" in filter) {
    return {
      not: replaceFilterAtOffset(filter.not, path, offset + 1, replacement),
    };
  }
  const childIndex = path[offset + 1];
  if (typeof childIndex !== "number") return filter;
  if (branch === "all" && "all" in filter) {
    if (childIndex < 0 || childIndex >= filter.all.length) return filter;
    return {
      all: filter.all.map((child, index) =>
        index === childIndex
          ? replaceFilterAtOffset(child, path, offset + 2, replacement)
          : child,
      ),
    };
  }
  if (branch === "any" && "any" in filter) {
    if (childIndex < 0 || childIndex >= filter.any.length) return filter;
    return {
      any: filter.any.map((child, index) =>
        index === childIndex
          ? replaceFilterAtOffset(child, path, offset + 2, replacement)
          : child,
      ),
    };
  }
  return filter;
}

export function replaceFilterAtPath(
  filter: BaseFilter,
  path: FilterPath,
  replacement: BaseFilter,
): BaseFilter {
  return replaceFilterAtOffset(filter, path, 0, replacement);
}

function removeFilterChild(
  children: BaseFilter[],
  childIndex: number,
  path: FilterPath,
  offset: number,
): BaseFilter[] | undefined {
  if (childIndex < 0 || childIndex >= children.length) return children;
  const child = removeFilterAtOffset(children[childIndex], path, offset + 2);
  const nextChildren = [...children];
  if (child) nextChildren[childIndex] = child;
  else nextChildren.splice(childIndex, 1);
  return nextChildren.length > 0 ? nextChildren : undefined;
}

function removeFilterAtOffset(
  filter: BaseFilter,
  path: FilterPath,
  offset: number,
): BaseFilter | undefined {
  if (offset === path.length) return undefined;
  const branch = path[offset];
  if (branch === "not" && "not" in filter) {
    const child = removeFilterAtOffset(filter.not, path, offset + 1);
    return child ? { not: child } : undefined;
  }
  const childIndex = path[offset + 1];
  if (typeof childIndex !== "number") return filter;
  if (branch === "all" && "all" in filter) {
    const children = removeFilterChild(filter.all, childIndex, path, offset);
    return children ? { all: children } : undefined;
  }
  if (branch === "any" && "any" in filter) {
    const children = removeFilterChild(filter.any, childIndex, path, offset);
    return children ? { any: children } : undefined;
  }
  return filter;
}

export function removeFilterAtPath(
  filter: BaseFilter,
  path: FilterPath,
): BaseFilter | undefined {
  return removeFilterAtOffset(filter, path, 0);
}

function cloneFilter(filter: BaseFilter | null | undefined) {
  return filter == null ? undefined : structuredClone(filter);
}

function clonePropertyDefinition(definition: PropertyDefinition) {
  return {
    ...definition,
    options: definition.options ? [...definition.options] : undefined,
  };
}

export function fromWire(detail: BaseDetailResponse): BaseDraft {
  return {
    name: detail.name,
    description: detail.description ?? undefined,
    filter: cloneFilter(detail.filter),
    properties: Object.entries(detail.properties ?? {}).map(
      ([key, definition]) => ({
        id: crypto.randomUUID(),
        key,
        definition: clonePropertyDefinition(definition),
      }),
    ),
    views: (detail.views ?? []).map((view) => ({
      id: crypto.randomUUID(),
      name: view.name,
      layout: view.layout ?? "table",
      filter: cloneFilter(view.filter),
      sort: (view.sort ?? []).map((sort) => ({ ...sort })),
      group_by: view.group_by ?? undefined,
      aggregates: (view.aggregates ?? []).map((aggregate) => ({
        ...aggregate,
      })),
      columns: [...(view.columns ?? [])],
    })),
  };
}

export function toWire(draft: BaseDraft): BaseFile {
  const wire = {
    name: draft.name,
    description: draft.description,
    filter: cloneFilter(draft.filter),
    properties: Object.fromEntries(
      draft.properties.map(({ key, definition }) => [
        key,
        clonePropertyDefinition(definition),
      ]),
    ),
    views: draft.views.map((view) => ({
      name: view.name,
      layout: view.layout,
      filter: cloneFilter(view.filter),
      sort: view.sort.map((sort) => ({ ...sort })),
      group_by: view.group_by,
      aggregates: view.aggregates.map((aggregate) => ({ ...aggregate })),
      columns: [...view.columns],
    })),
  };
  return wire;
}

export function createMinimalDraft(
  name: string,
  description?: string,
  filter?: BaseFilter,
): BaseDraft {
  return {
    name,
    description,
    filter: cloneFilter(filter),
    properties: [],
    views: [
      {
        id: crypto.randomUUID(),
        name: "All",
        layout: "table",
        sort: [],
        aggregates: [],
        columns: ["title"],
      },
    ],
  };
}

export function operatorsFor(
  type: PropertyType | "system-multi" | "system-scalar",
): FilterOp[] {
  switch (type) {
    case "system-multi":
      return ["contains", "in", "is_empty", "not_empty"];
    case "multi_select":
      return ["eq", "ne", "contains", "in", "is_empty", "not_empty"];
    case "number":
    case "date":
    case "datetime":
      return ["eq", "ne", "lt", "lte", "gt", "gte"];
    case "relation":
      return ["eq", "ne", "links_to", "is_empty", "not_empty"];
    case "bool":
      return ["eq", "ne", "in", "is_empty", "not_empty"];
    case "select":
      return ["eq", "ne", "contains", "in", "is_empty", "not_empty"];
    case "text":
    case "url":
    case "system-scalar":
      return ["eq", "ne", "contains", "in", "is_empty", "not_empty"];
  }
}

export function canGroup(type: PropertyType | undefined) {
  return !(type === "number" || type === "multi_select" || type === "relation");
}

export function aggregateFunctions(
  type: PropertyType | "word_count" | undefined,
): AggregateFunction[] {
  if (
    type === "number" ||
    type === "date" ||
    type === "datetime" ||
    type === "word_count"
  ) {
    return ["count", "sum", "avg", "min", "max"];
  }
  return ["count"];
}

export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const result = [...items];
  if (
    from < 0 ||
    from >= result.length ||
    to < 0 ||
    to >= result.length ||
    from === to
  ) {
    return result;
  }
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

export function slugifyBaseName(name: string) {
  let slug = "";
  let pendingHyphen = false;

  for (const character of name.normalize("NFC").toLowerCase()) {
    if (/^[a-z0-9]$/.test(character)) {
      if (pendingHyphen && slug.length > 0) slug += "-";
      slug += character;
      pendingHyphen = false;
    } else {
      pendingHyphen = slug.length > 0;
    }
  }

  return slug;
}

export function isValidBaseSlug(slug: string) {
  return (
    slug.length > 0 && !slug.startsWith(".") && /^[A-Za-z0-9_-]+$/.test(slug)
  );
}
