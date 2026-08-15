import { describe, expect, it } from "vitest";
import type { BaseDraft } from "#/components/bases/definition-model";
import {
  presentationFieldIdentity,
  validateBaseDraftStructure,
} from "#/components/bases/local-validation";

function draft(overrides: Partial<BaseDraft> = {}): BaseDraft {
  return {
    name: "Reading Log",
    properties: [],
    preview: [],
    views: [
      {
        id: "all",
        name: "All",
        layout: "table",
        sort: [],
        aggregates: [],
        labels: {},
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

  it("reports empty presentation labels at exact editor paths", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        preview: [{ id: "preview-body", field: "body", label: "  " }],
        views: [
          {
            ...draft().views[0],
            labels: { body: "\t" },
          },
        ],
      }),
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          path: "preview[0].label",
        }),
        expect.objectContaining({
          severity: "error",
          path: "views[0].labels.body",
        }),
      ]),
    );
  });

  it("reports duplicate canonical preview identities at the repeated field", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        properties: [
          {
            id: "title-property",
            key: "title",
            definition: { type: "text" },
          },
        ],
        preview: [
          { id: "title", field: "title" },
          { id: "system-title", field: "sys.title" },
          { id: "property-title", field: "prop.title" },
          { id: "body", field: "body" },
          { id: "qualified-body", field: "sys.body" },
        ],
      }),
    );

    expect(
      diagnostics
        .filter((diagnostic) => diagnostic.message.includes("Duplicate"))
        .map((diagnostic) => diagnostic.path),
    ).toEqual(["preview[1].field", "preview[4].field"]);
  });

  it("warns for unknown presentation references at exact paths", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        preview: [
          { id: "missing", field: "missing" },
          { id: "missing-system", field: "sys.also_missing" },
        ],
        views: [
          {
            ...draft().views[0],
            labels: {
              missing: "Missing",
              "sys.also_missing": "Missing system",
            },
          },
        ],
      }),
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          path: "preview[0].field",
        }),
        expect.objectContaining({
          severity: "warning",
          path: "preview[1].field",
        }),
        expect.objectContaining({
          severity: "warning",
          path: "views[0].labels.missing",
        }),
        expect.objectContaining({
          severity: "warning",
          path: "views[0].labels.sys.also_missing",
        }),
      ]),
    );
  });

  it("resolves bare sys grammar and explicitly qualified sys-prefixed properties", () => {
    expect(presentationFieldIdentity("sys.title")).toBe("system:title");
    expect(presentationFieldIdentity("sys.custom")).toBeUndefined();
    expect(presentationFieldIdentity("prop.sys.title")).toBe(
      "property:sys.title",
    );
    expect(presentationFieldIdentity("prop.sys.custom")).toBe(
      "property:sys.custom",
    );
  });

  it("accepts body and qualified shadow presentation references", () => {
    const diagnostics = validateBaseDraftStructure(
      "reading-log",
      draft({
        properties: [
          {
            id: "title-property",
            key: "title",
            definition: { type: "text" },
          },
          {
            id: "prefixed-property",
            key: "prop.title",
            definition: { type: "text" },
          },
          {
            id: "system-prefixed-title-property",
            key: "sys.title",
            definition: { type: "text" },
          },
          {
            id: "system-prefixed-custom-property",
            key: "sys.custom",
            definition: { type: "text" },
          },
        ],
        preview: [
          { id: "body", field: "body" },
          { id: "system-title", field: "sys.title" },
          { id: "property-title", field: "prop.title" },
          { id: "prefixed-property", field: "prop.prop.title" },
          { id: "system-prefixed-title", field: "prop.sys.title" },
          { id: "system-prefixed-custom", field: "prop.sys.custom" },
        ],
        views: [
          {
            ...draft().views[0],
            labels: {
              body: "Excerpt",
              "sys.title": "System title",
              "prop.title": "Custom title",
              "prop.prop.title": "Prefixed title",
              "prop.sys.title": "Custom system-like title",
              "prop.sys.custom": "Custom system-like field",
            },
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([]);
  });
});
