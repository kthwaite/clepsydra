import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

import { Route, TASKING_FILTER_URL } from "#/routes/tasking";

describe("Tasking route filters", () => {
  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({ pri: "p1,p2", hold: "1", bogus: "x" } as any),
    ).toEqual({
      pri: ["P1", "P2"],
      hold: "1",
      bogus: "x",
      project: undefined,
      tags: undefined,
      status: undefined,
      q: undefined,
    });
  });

  it("exposes project/tags/pri/status/hold field ids matching the URL codec", () => {
    expect(TASKING_FILTER_URL.fields.map((f) => f.id)).toEqual([
      "project",
      "tags",
      "pri",
      "status",
      "hold",
    ]);
  });
});
