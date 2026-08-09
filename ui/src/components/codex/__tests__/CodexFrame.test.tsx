import { useEffect, useRef, useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  locationState,
  locationHookMock,
  mobileLayoutState,
  navigateMock,
  openInscribeMock,
  openSearchMock,
  openSettingsMock,
  toggleThemeMock,
  workspaceState,
} = vi.hoisted(() => ({
  locationState: { pathname: "/docs/getting-started" },
  locationHookMock: vi.fn(),
  mobileLayoutState: { matches: false },
  navigateMock: vi.fn(),
  openInscribeMock: vi.fn(),
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
  useLocation: () => {
    locationHookMock();
    return locationState;
  },
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
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/store/ui", () => ({
  useUiStore: (
    selector: (state: {
      openInscribe: () => void;
      openSearch: () => void;
      openSettings: () => void;
      isSettingsOpen: boolean;
    }) => unknown,
  ) =>
    selector({
      openInscribe: openInscribeMock,
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

describe("CodexFrame Docs integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = false;
    locationState.pathname = "/docs/getting-started";
    workspaceState.tabs = [];
    workspaceState.activeTabId = null;
  });

  it("renders a nested Docs guide as the active shell view", () => {
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

  it("recognizes the exact Docs root path", () => {
    locationState.pathname = "/docs";
    renderFrame();

    expect(screen.getByRole("button", { name: /05.*DOCS/i })).toHaveClass(
      "shadow-[inset_0_-2px_0_0_var(--accent)]",
    );
    expect(screen.getByText(/FILE DOC-001.*VIEW DOCS/)).toBeInTheDocument();
  });

  it.each(["/docs-old", "/docsfoo"])(
    "keeps near-prefix path %s in the Atrium fallback view",
    (pathname) => {
      locationState.pathname = pathname;
      renderFrame();

      expect(screen.getByRole("button", { name: /00.*ATRIUM/i })).toHaveClass(
        "shadow-[inset_0_-2px_0_0_var(--accent)]",
      );
      expect(
        screen.getByRole("button", { name: /05.*DOCS/i }),
      ).not.toHaveClass("shadow-[inset_0_-2px_0_0_var(--accent)]");
      expect(screen.getByText(/FILE ATRIUM.*VIEW ATRIUM/)).toBeInTheDocument();
      expect(screen.queryByTestId("sheaf")).not.toBeInTheDocument();
    },
  );

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

  it("shows only the three roots and global actions in the mobile chrome", () => {
    mobileLayoutState.matches = true;
    renderFrame();

    const roots = screen.getByRole("navigation", { name: "Mobile roots" });
    expect(within(roots).getAllByRole("button")).toHaveLength(3);
    expect(
      within(roots).getByRole("button", { name: "Atrium" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(roots).getByRole("button", { name: "Gazetteer" }),
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
    await user.click(
      screen.getByRole("button", { name: "Constellation" }),
    );

    expect(openSearchMock).toHaveBeenCalledOnce();
    expect(openInscribeMock).toHaveBeenCalledOnce();
    expect(workspaceState.openTab).toHaveBeenCalledWith("graph");
    expect(navigateMock).toHaveBeenCalledWith({ to: "/workspace" });
    expect(workspaceState.openTab.mock.invocationCallOrder[0]).toBeLessThan(
      navigateMock.mock.invocationCallOrder[0],
    );
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
