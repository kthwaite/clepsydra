import { describe, expect, it } from "vitest";
import { KINDS } from "#/lib/kind";
import {
  isOneOnOne,
  localIso,
  ONE_ON_ONE_TAG,
  readOccurredAt,
  recordsOccurrence,
  withOneOnOne,
} from "#/lib/meeting";

describe("recordsOccurrence", () => {
  it("covers meetings and nothing else", () => {
    expect(recordsOccurrence("MEETING")).toBe(true);
    for (const kind of KINDS) {
      if (kind === "MEETING") continue;
      expect(recordsOccurrence(kind)).toBe(false);
    }
  });
});

describe("the 1:1 tag", () => {
  it("is spelled exactly 1:1", () => {
    expect(ONE_ON_ONE_TAG).toBe("1:1");
  });

  it("reads the tag off a tag list", () => {
    expect(isOneOnOne(["1:1"])).toBe(true);
    expect(isOneOnOne(["weekly", "1:1"])).toBe(true);
    expect(isOneOnOne(["weekly"])).toBe(false);
    expect(isOneOnOne([])).toBe(false);
  });

  it("appends the tag once and removes every copy", () => {
    expect(withOneOnOne(["weekly"], true)).toEqual(["weekly", "1:1"]);
    expect(withOneOnOne(["weekly", "1:1"], true)).toEqual(["weekly", "1:1"]);
    expect(withOneOnOne(["1:1", "weekly", "1:1"], false)).toEqual(["weekly"]);
    expect(withOneOnOne([], false)).toEqual([]);
  });

  it("returns a new array and leaves the input intact", () => {
    const input = ["weekly"];
    const next = withOneOnOne(input, true);
    expect(next).not.toBe(input);
    expect(input).toEqual(["weekly"]);
  });
});

describe("localIso", () => {
  it("writes the local wall clock, zero-padded and without an offset", () => {
    // Constructed from local parts, so the rendering is zone-independent.
    expect(localIso(new Date(2026, 7, 27, 14, 5, 9))).toBe(
      "2026-08-27T14:05:09",
    );
    expect(localIso(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01T00:00:00");
  });

  it("produces exactly what a datetime-local input accepts", () => {
    expect(localIso(new Date(2026, 7, 27, 14, 0, 0))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );
  });
});

describe("readOccurredAt", () => {
  it("passes a stored string through", () => {
    expect(readOccurredAt("2026-08-27T14:00:00Z")).toBe("2026-08-27T14:00:00Z");
  });

  it("treats absent, blank, and non-string values as unset", () => {
    expect(readOccurredAt(undefined)).toBeNull();
    expect(readOccurredAt(null)).toBeNull();
    expect(readOccurredAt("   ")).toBeNull();
    // A hand-edited page can hold anything; the doctor reports it, the rail
    // does not render it.
    expect(readOccurredAt(2026)).toBeNull();
    expect(readOccurredAt({ when: "later" })).toBeNull();
  });
});
