import type {
  BaseDetailResponse,
  BaseFilter,
  FilterOp,
  PropertyType,
  SortKey,
} from "#/api/bases";
import { asciiCaseFold } from "./local-validation";

export interface BaseEmbedSemanticConfig {
  base: string;
  view: string;
  filter?: BaseFilter;
  sort?: SortKey[];
}

export interface BaseEmbedSemanticDiagnostic {
  path: string;
  message: string;
}

type SystemField =
  | "id"
  | "path"
  | "title"
  | "kind"
  | "project"
  | "tags"
  | "aliases"
  | "created_at"
  | "updated_at"
  | "encryption"
  | "journal_date"
  | "word_count";

interface ResolvedField {
  identity: string;
  name: string;
  source: "system" | "property";
  type: PropertyType;
  multiValuedSystem: boolean;
}

const SYSTEM_FIELD_TYPES: Readonly<Record<SystemField, PropertyType>> = {
  id: "text",
  path: "text",
  title: "text",
  kind: "text",
  project: "text",
  tags: "text",
  aliases: "text",
  created_at: "text",
  updated_at: "text",
  encryption: "bool",
  journal_date: "date",
  word_count: "number",
};

const ORDERING_OPERATORS: ReadonlySet<FilterOp> = new Set([
  "lt",
  "lte",
  "gt",
  "gte",
]);

const MULTI_SYSTEM_OPERATORS: ReadonlySet<FilterOp> = new Set([
  "eq",
  "ne",
  "contains",
  "in",
  "is_empty",
  "not_empty",
]);

function isSystemField(value: string): value is SystemField {
  return Object.hasOwn(SYSTEM_FIELD_TYPES, value);
}

function systemField(name: SystemField): ResolvedField {
  return {
    identity: `sys:${name}`,
    name,
    source: "system",
    type: SYSTEM_FIELD_TYPES[name],
    multiValuedSystem: name === "tags" || name === "aliases",
  };
}

function propertyField(
  name: string,
  detail: BaseDetailResponse,
): ResolvedField | undefined {
  const definition = detail.properties?.find(
    (property) => property.key === name,
  )?.definition;
  if (!definition) return undefined;
  return {
    identity: `prop:${name}`,
    name,
    source: "property",
    type: definition.type,
    multiValuedSystem: false,
  };
}

function resolveField(
  reference: string,
  detail: BaseDetailResponse,
): { field?: ResolvedField; message?: string } {
  if (reference.startsWith("sys.")) {
    const name = reference.slice(4);
    return isSystemField(name)
      ? { field: systemField(name) }
      : { message: `unknown system field \`${name}\`` };
  }
  if (reference.startsWith("prop.")) {
    const name = reference.slice(5);
    const field = propertyField(name, detail);
    return field
      ? { field }
      : { message: `unknown property field \`${name}\`` };
  }
  if (isSystemField(reference)) return { field: systemField(reference) };
  const field = propertyField(reference, detail);
  return field ? { field } : { message: `unknown field \`${reference}\`` };
}

function supportsContains(type: PropertyType): boolean {
  return type !== "number" && type !== "bool";
}

function isOrdered(type: PropertyType): boolean {
  return type === "number" || type === "date" || type === "datetime";
}

function supportsOperator(field: ResolvedField, op: FilterOp): boolean {
  if (field.multiValuedSystem) return MULTI_SYSTEM_OPERATORS.has(op);
  if (field.source === "system") {
    if (op === "links_to") return false;
    if (op === "contains") return supportsContains(field.type);
    if (ORDERING_OPERATORS.has(op)) return field.type !== "bool";
    return true;
  }
  if (op === "links_to") return field.type === "relation";
  if (op === "contains") return supportsContains(field.type);
  if (ORDERING_OPERATORS.has(op)) return isOrdered(field.type);
  return true;
}

function scalarTypeError(
  type: PropertyType,
  value: unknown,
): string | undefined {
  if (type === "number")
    return typeof value === "number" ? undefined : "expected a number";
  if (type === "bool")
    return typeof value === "boolean" ? undefined : "expected a boolean";
  return typeof value === "string" ? undefined : "expected a string";
}

