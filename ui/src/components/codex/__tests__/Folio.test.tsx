import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useLayoutEffect, useMemo } from "react";
import {
  createEditor,
  type Descendant,
  type Editor,
  Element,
  Text,
} from "slate";
import { ReactEditor } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AttachmentsApi from "#/api/attachments";
import type { OutlinkEntry, TagCount } from "#/api/types";
import type { CustomEditor } from "#/editor/types";

// The recovery panel is the PRIMARY (declarative) invalid-tab path: usePage
// opts out of throwOnError, so a 404 surfaces as editor.error and Folio's
// early-return branch renders FolioNotFound. Mock the editor + data hooks so
// the test isolates that branch (FolioBoundary covers the thrown-error path).
const {
  blockerState,
  journalTodayState,
  outlinksState,
  attachmentRemoveMock,
  attachmentUploadMock,
  mobileLayoutState,
  mountedSlateEditors,
  folioPropertiesMock,
  folioPropertiesState,
  navigateMock,
  restorationFrames,
  routerHistory,
  useBlockerMock,
  useAttachmentsMock,
  useCollapsibleRailMock,
  usePageEditorMock,
  useTagSuggestionsMock,
  useTagsMock,
  useScrollSpyMock,
} = vi.hoisted(() => ({
  blockerState: {
    current: { status: "idle" } as {
      status: "idle" | "blocked";
      reset?: () => void;
      proceed?: () => void;
    },
  },
  journalTodayState: {
    data: null as null | {
      path: string;
      meta: { title: string | null };
    },
    isLoading: false,
  },
  outlinksState: { data: undefined as OutlinkEntry[] | undefined },
  mobileLayoutState: { matches: false },
  mountedSlateEditors: [] as Editor[],
  folioPropertiesMock: vi.fn(),
  folioPropertiesState: { failed: false },
  attachmentRemoveMock: vi.fn(),
  attachmentUploadMock: vi.fn(),
  navigateMock: vi.fn(),
  restorationFrames: [] as FrameRequestCallback[],
  routerHistory: {
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    location: { state: { __TSR_index: 0 } as Record<string, unknown> },
  },
  useCollapsibleRailMock: vi.fn(() => ({
    collapsed: false,
    width: 240,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  })),
  useTagSuggestionsMock: vi.fn(),
  useTagsMock: vi.fn<() => { data: TagCount[] | undefined; error?: Error }>(
    () => ({
      data: [
        { tag: "research", count: 4, computed_count: 0 },
        { tag: "ritual", count: 1, computed_count: 0 },
      ],
    }),
  ),
  useBlockerMock: vi.fn(),
  useAttachmentsMock: vi.fn(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
  usePageEditorMock: vi.fn(),
  useScrollSpyMock: vi.fn(() => ({
    activeIndex: -1,
    scrollTo: vi.fn(),
  })),
}));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: (options: unknown) => {
    useBlockerMock(options);
    return blockerState.current;
  },
  useLocation: () => ({ pathname: "/workspace" }),
  useNavigate: () => navigateMock,
  useRouter: () => ({ history: routerHistory }),
  useRouterState: ({
    select,
  }: {
    select: (s: {
      matches: Array<{ staticData?: { codexView?: string } }>;
    }) => unknown;
  }) => select({ matches: [{ staticData: { codexView: "workspace" } }] }),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: useCollapsibleRailMock,
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: useScrollSpyMock,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: undefined }),
  useOutlinks: () => outlinksState,
  useSimilar: () => ({ data: undefined }),
  useTagSuggestions: useTagSuggestionsMock,
  useTags: useTagsMock,
}));
vi.mock("#/api/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof AttachmentsApi>();
  return {
    ...actual,
    useAttachments: useAttachmentsMock,
    useUploadAttachment: () => ({
      mutateAsync: attachmentUploadMock,
      isPending: false,
    }),
    useDeleteAttachment: () => ({
      mutateAsync: attachmentRemoveMock,
      isPending: false,
    }),
  };
});
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
vi.mock("#/components/codex/FolioProperties", () => ({
  FolioProperties: (props: {
    pageId: string;
    path: string;
    locked: boolean;
    readOnly: boolean;
  }) => {
    if (folioPropertiesState.failed) {
      return (
        <section data-testid="folio-properties">
          <p role="alert">Property projection unavailable</p>
        </section>
      );
    }
    folioPropertiesMock(props);
    return (
      <section data-testid="folio-properties">Projected properties</section>
    );
  },
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    initialValue,
    onChange,
    editorRef,
    onUnmountSnapshot,
  }: {
    initialValue: Descendant[];
    onChange: (value: Descendant[]) => void;
    editorRef?: { current: CustomEditor | null };
    onUnmountSnapshot?: (editor: CustomEditor) => void;
  }) => {
    const editor = useMemo(() => {
      const instance = createEditor() as CustomEditor;
      instance.children = initialValue;
      mountedSlateEditors.push(instance);
      return instance;
    }, [initialValue]);

    useEffect(() => {
      if (editorRef) editorRef.current = editor;
      return () => {
        if (editorRef?.current === editor) editorRef.current = null;
      };
    }, [editor, editorRef]);

    // Mirrors the real SlateEditor's unmount-snapshot contract, including its
    // layout-phase timing (before the replacement's layout effects run).
    useLayoutEffect(
      () => () => {
        onUnmountSnapshot?.(editor);
      },
      [editor, onUnmountSnapshot],
    );

    const first = initialValue[0];
    const firstChild =
      Element.isElement(first) && first.children.length > 0
        ? first.children[0]
        : null;
    return (
      <textarea
        aria-label="Page body"
        data-testid="slate-editor"
        defaultValue={
          firstChild && Text.isText(firstChild) ? firstChild.text : ""
        }
        onChange={(event) =>
          onChange([
            {
              type: "paragraph",
              children: [{ text: event.currentTarget.value }],
            },
          ])
        }
      />
    );
  },
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => journalTodayState,
  useJournalEditorOptions: () => undefined,
  useJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => [],
}));

