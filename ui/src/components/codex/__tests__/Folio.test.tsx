import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo } from "react";
import { createEditor, type Descendant, type Editor, Node } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TagCount } from "#/api/types";
import type { CustomEditor } from "#/editor/types";

// The recovery panel is the PRIMARY (declarative) invalid-tab path: usePage
// opts out of throwOnError, so a 404 surfaces as editor.error and Folio's
// early-return branch renders FolioNotFound. Mock the editor + data hooks so
// the test isolates that branch (FolioBoundary covers the thrown-error path).
const {
  blockerState,
  journalTodayState,
  mobileLayoutState,
  mountedSlateEditors,
  navigateMock,
  restorationFrames,
  routerHistory,
  useBlockerMock,
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
  mobileLayoutState: { matches: false },
  mountedSlateEditors: [] as Editor[],
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
  useNavigate: () => navigateMock,
  useRouter: () => ({ history: routerHistory }),
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
  useOutlinks: () => ({ data: undefined }),
  useSimilar: () => ({ data: undefined }),
  useTagSuggestions: useTagSuggestionsMock,
  useTags: useTagsMock,
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
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    initialValue,
    onChange,
    editorRef,
  }: {
    initialValue: Descendant[];
    onChange: (value: Descendant[]) => void;
    editorRef?: { current: CustomEditor | null };
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

    return (
      <textarea
        aria-label="Page body"
        data-testid="slate-editor"
        defaultValue={initialValue[0] ? Node.string(initialValue[0]) : ""}
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

import {
  clearFolioRestoration,
  type FolioRestoration,
  readFolioRestoration,
  saveFolioRestoration,
} from "#/store/folioRestoration";
import { useWorkspaceStore } from "#/store/workspace";
import { todayJournalPath } from "#/lib/journal";
import { TabContent } from "#/components/TabContent";
import { Folio } from "../Folio";

beforeEach(() => {
  blockerState.current = { status: "idle" };
  useBlockerMock.mockClear();
  journalTodayState.data = null;
  journalTodayState.isLoading = false;
  clearFolioRestoration("t1");
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
});

function errorEditor() {
  return {
    isLoading: false,
    error: new Error("404"),
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

  it("renders the recovery panel when the page query errors", () => {
    render(<Folio tabId="t1" path="notes/gone.md" />);
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
    expect(screen.getByText("notes/gone.md")).toBeInTheDocument();
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
      encryptionState: { status: "locked" },
    });

    render(<Folio tabId="t1" path="notes/private.md" />);

    expect(
      screen.getByRole("heading", { name: "Private plans" }),
    ).toBeVisible();
    expect(screen.queryByTestId("slate-editor")).toBeNull();
    expect(document.body.textContent).not.toContain(armor);
    expect(
      screen.queryByRole("button", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/END OF FILE/)).toBeNull();
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

    expect(
      screen.getByRole("button", { name: "Raw Markdown" }),
    ).toBeVisible();
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
      tabs: [
        { id: "t1", type: "page", path: draftPath, label: "Today" },
      ],
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

    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue(
      "Alpha",
    );
    expect(
      screen.queryByRole("button", { name: "collapse panel" }),
    ).not.toBeInTheDocument();
    expect(useCollapsibleRailMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Document details" }));
    expect(
      screen.getByRole("dialog", { name: "Document details" }),
    ).toBeVisible();
    expect(screen.getByText("notes/alpha.md")).toBeVisible();

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

  it("leaves scroll and selection untouched when changed-revision text is stale", () => {
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

    expect(restoredScroller.scrollTop).toBe(0);
    expect(restoredEditor.selection).toBeNull();
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
