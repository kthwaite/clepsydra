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
  layout: "table";
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
      layout: "table",
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
  return {
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
    case "multi_select":
      return ["contains", "in", "is_empty", "not_empty"];
    case "number":
    case "date":
    case "datetime":
      return [
        "eq",
        "ne",
        "lt",
        "lte",
        "gt",
        "gte",
        "in",
        "is_empty",
        "not_empty",
      ];
    case "relation":
      return ["eq", "ne", "links_to", "is_empty", "not_empty"];
    case "bool":
      return ["eq", "ne", "is_empty", "not_empty"];
    case "select":
      return ["eq", "ne", "in", "is_empty", "not_empty"];
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
