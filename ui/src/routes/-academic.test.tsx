import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

import { ACADEMIC_FILTER_URL, Route } from "#/routes/academic";

describe("Academic route filters", () => {
  it("exposes work_type/status/year/tag field ids matching the URL codec", () => {
    expect(ACADEMIC_FILTER_URL.fields.map((f) => f.id)).toEqual([
      "work_type",
      "status",
      "year",
      "tag",
    ]);
  });

  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({
        work_type: "paper",
        status: "reading",
        bogus: "x",
      } as any),
    ).toEqual({
      work_type: "paper",
      status: "reading",
      bogus: "x",
      year: undefined,
      tag: undefined,
      q: undefined,
    });
  });

  it("round-trips a year and tag facet through the codec", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({ year: "2017", tag: "transformers" } as any),
    ).toEqual({
      work_type: undefined,
      status: undefined,
      year: "2017",
      tag: "transformers",
      q: undefined,
    });
  });
});
