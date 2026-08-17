import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

import { Route } from "#/routes/academic";

describe("Academic route filters", () => {
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
