import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});

const {
  locationState,
  featureFlagsState,
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
  featureFlagsState: { academic: true, feeds: true },
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
  useQueryClient: () => ({
    getMutationCache: () => ({ subscribe: () => () => {} }),
  }),
}));
vi.mock("#/api/feeds", () => ({ useFeeds: () => ({ data: undefined }) }));
vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => featureFlagsState,
}));
const TEST_ROUTE_VIEWS: ReadonlyArray<[prefix: string, view: string]> = [
  ["/archive", "archive"],
  ["/workspace", "workspace"],
  ["/gazetteer", "gazetteer"],
  ["/stats", "stats"],
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
  useSyncConflicts: () => ({ data: undefined }),
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
  Sheaf: ({ activeTabVisible }: { activeTabVisible?: boolean }) => (
    <div
      data-testid="sheaf"
      data-active-tab-visible={String(activeTabVisible)}
    />
  ),
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    toggle: toggleThemeMock,
    resolvedTheme: "light",
  }),
}));
vi.mock("#/hooks/useVaultEvents", () => ({
  useVaultEvents: () => "connected",
}));
vi.mock("#/components/codex/OpenPagesSheet", () => ({
  OpenPagesSheet: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog" aria-label="Open pages" /> : null,
}));
vi.mock("#/components/codex/StatusDot", () => ({
  StatusDot: () => <span role="status">Synced</span>,
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
      isSearchOpen: boolean;
      isContentsOpen: boolean;
      setContentsOpen: () => void;
      toggleContents: () => void;
    }) => unknown,
  ) =>
    selector({
      openInscribe: openInscribeMock,
      openLocation: openLocationMock,
      openSearch: openSearchMock,
      openSettings: openSettingsMock,
      isSettingsOpen: false,
      isSearchOpen: false,
      isContentsOpen: false,
      setContentsOpen: vi.fn(),
      toggleContents: vi.fn(),
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

import { CodexFrame } from "#/components/codex/CodexFrame";
import { useConnectionStore } from "#/offline/connectionStore";

function renderFrame(forceView?: "folio" | "archive") {
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

describe("CodexFrame destination integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = false;
    locationState.pathname = "/docs/getting-started";
    featureFlagsState.academic = true;
    featureFlagsState.feeds = true;
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
    useConnectionStore.setState({ status: "connected" });
  });

  const primary = () =>
    within(screen.getByRole("navigation", { name: "Primary navigation" }));

  it("shows exactly the core three plus Contents in the header", () => {
    locationState.pathname = "/";
    renderFrame();
    expect(
      primary()
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Folio", "Tasking", "Gazetteer", "Contents"]);
  });

  it("goes home from the wordmark, which carries the dot on the Atrium", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();
    const mark = screen.getByRole("button", {
      name: "Clepsydra — Atrium (home)",
    });
    expect(mark).toHaveAttribute("aria-current", "page");
    await user.click(mark);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
  });

  it.each([
    ["/gazetteer", "Gazetteer"],
    ["/tasking", "Tasking"],
    ["/workspace", "Folio"],
  ])("marks %s's core item current", (pathname, name) => {
    locationState.pathname = pathname;
    renderFrame();
    expect(primary().getByRole("button", { name })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      primary().getByRole("button", { name: "Contents" }),
    ).not.toHaveAttribute("aria-current");
  });

  it.each([
    "/bases/reading-log",
    "/feeds",
    "/docs/getting-started",
    "/repairs",
  ])("gives Contents the active dot on non-core %s", (pathname) => {
    locationState.pathname = pathname;
    renderFrame();
    expect(primary().getByRole("button", { name: "Contents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps Settings on the right and drops search and theme buttons", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(openSettingsMock).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /⌘K/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /dark mode|paper mode/i }),
    ).toBeNull();
  });

  it("renders the simplified footer", () => {
    locationState.pathname = "/";
    renderFrame();
    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveTextContent("Synced");
    expect(footer).not.toHaveTextContent(/VESSEL|FILE|CORPUS|UTC/);
  });

  it("marks the active tab as displayed only on Folio", () => {
    renderFrame("folio");
    expect(screen.getByTestId("sheaf")).toHaveAttribute(
      "data-active-tab-visible",
      "true",
    );
  });

  it("frees the active tab's preview on Gazetteer, where no folio is displayed", () => {
    locationState.pathname = "/gazetteer";
    renderFrame();

    expect(screen.getByTestId("sheaf")).toHaveAttribute(
      "data-active-tab-visible",
      "false",
    );
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
    featureFlagsState.academic = true;
    featureFlagsState.feeds = true;
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
  });

  it("shows the same five slots whatever the feature flags", () => {
    featureFlagsState.academic = false;
    featureFlagsState.feeds = false;
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    expect(within(roots).getAllByRole("button")).toHaveLength(5);
  });

  it("gives the archive route the full content window without codex chrome", () => {
    locationState.pathname = "/archive/archive/example/page.md";
    renderFrame();

    expect(screen.getByText("Frame content")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Clepsydra — Atrium (home)" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("footer")).not.toBeInTheDocument();
    expect(document.querySelector("main")).toHaveClass("h-full");
  });

  it("gives the mobile archive route a definite full height without codex chrome", () => {
    mobileLayoutState.matches = true;
    locationState.pathname = "/archive/archive/example/page.md";
    renderFrame();

    const content = screen.getByText("Frame content");
    expect(content.parentElement).toHaveClass("h-full");
    expect(
      screen.queryByRole("navigation", { name: "Mobile roots" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("footer")).not.toBeInTheDocument();
    expect(document.querySelectorAll("main")).toHaveLength(1);
  });

  it("shows Today, Agenda, Tasks, Search and Folio with the global actions", () => {
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    expect(
      within(roots)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Today", "Agenda", "Tasks", "Search", "Folio"]);
    expect(
      within(roots).getByRole("button", { name: "Today" }),
    ).toHaveAttribute("aria-current", "page");
    const actions = screen.getByRole("group", { name: "Global actions" });
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["New note", "Settings"]);
    expect(within(actions).getByRole("status")).toHaveTextContent("Synced");
    expect(screen.getByText("Frame content")).toBeInTheDocument();
  });

  it("shows the wordmark on Today only", () => {
    mobileLayoutState.matches = true;
    const { unmount } = renderFrame();
    expect(screen.getByRole("banner")).toHaveTextContent("Clepsydra");
    unmount();

    locationState.pathname = "/agenda";
    renderFrame();
    expect(screen.getByRole("banner")).not.toHaveTextContent("Clepsydra");
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

  it("wires the mobile global actions and bar slots", async () => {
    const user = userEvent.setup();
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    await user.click(within(roots).getByRole("button", { name: "Search" }));
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(within(roots).getByRole("button", { name: "Agenda" }));
    await user.click(within(roots).getByRole("button", { name: "Tasks" }));

    expect(openSearchMock).toHaveBeenCalledOnce();
    expect(openInscribeMock).toHaveBeenCalledOnce();
    expect(openSettingsMock).toHaveBeenCalledWith("appearance");
    expect(navigateMock).toHaveBeenCalledWith({ to: "/agenda" });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/tasking" });
  });

  it.each([
    ["/agenda", "Agenda"],
    ["/tasking", "Tasks"],
    ["/workspace", "Folio"],
  ])("marks the %s slot current", (pathname, name) => {
    mobileLayoutState.matches = true;
    locationState.pathname = pathname;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    const current = within(roots)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(name);
  });

  it("marks no slot current on a Go-to screen", () => {
    mobileLayoutState.matches = true;
    locationState.pathname = "/gazetteer";
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    for (const button of within(roots).getAllByRole("button")) {
      expect(button).not.toHaveAttribute("aria-current");
    }
  });

  it("leaves the top bar to the page on Folio", () => {
    mobileLayoutState.matches = true;
    locationState.pathname = "/workspace";
    workspaceState.tabs = [{ id: "a", type: "page", path: "notes/a.md" }];
    workspaceState.activeTabId = "a";
    renderFrame();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Mobile roots" }),
    ).toBeVisible();
  });

  it("gives mobile Folio a definite height so the page scrolls itself", () => {
    mobileLayoutState.matches = true;
    locationState.pathname = "/workspace";
    workspaceState.tabs = [{ id: "a", type: "page", path: "notes/a.md" }];
    workspaceState.activeTabId = "a";
    renderFrame();
    expect(screen.getByText("Frame content").parentElement).toHaveClass(
      "h-full",
    );
  });

  it("keeps the top bar on the empty launcher", () => {
    mobileLayoutState.matches = true;
    locationState.pathname = "/workspace";
    renderFrame();
    expect(screen.getByRole("banner")).toBeVisible();
  });

  it("fits five 44px targets at 320px with visible labels", () => {
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    for (const root of within(roots).getAllByRole("button")) {
      expect(root).toHaveClass("min-h-12");
    }
  });

  it("badges Folio with the open-page count and opens the open-pages sheet", async () => {
    const user = userEvent.setup();
    mobileLayoutState.matches = true;
    workspaceState.tabs = [
      { id: "a", type: "page", path: "notes/a.md" },
      { id: "b", type: "page", path: "notes/b.md" },
      { id: "g", type: "graph" },
    ];
    renderFrame();

    const folio = screen.getByRole("button", { name: "Folio, 2 open pages" });
    expect(folio).toHaveTextContent("2");
    await user.click(folio);
    expect(screen.getByRole("dialog", { name: "Open pages" })).toBeVisible();
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
      screen.getByRole("button", { name: "Clepsydra — Atrium (home)" }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Routed draft" })).toHaveValue(
      "unsaved",
    );
    expect(onMount).toHaveBeenCalledOnce();
    expect(onUnmount).not.toHaveBeenCalled();
  });
});
