import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

import {
  Route,
  RUBBISH_FILTER_URL,
  rubbishFilterNavigation,
} from "#/routes/rubbish";

describe("Rubbish route filters", () => {
  it("exposes the kind field id matching the URL codec", () => {
    expect(RUBBISH_FILTER_URL.fields.map((f) => f.id)).toEqual(["kind"]);
  });

  it("normalises the shared filter search params, passing through unknown keys", () => {
    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== "function") {
      throw new Error("Expected a callable search validator");
    }
    expect(
      validateSearch({
        kind: "note",
        bogus: "x",
      } as never),
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
    expect(validateSearch({ kind: "PROJECT", q: "alpha" } as never)).toEqual({
      kind: "PROJECT",
      q: "alpha",
    });
  });

  it("builds text-only navigation for the exact route while retaining unrelated search and clearing stale fields", () => {
    const navigation = rubbishFilterNavigation(
      { text: "trash", facets: { kind: ["NOTE"] } },
      { text: "old", facets: { kind: ["NOTE"] } },
    );

    expect(navigation.to).toBe("/rubbish");
    expect(navigation.replace).toBe(true);
    expect(
      navigation.search({
        q: "old",
        kind: "PROJECT",
        page: "2",
      }),
    ).toEqual({
      q: "trash",
      kind: "NOTE",
      page: "2",
    });
  });

  it("pushes history when a Rubbish facet changes with the text", () => {
    const navigation = rubbishFilterNavigation(
      { text: "new", facets: { kind: ["NOTE"] } },
      { text: "old", facets: { kind: ["PROJECT"] } },
    );

    expect(navigation.to).toBe("/rubbish");
    expect(navigation.replace).toBe(false);
  });
});
