import { describe, expect, it } from "vitest";
import { KINDS } from "#/lib/kind";
import { localIso, readOccurredAt, recordsOccurrence } from "#/lib/meeting";

describe("recordsOccurrence", () => {
  it("covers meetings and 1:1s and nothing else", () => {
    expect(recordsOccurrence("MEETING")).toBe(true);
    expect(recordsOccurrence("ONE_ON_ONE")).toBe(true);
    for (const kind of KINDS) {
      if (kind === "MEETING" || kind === "ONE_ON_ONE") continue;
      expect(recordsOccurrence(kind)).toBe(false);
    }
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
