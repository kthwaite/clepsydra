import { describe, expect, it } from "vitest";
import {
  clampReadingColumn,
  effectiveReadingColumn,
  READING_COLUMN_DEFAULT,
  READING_COLUMN_MAX,
  READING_COLUMN_MIN,
  readStoredReadingColumn,
  writeStoredReadingColumn,
} from "#/components/codex/reading-column";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    read: () => Object.fromEntries(values),
  };
}

describe("clampReadingColumn", () => {
  it("keeps a width inside the readable range", () => {
    expect(clampReadingColumn(READING_COLUMN_DEFAULT)).toBe(
      READING_COLUMN_DEFAULT,
    );
  });

  it("clamps past either end and rounds", () => {
    expect(clampReadingColumn(80)).toBe(READING_COLUMN_MIN);
    expect(clampReadingColumn(9000)).toBe(READING_COLUMN_MAX);
    expect(clampReadingColumn(720.4)).toBe(720);
  });
});

describe("effectiveReadingColumn", () => {
  it("honours the preference when the viewport can hold it", () => {
    expect(effectiveReadingColumn(1000, 1400)).toBe(1000);
  });

  it("gives way to a viewport narrower than the preference", () => {
    expect(effectiveReadingColumn(1000, 640)).toBe(640);
  });

  it("gives way even below the readable minimum, rather than overflowing", () => {
    expect(effectiveReadingColumn(900, 320)).toBe(320);
  });

  it("uses the preference alone before the container has been measured", () => {
    expect(effectiveReadingColumn(1000, 0)).toBe(1000);
    expect(effectiveReadingColumn(1000, Number.NaN)).toBe(1000);
  });

  it("clamps a stored preference from outside the range", () => {
    expect(effectiveReadingColumn(9000, 2000)).toBe(READING_COLUMN_MAX);
  });
});

describe("stored width", () => {
  it("reads an integer back", () => {
    expect(readStoredReadingColumn(storage({ "k.w": "1024" }), "k.w")).toBe(
      1024,
    );
  });

  it("clamps a stored width that no longer fits the range", () => {
    expect(readStoredReadingColumn(storage({ "k.w": "5000" }), "k.w")).toBe(
      READING_COLUMN_MAX,
    );
  });

  it.each(["", "wide", "NaN", "Infinity"])(
    "ignores the unusable stored value %o",
    (raw) => {
      expect(
        readStoredReadingColumn(storage({ "k.w": raw }), "k.w"),
      ).toBeUndefined();
    },
  );

  it("ignores an absent value and a storage that throws", () => {
    expect(readStoredReadingColumn(storage(), "k.w")).toBeUndefined();
    expect(
      readStoredReadingColumn(
        {
          getItem() {
            throw new Error("blocked");
          },
          setItem() {},
        },
        "k.w",
      ),
    ).toBeUndefined();
  });

  it("writes the clamped width and survives a storage that throws", () => {
    const store = storage();
    writeStoredReadingColumn(store, "k.w", 9000);
    expect(store.read()).toEqual({ "k.w": String(READING_COLUMN_MAX) });
    expect(() =>
      writeStoredReadingColumn(
        {
          getItem: () => null,
          setItem() {
            throw new Error("blocked");
          },
        },
        "k.w",
        800,
      ),
    ).not.toThrow();
  });
});
