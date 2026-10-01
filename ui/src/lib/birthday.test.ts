import { describe, expect, it } from "vitest";
import {
  type BirthdayOccurrence,
  birthdayLabel,
  birthdayOccurrences,
  birthdayPickerValue,
  birthdayValue,
  formatBirthday,
  readBirthday,
} from "#/lib/birthday";

describe("readBirthday", () => {
  it("reads a full date", () => {
    expect(readBirthday("1983-05-12")).toEqual({
      year: 1983,
      month: 5,
      day: 12,
    });
  });

  it("reads a month-day without a year, in both forms", () => {
    expect(readBirthday("05-12")).toEqual({ year: null, month: 5, day: 12 });
    expect(readBirthday("--05-12")).toEqual({ year: null, month: 5, day: 12 });
  });

  it("trims surrounding whitespace", () => {
    expect(readBirthday("  05-12 ")).toEqual({ year: null, month: 5, day: 12 });
  });

  it("accepts Feb 29 without a year and in a leap year", () => {
    expect(readBirthday("02-29")).toEqual({ year: null, month: 2, day: 29 });
    expect(readBirthday("1984-02-29")).toEqual({
      year: 1984,
      month: 2,
      day: 29,
    });
  });

  it.each([
    ["13-01"],
    ["02-30"],
    ["1983-02-29"],
    ["1983-04-31"],
    ["00-10"],
    ["1983-05-12T10:00:00"],
    ["May 12"],
    [""],
  ])("rejects %j", (raw) => {
    expect(readBirthday(raw)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(readBirthday(19830512)).toBeNull();
    expect(readBirthday(null)).toBeNull();
    expect(readBirthday(undefined)).toBeNull();
    expect(readBirthday({ month: 5, day: 12 })).toBeNull();
  });
});

describe("birthdayValue", () => {
  it("stores a known year as a native date", () => {
    expect(birthdayValue({ year: 1983, month: 5, day: 12 })).toEqual({
      value: "1983-05-12",
      hint: "date",
    });
  });

  it("stores an unknown year as a plain month-day string", () => {
    expect(birthdayValue({ year: null, month: 5, day: 2 })).toEqual({
      value: "05-02",
    });
  });
});

describe("birthdayPickerValue", () => {
  it("uses the real year when known", () => {
    expect(birthdayPickerValue({ year: 1983, month: 5, day: 12 })).toBe(
      "1983-05-12",
    );
  });

  it("uses leap year 2000 when unknown, so Feb 29 is pickable", () => {
    expect(birthdayPickerValue({ year: null, month: 2, day: 29 })).toBe(
      "2000-02-29",
    );
  });
});

describe("formatBirthday", () => {
  it("formats with and without a year", () => {
    expect(formatBirthday({ year: 1983, month: 5, day: 12 })).toBe(
      "12 May 1983",
    );
    expect(formatBirthday({ year: null, month: 5, day: 12 })).toBe("12 May");
  });
});

describe("birthdayOccurrences", () => {
  const ada = { path: "people/ada.md", title: "Ada", month: 5, day: 12 };

  it("places a yearly birthday on its day inside the range", () => {
    const got = birthdayOccurrences([{ ...ada, year: 1983 }], {
      first: "2026-04-27",
      last: "2026-06-07",
    });
    expect([...got.keys()]).toEqual(["2026-05-12"]);
    expect(got.get("2026-05-12")).toEqual([
      { path: "people/ada.md", title: "Ada", date: "2026-05-12", age: 43 },
    ]);
  });

  it("skips birthdays outside the range, inclusive at both ends", () => {
    expect(
      birthdayOccurrences([ada], { first: "2026-05-13", last: "2026-06-30" })
        .size,
    ).toBe(0);
    expect(
      birthdayOccurrences([ada], { first: "2026-05-12", last: "2026-05-12" })
        .size,
    ).toBe(1);
  });

  it("has a null age when the year is unknown", () => {
    const got = birthdayOccurrences([{ ...ada, year: null }], {
      first: "2026-05-01",
      last: "2026-05-31",
    });
    expect(got.get("2026-05-12")?.[0].age).toBeNull();
  });

  it("has a null age at or before the birth year", () => {
    const got = birthdayOccurrences([{ ...ada, year: 2026 }], {
      first: "2026-05-01",
      last: "2026-05-31",
    });
    expect(got.get("2026-05-12")?.[0].age).toBeNull();
  });

  it("defaults a missing title to null", () => {
    const got = birthdayOccurrences(
      [{ path: "people/x.md", month: 1, day: 1 }],
      { first: "2026-01-01", last: "2026-01-01" },
    );
    expect(got.get("2026-01-01")?.[0].title).toBeNull();
  });

  it("spans a year boundary, and can see the same birthday twice", () => {
    const got = birthdayOccurrences(
      [{ ...ada, month: 1, day: 5, year: 1990 }],
      { first: "2025-12-01", last: "2027-02-28" },
    );
    expect([...got.keys()]).toEqual(["2026-01-05", "2027-01-05"]);
    expect(got.get("2026-01-05")?.[0].age).toBe(36);
    expect(got.get("2027-01-05")?.[0].age).toBe(37);
  });

  it("moves Feb 29 to Feb 28 in non-leap years only", () => {
    const leapling = { path: "p.md", title: "P", month: 2, day: 29 };
    expect([
      ...birthdayOccurrences([leapling], {
        first: "2027-02-01",
        last: "2027-03-31",
      }).keys(),
    ]).toEqual(["2027-02-28"]);
    expect([
      ...birthdayOccurrences([leapling], {
        first: "2028-02-01",
        last: "2028-03-31",
      }).keys(),
    ]).toEqual(["2028-02-29"]);
  });

  it("groups several people on the same day in input order", () => {
    const got = birthdayOccurrences(
      [ada, { path: "people/bo.md", title: "Bo", month: 5, day: 12 }],
      { first: "2026-05-01", last: "2026-05-31" },
    );
    expect(got.get("2026-05-12")?.map((o) => o.title)).toEqual(["Ada", "Bo"]);
  });
});

describe("birthdayLabel", () => {
  const base: BirthdayOccurrence = {
    path: "p.md",
    title: "P",
    date: "2026-05-12",
    age: 43,
  };

  it("names the age when known", () => {
    expect(birthdayLabel(base)).toBe("birthday, turns 43");
  });

  it("says just birthday when the age is unknown", () => {
    expect(birthdayLabel({ ...base, age: null })).toBe("birthday");
  });
});
