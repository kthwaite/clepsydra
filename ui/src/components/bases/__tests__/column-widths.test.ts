import { describe, expect, it } from "vitest";
import {
  BASE_COLUMN_MAX,
  BASE_COLUMN_MIN,
  clampBaseColumnWidth,
  columnWidthsKey,
  readColumnWidths,
  writeColumnWidths,
} from "#/components/bases/column-widths";
import type { ViewStateStorage } from "#/components/bases/view-state";

class MemoryStorage implements ViewStateStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const sealed: ViewStateStorage & { removeItem(key: string): void } = {
  getItem() {
    throw new Error("sealed");
  },
  setItem() {
    throw new Error("sealed");
  },
  removeItem() {
    throw new Error("sealed");
  },
};

describe("columnWidthsKey", () => {
  it("scopes widths to base and case-folded view", () => {
    expect(columnWidthsKey("reading", "By Status")).toBe(
      "clepsydra.bases.columns.reading.by status",
    );
  });
});

describe("clampBaseColumnWidth", () => {
  it("clamps to the bounds and rounds", () => {
    expect(BASE_COLUMN_MIN).toBe(40);
    expect(BASE_COLUMN_MAX).toBe(640);
    expect(clampBaseColumnWidth(10)).toBe(40);
    expect(clampBaseColumnWidth(9000)).toBe(640);
    expect(clampBaseColumnWidth(120.6)).toBe(121);
  });
});

describe("column width storage", () => {
  it("round-trips a width map", () => {
    const storage = new MemoryStorage();
    const key = columnWidthsKey("reading", "shelf");
    writeColumnWidths(storage, key, { status: 120, rating: 80 });
    expect(storage.items.get(key)).toBe('{"status":120,"rating":80}');
    expect(readColumnWidths(storage, key)).toEqual({
      status: 120,
      rating: 80,
    });
  });

  it("removes the entry when no widths remain", () => {
    const storage = new MemoryStorage();
    writeColumnWidths(storage, "k", { status: 120 });
    writeColumnWidths(storage, "k", {});
    expect(storage.items.has("k")).toBe(false);
  });

  it("reads nothing from a missing, malformed, or non-object entry", () => {
    const storage = new MemoryStorage();
    expect(readColumnWidths(storage, "k")).toEqual({});
    storage.setItem("k", "{not json");
    expect(readColumnWidths(storage, "k")).toEqual({});
    storage.setItem("k", "[120]");
    expect(readColumnWidths(storage, "k")).toEqual({});
    storage.setItem("k", "null");
    expect(readColumnWidths(storage, "k")).toEqual({});
    storage.setItem("k", "7");
    expect(readColumnWidths(storage, "k")).toEqual({});
  });

  it("drops junk entries and clamps and rounds the rest", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "k",
      '{"a":"120","b":null,"c":1e999,"d":5,"e":9000,"f":100.4,"g":true}',
    );
    expect(readColumnWidths(storage, "k")).toEqual({
      d: 40,
      e: 640,
      f: 100,
    });
  });

  it("survives missing and throwing storage", () => {
    expect(readColumnWidths(undefined, "k")).toEqual({});
    expect(() => writeColumnWidths(undefined, "k", { a: 100 })).not.toThrow();
    expect(readColumnWidths(sealed, "k")).toEqual({});
    expect(() => writeColumnWidths(sealed, "k", { a: 100 })).not.toThrow();
    expect(() => writeColumnWidths(sealed, "k", {})).not.toThrow();
  });
});
