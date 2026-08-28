import { describe, expect, it } from "vitest";
import type { BaseFilter } from "#/api/bases";
import { updateFilterTree } from "#/components/bases/filter-tree";

describe("filter tree transactions", () => {
  it("replaces a condition below all and not without mutating the source", () => {
    const root = {
      all: [{ not: { field: "kind", op: "eq", value: "NOTE" } }],
    } satisfies BaseFilter;

    const next = updateFilterTree(root, {
      type: "replace",
      path: ["all", 0, "not"],
      value: { field: "kind", op: "eq", value: "PROJECT" },
    });

    expect(next).toEqual({
      all: [{ not: { field: "kind", op: "eq", value: "PROJECT" } }],
    });
    expect(root.all[0]).toEqual({
      not: { field: "kind", op: "eq", value: "NOTE" },
    });
  });

  it("replaces the root filter", () => {
    const root = {
      field: "kind",
      op: "eq",
      value: "NOTE",
    } satisfies BaseFilter;
    const replacement = {
      field: "kind",
      op: "eq",
      value: "PROJECT",
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "replace",
        path: [],
        value: replacement,
      }),
    ).toBe(replacement);
  });

  it("removes a sole child and collapses every empty ancestor", () => {
    const root = {
      all: [{ any: [{ field: "kind", op: "eq", value: "NOTE" }] }],
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "remove",
        path: ["all", 0, "any", 0],
      }),
    ).toBeUndefined();
  });

  it("removes the root filter", () => {
    const root = {
      field: "kind",
      op: "eq",
      value: "NOTE",
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, { type: "remove", path: [] }),
    ).toBeUndefined();
  });

  it("appends a child to all without mutating the source", () => {
    const root = {
      all: [{ field: "kind", op: "eq", value: "NOTE" }],
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "append",
        path: [],
        value: { field: "kind", op: "eq", value: "PROJECT" },
      }),
    ).toEqual({
      all: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "kind", op: "eq", value: "PROJECT" },
      ],
    });
    expect(root).toEqual({
      all: [{ field: "kind", op: "eq", value: "NOTE" }],
    });
  });

  it("appends a child to any without mutating the source", () => {
    const root = {
      any: [{ field: "kind", op: "eq", value: "NOTE" }],
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "append",
        path: [],
        value: { field: "kind", op: "eq", value: "PROJECT" },
      }),
    ).toEqual({
      any: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "kind", op: "eq", value: "PROJECT" },
      ],
    });
    expect(root).toEqual({
      any: [{ field: "kind", op: "eq", value: "NOTE" }],
    });
  });

  it("moves a sibling backward without mutating the source", () => {
    const root = {
      all: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "kind", op: "eq", value: "PROJECT" },
      ],
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "move",
        path: ["all", 1],
        offset: -1,
      }),
    ).toEqual({
      all: [
        { field: "kind", op: "eq", value: "PROJECT" },
        { field: "kind", op: "eq", value: "NOTE" },
      ],
    });
    expect(root.all[0].value).toBe("NOTE");
    expect(root.all[1].value).toBe("PROJECT");
  });

  it("moves a sibling forward without mutating the source", () => {
    const root = {
      any: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "kind", op: "eq", value: "PROJECT" },
      ],
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "move",
        path: ["any", 0],
        offset: 1,
      }),
    ).toEqual({
      any: [
        { field: "kind", op: "eq", value: "PROJECT" },
        { field: "kind", op: "eq", value: "NOTE" },
      ],
    });
    expect(root.any[0].value).toBe("NOTE");
    expect(root.any[1].value).toBe("PROJECT");
  });

  it("returns the same root object for sibling moves beyond either boundary", () => {
    const root = {
      all: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "kind", op: "eq", value: "PROJECT" },
      ],
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, {
        type: "move",
        path: ["all", 0],
        offset: -1,
      }),
    ).toBe(root);
    expect(
      updateFilterTree(root, {
        type: "move",
        path: ["all", 1],
        offset: 1,
      }),
    ).toBe(root);
  });

  it("wraps a filter in all", () => {
    const root = {
      field: "kind",
      op: "eq",
      value: "NOTE",
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, { type: "wrap", path: [], kind: "all" }),
    ).toEqual({ all: [root] });
  });

  it("wraps a filter in any", () => {
    const root = {
      field: "kind",
      op: "eq",
      value: "NOTE",
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, { type: "wrap", path: [], kind: "any" }),
    ).toEqual({ any: [root] });
  });

  it("wraps a filter in not", () => {
    const root = {
      field: "kind",
      op: "eq",
      value: "NOTE",
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, { type: "wrap", path: [], kind: "not" }),
    ).toEqual({ not: root });
  });

  it("returns the same root object for malformed branches and indices", () => {
    const root = {
      all: [{ field: "kind", op: "eq", value: "NOTE" }],
    } satisfies BaseFilter;
    const replacement = {
      field: "kind",
      op: "eq",
      value: "PROJECT",
    } satisfies BaseFilter;

    for (const path of [
      ["any", 0],
      ["all"],
      ["all", -1],
      ["all", 1],
      ["all", 0, "not"],
    ] as const) {
      expect(
        updateFilterTree(root, { type: "replace", path, value: replacement }),
      ).toBe(root);
    }
  });

  it("returns the same root object when append or move targets a non-group", () => {
    const root = {
      not: { field: "kind", op: "eq", value: "NOTE" },
    } satisfies BaseFilter;
    const child = {
      field: "kind",
      op: "eq",
      value: "PROJECT",
    } satisfies BaseFilter;

    expect(
      updateFilterTree(root, { type: "append", path: ["not"], value: child }),
    ).toBe(root);
    expect(
      updateFilterTree(root, { type: "move", path: ["not"], offset: 1 }),
    ).toBe(root);
  });
});