import { TabContent } from "#/components/TabContent";
import { todayJournalPath } from "#/lib/journal";
import { queryClient } from "#/lib/queryClient";
import {
  captureFolioHistoryLocation,
  clearFolioHistoryState,
  clearFolioRestoration,
  type FolioRestoration,
  readFolioHistoryRestorationRequest,
  readFolioRestoration,
  registerFolioHistoryCapture,
  requestFolioHistoryRestoration,
  saveFolioRestoration,
} from "#/store/folioRestoration";
import { useWorkspaceStore } from "#/store/workspace";
import { Folio } from "../Folio";

beforeEach(() => {
  blockerState.current = { status: "idle" };
  useBlockerMock.mockClear();
  journalTodayState.data = null;
  journalTodayState.isLoading = false;
  outlinksState.data = undefined;
  clearFolioRestoration("t1");
  clearFolioHistoryState();
  folioPropertiesMock.mockClear();
  folioPropertiesState.failed = false;
  mountedSlateEditors.length = 0;
  restorationFrames.length = 0;
  useTagSuggestionsMock.mockImplementation((query: string) => ({
    data: query.startsWith("clep")
      ? [{ tag: "clepsydra", count: 9, computed_count: 0 }]
      : [
          { tag: "research", count: 4, computed_count: 0 },
          { tag: "ritual", count: 1, computed_count: 0 },
        ],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }));
  useTagsMock.mockReturnValue({
    data: [
      { tag: "research", count: 4, computed_count: 0 },
      { tag: "ritual", count: 1, computed_count: 0 },
    ],
  });
  useAttachmentsMock.mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  });
  attachmentUploadMock.mockReset().mockResolvedValue({
    name: "diagram.png",
    path: "diagram.png",
    size: 5,
  });
  attachmentRemoveMock.mockReset().mockResolvedValue(undefined);
});

function errorEditor() {
  return {
    isLoading: false,
    error: new Error("404"),
    pageNotFound: true,
    tags: [],
    computedTags: [],
    title: undefined,
    saveNow: vi.fn(),
    kind: undefined,
    bodyMarkdown: "",
    inferred: undefined,
    project: undefined,
    initialValue: [],
    editorRevision: 0,
  };
}
function editableEditor() {
  const initialValue = [
    { type: "paragraph", children: [{ text: "Editable body" }] },
  ];
  let editorValue = initialValue;
  const onSlateChange = vi.fn(
    (value: Array<{ type: string; children: Array<{ text: string }> }>) => {
      editorValue = value;
    },
  );
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    title: "Alpha",
    setTitle: vi.fn(),
    tags: ["mobile"],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    saveStatus: "saved" as const,
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    kind: "NOTE",
    bodyMarkdown: "Editable body",
    inferred: false,
    project: null,
    initialValue,
    get editorValue() {
      return editorValue;
    },
    onSlateChange,
    editorRevision: 1,
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
    encrypted: false,
    pageId: "page-alpha",
    getPlaintext: vi.fn(() => "Editable body"),
    getRevision: vi.fn(() => "revision-1"),
    setBodyMarkdown: vi.fn(),
  };
}

function activeSlateEditor(): Editor {
  const editor = mountedSlateEditors[mountedSlateEditors.length - 1];
  if (!editor) throw new Error("Expected SlateEditor to mount an editor");
  return editor;
}

function folioScrollContainer(): HTMLDivElement {
  let element = screen.getByTestId("slate-editor").parentElement;
  while (element) {
    if (
      element.classList.contains("cl-noscroll") &&
      (element.classList.contains("overflow-auto") ||
        element.classList.contains("overflow-y-auto"))
    ) {
      return element as HTMLDivElement;
    }
    element = element.parentElement;
  }
  throw new Error("Expected a Folio scroll container");
}

function flushRestorationFrame() {
  const callbacks = restorationFrames.splice(0);
  expect(callbacks).not.toHaveLength(0);
  act(() => {
    for (const callback of callbacks) callback(performance.now());
  });
}

function restorationRecord(
  overrides: Partial<FolioRestoration> = {},
): FolioRestoration {
  return {
    tabId: "t1",
    path: "notes/alpha.md",
    revision: "revision-1",
    scrollTop: 48,
    anchor: { path: [0, 0], offset: 2, text: "Editable body" },
    focus: { path: [0, 0], offset: 7, text: "Editable body" },
    ...overrides,
  };
}

function queueHistoryRestoration(
  locationId: string,
  path: string,
  restoration: FolioRestoration | null,
) {
  if (restoration) {
    const unregister = registerFolioHistoryCapture(
      restoration.tabId,
      restoration.path,
      () => restoration,
    );
    expect(
      captureFolioHistoryLocation(
        locationId,
        restoration.tabId,
        restoration.path,
      ),
    ).toBe(true);
    unregister();
  }
  requestFolioHistoryRestoration({ tabId: "t1", path, locationId });
}

