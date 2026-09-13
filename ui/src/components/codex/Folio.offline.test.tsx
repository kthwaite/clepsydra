import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./__tests__/FolioProperties.mock";

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
  useArchivePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
vi.mock("#/api/aiJournal", () => ({
  useAiJournalToday: () => ({ data: null, isLoading: false }),
  useAiJournalRecent: () => ({ data: [] }),
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

import { Folio } from "./Folio";

function editor(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "Body" }] }],
    editorRevision: 1,
    title: "A note",
    setTitle: vi.fn(),
    tags: [],
    computedTags: ["note"],
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
    kind: "NOTE",
    inferred: false,
    project: null,
    encrypted: false,
    archive: null,
    readonly: false,
    offline: false,
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

describe("Folio offline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.scrollTo = vi.fn();
    mobileLayoutState.matches = false;
    slateProps.current = null;
  });

  it("leaves an ordinary page editable with no notice while online", () => {
    usePageEditorMock.mockReturnValue(editor());

    render(<Folio tabId="t1" path="notes/a-note.md" />);

    expect(slateProps.current?.readOnly).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the offline notice and forces the body read-only", () => {
    usePageEditorMock.mockReturnValue(
      editor({ readonly: true, offline: true }),
    );

    render(<Folio tabId="t1" path="notes/a-note.md" />);

    expect(screen.getByRole("status")).toHaveTextContent("Offline — read only");
    expect(slateProps.current?.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: /edit anyway/i })).toBeNull();
  });

  it("prefers the offline notice over the archive-protection notice", async () => {
    usePageEditorMock.mockReturnValue(
      editor({ archive: ARCHIVE_META, readonly: true, offline: true }),
    );

    renderFolioInRouter(ARCHIVE_PATH);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Offline — read only",
    );
    expect(screen.queryByText(/captured archive/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /edit anyway/i })).toBeNull();
  });
});
