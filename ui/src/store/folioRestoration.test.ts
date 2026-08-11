import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFolioRestoration,
  type FolioRestoration,
  readFolioRestoration,
  saveFolioRestoration,
} from "#/store/folioRestoration";

const testTabIds = [
  "alpha",
  "beta",
  "storage",
  ...Array.from({ length: 17 }, (_, index) => `bounded-${index}`),
];

function restoration(
  tabId: string,
  path = `notes/${tabId}.md`,
): FolioRestoration {
  return {
    tabId,
    path,
    revision: `revision-${tabId}`,
    scrollTop: 120,
    anchor: { path: [0, 0], offset: 2, text: "restorable text" },
    focus: { path: [0, 0], offset: 5, text: "restorable text" },
  };
}

beforeEach(() => {
  for (const tabId of testTabIds) clearFolioRestoration(tabId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("folio restoration store", () => {
  it("returns the record keyed by tab and matching page path", () => {
    const alpha = restoration("alpha");
    const beta = restoration("beta");
    saveFolioRestoration(alpha);
    saveFolioRestoration(beta);

    expect(readFolioRestoration("alpha", "notes/alpha.md")).toEqual(alpha);
    expect(readFolioRestoration("beta", "notes/beta.md")).toEqual(beta);
  });

  it("rejects a saved record when the tab now points at another path", () => {
    const alpha = restoration("alpha");
    saveFolioRestoration(alpha);

    expect(readFolioRestoration("alpha", "notes/renamed.md")).toBeNull();
    expect(readFolioRestoration("alpha", "notes/alpha.md")).toEqual(alpha);
  });

  it("removes a tab record explicitly", () => {
    saveFolioRestoration(restoration("alpha"));
    clearFolioRestoration("alpha");
    expect(readFolioRestoration("alpha", "notes/alpha.md")).toBeNull();
  });

  it("evicts the oldest record when a seventeenth tab is saved", () => {
    for (let index = 0; index < 17; index += 1) {
      saveFolioRestoration(restoration(`bounded-${index}`));
    }

    expect(readFolioRestoration("bounded-0", "notes/bounded-0.md")).toBeNull();
    expect(readFolioRestoration("bounded-1", "notes/bounded-1.md")).not.toBeNull();
    expect(readFolioRestoration("bounded-16", "notes/bounded-16.md")).not.toBeNull();
  });

  it("keeps save, read, and clear entirely out of localStorage", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    saveFolioRestoration(restoration("storage"));
    readFolioRestoration("storage", "notes/storage.md");
    clearFolioRestoration("storage");

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