describe("Folio invalid-tab recovery", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    useCollapsibleRailMock.mockClear();
    usePageEditorMock.mockReturnValue(errorEditor());
    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: "notes/gone.md", label: "gone" }],
      activeTabId: "t1",
    });
  });

  it("renders the recovery panel when the page query 404s", () => {
    render(<Folio tabId="t1" path="notes/gone.md" />);
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
    expect(screen.getByText("notes/gone.md")).toBeInTheDocument();
  });

  it("renders the error panel, not a not-found claim, for non-404 query errors", () => {
    usePageEditorMock.mockReturnValue({
      ...errorEditor(),
      error: { status: 500, error: "index unavailable" },
      pageNotFound: false,
    });

    render(<Folio tabId="t1" path="notes/gone.md" />);

    expect(screen.getByText("Folio hit an error.")).toBeInTheDocument();
    expect(screen.getByText("index unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Folio not found.")).not.toBeInTheDocument();
  });

  it("retry on the error panel resets errored queries so they can refetch", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue({
      ...errorEditor(),
      error: { status: 500, error: "index unavailable" },
      pageNotFound: false,
    });
    await queryClient.prefetchQuery({
      queryKey: ["folio-test-errored"],
      queryFn: () => Promise.reject(new Error("nope")),
      retry: false,
    });
    expect(queryClient.getQueryState(["folio-test-errored"])?.status).toBe(
      "error",
    );

    render(<Folio tabId="t1" path="notes/gone.md" />);
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(queryClient.getQueryState(["folio-test-errored"])?.status).not.toBe(
      "error",
    );
  });

  it("closes the offending tab from the recovery panel", async () => {
    const user = userEvent.setup();
    render(<Folio tabId="t1" path="notes/gone.md" />);
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });

  it("suggests indexed tags while editing folio tags", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue(editableEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "res");

    expect(
      await screen.findByRole("option", { name: "research" }),
    ).toBeInTheDocument();
  });

  it("queries a bounded suggestion set as the Folio draft changes", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue(editableEditor());
    useTagsMock.mockClear();

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "clep");

    await waitFor(() =>
      expect(useTagSuggestionsMock).toHaveBeenCalledWith("clep", 12, true),
    );
    expect(screen.getByRole("option", { name: "clepsydra" })).toBeVisible();
    expect(useTagsMock).not.toHaveBeenCalled();

    await user.type(input, "sydra");
    await waitFor(() =>
      expect(useTagSuggestionsMock).toHaveBeenCalledWith("clepsydra", 12, true),
    );
    expect(screen.getByRole("option", { name: "clepsydra" })).toBeVisible();
  });

  it("keeps raw tag editing and blur-save operational without a tag index", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    useTagSuggestionsMock.mockReturnValue({
      data: undefined,
      error: new Error("tag suggestions unavailable"),
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "ad-hoc");

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
    fireEvent.blur(input);

    expect(editor.setTags).toHaveBeenCalledOnce();
    expect(editor.setTags).toHaveBeenCalledWith(["mobile", "ad-hoc"]);
    expect(editor.saveNow).toHaveBeenCalledOnce();
  });

  it("renders a locked folio without mounting Slate or exposing armor", () => {
    const armor = "-----BEGIN AGE ENCRYPTED FILE----- SECRET ARMOR";
    usePageEditorMock.mockReturnValue({
      isLoading: false,
      error: null,
      isDraft: false,
      title: "Private plans",
      tags: ["private"],
      saveNow: vi.fn(),
      kind: "NOTE",
      bodyMarkdown: "",
      inferred: true,
      project: null,
      initialValue: [{ type: "paragraph", children: [{ text: armor }] }],
      editorRevision: 1,
      encrypted: true,
      pageId: "page-private",
      encryptionState: { status: "locked" },
    });

    render(<Folio tabId="t1" path="notes/private.md" />);

    expect(
      screen.getByRole("heading", { name: "Private plans" }),
    ).toBeVisible();
    expect(screen.queryByTestId("slate-editor")).toBeNull();
    expect(document.body.textContent).not.toContain(armor);
    expect(screen.getByTestId("folio-properties")).toBeVisible();
    expect(folioPropertiesMock).toHaveBeenLastCalledWith({
      pageId: "page-private",
      path: "notes/private.md",
      locked: true,
      readOnly: false,
    });
    expect(
      screen.queryByRole("button", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/END OF FILE/)).toBeNull();
  });

  it("orders recent open Folios by activation without tab pin controls", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue(editableEditor());
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
          lastActiveAt: 1,
        },
        {
          id: "t2",
          type: "page",
          path: "notes/beta.md",
          label: "Beta",
          lastActiveAt: 2,
        },
      ],
      activeTabId: "t1",
      quires: {},
      openHistory: [],
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    const recent = screen.getByText("Recent").parentElement!;
    expect(
      within(recent).queryByRole("button", { name: /pin tab/i }),
    ).not.toBeInTheDocument();
    expect(
      within(recent).getAllByRole("button", { name: "Close tab" }),
    ).toHaveLength(2);

    const beta = within(recent).getByRole("button", { name: "Beta" });
    const alpha = within(recent).getByRole("button", { name: "Alpha" });
    expect(
      beta.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    await user.click(beta);
    expect(useWorkspaceStore.getState().activeTabId).toBe("t2");
  });
});

