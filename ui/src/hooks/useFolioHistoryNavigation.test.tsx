import type { RouterHistory } from "@tanstack/history";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActivateTabWithFolioHistory,
  type LeaveFolioWorkspace,
  type OpenTabWithFolioHistory,
  useActivateTabWithFolioHistory,
  useFolioHistoryController,
  useLeaveFolioWorkspace,
  useOpenTabWithFolioHistory,
} from "#/hooks/useFolioHistoryNavigation";
import {
  clearFolioHistoryState,
  readFolioHistoryDestination,
  readFolioHistoryRestorationRequest,
  registerFolioHistoryCapture,
  type FolioRestoration,
} from "#/store/folioRestoration";
import {
  registerWorkspaceTransitionGuard,
  useWorkspaceStore,
} from "#/store/workspace";

type HistoryStateInput = {
  folioTabId?: string | null;
  folioPath?: string | null;
  folioLocationId?: string | null;
  folioOriginTabId?: string | null;
};

type HookControls = {
  open: OpenTabWithFolioHistory;
  activate: ActivateTabWithFolioHistory;
  leave: LeaveFolioWorkspace;
};

type MemoryHistory = RouterHistory;

let controls: HookControls | null = null;
const cleanups: Array<() => void> = [];

function pageState(
  tabId: string,
  path: string,
  locationId: string,
): HistoryStateInput {
  return {
    folioTabId: tabId,
    folioPath: path,
    folioLocationId: locationId,
  };
}

const graphState: HistoryStateInput = {
  folioTabId: null,
  folioPath: null,
  folioLocationId: null,
};

function restoration(tabId: string, path: string): FolioRestoration {
  return {
    tabId,
    path,
    revision: `revision-${tabId}`,
    scrollTop: 42,
    anchor: null,
    focus: null,
  };
}

function seedWorkspace(activeTabId = "alpha") {
  useWorkspaceStore.setState({
    tabs: [
      {
        id: "alpha",
        type: "page",
        path: "notes/alpha.md",
        label: "Alpha",
      },
      {
        id: "beta",
        type: "page",
        path: "notes/beta.md",
        label: "Beta",
      },
      { id: "graph", type: "graph", label: "Graph" },
    ],
    activeTabId,
    navigationMode: "smart",
    openHistory: [],
    quires: {},
  });
}

function memoryHistory(
  states: HistoryStateInput[],
  initialIndex = states.length - 1,
): MemoryHistory {
  const history = createMemoryHistory({
    initialEntries: states.map(() => "/workspace"),
  });
  history.go(-(states.length - 1), { ignoreBlocker: true });
  states.forEach((state, index) => {
    if (index > 0) history.forward({ ignoreBlocker: true });
    history.replace("/workspace", state, { ignoreBlocker: true });
  });
  if (initialIndex !== states.length - 1) {
    history.go(initialIndex - (states.length - 1), { ignoreBlocker: true });
  }
  return history;
}

function Probe() {
  useFolioHistoryController();
  controls = {
    open: useOpenTabWithFolioHistory(),
    activate: useActivateTabWithFolioHistory(),
    leave: useLeaveFolioWorkspace(),
  };
  return null;
}

function renderHarness({
  states = [{}],
  initialIndex,
}: {
  states?: HistoryStateInput[];
  initialIndex?: number;
} = {}) {
  const history = memoryHistory(states, initialIndex);
  const actions: string[] = [];
  cleanups.push(
    history.subscribe(({ action }) => {
      actions.push(action.type);
    }),
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspace",
    staticData: { codexView: "workspace" },
    component: Probe,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history,
  });
  render(<RouterProvider router={router} />);
  return { actions, history, router };
}

function currentControls(): HookControls {
  if (!controls) throw new Error("History hook controls have not mounted");
  return controls;
}

async function waitForController() {
  await waitFor(() => expect(controls).not.toBeNull());
}

function registerCapture(
  tabId: string,
  path: string,
  capture: () => FolioRestoration = () => restoration(tabId, path),
) {
  const unregister = registerFolioHistoryCapture(tabId, path, capture);
  cleanups.push(unregister);
  return unregister;
}

beforeEach(() => {
  controls = null;
  clearFolioHistoryState();
  seedWorkspace();
});

afterEach(() => {
  cleanup();
  while (cleanups.length > 0) cleanups.pop()?.();
  clearFolioHistoryState();
});

