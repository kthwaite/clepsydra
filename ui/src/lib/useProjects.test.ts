import { describe, expect, it } from "vitest";
import { distinctProjects } from "#/lib/useProjects";

describe("distinctProjects", () => {
  it("collects sorted unique non-empty project slugs", () => {
    const items = [
      { project: "clep" },
      { project: null },
      { project: "atlas" },
      { project: "clep" },
      {},
    ];
    expect(distinctProjects(items)).toEqual(["atlas", "clep"]);
  });
});
