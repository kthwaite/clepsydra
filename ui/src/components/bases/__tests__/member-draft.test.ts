import { describe, expect, it } from "vitest";
import type {
  BaseDetailResponse,
  BaseMemberCapability,
  PropertyDefinition,
} from "#/api/bases";
import {
  composeMemberDraftFields,
  initialMemberDraft,
} from "#/components/bases/member-draft";

const authorDefinition: PropertyDefinition = { type: "relation" };
const ratingDefinition: PropertyDefinition = { type: "number" };
const statusDefinition: PropertyDefinition = {
  type: "select",
  options: ["reading", "finished"],
};

function makeDefinition(
  overrides: Partial<BaseDetailResponse> = {},
): BaseDetailResponse {
  return {
    name: "Books",
    slug: "books",
    revision: "base-revision",
    diagnostics: [],
    member_creation: [],
    properties: {
      author: authorDefinition,
      rating: ratingDefinition,
      status: statusDefinition,
    },
    views: [
      {
        name: "Continues",
        columns: ["prop.author", "rating", "title", "sys.id"],
      },
    ],
    ...overrides,
  };
}

function makeCapability(
  overrides: Partial<BaseMemberCapability> = {},
): BaseMemberCapability {
  return {
    view: "Continues",
    enabled: true,
    fields: [],
    blockers: [],
    ...overrides,
  };
}

describe("composeMemberDraftFields", () => {
  it("orders title, active columns, then filter-only fields without duplicates", () => {
    const fields = composeMemberDraftFields(
      makeDefinition(),
      "continues",
      makeCapability({
        fields: [
          { field: "sys.kind", membership: true, view: false },
          { field: "prop.status", membership: false, view: true },
          { field: "author", membership: true, view: false },
        ],
      }),
    );

    expect(fields.map((field) => field.key)).toEqual([
      "title",
      "author",
      "rating",
      "kind",
      "status",
    ]);
    expect(fields.find((field) => field.key === "author")).toMatchObject({
      kind: "property",
      definition: authorDefinition,
      membership: true,
      viewOnly: false,
    });
    expect(fields.find((field) => field.key === "status")).toMatchObject({
      membership: false,
      viewOnly: true,
    });
  });

  it("uses capability fields after title when the active view has no columns", () => {
    const fields = composeMemberDraftFields(
      makeDefinition({ views: [{ name: "Inbox" }] }),
      "INBOX",
      makeCapability({
        view: "Inbox",
        fields: [
          { field: "sys.project", membership: true, view: false },
          { field: "prop.status", membership: false, view: true },
        ],
      }),
    );

    expect(fields.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: "title", kind: "title" },
      { key: "project", kind: "project" },
      { key: "status", kind: "property" },
    ]);
  });

  it("normalizes system and property prefixes and omits read-only system fields", () => {
    const fields = composeMemberDraftFields(
      makeDefinition({
        views: [
          {
            name: "Continues",
            columns: [
              "sys.kind",
              "kind",
              "prop.status",
              "status",
              "sys.path",
              "created_at",
            ],
          },
        ],
      }),
      "Continues",
      makeCapability({
        fields: [
          { field: "sys.kind", membership: true, view: false },
          { field: "prop.status", membership: false, view: true },
          { field: "sys.updated_at", membership: false, view: true },
        ],
      }),
    );

    expect(fields.map((field) => field.key)).toEqual(["title", "kind", "status"]);
  });

  it("does not turn undeclared filter keys into controls or consume their diagnostics", () => {
    const capability = makeCapability({
      enabled: false,
      fields: [{ field: "prop.missing", membership: true, view: false }],
      blockers: [
        {
          scope: "field",
          field: "missing",
          filter_path: "filter.eq",
          message: "property is not declared",
        },
      ],
    });
    const before = structuredClone(capability);

    const fields = composeMemberDraftFields(
      makeDefinition({ properties: undefined, views: [{ name: "Continues" }] }),
      "Continues",
      capability,
    );

    expect(fields).toEqual([
      {
        key: "title",
        kind: "title",
        membership: false,
        viewOnly: false,
      },
    ]);
    expect(capability).toEqual(before);
  });

  it("does not mutate generated definition or capability objects", () => {
    const definition = makeDefinition();
    const capability = makeCapability({
      fields: [{ field: "prop.status", membership: false, view: true }],
    });
    const definitionBefore = structuredClone(definition);
    const capabilityBefore = structuredClone(capability);

    composeMemberDraftFields(definition, "Continues", capability);

    expect(definition).toEqual(definitionBefore);
    expect(capability).toEqual(capabilityBefore);
  });
});

describe("initialMemberDraft", () => {
  it("defaults creatable system values without inventing custom values", () => {
    const fields = composeMemberDraftFields(
      makeDefinition({
        views: [
          {
            name: "Continues",
            columns: [
              "sys.kind",
              "sys.project",
              "sys.tags",
              "sys.aliases",
              "prop.status",
            ],
          },
        ],
      }),
      "Continues",
      makeCapability(),
    );

    expect(initialMemberDraft(fields)).toEqual({
      title: "",
      fields: { kind: "NOTE", tags: [], aliases: [] },
    });
  });
});
