import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

import { Route } from "#/routes/rubbish";

describe("Rubbish route filters", () => {
  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({
        kind: "note",
        bogus: "x",
      } as any),
    ).toEqual({
      kind: "NOTE",
      bogus: "x",
      q: undefined,
    });
  });

  it("round-trips an already-normalised kind facet and text query through the codec", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(validateSearch({ kind: "PROJECT", q: "alpha" } as any)).toEqual({
      kind: "PROJECT",
      q: "alpha",
    });
  });
});
