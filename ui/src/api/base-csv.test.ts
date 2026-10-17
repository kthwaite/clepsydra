import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { type BaseCsvPreviewResponse, importBaseCsvRows } from "#/api/base-csv";
import type { BaseDetailResponse } from "#/api/bases";

const definition: BaseDetailResponse = {
  slug: "books",
  name: "Books",
  revision: "rev-1",
  diagnostics: [],
  member_creation: [],
  properties: [],
  views: [],
};
const preview: BaseCsvPreviewResponse = {
  base_revision: "rev-1",
  valid: true,
  diagnostics: [],
  declarations: [],
  mappings: [{ column: 0, header: "Title", field: "title" }],
  rows: [{ row: 2, title: "Dune", fields: {}, diagnostics: [] }],
};

// These refusal/skip paths have no transport: a regression attempts a real request and fails.
describe("CSV import write boundary", () => {
  it("refuses unapproved or rejected previews before any definition or member write", async () => {
    const client = new QueryClient();
    for (const input of [
      { preview, approved: false },
      {
        preview: {
          ...preview,
          valid: false,
          declarations: [
            { key: "rating", definition: { type: "number" as const } },
          ],
        },
        approved: true,
      },
      {
        preview: {
          ...preview,
          diagnostics: [
            { row: 2, column: 0, field: "title", message: "Missing title" },
          ],
        },
        approved: true,
      },
      {
        preview: {
          ...preview,
          rows: [
            {
              row: 2,
              title: "Dune",
              fields: {},
              diagnostics: [
                {
                  row: 2,
                  column: 1,
                  field: "rating",
                  message: "Expected a number",
                },
              ],
            },
          ],
        },
        approved: true,
      },
    ]) {
      await expect(
        importBaseCsvRows(
          { slug: "books", view: "All", definition, ...input },
          client,
        ),
      ).rejects.toThrow("A valid CSV preview must be explicitly approved");
    }
  });

  it("requires a fresh preview after a Base revision change", async () => {
    await expect(
      importBaseCsvRows(
        {
          slug: "books",
          view: "All",
          definition: { ...definition, revision: "rev-2" },
          preview,
          approved: true,
        },
        new QueryClient(),
      ),
    ).rejects.toThrow("The Base changed since this preview");
  });

  it("does not create successful rows again when retrying an import", async () => {
    const created = {
      row: 2,
      status: "created",
      page: {
        id: "dune",
        path: "books/dune.md",
        revision: "page-1",
        title: "Dune",
      },
    } as const;
    const outcomes = await importBaseCsvRows(
      {
        slug: "books",
        view: "All",
        definition,
        preview,
        approved: true,
        previous: [created],
      },
      new QueryClient(),
    );
    expect(outcomes).toEqual([created]);
  });

  it("does not retry a row whose creation response was lost", async () => {
    const uncertain = {
      row: 2,
      status: "uncertain",
      message: "Check the vault before importing separately.",
    } as const;
    const outcomes = await importBaseCsvRows(
      {
        slug: "books",
        view: "All",
        definition,
        preview,
        approved: true,
        previous: [uncertain],
      },
      new QueryClient(),
    );
    expect(outcomes).toEqual([uncertain]);
  });
});