describe("Folio history initialization", () => {
  it("replaces an incomplete initial page entry without adding history", async () => {
    const { actions, history } = renderHarness();

    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).toMatchObject({
        folioTabId: "alpha",
        folioPath: "notes/alpha.md",
      }),
    );

    expect(history.length).toBe(1);
    expect(actions).toEqual(["REPLACE"]);
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
  });

  it("applies a complete initial tuple without replacing it", async () => {
    seedWorkspace("beta");
    const initial = pageState(
      "alpha",
      "notes/alpha.md",
      "location-alpha",
    );
    const { actions, history } = renderHarness({ states: [initial] });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeTabId).toBe("alpha"),
    );

    expect(actions).toEqual([]);
    expect(history.length).toBe(1);
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toMatchObject({
      request: {
        tabId: "alpha",
        path: "notes/alpha.md",
        locationId: "location-alpha",
      },
    });
  });
});

describe("programmatic Folio navigation", () => {
  it("captures the outgoing page before opening and pushes the actual page tuple", async () => {
    const { actions, history } = renderHarness();
    await waitForController();
    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).not.toBeNull(),
    );
    actions.splice(0);
    const order: string[] = [];
    registerCapture("alpha", "notes/alpha.md", () => {
      order.push(`capture:${useWorkspaceStore.getState().activeTabId}`);
      return restoration("alpha", "notes/alpha.md");
    });

    act(() => {
      currentControls().open("page", "notes/beta.md", "Beta");
    });

    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).toMatchObject({
        folioPath: "notes/beta.md",
      }),
    );
    const destination = readFolioHistoryDestination(history.location.state);
    expect(order).toEqual(["capture:alpha"]);
    expect(destination).toEqual({
      folioTabId: useWorkspaceStore.getState().activeTabId,
      folioPath: "notes/beta.md",
      folioLocationId: expect.any(String),
    });
    expect(actions).toEqual(["PUSH"]);
    expect(
      readFolioHistoryRestorationRequest(
        destination?.folioTabId ?? "",
        "notes/beta.md",
      ),
    ).toBeNull();
  });

  it("does nothing when opening the already-active page without a block target", async () => {
    const { actions, history } = renderHarness();
    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).not.toBeNull(),
    );
    actions.splice(0);
    let guardCalls = 0;
    let captureCalls = 0;
    cleanups.push(
      registerWorkspaceTransitionGuard(() => {
        guardCalls += 1;
        return true;
      }),
    );
    registerCapture("alpha", "notes/alpha.md", () => {
      captureCalls += 1;
      return restoration("alpha", "notes/alpha.md");
    });
    const entryCount = history.length;

    act(() => {
      currentControls().open("page", "notes/alpha.md", "Alpha");
    });

    expect(guardCalls).toBe(0);
    expect(captureCalls).toBe(0);
    expect(useWorkspaceStore.getState().activeTabId).toBe("alpha");
    expect(history.length).toBe(entryCount);
    expect(actions).toEqual([]);
  });

  it("waits for guarded approval before capture, mutation, and navigation", async () => {
    const { history } = renderHarness();
    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).not.toBeNull(),
    );
    let captureCalls = 0;
    registerCapture("alpha", "notes/alpha.md", () => {
      captureCalls += 1;
      return restoration("alpha", "notes/alpha.md");
    });
    let proceed: (() => void) | null = null;
    cleanups.push(
      registerWorkspaceTransitionGuard((approved) => {
        proceed = approved;
        return true;
      }),
    );
    const entryCount = history.length;

    act(() => {
      currentControls().open("page", "notes/beta.md", "Beta");
    });

    expect(captureCalls).toBe(0);
    expect(useWorkspaceStore.getState().activeTabId).toBe("alpha");
    expect(history.length).toBe(entryCount);

    act(() => proceed?.());

    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).toMatchObject({
        folioPath: "notes/beta.md",
      }),
    );
    expect(captureCalls).toBe(1);
    expect(useWorkspaceStore.getState().activeTabId).not.toBe("alpha");
    expect(history.length).toBe(entryCount + 1);
  });

  it("pushes a fresh tuple when activating an existing page tab", async () => {
    const { actions, history } = renderHarness();
    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).not.toBeNull(),
    );
    const outgoing = readFolioHistoryDestination(history.location.state);
    actions.splice(0);
    registerCapture("alpha", "notes/alpha.md");

    act(() => currentControls().activate("beta"));

    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).toMatchObject({
        folioTabId: "beta",
        folioPath: "notes/beta.md",
      }),
    );
    const destination = readFolioHistoryDestination(history.location.state);
    expect(destination?.folioLocationId).not.toBe(outgoing?.folioLocationId);
    expect(useWorkspaceStore.getState().activeTabId).toBe("beta");
    expect(actions).toEqual(["PUSH"]);
  });

  it("clears every Folio destination field for graph entries", async () => {
    const { history } = renderHarness();
    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).not.toBeNull(),
    );
    registerCapture("alpha", "notes/alpha.md");

    act(() => currentControls().open("graph"));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeTabId).toBe("graph"),
    );
    expect(history.location.state).toMatchObject({
      folioTabId: null,
      folioPath: null,
      folioLocationId: null,
    });
    expect(readFolioHistoryDestination(history.location.state)).toBeNull();
  });

  it("captures before invoking a guarded programmatic departure", async () => {
    const { history } = renderHarness();
    await waitFor(() =>
      expect(readFolioHistoryDestination(history.location.state)).not.toBeNull(),
    );
    const order: string[] = [];
    registerCapture("alpha", "notes/alpha.md", () => {
      order.push("capture");
      return restoration("alpha", "notes/alpha.md");
    });
    let proceed: (() => void) | null = null;
    cleanups.push(
      registerWorkspaceTransitionGuard((approved) => {
        proceed = approved;
        return true;
      }),
    );

    act(() => {
      currentControls().leave(() => order.push("navigate"));
    });
    expect(order).toEqual([]);

    act(() => proceed?.());
    expect(order).toEqual(["capture", "navigate"]);
  });
});