describe("Folio outbound links", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    usePageEditorMock.mockReturnValue(editableEditor());
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
  });

  it("excludes metadata edges from the Links count, badge, and list", async () => {
    const user = userEvent.setup();
    outlinksState.data = [
      ...Array.from({ length: 5 }, (_, index) => ({
        kind: "property_ref",
        source_field: "tags",
        target_id: `tag-${index}`,
        target_path: `notes/tag-${index}.md`,
        target_raw: `tag-${index}`,
      })),
      {
        kind: "wiki",
        source_field: null,
        target_id: "page-1",
        target_path: "notes/real.md",
        target_raw: "Real",
      },
    ];

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    const vitals = screen.getByText("Vitals").parentElement;
    expect(vitals).not.toBeNull();
    expect(within(vitals!).getByText("Links").closest("div")).toHaveTextContent(
      "1",
    );
    const linksTab = screen.getByRole("button", { name: /^Links/ });
    expect(linksTab).toHaveTextContent("1");
    await user.click(linksTab);
    expect(screen.getByText("Real")).toBeVisible();
    expect(screen.queryByText("tag-0")).toBeNull();
  });
});

describe("Folio raw Markdown mode", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
  });

  it("offers raw Markdown on a generic editable Folio", () => {
    usePageEditorMock.mockReturnValue(editableEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    expect(screen.getByRole("button", { name: "Raw Markdown" })).toBeVisible();
  });

  it("snapshots the current unsaved rich draft instead of stale server Markdown", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    const exactDraft = "Current unsaved draft  \n\n- [ ] still local\n";
    editor.getPlaintext.mockReturnValue(exactDraft);
    usePageEditorMock.mockReturnValue(editor);

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));

    expect(editor.getPlaintext).toHaveBeenCalledOnce();
    expect(editor.getRevision).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      exactDraft,
    );
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("cancels an unchanged session without normalizing or saving", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("textbox", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveValue(
      "Editable body",
    );
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("discards an exact changed raw draft on Cancel without mutating the page editor", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    const discarded = "  exact raw text  \r\n\r\nwith spacing\t";

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: discarded },
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveValue(
      "Editable body",
    );
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("applies the exact raw draft once and returns to the rich editor", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    const exactRaw = "# Exact  \n\n- item\n\n";

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: exactRaw },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
    expect(editor.setBodyMarkdown).toHaveBeenCalledWith(exactRaw);
    expect(
      screen.queryByRole("textbox", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page body" })).toBeVisible();
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("keeps an exact dirty raw draft recoverable when an encrypted Folio locks", async () => {
    const user = userEvent.setup();
    const plainEditor = {
      ...editableEditor(),
      encrypted: true,
      encryptionState: { status: "plain" as const, body: "Editable body" },
    };
    usePageEditorMock.mockReturnValue(plainEditor);
    const view = render(<Folio tabId="t1" path="notes/private.md" />);

    expect(
      screen.getByRole("button", { name: "Lock encrypted notes" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    const exactRaw = "Private raw draft stays recoverable  \n";
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: exactRaw },
    });

    usePageEditorMock.mockReturnValue({
      ...plainEditor,
      encryptionState: { status: "locked" as const },
    });
    view.rerender(<Folio tabId="t1" path="notes/private.md" />);

    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      exactRaw,
    );
    expect(
      screen.queryByRole("button", { name: "Lock encrypted notes" }),
    ).toBeNull();
    const options = useBlockerMock.mock.calls.at(-1)?.[0] as {
      shouldBlockFn: () => boolean;
      enableBeforeUnload: boolean;
    };
    expect(options.shouldBlockFn()).toBe(true);
    expect(options.enableBeforeUnload).toBe(true);
  });

  it("guards a today-draft retarget through Stay and consumes it once on Leave", async () => {
    const user = userEvent.setup();
    const draftPath = todayJournalPath();
    const canonicalPath = "journals/archive/today.md";
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: draftPath, label: "Today" }],
      activeTabId: "t1",
    });
    const view = render(<TabContent />);

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    const exactRaw = "Today draft before canonical retarget  \n";
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: exactRaw },
    });

    journalTodayState.data = {
      path: canonicalPath,
      meta: { title: "Today" },
    };
    view.rerender(<TabContent />);

    expect(useWorkspaceStore.getState().tabs[0]?.path).toBe(draftPath);
    expect(
      screen.getByRole("dialog", { name: "Unsaved raw Markdown" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(useWorkspaceStore.getState().tabs[0]?.path).toBe(draftPath);
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      exactRaw,
    );

    journalTodayState.data = {
      path: canonicalPath,
      meta: { title: "Today" },
    };
    view.rerender(<TabContent />);
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().tabs[0]?.path).toBe(canonicalPath),
    );
    expect(usePageEditorMock).toHaveBeenLastCalledWith(
      canonicalPath,
      undefined,
    );
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
  });

  it("retains exact raw text and reports a conversion diagnostic when Apply throws", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    editor.setBodyMarkdown.mockImplementation(() => {
      throw new Error("Unexpected construct on line 2");
    });
    usePageEditorMock.mockReturnValue(editor);
    const exactRaw = "# Keep me\n\n<broken  \n";

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: exactRaw },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      exactRaw,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not be applied.*Unexpected construct on line 2/i,
    );
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("refuses Apply when the page revision changed after entry", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Local raw draft" },
    });
    editor.getRevision.mockReturnValue("revision-2");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Local raw draft",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed after raw Markdown mode opened/i,
    );
  });

  it("blocks only a changed raw draft and resolves Stay or Leave explicitly", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    const view = render(<Folio tabId="t1" path="notes/alpha.md" />);

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    let options = useBlockerMock.mock.calls.at(-1)?.[0] as {
      shouldBlockFn: () => boolean;
      enableBeforeUnload: boolean;
      withResolver: boolean;
    };
    expect(options.shouldBlockFn()).toBe(false);
    expect(options.enableBeforeUnload).toBe(false);
    expect(options.withResolver).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Dirty raw draft" },
    });
    options = useBlockerMock.mock.calls.at(-1)?.[0] as typeof options;
    expect(options.shouldBlockFn()).toBe(true);
    expect(options.enableBeforeUnload).toBe(true);

    const reset = vi.fn();
    blockerState.current = { status: "blocked", reset };
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(reset).toHaveBeenCalledOnce();
    blockerState.current = { status: "idle" };
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Dirty raw draft",
    );

    const proceed = vi.fn();
    blockerState.current = { status: "blocked", proceed };
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Leave" }));

    expect(proceed).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("textbox", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("blocks active-tab remounts before workspace mutation and resolves the pending activation once", async () => {
    const user = userEvent.setup();
    const alphaEditor = editableEditor();
    const betaEditor = editableEditor();
    betaEditor.title = "Beta";
    betaEditor.initialValue = [
      { type: "paragraph", children: [{ text: "Beta body" }] },
    ];
    usePageEditorMock.mockImplementation((path: string) =>
      path === "notes/alpha.md" ? alphaEditor : betaEditor,
    );
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
          lastActiveAt: 2,
        },
        {
          id: "t2",
          type: "page",
          path: "notes/beta.md",
          label: "Beta",
          lastActiveAt: 1,
        },
      ],
      activeTabId: "t1",
    });
    render(<TabContent />);

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Do not lose this exact draft  \n" },
    });
    await user.click(screen.getByRole("button", { name: "Beta" }));

    expect(useWorkspaceStore.getState().activeTabId).toBe("t1");
    expect(
      screen.getByRole("dialog", { name: "Unsaved raw Markdown" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(useWorkspaceStore.getState().activeTabId).toBe("t1");
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Do not lose this exact draft  \n",
    );

    await user.click(screen.getByRole("button", { name: "Beta" }));
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeTabId).toBe("t2"),
    );
    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue(
      "Beta",
    );
    expect(alphaEditor.setBodyMarkdown).not.toHaveBeenCalled();
  });

  it("blocks an active path retarget before TabContent remounts", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    render(<TabContent />);

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Pending across move\n" },
    });
    act(() => {
      useWorkspaceStore
        .getState()
        .updateTabPath("t1", "archive/alpha.md", "Alpha");
    });

    expect(useWorkspaceStore.getState().tabs[0]?.path).toBe("notes/alpha.md");
    expect(
      screen.getByRole("dialog", { name: "Unsaved raw Markdown" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Pending across move\n",
    );
    act(() => {
      useWorkspaceStore
        .getState()
        .updateTabPath("t1", "archive/alpha.md", "Alpha");
    });

    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().tabs[0]?.path).toBe(
        "archive/alpha.md",
      ),
    );
    expect(usePageEditorMock).toHaveBeenLastCalledWith(
      "archive/alpha.md",
      undefined,
    );
  });
});

