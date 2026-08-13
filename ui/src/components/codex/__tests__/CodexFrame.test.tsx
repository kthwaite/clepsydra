import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  locationState,
  locationHookMock,
  mobileLayoutState,
  navigateMock,
  openInscribeMock,
  openLocationMock,
  openSearchMock,
  openSettingsMock,
  referenceIssuesState,
  toggleThemeMock,
  workspaceState,
} = vi.hoisted(() => ({
  locationState: { pathname: "/docs/getting-started" },
  locationHookMock: vi.fn(),
  mobileLayoutState: { matches: false },
  navigateMock: vi.fn(),
  openInscribeMock: vi.fn(),
  openLocationMock: vi.fn(),
  openSearchMock: vi.fn(),
  openSettingsMock: vi.fn(),
  referenceIssuesState: { total: 7 },
  toggleThemeMock: vi.fn(),
  workspaceState: {
    tabs: [] as Array<{ id: string; type: string; path?: string }>,
    activeTabId: null as string | null,
    openHistory: [] as Array<{ path: string; openedAt: number }>,
    openTab: vi.fn(),
    activateTab: vi.fn(),
    clearActiveTab: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useIsMutating: () => 0,
}));
const TEST_ROUTE_VIEWS: ReadonlyArray<[prefix: string, view: string]> = [
  ["/workspace", "workspace"],
  ["/gazetteer", "gazetteer"],
  ["/tasking", "tasking"],
  ["/academic", "academic"],
  ["/bases", "bases"],
  ["/feeds", "feeds"],
  ["/docs", "docs"],
  ["/repairs", "repairs"],
  ["/agenda", "agenda"],
];

function testMatches(pathname: string) {
  const hit = TEST_ROUTE_VIEWS.find(
    ([p]) => pathname === p || pathname.startsWith(`${p}/`),
  );
  return [
    { staticData: { codexView: "atrium" } },
    ...(hit ? [{ staticData: { codexView: hit[1] } }] : []),
  ];
}

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => {
    locationHookMock();
    return locationState;
  },
  useNavigate: () => navigateMock,
  useRouterState: ({
    select,
  }: {
    select: (s: { matches: unknown[] }) => unknown;
  }) => select({ matches: testMatches(locationState.pathname) }),
}));
vi.mock("#/api/index", () => ({
  useContentIndex: () => ({ data: { items: [] } }),
  useReferenceIssues: () => ({
    data: { items: [], limit: 1, offset: 0, total: referenceIssuesState.total },
  }),
  useStats: () => ({
    data: {
      pages: 12,
      links_total: 34,
      links_unresolved: 2,
      tags: 3,
      orphan_pages: 1,
      isolated_pages: 1,
      attachments: 4,
      last_indexed_at: null,
    },
    isError: false,
  }),
  useTags: () => ({ data: [] }),
}));
vi.mock("#/api/bcl", () => ({
  useBcl: () => ({ data: undefined }),
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: undefined }),
}));
vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));
vi.mock("#/components/codex/ActivityHeatmap", () => ({
  ActivityHeatmap: () => null,
}));
vi.mock("#/components/codex/FeedRiverPanel", () => ({
  FeedRiverPanel: () => null,
}));
vi.mock("#/components/codex/ReadingContinues", () => ({
  ReadingContinuesPanel: () => null,
}));
vi.mock("#/components/codex/SkyCard", () => ({
  SkyCard: () => null,
}));
vi.mock("#/hooks/useClock", () => ({
  useClock: () => new Date("2026-08-12T12:00:00Z"),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => workspaceState.openTab,
}));
vi.mock("#/hooks/useOpenTodayJournal", () => ({
  useOpenTodayJournal: () => vi.fn(),
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
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/store/ui", () => ({
  useUiStore: (
    selector: (state: {
      openInscribe: () => void;
      openLocation: () => void;
      openSearch: () => void;
      openSettings: () => void;
      isSettingsOpen: boolean;
    }) => unknown,
  ) =>
    selector({
      openInscribe: openInscribeMock,
      openLocation: openLocationMock,
      openSearch: openSearchMock,
      openSettings: openSettingsMock,
      isSettingsOpen: false,
    }),
}));
vi.mock("#/store/workspace", () => {
  const useWorkspaceStore = (
    selector?: (state: typeof workspaceState) => unknown,
  ) => (selector ? selector(workspaceState) : workspaceState);
  useWorkspaceStore.getState = () => workspaceState;
  const selectActiveTab = (state: typeof workspaceState) =>
    state.tabs.find((t) => t.id === state.activeTabId);
  const selectWorkspaceMode = (state: typeof workspaceState) => {
    const active = selectActiveTab(state);
    if (active?.type === "graph") return "constellation";
    if (active?.type === "page" && active.path) return "folio";
    return "launcher";
  };
  return {
    runWorkspaceTransition: (transition: () => void) => {
      transition();
      return true;
    },
    selectActiveTab,
    selectWorkspaceMode,
    useWorkspaceStore,
  };
});

