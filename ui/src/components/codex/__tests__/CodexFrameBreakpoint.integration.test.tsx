import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Descendant } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  graph,
  matchMediaController,
  navigateMock,
  openInscribeMock,
  openSearchMock,
  openSettingsMock,
  saveNowMock,
  toggleThemeMock,
  usePageEditorMock,
} = vi.hoisted(() => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    matches: false,
    media: "(max-width: 767px)",
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList;

  const setMatches = (matches: boolean) => {
    Object.defineProperty(mediaQuery, "matches", {
      configurable: true,
      value: matches,
    });
    const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
    for (const listener of listeners) listener(event);
  };

  return {
    graph: {
      nodes: [
        { id: "alpha-id", path: "notes/alpha.md", title: "Alpha" },
        { id: "daily-id", path: "journals/2026-08-08.md", title: "Daily" },
      ],
      edges: [{ source: "alpha-id", target: "daily-id", kind: "wikilink" }],
    },
    matchMediaController: {
      query: vi.fn(() => mediaQuery),
      setMatches,
      setWidth(width: number) {
        setMatches(width <= 767);
      },
    },
    navigateMock: vi.fn(),
    openInscribeMock: vi.fn(),
    openSearchMock: vi.fn(),
    openSettingsMock: vi.fn(),
    saveNowMock: vi.fn(),
    toggleThemeMock: vi.fn(),
    usePageEditorMock: vi.fn(),
  };
});

