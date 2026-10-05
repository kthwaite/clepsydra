import { describe, expect, it } from "vitest";
import { KINDS } from "#/lib/kind";
import {
  floorToQuarterHour,
  localIso,
  readOccurredAt,
  recordsOccurrence,
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

describe("floorToQuarterHour", () => {
  it("keeps a time already on a quarter", () => {
    expect(localIso(floorToQuarterHour(new Date(2026, 7, 27, 12, 0, 0)))).toBe(
      "2026-08-27T12:00:00",
    );
    expect(localIso(floorToQuarterHour(new Date(2026, 7, 27, 12, 45, 0)))).toBe(
      "2026-08-27T12:45:00",
    );
  });

  it("rounds down to the quarter that has already started", () => {
    expect(localIso(floorToQuarterHour(new Date(2026, 7, 27, 12, 1, 0)))).toBe(
      "2026-08-27T12:00:00",
    );
    expect(localIso(floorToQuarterHour(new Date(2026, 7, 27, 12, 16, 0)))).toBe(
      "2026-08-27T12:15:00",
    );
    expect(localIso(floorToQuarterHour(new Date(2026, 7, 27, 12, 59, 0)))).toBe(
      "2026-08-27T12:45:00",
    );
  });

  it("drops the seconds and milliseconds", () => {
    expect(
      localIso(floorToQuarterHour(new Date(2026, 7, 27, 12, 16, 41, 500))),
    ).toBe("2026-08-27T12:15:00");
  });

  it("never crosses back over the hour or the day", () => {
    expect(localIso(floorToQuarterHour(new Date(2026, 7, 27, 0, 3, 9)))).toBe(
      "2026-08-27T00:00:00",
    );
    expect(
      localIso(floorToQuarterHour(new Date(2026, 7, 27, 23, 59, 59))),
    ).toBe("2026-08-27T23:45:00");
  });

  it("leaves the given date untouched", () => {
    const now = new Date(2026, 7, 27, 12, 16, 41);
    floorToQuarterHour(now);
    expect(localIso(now)).toBe("2026-08-27T12:16:41");
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
