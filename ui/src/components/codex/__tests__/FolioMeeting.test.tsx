import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./FolioProperties.mock";

const {
  collapsibleRailState,
  mobileLayoutState,
  usePageEditorMock,
  usePageMock,
  commitMock,
} = vi.hoisted(() => ({
  collapsibleRailState: { collapsed: false },
  mobileLayoutState: { matches: false },
  usePageEditorMock: vi.fn(),
  usePageMock: vi.fn(),
  commitMock: vi.fn(),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
// The expanded META rail mounts OpenFilesAccordion, which reads router history
// state through useRouterState. Stub the module so that path doesn't need a
// RouterProvider.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/archive">{children}</a>
  ),
  useBlocker: () => ({ status: "idle" as const }),
  useLocation: () => ({ pathname: "/workspace" }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({
    history: {
      back: vi.fn(),
      replace: vi.fn(),
      canGoBack: () => false,
      location: { href: "/workspace", state: {} },
    },
  }),
  useRouterState: ({
    select,
  }: {
    select: (s: {
      matches: Array<{ staticData?: { codexView?: string } }>;
    }) => unknown;
  }) => select({ matches: [{ staticData: { codexView: "workspace" } }] }),
}));
vi.mock("#/editor/SaveIndicator", () => ({ SaveIndicator: () => null }));
vi.mock("#/editor/SlateEditor", () => ({ SlateEditor: () => null }));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
  useTagSuggestions: () => ({
    data: [],
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
  useArchivePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePage: usePageMock,
  // MeetingMeta resolves attendee names through usePeople, which reads the
  // page index and creates PERSON pages; CLink opens tabs.
  usePages: () => ({ data: { items: [] } }),
  useCreatePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/api/bases", () => ({ usePropertyCommit: () => commitMock }));
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
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("#/api/aiJournal", () => ({
  useAiJournalToday: () => ({ data: null, isLoading: false }),
  useEnsureAiJournalToday: () => ({ mutateAsync: vi.fn() }),
  useAiJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: () => ({
    collapsed: collapsibleRailState.collapsed,
    width: 240,
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

import { useWorkspaceStore } from "#/store/workspace";
import { Folio } from "../Folio";

const PATH = "meetings/kickoff.md";

function meetingEditor() {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "" }] }],
    editorRevision: 1,
    title: "Kickoff",
    setTitle: vi.fn(),
    tags: [],
    computedTags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved" as const,
    saveError: null,
    onSlateChange: vi.fn(),
    saveNow: vi.fn(),
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    createdAt: "2026-08-27T00:00:00Z",
    updatedAt: "2026-08-27T00:00:00Z",
    bodyMarkdown: "",
    kind: "MEETING",
    inferred: false,
    project: null,
    encrypted: false,
    pageId: "page-uuid",
  };
}

describe("Folio meeting header band", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = false;
    collapsibleRailState.collapsed = false;
    usePageEditorMock.mockReturnValue(meetingEditor());
    usePageMock.mockReturnValue({
      data: {
        path: PATH,
        kind: "MEETING",
        meta: {
          id: "page-uuid",
          attendees: ["[[Ada]]"],
          occurred_at: undefined,
        },
      },
    });
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  });

  it("renders the meeting facts under the title, not in the rail", () => {
    render(<Folio tabId="t1" path={PATH} />);

    const band = screen.getByRole("region", { name: "Meeting details" });
    expect(within(band).getByText("Ada")).toBeInTheDocument();
    expect(
      within(band).getByRole("combobox", { name: "add attendee" }),
    ).toBeInTheDocument();
    // The rail is expanded, so a surviving rail block would be mounted.
    expect(screen.getByText("Vitals")).toBeInTheDocument();
    expect(screen.queryByText("Meeting")).toBeNull();
  });

  it("keeps the band on the mobile layout", () => {
    mobileLayoutState.matches = true;

    render(<Folio tabId="t1" path={PATH} />);

    const document = screen.getByRole("main", { name: "Page document" });
    expect(
      within(document).getByRole("region", { name: "Meeting details" }),
    ).toBeInTheDocument();
  });
});
