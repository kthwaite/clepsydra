import type * as Router from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Route } from "#/routes/pages/$";
import { useWorkspaceStore } from "#/store/workspace";

const navigation = vi.hoisted(() => ({
  location: { pathname: "/pages/reference.md", hash: "Second section" },
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useLocation: ({
    select,
  }: {
    select: (location: typeof navigation.location) => unknown;
  }) => select(navigation.location),
  useNavigate: () => navigation.navigate,
}));

afterEach(() => vi.restoreAllMocks());

it("preserves the passage when the outgoing redirect remounts during workspace navigation", () => {
  vi.spyOn(Route, "useParams").mockReturnValue({ _splat: "reference.md" });
  useWorkspaceStore.setState({ tabs: [], activeTabId: null, quires: {} });
  const Redirect = Route.options.component;
  if (!Redirect) throw new Error("Missing page redirect");

  const first = render(<Redirect />);
  expect(useWorkspaceStore.getState().tabs[0]?.focusHeading).toBe(
    "Second section",
  );
  first.unmount();

  navigation.location = { pathname: "/workspace", hash: "" };
  render(<Redirect />);
  const state = useWorkspaceStore.getState();
  expect(
    state.takeTabFocus(
      state.activeTabId ?? "",
      state.tabs[0]?.focusRequestId ?? "",
    ),
  ).toEqual({ heading: "Second section", blockId: undefined });
});
