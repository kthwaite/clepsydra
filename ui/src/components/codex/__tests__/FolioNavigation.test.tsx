import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type RefObject,
  StrictMode,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import "./FolioProperties.mock";
import { createEditor, type Descendant, type Editor, Transforms } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal()),
  useIsMutating: () => 0,
}));
import { CodexFrame } from "#/components/codex/CodexFrame";
import { Constellation } from "#/components/codex/Constellation";
import { Folio } from "#/components/codex/Folio";
import { renderElement } from "#/editor/elements/renderElement";
import { withSchema } from "#/editor/schema/withSchema";
import type { CustomEditor } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";
import {
  registerFolioHistoryTraversalGuard,
  useFolioHistoryController,
} from "#/hooks/useFolioHistoryNavigation";
import { GlobalShortcuts } from "#/hooks/useGlobalShortcuts";
import { useConstellationStore } from "#/store/constellation";
import * as folioRestorationStore from "#/store/folioRestoration";
import {
  clearFolioHistoryState,
  clearFolioRestoration,
  readFolioHistoryDestination,
  readFolioHistoryLocation,
  readFolioHistoryRestorationRequest,
} from "#/store/folioRestoration";
import { useGazetteerStore } from "#/store/gazetteer";
import { useWorkspaceStore } from "#/store/workspace";

const {
  editorCapture,
  editorMountCount,
  mobileLayout,
  mutatePage,
  pageEditorState,
  refetchPage,
} = vi.hoisted(() => ({
  editorCapture: { current: null as CustomEditor | null },
  editorMountCount: { current: 0 },
  mobileLayout: { current: true },
  mutatePage: vi.fn().mockResolvedValue(undefined),
  pageEditorState: {
    body: "Focused source block ^abc123DEF0\n",
    error: null as Error | null,
    isLoading: false,
    kind: "NOTE",
    listeners: new Set<() => void>(),
    revision: "revision-a",
    version: 0,
  },
  refetchPage: vi.fn(),
}));

function publishPageState(
  next: Partial<
    Pick<
      typeof pageEditorState,
      "body" | "error" | "isLoading" | "kind" | "revision"
    >
  >,
) {
  Object.assign(pageEditorState, next);
  pageEditorState.version += 1;
  for (const listener of pageEditorState.listeners) listener();
}

vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayout.current,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: undefined }),
  useOutlinks: () => ({ data: undefined }),
  useSimilar: () => ({ data: undefined }),
  useTags: () => ({ data: [] }),
  useStats: () => ({ data: undefined, isError: false }),
  useTagSuggestions: () => ({
    data: [],
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGraph: () => ({
    data: {
      nodes: [
        { id: "alpha-id", path: "notes/alpha.md", title: "Alpha" },
        { id: "beta-id", path: "notes/beta.md", title: "Beta" },
        {
          id: "daily-id",
          path: "journals/2026-08-08.md",
          title: "Daily",
        },
        { id: "orphan-id", path: "notes/orphan.md", title: "Orphan" },
      ],
      edges: [
        { source: "alpha-id", target: "beta-id", kind: "wikilink" },
        { source: "beta-id", target: "daily-id", kind: "wikilink" },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
  usePage: (path: string) => {
    const pageStateVersion = useSyncExternalStore(
      (listener) => {
        pageEditorState.listeners.add(listener);
        return () => pageEditorState.listeners.delete(listener);
      },
      () => pageEditorState.version,
      () => pageEditorState.version,
    );
    const data = useMemo(
      () =>
        pageEditorState.isLoading
          ? undefined
          : {
              path,
              canonical_name:
                path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
              body: pageEditorState.body,
              revision: pageEditorState.revision,
              kind: pageEditorState.kind,
              inferred: false,
              project: null,
              encrypted: false,
              conversation: null,
              meta: {
                id: `page:${path}`,
                title: "Alpha",
                tags: ["mobile"],
                aliases: [],
                created_at: "2026-08-08T00:00:00Z",
                updated_at: "2026-08-08T00:00:00Z",
              },
            },
      [path, pageStateVersion],
    );
    return {
      data,
      isLoading: pageEditorState.isLoading,
      error: pageEditorState.error,
      refetch: refetchPage,
    };
  },
  useUpdatePage: () => ({
    mutateAsync: mutatePage,
  }),
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalEditorOptions: () => undefined,
}));
vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({ lock: vi.fn() }),
  useOptionalEncryptionStatus: () => null,
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    toggle: vi.fn(),
    resolvedTheme: "light",
    diegetic: false,
  }),
}));
vi.mock("#/components/page-tree/PageActionsMenu", () => ({
  PageActionsMenu: ({ onDeleted }: { onDeleted: () => void }) => (
    <button type="button" onClick={onDeleted}>
      Complete page deletion
    </button>
  ),
}));
vi.mock("#/components/page-tree/FolderActionsMenu", () => ({
  FolderActionsMenu: () => null,
}));
vi.mock("#/hooks/useVaultEvents", () => ({
  useVaultEvents: () => "connected",
}));
vi.mock("#/hooks/useUptime", () => ({ useUptime: () => "00:00" }));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/components/ForceGraph", () => ({
  ForceGraph: () => <div role="img" aria-label="Constellation graph" />,
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: () => ({ activeIndex: -1, scrollTo: vi.fn() }),
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    initialValue,
    onChange,
    readOnly = false,
    editorRef,
  }: {
    initialValue: Descendant[];
    onChange: (value: Descendant[], editor: Editor) => void;
    readOnly?: boolean;
    editorRef?: RefObject<CustomEditor | null>;
  }) => {
    const editor = useMemo(() => {
      editorMountCount.current += 1;
      return withReact(withSchema(createEditor()));
    }, []);
    if (editorRef) editorRef.current = editor;
    editorCapture.current = editorRef ? editor : null;
    useEffect(
      () => () => {
        if (editorRef?.current === editor) editorRef.current = null;
        if (editorCapture.current === editor) editorCapture.current = null;
      },
      [editor, editorRef],
    );
    return (
      <Slate
        editor={editor}
        initialValue={initialValue}
        onChange={(value) => onChange(value, editor)}
      >
        <Editable
          aria-label="Page body"
          readOnly={readOnly}
          renderElement={renderElement}
        />
      </Slate>
    );
  },
}));

