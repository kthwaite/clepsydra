import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/workspace" }),
  useNavigate: () => navigateMock,
}));

import {
  registerWorkspaceTransitionGuard,
  useWorkspaceStore,
} from "#/store/workspace";
import { useOpenTab } from "#/hooks/useOpenTab";

beforeEach(() => {
  navigateMock.mockReset();
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
