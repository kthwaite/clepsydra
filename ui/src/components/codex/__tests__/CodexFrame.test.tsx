import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NAV_LABELS = [
  "ATRIUM",
  "FOLIO",
  "GAZETTEER",
  "CONSTELLATION",
  "TASKING",
  "BASES",
  "DOCS",
];

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
  Link: ({
    children,
    to,
    params,
    onClick,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
    [key: string]: unknown;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onClick?.(event);
          navigateMock(params ? { to, params } : { to });
        }}
      >
        {children}
      </a>
    );
  },
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

function primaryNavigation() {
  return within(screen.getByRole("navigation", { name: "Primary navigation" }));
}

describe("CodexFrame Docs integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locationState.pathname = "/docs/getting-started";
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
  });

  it("renders a nested Docs guide as the active shell view", () => {
    renderFrame();

    expect(
      primaryNavigation().getByRole("link", { name: /06.*DOCS/i }),
    ).toHaveClass("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(
      screen.getByRole("button", { name: /07.*STATUS/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
    expect(screen.getByText(/FILE DOC-001.*VIEW DOCS/)).toBeInTheDocument();
    expect(screen.queryByText("42%")).not.toBeInTheDocument();
    expect(screen.getByText("Frame content")).toBeInTheDocument();
  });

  it("recognizes the exact Docs root path", () => {
    locationState.pathname = "/docs";
    renderFrame();

    expect(
      primaryNavigation().getByRole("link", { name: /06.*DOCS/i }),
    ).toHaveClass("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(screen.getByText(/FILE DOC-001.*VIEW DOCS/)).toBeInTheDocument();
  });

  it.each([
    "/docs-old",
    "/docsfoo",
  ])("keeps near-prefix path %s in the Atrium fallback view", (pathname) => {
    locationState.pathname = pathname;
    renderFrame();

    expect(
      primaryNavigation().getByRole("link", { name: /00.*ATRIUM/i }),
    ).toHaveClass("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(
      primaryNavigation().getByRole("link", { name: /06.*DOCS/i }),
    ).not.toHaveClass("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(screen.getByText(/FILE ATRIUM.*VIEW ATRIUM/)).toBeInTheDocument();
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
  });

  it("navigates an inactive Docs item to the typed default guide route", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();

    const docsButton = primaryNavigation().getByRole("link", {
      name: /06.*DOCS/i,
    });
    expect(docsButton).not.toHaveClass(
      "shadow-[inset_0_-2px_0_0_var(--accent)]",
    );

    await user.click(docsButton);

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$slug",
      params: { slug: DEFAULT_DOC_SLUG },
    });
  });

  it.each([
    "/bases",
    "/bases/",
    "/bases/reading-log",
    "/bases/reading-log/edit",
  ])("keeps Bases active for deep link %s", (pathname) => {
    locationState.pathname = pathname;
    renderFrame();

    const basesButton = primaryNavigation().getByRole("link", {
      name: /05.*BASES/i,
    });
    expect(basesButton).toHaveClass("shadow-[inset_0_-2px_0_0_var(--accent)]");
    expect(basesButton).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/FILE BASES.*VIEW BASES/)).toBeInTheDocument();
  });

  it.each([
    "/bases-old",
    "/basesfoo",
  ])("does not treat near-prefix path %s as Bases", (pathname) => {
    locationState.pathname = pathname;
    renderFrame();

    expect(
      primaryNavigation().getByRole("link", { name: /05.*BASES/i }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.getByText(/FILE ATRIUM.*VIEW ATRIUM/)).toBeInTheDocument();
  });

  it("navigates to the Bases index and exposes one main landmark", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();

    const basesButton = primaryNavigation().getByRole("link", {
      name: /05.*BASES/i,
    });
    basesButton.focus();
    await user.keyboard("{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/bases" });
    expect(basesButton).toHaveFocus();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeInTheDocument();
  });

  it("starts keyboard navigation with a skip link targeting the sole main", async () => {
    const user = userEvent.setup();
    renderFrame();

    await user.tab();

    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("offers every destination in a compact mobile navigation menu", () => {
    locationState.pathname = "/";
    renderFrame();

    expect(
      screen.getByText("Navigation — Atrium", { selector: "summary" }),
    ).toBeInTheDocument();
    const mobileNav = screen.getByRole("navigation", {
      name: "Mobile primary navigation",
    });
    for (const destination of NAV_LABELS) {
      expect(within(mobileNav).getByText(destination)).toBeInTheDocument();
    }
    expect(
      within(mobileNav).getByRole("link", { name: /Bases/i }),
    ).toHaveAttribute("href", "/bases");
    expect(
      within(mobileNav).getByRole("link", { name: /Atrium/i }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("retains the reading percentage for Folio", () => {
    renderFrame("folio");

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByTestId("sheaf")).toBeInTheDocument();
  });
});
