import { describe, expect, it } from "vitest";
import { rule } from "./css-contract";

describe("list indentation default", () => {
  it("lives in the base layer so a list's own padding utilities win", () => {
    // Unlayered, `ul { padding-inline-start }` beat every `p-0` / `px-*`
    // utility on a <ul> (Conflicts rows sat 7px left of the gutter).
    expect(() => rule("ul")).toThrow();
    expect(rule("@layer base")).toMatch(/ul\s*\{\s*padding-inline-start:\s*1lh;/);
  });
});