vi.stubGlobal("matchMedia", matchMediaController.query);
vi.mock("@tanstack/react-query", () => ({ useIsMutating: () => 0 }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/workspace" }),
  useNavigate: () => navigateMock,
  useRouter: () => ({
    history: {
      back: vi.fn(),
      canGoBack: () => false,
      location: { state: { __TSR_index: 0 } },
    },
  }),
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useGraph: () => ({ data: graph, isLoading: false }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
  useStats: () => ({
    data: { pages: 2, links_total: 1, last_indexed_at: null },
    isError: false,
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => ({
    data: { initialized: true, wrapped_identity: "wrapped" },
    isPending: false,
    error: null,
  }),
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalEditorOptions: () => undefined,
  useJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ progress: 0 }),
  useSetReadingProgress: () => vi.fn(),
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    toggle: toggleThemeMock,
    resolvedTheme: "light",
    diegetic: false,
  }),
}));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: () => ({
    collapsed: false,
    width: 240,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  }),
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: () => ({ activeIndex: -1, scrollTo: vi.fn() }),
}));
vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({ lock: vi.fn() }),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    initialValue,
    onChange,
  }: {
    initialValue: Array<{ children?: Array<{ text?: string }> }>;
    onChange: (value: Descendant[]) => void;
  }) => (
    <textarea
      aria-label="Page body"
      defaultValue={initialValue[0]?.children?.[0]?.text ?? ""}
      onChange={(event) =>
        onChange([
          {
            type: "paragraph",
            children: [{ text: event.currentTarget.value }],
          } as Descendant,
        ])
      }
    />
  ),
}));
vi.mock("#/editor/wikilinkResolution", () => ({
  WikilinkResolutionProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("#/hooks/useClock", () => ({ useClock: () => new Date(0) }));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/hooks/useUptime", () => ({ useUptime: () => "00:01" }));
vi.mock("#/hooks/useVaultEvents", () => ({
  useVaultEvents: () => "connected",
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/store/ui", () => ({
  useUiStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openInscribe: openInscribeMock,
      openSearch: openSearchMock,
      openSettings: openSettingsMock,
      isSettingsOpen: false,
    }),
}));

import { CodexFrame } from "#/components/codex/CodexFrame";
import { Constellation } from "#/components/codex/Constellation";
import { Folio } from "#/components/codex/Folio";
import { useConstellationStore } from "#/store/constellation";
import { useWorkspaceStore } from "#/store/workspace";

describe("CodexFrame real breakpoint transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    matchMediaController.setMatches(true);
    useConstellationStore.setState({
      selectedAnchorId: null,
      depth: null,
      hideDaily: false,
      orphansVisible: true,
      mode: "graph",
    });
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "page-alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "page-alpha",
    });
    saveNowMock.mockRejectedValue(new Error("offline"));
    let editorValue: Descendant[] = [
      {
        type: "paragraph",
        children: [{ text: "Original body" }],
      } as Descendant,
    ];
    usePageEditorMock.mockReturnValue({
      isLoading: false,
      error: null,
      isDraft: false,
      title: "Alpha",
      setTitle: vi.fn(),
      tags: [],
      setTags: vi.fn(),
      aliases: [],
      setAliases: vi.fn(),
      saveNow: saveNowMock,
      saveStatus: "error",
      saveError: new Error("offline"),
      revisionConflict: null,
      reloadAfterConflict: vi.fn(),
      kind: "NOTE",
      bodyMarkdown: "Original body",
      inferred: false,
      project: null,
      initialValue: editorValue,
      get editorValue() {
        return editorValue;
      },
      onSlateChange: vi.fn((value: Descendant[]) => {
        editorValue = value;
      }),
      editorRevision: 1,
      createdAt: "2026-08-08T00:00:00Z",
      updatedAt: "2026-08-08T00:00:00Z",
      encrypted: false,
      pageId: "page-alpha",
      getPlaintext: vi.fn(),
      getRevision: vi.fn(),
    });
  });

  it.each([
    768, 1024,
  ])("keeps desktop-only routes and actions reachable at %ipx", async (width) => {
    const user = userEvent.setup();
    matchMediaController.setWidth(width);
    render(
      <CodexFrame forceView="atrium">
        <div>Responsive content</div>
      </CodexFrame>,
    );

    expect(matchMediaController.query).toHaveBeenCalledWith(
      "(max-width: 767px)",
    );
    const primary = screen.getByRole("navigation", {
      name: "Primary navigation",
    });
    expect(
      within(primary).getByRole("button", { name: /06.*feeds/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Mobile roots" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /08.*status/i }));
    await user.click(
      screen.getByRole("button", { name: "Switch to dark mode" }),
    );
    expect(openSettingsMock).toHaveBeenCalledWith("appearance");
    expect(toggleThemeMock).toHaveBeenCalledOnce();
  });

  it("switches to mobile roots at the shared 767px boundary", () => {
    matchMediaController.setWidth(767);
    render(
      <CodexFrame forceView="atrium">
        <div>Phone content</div>
      </CodexFrame>,
    );

    expect(
      screen.getByRole("navigation", { name: "Mobile roots" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("navigation", { name: "Primary navigation" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Global actions" })).toBeVisible();
  });

  it("keeps every global action reachable in the compact phone header", () => {
    matchMediaController.setWidth(390);
    render(
      <CodexFrame forceView="atrium">
        <div>Phone content</div>
      </CodexFrame>,
    );

    const banner = screen.getByRole("banner");
    const actions = within(banner).getByRole("group", {
      name: "Global actions",
    });
    expect(banner).toHaveClass("min-w-0");
    expect(banner.firstElementChild).toHaveClass("min-w-0", "overflow-hidden");
    expect(actions).toHaveClass("shrink-0");

    const actionNames = [
      "Search",
      "New note",
      "Status",
      "Switch to dark mode",
    ] as const;
    expect(within(actions).getAllByRole("button")).toHaveLength(
      actionNames.length,
    );
    for (const name of actionNames) {
      const button = within(actions).getByRole("button", { name });
      expect(button).toHaveAttribute("aria-label", name);
      expect(button).toHaveClass("min-w-8");
      expect(button.textContent?.trim().length).toBeLessThanOrEqual(3);
    }
  });

  it("preserves real Constellation controls through real media-query changes", async () => {
    const user = userEvent.setup();
    render(
      <CodexFrame forceView="constellation">
        <Constellation />
      </CodexFrame>,
    );

    await user.selectOptions(screen.getByLabelText("Anchor page"), "alpha-id");
    await user.click(screen.getByRole("switch", { name: "Hide journals" }));

    act(() => matchMediaController.setMatches(false));
    expect(
      screen.getByText("CONSTELLATION", { selector: ".cl-cap" }),
    ).toBeVisible();
    act(() => matchMediaController.setMatches(true));

    expect(screen.getByLabelText("Anchor page")).toHaveValue("alpha-id");
    expect(screen.getByRole("switch", { name: "Hide journals" })).toBeChecked();
  });

  it("preserves real Folio editor input after a rejected save and breakpoint changes", async () => {
    const user = userEvent.setup();
    render(
      <CodexFrame forceView="folio">
        <Folio tabId="page-alpha" path="notes/alpha.md" />
      </CodexFrame>,
    );

    const editor = screen.getByRole("textbox", { name: "Page body" });
    await user.type(editor, " — unsaved");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(saveNowMock).toHaveBeenCalledOnce());

    act(() => matchMediaController.setMatches(false));
    act(() => matchMediaController.setMatches(true));

    const remountedEditor = screen.getByRole("textbox", { name: "Page body" });
    expect(remountedEditor).toHaveValue("Original body — unsaved");
    expect(saveNowMock).toHaveBeenCalledOnce();
  });
});
