import { describe, expect, it } from "vitest";
import type { BaseDetailResponse, BaseViewDefinition } from "#/api/bases";
import {
  applyOverridesToView,
  composeQuickFilters,
  definitionPayload,
  EMPTY_OVERRIDES,
  groupOverrideParam,
  hasOverrides,
  type QuickFilter,
  quickFilterIdentity,
  withGroup,
  withHiddenColumn,
  withoutHiddenColumns,
  withoutQuickFilter,
  withQuickFilter,
} from "#/components/bases/view-overrides";

const reading: QuickFilter = {
  field: "status",
  op: "eq",
  value: "reading",
  label: "status is reading",
};
const today: QuickFilter = {
  field: "due",
  op: "is_today",
  label: "due is today",
};

describe("override state transitions", () => {
  it("adds a quick filter once and removes it by identity", () => {
    const once = withQuickFilter(EMPTY_OVERRIDES, reading);
    const twice = withQuickFilter(once, { ...reading, label: "other label" });
    expect(twice.quickFilters).toHaveLength(1);
    expect(
      withoutQuickFilter(twice, quickFilterIdentity(reading)).quickFilters,
    ).toEqual([]);
  });

  it("tracks group and hidden columns", () => {
    const grouped = withGroup(EMPTY_OVERRIDES, { kind: "by", field: "status" });
    expect(grouped.group).toEqual({ kind: "by", field: "status" });
    expect(withGroup(grouped, undefined).group).toBeUndefined();
    const hidden = withHiddenColumn(
      withHiddenColumn(EMPTY_OVERRIDES, "author"),
      "author",
    );
    expect(hidden.hiddenColumns).toEqual(["author"]);
    expect(withoutHiddenColumns(hidden).hiddenColumns).toEqual([]);
  });

  it("reports overrides including a caller-owned sort", () => {
    expect(hasOverrides(EMPTY_OVERRIDES, undefined)).toBe(false);
    expect(
      hasOverrides(EMPTY_OVERRIDES, [{ field: "author", dir: "asc" }]),
    ).toBe(true);
    expect(
      hasOverrides(withGroup(EMPTY_OVERRIDES, { kind: "flat" }), undefined),
    ).toBe(true);
  });
});

describe("filter composition", () => {
  it("returns the base filter untouched without quick filters", () => {
    const base = { field: "kind", op: "eq", value: "BOOK" } as const;
    expect(composeQuickFilters(base, [])).toEqual(base);
    expect(composeQuickFilters(undefined, [])).toBeUndefined();
  });

  it("sends a lone quick filter bare and conjoins several", () => {
    expect(composeQuickFilters(undefined, [today])).toEqual({
      field: "due",
      op: "is_today",
    });
    expect(composeQuickFilters(undefined, [reading, today])).toEqual({
      all: [
        { field: "status", op: "eq", value: "reading" },
        { field: "due", op: "is_today" },
      ],
    });
  });

  it("flattens into an existing all-group", () => {
    expect(
      composeQuickFilters(
        { all: [{ field: "kind", op: "eq", value: "BOOK" }] },
        [reading],
      ),
    ).toEqual({
      all: [
        { field: "kind", op: "eq", value: "BOOK" },
        { field: "status", op: "eq", value: "reading" },
      ],
    });
  });

  it("maps the group override to the wire sentinel", () => {
    expect(groupOverrideParam(undefined)).toBeUndefined();
    expect(groupOverrideParam({ kind: "flat" })).toBe("");
    expect(groupOverrideParam({ kind: "by", field: "status" })).toBe("status");
  });
});

describe("applyOverridesToView", () => {
  const view: BaseViewDefinition = {
    name: "Continues",
    layout: "table",
    filter: { field: "status", op: "eq", value: "reading" },
    sort: [{ field: "started", dir: "desc" }],
    columns: ["title", "author", "rating"],
  };

  it("leaves the view alone without overrides", () => {
    expect(
      applyOverridesToView(
        view,
        EMPTY_OVERRIDES,
        undefined,
        view.columns ?? [],
      ),
    ).toEqual(view);
  });

  it("conjoins quick filters, applies grouping, sort and hidden columns", () => {
    const state = withHiddenColumn(
      withGroup(withQuickFilter(EMPTY_OVERRIDES, today), {
        kind: "by",
        field: "status",
      }),
      "rating",
    );
    expect(
      applyOverridesToView(
        view,
        state,
        [{ field: "author", dir: "asc" }],
        ["title", "author", "rating"],
      ),
    ).toEqual({
      name: "Continues",
      layout: "table",
      filter: {
        all: [
          { field: "status", op: "eq", value: "reading" },
          { field: "due", op: "is_today" },
        ],
      },
      sort: [{ field: "author", dir: "asc" }],
      group_by: "status",
      columns: ["title", "author"],
    });
  });

  it("removes group_by for a flat override", () => {
    const grouped = { ...view, group_by: "status" };
    const next = applyOverridesToView(
      grouped,
      withGroup(EMPTY_OVERRIDES, { kind: "flat" }),
      undefined,
      [],
    );
    expect("group_by" in next).toBe(false);
  });
});

describe("definitionPayload", () => {
  it("strips response-only fields and swaps the named view", () => {
    const detail: BaseDetailResponse = {
      slug: "reading",
      revision: "r1",
      name: "Reading Log",
      description: "Books",
      properties: [{ key: "status", definition: { type: "select" } }],
      views: [
        { name: "Continues", layout: "table", columns: ["title"] },
        { name: "Shelf", layout: "table", columns: ["title"] },
      ],
      diagnostics: [],
      member_creation: [],
    };
    const payload = definitionPayload(detail, {
      name: "Shelf",
      layout: "table",
      columns: ["title", "status"],
    });
    expect(payload).toEqual({
      name: "Reading Log",
      description: "Books",
      properties: [{ key: "status", definition: { type: "select" } }],
      views: [
        { name: "Continues", layout: "table", columns: ["title"] },
        { name: "Shelf", layout: "table", columns: ["title", "status"] },
      ],
    });
    expect("slug" in payload).toBe(false);
    expect("revision" in payload).toBe(false);
  });
});