describe("Folio property placement", () => {
  it("places projected properties between the desktop header and body", () => {
    mobileLayoutState.matches = false;
    usePageEditorMock.mockReturnValue(editableEditor());
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    const title = screen.getByRole("textbox", { name: "Page title" });
    const properties = screen.getByTestId("folio-properties");
    const body = screen.getByRole("textbox", { name: "Page body" });
    expect(
      title.compareDocumentPosition(properties) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      properties.compareDocumentPosition(body) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(properties.closest("aside")).toBeNull();
    expect(screen.getAllByTestId("folio-properties")).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: "Page body" })).toHaveLength(
      1,
    );
    expect(folioPropertiesMock).toHaveBeenLastCalledWith({
      pageId: "page-alpha",
      path: "notes/alpha.md",
      locked: false,
      readOnly: false,
    });
  });

  it("places projected properties between the read-only header and body", () => {
    mobileLayoutState.matches = false;
    usePageEditorMock.mockReturnValue({
      ...editableEditor(),
      readonly: true,
      setReadonly: vi.fn().mockResolvedValue(undefined),
    });
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    const header = screen.getByRole("region", { name: "Page metadata" });
    const properties = screen.getByTestId("folio-properties");
    const body = screen.getByRole("textbox", { name: "Page body" });
    expect(
      within(header).getByRole("heading", { name: "Alpha", level: 1 }),
    ).toBeVisible();
    expect(properties).toBeVisible();
    expect(body).toBeVisible();
    expect(
      header.compareDocumentPosition(properties) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      properties.compareDocumentPosition(body) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      screen.getAllByRole("region", { name: "Page metadata" }),
    ).toHaveLength(1);
    expect(screen.getAllByTestId("folio-properties")).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: "Page body" })).toHaveLength(
      1,
    );
    expect(folioPropertiesMock).toHaveBeenLastCalledWith({
      pageId: "page-alpha",
      path: "notes/alpha.md",
      locked: false,
      readOnly: true,
    });
  });

  it("keeps the normal Folio usable when the property projection fails", () => {
    mobileLayoutState.matches = false;
    folioPropertiesState.failed = true;
    usePageEditorMock.mockReturnValue(editableEditor());
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Property projection unavailable",
    );
    expect(screen.getByRole("textbox", { name: "Page body" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Page title" })).toBeVisible();
  });
});