function OpenAlpha({ origin, blockId }: { origin: string; blockId?: string }) {
  const openTab = useOpenTab();
  return (
    <button
      type="button"
      onClick={() =>
        openTab(
          "page",
          "notes/alpha.md",
          "Alpha",
          blockId ? { blockId } : undefined,
        )
      }
    >
      Open Alpha from {origin}
    </button>
  );
}

function HistoryControls() {
  const openTab = useOpenTab();
  return (
    <div>
      <button
        type="button"
        onClick={() => openTab("page", "notes/alpha.md", "Alpha")}
      >
        Visit Alpha
      </button>
      <button
        type="button"
        onClick={() => openTab("page", "notes/beta.md", "Beta")}
      >
        Visit Beta
      </button>
      <button type="button" onClick={() => openTab("graph")}>
        Visit graph
      </button>
    </div>
  );
}

function AtriumOrigin() {
  return (
    <section>
      <h1>Atrium origin</h1>
      <OpenAlpha origin="Atrium" />
      <OpenAlpha origin="source reference" blockId="abc123DEF0" />
    </section>
  );
}

function GazetteerOrigin() {
  const state = useGazetteerStore();
  const page = (state as typeof state & { page?: number }).page ?? 1;
  return (
    <section>
      <h1>Gazetteer origin</h1>
      <p>
        {state.query} · {state.selectedTags.join(",")} · {state.sort} · page{" "}
        {page}
      </p>
      <OpenAlpha origin="Gazetteer" />
    </section>
  );
}

function Workspace() {
  const tabs = useWorkspaceStore((state) => state.tabs);
  useFolioHistoryController();
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const content =
    activeTab?.type === "graph" ? (
      <Constellation />
    ) : activeTab?.type === "page" && activeTab.path ? (
      <Folio tabId={activeTab.id} path={activeTab.path} />
    ) : (
      <p>No active workspace tab</p>
    );

  return (
    <>
      <HistoryControls />
      <GlobalShortcuts />
      <CodexFrame>{content}</CodexFrame>
    </>
  );
}

function renderNavigation(initialEntry: string, strictMode = false) {
  const rootRoute = createRootRoute({ component: Outlet });
  const atriumRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: AtriumOrigin,
  });
  const gazetteerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/gazetteer",
    component: GazetteerOrigin,
  });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspace",
    staticData: { codexView: "workspace" },
    component: Workspace,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      atriumRoute,
      gazetteerRoute,
      workspaceRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  const provider = <RouterProvider router={router} />;
  render(strictMode ? <StrictMode>{provider}</StrictMode> : provider);
  return router;
}

function pageTabStillExists() {
  return useWorkspaceStore
    .getState()
    .tabs.some((tab) => tab.type === "page" && tab.path === "notes/alpha.md");
}

function seedHistoryTabs(
  activeTabId: "alpha" | "beta" | "graph" = "alpha",
) {
  useWorkspaceStore.setState({
    tabs: [
      {
        id: "alpha",
        type: "page",
        path: "notes/alpha.md",
        label: "Alpha",
      },
      {
        id: "beta",
        type: "page",
        path: "notes/beta.md",
        label: "Beta",
      },
      { id: "graph", type: "graph", label: "Graph" },
    ],
    activeTabId,
  });
}

function activePagePath() {
  const workspace = useWorkspaceStore.getState();
  return workspace.tabs.find((tab) => tab.id === workspace.activeTabId)?.path;
}

