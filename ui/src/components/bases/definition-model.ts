import type {
  Aggregate,
  BaseFile,
  BaseFilter,
  FilterOp,
  PropertyDefinition,
  PropertyType,
  SortKey,
} from "#/api/bases";

export type { BaseFilter } from "#/api/bases";

export interface DraftProperty {
  id: string;
  key: string;
  definition: PropertyDefinition;
}

type WirePreviewField = NonNullable<BaseFile["preview"]>[number];

export interface DraftPreviewField extends Omit<WirePreviewField, "label"> {
  id: string;
  label?: Exclude<WirePreviewField["label"], null>;
}

export interface DraftView {
  id: string;
  name: string;
  origin?: string;
  layout: string;
  filter?: BaseFilter;
  sort: SortKey[];
  group_by?: string;
  aggregates: Aggregate[];
  labels: NonNullable<NonNullable<BaseFile["views"]>[number]["labels"]>;
  columns: string[];
}

export interface BaseDraft {
  name: string;
  description?: string;
  /** `{field}` template proposing a title for new members. */
  titleTemplate?: string;
  filter?: BaseFilter;
  properties: DraftProperty[];
  preview: DraftPreviewField[];
  views: DraftView[];
}

export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";

function cloneFilter(filter: BaseFilter | null | undefined) {
  return filter == null ? undefined : structuredClone(filter);
}

function clonePropertyDefinition(definition: PropertyDefinition) {
  return {
    ...definition,
    ...(definition.options === undefined
      ? {}
      : { options: [...definition.options] }),
  };
}

export function fromWire(detail: BaseFile): BaseDraft {
  return {
    name: detail.name,
    description: detail.description ?? undefined,
    titleTemplate: detail.title_template ?? undefined,
    filter: cloneFilter(detail.filter),
    preview: (detail.preview ?? []).map((definition) => ({
      id: crypto.randomUUID(),
      field: definition.field,
      ...(definition.label == null ? {} : { label: definition.label }),
    })),
    properties: (detail.properties ?? []).map(({ key, definition }) => ({
      id: crypto.randomUUID(),
      key,
      definition: clonePropertyDefinition(definition),
    })),
    views: (detail.views ?? []).map((view) => ({
      id: crypto.randomUUID(),
      name: view.name,
      origin: view.name,
      layout: view.layout ?? "table",
      filter: cloneFilter(view.filter),
      sort: (view.sort ?? []).map((sort) => ({ ...sort })),
      group_by: view.group_by ?? undefined,
      aggregates: (view.aggregates ?? []).map((aggregate) => ({
        ...aggregate,
      })),
      labels: { ...(view.labels ?? {}) },
      columns: [...(view.columns ?? [])],
    })),
  };
}

export function toWire(draft: BaseDraft): BaseFile {
  const wire = {
    name: draft.name,
    description: draft.description,
    ...(draft.titleTemplate === undefined
      ? {}
      : { title_template: draft.titleTemplate }),
    filter: cloneFilter(draft.filter),
    preview: draft.preview.map(({ field, label }) => ({
      field,
      ...(label === undefined ? {} : { label }),
    })),
    properties: draft.properties.map(({ key, definition }) => ({
      key,
      definition: clonePropertyDefinition(definition),
    })),
    views: draft.views.map((view) => ({
      name: view.name,
      layout: view.layout,
      ...(view.filter === undefined
        ? {}
        : { filter: cloneFilter(view.filter) }),
      sort: view.sort.map((sort) => ({ ...sort })),
      ...(view.group_by === undefined ? {} : { group_by: view.group_by }),
      aggregates: view.aggregates.map((aggregate) => ({ ...aggregate })),
      ...(Object.keys(view.labels).length === 0
        ? {}
        : { labels: { ...view.labels } }),
      columns: [...view.columns],
    })),
  };
  return wire;
}
export function toViewOrigins(draft: BaseDraft) {
  return draft.views.map((view) =>
    view.origin === undefined
      ? ({ kind: "fresh" } as const)
      : ({ kind: "existing", name: view.origin } as const),
  );
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
    preview: [],
    views: [
      {
        id: crypto.randomUUID(),
        name: "All",
        layout: "table",
        sort: [],
        aggregates: [],
        labels: {},
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

export function canSort(
  type: PropertyType | "system-multi" | "word_count" | undefined,
) {
  return (
    type === undefined ||
    type === "word_count" ||
    type === "text" ||
    type === "number" ||
    type === "bool" ||
    type === "date" ||
    type === "datetime" ||
    type === "select" ||
    type === "url"
  );
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
