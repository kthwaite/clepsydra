import type { FilterOp, PropertyDefinition, PropertyType } from "#/api/bases";
import type { CellValue } from "./cells/types";
import { OPERATOR_LABELS } from "./operator-labels";
import type { QuickFilter } from "./view-overrides";
import { wikilinkTarget } from "./wikilink-target";

export type QuickFilterType = PropertyType | "system-scalar" | "system-multi";

/** The filterable type of a rendered column, or undefined for columns that
 * take no quick filter (title, path, id, body, word_count, undeclared). */
export function quickFilterType(
  column: string,
  definition: PropertyDefinition | undefined,
): QuickFilterType | undefined {
  if (definition) return definition.type;
  switch (column) {
    case "kind":
    case "project":
      return "system-scalar";
    case "tags":
    case "aliases":
      return "system-multi";
    case "created_at":
    case "updated_at":
      return "datetime";
    case "journal_date":
      return "date";
    default:
      return undefined;
  }
}

export function isDateLike(type: QuickFilterType | undefined): boolean {
  return type === "date" || type === "datetime";
}

function isEmptyValue(value: CellValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function emptiness(
  field: string,
  label: string,
  op: "is_empty" | "not_empty",
): QuickFilter {
  return { field, op, label: `${label} ${OPERATOR_LABELS[op]}` };
}

function checked(field: string, label: string, value: boolean): QuickFilter {
  return {
    field,
    op: "eq",
    value,
    label: `${label} is ${value ? "checked" : "unchecked"}`,
  };
}

function membership(
  field: string,
  label: string,
  op: "contains" | "links_to",
  value: unknown,
): QuickFilter {
  const verb = op === "contains" ? "has" : OPERATOR_LABELS.links_to;
  return { field, op, value, label: `${label} ${verb} ${String(value)}` };
}

/** The value-derived filters for one cell (spec table "Quick-filter derivation"). */
export function quickFiltersForCell(
  field: string,
  type: QuickFilterType,
  value: CellValue | undefined,
  label: string,
): QuickFilter[] {
  if (isEmptyValue(value)) return [emptiness(field, label, "is_empty")];
  switch (type) {
    case "bool":
      return typeof value === "boolean" ? [checked(field, label, value)] : [];
    case "select":
    case "number":
    case "system-scalar":
      return Array.isArray(value) || typeof value === "object"
        ? []
        : [{ field, op: "eq", value, label: `${label} is ${String(value)}` }];
    case "text":
    case "url":
      return typeof value === "string"
        ? [{ field, op: "eq", value, label: `${label} is "${value}"` }]
        : [];
    case "multi_select":
    case "system-multi":
      return Array.isArray(value)
        ? value.map((element) => membership(field, label, "contains", element))
        : [];
    case "relation":
      // The stored value is a wikilink; `links_to` matches the bare target.
      return Array.isArray(value)
        ? value.flatMap((element) => {
            const target = wikilinkTarget(element);
            return target === ""
              ? []
              : [membership(field, label, "links_to", target)];
          })
        : [];
    case "date": {
      if (typeof value !== "string") return [];
      const face = value.slice(0, 10);
      return [{ field, op: "eq", value: face, label: `${label} is ${face}` }];
    }
    case "datetime":
      return [];
  }
}

export const DATE_PRESETS: readonly { op: FilterOp; label: string }[] = [
  { op: "is_today", label: "Today" },
  { op: "is_this_week", label: "This week" },
  { op: "is_past_week", label: "Past week" },
  { op: "is_next_week", label: "Next week" },
  { op: "is_this_month", label: "This month" },
];

export function datePresetFilter(
  field: string,
  label: string,
  op: FilterOp,
): QuickFilter {
  return { field, op, label: `${label} ${OPERATOR_LABELS[op]}` };
}

export const HEADER_OPTION_CAP = 12;

/** How many of a column's options the header submenu leaves out. */
export function headerOptionOverflow(
  definition: PropertyDefinition | undefined,
): number {
  return Math.max(0, (definition?.options?.length ?? 0) - HEADER_OPTION_CAP);
}

/** The header menu's Filter ▸ presets (spec "headerFilterPresets"). */
export function headerFilterPresets(
  field: string,
  type: QuickFilterType | undefined,
  definition: PropertyDefinition | undefined,
  label: string,
): QuickFilter[] {
  if (type === undefined) return [];
  const presets: QuickFilter[] = [];
  if (type === "bool") {
    presets.push(checked(field, label, true), checked(field, label, false));
  }
  if (isDateLike(type)) {
    for (const preset of DATE_PRESETS)
      presets.push(datePresetFilter(field, label, preset.op));
  }
  if (type === "select" || type === "multi_select") {
    const options = (definition?.options ?? []).slice(0, HEADER_OPTION_CAP);
    for (const option of options) {
      presets.push(
        type === "select"
          ? { field, op: "eq", value: option, label: `${label} is ${option}` }
          : membership(field, label, "contains", option),
      );
    }
  }
  presets.push(
    emptiness(field, label, "is_empty"),
    emptiness(field, label, "not_empty"),
  );
  return presets;
}
