import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { navigateMock, routeMatchesRef, routerHistory } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  routeMatchesRef: {
    current: [{ staticData: { codexView: "workspace" } }] as Array<{
      staticData?: { codexView?: string };
    }>,
  },
  routerHistory: { location: { state: {} } },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ history: routerHistory }),
  useRouterState: ({
    select,
  }: {
    select: (s: { matches: typeof routeMatchesRef.current }) => unknown;
  }) => select({ matches: routeMatchesRef.current }),
}));

import { useOpenTab } from "#/hooks/useOpenTab";
import { readFolioHistoryDestination } from "#/store/folioRestoration";
import {
  registerWorkspaceTransitionGuard,
  useWorkspaceStore,
} from "#/store/workspace";

const ON_WORKSPACE_ROUTE = [
  { staticData: { codexView: "atrium" } },
  { staticData: { codexView: "workspace" } },
];
const OFF_WORKSPACE_ROUTE = [
  { staticData: { codexView: "atrium" } },
  { staticData: { codexView: "gazetteer" } },
];

beforeEach(() => {
  navigateMock.mockReset();
  routeMatchesRef.current = ON_WORKSPACE_ROUTE;
  useWorkspaceStore.setState({
    tabs: [
      { id: "alpha", type: "page", path: "notes/alpha.md", label: "Alpha" },
    ],
    activeTabId: "alpha",
    navigationMode: "smart",
    openHistory: [],
    quires: {},
  });
});

it("keeps the workspace and route unchanged until a guarded page open proceeds", () => {
  let proceed: (() => void) | null = null;
  const unregister = registerWorkspaceTransitionGuard((pending) => {
    proceed = pending;
    return true;
  });
  const { result } = renderHook(() => useOpenTab());

  act(() => {
    result.current("page", "notes/beta.md", "Beta");
  });

  expect(useWorkspaceStore.getState().activeTabId).toBe("alpha");
  expect(navigateMock).not.toHaveBeenCalled();

  act(() => proceed?.());
  const active = useWorkspaceStore
    .getState()
    .tabs.find((tab) => tab.id === useWorkspaceStore.getState().activeTabId);
  expect(active?.path).toBe("notes/beta.md");
  expect(navigateMock).toHaveBeenCalledOnce();
  unregister();
});

it("stamps the outgoing active tab as folioOriginTabId when already on the workspace route", () => {
  routeMatchesRef.current = ON_WORKSPACE_ROUTE;
  const { result } = renderHook(() => useOpenTab());

  act(() => {
    result.current("page", "notes/beta.md", "Beta");
  });

  expect(navigateMock).toHaveBeenCalledOnce();
  const call = navigateMock.mock.calls[0][0];
  expect(call.to).toBe("/workspace");
  const state = call.state({});
  expect(state.folioOriginTabId).toBe("alpha");
  expect(readFolioHistoryDestination(state)).toEqual({
    folioTabId: useWorkspaceStore.getState().activeTabId,
    folioPath: "notes/beta.md",
    folioLocationId: expect.any(String),
  });
});

it("stamps folioOriginTabId as null when navigating from off the workspace route", () => {
  routeMatchesRef.current = OFF_WORKSPACE_ROUTE;
  const { result } = renderHook(() => useOpenTab());

  act(() => {
    result.current("page", "notes/beta.md", "Beta");
  });

  expect(navigateMock).toHaveBeenCalledOnce();
  const call = navigateMock.mock.calls[0][0];
  expect(call.to).toBe("/workspace");
  const state = call.state({});
  expect(state.folioOriginTabId).toBeNull();
  expect(readFolioHistoryDestination(state)).toEqual({
    folioTabId: useWorkspaceStore.getState().activeTabId,
    folioPath: "notes/beta.md",
    folioLocationId: expect.any(String),
  });
});
