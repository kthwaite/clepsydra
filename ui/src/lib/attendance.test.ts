import { describe, expect, it } from "vitest";
import {
  asWikilink,
  attendeeCardinality,
  attendeeTarget,
  canAddAttendee,
  hasAttendees,
  readAttendees,
} from "#/lib/attendance";
import { KINDS } from "#/lib/kind";

describe("attendeeCardinality", () => {
  it("covers meetings and 1:1s and nothing else", () => {
    expect(attendeeCardinality("MEETING")).toBe("many");
    expect(attendeeCardinality("ONE_ON_ONE")).toBe("one");
    for (const kind of KINDS) {
      if (kind === "MEETING" || kind === "ONE_ON_ONE") continue;
      expect(attendeeCardinality(kind)).toBeNull();
      expect(hasAttendees(kind)).toBe(false);
    }
  });
});

describe("attendeeTarget", () => {
  it("unwraps wikilinks and drops display aliases", () => {
    expect(attendeeTarget("[[Ada Lovelace]]")).toBe("Ada Lovelace");
    expect(attendeeTarget("[[Grace Hopper|Grace]]")).toBe("Grace Hopper");
    expect(attendeeTarget("  Alan Turing  ")).toBe("Alan Turing");
    expect(attendeeTarget("[[]]")).toBe("");
  });
});

describe("asWikilink", () => {
  it("wraps bare names and leaves linked ones alone", () => {
    expect(asWikilink("Ada Lovelace")).toBe("[[Ada Lovelace]]");
    expect(asWikilink(" [[Ada Lovelace]] ")).toBe("[[Ada Lovelace]]");
  });
});

describe("readAttendees", () => {
  it("reads the array the server writes", () => {
    expect(readAttendees(["[[Ada]]", "[[Grace]]"])).toEqual(["Ada", "Grace"]);
  });

  it("reads a hand-written single wikilink", () => {
    expect(readAttendees("[[Ada]]")).toEqual(["Ada"]);
  });

  it("drops entries that name nobody, and absent values", () => {
    expect(readAttendees(["[[Ada]]", "[[]]", "  ", 7])).toEqual(["Ada"]);
    expect(readAttendees(undefined)).toEqual([]);
    expect(readAttendees(null)).toEqual([]);
    expect(readAttendees(42)).toEqual([]);
  });
});

describe("canAddAttendee", () => {
  it("lets a meeting keep going and stops a 1:1 at one", () => {
    expect(canAddAttendee("MEETING", 0)).toBe(true);
    expect(canAddAttendee("MEETING", 9)).toBe(true);
    expect(canAddAttendee("ONE_ON_ONE", 0)).toBe(true);
    expect(canAddAttendee("ONE_ON_ONE", 1)).toBe(false);
    expect(canAddAttendee("NOTE", 0)).toBe(false);
  });
});
