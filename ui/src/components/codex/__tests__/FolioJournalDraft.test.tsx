import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./FolioProperties.mock";

const {
  collapsibleRailState,
  mobileLayoutState,
  setReadingProgressMock,
  usePageEditorMock,
  useJournalTodayMock,
  useAiJournalTodayMock,
  useJournalEditorOptionsMock,
} = vi.hoisted(() => ({
  collapsibleRailState: { collapsed: true },
  mobileLayoutState: { matches: false },
  setReadingProgressMock: vi.fn(),
  usePageEditorMock: vi.fn(),
  useJournalTodayMock: vi.fn(),
  useAiJournalTodayMock: vi.fn(),
  useJournalEditorOptionsMock: vi.fn(),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
// Expanding the META rail (for the Project-control test) mounts
// OpenFilesAccordion, which reaches into router history state via
// useRouterState. Stub the module so that path doesn't need a RouterProvider.
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
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    onChange,
    onSaveNow,
  }: {
    onChange: (value: unknown[]) => void;
    onSaveNow: () => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          onChange([{ type: "paragraph", children: [{ text: "First line" }] }])
        }
      >
        Edit journal body
      </button>
      <button type="button" onClick={onSaveNow}>
        Save journal body
      </button>
    </>
  ),
}));
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
  useJournalEditorOptions: useJournalEditorOptionsMock,
  useJournalToday: useJournalTodayMock,
  useJournalRecent: () => ({ data: [] }),
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("#/api/aiJournal", () => ({
  useAiJournalToday: useAiJournalTodayMock,
  useEnsureAiJournalToday: () => ({ mutateAsync: vi.fn() }),
  useAiJournalRecent: () => ({ data: [] }),
}));
// The META-rail's JournalMeta/AiJournalMeta blocks reach into router
// navigation and journal-recent queries irrelevant to this file's draft-dance
// assertions; stub them out so expanding the rail doesn't require mocking
// @tanstack/react-router too.
vi.mock("#/components/codex/JournalMeta", () => ({
  JournalMeta: () => null,
  AiJournalMeta: () => null,
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
  useReadingProgress: () => ({ setProgress: setReadingProgressMock }),
  useSetReadingProgress: () => setReadingProgressMock,
}));

import { todayAiJournalPath, todayJournalPath } from "#/lib/journal";
import { useWorkspaceStore } from "#/store/workspace";
import { Folio } from "../Folio";

function draftEditor() {
  return {
    isLoading: false,
    error: { status: 404 },
    isDraft: true,
    initialValue: [{ type: "paragraph", children: [{ text: "" }] }],
    editorRevision: 0,
    title: "",
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
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "",
    kind: null,
    inferred: true,
    project: null,
  };
}

