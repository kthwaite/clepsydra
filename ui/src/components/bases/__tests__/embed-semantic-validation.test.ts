import { describe, expect, it } from "vitest";
import type {
  BaseDetailResponse,
  BaseFilter,
  SortKey,
} from "#/api/bases";
import { validateBaseEmbedSemantics } from "#/components/bases/embed-semantic-validation";

function detail(): BaseDetailResponse {
  return {
    slug: "reading",
    name: "Reading Log",
    properties: {
      kind: { type: "number" },
      rating: { type: "number" },
      shelf: { type: "select", options: ["Now", "Later"] },
      topics: { type: "multi_select" },
      related: { type: "relation" },
    },
    views: [
      {
        name: "All Entries",
        layout: "table",
        columns: ["title"],
      },
    ],
    diagnostics: [],
    member_creation: [],
    revision: "reading-revision",
  };
}

function validate({
  view = "All Entries",
  filter,
  sort,
}: {
  view?: string;
  filter?: BaseFilter;
  sort?: SortKey[];
} = {}) {
  return validateBaseEmbedSemantics(
    {
      base: "reading",
      view,
      ...(filter === undefined ? {} : { filter }),
      ...(sort === undefined ? {} : { sort }),
    },
    detail(),
  );
}

describe("validateBaseEmbedSemantics", () => {
  it("resolves saved views with the server ASCII-case-insensitive contract", () => {
    expect(validate({ view: "aLL eNTRIES" })).toEqual([]);
  });

  it("accepts sys and prop aliases while resolving bare system shadows system-first", () => {
    expect(
      validate({
        filter: {
          all: [
            { field: "sys.kind", op: "contains", value: "NOTE" },
            { field: "prop.rating", op: "gte", value: 4 },
            { field: "kind", op: "eq", value: "NOTE" },
            { field: "prop.kind", op: "gte", value: 1 },
          ],
        },
        sort: [
          { field: "kind", dir: "asc" },
          { field: "prop.kind", dir: "desc" },
          { field: "prop.rating", dir: "asc" },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects unknown explicit system and property aliases", () => {
    const diagnostics = validate({
      filter: {
        all: [
          { field: "sys.rating", op: "eq", value: "5" },
          { field: "prop.missing", op: "eq", value: "x" },
        ],
      },
    });

    expect(diagnostics.map(({ path }) => path)).toEqual([
      "filter.all[0].field",
      "filter.all[1].field",
    ]);
  });

  it.each([
    [
      "operator",
      { field: "rating", op: "contains", value: 4 } as BaseFilter,
      "filter.op",
      /not valid/i,
    ],
    [
      "scalar value",
      { field: "rating", op: "eq", value: "4" } as BaseFilter,
      "filter.value",
      /number/i,
    ],
    [
      "in container",
      { field: "shelf", op: "in", value: "Now" } as BaseFilter,
      "filter.value",
      /array/i,
    ],
    [
      "in member",
      { field: "rating", op: "in", value: [4, "5"] } as BaseFilter,
      "filter.value",
      /number/i,
    ],
    [
      "valueless operator",
      { field: "title", op: "is_empty", value: "x" } as BaseFilter,
      "filter.value",
      /does not accept/i,
    ],
    [
      "relation target",
      { field: "related", op: "links_to", value: 42 } as BaseFilter,
      "filter.value",
      /string/i,
    ],
    [
      "system-first shadow value",
      { field: "kind", op: "eq", value: 1 } as BaseFilter,
      "filter.value",
      /string/i,
    ],
  ])("rejects incompatible %s semantics", (_name, filter, path, message) => {
    const diagnostics = validate({ filter });

    expect(diagnostics).toEqual([
      expect.objectContaining({ path, message: expect.stringMatching(message) }),
    ]);
  });

  it("treats missing valueless values as the server's default null", () => {
    expect(
      validate({ filter: { field: "title", op: "is_empty" } }),
    ).toEqual([]);
  });

  it.each([
    [
      "bare/system aliases",
      [
        { field: "title", dir: "asc" },
        { field: "sys.title", dir: "desc" },
      ] as SortKey[],
    ],
    [
      "bare/property aliases",
      [
        { field: "rating", dir: "asc" },
        { field: "prop.rating", dir: "desc" },
      ] as SortKey[],
    ],
  ])("rejects duplicate resolved sort identities through %s", (_name, sort) => {
    const diagnostics = validate({ sort });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        path: "sort[1].field",
        message: expect.stringMatching(/duplicate canonical sort field/i),
      }),
    ]);
  });

  it.each(["tags", "aliases", "encryption", "topics", "related"])(
    "rejects non-scalar-sortable field %s",
    (field) => {
      expect(validate({ sort: [{ field }] })).toEqual([
        expect.objectContaining({
          path: "sort[0].field",
          message: expect.stringMatching(/not scalar-sortable/i),
        }),
      ]);
    },
  );
});
