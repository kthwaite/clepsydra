import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSearch: vi.fn(),
  openInscribe: vi.fn(),
  openLocation: vi.fn(),
  openTab: vi.fn(),
  openTodayJournal: vi.fn(),
  get: vi.fn(),
  workspaceState: {
    openHistory: [] as Array<{ path: string; openedAt: number }>,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => ({ academic: true, feeds: true }),
}));

vi.mock("#/api/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/api/index")>();
  return {
    ...actual,
    useTags: () => ({ data: [] }),
    useStats: () => ({ data: undefined }),
    useContentIndex: () => ({ data: { items: [] } }),
  };
});

vi.mock("#/api/bcl", () => ({
  useBcl: () => ({ data: undefined }),
}));

vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: undefined }),
}));

vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));

vi.mock("#/hooks/useClock", () => ({
  useClock: () => new Date("2026-08-09T12:00:00Z"),
}));

vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => false,
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mocks.openTab,
}));

vi.mock("#/hooks/useOpenTodayJournal", () => ({
  useOpenTodayJournal: () => mocks.openTodayJournal,
}));

vi.mock("#/store/ui", () => ({
  useUiStore: (
    selector: (state: {
      openSearch: typeof mocks.openSearch;
      openInscribe: typeof mocks.openInscribe;
      openLocation: typeof mocks.openLocation;
    }) => unknown,
  ) =>
    selector({
      openSearch: mocks.openSearch,
      openInscribe: mocks.openInscribe,
      openLocation: mocks.openLocation,
    }),
}));

vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (
    selector: (state: typeof mocks.workspaceState) => unknown,
  ) => selector(mocks.workspaceState),
}));

vi.mock("#/components/codex/ActivityHeatmap", () => ({
  ActivityHeatmap: () => <div data-testid="activity-heatmap" />,
}));

vi.mock("#/components/codex/FeedRiverPanel", () => ({
  FeedRiverPanel: () => <section aria-label="Feed river panel" />,
}));

vi.mock("#/components/codex/ReadingContinues", () => ({
  ReadingContinuesPanel: () => null,
}));

vi.mock("#/components/codex/SkyCard", () => ({
  SkyCard: () => <section aria-label="Sky" />,
}));

import { Atrium } from "#/components/codex/Atrium";
import { Stats } from "#/components/codex/Stats";
import { RepairWorkspace } from "#/components/repairs/RepairWorkspace";
import { queryClient as appQueryClient } from "#/lib/queryClient";

class TestErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    if (this.state.error) return <p>Application boundary rendered.</p>;
    return this.props.children;
  }
}

function productionPolicyClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        ...appQueryClient.getDefaultOptions().queries,
        retry: false,
      },
    },
  });
}

function renderWithProductionPolicy(children: ReactNode) {
  const client = productionPolicyClient();
  return render(
    <QueryClientProvider client={client}>
      <TestErrorBoundary>{children}</TestErrorBoundary>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.get.mockReset().mockResolvedValue({
    data: undefined,
    error: { error: "reference issue index unavailable" },
    response: new Response(null, { status: 503 }),
  });
  vi.spyOn(fetchClient, "GET").mockImplementation(mocks.get);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reference issue query production error policy", () => {
  it("contains repair and Stats failures while keeping Atrium independent", async () => {
    const user = userEvent.setup();
    const repairs = renderWithProductionPolicy(<RepairWorkspace />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reference issues could not load. reference issue index unavailable",
    );
    expect(
      screen.queryByText("Application boundary rendered."),
    ).not.toBeInTheDocument();

    repairs.unmount();
    mocks.get.mockClear();

    const atrium = renderWithProductionPolicy(<Atrium />);

    expect(screen.getByTestId("activity-heatmap")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Reference Repairs" }),
    ).not.toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalledWith(
      "/api/vault/index/issues",
      expect.anything(),
    );
    expect(
      screen.queryByText("Application boundary rendered."),
    ).not.toBeInTheDocument();

    atrium.unmount();
    mocks.get.mockClear();
    renderWithProductionPolicy(<Stats />);

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const fallback = screen.getByRole("button", {
      name: "Open Reference Repairs",
    });
    expect(fallback).toHaveTextContent("Repairs");
    expect(
      screen.queryByText("Application boundary rendered."),
    ).not.toBeInTheDocument();

    await user.click(fallback);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/repairs" });
  });
});