describe("Folio attachment protection plumbing", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
  });

  it("gates encrypted-page uploads while plaintext-page uploads remain immediate", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue({
      ...editableEditor(),
      encrypted: true,
    });
    const protectedView = render(<Folio tabId="t1" path="notes/alpha.md" />);

    await user.click(
      screen.getByRole("button", { name: "Manage attachments" }),
    );
    fireEvent.change(await screen.findByLabelText("Upload attachment"), {
      target: {
        files: [new File(["image"], "diagram.png", { type: "image/png" })],
      },
    });
    expect(
      screen.getByRole("dialog", { name: "Store plaintext attachment?" }),
    ).toBeVisible();
    expect(attachmentUploadMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    protectedView.unmount();

    usePageEditorMock.mockReturnValue(editableEditor());
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(
      screen.getByRole("button", { name: "Manage attachments" }),
    );
    fireEvent.change(await screen.findByLabelText("Upload attachment"), {
      target: {
        files: [new File(["image"], "diagram.png", { type: "image/png" })],
      },
    });

    await waitFor(() => expect(attachmentUploadMock).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hands decrypted Markdown to the protected attachment audit without mutating", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue({
      ...editableEditor(),
      encrypted: true,
      bodyMarkdown:
        "[Missing paper](/api/vault/attachments/private/missing%20paper.pdf)",
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(
      screen.getByRole("button", { name: "Manage attachments" }),
    );

    const audit = await screen.findByRole("region", {
      name: "Plaintext attachment references",
    });
    expect(within(audit).getByText("private/missing paper.pdf")).toBeVisible();
    expect(attachmentUploadMock).not.toHaveBeenCalled();
    expect(attachmentRemoveMock).not.toHaveBeenCalled();
  });
});
describe("Folio mobile presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = true;
    usePageEditorMock.mockReturnValue(editableEditor());
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
  });

  it("keeps the page editable without initializing desktop rails", async () => {
    const user = userEvent.setup();
    render(<Folio tabId="t1" path="notes/alpha.md" />);

    const title = screen.getByRole("textbox", { name: "Page title" });
    const properties = screen.getByTestId("folio-properties");
    const body = screen.getByRole("textbox", { name: "Page body" });
    expect(
      title.compareDocumentPosition(properties) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      properties.compareDocumentPosition(body) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getAllByTestId("folio-properties")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "collapse panel" }),
    ).not.toBeInTheDocument();
    expect(useCollapsibleRailMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Document details" }));
    const detailsDialog = screen.getByRole("dialog", {
      name: "Document details",
    });
    expect(detailsDialog).toBeVisible();
    expect(screen.getByText("notes/alpha.md")).toBeVisible();
    expect(within(detailsDialog).queryByTestId("folio-properties")).toBeNull();
    expect(folioPropertiesMock).toHaveBeenLastCalledWith({
      pageId: "page-alpha",
      path: "notes/alpha.md",
      locked: false,
      readOnly: false,
    });

    await user.click(
      screen.getByRole("button", { name: "Page relationships" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Page relationships" }),
    ).toBeVisible();
    expect(screen.getByText("Backlinks")).toBeVisible();
  });

  it("rehydrates unsaved body state across breakpoint changes", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    mobileLayoutState.matches = false;
    const { rerender } = render(<Folio tabId="t1" path="notes/alpha.md" />);

    const desktopBody = screen.getByRole("textbox", { name: "Page body" });
    await user.clear(desktopBody);
    await user.type(desktopBody, "Unsaved across layouts");
    expect(editor.onSlateChange).toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();

    mobileLayoutState.matches = true;
    rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveValue(
      "Unsaved across layouts",
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(editor.saveNow).toHaveBeenCalledOnce();

    mobileLayoutState.matches = false;
    rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveValue(
      "Unsaved across layouts",
    );
  });

  it("keeps raw Markdown controls directly usable on mobile", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    editor.getPlaintext.mockReturnValue("Mobile raw draft\n");
    usePageEditorMock.mockReturnValue(editor);

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));

    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Mobile raw draft\n",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("blocks mobile back before restoring the origin tab and goes back once on Leave", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    routerHistory.canGoBack.mockReturnValue(true);
    routerHistory.location.state = {
      __TSR_index: 1,
      folioOriginTabId: "origin",
    };
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "origin",
          type: "page",
          path: "notes/origin.md",
          label: "Origin",
        },
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
    render(<TabContent />);

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Exact mobile draft  \n" },
    });
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(useWorkspaceStore.getState().activeTabId).toBe("t1");
    expect(routerHistory.back).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Unsaved raw Markdown" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Exact mobile draft  \n",
    );
    await user.click(screen.getByRole("button", { name: "Back" }));

    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().activeTabId).toBe("origin"),
    );
    expect(routerHistory.back).toHaveBeenCalledOnce();
  });

  it("passes breakpoint changes as the scroll-spy reattach discriminator", () => {
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    mobileLayoutState.matches = false;
    const { rerender } = render(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(useScrollSpyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      1,
      false,
    );

    mobileLayoutState.matches = true;
    rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(useScrollSpyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      1,
      true,
    );
  });
});

