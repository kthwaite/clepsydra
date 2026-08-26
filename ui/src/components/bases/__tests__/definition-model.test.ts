import { describe, expect, it } from "vitest";
import type { BaseDetailResponse, BaseFile } from "#/api/bases";
import {
  aggregateFunctions,
  canGroup,
  createMinimalDraft,
  fromWire,
  isValidBaseSlug,
  moveItem,
  operatorsFor,
  slugifyBaseName,
  toWire,
} from "#/components/bases/definition-model";

type BaseDetailFixture = BaseDetailResponse & { revision: string };

function baseDetail(overrides: Partial<BaseFile> = {}): BaseDetailFixture {
  return {
    slug: "books",
    revision: "revision-1",
    diagnostics: [],
    member_creation: [],
    name: "Books",
    description: "Reading tracker",
    properties: [],
    views: [],
    ...overrides,
  };
}

function stripResponseFields(detail: BaseDetailFixture): BaseFile {
  const {
    slug: _slug,
    revision: _revision,
    diagnostics: _diagnostics,
    member_creation: _memberCreation,
    ...file
  } = detail;
  return file;
}

describe("base definition model", () => {
  it("round-trips the complete model while preserving property and view order", () => {
    const detail = baseDetail({
      filter: {
        all: [
          { field: "kind", op: "eq", value: "BOOK" },
          {
            any: [
              { field: "status", op: "eq", value: "reading" },
              { field: "status", op: "eq", value: "queued" },
            ],
          },
        ],
      },
      preview: [
        { field: "body", label: "Excerpt" },
        { field: "sys.title" },
        { field: "prop.title", label: "Custom title" },
      ],
      properties: [
        {
          key: "status",
          definition: {
            type: "select",
            options: ["queued", "reading"],
          },
        },
        { key: "rating", definition: { type: "number" } },
      ],
      views: [
        {
          name: "Reading",
          layout: "table",
          filter: { field: "status", op: "eq", value: "reading" },
          sort: [{ field: "rating", dir: "desc" }],
          group_by: "status",
          aggregates: [{ fn: "count" }, { fn: "avg", field: "rating" }],
          columns: ["title", "status", "rating"],
          labels: {
            body: "Excerpt",
            "prop.title": "Custom title",
          },
        },
        {
          name: "All",
          layout: "table",
          sort: [],
          aggregates: [],
          columns: ["title"],
        },
      ],
    });

    const draft = fromWire(detail);

    expect(draft.properties.map((property) => property.key)).toEqual([
      "status",
      "rating",
    ]);
    expect(draft.preview.map(({ field }) => field)).toEqual([
      "body",
      "sys.title",
      "prop.title",
    ]);
    expect(new Set(draft.preview.map(({ id }) => id)).size).toBe(3);
    expect(draft.views[0].labels).toEqual({
      body: "Excerpt",
      "prop.title": "Custom title",
    });
    expect(draft.views.map((view) => view.name)).toEqual(["Reading", "All"]);
    expect(new Set(draft.properties.map((property) => property.id)).size).toBe(
      2,
    );
    expect(new Set(draft.views.map((view) => view.id)).size).toBe(2);
    expect(toWire(draft)).toEqual(stripResponseFields(detail));
    expect(toWire(draft).properties?.map((property) => property.key)).toEqual([
      "status",
      "rating",
    ]);
  });

  it("round-trips reverse integer-like keys in exact mixed declaration order", () => {
    const detail = baseDetail({
      properties: [
        { key: "2", definition: { type: "number" } },
        { key: "ordinary", definition: { type: "text" } },
        { key: "1", definition: { type: "bool" } },
      ],
    });

    const wire = toWire(fromWire(detail));

    expect(wire.properties).toEqual([
      { key: "2", definition: { type: "number" } },
      { key: "ordinary", definition: { type: "text" } },
      { key: "1", definition: { type: "bool" } },
    ]);
  });

  it("preserves an unsupported wire layout until the user explicitly repairs it", () => {
    const detail = baseDetail({
      views: [
        {
          name: "Board",
          layout: "board",
          columns: ["title"],
        },
      ],
    } as unknown as Partial<BaseFile>);

    const draft = fromWire(detail);

    expect(draft.views[0].layout).toBe("board");
    expect(toWire(draft)).toEqual(
      expect.objectContaining({
        views: [expect.objectContaining({ layout: "board" })],
      }),
    );
  });

  it("materializes wire defaults without mutating the response", () => {
    const detail = baseDetail({
      description: undefined,
      filter: undefined,
      properties: undefined,
      views: [{ name: "Compact" }],
    });

    const draft = fromWire(detail);

    expect(draft).toMatchObject({
      name: "Books",
      properties: [],
      views: [
        {
          name: "Compact",
          layout: "table",
          sort: [],
          aggregates: [],
          columns: [],
        },
      ],
    });
    expect(detail.views).toEqual([{ name: "Compact" }]);
  });

  it("materializes presentation defaults with stable draft references", () => {
    const detail = baseDetail({
      preview: [{ field: "body" }],
      views: [{ name: "Compact" }],
    });

    const draft = fromWire(detail);
    const preview = draft.preview;
    const labels = draft.views[0].labels;

    expect(preview).toEqual([
      expect.objectContaining({ field: "body", id: expect.any(String) }),
    ]);
    expect(labels).toEqual({});
    expect(draft.preview).toBe(preview);
    expect(draft.views[0].labels).toBe(labels);
    expect(detail.preview).toEqual([{ field: "body" }]);
    expect(detail.views).toEqual([{ name: "Compact" }]);
  });

  it("strips presentation row IDs and clones mutable presentation data", () => {
    const detail = baseDetail({
      preview: [{ field: "body", label: "Excerpt" }],
      views: [{ name: "All", labels: { body: "Excerpt" } }],
    });

    const draft = fromWire(detail);
    draft.preview[0].label = "Summary";
    draft.views[0].labels.body = "Summary";
    const wire = toWire(draft);

    expect(detail.preview).toEqual([{ field: "body", label: "Excerpt" }]);
    expect(detail.views?.[0].labels).toEqual({ body: "Excerpt" });
    expect(wire.preview).toEqual([{ field: "body", label: "Summary" }]);
    expect(wire.views?.[0].labels).toEqual({ body: "Summary" });
    expect(wire.preview?.[0]).not.toHaveProperty("id");

    draft.preview[0].label = "Changed again";
    draft.views[0].labels.body = "Changed again";
    expect(wire.preview).toEqual([{ field: "body", label: "Summary" }]);
    expect(wire.views?.[0].labels).toEqual({ body: "Summary" });
  });

  it("creates a valid minimal All view with the supplied membership", () => {
    const filter = { field: "kind", op: "eq", value: "BOOK" } as const;

    expect(createMinimalDraft("Books", "Reading tracker", filter)).toEqual({
      name: "Books",
      description: "Reading tracker",
      filter,
      properties: [],
      preview: [],
      views: [
        expect.objectContaining({
          name: "All",
          layout: "table",
          sort: [],
          aggregates: [],
          labels: {},
          columns: ["title"],
        }),
      ],
    });
  });

  it("offers operators that match field type and cardinality", () => {
    expect(operatorsFor("system-multi")).toEqual([
      "contains",
      "in",
      "is_empty",
      "not_empty",
    ]);
    expect(operatorsFor("system-scalar")).toEqual([
      "eq",
      "ne",
      "contains",
      "in",
      "is_empty",
      "not_empty",
    ]);
    expect(operatorsFor("number")).toEqual([
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
    ]);
    expect(operatorsFor("relation")).toEqual([
      "eq",
      "ne",
      "links_to",
      "is_empty",
      "not_empty",
    ]);
    expect(operatorsFor("select")).toEqual([
      "eq",
      "ne",
      "contains",
      "in",
      "is_empty",
      "not_empty",
    ]);
    expect(operatorsFor("multi_select")).toEqual([
      "eq",
      "ne",
      "contains",
      "in",
      "is_empty",
      "not_empty",
    ]);
    expect(operatorsFor("bool")).toEqual([
      "eq",
      "ne",
      "in",
      "is_empty",
      "not_empty",
    ]);
  });

  it("matches grouping and aggregate capabilities", () => {
    for (const type of [
      "text",
      "bool",
      "date",
      "datetime",
      "select",
      "url",
    ] as const) {
      expect(canGroup(type)).toBe(true);
    }
    for (const type of ["number", "multi_select", "relation"] as const) {
      expect(canGroup(type)).toBe(false);
    }
    expect(canGroup(undefined)).toBe(true);

    const numericFunctions = ["count", "sum", "avg", "min", "max"];
    expect(aggregateFunctions("number")).toEqual(numericFunctions);
    expect(aggregateFunctions("date")).toEqual(numericFunctions);
    expect(aggregateFunctions("datetime")).toEqual(numericFunctions);
    expect(aggregateFunctions("word_count")).toEqual(numericFunctions);
    expect(aggregateFunctions("select")).toEqual(["count"]);
    expect(aggregateFunctions(undefined)).toEqual(["count"]);
  });

  it("moves an item immutably while preserving tuple order", () => {
    const items = ["first", "second", "third"] as const;

    expect(moveItem(items, 0, 2)).toEqual(["second", "third", "first"]);
    expect(items).toEqual(["first", "second", "third"]);
    expect(moveItem(items, 1, 1)).toEqual(items);
    expect(moveItem(items, -1, 2)).toEqual(items);
    expect(moveItem(items, 0, 3)).toEqual(items);
  });

  it("generates and validates deterministic safe base slugs", () => {
    expect(slugifyBaseName("  Reading & Research Log  ")).toBe(
      "reading-research-log",
    );
    expect(slugifyBaseName("Café BOOKS")).toBe("caf-books");
    expect(slugifyBaseName("!!!")).toBe("");
    expect(isValidBaseSlug("reading-log")).toBe(true);
    expect(isValidBaseSlug("reading_log-2")).toBe(true);
    expect(isValidBaseSlug("../reading")).toBe(false);
    expect(isValidBaseSlug(".hidden")).toBe(false);
    expect(isValidBaseSlug("")).toBe(false);
  });
});

describe("title templates", () => {
  it("round-trips a title template through the draft model", () => {
    const draft = fromWire({
      name: "Books",
      title_template: "{author} — {work}",
      properties: [],
      views: [],
    } as never);
    expect(draft.titleTemplate).toBe("{author} — {work}");
    expect(toWire(draft).title_template).toBe("{author} — {work}");
  });

  it("omits an absent template from the wire form", () => {
    const draft = fromWire({ name: "Books", properties: [], views: [] } as never);
    expect(draft.titleTemplate).toBeUndefined();
    expect(toWire(draft)).not.toHaveProperty("title_template");
  });
});
