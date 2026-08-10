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
          { field: "kind", membership: true, view: false, embed: false },
          { field: "status", membership: false, view: true, embed: false },
          { field: "status", membership: false, view: false, embed: true },
          { field: "author", membership: true, view: false, embed: false },
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
      embedOnly: false,
    });
    expect(fields.find((field) => field.key === "status")).toMatchObject({
      membership: false,
      viewOnly: true,
      embedOnly: true,
    });
  });

  it("uses capability fields after title when the active view has no columns", () => {
    const fields = composeMemberDraftFields(
      makeDefinition({ views: [{ name: "Inbox" }] }),
      "INBOX",
      makeCapability({
        view: "Inbox",
        fields: [
          { field: "project", membership: true, view: false, embed: false },
          { field: "status", membership: false, view: true, embed: false },
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
          { field: "kind", membership: true, view: false, embed: false },
          { field: "status", membership: false, view: true, embed: false },
          {
            field: "updated_at",
            membership: false,
            view: true,
            embed: false,
          },
        ],
      }),
    );

    expect(fields.map((field) => field.key)).toEqual(["title", "kind", "status"]);
  });

  it("preserves canonical property namespaces when custom fields shadow system and derived fields", () => {
    const customKind: PropertyDefinition = { type: "text" };
    const customWordCount: PropertyDefinition = { type: "number" };
    const customJournalDate: PropertyDefinition = { type: "date" };
    const fields = composeMemberDraftFields(
      makeDefinition({
        properties: {
          kind: customKind,
          word_count: customWordCount,
          journal_date: customJournalDate,
        },
        views: [
          {
            name: "Continues",
            columns: [
              "kind",
              "prop.kind",
              "prop.word_count",
              "prop.journal_date",
            ],
          },
        ],
      }),
      "Continues",
      makeCapability({
        fields: [
          { field: "kind", membership: true, view: false, embed: false },
          { field: "prop.kind", membership: false, view: true, embed: false },
          {
            field: "prop.word_count",
            membership: false,
            view: true,
            embed: false,
          },
          {
            field: "prop.journal_date",
            membership: false,
            view: true,
            embed: false,
          },
        ],
      }),
    );

    expect(fields.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: "title", kind: "title" },
      { key: "kind", kind: "kind" },
      { key: "prop.kind", kind: "property" },
      { key: "prop.word_count", kind: "property" },
      { key: "prop.journal_date", kind: "property" },
    ]);
    expect(
      fields.slice(1).map(({ membership, viewOnly, embedOnly }) => ({
        membership,
        viewOnly,
        embedOnly,
      })),
    ).toEqual([
      { membership: true, viewOnly: false, embedOnly: false },
      { membership: false, viewOnly: true, embedOnly: false },
      { membership: false, viewOnly: true, embedOnly: false },
      { membership: false, viewOnly: true, embedOnly: false },
    ]);
  });

  it("uses own-property checks for names that collide with Object.prototype", () => {
    const inheritedOnly = composeMemberDraftFields(
      makeDefinition({
        properties: undefined,
        views: [{ name: "Continues" }],
      }),
      "Continues",
      makeCapability({
        fields: [
          {
            field: "constructor",
            membership: true,
            view: false,
            embed: false,
          },
        ],
      }),
    );
    expect(inheritedOnly.map((field) => field.key)).toEqual(["title"]);

    const constructorDefinition: PropertyDefinition = { type: "text" };
    const declared = composeMemberDraftFields(
      makeDefinition({
        properties: { constructor: constructorDefinition },
        views: [{ name: "Continues", columns: ["prop.constructor"] }],
      }),
      "Continues",
      makeCapability(),
    );
    expect(declared.find((field) => field.key === "constructor")).toMatchObject({
      kind: "property",
      definition: constructorDefinition,
    });
  });

  it("does not turn undeclared filter keys into controls or consume their diagnostics", () => {
    const capability = makeCapability({
      enabled: false,
      fields: [
        { field: "missing", membership: true, view: false, embed: false },
      ],
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
        embedOnly: false,
      },
    ]);
    expect(capability).toEqual(before);
  });

  it("does not mutate generated definition or capability objects", () => {
    const definition = makeDefinition();
    const capability = makeCapability({
      fields: [
        { field: "status", membership: false, view: true, embed: false },
      ],
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