describe("Folio journal draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePageEditorMock.mockReset();
    useJournalTodayMock.mockReset();
    useAiJournalTodayMock.mockReset();
    useJournalEditorOptionsMock.mockReset();
    mobileLayoutState.matches = false;
    collapsibleRailState.collapsed = true;
    useJournalTodayMock.mockReturnValue({ data: null, isLoading: false });
    useAiJournalTodayMock.mockReturnValue({ data: null, isLoading: false });
    useJournalEditorOptionsMock.mockReturnValue(undefined);
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  });

  it("repoints a stale draft tab when today's journal already exists", () => {
    const canonicalPath = "journals/20260808T005500Z--2026-08-08--a1b2c3.md";
    useJournalTodayMock.mockReturnValue({
      data: { path: canonicalPath, meta: { title: "2026-08-08" } },
      isLoading: false,
    });
    usePageEditorMock.mockReturnValue(draftEditor());
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          type: "page",
          path: todayJournalPath(),
          label: "2026-08-08",
        },
      ],
      activeTabId: "t1",
    });

    render(<Folio tabId="t1" path={todayJournalPath()} />);

    expect(useWorkspaceStore.getState().tabs[0].path).toBe(canonicalPath);
  });

  it("repoints a stale AI draft tab when today's AI journal already exists", () => {
    const canonicalPath = "ai-journals/20260827.2026-08-27.Ab12Cd34.md";
    useAiJournalTodayMock.mockReturnValue({
      data: { path: canonicalPath, meta: { title: "2026-08-27" } },
      isLoading: false,
    });
    usePageEditorMock.mockReturnValue(draftEditor());
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          type: "page",
          path: todayAiJournalPath(),
          label: "2026-08-27",
        },
      ],
      activeTabId: "t1",
    });

    render(<Folio tabId="t1" path={todayAiJournalPath()} />);

    expect(useWorkspaceStore.getState().tabs[0].path).toBe(canonicalPath);
  });

  it("passes ensure() for the AI draft path that calls the AI ensure mutation", () => {
    const ensureAiJournal = vi.fn();
    useJournalEditorOptionsMock.mockImplementation((p: string) =>
      p === todayAiJournalPath()
        ? { ensure: () => ensureAiJournal() }
        : undefined,
    );
    usePageEditorMock.mockReturnValue(draftEditor());

    render(<Folio tabId="t1" path={todayAiJournalPath()} />);

    const lastCall = usePageEditorMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(todayAiJournalPath());
    const options = lastCall?.[1] as { ensure?: () => void } | undefined;
    expect(options?.ensure).toBeTypeOf("function");
    options?.ensure?.();
    expect(ensureAiJournal).toHaveBeenCalledOnce();
  });

  it("keeps the Project control static for JOURNAL and AI_JOURNAL kinds", () => {
    collapsibleRailState.collapsed = false;
    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      kind: "JOURNAL",
    });
    const journalView = render(
      <Folio tabId="t1" path="journals/2026-08-07.md" />,
    );
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(
      screen.getByTitle("Journal pages cannot join a project."),
    ).toBeInTheDocument();
    journalView.unmount();

    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      kind: "AI_JOURNAL",
    });
    render(<Folio tabId="t1" path="ai-journals/2026-08-07.md" />);
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(
      screen.getByTitle("Journal pages cannot join a project."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("AI journal kind cannot be changed."),
    ).toBeInTheDocument();
  });

  it("renders the editor surface, not FolioNotFound, for a draft", () => {
    usePageEditorMock.mockReturnValue(draftEditor());
    render(<Folio tabId="t1" path="journals/2026-08-07.md" />);
    expect(screen.queryByText(/not found/i)).toBeNull();
    expect(screen.getByText(/END OF FILE/)).toBeInTheDocument();
  });

  it("derives an immutable journal tag for a resolved journal", () => {
    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      kind: "JOURNAL",
      computedTags: ["journal"],
    });

    render(<Folio tabId="t1" path="journals/2026-08-07.md" />);

    const derivedTags = screen.getByRole("grid", {
      name: "Read-only Tags",
    });
    expect(within(derivedTags).getByText("journal")).toBeInTheDocument();
    expect(within(derivedTags).queryByRole("button")).toBeNull();
  });

  it("filters a persisted journal tag once and keeps other tags editable", async () => {
    const setTags = vi.fn();
    usePageEditorMock.mockImplementation(() => {
      const [tags, setTagsState] = useState(["journal", "daily"]);
      return {
        ...draftEditor(),
        kind: "JOURNAL",
        computedTags: ["journal"],
        tags,
        setTags: (nextTags: string[]) => {
          setTags(nextTags);
          setTagsState(nextTags);
        },
      };
    });

    render(<Folio tabId="t1" path="journals/2026-08-07.md" />);

    const derivedTags = screen.getByRole("grid", {
      name: "Read-only Tags",
    });
    const editableTags = screen.getByRole("grid", { name: "Tags" });
    expect(screen.getAllByText("journal")).toHaveLength(1);
    expect(within(derivedTags).getByText("journal")).toBeInTheDocument();
    expect(within(editableTags).getByText("daily")).toBeInTheDocument();
    expect(within(editableTags).getByRole("button")).toBeInTheDocument();
    await waitFor(() => {
      expect(setTags).not.toHaveBeenCalled();
    });
  });

  it("defers encrypted journal-tag cleanup until the plain body baseline is adopted", async () => {
    const setTags = vi.fn();
    let editor: Record<string, unknown> = {
      ...draftEditor(),
      kind: "JOURNAL",
      computedTags: ["journal"],
      tags: ["journal", "daily"],
      setTags,
      encrypted: true,
      encryptionState: { status: "locked" as const },
    };
    usePageEditorMock.mockImplementation(() => editor);

    const view = render(<Folio tabId="t1" path="journals/2026-08-07.md" />);

    expect(setTags).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Tags")).toHaveTextContent("#daily");
    expect(screen.getByLabelText("Read-only Tags")).toHaveTextContent(
      "#journal",
    );

    editor = {
      ...editor,
      bodyMarkdown: "# Friday",
      initialValue: [
        {
          type: "heading-one" as const,
          children: [{ text: "Friday" }],
        },
      ],
      editorRevision: 1,
      encryptionState: { status: "plain" as const, body: "# Friday" },
    };
    view.rerender(<Folio tabId="t1" path="journals/2026-08-07.md" />);

    await waitFor(() => {
      expect(setTags).not.toHaveBeenCalled();
    });
  });

  it("keeps an ordinary journal tag editable on a note", () => {
    const setTags = vi.fn();
    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      kind: "NOTE",
      tags: ["journal"],
      setTags,
    });

    render(<Folio tabId="t1" path="notes/note.md" />);

    expect(screen.queryByRole("grid", { name: "Read-only Tags" })).toBeNull();
    const editableTags = screen.getByRole("grid", { name: "Tags" });
    expect(within(editableTags).getByText("journal")).toBeInTheDocument();
    expect(within(editableTags).getByRole("button")).toBeInTheDocument();
    expect(setTags).not.toHaveBeenCalled();
  });

  it("keeps an unwritten mobile journal lazy until its first edit and save", () => {
    const editor = draftEditor();
    usePageEditorMock.mockReturnValue(editor);
    mobileLayoutState.matches = true;

    render(<Folio tabId="t1" path={todayJournalPath()} />);

    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit journal body" }));
    expect(editor.onSlateChange).toHaveBeenCalledOnce();
    expect(editor.saveNow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save journal body" }));
    expect(editor.saveNow).toHaveBeenCalledOnce();
  });

  it("still renders FolioNotFound for a plain missing page", () => {
    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      isDraft: false,
    });
    render(<Folio tabId="t1" path="notes/missing.md" />);
    expect(screen.queryByText(/END OF FILE/)).toBeNull();
  });

  it("coalesces scroll progress writes into one animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    usePageEditorMock.mockReturnValue(draftEditor());
    const { container } = render(
      <Folio tabId="t1" path="journals/2026-08-07.md" />,
    );
    setReadingProgressMock.mockClear();
    const scroller = container.querySelector<HTMLElement>(
      ".cl-noscroll.h-full.overflow-auto",
    );
    expect(scroller).not.toBeNull();
    Object.defineProperties(scroller as HTMLElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
    });

    (scroller as HTMLElement).scrollTop = 200;
    fireEvent.scroll(scroller as HTMLElement);
    (scroller as HTMLElement).scrollTop = 600;
    fireEvent.scroll(scroller as HTMLElement);

    expect(setReadingProgressMock).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    act(() => frames[0]?.(0));
    expect(setReadingProgressMock).toHaveBeenCalledOnce();
    expect(setReadingProgressMock).toHaveBeenCalledWith(0.75);
    vi.unstubAllGlobals();
  });
});
