import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./FolioProperties.mock";

const { mobileLayoutState, slateProps, usePageEditorMock } = vi.hoisted(() => ({
  mobileLayoutState: { matches: false },
  slateProps: { current: null as Record<string, unknown> | null },
  usePageEditorMock: vi.fn(),
}));

vi.mock("#/editor/usePageEditor", () => ({ usePageEditor: usePageEditorMock }));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: (props: Record<string, unknown>) => {
    slateProps.current = props;
    return null;
  },
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
  useTagSuggestions: () => ({ data: [] }),
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
vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({ lock: vi.fn() }),
  useEncryptionActions: () => ({
    unlockWithPassword: vi.fn(),
    unlockWithImportedIdentity: vi.fn(),
  }),
}));
vi.mock("#/api/journal", () => ({
  useJournalEditorOptions: () => undefined,
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: () => ({
    collapsed: true,
    width: 0,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  }),
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: () => ({ activeIndex: -1, scrollTo: vi.fn() }),
}));
vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ setProgress: vi.fn() }),
  useSetReadingProgress: () => vi.fn(),
}));

import { Folio } from "../Folio";

function editor(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "Body" }] }],
    editorRevision: 1,
    title: "Archived article",
    setTitle: vi.fn(),
    tags: [],
    computedTags: ["archive"],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved" as const,
    saveError: null,
    onSlateChange: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "Body",
    kind: "ARCHIVE",
    inferred: false,
    project: null,
    encrypted: false,
    readonly: true,
    setReadonly: vi.fn().mockResolvedValue(undefined),
    getRevision: vi.fn(() => "rev-a"),
    ...overrides,
  };
}

const ARCHIVE_PATH = "archive/example.com/an-article.md";

const ARCHIVE_META = {
  blobs: [],
  byline: "A. Writer",
  canonical_url: "https://example.com/an-article",
  captured_at: "2026-08-13T12:00:00Z",
  content_hash: "content-hash",
  description: "An archived article.",
  domain: "example.com",
  excerpt: "A short excerpt.",
  lang: "en",
  published_time: "2026-08-12T09:00:00Z",
  resource_count: 0,
  site_name: "Example",
  snapshot_hash: "snapshot-hash",
  source_hash: "source-hash",
  url: "https://example.com/an-article",
};