describe("Folio in-session restoration", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      restorationFrames.push(callback);
      return restorationFrames.length;
    });
  });

  it("restores scroll and selection only after the remounted editor is available", () => {
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const firstMount = render(<Folio tabId="t1" path="notes/alpha.md" />);
    const savedSelection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    activeSlateEditor().selection = savedSelection;
    folioScrollContainer().scrollTop = 96;
    screen.getByRole("textbox", { name: "Page body" }).focus();

    firstMount.unmount();

    const returning = editableEditor();
    returning.initialValue[0].children[0].text =
      "Edited leaf, unchanged revision";
    returning.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(returning);
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredEditor = activeSlateEditor();
    const restoredScroller = folioScrollContainer();
    expect(restoredEditor.selection).toBeNull();
    expect(restoredScroller.scrollTop).toBe(0);

    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(96);
    expect(restoredEditor.selection).toEqual(savedSelection);
  });

  it("restores scroll when changed-revision selection text is stale", () => {
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const firstMount = render(<Folio tabId="t1" path="notes/alpha.md" />);
    activeSlateEditor().selection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    folioScrollContainer().scrollTop = 64;
    firstMount.unmount();

    const returning = editableEditor();
    returning.initialValue[0].children[0].text = "Different leaf text";
    returning.getRevision.mockReturnValue("revision-2");
    usePageEditorMock.mockReturnValue(returning);
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredEditor = activeSlateEditor();
    const restoredScroller = folioScrollContainer();

    flushRestorationFrame();

    // Defect caught: invalid stale selection used to abort independent scroll restoration.
    expect(restoredScroller.scrollTop).toBe(64);
    expect(restoredEditor.selection).toBeNull();
  });

  it("prefers a matching history snapshot over latest tab state", () => {
    saveFolioRestoration(restorationRecord({ scrollTop: 12 }));
    queueHistoryRestoration(
      "history-alpha",
      "notes/alpha.md",
      restorationRecord({ scrollTop: 91 }),
    );
    usePageEditorMock.mockReturnValue(editableEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();
    flushRestorationFrame();

    // Defect caught: latest-per-tab state used to override the visited history location.
    expect(restoredScroller.scrollTop).toBe(91);
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md"),
    ).toBeNull();
  });

  it("consumes a matching missing snapshot without applying latest tab state", () => {
    saveFolioRestoration(restorationRecord({ scrollTop: 70 }));
    queueHistoryRestoration("history-missing", "notes/alpha.md", null);
    usePageEditorMock.mockReturnValue(editableEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();
    restoredScroller.scrollTop = 23;
    flushRestorationFrame();

    // Defect caught: a missing history snapshot used to fall through to a different visit.
    expect(restoredScroller.scrollTop).toBe(23);
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md"),
    ).toBeNull();
  });

  it("keeps a history request through loading and retryable error", () => {
    queueHistoryRestoration(
      "history-after-retry",
      "notes/alpha.md",
      restorationRecord({ scrollTop: 83 }),
    );
    usePageEditorMock.mockReturnValue({
      ...editableEditor(),
      isLoading: true,
    });
    const view = render(<Folio tabId="t1" path="notes/alpha.md" />);

    // Defect caught: loading used to strand the request before content could restore it.
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md")?.request
        .locationId,
    ).toBe("history-after-retry");

    usePageEditorMock.mockReturnValue({
      ...errorEditor(),
      error: { status: 500, error: "index unavailable" },
      pageNotFound: false,
    });
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    // Defect caught: a retryable failure used to discard the pending visit.
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md")?.request
        .locationId,
    ).toBe("history-after-retry");

    usePageEditorMock.mockReturnValue(editableEditor());
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();
    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(83);
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md"),
    ).toBeNull();
  });

  it("keeps a history request locked until the Folio unlocks", () => {
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/private.md", label: "Private" },
      ],
      activeTabId: "t1",
    });
    queueHistoryRestoration(
      "history-private",
      "notes/private.md",
      restorationRecord({
        path: "notes/private.md",
        scrollTop: 57,
        anchor: null,
        focus: null,
      }),
    );
    const lockedEditor = {
      ...editableEditor(),
      encrypted: true,
      encryptionState: { status: "locked" as const },
    };
    usePageEditorMock.mockReturnValue(lockedEditor);
    const view = render(<Folio tabId="t1" path="notes/private.md" />);

    // Defect caught: the locked shell used to lose the visit before an editor existed.
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/private.md")?.request
        .locationId,
    ).toBe("history-private");

    usePageEditorMock.mockReturnValue({
      ...lockedEditor,
      encryptionState: { status: "plain" as const, body: "Editable body" },
    });
    view.rerender(<Folio tabId="t1" path="notes/private.md" />);
    const restoredScroller = folioScrollContainer();
    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(57);
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/private.md"),
    ).toBeNull();
  });

  it("consumes a valid history request in read-only conversation mode", () => {
    queueHistoryRestoration(
      "history-conversation",
      "notes/alpha.md",
      restorationRecord({
        scrollTop: 36,
        anchor: null,
        focus: null,
      }),
    );
    usePageEditorMock.mockReturnValue({
      ...editableEditor(),
      kind: "AI_CONVERSATION",
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();
    flushRestorationFrame();

    // Defect caught: read-only presentation used to leave a valid visit pending forever.
    expect(restoredScroller.scrollTop).toBe(36);
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md"),
    ).toBeNull();
  });

  it("does not let an older restore effect consume a superseding request", () => {
    saveFolioRestoration(restorationRecord({ scrollTop: 5 }));
    queueHistoryRestoration(
      "history-first",
      "notes/alpha.md",
      restorationRecord({ scrollTop: 44 }),
    );
    usePageEditorMock.mockReturnValue(editableEditor());
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();

    requestFolioHistoryRestoration({
      tabId: "t1",
      path: "notes/alpha.md",
      locationId: "history-second",
    });
    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(44);
    // Defect caught: completion of the first effect used to erase the newer exact-ID request.
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md")?.request
        .locationId,
    ).toBe("history-second");
  });

  it("discards a matching history request after a settled not-found", () => {
    queueHistoryRestoration(
      "history-gone",
      "notes/alpha.md",
      restorationRecord(),
    );
    usePageEditorMock.mockReturnValue(errorEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    // Defect caught: an impossible destination used to remain pending after a settled 404.
    expect(
      readFolioHistoryRestorationRequest("t1", "notes/alpha.md"),
    ).toBeNull();
  });

  it("restores scroll and selection when changed-revision text remains compatible", () => {
    saveFolioRestoration(restorationRecord({ scrollTop: 80 }));
    const returning = editableEditor();
    returning.getRevision.mockReturnValue("revision-2");
    usePageEditorMock.mockReturnValue(returning);
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredEditor = activeSlateEditor();
    const restoredScroller = folioScrollContainer();

    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(80);
    expect(restoredEditor.selection).toEqual({
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    });
  });

  it("clears restoration when the same tab is repointed to another path", () => {
    saveFolioRestoration(restorationRecord());
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const mounted = render(<Folio tabId="t1" path="notes/alpha.md" />);
    activeSlateEditor().selection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    folioScrollContainer().scrollTop = 88;
    useWorkspaceStore.getState().updateTabPath("t1", "notes/beta.md", "Beta");
    mounted.unmount();

    expect(readFolioRestoration("t1", "notes/alpha.md")).toBeNull();
  });

  it("restores the mobile document scroll container", () => {
    mobileLayoutState.matches = true;
    saveFolioRestoration(
      restorationRecord({ scrollTop: 72, anchor: null, focus: null }),
    );
    const returning = editableEditor();
    returning.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(returning);

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();
    flushRestorationFrame();

    expect(restoredScroller).toHaveClass("overflow-y-auto");
    expect(restoredScroller.scrollTop).toBe(72);
  });

  it("clears restoration when the page is unavailable", () => {
    saveFolioRestoration(restorationRecord());
    usePageEditorMock.mockReturnValue(errorEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    expect(readFolioRestoration("t1", "notes/alpha.md")).toBeNull();
  });

  it("clears restoration when its tab is deleted", () => {
    saveFolioRestoration(restorationRecord());

    useWorkspaceStore.getState().closeTab("t1");

    expect(readFolioRestoration("t1", "notes/alpha.md")).toBeNull();
  });

  it("restores selection and focus across an in-place editor remount", () => {
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const view = render(<Folio tabId="t1" path="notes/alpha.md" />);
    const first = activeSlateEditor();
    const savedSelection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    first.selection = savedSelection;
    const isFocusedSpy = vi
      .spyOn(ReactEditor, "isFocused")
      .mockReturnValue(true);
    const focusSpy = vi
      .spyOn(ReactEditor, "focus")
      .mockImplementation(() => {});

    usePageEditorMock.mockReturnValue({ ...departing, editorRevision: 2 });
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    const second = activeSlateEditor();
    expect(second).not.toBe(first);

    flushRestorationFrame();

    expect(second.selection).toEqual(savedSelection);
    expect(focusSpy).toHaveBeenCalledWith(second);
    isFocusedSpy.mockRestore();
    focusSpy.mockRestore();
  });

  it("keeps selection but does not take focus when the swapped-out editor was blurred", () => {
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const view = render(<Folio tabId="t1" path="notes/alpha.md" />);
    const first = activeSlateEditor();
    const savedSelection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    first.selection = savedSelection;
    const isFocusedSpy = vi
      .spyOn(ReactEditor, "isFocused")
      .mockReturnValue(false);
    const focusSpy = vi
      .spyOn(ReactEditor, "focus")
      .mockImplementation(() => {});

    usePageEditorMock.mockReturnValue({ ...departing, editorRevision: 2 });
    view.rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    const second = activeSlateEditor();

    flushRestorationFrame();

    expect(second.selection).toEqual(savedSelection);
    expect(focusSpy).not.toHaveBeenCalled();
    isFocusedSpy.mockRestore();
    focusSpy.mockRestore();
  });

  it("restores selection without taking focus from an explicit control", () => {
    saveFolioRestoration(restorationRecord());
    const returning = editableEditor();
    returning.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(returning);
    render(
      <>
        <button type="button">Dialog action</button>
        <Folio tabId="t1" path="notes/alpha.md" />
      </>,
    );
    const dialogAction = screen.getByRole("button", {
      name: "Dialog action",
    });
    dialogAction.focus();

    flushRestorationFrame();

    expect(activeSlateEditor().selection).toEqual({
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    });
    expect(dialogAction).toHaveFocus();
  });
});
