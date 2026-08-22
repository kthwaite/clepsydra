import type { BaseFilter, FilterOp } from "#/api/bases";

/** The multi-valued system fields a tag condition can address. Both are
 * membership fields in the query engine, so `contains`/`eq` test one value and
 * `in` tests "any of". */
export const TAG_CONDITION_FIELDS = ["tags", "aliases"] as const;
export type TagConditionField = (typeof TAG_CONDITION_FIELDS)[number];

export type TagQuantifier = "all_of" | "any_of" | "none_of";

/** Which AST shape this condition was read from. Writing back through the same
 * shape keeps a base file byte-stable when the author edits an unrelated part
 * of the definition. Absent on a freshly authored condition, which takes the
 * canonical encoding for its quantifier. */
export type TagConditionEncoding =
  | { kind: "single"; op: Extract<FilterOp, "contains" | "eq"> }
  | { kind: "group"; connective: "all" | "any" }
  | { kind: "in" };

export interface TagCondition {
  field: TagConditionField;
  quantifier: TagQuantifier;
  values: string[];
  encoding?: TagConditionEncoding;
}

const MEMBERSHIP_OPS: ReadonlySet<string> = new Set(["contains", "eq"]);

function isTagField(field: string): field is TagConditionField {
  return (TAG_CONDITION_FIELDS as readonly string[]).includes(field);
}

/** One `field op value` node testing a single membership value. An empty value
 * is only meaningful at the top of a row — a half-authored condition the author
 * has not filled in yet — never as a group child. */
function readMembership(
  filter: BaseFilter,
  allowEmpty = false,
): { field: TagConditionField; op: "contains" | "eq"; value: string } | undefined {
  if (!("field" in filter)) return undefined;
  if (!isTagField(filter.field)) return undefined;
  if (!MEMBERSHIP_OPS.has(filter.op)) return undefined;
  if (typeof filter.value !== "string") return undefined;
  if (filter.value === "" && !allowEmpty) return undefined;
  return {
    field: filter.field,
    op: filter.op as "contains" | "eq",
    value: filter.value,
  };
}

/** An `in` node over a non-empty list of strings on one tag field. */
function readIn(
  filter: BaseFilter,
): { field: TagConditionField; values: string[] } | undefined {
  if (!("field" in filter)) return undefined;
  if (!isTagField(filter.field) || filter.op !== "in") return undefined;
  if (!Array.isArray(filter.value) || filter.value.length === 0) return undefined;
  if (!filter.value.every((item) => typeof item === "string" && item !== "")) {
    return undefined;
  }
  return { field: filter.field, values: [...(filter.value as string[])] };
}

/** An `all`/`any` group whose children are all memberships of one field. */
function readGroup(
  filter: BaseFilter,
): { field: TagConditionField; quantifier: TagQuantifier; values: string[] } | undefined {
  const children = "all" in filter ? filter.all : "any" in filter ? filter.any : undefined;
  if (!children || children.length === 0) return undefined;
  // Arity matters: map would pass the index as `allowEmpty`.
  const memberships = children.map((child) => readMembership(child));
  const [first] = memberships;
  if (!first) return undefined;
  if (!memberships.every((entry) => entry?.field === first.field)) return undefined;
  return {
    field: first.field,
    quantifier: "all" in filter ? "all_of" : "any_of",
    values: memberships.map((entry) => (entry as { value: string }).value),
  };
}

function readPositive(filter: BaseFilter): TagCondition | undefined {
  const single = readMembership(filter, true);
  if (single) {
    return {
      field: single.field,
      quantifier: "all_of",
      values: single.value === "" ? [] : [single.value],
      encoding: { kind: "single", op: single.op },
    };
  }
  const list = readIn(filter);
  if (list) {
    return {
      field: list.field,
      quantifier: "any_of",
      values: list.values,
      encoding: { kind: "in" },
    };
  }
  const group = readGroup(filter);
  if (group) {
    return {
      field: group.field,
      quantifier: group.quantifier,
      values: group.values,
      encoding: {
        kind: "group",
        connective: group.quantifier === "all_of" ? "all" : "any",
      },
    };
  }
  return undefined;
}

/** Recognise a filter subtree as a tag condition, or return undefined so the
 * caller falls back to the general condition editor. */
export function readTagCondition(filter: BaseFilter): TagCondition | undefined {
  if ("not" in filter) {
    const inner = readPositive(filter.not);
    if (!inner) return undefined;
    // "none of a, b" is not(any of a, b). Negating an all-of group means "not
    // both", a predicate this row cannot express, so leave it to the general
    // editor.
    const negatable = inner.quantifier === "any_of" || inner.values.length === 1;
    if (!negatable) return undefined;
    return { ...inner, quantifier: "none_of" };
  }
  return readPositive(filter);
}

function membershipNode(
  field: TagConditionField,
  op: "contains" | "eq",
  value: string,
): BaseFilter {
  return { field, op, value };
}

/** The positive body of a condition: what `none_of` negates. Any-of is that
 * body for none-of, since "none of a, b" is not(any of a, b). */
function writePositive(condition: TagCondition): BaseFilter {
  const { field, values, encoding } = condition;
  const connective = condition.quantifier === "all_of" ? "all" : "any";
  // A row the author has not filled in stays a single empty node: an empty
  // group would be claimed back by the group editor mid-edit, and the
  // validator flags the blank value either way.
  if (values.length === 0) {
    return membershipNode(
      field,
      encoding?.kind === "single" ? encoding.op : "contains",
      "",
    );
  }
  // A single value reads the same under every quantifier, so its node — and
  // whichever operator it was authored with — always survives.
  if (values.length === 1 && encoding?.kind === "single") {
    return membershipNode(field, encoding.op, values[0]);
  }
  if (values.length === 1) return membershipNode(field, "contains", values[0]);
  // Other encodings survive only while they still express the quantifier.
  if (encoding?.kind === "group" && encoding.connective === connective) {
    const children = values.map((value) => membershipNode(field, "contains", value));
    return connective === "all" ? { all: children } : { any: children };
  }
  if (connective === "all") {
    return { all: values.map((value) => membershipNode(field, "contains", value)) };
  }
  return { field, op: "in", value: values };
}

/** Serialize a tag condition into the existing filter AST. */
export function writeTagCondition(condition: TagCondition): BaseFilter {
  const positive = writePositive(condition);
  return condition.quantifier === "none_of" ? { not: positive } : positive;
}
