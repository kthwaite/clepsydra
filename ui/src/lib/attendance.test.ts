import { describe, expect, it } from "vitest";
import {
  asWikilink,
  attendeeTarget,
  hasAttendees,
  readAttendees,
} from "#/lib/attendance";
import { KINDS } from "#/lib/kind";

describe("hasAttendees", () => {
  it("covers meetings and nothing else", () => {
    expect(hasAttendees("MEETING")).toBe(true);
    for (const kind of KINDS) {
      if (kind === "MEETING") continue;
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
