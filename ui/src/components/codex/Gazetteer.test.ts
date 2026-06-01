import { describe, expect, it } from "vitest";
import { toggleInSet } from "./Gazetteer";

describe("toggleInSet", () => {
  it("adds a value that is absent", () => {
    const result = toggleInSet(new Set(["a"]), "b");
    expect([...result].sort()).toEqual(["a", "b"]);
  });

  it("removes a value that is present", () => {
    const result = toggleInSet(new Set(["a", "b"]), "a");
    expect([...result]).toEqual(["b"]);
  });

  it("returns a NEW set (does not mutate the input)", () => {
    const input = new Set(["a"]);
    const result = toggleInSet(input, "b");
    expect(result).not.toBe(input);
    expect([...input]).toEqual(["a"]);
  });
});
