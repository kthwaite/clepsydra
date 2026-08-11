import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  StrictMode,
  useEffect,
  useMemo,
  type MutableRefObject,
} from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { Folio } from "#/components/codex/Folio";
import { Constellation } from "#/components/codex/Constellation";
import { renderElement } from "#/editor/elements/renderElement";
import type { CustomEditor } from "#/editor/types";
import { withSchema } from "#/editor/schema/withSchema";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useConstellationStore } from "#/store/constellation";
import { useGazetteerStore } from "#/store/gazetteer";
import { useWorkspaceStore } from "#/store/workspace";

const { editorCapture, pageEditorState } = vi.hoisted(() => ({
  editorCapture: { current: null as CustomEditor | null },
  pageEditorState: {
    isLoading: false,
    kind: "NOTE",
    bodyMarkdown: "Editable body",
  },
}));

vi.mock("#/hooks/useMobileLayout", () => ({ useMobileLayout: () => true }));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: undefined }),
  useOutlinks: () => ({ data: undefined }),
  useSimilar: () => ({ data: undefined }),
  useTags: () => ({ data: [] }),
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
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalEditorOptions: () => undefined,
}));
vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({ lock: vi.fn() }),
}));
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
    readOnly = false,
    editorRef,
  }: {
    initialValue: Descendant[];
    readOnly?: boolean;
    editorRef?: MutableRefObject<CustomEditor | null>;
  }) => {
    const editor = useMemo(() => withReact(withSchema(createEditor())), []);
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
      <Slate editor={editor} initialValue={initialValue}>
        <Editable
          aria-label="Page body"
          readOnly={readOnly}
          renderElement={renderElement}
        />
      </Slate>
    );
  },
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: () => ({
    isLoading: pageEditorState.isLoading,
    error: null,
    isDraft: false,
    title: "Alpha",
    setTitle: vi.fn(),
    tags: ["mobile"],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    saveStatus: "saved",
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    kind: pageEditorState.kind,
    bodyMarkdown: pageEditorState.bodyMarkdown,
    inferred: false,
    project: null,
    initialValue: [
      {
        type: "paragraph",
        blockId: "abc123DEF0",
        children: [{ text: "Focused source block" }],
      },
    ],
    editorValue: [
      {
        type: "paragraph",
        blockId: "abc123DEF0",
        children: [{ text: "Focused source block" }],
      },
    ],
    onSlateChange: vi.fn(),
    editorRevision: 1,
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
    encrypted: false,
    pageId: "page-alpha",
    getPlaintext: vi.fn(),
    getRevision: vi.fn(),
  }),
}));

function OpenAlpha({
  origin,
  blockId,
}: {
  origin: string;
  blockId?: string;
}) {
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
        {state.query} · {state.selectedTags.join(",")} · {state.sort} · page {page}
      </p>
      <OpenAlpha origin="Gazetteer" />
    </section>
  );
}

function Workspace() {
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  if (activeTab?.type === "graph") return <Constellation />;
  if (activeTab?.type === "page" && activeTab.path) {
    return <Folio tabId={activeTab.id} path={activeTab.path} />;
  }
  return <p>No active workspace tab</p>;
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
    editorCapture.current = null;
    pageEditorState.isLoading = false;
    pageEditorState.kind = "NOTE";
    pageEditorState.bodyMarkdown = "Editable body";
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

  it("focuses a source block after its page opens in a new tab", async () => {
    const user = userEvent.setup();
    const router = renderNavigation("/");

    await user.click(
      await screen.findByRole("button", {
        name: "Open Alpha from source reference",
      }),
    );

    await screen.findByText("Focused source block");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    const editor = editorCapture.current;
    expect(editor?.selection).toEqual({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 0 },
    });
    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveFocus();
    expect(router.state.location.pathname).toBe("/workspace");
    const state = useWorkspaceStore.getState();
    expect(
      state.tabs.find((tab) => tab.id === state.activeTabId)?.focusBlockId,
    ).toBeUndefined();
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
      useWorkspaceStore
        .getState()
        .openTab("page", "notes/alpha.md", "Alpha", {
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

  it("claims a StrictMode focus request once and accepts a later request for the same block", async () => {
    useWorkspaceStore
      .getState()
      .openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    renderNavigation("/workspace", true);

    await screen.findByText("Focused source block");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());

    act(() => {
      useWorkspaceStore
        .getState()
        .openTab("page", "notes/alpha.md", "Alpha", {
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
    useWorkspaceStore
      .getState()
      .openTab("page", "notes/alpha.md", "Alpha", {
        blockId: "abc123DEF0",
      });
    renderNavigation("/workspace");
    await screen.findByText(/fetching folio notes\/alpha\.md/);

    act(() => useWorkspaceStore.getState().activateTab("other"));
    pageEditorState.isLoading = false;
    act(() => useWorkspaceStore.getState().activateTab(
      useWorkspaceStore
        .getState()
        .tabs.find((tab) => tab.path === "notes/alpha.md")!.id,
    ));

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
    pageEditorState.bodyMarkdown = "Focused source block";
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
    const targetText = await screen.findByText("Focused source block");
    const target = targetText.closest<HTMLElement>("[data-block-id]");
    expect(target).not.toBeNull();

    act(() => {
      useWorkspaceStore
        .getState()
        .openTab("page", "notes/alpha.md", "Alpha", {
          blockId: "abc123DEF0",
        });
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    expect(target).toHaveFocus();
    expect(editorCapture.current?.selection).toBeNull();
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
      useWorkspaceStore
        .getState()
        .openTab("page", "notes/alpha.md", "Alpha", {
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
    expect(screen.getByRole("heading", { name: "Atrium origin" })).toBeVisible();
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

  it("returns to Constellation through history, preserving anchor, depth, journal, orphan, and list state without closing the page tab", async () => {
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
    await user.click(await screen.findByRole("button", { name: "Back" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/workspace"),
    );
    expect(screen.getByLabelText("Anchor page")).toHaveValue("alpha-id");
    expect(screen.getByRole("button", { name: "Depth 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Hide journals" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Show orphans" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(pageTabStillExists()).toBe(true);
  });

  it("falls back to Atrium when a directly-loaded Folio has no usable in-app history", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Back" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.getByRole("heading", { name: "Atrium origin" })).toBeVisible();
    expect(pageTabStillExists()).toBe(true);
  });
});
