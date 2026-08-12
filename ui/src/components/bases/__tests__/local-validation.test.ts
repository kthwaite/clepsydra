import { describe, expect, it } from "vitest";
import type { BaseDraft } from "#/components/bases/definition-model";
import { validateBaseDraftStructure } from "#/components/bases/local-validation";

function draft(overrides: Partial<BaseDraft> = {}): BaseDraft {
  return {
    name: "Reading Log",
    properties: [],
    views: [
      {
        id: "all",
        name: "All",
        layout: "table",
        sort: [],
        aggregates: [],
        columns: ["title"],
      },
    ],
    ...overrides,
  };
}

describe("validateBaseDraftStructure", () => {
  it("reports exact paths for empty base and view names", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        name: "  ",
        views: [
          {
            ...draft().views[0],
            name: "\t",
          },
        ],
      }),
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", path: "name" }),
        expect.objectContaining({ severity: "error", path: "views[0].name" }),
      ]),
    );
  });

  it("reports every ASCII-case-insensitive duplicate view name", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        views: [
          { ...draft().views[0], id: "one", name: "All" },
          { ...draft().views[0], id: "two", name: "aLL" },
        ],
      }),
    );

    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      "views[0].name",
      "views[1].name",
    ]);
  });

  it("reports unsupported layouts at the exact layout control", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        views: [
          {
            ...draft().views[0],
            layout: "board",
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        path: "views[0].layout",
      }),
    ]);
  });
  it.each(["multi_select", "relation"] as const)(
    "reports an unsupported %s sort at the exact field path",
    (type) => {
      const diagnostics = validateBaseDraftStructure(
        "reading-log",
        draft({
          properties: [
            {
              id: "status",
              key: "status",
              definition: { type },
            },
          ],
          views: [
            {
              ...draft().views[0],
              sort: [{ field: "status", dir: "asc" }],
            },
          ],
        }),
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          severity: "error",
          path: "views[0].sort[0].field",
          message: expect.stringContaining("status"),
        }),
      ]);
    },
  );
});
