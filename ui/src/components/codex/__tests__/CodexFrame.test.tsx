import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  locationState,
  navigateMock,
  openSearchMock,
  openSettingsMock,
  toggleThemeMock,
  workspaceState,
} = vi.hoisted(() => ({
  locationState: { pathname: "/docs/getting-started" },
  navigateMock: vi.fn(),
  openSearchMock: vi.fn(),
  openSettingsMock: vi.fn(),
  toggleThemeMock: vi.fn(),
  workspaceState: {
    tabs: [] as Array<{ id: string; type: string; path?: string }>,
    activeTabId: null as string | null,
    openTab: vi.fn(),
    activateTab: vi.fn(),
    clearActiveTab: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => 0,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => locationState,
  useNavigate: () => navigateMock,
}));
vi.mock("#/api/index", () => ({
  useStats: () => ({
    data: { pages: 12, links_total: 34, last_indexed_at: null },
    isError: false,
  }),
}));
vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ progress: 0.42 }),
}));
vi.mock("#/components/codex/Sheaf", () => ({
  Sheaf: () => <div data-testid="sheaf" />,
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    toggle: toggleThemeMock,
    resolvedTheme: "light",
    diegetic: false,
  }),
}));
vi.mock("#/hooks/useUptime", () => ({
  useUptime: () => "00:01",
}));
vi.mock("#/hooks/useVaultEvents", () => ({
  useVaultEvents: () => "connected",
}));
vi.mock("#/store/ui", () => ({
  useUiStore: (
    selector: (state: {
      openSearch: () => void;
      openSettings: () => void;
      isSettingsOpen: boolean;
    }) => unknown,
  ) =>
    selector({
      openSearch: openSearchMock,
      openSettings: openSettingsMock,
      isSettingsOpen: false,
    }),
}));
vi.mock("#/store/workspace", () => {
  const useWorkspaceStore = () => workspaceState;
  useWorkspaceStore.getState = () => workspaceState;
  return { useWorkspaceStore };
});

import { CodexFrame } from "#/components/codex/CodexFrame";
import { DEFAULT_DOC_SLUG } from "#/docs/registry";

function renderFrame(forceView?: "folio") {
  return render(
    <CodexFrame {...(forceView ? { forceView } : {})}>
      <section>Frame content</section>
    </CodexFrame>,
  );
}

describe("CodexFrame Docs integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locationState.pathname = "/docs/getting-started";
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
  });

  it("renders Docs as the active shell view", () => {
    renderFrame();

    expect(screen.getByRole("button", { name: /05.*DOCS/i })).toHaveClass(
      "shadow-[inset_0_-2px_0_0_var(--accent)]",
    );
    expect(
      screen.getByRole("button", { name: /06.*STATUS/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
    expect(screen.getByText(/FILE DOC-001.*VIEW DOCS/)).toBeInTheDocument();
    expect(screen.queryByText("42%")).not.toBeInTheDocument();
    expect(screen.getByText("Frame content")).toBeInTheDocument();
  });

  it("navigates an inactive Docs item to the typed default guide route", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();

    const docsButton = screen.getByRole("button", { name: /05.*DOCS/i });
    expect(docsButton).not.toHaveClass(
      "shadow-[inset_0_-2px_0_0_var(--accent)]",
    );

    await user.click(docsButton);

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$slug",
      params: { slug: DEFAULT_DOC_SLUG },
    });
  });

  it("retains the reading percentage for Folio", () => {
    renderFrame("folio");

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByTestId("sheaf")).toBeInTheDocument();
  });
});