function currentFolioScroller() {
  const editor = screen.getByRole("textbox", { name: "Page body" });
  const scrollContainer =
    editor.closest<HTMLDivElement>(".cl-noscroll.overflow-y-auto") ??
    editor.closest<HTMLDivElement>(".cl-noscroll.overflow-auto");
  if (!scrollContainer) throw new Error("Expected mobile Folio scroller");
  return scrollContainer;
}

function setFolioPosition(scrollTop: number, offset: number) {
  const editor = editorCapture.current;
  if (!editor) throw new Error("Expected the hydrated Slate editor");
  currentFolioScroller().scrollTop = scrollTop;
  act(() => {
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset },
      focus: { path: [0, 0], offset },
    });
  });
}

async function expectFolioPosition(
  path: string,
  scrollTop: number,
  offset: number,
) {
  await waitFor(() => expect(activePagePath()).toBe(path));
  await screen.findByRole("textbox", { name: "Page body" });
  await waitFor(() => expect(currentFolioScroller().scrollTop).toBe(scrollTop));
  await waitFor(() =>
    expect(editorCapture.current?.selection).toEqual({
      anchor: { path: [0, 0], offset },
      focus: { path: [0, 0], offset },
    }),
  );
}

describe("mobile Folio Back", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    window.scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    scrollIntoView.mockReset();
    mobileLayout.current = true;
    editorCapture.current = null;
    editorMountCount.current = 0;
    clearFolioRestoration("alpha");
    clearFolioRestoration("beta");
    clearFolioRestoration("other");
    clearFolioHistoryState();
    pageEditorState.body = "Focused source block ^abc123DEF0\n";
    pageEditorState.isLoading = false;
    pageEditorState.kind = "NOTE";
    pageEditorState.listeners.clear();
    pageEditorState.error = null;
    pageEditorState.revision = "revision-a";
    pageEditorState.version = 0;
    useWorkspaceStore.setState({
      tabs: [],
      activeTabId: null,
      navigationMode: "new",
      openHistory: [],
      quires: {},
    });
    useGazetteerStore.setState({
      query: "",
      selectedTags: [],
      sort: "ts",
      page: 1,
      routeTag: undefined,
    });
    useConstellationStore.setState({
      selectedAnchorId: null,
      depth: null,
      hideDaily: false,
      orphansVisible: true,
      mode: "graph",
    });
  });

  it("keeps Slate selection and focus after fetched content bumps the editor revision", async () => {
    const user = userEvent.setup();
    pageEditorState.isLoading = true;
    const router = renderNavigation("/");

    await user.click(
      await screen.findByRole("button", {
        name: "Open Alpha from source reference",
      }),
    );
    await screen.findByText(/fetching folio notes\/alpha\.md/);
    act(() => publishPageState({ isLoading: false }));

    await screen.findByText("Focused source block");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    const editor = editorCapture.current;
    expect(editor?.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Page body" })).toHaveFocus(),
    );
    expect(router.state.location.pathname).toBe("/workspace");
    expect(editorMountCount.current).toBeGreaterThanOrEqual(2);
    const state = useWorkspaceStore.getState();
    expect(
      state.tabs.find((tab) => tab.id === state.activeTabId)?.focusBlockId,
    ).toBeUndefined();
  });

  it("focuses the retained local tree when a dirty editor rejects a newer server revision", async () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("Focused source block");
    await waitFor(() =>
      expect(editorMountCount.current).toBeGreaterThanOrEqual(2),
    );
    const editor = editorCapture.current;
    if (!editor) throw new Error("Expected the hydrated Slate editor");

    act(() => {
      Transforms.insertText(editor, "Local ", {
        at: { path: [0, 0], offset: 0 },
      });
    });
    await screen.findByText("Local Focused source block");
    act(() =>
      publishPageState({
        body: "Server replacement ^abc123DEF0\n",
        revision: "revision-b",
      }),
    );
    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(editorCapture.current).toBe(editor);
    expect(editor.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === "alpha")
        ?.focusBlockId,
    ).toBeUndefined();
  });

  it("consumes a focus request while a retained-data terminal error shows the error panel", async () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("Focused source block");
    const editor = editorCapture.current;
    if (!editor) throw new Error("Expected the hydrated Slate editor");
    act(() => {
      Transforms.insertText(editor, "Local ", {
        at: { path: [0, 0], offset: 0 },
      });
    });
    await screen.findByText("Local Focused source block");

    act(() =>
      publishPageState({
        body: "Retained server body ^abc123DEF0\n",
        error: new Error("Refetch failed"),
        revision: "revision-b",
      }),
    );
    await screen.findByText("Folio hit an error.");
    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() =>
      expect(
        useWorkspaceStore.getState().tabs.find((tab) => tab.id === "alpha")
          ?.focusBlockId,
      ).toBeUndefined(),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("focuses a source block when reopening an existing page tab", async () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("Focused source block");

    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(editorCapture.current?.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Page body" })).toHaveFocus(),
    );
    expect(
      useWorkspaceStore.getState().tabs.find((tab) => tab.id === "alpha")
        ?.focusBlockId,
    ).toBeUndefined();
  });

  it("focuses a fenced code block loaded from real Markdown", async () => {
    pageEditorState.body =
      "```typescript\nconst answer = 42;\n^abc123DEF0\n```\n";
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("const answer = 42;");

    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(
      document.querySelector('[data-block-id="abc123DEF0"]'),
    ).not.toBeNull();
    expect(editorCapture.current?.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
  });

  it("claims a StrictMode focus request once and accepts a later request for the same block", async () => {
    useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
      blockId: "abc123DEF0",
    });
    renderNavigation("/workspace", true);

    await screen.findByText("Focused source block");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());

    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
  });

  it("does not revive a loading focus request after another tab supersedes it", async () => {
    pageEditorState.isLoading = true;
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "other",
          type: "page",
          path: "notes/other.md",
          label: "Other",
        },
      ],
      activeTabId: "other",
    });
    useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
      blockId: "abc123DEF0",
    });
    renderNavigation("/workspace");
    await screen.findByText(/fetching folio notes\/alpha\.md/);

    act(() => useWorkspaceStore.getState().activateTab("other"));
    pageEditorState.isLoading = false;
    act(() =>
      useWorkspaceStore
        .getState()
        .activateTab(
          useWorkspaceStore
            .getState()
            .tabs.find((tab) => tab.path === "notes/alpha.md")!.id,
        ),
    );

    await screen.findByText("Focused source block");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      useWorkspaceStore
        .getState()
        .tabs.find((tab) => tab.path === "notes/alpha.md")?.focusBlockId,
    ).toBeUndefined();
  });

  it("focuses the DOM block without changing Slate selection in read-only mode", async () => {
    pageEditorState.kind = "AI_CONVERSATION";
    pageEditorState.body = "Focused source block ^abc123DEF0\n";
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("Focused source block");

    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(
      document.querySelector('[data-block-id="abc123DEF0"]'),
    ).toHaveFocus();
    expect(editorCapture.current?.selection).toBeNull();
  });

  it("preserves block focus by using the source editor for Recipes with block IDs", async () => {
    pageEditorState.kind = "RECIPE";
    pageEditorState.body =
      "Focused source block ^abc123DEF0\n\nINGREDIENTS\n• salt\n\nSTEPS\n1. Serve.\n\nNOTES\n";
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("Focused source block");

    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(editorCapture.current?.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
  });

  it("consumes a focus request when the source block is missing", async () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    renderNavigation("/workspace");
    await screen.findByText("Focused source block");

    act(() => {
      useWorkspaceStore.getState().openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "missing123",
      });
    });

    await waitFor(() =>
      expect(
        useWorkspaceStore.getState().tabs.find((tab) => tab.id === "alpha")
          ?.focusBlockId,
      ).toBeUndefined(),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("returns to Atrium through history without closing the page tab", async () => {
    const user = userEvent.setup();
    const router = renderNavigation("/");

    await user.click(
      await screen.findByRole("button", { name: "Open Alpha from Atrium" }),
    );
    await user.click(await screen.findByRole("button", { name: "Back" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      screen.getByRole("heading", { name: "Atrium origin" }),
    ).toBeVisible();
    expect(pageTabStillExists()).toBe(true);
  });

  it("returns to filtered Gazetteer through history, preserving query, tag, sort, and page without closing the page tab", async () => {
    const user = userEvent.setup();
    useGazetteerStore.setState({
      query: "atlas",
      selectedTags: ["research"],
      sort: "title",
      page: 2,
    });
    const router = renderNavigation("/gazetteer");

    expect(
      await screen.findByText("atlas · research · title · page 2"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Open Alpha from Gazetteer" }),
    );
    await user.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/gazetteer"),
    );
    expect(screen.getByText("atlas · research · title · page 2")).toBeVisible();
    expect(pageTabStillExists()).toBe(true);
  });

  it("checkpoints before restoring the Constellation origin through history", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      tabs: [{ id: "graph", type: "graph", label: "Graph" }],
      activeTabId: "graph",
    });
    const router = renderNavigation("/workspace");

    await user.selectOptions(
      await screen.findByLabelText("Anchor page"),
      "alpha-id",
    );
    await user.click(screen.getByRole("button", { name: "Depth 2" }));
    await user.click(screen.getByRole("switch", { name: "Hide journals" }));
    await user.click(screen.getByRole("switch", { name: "Show orphans" }));
    await user.click(screen.getByRole("button", { name: "List view" }));
    await user.click(screen.getByRole("button", { name: "Open Alpha" }));
    const editor = await screen.findByRole("textbox", { name: "Page body" });
    const scrollContainer = editor.closest<HTMLDivElement>(
      ".cl-noscroll.overflow-y-auto",
    );
    if (!scrollContainer) throw new Error("Expected mobile Folio scroller");
    scrollContainer.scrollTop = 137;
    const destination = readFolioHistoryDestination(
      router.history.location.state,
    );
    if (!destination) throw new Error("Expected Folio history destination");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/workspace"),
    );
    expect(screen.getByLabelText("Anchor page")).toHaveValue("alpha-id");
    expect(screen.getByRole("button", { name: "Depth 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Hide journals" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Show orphans" }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(pageTabStillExists()).toBe(true);
    // Defect caught: origin activation used to unmount Folio before its visit was checkpointed.
    expect(
      readFolioHistoryLocation(
        destination.folioLocationId,
        destination.folioTabId,
        destination.folioPath,
      )?.scrollTop,
    ).toBe(137);
  });

  it("checkpoints before falling back from direct-loaded Folio to Atrium", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "page",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "page",
    });
    const router = renderNavigation("/workspace");
    const editor = await screen.findByRole("textbox", { name: "Page body" });
    const scrollContainer = editor.closest<HTMLDivElement>(
      ".cl-noscroll.overflow-y-auto",
    );
    if (!scrollContainer) throw new Error("Expected mobile Folio scroller");
    scrollContainer.scrollTop = 149;
    await waitFor(() =>
      expect(
        readFolioHistoryDestination(router.history.location.state),
      ).not.toBeNull(),
    );
    const destination = readFolioHistoryDestination(
      router.history.location.state,
    );
    if (!destination) throw new Error("Expected Folio history destination");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(
      screen.getByRole("heading", { name: "Atrium origin" }),
    ).toBeVisible();
    expect(pageTabStillExists()).toBe(true);
    // Defect caught: fallback navigation used to leave before synchronously checkpointing.
    expect(
      readFolioHistoryLocation(
        destination.folioLocationId,
        destination.folioTabId,
        destination.folioPath,
      )?.scrollTop,
    ).toBe(149);
  });

  it("keeps frame graph activation and router navigation in one raw-draft confirmation", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "page",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "page",
    });
    const router = renderNavigation("/workspace");
    await screen.findByRole("button", { name: "Raw Markdown" });
    const navigateSpy = vi.spyOn(router, "navigate");
    navigateSpy.mockClear();

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Frame graph draft stays local  \n" },
    });
    await user.click(screen.getByRole("button", { name: "Constellation" }));

    expect(useWorkspaceStore.getState().activeTabId).toBe("page");
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Unsaved raw Markdown" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(useWorkspaceStore.getState().activeTabId).toBe("page");
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Frame graph draft stays local  \n",
    );

    await user.click(screen.getByRole("button", { name: "Constellation" }));
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => {
      const state = useWorkspaceStore.getState();
      expect(state.tabs.filter((tab) => tab.type === "graph")).toHaveLength(1);
      expect(state.activeTabId).not.toBe("page");
      expect(router.state.status).toBe("idle");
    });
    expect(navigateSpy).toHaveBeenCalledOnce();
    // Mobile Constellation now opens via useOpenTab, which also stamps
    // folioOriginTabId via a state callback (see useOpenTab.test.tsx).
    expect(navigateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/workspace" }),
    );
  });

  it("keeps mobile deletion and router navigation in one raw-draft confirmation", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "page",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "page",
    });
    const router = renderNavigation("/workspace");
    await screen.findByRole("button", { name: "Raw Markdown" });
    const navigateSpy = vi.spyOn(router, "navigate");
    navigateSpy.mockClear();

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Deletion must not discard this draft  \n" },
    });
    await user.click(screen.getByRole("button", { name: "Document details" }));
    await user.click(screen.getByRole("button", { name: "Manage paths" }));
    await user.click(
      await screen.findByRole("button", { name: "Complete page deletion" }),
    );

    expect(pageTabStillExists()).toBe(true);
    expect(router.state.location.pathname).toBe("/workspace");
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Unsaved raw Markdown" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(pageTabStillExists()).toBe(true);
    expect(navigateSpy).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Close document details" }),
    );
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Deletion must not discard this draft  \n",
    );
    await user.click(screen.getByRole("button", { name: "Document details" }));

    await user.click(
      screen.getByRole("button", { name: "Complete page deletion" }),
    );
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => {
      expect(pageTabStillExists()).toBe(false);
      expect(router.state.location.pathname).toBe("/");
      expect(router.state.status).toBe("idle");
    });
    expect(navigateSpy).toHaveBeenCalledOnce();
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/" });
  });

  describe("real memory-history traversal", () => {
    it("restores both departure positions across A to B, Back, and Forward", async () => {
      const user = userEvent.setup();
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).toMatchObject({ folioTabId: "alpha" }),
      );
      setFolioPosition(111, 1);

      await user.click(screen.getByRole("button", { name: "Visit Beta" }));
      await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
      await screen.findByRole("textbox", { name: "Page body" });
      setFolioPosition(222, 2);

      act(() => router.history.back());
      await expectFolioPosition("notes/alpha.md", 111, 1);

      act(() => router.history.forward());
      await expectFolioPosition("notes/beta.md", 222, 2);
      expect(router.state.location.pathname).toBe("/workspace");
    });

    it("keeps distinct restoration locations for repeated visits to A", async () => {
      const user = userEvent.setup();
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).not.toBeNull(),
      );
      const firstA = readFolioHistoryDestination(
        router.history.location.state,
      );
      setFolioPosition(101, 1);

      await user.click(screen.getByRole("button", { name: "Visit Beta" }));
      await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
      setFolioPosition(202, 2);

      const betaEditor = editorCapture.current;
      await user.click(screen.getByRole("button", { name: "Visit Alpha" }));
      await waitFor(() => expect(activePagePath()).toBe("notes/alpha.md"));
      await waitFor(() => expect(editorCapture.current).not.toBe(betaEditor));
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state)
            ?.folioLocationId,
        ).not.toBe(firstA?.folioLocationId),
      );
      setFolioPosition(303, 3);

      act(() => router.history.back());
      await expectFolioPosition("notes/beta.md", 202, 2);
      act(() => router.history.back());
      await expectFolioPosition("notes/alpha.md", 101, 1);
      act(() => router.history.forward());
      await expectFolioPosition("notes/beta.md", 202, 2);
      act(() => router.history.forward());
      await expectFolioPosition("notes/alpha.md", 303, 3);
    });

    it("refreshes A's checkpoint when A moves between Back and Forward", async () => {
      const user = userEvent.setup();
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      setFolioPosition(110, 1);

      await user.click(screen.getByRole("button", { name: "Visit Beta" }));
      await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
      setFolioPosition(220, 2);

      act(() => router.history.back());
      await expectFolioPosition("notes/alpha.md", 110, 1);
      setFolioPosition(330, 3);

      act(() => router.history.forward());
      await expectFolioPosition("notes/beta.md", 220, 2);
      act(() => router.history.back());
      await expectFolioPosition("notes/alpha.md", 330, 3);
    });

    it("keeps dirty native Back inert until Leave checkpoints and traverses once", async () => {
      const user = userEvent.setup();
      const router = renderNavigation("/");
      await user.click(
        await screen.findByRole("button", {
          name: "Open Alpha from Atrium",
        }),
      );
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).not.toBeNull(),
      );
      const destination = readFolioHistoryDestination(
        router.history.location.state,
      );
      if (!destination) throw new Error("Expected Folio history destination");
      setFolioPosition(404, 4);
      const tabsBefore = useWorkspaceStore.getState().tabs;
      const stateBefore = router.history.location.state;
      const actions: string[] = [];
      const unsubscribe = router.history.subscribe(({ action }) => {
        actions.push(action.type);
      });
      const captureSpy = vi.spyOn(
        folioRestorationStore,
        "captureFolioHistoryLocation",
      );
      captureSpy.mockClear();

      await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
        target: { value: "Dirty native Back draft  \n" },
      });
      act(() => router.history.back());

      expect(
        await screen.findByRole("dialog", { name: "Unsaved raw Markdown" }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe("/workspace");
      expect(router.history.location.state).toEqual(stateBefore);
      expect(useWorkspaceStore.getState().tabs).toEqual(tabsBefore);
      expect(useWorkspaceStore.getState().activeTabId).toBe(
        destination.folioTabId,
      );
      expect(
        readFolioHistoryLocation(
          destination.folioLocationId,
          destination.folioTabId,
          destination.folioPath,
        ),
      ).toBeNull();
      expect(actions).toEqual([]);

      await user.click(screen.getByRole("button", { name: "Stay" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Unsaved raw Markdown" }),
        ).not.toBeInTheDocument(),
      );
      expect(router.history.location.state).toEqual(stateBefore);
      expect(router.history.location.state.__TSR_index).toBe(
        stateBefore.__TSR_index,
      );
      expect(router.history.canGoBack()).toBe(true);
      expect(router.state.location.pathname).toBe("/workspace");
      expect(activePagePath()).toBe(destination.folioPath);
      expect(useWorkspaceStore.getState().activeTabId).toBe(
        destination.folioTabId,
      );
      expect(useWorkspaceStore.getState().tabs).toEqual(tabsBefore);
      expect(actions).toEqual([]);
      expect(
        readFolioHistoryLocation(
          destination.folioLocationId,
          destination.folioTabId,
          destination.folioPath,
        ),
      ).toBeNull();
      expect(captureSpy).not.toHaveBeenCalled();

      act(() => router.history.back());
      expect(
        await screen.findByRole("dialog", { name: "Unsaved raw Markdown" }),
      ).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Leave" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(actions).toEqual(["BACK"]);
      expect(captureSpy).toHaveBeenCalledOnce();
      expect(
        readFolioHistoryLocation(
          destination.folioLocationId,
          destination.folioTabId,
          destination.folioPath,
        ),
      ).toMatchObject({
        scrollTop: 404,
        anchor: { offset: 4 },
        focus: { offset: 4 },
      });
      unsubscribe();
      captureSpy.mockRestore();
    });

    it("scopes raw approval so another traversal blocker can still reject Back", async () => {
      const user = userEvent.setup();
      const router = renderNavigation("/");
      await user.click(
        await screen.findByRole("button", {
          name: "Open Alpha from Atrium",
        }),
      );
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).not.toBeNull(),
      );
      const destination = readFolioHistoryDestination(
        router.history.location.state,
      );
      if (!destination) throw new Error("Expected Folio history destination");
      setFolioPosition(505, 5);
      const actions: string[] = [];
      const unsubscribeHistory = router.history.subscribe(({ action }) => {
        actions.push(action.type);
      });
      const captureSpy = vi.spyOn(
        folioRestorationStore,
        "captureFolioHistoryLocation",
      );
      captureSpy.mockClear();

      await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
        target: { value: "Two blockers must approve  \n" },
      });
      let permitSecondBlocker: (() => void) | null = null;
      let secondBlockerCalls = 0;
      const unregisterSecondBlocker = registerFolioHistoryTraversalGuard(
        (proceed) => {
          secondBlockerCalls += 1;
          permitSecondBlocker = proceed;
          return true;
        },
      );

      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(
        await screen.findByRole("dialog", { name: "Unsaved raw Markdown" }),
      ).toBeVisible();
      expect(secondBlockerCalls).toBe(0);

      await user.click(screen.getByRole("button", { name: "Leave" }));

      await waitFor(() => expect(secondBlockerCalls).toBe(1));
      expect(router.state.location.pathname).toBe("/workspace");
      expect(activePagePath()).toBe(destination.folioPath);
      expect(actions).toEqual([]);
      expect(captureSpy).not.toHaveBeenCalled();
      expect(
        readFolioHistoryLocation(
          destination.folioLocationId,
          destination.folioTabId,
          destination.folioPath,
        ),
      ).toBeNull();

      act(() => permitSecondBlocker?.());

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(actions).toEqual(["BACK"]);
      expect(captureSpy).toHaveBeenCalledOnce();
      expect(
        readFolioHistoryLocation(
          destination.folioLocationId,
          destination.folioTabId,
          destination.folioPath,
        ),
      ).toMatchObject({
        scrollTop: 505,
        anchor: null,
        focus: null,
      });
      unregisterSecondBlocker();
      unsubscribeHistory();
      captureSpy.mockRestore();
    });

    it.each(["closed", "replace-reused"] as const)(
      "does not activate a %s stale tuple when its snapshot is missing",
      async (staleKind) => {
        const user = userEvent.setup();
        if (staleKind === "replace-reused") {
          useWorkspaceStore.setState({
            tabs: [
              {
                id: "slot",
                type: "page",
                path: "notes/alpha.md",
                label: "Alpha",
              },
            ],
            activeTabId: "slot",
            navigationMode: "replace",
          });
        } else {
          useWorkspaceStore.setState({
            tabs: [
              {
                id: "alpha",
                type: "page",
                path: "notes/alpha.md",
                label: "Alpha",
              },
            ],
            activeTabId: "alpha",
          });
        }
        const router = renderNavigation("/workspace");
        await screen.findByRole("textbox", { name: "Page body" });
        await waitFor(() =>
          expect(
            readFolioHistoryDestination(router.history.location.state),
          ).toMatchObject({ folioPath: "notes/alpha.md" }),
        );

        await user.click(screen.getByRole("button", { name: "Visit Beta" }));
        await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
        if (staleKind === "closed") {
          act(() => useWorkspaceStore.getState().closeTab("alpha"));
        }
        clearFolioHistoryState();

        act(() => router.history.back());

        await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
        expect(router.state.location.pathname).toBe("/workspace");
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).toMatchObject({ folioPath: "notes/alpha.md" });
      },
    );

    it("replaces direct workspace initialization without adding a Back step", async () => {
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).toMatchObject({
          folioTabId: "alpha",
          folioPath: "notes/alpha.md",
        }),
      );
      expect(router.history.length).toBe(1);
      expect(router.history.canGoBack()).toBe(false);

      act(() => router.history.back());

      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/workspace"),
      );
      expect(activePagePath()).toBe("notes/alpha.md");
      expect(router.history.length).toBe(1);
    });

    it("ignores explicit-null graph entries during later traversal", async () => {
      const user = userEvent.setup();
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      setFolioPosition(707, 7);

      await user.click(screen.getByRole("button", { name: "Visit graph" }));
      await screen.findByRole("img", { name: "Constellation graph" });
      expect(useWorkspaceStore.getState().activeTabId).toBe("graph");
      expect(router.history.location.state).toMatchObject({
        folioTabId: null,
        folioPath: null,
        folioLocationId: null,
      });

      act(() => router.history.back());
      await expectFolioPosition("notes/alpha.md", 707, 7);
      act(() => router.history.forward());

      await waitFor(() =>
        expect(router.history.location.state).toMatchObject({
          folioTabId: null,
          folioPath: null,
          folioLocationId: null,
        }),
      );
      expect(useWorkspaceStore.getState().activeTabId).toBe("alpha");
      expect(activePagePath()).toBe("notes/alpha.md");
      expect(
        readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
      ).toBeNull();
    });

    it("restores a direct Folio after fallback to Atrium and browser Back", async () => {
      const user = userEvent.setup();
      useWorkspaceStore.setState({
        tabs: [
          {
            id: "alpha",
            type: "page",
            path: "notes/alpha.md",
            label: "Alpha",
          },
        ],
        activeTabId: "alpha",
      });
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).not.toBeNull(),
      );
      setFolioPosition(808, 8);

      await user.click(screen.getByRole("button", { name: "Back" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(
        screen.getByRole("heading", { name: "Atrium origin" }),
      ).toBeVisible();

      act(() => router.history.back());

      await expectFolioPosition("notes/alpha.md", 808, 8);
      expect(router.state.location.pathname).toBe("/workspace");
    });

    it.each([
      {
        name: "mobile root",
        setup: () => undefined,
        exit: async (user: ReturnType<typeof userEvent.setup>) => {
          await user.click(screen.getByRole("button", { name: "Gazetteer" }));
        },
      },
      {
        name: "desktop rail",
        setup: () => {
          mobileLayout.current = false;
        },
        exit: async (user: ReturnType<typeof userEvent.setup>) => {
          await user.click(screen.getByRole("button", { name: /GAZETTEER/ }));
        },
      },
      {
        name: "keyboard shortcut",
        setup: () => undefined,
        exit: async () => {
          fireEvent.keyDown(window, { key: "i", ctrlKey: true });
        },
      },
    ])(
      "checkpoints a positioned Folio for $name exit and restores it on Back",
      async ({ setup, exit }) => {
        const user = userEvent.setup();
        setup();
        useWorkspaceStore.setState({
          tabs: [
            {
              id: "alpha",
              type: "page",
              path: "notes/alpha.md",
              label: "Alpha",
            },
          ],
          activeTabId: "alpha",
        });
        const router = renderNavigation("/workspace");
        await screen.findByRole("textbox", { name: "Page body" });
        await waitFor(() =>
          expect(
            readFolioHistoryDestination(router.history.location.state),
          ).not.toBeNull(),
        );
        setFolioPosition(919, 9);

        await exit(user);
        await waitFor(() =>
          expect(router.state.location.pathname).toBe("/gazetteer"),
        );
        act(() => router.history.back());

        await expectFolioPosition("notes/alpha.md", 919, 9);
      },
    );

    it("pushes a fresh tuple for next-tab shortcut and restores Back position", async () => {
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      await waitFor(() =>
        expect(
          readFolioHistoryDestination(router.history.location.state),
        ).not.toBeNull(),
      );
      const alphaDestination = readFolioHistoryDestination(
        router.history.location.state,
      );
      setFolioPosition(313, 3);

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });

      await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
      const betaDestination = readFolioHistoryDestination(
        router.history.location.state,
      );
      expect(betaDestination?.folioLocationId).not.toBe(
        alphaDestination?.folioLocationId,
      );
      act(() => router.history.back());
      await expectFolioPosition("notes/alpha.md", 313, 3);
    });

    it("applies Back without pushing, replacing, or recursively traversing", async () => {
      const user = userEvent.setup();
      seedHistoryTabs();
      const router = renderNavigation("/workspace");
      await screen.findByRole("textbox", { name: "Page body" });
      await user.click(screen.getByRole("button", { name: "Visit Beta" }));
      await waitFor(() => expect(activePagePath()).toBe("notes/beta.md"));
      const actions: string[] = [];
      const unsubscribe = router.history.subscribe(({ action }) => {
        actions.push(action.type);
      });
      const navigateSpy = vi.spyOn(router, "navigate");
      navigateSpy.mockClear();

      act(() => router.history.back());

      await waitFor(() => expect(activePagePath()).toBe("notes/alpha.md"));
      expect(actions).toEqual(["BACK"]);
      expect(navigateSpy).not.toHaveBeenCalled();
      expect(router.state.location.pathname).toBe("/workspace");
      unsubscribe();
    });
  });
});
