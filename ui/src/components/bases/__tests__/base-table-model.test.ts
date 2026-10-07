import { describe, expect, it } from "vitest";
import type { BaseDetailResponse, QueryOutput } from "#/api/bases";
import { readOnlyModel } from "#/components/bases/base-table-model";

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "r1",
  name: "Reading Log",
  properties: [],
  views: [{ name: "Continues", layout: "table", columns: ["title"] }],
  diagnostics: [],
  member_creation: [],
};

const output: QueryOutput = {
  shape: "flat",
  rows: [],
  total: 0,
  aggregates: [],
};

describe("readOnlyModel", () => {
  it("is a ready, read-only model over the given output", () => {
    const model = readOnlyModel({
      definition,
      activeView: "Continues",
      output,
    });

    expect(model.status).toBe("ready");
    expect(model.readOnly).toBe(true);
    expect(model.definition).toBe(definition);
    expect(model.query.activeView).toBe("Continues");
    expect(model.query.output).toBe(output);
    expect(model.query.sort).toBeUndefined();
    expect(model.query.error).toBeUndefined();
    expect(model.query.loading).toBe(false);
  });

  it("wires no member, override, window or row-menu actions", () => {
    const model = readOnlyModel({
      definition,
      activeView: "Continues",
      output,
    });

    expect(model.members).toBeUndefined();
    expect(model.overrides).toBeUndefined();
    expect(model.window).toBeUndefined();
    expect(model.configureSlug).toBeUndefined();
    expect(model.rowActions.onOpenPageInNewTab).toBeUndefined();
    expect(model.rowActions.onCopyWikilink).toBeUndefined();
    expect(model.rowActions.onDuplicateRow).toBeUndefined();
    expect(model.rowActions.onArchiveRow).toBeUndefined();
  });

  it("ignores view, sort, open and commit requests", () => {
    const model = readOnlyModel({
      definition,
      activeView: "Continues",
      output,
    });

    expect(() => {
      model.query.onViewChange("Other");
      model.query.onSortChange([{ field: "title", dir: "asc" }]);
      model.rowActions.onOpenPage("one.md");
      model.rowActions.onCommitCell(
        { id: "one", path: "one.md", title: "One", kind: "NOTE", columns: {} },
        "title",
        "Two",
      );
    }).not.toThrow();
  });
});