import { Atrium } from "#/components/codex/Atrium";
import { CodexFrame } from "#/components/codex/CodexFrame";
import { DEFAULT_DOC_SLUG } from "#/docs/registry";

function renderFrame(forceView?: "folio") {
  return render(
    <CodexFrame {...(forceView ? { forceView } : {})}>
      <section>Frame content</section>
    </CodexFrame>,
  );
}

function StatefulRouteProbe({
  onMount,
  onUnmount,
  persistDraft,
}: {
  onMount: () => void;
  onUnmount: () => void;
  persistDraft: (draft: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    onMount();
    return () => {
      onUnmount();
      void persistDraft(draftRef.current).catch(() => undefined);
    };
  }, [onMount, onUnmount, persistDraft]);

  return (
    <>
      <label>
        Draft
        <input
          aria-label="Routed draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => void persistDraft(draft).catch(() => undefined)}
      >
        Attempt draft save
      </button>
    </>
  );
}

describe("Atrium repair entry point", () => {
  it("exposes the reference issue count and opens repairs", async () => {
    const user = userEvent.setup();
    render(<Atrium />);

    const repairs = screen.getByRole("button", {
      name: "Open Reference Repairs, 7 issues",
    });
    expect(repairs).toHaveTextContent("7 issues");

    await user.click(repairs);

    expect(navigateMock).toHaveBeenCalledWith({ to: "/repairs" });
  });
});

describe("CodexFrame destination integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = false;
    locationState.pathname = "/docs/getting-started";
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
  });

  it.each(["/docs", "/docs/getting-started"])(
    "renders Docs as the active shell view for %s",
    (pathname) => {
      locationState.pathname = pathname;
      renderFrame();

      const docsButton = within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      ).getByRole("button", { name: /08.*DOCS/i });
      expect(docsButton).toHaveAttribute("aria-current", "page");
      expect(
        screen.queryByRole("button", { name: /08.*STATUS/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
      expect(screen.getByText(/FILE DOC-001.*VIEW DOCS/)).toBeInTheDocument();
    },
  );

  it.each(["/docs-old", "/docsfoo"])(
    "keeps near-prefix Docs path %s in Atrium",
    (pathname) => {
      locationState.pathname = pathname;
      renderFrame();

      const nav = within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      );
      expect(nav.getByRole("button", { name: /00.*ATRIUM/i })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(
        nav.getByRole("button", { name: /08.*DOCS/i }),
      ).not.toHaveAttribute("aria-current");
    },
  );

  it("navigates Docs to the typed default guide route", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();

    await user.click(
      within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      ).getByRole("button", { name: /08.*DOCS/i }),
    );

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$slug",
      params: { slug: DEFAULT_DOC_SLUG },
    });
  });

  it("renders Feeds as a full-surface desktop destination before Docs", () => {
    locationState.pathname = "/feeds";
    renderFrame();

    const nav = within(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    );
    const feedsButton = nav.getByRole("button", { name: /07.*FEEDS/i });
    const docsButton = nav.getByRole("button", { name: /08.*DOCS/i });

    expect(feedsButton).toHaveAttribute("aria-current", "page");
    expect(
      feedsButton.compareDocumentPosition(docsButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /08.*STATUS/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
    expect(screen.getByText(/FILE FEEDS.*VIEW FEEDS/)).toBeInTheDocument();
  });

  it("navigates to the Feeds index from the desktop rail", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();

    await user.click(
      within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      ).getByRole("button", { name: /07.*FEEDS/i }),
    );

    expect(navigateMock).toHaveBeenCalledWith({ to: "/feeds" });
  });

  it.each([
    "/bases",
    "/bases/",
    "/bases/reading-log",
    "/bases/reading-log/edit",
  ])("keeps Bases active for deep link %s", (pathname) => {
    locationState.pathname = pathname;
    renderFrame();

    const basesButton = within(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).getByRole("button", { name: /06.*BASES/i });
    expect(basesButton).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
    expect(screen.getByText(/FILE BASES.*VIEW BASES/)).toBeInTheDocument();
  });

  it.each(["/bases-old", "/basesfoo"])(
    "does not treat near-prefix path %s as Bases",
    (pathname) => {
      locationState.pathname = pathname;
      renderFrame();

      const nav = within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      );
      expect(
        nav.getByRole("button", { name: /06.*BASES/i }),
      ).not.toHaveAttribute("aria-current");
      expect(nav.getByRole("button", { name: /00.*ATRIUM/i })).toHaveAttribute(
        "aria-current",
        "page",
      );
    },
  );

  it("navigates to the Bases index", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();

    await user.click(
      within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      ).getByRole("button", { name: /06.*BASES/i }),
    );

    expect(navigateMock).toHaveBeenCalledWith({ to: "/bases" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("marks Academic active and navigates to its library", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/academic";
    renderFrame();

    const academic = within(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).getByRole("button", { name: /05.*ACADEMIC/i });
    expect(academic).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/FILE ACADEMIC.*VIEW ACADEMIC/)).toBeVisible();
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();

    await user.click(academic);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/academic" });
  });

  it("shows the launcher state on /workspace with no active tab", () => {
    locationState.pathname = "/workspace";
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
    renderFrame();

    expect(screen.getByText(/FILE —.*VIEW LAUNCHER/)).toBeInTheDocument();
    expect(screen.getByTestId("sheaf")).toBeInTheDocument();

    const folioButton = within(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).getByRole("button", { name: /01.*FOLIO/i });
    expect(folioButton).toHaveAttribute("aria-current", "page");
  });

  it("retains the reading percentage for Folio", () => {
    renderFrame("folio");

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByTestId("sheaf")).toBeInTheDocument();
  });

  it("does not re-render the shell when the UTC clock ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    renderFrame();
    const callsAfterRender = locationHookMock.mock.calls.length;
    expect(callsAfterRender).toBeGreaterThan(0);

    act(() => vi.advanceTimersByTime(1000));

    expect(locationHookMock).toHaveBeenCalledTimes(callsAfterRender);
    vi.useRealTimers();
  });
});

