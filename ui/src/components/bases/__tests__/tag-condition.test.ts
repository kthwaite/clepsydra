import { describe, expect, it } from "vitest";
import type { BaseFilter } from "#/api/bases";
import {
  readTagCondition,
  type TagCondition,
  writeTagCondition,
} from "#/components/bases/tag-condition";

const contains = (value: string, field = "tags"): BaseFilter => ({
  field,
  op: "contains",
  value,
});

describe("readTagCondition", () => {
  it("reads a bare membership comparison as one all-of value", () => {
    expect(readTagCondition(contains("beer"))).toEqual({
      field: "tags",
      quantifier: "all_of",
      values: ["beer"],
      encoding: { kind: "single", op: "contains" },
    });
  });

  it("reads a bare eq comparison, which the engine treats as membership", () => {
    expect(
      readTagCondition({ field: "aliases", op: "eq", value: "ale" }),
    ).toEqual({
      field: "aliases",
      quantifier: "all_of",
      values: ["ale"],
      encoding: { kind: "single", op: "eq" },
    });
  });

  it("reads an all group of same-field memberships as all-of", () => {
    expect(
      readTagCondition({ all: [contains("beer"), contains("tasting")] }),
    ).toEqual({
      field: "tags",
      quantifier: "all_of",
      values: ["beer", "tasting"],
      encoding: { kind: "group", connective: "all" },
    });
  });

  it("reads an in comparison as any-of", () => {
    expect(
      readTagCondition({ field: "tags", op: "in", value: ["beer", "wine"] }),
    ).toEqual({
      field: "tags",
      quantifier: "any_of",
      values: ["beer", "wine"],
      encoding: { kind: "in" },
    });
  });

  it("reads an any group of same-field memberships as any-of", () => {
    expect(
      readTagCondition({ any: [contains("beer"), contains("wine")] }),
    ).toEqual({
      field: "tags",
      quantifier: "any_of",
      values: ["beer", "wine"],
      encoding: { kind: "group", connective: "any" },
    });
  });

  it("reads a negated any-of as none-of, keeping the inner encoding", () => {
    expect(
      readTagCondition({
        not: { field: "tags", op: "in", value: ["beer", "wine"] },
      }),
    ).toEqual({
      field: "tags",
      quantifier: "none_of",
      values: ["beer", "wine"],
      encoding: { kind: "in" },
    });
  });

  it("reads a negated single membership as one none-of value", () => {
    expect(readTagCondition({ not: contains("beer") })).toEqual({
      field: "tags",
      quantifier: "none_of",
      values: ["beer"],
      encoding: { kind: "single", op: "contains" },
    });
  });

  it("reads an empty membership comparison as a condition with no values yet", () => {
    expect(
      readTagCondition({ field: "tags", op: "contains", value: "" }),
    ).toEqual({
      field: "tags",
      quantifier: "all_of",
      values: [],
      encoding: { kind: "single", op: "contains" },
    });
  });

  it.each([
    ["a non-membership field", contains("x", "title")],
    [
      "a group with an empty child value",
      { all: [contains("beer"), contains("")] } as BaseFilter,
    ],
    [
      "an unsupported operator",
      { field: "tags", op: "is_empty" } as BaseFilter,
    ],
    [
      "a group mixing fields",
      { all: [contains("beer"), contains("x", "kind")] } as BaseFilter,
    ],
    [
      "a group with a nested group",
      { all: [contains("beer"), { any: [contains("wine")] }] } as BaseFilter,
    ],
    ["an empty group", { all: [] } as BaseFilter],
    [
      "an in comparison whose value is not a string list",
      { field: "tags", op: "in", value: [1, 2] } as BaseFilter,
    ],
    [
      "a doubly negated condition",
      { not: { not: contains("beer") } } as BaseFilter,
    ],
    [
      "a negated all-of group, which means 'not both' rather than 'neither'",
      { not: { all: [contains("beer"), contains("wine")] } } as BaseFilter,
    ],
  ])("does not read %s as a tag condition", (_label, filter) => {
    expect(readTagCondition(filter)).toBeUndefined();
  });
});

describe("writeTagCondition", () => {
  const fresh = (
    quantifier: TagCondition["quantifier"],
    values: string[],
  ): TagCondition => ({ field: "tags", quantifier, values });

  it("writes a single all-of value as a bare membership comparison", () => {
    expect(writeTagCondition(fresh("all_of", ["beer"]))).toEqual(
      contains("beer"),
    );
  });

  it("writes several all-of values as an all group", () => {
    expect(writeTagCondition(fresh("all_of", ["beer", "tasting"]))).toEqual({
      all: [contains("beer"), contains("tasting")],
    });
  });

  it("writes any-of as an in comparison", () => {
    expect(writeTagCondition(fresh("any_of", ["beer", "wine"]))).toEqual({
      field: "tags",
      op: "in",
      value: ["beer", "wine"],
    });
  });

  it("writes none-of as a negated any-of", () => {
    expect(writeTagCondition(fresh("none_of", ["beer", "wine"]))).toEqual({
      not: { field: "tags", op: "in", value: ["beer", "wine"] },
    });
  });

  it("writes a valueless condition as an empty membership node", () => {
    expect(writeTagCondition(fresh("all_of", []))).toEqual({
      field: "tags",
      op: "contains",
      value: "",
    });
    expect(writeTagCondition(fresh("any_of", []))).toEqual({
      field: "tags",
      op: "contains",
      value: "",
    });
    expect(writeTagCondition(fresh("none_of", []))).toEqual({
      not: { field: "tags", op: "contains", value: "" },
    });
  });

  it("round-trips an emptied row without changing its shape", () => {
    const read = readTagCondition({ field: "tags", op: "eq", value: "beer" });
    if (!read) throw new Error("expected a tag condition");
    expect(writeTagCondition({ ...read, values: [] })).toEqual({
      field: "tags",
      op: "eq",
      value: "",
    });
  });

  it("keeps the recognised encoding when the values change", () => {
    const source: BaseFilter = { any: [contains("beer"), contains("wine")] };
    const read = readTagCondition(source);
    if (!read) throw new Error("expected a tag condition");
    expect(writeTagCondition({ ...read, values: ["beer", "cider"] })).toEqual({
      any: [contains("beer"), contains("cider")],
    });
  });

  it("keeps a single comparison's original operator", () => {
    const read = readTagCondition({ field: "tags", op: "eq", value: "beer" });
    if (!read) throw new Error("expected a tag condition");
    expect(writeTagCondition({ ...read, values: ["cider"] })).toEqual({
      field: "tags",
      op: "eq",
      value: "cider",
    });
  });

  it("drops a stale encoding when the quantifier changes", () => {
    const read = readTagCondition({
      all: [contains("beer"), contains("wine")],
    });
    if (!read) throw new Error("expected a tag condition");
    expect(writeTagCondition({ ...read, quantifier: "any_of" })).toEqual({
      field: "tags",
      op: "in",
      value: ["beer", "wine"],
    });
  });

  it("round-trips every canonical encoding unchanged", () => {
    const filters: BaseFilter[] = [
      contains("beer"),
      { all: [contains("beer"), contains("tasting")] },
      { field: "tags", op: "in", value: ["beer", "wine"] },
      { not: { field: "tags", op: "in", value: ["beer", "wine"] } },
      { not: contains("beer") },
      { any: [contains("beer"), contains("wine")] },
    ];
    for (const filter of filters) {
      const read = readTagCondition(filter);
      if (!read)
        throw new Error(`expected a tag condition: ${JSON.stringify(filter)}`);
      expect(writeTagCondition(read)).toEqual(filter);
    }
  });
});
