import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureFolioHistoryLocation,
  clearFolioHistoryForTab,
  clearFolioHistoryState,
  clearFolioRestoration,
  type FolioRestoration,
  readFolioHistoryDestination,
  readFolioHistoryLocation,
  readFolioHistoryRestorationRequest,
  readFolioRestoration,
  registerFolioHistoryCapture,
  requestFolioHistoryRestoration,
  saveFolioRestoration,
  subscribeFolioHistoryRestorationRequests,
  consumeFolioHistoryRestorationRequest,
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

function capture(tabId: string, scrollTop: number): () => void {
  return registerFolioHistoryCapture(
    tabId,
    `notes/${tabId}.md`,
    () => ({
      ...restoration(tabId),
      scrollTop,
    }),
  );
}

beforeEach(() => {
  for (const tabId of testTabIds) clearFolioRestoration(tabId);
  clearFolioHistoryState();
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
    expect(
      readFolioRestoration("bounded-1", "notes/bounded-1.md"),
    ).not.toBeNull();
    expect(
      readFolioRestoration("bounded-16", "notes/bounded-16.md"),
    ).not.toBeNull();
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

describe("Folio history restoration registry", () => {
  it("decodes only a complete string-valued history destination tuple", () => {
    const state = {
      folioTabId: "alpha",
      folioPath: "notes/alpha.md",
      folioLocationId: "history-alpha",
      unrelated: true,
    };

    expect(readFolioHistoryDestination(state)).toEqual({
      folioTabId: "alpha",
      folioPath: "notes/alpha.md",
      folioLocationId: "history-alpha",
    });
    expect(readFolioHistoryDestination(null)).toBeNull();
    expect(
      readFolioHistoryDestination({
        folioTabId: "alpha",
        folioPath: "notes/alpha.md",
      }),
    ).toBeNull();
    expect(
      readFolioHistoryDestination({
        folioTabId: "alpha",
        folioPath: 7,
        folioLocationId: "history-alpha",
      }),
    ).toBeNull();
  });

  it.each([
    {
      emptyField: "folioTabId",
      state: {
        folioTabId: "",
        folioPath: "notes/alpha.md",
        folioLocationId: "history-alpha",
      },
    },
    {
      emptyField: "folioPath",
      state: {
        folioTabId: "alpha",
        folioPath: "",
        folioLocationId: "history-alpha",
      },
    },
    {
      emptyField: "folioLocationId",
      state: {
        folioTabId: "alpha",
        folioPath: "notes/alpha.md",
        folioLocationId: "",
      },
    },
  ])("rejects an empty $emptyField", ({ state }) => {
    expect(readFolioHistoryDestination(state)).toBeNull();
  });

  it("captures only the active tab and path and clones stored records and reads", () => {
    const source = restoration("alpha");
    let calls = 0;
    registerFolioHistoryCapture("alpha", "notes/alpha.md", () => {
      calls += 1;
      return source;
    });

    expect(
      captureFolioHistoryLocation(
        "wrong-tab",
        "beta",
        "notes/alpha.md",
      ),
    ).toBe(false);
    expect(
      captureFolioHistoryLocation(
        "wrong-path",
        "alpha",
        "notes/other.md",
      ),
    ).toBe(false);
    expect(calls).toBe(0);

    expect(
      captureFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(true);
    source.scrollTop = 999;
    source.anchor!.path[0] = 4;

    const first = readFolioHistoryLocation(
      "history-alpha",
      "alpha",
      "notes/alpha.md",
    );
    expect(first?.scrollTop).toBe(120);
    expect(first?.anchor?.path).toEqual([0, 0]);

    first!.focus!.path[0] = 8;
    expect(
      readFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      )?.focus?.path,
    ).toEqual([0, 0]);
  });

  it("rejects a captured record whose tab or path does not match the registration", () => {
    registerFolioHistoryCapture("alpha", "notes/alpha.md", () =>
      restoration("beta"),
    );
    expect(
      captureFolioHistoryLocation(
        "wrong-record-tab",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(false);

    registerFolioHistoryCapture("alpha", "notes/alpha.md", () =>
      restoration("alpha", "notes/other.md"),
    );
    expect(
      captureFolioHistoryLocation(
        "wrong-record-path",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(false);
  });

  it("replaces an existing location ID with the latest capture", () => {
    capture("alpha", 100);
    expect(
      captureFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(true);

    capture("alpha", 200);
    expect(
      captureFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(true);
    expect(
      readFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      )?.scrollTop,
    ).toBe(200);
  });

  it("refreshes replacement order before evicting the oldest of 65 records", () => {
    let scrollTop = 0;
    registerFolioHistoryCapture("alpha", "notes/alpha.md", () => ({
      ...restoration("alpha"),
      scrollTop,
    }));

    for (let index = 0; index < 64; index += 1) {
      scrollTop = index;
      expect(
        captureFolioHistoryLocation(
          `history-${index}`,
          "alpha",
          "notes/alpha.md",
        ),
      ).toBe(true);
    }
    scrollTop = 100;
    captureFolioHistoryLocation(
      "history-0",
      "alpha",
      "notes/alpha.md",
    );
    scrollTop = 64;
    captureFolioHistoryLocation(
      "history-64",
      "alpha",
      "notes/alpha.md",
    );

    expect(
      readFolioHistoryLocation(
        "history-1",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBeNull();
    expect(
      readFolioHistoryLocation(
        "history-0",
        "alpha",
        "notes/alpha.md",
      )?.scrollTop,
    ).toBe(100);
    expect(
      readFolioHistoryLocation(
        "history-2",
        "alpha",
        "notes/alpha.md",
      ),
    ).not.toBeNull();
    expect(
      readFolioHistoryLocation(
        "history-64",
        "alpha",
        "notes/alpha.md",
      ),
    ).not.toBeNull();
  });

  it("does not let a stale unregister clear a newer capture", () => {
    const unregisterFirst = capture("alpha", 100);
    const unregisterSecond = capture("alpha", 200);

    unregisterFirst();
    expect(
      captureFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(true);
    expect(
      readFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      )?.scrollTop,
    ).toBe(200);

    unregisterSecond();
    expect(
      captureFolioHistoryLocation(
        "history-after-unregister",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(false);
  });

  it("supersedes an older pending restoration request", () => {
    capture("alpha", 100);
    captureFolioHistoryLocation(
      "history-first",
      "alpha",
      "notes/alpha.md",
    );
    capture("beta", 200);
    captureFolioHistoryLocation(
      "history-second",
      "beta",
      "notes/beta.md",
    );

    requestFolioHistoryRestoration({
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "history-first",
    });
    requestFolioHistoryRestoration({
      tabId: "beta",
      path: "notes/beta.md",
      locationId: "history-second",
    });

    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
    expect(
      readFolioHistoryRestorationRequest("beta", "notes/beta.md"),
    ).toEqual({
      request: {
        tabId: "beta",
        path: "notes/beta.md",
        locationId: "history-second",
      },
      restoration: {
        ...restoration("beta"),
        scrollTop: 200,
      },
    });
  });

  it("exposes a matching pending request when its snapshot is absent", () => {
    requestFolioHistoryRestoration({
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "missing-history",
    });

    expect(
      readFolioHistoryRestorationRequest("beta", "notes/alpha.md"),
    ).toBeNull();
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/other.md"),
    ).toBeNull();
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toEqual({
      request: {
        tabId: "alpha",
        path: "notes/alpha.md",
        locationId: "missing-history",
      },
      restoration: null,
    });
  });

  it("consumes only the pending request with the matching location ID", () => {
    requestFolioHistoryRestoration({
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "history-alpha",
    });

    consumeFolioHistoryRestorationRequest("stale-history");
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).not.toBeNull();

    consumeFolioHistoryRestorationRequest("history-alpha");
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
  });

  it("notifies pending-request subscribers only when pending state changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFolioHistoryRestorationRequests(listener);
    const alpha = {
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "history-alpha",
    };

    requestFolioHistoryRestoration(alpha);
    expect(listener).toHaveBeenCalledTimes(1);

    consumeFolioHistoryRestorationRequest("stale-history");
    clearFolioHistoryForTab("beta");
    expect(listener).toHaveBeenCalledTimes(1);

    requestFolioHistoryRestoration(alpha);
    expect(listener).toHaveBeenCalledTimes(1);

    consumeFolioHistoryRestorationRequest("history-alpha");
    expect(listener).toHaveBeenCalledTimes(2);

    requestFolioHistoryRestoration(alpha);
    clearFolioHistoryForTab("alpha");
    expect(listener).toHaveBeenCalledTimes(4);

    requestFolioHistoryRestoration(alpha);
    clearFolioHistoryState();
    clearFolioHistoryState();
    expect(listener).toHaveBeenCalledTimes(6);

    unsubscribe();
    requestFolioHistoryRestoration(alpha);
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it("clears records, capture, and pending restoration for one tab only", () => {
    capture("alpha", 100);
    captureFolioHistoryLocation(
      "history-alpha",
      "alpha",
      "notes/alpha.md",
    );
    capture("beta", 200);
    captureFolioHistoryLocation(
      "history-beta",
      "beta",
      "notes/beta.md",
    );
    capture("alpha", 300);
    requestFolioHistoryRestoration({
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "history-alpha",
    });

    clearFolioHistoryForTab("alpha");

    expect(
      readFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBeNull();
    expect(
      readFolioHistoryLocation(
        "history-beta",
        "beta",
        "notes/beta.md",
      ),
    ).not.toBeNull();
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
    expect(
      captureFolioHistoryLocation(
        "history-after-clear",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(false);
  });

  it("keeps every history operation out of localStorage and resets deterministically", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    readFolioHistoryDestination({
      folioTabId: "alpha",
      folioPath: "notes/alpha.md",
      folioLocationId: "history-alpha",
    });
    capture("alpha", 100);
    captureFolioHistoryLocation(
      "history-alpha",
      "alpha",
      "notes/alpha.md",
    );
    readFolioHistoryLocation(
      "history-alpha",
      "alpha",
      "notes/alpha.md",
    );
    requestFolioHistoryRestoration({
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "history-alpha",
    });
    readFolioHistoryRestorationRequest("alpha", "notes/alpha.md");
    consumeFolioHistoryRestorationRequest("stale-history");
    clearFolioHistoryForTab("beta");
    clearFolioHistoryState();

    expect(
      readFolioHistoryLocation(
        "history-alpha",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBeNull();
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
    expect(
      captureFolioHistoryLocation(
        "history-after-reset",
        "alpha",
        "notes/alpha.md",
      ),
    ).toBe(false);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
