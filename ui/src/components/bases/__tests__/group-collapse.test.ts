import { describe, expect, it } from "vitest";
import {
  groupCollapseKey,
  groupIdentity,
  readCollapsedGroups,
  writeCollapsedGroups,
} from "#/components/bases/group-collapse";
import type { ViewStateStorage } from "#/components/bases/view-state";

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

describe("groupIdentity", () => {
  it("keeps strings, numbers, booleans, and the empty group distinct", () => {
    expect(groupIdentity("1")).not.toBe(groupIdentity(1));
    expect(groupIdentity(true)).not.toBe(groupIdentity("true"));
    expect(groupIdentity(null)).toBe(groupIdentity(undefined));
    expect(groupIdentity(null)).not.toBe(groupIdentity(""));
  });
});

describe("groupCollapseKey", () => {
  it("scopes the fold to base, case-folded view, and grouping field", () => {
    expect(groupCollapseKey("reading", "By Status", "status")).toBe(
      "clepsydra.bases.groups.reading.by status.status",
    );
  });
});

describe("collapsed group storage", () => {
  it("round-trips a set of identities", () => {
    const storage = new MemoryStorage();
    const key = groupCollapseKey("reading", "shelf", "status");
    writeCollapsedGroups(storage, key, new Set(['"reading"', "null"]));
    expect(storage.items.get(key)).toBe('["\\"reading\\"","null"]');
    expect([...readCollapsedGroups(storage, key)]).toEqual([
      '"reading"',
      "null",
    ]);
  });

  it("reads nothing from a missing, malformed, or non-string entry", () => {
    const storage = new MemoryStorage();
    expect(readCollapsedGroups(storage, "k").size).toBe(0);
    storage.setItem("k", "{not json");
    expect(readCollapsedGroups(storage, "k").size).toBe(0);
    storage.setItem("k", '{"a":1}');
    expect(readCollapsedGroups(storage, "k").size).toBe(0);
    storage.setItem("k", '["x", 1, null]');
    expect([...readCollapsedGroups(storage, "k")]).toEqual(["x"]);
  });

  it("survives missing and throwing storage", () => {
    expect(readCollapsedGroups(undefined, "k").size).toBe(0);
    expect(() => writeCollapsedGroups(undefined, "k", new Set())).not.toThrow();
    expect(readCollapsedGroups(sealed, "k").size).toBe(0);
    expect(() =>
      writeCollapsedGroups(sealed, "k", new Set(["x"])),
    ).not.toThrow();
  });
});
