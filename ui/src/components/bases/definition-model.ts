import type {
  Aggregate,
  BaseFile,
  BaseFilter,
  FilterOp,
  PropertyDefinition,
  PropertyType,
  SortKey,
} from "#/api/bases";
import { RELATIVE_DATE_OPERATORS } from "./operator-labels";

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

export type DraftRowTemplate = NonNullable<BaseFile["templates"]>[number] & {
  id: string;
  fields: Record<string, unknown>;
};

export interface BaseDraft {
  name: string;
  description?: string;
  /** `{field}` template proposing a title for new members. */
  titleTemplate?: string;
  hideMemberProperties?: boolean;
  templates?: DraftRowTemplate[];
  filter?: BaseFilter;
  properties: DraftProperty[];
  preview: DraftPreviewField[];
  views: DraftView[];
}

export type AggregateFunction = Aggregate["fn"];

function cloneFilter(filter: BaseFilter | null | undefined) {
  return filter == null ? undefined : structuredClone(filter);
}

function clonePropertyDefinition(definition: PropertyDefinition) {
  return structuredClone(definition);
}

export function fromWire(detail: BaseFile): BaseDraft {
  return {
    name: detail.name,
    description: detail.description ?? undefined,
    titleTemplate: detail.title_template ?? undefined,
    hideMemberProperties: detail.hide_member_properties ?? false,
    ...(detail.templates?.length
      ? {
          templates: detail.templates.map((template) => ({
            ...structuredClone(template),
            fields: structuredClone(template.fields ?? {}),
            id: crypto.randomUUID(),
          })),
        }
      : {}),
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
    ...(draft.hideMemberProperties ? { hide_member_properties: true } : {}),
    ...(draft.templates?.length
      ? {
          templates: draft.templates.map(({ id: _id, ...template }) =>
            structuredClone(template),
          ),
        }
      : {}),
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

const SYSTEM_REFERENCE_FIELDS: Record<string, true> = {
  id: true,
  path: true,
  title: true,
  kind: true,
  project: true,
  tags: true,
  aliases: true,
  created_at: true,
  updated_at: true,
  encryption: true,
  journal_date: true,
  word_count: true,
  body: true,
};

/** Changes schema references only. Existing page values are never migrated. */
export function changePropertyReferences(
  source: BaseDraft,
  propertyId: string,
  nextKey?: string,
): { draft: BaseDraft; changes: string[]; membershipChanged: boolean } {
  const property = source.properties.find(({ id }) => id === propertyId);
  if (!property)
    return { draft: source, changes: [], membershipChanged: false };
  const draft = structuredClone(source);
  const changes = new Set<string>();
  const matches = (field: string) =>
    field.startsWith("prop.")
      ? field.slice(5) === property.key
      : field === property.key &&
        !field.startsWith("sys.") &&
        !Object.hasOwn(SYSTEM_REFERENCE_FIELDS, field);
  const reference = (field: string, location: string): string | undefined => {
    if (!matches(field)) return field;
    changes.add(location);
    return nextKey === undefined
      ? undefined
      : field.startsWith("prop.") ||
          nextKey.startsWith("prop.") ||
          nextKey.startsWith("sys.") ||
          Object.hasOwn(SYSTEM_REFERENCE_FIELDS, nextKey)
        ? `prop.${nextKey}`
        : nextKey;
  };
  const filter = (
    value: BaseFilter | undefined,
    location: string,
  ): BaseFilter | undefined => {
    if (!value) return undefined;
    if ("field" in value) {
      const field = reference(value.field, location);
      return field === undefined ? undefined : { ...value, field };
    }
    if ("not" in value) {
      const child = filter(value.not, location);
      return child ? { not: child } : undefined;
    }
    const original = "all" in value ? value.all : value.any;
    if (original.length === 0) return value;
    const children = original.flatMap((child) => {
      const next = filter(child, location);
      return next ? [next] : [];
    });
    return children.length
      ? "all" in value
        ? { all: children }
        : { any: children }
      : undefined;
  };
  draft.filter = filter(draft.filter, "Base membership filter");
  draft.preview = draft.preview.flatMap((item) => {
    const field = reference(item.field, "Preview fields");
    return field === undefined ? [] : [{ ...item, field }];
  });
  for (const view of draft.views) {
    const location = `View “${view.name}”`;
    view.filter = filter(view.filter, `${location}: filter`);
    view.columns = view.columns.flatMap((field) => {
      const next = reference(field, `${location}: columns`);
      return next === undefined ? [] : [next];
    });
    view.sort = view.sort.flatMap((item) => {
      const field = reference(item.field, `${location}: sort`);
      return field === undefined ? [] : [{ ...item, field }];
    });
    if (view.group_by)
      view.group_by = reference(view.group_by, `${location}: group`);
    view.aggregates = view.aggregates.flatMap((item) => {
      if (!item.field) return [item];
      const field = reference(item.field, `${location}: aggregates`);
      return field === undefined ? [] : [{ ...item, field }];
    });
    view.labels = Object.fromEntries(
      Object.entries(view.labels).flatMap(([key, label]) => {
        const field = reference(key, `${location}: labels`);
        return field === undefined ? [] : [[field, label]];
      }),
    );
  }
  draft.titleTemplate = draft.titleTemplate?.replace(
    /\{([^{}]*)\}/g,
    (placeholder, key: string) => {
      const next = reference(key.trim(), "Title template");
      return next === undefined
        ? ""
        : next === key.trim()
          ? placeholder
          : `{${next}}`;
    },
  );
  if (draft.titleTemplate !== undefined && !draft.titleTemplate.trim())
    draft.titleTemplate = undefined;
  for (const template of draft.templates ?? []) {
    template.fields = Object.fromEntries(
      Object.entries(template.fields).flatMap(([key, value]) => {
        const field = reference(key, `Row template “${template.name}”: fields`);
        return field === undefined ? [] : [[field, value]];
      }),
    );
  }
  draft.properties = draft.properties.flatMap((item) =>
    item.id !== propertyId
      ? [item]
      : nextKey === undefined
        ? []
        : [{ ...item, key: nextKey }],
  );
  return {
    draft,
    changes: [...changes],
    membershipChanged: changes.has("Base membership filter"),
  };
}

export function operatorsFor(
  type: PropertyType | "system-multi" | "system-scalar",
): FilterOp[] {
  switch (type) {
    case "system-multi":
      return ["contains", "not_contains", "in", "is_empty", "not_empty"];
    case "multi_select":
    case "select":
      return [
        "eq",
        "ne",
        "contains",
        "not_contains",
        "in",
        "is_empty",
        "not_empty",
      ];
    case "number":
      return ["eq", "ne", "lt", "lte", "gt", "gte"];
    case "date":
    case "datetime":
      return [
        "eq",
        "ne",
        "lt",
        "lte",
        "gt",
        "gte",
        ...RELATIVE_DATE_OPERATORS,
        "is_empty",
        "not_empty",
      ];
    case "relation":
      return ["eq", "ne", "links_to", "is_empty", "not_empty"];
    case "bool":
      return ["eq", "ne", "in", "is_empty", "not_empty"];
    case "text":
    case "url":
    case "system-scalar":
      return [
        "eq",
        "ne",
        "contains",
        "not_contains",
        "starts_with",
        "ends_with",
        "in",
        "is_empty",
        "not_empty",
      ];
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
  return !(type === "number" || type === "multi_select");
}

export const GROUPABLE_SYSTEM_FIELDS: Record<string, true> = {
  id: true,
  path: true,
  title: true,
  kind: true,
  project: true,
  created_at: true,
  updated_at: true,
  journal_date: true,
  encryption: true,
  word_count: true,
};

const COUNT_FAMILY: readonly AggregateFunction[] = [
  "count",
  "count_filled",
  "count_empty",
  "percent_filled",
  "count_unique",
];
const FOLD_FAMILY: readonly AggregateFunction[] = [
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "range",
];

export function aggregateFunctions(
  type:
    | PropertyType
    | "system-scalar"
    | "system-multi"
    | "word_count"
    | undefined,
): AggregateFunction[] {
  if (type === undefined) return ["count"];
  if (type === "system-multi") return ["count"];
  if (
    type === "number" ||
    type === "date" ||
    type === "datetime" ||
    type === "word_count"
  ) {
    return [...COUNT_FAMILY, ...FOLD_FAMILY];
  }
  return [...COUNT_FAMILY];
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
