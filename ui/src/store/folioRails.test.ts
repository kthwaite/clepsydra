import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

let storage: Storage;
beforeEach(() => {
  storage = fakeStorage({ "clp.folio.l.collapsed": "1" });
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

async function load() {
  return import("#/store/folioRails");
}

describe("folioRails", () => {
  it("reads the collapsed state users already have stored", async () => {
    const { useFolioRails, FOLIO_LEFT_RAIL, FOLIO_RIGHT_RAIL } = await load();
    expect(useFolioRails.getState().isCollapsed(FOLIO_LEFT_RAIL)).toBe(true);
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(false);
  });

  it("toggles one side and persists it in the existing key", async () => {
    const { useFolioRails, FOLIO_RIGHT_RAIL } = await load();
    useFolioRails.getState().toggle(FOLIO_RIGHT_RAIL);
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(true);
    expect(storage.getItem("clp.folio.r.collapsed")).toBe("1");
  });

  it("toggleBoth collapses both when either is open, else opens both", async () => {
    const { useFolioRails, FOLIO_LEFT_RAIL, FOLIO_RIGHT_RAIL } = await load();
    const s = () => useFolioRails.getState();
    s().toggleBoth(); // left collapsed, right open → collapse both
    expect(s().isCollapsed(FOLIO_LEFT_RAIL)).toBe(true);
    expect(s().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(true);
    s().toggleBoth(); // both collapsed → open both
    expect(s().isCollapsed(FOLIO_LEFT_RAIL)).toBe(false);
    expect(s().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(false);
  });
});