describe("native history tuple application", () => {
  it.each([
    {
      action: "BACK",
      initialIndex: 1,
      activeTabId: "beta",
      outgoingPath: "notes/beta.md",
      expectedTabId: "alpha",
      travel: (history: MemoryHistory) => history.back(),
    },
    {
      action: "FORWARD",
      initialIndex: 0,
      activeTabId: "alpha",
      outgoingPath: "notes/alpha.md",
      expectedTabId: "beta",
      travel: (history: MemoryHistory) => history.forward(),
    },
    {
      action: "GO",
      initialIndex: 1,
      activeTabId: "beta",
      outgoingPath: "notes/beta.md",
      expectedTabId: "alpha",
      travel: (history: MemoryHistory) => history.go(-1),
    },
  ])(
    "applies $action synchronously without recursive history or guard entry",
    async ({
      action,
      initialIndex,
      activeTabId,
      outgoingPath,
      expectedTabId,
      travel,
    }) => {
      seedWorkspace(activeTabId);
      const { actions, history } = renderHarness({
        states: [
          pageState("alpha", "notes/alpha.md", "location-alpha"),
          pageState("beta", "notes/beta.md", "location-beta"),
        ],
        initialIndex,
      });
      await waitForController();
      actions.splice(0);
      let captureCalls = 0;
      registerCapture(activeTabId, outgoingPath, () => {
        captureCalls += 1;
        return restoration(activeTabId, outgoingPath);
      });
      let guardCalls = 0;
      cleanups.push(
        registerWorkspaceTransitionGuard(() => {
          guardCalls += 1;
          return true;
        }),
      );

      act(() => travel(history));

      await waitFor(() =>
        expect(useWorkspaceStore.getState().activeTabId).toBe(expectedTabId),
      );
      expect(captureCalls).toBe(1);
      expect(guardCalls).toBe(0);
      expect(actions).toEqual([action]);
      const expectedPath = `notes/${expectedTabId}.md`;
      expect(
        readFolioHistoryRestorationRequest(expectedTabId, expectedPath),
      ).toMatchObject({
        request: {
          tabId: expectedTabId,
          path: expectedPath,
          locationId: `location-${expectedTabId}`,
        },
      });
    },
  );

  it.each([
    {
      case: "missing tab ID",
      destination: pageState(
        "missing",
        "notes/alpha.md",
        "location-missing",
      ),
    },
    {
      case: "mismatched tab path",
      destination: pageState(
        "alpha",
        "notes/renamed.md",
        "location-renamed",
      ),
    },
  ])("retains the current tab for a stale $case", async ({ destination }) => {
    seedWorkspace("beta");
    const { history } = renderHarness({
      states: [
        destination,
        pageState("beta", "notes/beta.md", "location-beta"),
      ],
    });
    await waitForController();
    let captureCalls = 0;
    registerCapture("beta", "notes/beta.md", () => {
      captureCalls += 1;
      return restoration("beta", "notes/beta.md");
    });

    act(() => history.back());

    expect(captureCalls).toBe(1);
    expect(useWorkspaceStore.getState().activeTabId).toBe("beta");
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
  });

  it("ignores graph entries after capturing the outgoing page", async () => {
    seedWorkspace("beta");
    const { history } = renderHarness({
      states: [
        graphState,
        pageState("beta", "notes/beta.md", "location-beta"),
      ],
    });
    await waitForController();
    let captureCalls = 0;
    registerCapture("beta", "notes/beta.md", () => {
      captureCalls += 1;
      return restoration("beta", "notes/beta.md");
    });

    act(() => history.back());

    expect(captureCalls).toBe(1);
    expect(useWorkspaceStore.getState().activeTabId).toBe("beta");
    expect(readFolioHistoryDestination(history.location.state)).toBeNull();
  });
});