function validateComparison(
  filter: Extract<BaseFilter, { field: string }>,
  path: string,
  detail: BaseDetailResponse,
): BaseEmbedSemanticDiagnostic[] {
  const resolved = resolveField(filter.field, detail);
  if (!resolved.field) {
    return [
      {
        path: `${path}.field`,
        message: resolved.message ?? `unknown field \`${filter.field}\``,
      },
    ];
  }
  const field = resolved.field;
  if (!supportsOperator(field, filter.op)) {
    return [
      {
        path: `${path}.op`,
        message: `op \`${filter.op}\` is not valid for field \`${field.name}\``,
      },
    ];
  }

  if (filter.op === "is_empty" || filter.op === "not_empty") {
    return filter.value == null
      ? []
      : [
          {
            path: `${path}.value`,
            message: `op \`${filter.op}\` does not accept a value`,
          },
        ];
  }
  if (filter.op === "links_to") {
    return typeof filter.value === "string"
      ? []
      : [
          {
            path: `${path}.value`,
            message: "op `links_to` expects a string target",
          },
        ];
  }
  if (filter.op === "in") {
    if (!Array.isArray(filter.value)) {
      return [
        {
          path: `${path}.value`,
          message: "op `in` expects an array",
        },
      ];
    }
    return filter.value.flatMap((value) => {
      const reason = scalarTypeError(field.type, value);
      return reason
        ? [
            {
              path: `${path}.value`,
              message: `invalid value for field \`${field.name}\`: ${reason}`,
            },
          ]
        : [];
    });
  }

  const reason = scalarTypeError(field.type, filter.value);
  return reason
    ? [
        {
          path: `${path}.value`,
          message: `invalid value for field \`${field.name}\`: ${reason}`,
        },
      ]
    : [];
}

function validateFilter(
  filter: BaseFilter,
  path: string,
  detail: BaseDetailResponse,
): BaseEmbedSemanticDiagnostic[] {
  if ("all" in filter) {
    return filter.all.flatMap((child, index) =>
      validateFilter(child, `${path}.all[${index}]`, detail),
    );
  }
  if ("any" in filter) {
    return filter.any.flatMap((child, index) =>
      validateFilter(child, `${path}.any[${index}]`, detail),
    );
  }
  if ("not" in filter) return validateFilter(filter.not, `${path}.not`, detail);
  return validateComparison(filter, path, detail);
}

function isScalarSortable(field: ResolvedField): boolean {
  if (field.source === "system") {
    return !field.multiValuedSystem && field.name !== "encryption";
  }
  return field.type !== "multi_select" && field.type !== "relation";
}

function validateSort(
  sort: readonly SortKey[],
  detail: BaseDetailResponse,
): BaseEmbedSemanticDiagnostic[] {
  const diagnostics: BaseEmbedSemanticDiagnostic[] = [];
  const seen = new Set<string>();
  sort.forEach((sortKey, index) => {
    const path = `sort[${index}].field`;
    const resolved = resolveField(sortKey.field, detail);
    if (!resolved.field) {
      diagnostics.push({
        path,
        message: resolved.message ?? `unknown field \`${sortKey.field}\``,
      });
      return;
    }
    const field = resolved.field;
    if (seen.has(field.identity)) {
      diagnostics.push({
        path,
        message: `duplicate canonical sort field \`${field.name}\``,
      });
      return;
    }
    seen.add(field.identity);
    if (!isScalarSortable(field)) {
      diagnostics.push({
        path,
        message: `${field.source} field \`${field.name}\` is not scalar-sortable`,
      });
    }
  });
  return diagnostics;
}

export function validateBaseEmbedSemantics(
  config: BaseEmbedSemanticConfig,
  detail: BaseDetailResponse,
): BaseEmbedSemanticDiagnostic[] {
  const diagnostics: BaseEmbedSemanticDiagnostic[] = [];
  const view = (detail.views ?? []).find(
    ({ name }) => asciiCaseFold(name) === asciiCaseFold(config.view),
  );
  if (!view) {
    diagnostics.push({
      path: "view",
      message: `Saved view “${config.view}” was not found in ${detail.name}.`,
    });
  }
  if (config.filter) {
    diagnostics.push(...validateFilter(config.filter, "filter", detail));
  }
  if (config.sort) diagnostics.push(...validateSort(config.sort, detail));
  return diagnostics;
}
