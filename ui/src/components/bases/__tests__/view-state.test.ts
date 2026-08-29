import { describe, expect, it } from "vitest";
import {
  readLastView,
  resolveActiveView,
  type ViewStateStorage,
  writeLastView,
} from "#/components/bases/view-state";

class MemoryStorage implements ViewStateStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const sealed: ViewStateStorage = {
  getItem() {
    throw new Error("sealed");
  },
  setItem() {
    throw new Error("sealed");
  },
};

const views = [{ name: "Continues" }, { name: "Shelf" }];

describe("last view memory", () => {
  it("round-trips under the per-base key", () => {
    const storage = new MemoryStorage();
    writeLastView(storage, "reading", "Shelf");
    expect(storage.items.get("clepsydra.bases.lastView.reading")).toBe("Shelf");
    expect(readLastView(storage, "reading")).toBe("Shelf");
    expect(readLastView(storage, "other")).toBeUndefined();
  });

  it("treats an empty value as nothing remembered", () => {
    const storage = new MemoryStorage();
    storage.setItem("clepsydra.bases.lastView.reading", "");
    expect(readLastView(storage, "reading")).toBeUndefined();
  });

  it("survives missing and throwing storage", () => {
    expect(readLastView(undefined, "reading")).toBeUndefined();
    expect(() => writeLastView(undefined, "reading", "Shelf")).not.toThrow();
    expect(readLastView(sealed, "reading")).toBeUndefined();
    expect(() => writeLastView(sealed, "reading", "Shelf")).not.toThrow();
  });
});

describe("resolveActiveView", () => {
  it("returns nothing while there are no views", () => {
    expect(resolveActiveView([], "Shelf", "Continues")).toEqual({
      view: "",
      scrub: false,
    });
  });

  it("prefers the requested view and returns its canonical name", () => {
    expect(resolveActiveView(views, "shelf", "Continues")).toEqual({
      view: "Shelf",
      scrub: false,
    });
  });

  it("scrubs an unknown request and falls back to memory", () => {
    expect(resolveActiveView(views, "bogus", "shelf")).toEqual({
      view: "Shelf",
      scrub: true,
    });
  });

  it("scrubs an unknown request and falls back to the first view", () => {
    expect(resolveActiveView(views, "bogus", undefined)).toEqual({
      view: "Continues",
      scrub: true,
    });
  });

  it("restores memory without a request and never scrubs", () => {
    expect(resolveActiveView(views, undefined, "SHELF")).toEqual({
      view: "Shelf",
      scrub: false,
    });
  });

  it("ignores stale memory", () => {
    expect(resolveActiveView(views, undefined, "Gone")).toEqual({
      view: "Continues",
      scrub: false,
    });
  });
});