describe("CodexFrame responsive shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locationState.pathname = "/";
    mobileLayoutState.matches = false;
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
  });

  it("retains the desktop header and footer", () => {
    renderFrame();

    expect(
      screen.getByRole("button", { name: "CLEPSYDRA — return to Atrium" }),
    ).toBeVisible();
    expect(screen.getByText(/FILE ATRIUM.*VIEW ATRIUM/)).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Mobile roots" }),
    ).not.toBeInTheDocument();
  });

  it("shows the six roots and global actions in the mobile chrome", () => {
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    expect(within(roots).getAllByRole("button")).toHaveLength(6);
    expect(
      within(roots).getByRole("button", { name: "Atrium" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(roots).getByRole("button", { name: "Gazetteer" }),
    ).toBeVisible();
    expect(within(roots).getByRole("button", { name: "Bases" })).toBeVisible();
    expect(within(roots).getByRole("button", { name: "Feeds" })).toBeVisible();
    expect(
      within(roots).getByRole("button", { name: "Academic" }),
    ).toBeVisible();
    expect(
      within(roots).getByRole("button", { name: "Constellation" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New note" })).toBeVisible();
    expect(screen.queryByText("TASKING")).not.toBeInTheDocument();
    expect(screen.getByText("Frame content")).toBeInTheDocument();
  });

  it.each([
    ["mobile", true],
    ["desktop", false],
  ] as const)(
    "keeps %s bottom chrome after the routed content in DOM order",
    (_label, mobile) => {
      mobileLayoutState.matches = mobile;
      renderFrame();

      const main = document.querySelector("main");
      const bottomChrome = mobile
        ? screen.getByRole("navigation", { name: "Mobile roots" })
        : document.querySelector("footer");

      if (!main || !bottomChrome) {
        throw new Error("Expected main and responsive bottom chrome");
      }
      expect(
        main.compareDocumentPosition(bottomChrome) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    },
  );

  it("wires the mobile global actions and Constellation root", async () => {
    const user = userEvent.setup();
    mobileLayoutState.matches = true;
    renderFrame();

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.click(screen.getByRole("button", { name: "Constellation" }));

    expect(openSearchMock).toHaveBeenCalledOnce();
    expect(openInscribeMock).toHaveBeenCalledOnce();
    // Navigation to /workspace is now useOpenTab's responsibility (mocked
    // above as workspaceState.openTab); see useOpenTab.test.tsx.
    expect(workspaceState.openTab).toHaveBeenCalledWith("graph");
  });

  it("marks Bases active on mobile and navigates to its index", async () => {
    const user = userEvent.setup();
    mobileLayoutState.matches = true;
    locationState.pathname = "/bases/reading-log/edit";
    renderFrame();

    const bases = within(
      screen.getByRole("navigation", { name: "Mobile roots" }),
    ).getByRole("button", { name: "Bases" });
    expect(bases).toHaveAttribute("aria-current", "page");

    await user.click(bases);

    expect(navigateMock).toHaveBeenCalledWith({ to: "/bases" });
  });

  it("marks Feeds active on mobile and navigates to its index", async () => {
    const user = userEvent.setup();
    mobileLayoutState.matches = true;
    locationState.pathname = "/feeds";
    renderFrame();

    const feeds = within(
      screen.getByRole("navigation", { name: "Mobile roots" }),
    ).getByRole("button", { name: "Feeds" });
    expect(feeds).toHaveAttribute("aria-current", "page");
    expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();

    await user.click(feeds);

    expect(navigateMock).toHaveBeenCalledWith({ to: "/feeds" });
  });

  it("keeps the desktop rail at tablet widths by scoping overflow to primary navigation", () => {
    mobileLayoutState.matches = false;
    locationState.pathname = "/feeds";
    renderFrame();

    const header = screen.getByRole("banner");
    const primary = screen.getByRole("navigation", {
      name: "Primary navigation",
    });
    const feeds = within(primary).getByRole("button", {
      name: /07.*feeds/i,
    });

    expect(header).toHaveClass("min-w-0");
    expect(primary).toHaveClass("min-w-0", "overflow-x-auto");
    expect(feeds).toHaveClass("shrink-0");
    expect(feeds).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /⌘K/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Switch to dark mode" }),
    ).toBeVisible();
  });

  it("fits six 44px mobile targets at 320px with short labels and full accessible names", () => {
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    const expectedRoots = [
      ["Atrium", "ATR"],
      ["Gazetteer", "GAZ"],
      ["Academic", "ACAD"],
      ["Bases", "BASE"],
      ["Feeds", "FEED"],
      ["Constellation", "GRAPH"],
    ] as const;

    expect(within(roots).getAllByRole("button")).toHaveLength(
      expectedRoots.length,
    );
    for (const [accessibleName, visualLabel] of expectedRoots) {
      const root = within(roots).getByRole("button", {
        name: accessibleName,
      });
      expect(root).toHaveAttribute("aria-label", accessibleName);
      expect(root).toHaveClass("min-h-12", "flex-1");
      expect(root).toHaveTextContent(visualLabel);
      expect(root.textContent?.trim()).toHaveLength(visualLabel.length);
    }
  });

  it("marks Academic active on mobile and navigates to its library", async () => {
    const user = userEvent.setup();
    mobileLayoutState.matches = true;
    locationState.pathname = "/academic";
    renderFrame();

    const academic = within(
      screen.getByRole("navigation", { name: "Mobile roots" }),
    ).getByRole("button", { name: "Academic" });
    expect(academic).toHaveAttribute("aria-current", "page");

    await user.click(academic);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/academic" });
  });

  it("preserves the routed child instance and local state across desktop/mobile breakpoint changes", async () => {
    const user = userEvent.setup();
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    const persistDraft = vi.fn().mockRejectedValue(new Error("offline"));
    const child = (
      <StatefulRouteProbe
        onMount={onMount}
        onUnmount={onUnmount}
        persistDraft={persistDraft}
      />
    );
    const { rerender } = render(<CodexFrame>{child}</CodexFrame>);

    await user.type(
      screen.getByRole("textbox", { name: "Routed draft" }),
      "unsaved",
    );
    await user.click(
      screen.getByRole("button", { name: "Attempt draft save" }),
    );
    expect(persistDraft).toHaveBeenCalledOnce();
    expect(persistDraft).toHaveBeenCalledWith("unsaved");
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();

    mobileLayoutState.matches = true;
    rerender(<CodexFrame>{child}</CodexFrame>);

    expect(
      screen.getByRole("navigation", { name: "Mobile roots" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Routed draft" })).toHaveValue(
      "unsaved",
    );
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
    expect(persistDraft).toHaveBeenCalledOnce();

    mobileLayoutState.matches = false;
    rerender(<CodexFrame>{child}</CodexFrame>);

    expect(
      screen.getByRole("button", { name: "CLEPSYDRA — return to Atrium" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Routed draft" })).toHaveValue(
      "unsaved",
    );
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
  });
});
