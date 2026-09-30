import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSED_KEY,
  HIDDEN_KINDS_KEY,
  readCollapsed,
  readHiddenKinds,
  writeCollapsed,
  writeHiddenKinds,
} from "#/lib/calendar/railPrefs";

describe("railPrefs", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("defaults to no hidden kinds and not collapsed", () => {
    expect(readHiddenKinds()).toEqual(new Set());
    expect(readCollapsed()).toBe(false);
  });

  it("round-trips hidden kinds and the collapsed flag", () => {
    writeHiddenKinds(new Set(["RECIPE", "NOTE"]));
    expect(window.localStorage.getItem(HIDDEN_KINDS_KEY)).toBe(
      '["NOTE","RECIPE"]',
    );
    expect(readHiddenKinds()).toEqual(new Set(["NOTE", "RECIPE"]));

    writeCollapsed(true);
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("1");
    expect(readCollapsed()).toBe(true);
    writeCollapsed(false);
    expect(readCollapsed()).toBe(false);
  });

  it("reads corrupt JSON as an empty set", () => {
    window.localStorage.setItem(HIDDEN_KINDS_KEY, "{not json");
    expect(readHiddenKinds()).toEqual(new Set());
    window.localStorage.setItem(HIDDEN_KINDS_KEY, '"NOTE"');
    expect(readHiddenKinds()).toEqual(new Set());
  });

  it("drops unknown kinds", () => {
    window.localStorage.setItem(
      HIDDEN_KINDS_KEY,
      JSON.stringify(["NOTE", "BOGUS", 3]),
    );
    expect(readHiddenKinds()).toEqual(new Set(["NOTE"]));
  });

  it("falls back to defaults when storage throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readHiddenKinds()).toEqual(new Set());
    expect(readCollapsed()).toBe(false);
    expect(() => writeHiddenKinds(new Set(["NOTE"]))).not.toThrow();
    expect(() => writeCollapsed(true)).not.toThrow();
  });
});