function renderFolioInRouter(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const folioRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Folio tabId="t1" path={path} />,
  });
  const archiveRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/archive/$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([folioRoute, archiveRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("Folio read-only bodies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.scrollTo = vi.fn();
    mobileLayoutState.matches = false;
    slateProps.current = null;
  });

  it("edits ordinary tags on protected archives without exposing computed tags or the body", async () => {
    const user = userEvent.setup();
    const state = editor({
      archive: ARCHIVE_META,
      tags: ["saved"],
      computedTags: ["archive"],
    });
    usePageEditorMock.mockReturnValue(state);

    const rendered = renderFolioInRouter(ARCHIVE_PATH);

    const tags = await screen.findByRole("combobox", {
      name: "Archive tags",
    });
    expect(slateProps.current?.readOnly).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Page title" })).toBeNull();
    const computed = screen.getByRole("grid", { name: "Read-only Tags" });
    expect(within(computed).getByText("archive")).toBeInTheDocument();
    expect(within(computed).queryByRole("button")).toBeNull();

    await user.type(tags, "reading{Enter}");
    expect(state.setTags).toHaveBeenCalledWith(["saved", "reading"]);

    rendered.unmount();
    const updatedState = { ...state, tags: ["saved", "reading"] };
    usePageEditorMock.mockReturnValue(updatedState);
    const updated = renderFolioInRouter(ARCHIVE_PATH);
    const editable = await screen.findByRole("grid", {
      name: "Archive tags",
    });
    await user.click(
      within(editable).getByRole(
        "button",
        { name: "Remove saved" },
      ),
    );
    expect(state.setTags).toHaveBeenLastCalledWith(["reading"]);

    state.saveNow.mockClear();
    await user.click(
      await screen.findByRole("combobox", { name: "Archive tags" }),
    );
    await user.tab();
    expect(state.saveNow).toHaveBeenCalledTimes(1);
    updated.unmount();
  });

  it("offers conflict recovery for archived tag edits", async () => {
    const user = userEvent.setup();
    const confirmReload = vi.spyOn(window, "confirm").mockReturnValue(true);
    const state = editor({
      archive: ARCHIVE_META,
      tags: ["saved"],
      saveStatus: "error",
      saveError: "page changed since it was loaded",
      revisionConflict: { currentRevision: "rev-b" },
    });
    usePageEditorMock.mockReturnValue(state);

    renderFolioInRouter(ARCHIVE_PATH);
    await user.click(
      await screen.findByRole("button", { name: "Reload from disk" }),
    );

    expect(confirmReload).toHaveBeenCalledWith(
      "Reload this page from disk? Your unsaved changes will be discarded.",
    );
    expect(state.reloadAfterConflict).toHaveBeenCalledTimes(1);
    confirmReload.mockRestore();
  });

  it("does not expose archive tag editing for other page presentations", () => {
    const cases = [
      {
        path: "notes/a-note.md",
        overrides: {
          archive: null,
          kind: "NOTE",
          computedTags: ["note"],
          readonly: false,
        },
      },
      {
        path: "conversations/a-conversation.md",
        overrides: {
          archive: null,
          kind: "AI_CONVERSATION",
          computedTags: ["ai-conversation"],
          conversationProvider: "claude",
          readonly: false,
        },
      },
      {
        path: "recipes/a-recipe.md",
        overrides: {
          archive: null,
          kind: "RECIPE",
          computedTags: ["recipe"],
          readonly: false,
          bodyMarkdown:
            "A dish.\n\nINGREDIENTS\n• one lemon\n\nSTEPS\n1. Serve.\n\nNOTES\nEnjoy.\n",
        },
      },
    ];

    for (const { path, overrides } of cases) {
      usePageEditorMock.mockReturnValue(editor(overrides));
      const rendered = renderFolioInRouter(path);
      expect(
        screen.queryByRole("combobox", { name: "Archive tags" }),
      ).toBeNull();
      rendered.unmount();
    }
  });

  it("renders a protected archive body as non-editable", () => {
    usePageEditorMock.mockReturnValue(editor());

    render(<Folio tabId="t1" path={ARCHIVE_PATH} />);

    expect(slateProps.current?.readOnly).toBe(true);
  });

  it("explains why the body is protected", () => {
    usePageEditorMock.mockReturnValue(editor());

    render(<Folio tabId="t1" path={ARCHIVE_PATH} />);

    expect(screen.getByRole("status")).toHaveTextContent(/captured archive/i);
  });

  it("leaves an ordinary page editable with no notice", () => {
    usePageEditorMock.mockReturnValue(
      editor({ kind: "NOTE", computedTags: ["note"], readonly: false }),
    );

    render(<Folio tabId="t1" path="notes/a-note.md" />);

    expect(slateProps.current?.readOnly).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("links a protected archive to its snapshot viewer while ordinary pages omit the action", async () => {
    usePageEditorMock.mockReturnValue(editor({ archive: ARCHIVE_META }));

    const archived = renderFolioInRouter(ARCHIVE_PATH);

    expect(
      await screen.findByRole("link", { name: "View archived snapshot" }),
    ).toHaveAttribute("href", `/archive/${ARCHIVE_PATH}`);

    archived.unmount();
    usePageEditorMock.mockReturnValue(
      editor({
        archive: null,
        kind: "NOTE",
        computedTags: ["note"],
        readonly: false,
      }),
    );
    renderFolioInRouter("notes/a-note.md");

    await screen.findByRole("textbox", { name: "Page title" });
    expect(
      screen.queryByRole("link", { name: "View archived snapshot" }),
    ).toBeNull();
  });

  it("clears protection when the reader chooses to edit anyway", async () => {
    const user = userEvent.setup();
    const state = editor();
    usePageEditorMock.mockReturnValue(state);

    render(<Folio tabId="t1" path={ARCHIVE_PATH} />);
    await user.click(screen.getByRole("button", { name: /edit anyway/i }));

    expect(state.setReadonly).toHaveBeenCalledWith(false);
  });
});
